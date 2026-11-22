import { safeName } from './safe-name.js';
import { resolveChatForSession } from './session-overrides.js';
import { shouldStaySilent, noteOwnReply } from './reply-budget.js';
/**
 * Reply-decision layer: before the expensive two-call reply path runs, ask the model
 * a single question -- should this character answer this message at all?
 *
 * WHY (user, 2026-10-09): "对每个进大模型的话先决定要不要回复再回复", and for the two
 * bots "他们两个一个被骂的时候另一个最好有点反应". Chosen design: B -- the model judges
 * tone, because "is this a scolding / should I step in" is not something a keyword list
 * can decide (same lesson as 素食: mechanical matching cannot read context).
 *
 * COST: this is a third LLM call (+1), but it is tiny (short prompt, ~4 tokens out) and
 * a NO verdict SKIPS the two big calls that follow. Net saving in a busy group.
 *
 * SAFETY: fails OPEN. If the call errors, times out, or returns something unparseable,
 * we return { skip: false } -- i.e. behave exactly like today. A decision layer must
 * never be the reason a reply silently disappears.
 */
export const DEFAULT_DECISION_PROMPT = `你在替一个群里的角色决定：**这一轮我该不该开口**。

只输出一个词，不要解释、不要标点：
YES = 回
NO  = 不回

默认是 NO。宁可少说一句，也不要为了刷存在感硬接一句。
只有下面这些才回 YES：
- 有人直接点了你的名字、@ 了你、或者直接问你 —— **这一条最优先**：只要这条成立就回 YES，
  哪怕这件事你刚才已经答过、哪怕那句话很短、哪怕你觉得自己没什么新话可说；
- 有人在跟你说话，是接着你上一条在说；
- 话题就是你 —— 在议论你、夸你、损你、拿你开玩笑；
- 你被挑衅、被骂，或者你该替谁出面（有人被欺负了）。

出现下面任何一条就回 NO：
- **这一轮要收尾了**：对方在收（好 / 行 / 就这样 / 睡了 / 晚安 / 明天见 / 嗯 / 哦 / ？），
  或者上一句已经把话说完，或者同一件事你上一条已经回应过；
- **话题已经换了**：现在聊的事、聊的人跟刚才不是一拨，或者明显没你什么事。
  只要你感觉话题从你身上移开了，就立刻回 NO —— 不要接一句来留住这个话头；
- 是别人之间的对话，只是碰巧提到了某个词；
- 群里别人之间在商量事情（约时间、组队、开黑、走不走、还来不来、排不排），
  没人点名问你 —— 那是在问别人；你不要替自己报名，也不要说"等我一下"这种答应的话；
- @ 了你、但这句话本身是在对别人说（比如"没说你""我说的是他""别理它"）——
  看这句话在对谁讲，不看有没有 @；
- 纯表情包 / 贴图 / 复读 / 刷屏 / 广告 / 系统消息 / 机器人自己的输出 / 跟你无关的技术问答；
- 极短、没有信息量、像打错字或随手试探（单个字、哦、？、aa、1）。

拿不准就回 NO。

【指代】（判断"在说我吗"只看这一节）
- 「」里是发言人的**昵称**（有人昵称就叫「你」「你 耗时 已 长」），昵称里的字不是在叫你。
- 「你」默认指**被 @ 的人、或者上一句的说话对象**，不是我。只有 @ 了我、叫了我的名字、
  或者紧接着我说的内容时，「你」才指我。
- 这条 @ 的是别人、也没提我的名字 → 回 NO。别回「又没人问我」这种既接话又否认的句子。
- 【接力中】出现这个标记，说明你刚才被叫过来、正在接着聊。这时候就算没人 @ 你，
  只要这句话跟你刚才说的、或者大家一起聊的事有关，可以回 YES（别硬接无关的）。
- 「我」永远是我的自称；别人的「我」是别人。`;

export const DEFAULT_PRIVATE_DECISION_PROMPT = `你在私聊里替一个角色决定：这一条消息，值不值得回。

只输出一个词，不要解释，不要标点：
YES = 回
NO  = 不回

私聊里你们是熟人，大部分话都该回。只有这几种「这一轮没什么可接的」才回 NO：
- 对方只是在收尾（晚安、睡了、明天见、先这样、我走了），把话关掉；
- 对方发的是纯表情或贴图，没有文字要接；
- 对方明显在自言自语、刷屏、连发同一类东西；
- 你上一条已经说过要去睡了或要走了，对方只是随手再补一句；
- 极短、没有信息量、像打错字或随手试探（单字、哦、？、aa、1、在吗）。

其余都回 YES：对方在问你、跟你说话、补充或纠正刚才的话题、吐槽、调侃你，
或者话题跟你有关。拿不准就回 YES。`;

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 把最近几条消息压成一段短文本，够模型判断语气即可。 */
const DECISION_HEADER_RE = /\[(群聊|私聊)\|QQ:([^|\]]*)\|昵称:([^|\]]*)\|/;

/** 剥掉结构化消息头 / JSON 段。头里嵌了 messageSegments:[{...}]，所以要反复剥最内层。 */
export function stripStructuredHeader(raw) {
    let s = text(raw);
    let prev = null;
    let rounds = 0;
    while (prev !== s && rounds < 20) {
        prev = s;
        s = s.replace(/\[[^\[\]]*\]/g, ' ').replace(/\{[^{}]*\}/g, ' ');
        rounds += 1;
    }
    return s.replace(/\s+/g, ' ').trim();
}

/** 从结构化头里取发言人昵称（群里有好几个人，判定时必须分得清谁在说）。 */
function decisionSpeakerName(raw) {
    const m = DECISION_HEADER_RE.exec(text(raw));
    return m ? text(m[3]) : '';
}

function decisionContentText(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
        return value.filter((p) => p?.type === 'text').map((p) => p.text).join(' ');
    }
    return '';
}

/**
 * 把最近的对话压成一段短文本。
 * 「这一轮结束了没 / 换话题了没」是**序列判断** —— 没有历史就只能瞎猜，
 * 所以这里必须带上下文，并且标出说话人。
 */
// >>> decision-at-marker patch >>>
/**
 * 这一条有没有直接 @ 到 bot。
 *
 * ⚠ 必须在 `stripStructuredHeader` **之前**判 —— 它会把 `[...]` 整段删掉，
 * 而 @ 的标记有两种写法，**两种都会被吃掉**：
 *   - 结构化头里的 `isAtBot:true`
 *   - 正文前的 `[@bot]`（standard-event 的 readableText）
 * 2026-10-11 实测事故：有人 @ 了爱音问一句话，决策层看到的只有
 * `【刚进来的这条】werwer: 你觉得…怎么样`，**完全不知道被 @ 了**，
 * 于是按提示词里那句「默认是 NO」判了 NO —— 被直接点名却不回。
 * @ 是显式召唤，所以这个标记必须活到决策层看见。
 */
export function detectAtBot(raw) {
    const s = text(raw);
    if (!s) return false;
    if (/isAtBot\s*:\s*true/i.test(s)) return true;
    if (/\[@bot\]/.test(s)) return true;
    // ⚠ 刻意**不认** `[CQ:at,qq=123]`：这里拿不到 bot 自己的 QQ，
    //   认了就等于"群里 @ 谁都算 @ 了我"（会让她对每条 @别人的消息都插嘴）。
    //   上面两个标记都是本 pipeline 权威产出的：
    //   `isAtBot` 由 buildStructuredMessage 算，`[@bot]` 由 standard-event
    //   在 `segment.isBot || qq === botSelfId` 时才写。
    return false;
}
// <<< decision-at-marker patch <<<

export function buildDecisionContext(recentMessages = [], plainText = '', limit = 10) {
    const lines = [];
    const list = Array.isArray(recentMessages) ? recentMessages : [];
    // >>> speaker-quote patch >>>
    // 2026-10-31 事故：有人群昵称就叫「你 耗时 已 长」，渲染成
    //   `你 耗时 已 长: 你个打卡拉彼丘的傻逼`
    // 模型把昵称里的「你」当第二人称 ⇒ 以为在骂自己 ⇒ 判 YES（判据里"被挑衅就回"）。
    // 实测那条决策 YES 就是这么来的（19:01:37 音游群）。
    // 现在昵称一律用「」包住，并在判据里说明「」里是昵称，不是称呼。
    const wrap = (name) => `「${safeName(name, '某人')}」`;
    // <<< speaker-quote patch >>>
    for (const message of list.slice(-limit)) {
        const raw = text(decisionContentText(message?.content));
        if (!raw) continue;
        const atMe = detectAtBot(raw) ? '（@了我）' : '';
        const body = stripStructuredHeader(raw).slice(0, 160);
        // 纯 @ 没文字的也要留一行 —— 那也是"在叫你"
        if (!body && !atMe) continue;
        if (message?.role === 'assistant') {
            lines.push(`我: ${body}`);
        } else {
            // >>> speaker-quote patch >>>
            lines.push(`${wrap(decisionSpeakerName(raw))}${atMe}: ${body || '（只有 @，没有文字）'}`);
            // <<< speaker-quote patch >>>
        }
    }
    const nowRaw = text(plainText);
    const nowAtMe = detectAtBot(nowRaw) ? '（@了我）' : '';
    const now = stripStructuredHeader(nowRaw).slice(0, 300);
    if (now || nowAtMe) {
        // >>> speaker-quote patch >>>
        lines.push(`【刚进来的这条】${wrap(decisionSpeakerName(nowRaw))}${nowAtMe}: `
            + `${now || '（只有 @，没有文字）'}`);
        // <<< speaker-quote patch >>>
    }
    return lines.join('\n');
}

export function parseDecision(raw) {
    const s = text(raw).toUpperCase();
    if (!s) return null;
    if (/\bNO\b/.test(s)) return false;
    if (/\bYES\b/.test(s)) return true;
    if (s.startsWith('回')) return true;
    if (s.startsWith('不回')) return false;
    return null;
}

// >>> decision-debug patch >>>
// 2026-10-30：用户要「调试时能看到决策的思考过程」。
// 默认关（只出 YES/NO，4 个 token，最省最快）。打开 chat.replyDecision.debug 后：
//   · prompt 末尾追加一句「另起一行写为什么（≤20 字）」
//   · maxTokens 放宽到 80（原上限 64 会把原因截掉）
//   · 只解析**第一行**当裁决，后面几行进日志的 why 字段
// 注意：这是调试专用。让模型多写一句会占输出带宽，判断质量可能略有波动，
// 长期开着没必要，查问题的时候开。
const DEBUG_SUFFIX = '\n\n判完之后另起一行，写一句为什么（不超过 20 字）。第一行只能有 YES 或 NO 这两个词。';

function firstLine(raw) {
    return String(raw || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || '';
}

function restLines(raw) {
    const lines = String(raw || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return lines.slice(1).join(' ').slice(0, 60);
}
// <<< decision-debug patch <<<

/**
 * @returns {Promise<{skip: boolean, reason: string, raw: string}>}
 *   skip === true  -> do not send a reply this turn
 *   anything unexpected -> { skip: false } (fail open)
 */
export async function decideReply({ config = {}, aiClient, logger = console, recentMessages = [], plainText = '', speaker = '', messageType = '', sessionId = '', atOthers = false, addressed = false, followActive = false } = {}) {
    // 按会话取配置：群/个人可以有自己的一套判据（见 session-overrides.js）
    const sessionChat = resolveChatForSession(config, sessionId || '');
    const cfg = sessionChat?.replyDecision || config.chat?.replyDecision || {};
    if (cfg.enabled !== true) return { skip: false, reason: 'disabled', raw: '' };

    // >>> group-reply-gate patch (managed by patch_group_reply_gate.py) >>>
    // scope: 'group'（默认）只判群聊，私聊不碰；'all' 连私聊一起判。
    const decisionScope = String(cfg.scope || 'group').toLowerCase();
    if (decisionScope !== 'all' && String(messageType) !== 'group') {
        return { skip: false, reason: 'scope:' + decisionScope, raw: '' };
    }
    // <<< group-reply-gate patch <<<
    if (!aiClient || typeof aiClient.chat !== 'function') {
        return { skip: false, reason: 'no-ai-client', raw: '' };
    }
    // >>> at-others-skip patch >>>
    // 2026-11-01 事故（757026023）：
    //   `[@2519068029] 你现在cf多少分` —— @ 的是别人，她却回「诶 cf 是什么 又没人问我」。
    // 这类**确定不是对我说的**，不必花一次决策调用，更不该由模型猜。
    if (atOthers && !detectAtBot(plainText)) {
        logger.info?.('[决策] @ 的是别人且没提我，直接不回', {
            preview: String(plainText || '').slice(0, 50)
        });
        return { skip: true, reason: 'at_others', raw: '' };
    }
    // <<< at-others-skip patch >>>

    // >>> reply-budget patch >>>
    // 节奏控制：自己刚说完 2 分钟内不接话；10 分钟最多 4 条。被点名的永远放行。
    const budget = shouldStaySilent(sessionId || '', {
        addressed: addressed === true || detectAtBot(plainText),
        cfg: cfg.budget || {}
    });
    if (budget.skip) {
        logger.info?.('[决策] 发言预算，本轮闭嘴', { reason: budget.reason, session: sessionId || '' });
        return { skip: true, reason: 'budget:' + budget.reason, raw: '' };
    }
    // <<< reply-budget patch >>>

    const minChars = clampInt(cfg.minChars, 0, 10000, 0);
    if (text(plainText).length < minChars) {
        return { skip: false, reason: 'too-short-to-judge', raw: '' };
    }

// >>> decision-private patch (managed by patch_decision_private.py) >>>
    // 私聊与群聊的判据不同：群聊要判断「这条闲话点没点到我」，
    // 私聊要判断「这一句还有没有可接的」。默认改判据，promptPrivate 可覆盖。
    const isPrivateChat = String(messageType) === 'private';
    const judgePrompt = isPrivateChat
        ? (text(cfg.promptPrivate) || DEFAULT_PRIVATE_DECISION_PROMPT)
        : (text(cfg.prompt) || DEFAULT_DECISION_PROMPT);
// <<< decision-private patch <<<
// >>> group-reply-gate patch (managed by patch_group_reply_gate.py) >>>
    const debugReason = cfg.debug === true;
    const judgePromptMerged = debugReason ? `${judgePrompt}${DEBUG_SUFFIX}` : judgePrompt;
    const prompt = `${judgePromptMerged}\n\n【前面的对话（越靠下越新）】\n`
        + `${buildDecisionContext(recentMessages, plainText)}\n`
        + `${speaker ? `\n【正在说话的人】${speaker}` : ''}`
        // 接力窗口放行时告诉模型"这是我刚被叫过来的场合"，否则它按"没 @ 我"一律判 NO
        + `${followActive ? '\n【接力中】你刚被叫过来，正在接着聊。' : ''}`;
    // <<< group-reply-gate patch <<<
// >>> group-reply-gate patch (managed by patch_group_reply_gate.py) >>>
    const overrides = {
        // 调试模式要多写一行原因，4 个 token 不够；其余情况仍按精算值走。
        maxTokens: debugReason ? Math.max(80, clampInt(cfg.maxTokens, 1, 64, 4)) : clampInt(cfg.maxTokens, 1, 64, 4),
        temperature: 0,
        allowModelFallback: false,
        // 🔴 必须关掉思维链：4 个 token 一旦被推理吃掉就拿不到 YES/NO，
        //    parseDecision 返回 null ⇒ 走「失败放行」⇒ 闸门**静默失效**。
        thinking: { type: 'disabled' }
    };
    // <<< group-reply-gate patch <<<

    try {
        // >>> decision-timeout patch (managed by patch_group_reply_gate.py) >>>
        // 决策调用在 index.js 里**没有**被 callWithTimeout 包住（实测 src/ai.js 里
        // 根本没用到 config.ai.timeout）⇒ 请求一挂就拖住整轮回复，fail-open 也来不及生效。
        // 自己加一道上限，超时抛 AI_TIMEOUT，走下面的 catch ⇒ 按「回」处理。
        const decisionTimeoutMs = clampInt(cfg.timeoutMs, 500, 60000, 8000);
        const result = await Promise.race([
            aiClient.chat([{ role: 'user', content: prompt }], overrides),
            new Promise((_, reject) => setTimeout(
                () => reject(new Error('AI_TIMEOUT')), decisionTimeoutMs))
        ]);
        // <<< decision-timeout patch <<<
        const raw = text(aiClient.getVisibleResponseContent(result));
        const verdict = debugReason ? parseDecision(firstLine(raw)) : parseDecision(raw);
        const atBot = detectAtBot(plainText);
        // 🔴 把"这条 @ 了我没有"打进日志：这次事故从日志上完全看不出来
        //    （只看到 raw=NO，看不出它根本不知道被 @ 了）。
        logger.info?.('[决策] 裁决', {
            messageType: isPrivateChat ? 'private' : 'group',
            raw,
            atBot,
            ...(debugReason ? { why: restLines(raw), promptChars: prompt.length } : {}),
            preview: stripStructuredHeader(plainText).slice(0, 60)
        });
        // >>> decision-debug patch >>>
        // 调试模式额外打一份**完整输入**，方便对照"它到底看到了什么"。
        if (debugReason) {
            logger.info?.('[决策] 输入快照', { prompt });
        }
        // <<< decision-debug patch <<<
        if (verdict === null) {
            logger.warn?.(`[决策] 无法解析，按"回"处理: ${JSON.stringify(raw.slice(0, 40))}`);
            // >>> reply-decision-failopen patch >>>
            // failOpen=false ⇒ 宁可少一句，也不要多一句没头没脑的
            if (config?.chat?.replyDecision?.failOpen === false) {
                logger.warn?.('[决策] failOpen=false，本轮按不回处理');
                return { skip: true, reason: 'unparsed', raw, atBot };
            }
            // <<< reply-decision-failopen patch <<<
            return { skip: false, reason: 'unparsed', raw, atBot };
        }
        if (verdict === true) noteOwnReply(sessionId || '');
        return { skip: verdict === false, reason: verdict ? 'yes' : 'no', raw, atBot };
    } catch (error) {
        // 失败一律放行 —— 决策层绝不能成为"回复凭空消失"的原因
        const reason = String(error?.message || '') === 'AI_TIMEOUT' ? 'timeout' : 'error';
        logger.warn?.(`[决策] 判定失败(${reason})，按"回"处理: ${error?.message || error}`);
        // >>> reply-decision-failopen patch >>>
        if (config?.chat?.replyDecision?.failOpen === false) {
            logger.warn?.('[决策] failOpen=false，本轮按不回处理');
            return { skip: true, reason, raw: '' };
        }
        // <<< reply-decision-failopen patch <<<
        return { skip: false, reason, raw: '' };
    }
}
