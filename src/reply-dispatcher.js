// >>> send-status patch >>>
import { clearSendFailure, recordSendFailure } from './send-status.js';
// <<< send-status patch <<<
import { sessionKeyFromEvent, waitUntilSendable } from './reply-gate.js';
import { parseVoiceTags } from './tts.js';
import { buildVoicePrefaceText } from './tools.js';
// >>> sticker-send patch >>>
import {
    STICKER_MARKER_TEST,
    buildStickerSegment,
    extractStickerMarkers,
    getStickerConfig,
    pickSticker,
    resolveStickerDir,
    scanStickerLibrary
} from './sticker-library.js';
// <<< sticker-send patch <<<

function defaultSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function buildGroupMentionPrefix(userId) {
    if (userId === undefined || userId === null || userId === '') {
        return '';
    }

    return `[CQ:at,qq=${String(userId)}] `;
}

function buildVoiceFallbackText(content, { explicitVoice = false } = {}) {
    const text = String(content || '').trim();
    if (explicitVoice) {
        return text
            ? `语音合成失败，原语音内容：${text}`
            : '语音合成失败，且没有可回退的语音文本。';
    }

    return text
        ? `语音合成失败，先发送文本回复：${text}`
        : '语音合成失败，且没有可回退的文本回复。';
}

/**
 * 构造语音/文件消息前缀（reply / at）。
 * 与纯文本回复链路解耦：调用方显式传入 mentionSender，避免点歌与 TTS 共用一个隐式开关后互相误伤。
 * - 点歌：可传 mentionSender=true（用户要求点歌仍可 @）
 * - TTS：可传 mentionSender=false（语音不走文本必须 @ 的策略）
 */
export function buildMediaPrefixSegments(event, {
    quoteReplyEnabled = true,
    mentionSender = false,
    hasSentPrimary = false
} = {}) {
    if (hasSentPrimary) {
        return [];
    }

    const segments = [];
    if (quoteReplyEnabled && event?.message_id) {
        segments.push({ type: 'reply', data: { id: String(event.message_id) } });
    }

    if (event?.message_type === 'group' && mentionSender && event?.user_id) {
        segments.push({ type: 'at', data: { qq: String(event.user_id) } });
    }

    return segments;
}

// 兼容旧名；历史参数 mentionSenderOnReply 易与文本开关混淆，新代码请用 buildMediaPrefixSegments
function buildVoicePrefixSegments(event, {
    quoteReplyEnabled = true,
    mentionSenderOnReply = true,
    hasSentPrimary = false
} = {}) {
    return buildMediaPrefixSegments(event, {
        quoteReplyEnabled,
        mentionSender: mentionSenderOnReply === true,
        hasSentPrimary
    });
}

// >>> send-interval patch (managed by patch_send_interval.py) >>>
// 同一个机器人两次下发之间至少间隔 chat.minSendIntervalMs（默认 5000ms）。
// 起因：2026-10-09 群里 300ms 连发，QQ 直接 result:120 拒发（连错误提示一起拒）。
// 模块级变量 ⇒ 跨会话全局生效；sendText / sendVoice 是本文件唯一的两条下发出口。
let lastOutboundAt = 0;

async function awaitSendSlot(config = {}, sleepFn, logger = console, event = null, isBurst = false) {
    // >>> private-interval patch <<<
    // 私聊（尤其两个机器人互相私聊）用更长的间隔；群里维持原值。
    const isGroup = event?.message_type === 'group';
    let rawMs = isGroup
        ? (config?.chat?.minSendIntervalMs ?? 0)
        : (config?.chat?.minSendIntervalMsPrivate ?? config?.chat?.minSendIntervalMs ?? 0);
    // >>> burst-interval patch (managed by patch_burst_interval.py) >>>
    // 同一轮回复内的连续分段按「连发」处理：真人是在一两秒内把两三句发完的。
    // 段间再压 minSendIntervalMs 会让整轮看起来像逐字蹦；跨轮的长间隔仍然生效，
    // 因为下面 lastOutboundAt 无论走哪条路径都会照常更新。
    if (isBurst === true) {
        rawMs = config?.chat?.burstIntervalMs ?? 1200;
    }
    // <<< burst-interval patch <<<
    const minIntervalMs = Math.max(0, Number(rawMs) || 0);
    // <<< private-interval patch <<<
    const wait = typeof sleepFn === 'function'
        ? sleepFn
        : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    if (minIntervalMs <= 0) {
        lastOutboundAt = Date.now();
        return 0;
    }
    const waitMs = lastOutboundAt + minIntervalMs - Date.now();
    if (waitMs > 0) {
        logger.info?.(`[限速] 距上次下发不足 ${minIntervalMs}ms，再等 ${waitMs}ms`);
        await wait(waitMs);
    }
    lastOutboundAt = Date.now();
    return Math.max(0, waitMs);
}
// <<< send-interval patch <<<

export async function dispatchReply(event, processedReply, options = {}, deps = {}) {
    const {
        config,
        bot,
        ttsManager,
        logger = console,
        recordDashboardMetric = () => {},
        sleep = defaultSleep
    } = deps;

    // >>> cobot-truncate patch >>>
    // 用户 2026-10-10：「两个人在群里互相说话一轮不能超过 2 句，直接截断」。
    // 放在最前面（拆段/引用/语音之前），保证后面所有路径看到的都是截断后的文本。
    const coBotCapRaw = Number(config?.chat?.coBotMaxSentences);
    const coBotCap = Number.isFinite(coBotCapRaw) && coBotCapRaw > 0 ? Math.floor(coBotCapRaw) : 0;
    if (options?.isCoBotTurn === true && coBotCap > 0) {
        const rawText = String(processedReply || '');
        // 句末标点或换行都算一句的边界
        const sentences = rawText
            .split(/(?<=[。！？!?])|\r?\n+/)
            .map((s) => s.trim())
            .filter(Boolean);
        if (sentences.length > coBotCap) {
            processedReply = sentences.slice(0, coBotCap).join('\n');
            logger.info(`[互怼] 回复 ${sentences.length} 句 → 截断到 ${coBotCap} 句`);
        }
    }
    // <<< cobot-truncate patch <<<
    const ttsConfig = ttsManager?.getConfig?.() || {};
    const { textParts, hasVoice } = parseVoiceTags(String(processedReply || ''));
    const splitMessage = options.forceSingleMessage ? false : config.chat.splitMessage !== false;
    const segmentDelayMs = config.chat.segmentDelayMs ?? 300;
    const proactiveIntervalMs = config.chat.proactiveMessageIntervalMs ?? Math.max(segmentDelayMs, 1200);
    const quoteReplyEnabled = config.chat.quoteReplyEnabled !== false;
    // >>> reply-style patch (managed by patch_reply_style.py) >>>
    // 1) 句号即消息边界：QQ 上没人一句话全用句号收尾，断句交给换行/分段。
    // 2) 引用回复只留给长消息，而且只挂第一条：短回复直接发正文，
    //    拆成多条时后面的也普通发，别每条都顶个引用框。
    const splitOnPeriod = config.chat.splitOnPeriod !== false;
    const rawQuoteMinLines = config.chat.quoteReplyMinLines;
    const quoteReplyMinLines = (rawQuoteMinLines === undefined
        || rawQuoteMinLines === null
        || rawQuoteMinLines === '')
        ? 6
        : (Number.isFinite(Number(rawQuoteMinLines)) ? Number(rawQuoteMinLines) : 6);
    const replyLineCount = String(processedReply || '')
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .length;
    // quoteReplyMinLines <= 0 表示「永远引用」，即本补丁之前的旧行为。
    const quoteThisReply = quoteReplyEnabled
        && (quoteReplyMinLines <= 0 || replyLineCount >= quoteReplyMinLines);
    const splitReplyIntoSegments = (text) => {
        // >>> code-safety patch (managed by patch_code_safety.py) >>>
        // 围栏代码块整体算一段：按行拆会把一个程序拆成几十条 QQ 消息
        //（配合 minSendIntervalMs=5000 更是灾难）。只有围栏外的正文才按句号/换行切。
        const source = String(text === undefined || text === null ? '' : text);
        const splitPlain = (part) => {
            const chunks = splitOnPeriod ? part.split('。') : [part];
            return chunks.flatMap((chunk) => chunk.split(/\r?\n+/));
        };
        const segments = [];
        const fence = /```[\s\S]*?```/g;
        let cursor = 0;
        let match;
        while ((match = fence.exec(source)) !== null) {
            segments.push(...splitPlain(source.slice(cursor, match.index)));
            segments.push(match[0]);
            cursor = match.index + match[0].length;
        }
        segments.push(...splitPlain(source.slice(cursor)));
        return segments
            .map((segment) => segment.trim())
            .filter(Boolean);
        // <<< code-safety patch <<<
    };
    // <<< reply-style patch <<<
    const mentionSenderOnReply = config.chat.mentionSenderOnReply !== false;
    const mentionPrefix = event.message_type === 'group' && mentionSenderOnReply ? buildGroupMentionPrefix(event.user_id) : '';
    const ttsEnabled = ttsConfig.enabled === true;
    let hasSentPrimary = false;

    const sendText = async (content, options = {}) => {
        // >>> silence-gate patch (managed by patch_silence_gate.py) >>>
        // 生成可以提前（runtime 的 prefetch 计时器），但发送必须等本轮静默窗口结束；
        // 期间用户又发了消息 ⇒ 本轮作废，直接不发。
        const gateKey = sessionKeyFromEvent(event);
        if (gateKey) {
            const sendable = await waitUntilSendable(gateKey, sleep, logger);
            if (!sendable) {
                // >>> group-no-supersede patch >>>
                logger.warn?.('[闸门] 整段回复被丢弃（未发送）', {
                    sessionKey: gateKey,
                    droppedLength: String(content || '').length,
                    droppedPreview: String(content || '').slice(0, 80)
                });
                // <<< group-no-supersede patch <<<
                return;
            }
        }
        // <<< silence-gate patch <<<
        // >>> send-interval patch <<<
        await awaitSendSlot(config, sleep, logger, event, options.burst === true);
        // <<< send-interval patch <<<
        const message = !hasSentPrimary && mentionPrefix ? `${mentionPrefix}${content}` : content;
// >>> send-status patch >>>
        // 发送失败（禁言 / 无权限 / 风控）⇒ 记一笔，下一轮她会知道「那条没送达」。
        // ⚠ 一定要重新 throw：原来的错误语义要保留给上层，这里只多记一笔。
        try {
// <<< send-status patch <<<
        if (event.message_type === 'group') {
            if (quoteThisReply && event.message_id && !hasSentPrimary) {
                if (!hasSentPrimary && mentionSenderOnReply && event.user_id) {
                    const segments = [
                        { type: 'reply', data: { id: String(event.message_id) } },
                        { type: 'at', data: { qq: String(event.user_id) } },
                        { type: 'text', data: { text: String(content) } }
                    ];
                    await bot.sendGroupMessage(event.group_id, segments);
                } else {
                    await bot.sendGroupReply(event.group_id, event.message_id, message);
                }
            } else {
                await bot.sendGroupMessage(event.group_id, message);
            }
        } else if (quoteThisReply && event.message_id && !hasSentPrimary) {
            await bot.sendPrivateReply(event.user_id, event.message_id, message);
        } else {
            await bot.sendPrivateMessage(event.user_id, message);
        }

        hasSentPrimary = true;
// >>> send-status patch >>>
        clearSendFailure(event);
// <<< send-status patch <<<
        } catch (error) {
// >>> send-status patch >>>
            recordSendFailure(event, error, logger);
// <<< send-status patch <<<
            throw error;
        }
    };

    // >>> sticker-send patch >>>
    // 发表情包。和 sendVoice 同构（走 send-interval 槽位 + 媒体前缀段），差别只在：
    //   ① 段里带 `sub_type: 1` ⇒ QQ 侧 `picSubType=1` ⇒ 渲染成**表情包**而不是图片；
    //   ② 不需要专用的 bot 方法 —— `sendGroupMessage/sendPrivateMessage` 本来就收段数组。
    const sendSticker = async (absPath) => {
        // >>> send-interval patch <<<
        await awaitSendSlot(config, sleep, logger, event);
        // <<< send-interval patch <<<
        // 表情包不走"必须 @"策略：只保留可选引用，绝不拼 at（和语音同理）
        const prefixSegments = buildMediaPrefixSegments(event, {
            quoteReplyEnabled,
            mentionSender: false,
            hasSentPrimary
        });
        const segments = [...prefixSegments, buildStickerSegment(absPath)];
        if (event.message_type === 'group') {
            await bot.sendGroupMessage(event.group_id, segments);
        } else {
            await bot.sendPrivateMessage(event.user_id, segments);
        }
        hasSentPrimary = true;
    };
    // <<< sticker-send patch <<<

    const sendVoice = async (audioPath) => {
        // >>> send-interval patch <<<
        await awaitSendSlot(config, sleep, logger, event);
        // <<< send-interval patch <<<
        // TTS 语音不走文本「必须 @」策略：只保留可选引用，绝不拼 at。
        // 点歌路径在 index.js 单独传 mentionSender，不会被这里影响。
        const prefixSegments = buildMediaPrefixSegments(event, {
            quoteReplyEnabled,
            mentionSender: false,
            hasSentPrimary
        });

        if (event.message_type === 'group') {
            if (typeof bot.sendGroupRecord !== 'function') {
                throw new Error('当前 OneBot 适配器不支持发送群语音');
            }
            await bot.sendGroupRecord(event.group_id, audioPath, prefixSegments);
        } else {
            if (typeof bot.sendPrivateRecord !== 'function') {
                throw new Error('当前 OneBot 适配器不支持发送私聊语音');
            }
            await bot.sendPrivateRecord(event.user_id, audioPath, prefixSegments);
        }

        hasSentPrimary = true;
    };

    const sendTtsContent = async (content, { explicitVoice = false } = {}) => {
        try {
            logger.info?.(`[TTS] 合成语音: ${String(content || '').substring(0, 30)}...`);
            recordDashboardMetric('tts');
            const audioPath = await ttsManager.synthesize(content);
            await sendVoice(audioPath);
            logger.info?.('[TTS] 语音发送成功');
        } catch (error) {
            logger.warn?.(`[TTS] 语音合成或发送失败: ${error.message}`);
            await sendText(buildVoiceFallbackText(content, { explicitVoice }));
        }
    };

    for (let partIndex = 0; partIndex < textParts.length; partIndex += 1) {
        const part = textParts[partIndex];
        const content = String(part.content || '').trim();

        if (part.type === 'text') {
            // >>> sticker-send patch >>>
            // 先把 [表情:类别] 标记摘出来。⚠ 必须在**分段之前**摘：
            // 否则 `[表情:开心]` 会被 splitReplyIntoSegments 切成独立一段、当成一句文字发出去。
            let textContent = content;
            const stickerPaths = [];
            {
                const stickerCfg = getStickerConfig(config);
                if (stickerCfg.enabled && STICKER_MARKER_TEST.test(content)) {
                    const { cleaned, requests } = extractStickerMarkers(content);
                    textContent = cleaned;
                    if (requests.length > 0) {
                        const lib = scanStickerLibrary(resolveStickerDir(config));
                        for (const req of requests.slice(0, stickerCfg.maxPerReply)) {
                            const picked = pickSticker(lib, req.category);
                            if (picked) {
                                stickerPaths.push(picked);
                            } else {
                                // 库空 / 类别不存在：**说清楚**，不然她会以为发出去了
                                logger.warn?.(`[表情] 抽不到表情包（类别="${req.category}"，库内 ${lib.total} 张）`);
                            }
                        }
                    }
                }
            }
            // <<< sticker-send patch <<<

            // >>> sticker-send patch >>>
            // 🔴 静默兜底：整条回复**只有**标记、可表情又一张都没抽到（库被清空 / 类别没有图）
            //    ⇒ 上面两条路都不会发任何东西 ⇒ 用户看到的是"她压根没回"。
            //    这种情况下宁可把原文（含标记）当文字发出去 —— 难看，但**看得见**。
            //    本项目的原则：失败要可见，不要静默。
            if (!textContent && stickerPaths.length === 0 && content) {
                textContent = content;
                logger.warn?.('[表情] 标记没换成表情包，已按原文发送（避免整轮无输出）');
            }
            // <<< sticker-send patch <<<

            // 无 [voice] 标签且开启 TTS：整段当语音（历史行为）
            // 有 [voice] 标签：正文保持文字，只有 voice 段才合成，实现「文字里夹语音」
            if (ttsEnabled && !hasVoice) {
                if (textContent) {
                    await sendTtsContent(textContent, { explicitVoice: false });
                } else {
                    // >> sticker-send patch >>>
                    // 整条回复只有表情标记时，TTS 没东西可合成 ⇒ 直接发表情，别合成空语音
                    for (const stickerPath of stickerPaths) {
                        await sendSticker(stickerPath);
                    }
                    // <<< sticker-send patch <<<
                }
                continue;
            }

            const segments = splitMessage
                ? splitReplyIntoSegments(textContent)
                : [textContent];

            for (let index = 0; index < segments.length; index += 1) {
                const segment = segments[index];
                const segmentContent = segment.trim();
                if (!segmentContent) {
                    continue;
                }

                const isPrimarySend = !hasSentPrimary;
                await sendText(segmentContent, { burst: !isPrimarySend });
                const hasMoreSegments = index < segments.length - 1 || partIndex < textParts.length - 1;
                const delayMs = isPrimarySend ? segmentDelayMs : proactiveIntervalMs;
                if (hasMoreSegments && delayMs > 0) {
                    await sleep(delayMs);
                }
            }
            // >>> sticker-send patch >>>
            // 文字发完再发图 —— 顺序反了会像"先甩张图再解释"，读起来很怪。
            // 若整条回复只有标记（textContent 为空、循环空转），这里就是唯一的下发。
            for (const stickerPath of stickerPaths) {
                await sendSticker(stickerPath);
            }
            // <<< sticker-send patch <<<
            continue;
        }

        if (part.type === 'voice' && ttsEnabled) {
            await sendTtsContent(content, { explicitVoice: true });
            continue;
        }

        if (part.type === 'voice') {
            // TTS 未启用时无法真正发 record，给出可读回退，避免静默丢语音意图
            const preface = buildVoicePrefaceText(content);
            await sendText(preface.includes('语音') ? `${preface}（当前未启用 TTS，无法发送语音消息）` : `语音内容：${content || '（空）'}（当前未启用 TTS，无法发送语音消息）`);
        }
    }
}
