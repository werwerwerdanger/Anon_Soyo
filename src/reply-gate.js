/**
 * silence gate —— 「提前调 AI，等到静默窗口结束再发」的闸门
 *
 * 为什么需要（2026-10-10 用户需求）：
 *   用户发消息常常是连着打几条，机器人 2.5s 就回会打断他。
 *   要的是：最后一条消息后静默一段时间才算这轮说完；静默到某个时间点提前调 AI，
 *   这样窗口一结束就能立刻发出去，不用再等生成。
 *
 * 但「提前调 AI」有个必须解决的问题：15s 时已经开始生成了，如果用户 16s 又发了一条，
 * 这条在途回复就过期了，绝不能再发出去。所以生成可以提前，**发送必须被闸住**：
 *   - 闸住到「本轮静默窗口结束」的时刻（holdUntil）
 *   - 期间每 500ms 复查一次；一旦发现被新消息作废（superseded），立刻放弃
 *
 * 状态按 sessionKey 存（group:<群号> / private:<QQ>），和 runtime.js 的 sessionKey 格式一致，
 * 这样 reply-dispatcher 可以直接从 event 算出来，不需要层层穿参。
 *
 * 失败方向：拿不到状态、时间算不出来 ⇒ 一律放行（返回 true），
 * 闸门绝不能变成「消息发不出去」的原因。
 */

const sessions = new Map();

// >>> group-no-supersede patch >>>
// 2026-10-17：群聊「换话题就作废在途回复」被实证为**常态漏答** ——
// 群里同一时刻本来就有好几个人说话，新消息与本轮文本「词面零重叠」几乎必然成立，
// 于是已经生成好的整轮回复在最后一刻被静默丢掉（当日 46 轮丢 5 轮，
// 含一份完整的 P1011 题解：算完了 / 就设第二站上下车都是 u / … 四段全丢）。
// 新话题会自己进下一批被再答一次，所以群聊**不需要**靠作废去「避免答非所问」。
const GROUP_SUPERSEDE_ENABLED = false;
const PRIVATE_TOPIC_SWITCH_MIN_CHARS = 16;   // 私聊：8 -> 16，只有明显另起一段的才作废
// <<< group-no-supersede patch <<<

/**
 * 归一化：去掉占位文本（[图片]/[动画表情]）、空白、标点，小写。
 * 只用于**词面**比较，不假装懂语义。
 */
function normalizeForCompare(text) {
    return String(text || '')
        .replace(/\[[^\]]{0,12}\]/g, ' ')
        .replace(/[\s\p{P}\p{S}]/gu, '')
        .toLowerCase();
}

function bigrams(s) {
    const out = new Set();
    for (let i = 0; i + 1 < s.length; i++) {
        out.add(s.slice(i, i + 2));
    }
    return out;
}

/**
 * 新消息是不是**换了话题**（用来决定要不要作废在途回复）。
 *
 * 🔴 为什么这么保守（2026-10-13）：
 * 原来的逻辑是「只要有新消息就作废在途回复」，用户实测**私聊被作废 17 次** ——
 * 连打时每来一句就吃掉上一句已经生成好的回复，用户看到的是**漏答 + 跳答**
 * （他自己发了「你是不是又死了」）。所以改成：
 *   - **判不出来 = 当作"接着说" = 不作废**（宁可多发一句同话题的，也别漏答）；
 *   - 只有「新消息够长 **且** 与本轮目标文本**词面零重叠**」才判换话题。
 *
 * ⚠ 局限（必须承认）：同一件事可以零词面重叠（「室友问了句 are you ok」→「但是我没有朋友啊」），
 *   这种会被误判成"换话题"而作废。**词面判语义本来就不可靠**，所以阈值取得保守：
 *   宁可在"真换话题"时偶尔多发一句旧话题，也不要常态漏答。
 *   短句（< minChars）一律当"接着说" —— 「嗯」「不知道」这类本来就没话题信息。
 */
export function isTopicSwitch(roundText, newText, { minChars = 8 } = {}) {
    const n = normalizeForCompare(newText);
    if (n.length < minChars) return false;
    const r = normalizeForCompare(roundText);
    if (!r) return false;
    const rb = bigrams(r);
    for (const g of bigrams(n)) {
        if (rb.has(g)) return false;      // 有任何重叠 ⇒ 接着说
    }
    return true;                          // 够长 + 零重叠 ⇒ 换话题
}

/**
 * 某会话来了一条新消息。
 * @param {string} sessionKey
 * @param {string} newText 新消息文本（用于判有没有换话题；缺省时按"接着说"处理，即不作废）
 */
export function noteInbound(sessionKey, newText = '') {
    if (!sessionKey) return;
    const state = sessions.get(sessionKey) || {};
    state.lastInboundAt = Date.now();
    // 已经有在途回复 ⇒ 只有**换了话题**才作废它。
    // 原来是无条件作废；改成条件作废后，连打时不再吃掉上一句的回复（用户 2026-10-13 要求）。
    if (state.active) {
        // >>> group-no-supersede patch >>>
        const isGroupSession = String(sessionKey).startsWith('group:');
        if (isGroupSession && !GROUP_SUPERSEDE_ENABLED) {
            // 群聊不作废：第三人插话是常态，作废=漏答。放到下一批再答更划算。
            state.supersededReason = 'group_keep';
        } else if (isTopicSwitch(state.roundText, newText, { minChars: PRIVATE_TOPIC_SWITCH_MIN_CHARS })) {
            state.superseded = true;
            state.supersededReason = 'topic_switch';
        } else {
            state.supersededReason = 'related_keep';
        }
        // <<< group-no-supersede patch <<<
    }
    sessions.set(sessionKey, state);
}

/**
 * 一轮回复开始（无论是提前 flush 还是正常 flush）
 * @param {string} roundText 本轮正在回的那些消息的文本（用于跟新消息比"是否换话题"）
 */
export function beginReply(sessionKey, holdUntilTs, roundText = '') {
    if (!sessionKey) return;
    const state = sessions.get(sessionKey) || {};
    state.active = true;
    state.superseded = false;
    state.supersededReason = '';
    state.roundText = String(roundText || '');
    state.holdUntil = Math.max(0, Number(holdUntilTs) || 0);
    sessions.set(sessionKey, state);
}

/** 供日志用：为什么没作废 / 为什么作废 */
export function getSupersededReason(sessionKey) {
    const state = sessionKey ? sessions.get(sessionKey) : null;
    return state ? (state.supersededReason || '') : '';
}

export function endReply(sessionKey) {
    if (!sessionKey) return;
    const state = sessions.get(sessionKey);
    if (!state) return;
    state.active = false;
    state.superseded = false;
}

export function isSuperseded(sessionKey) {
    const state = sessionKey ? sessions.get(sessionKey) : null;
    return Boolean(state && state.superseded);
}

export function getHoldUntil(sessionKey) {
    const state = sessionKey ? sessions.get(sessionKey) : null;
    return state && Number.isFinite(state.holdUntil) ? state.holdUntil : 0;
}

/** 从 OneBot 事件算 sessionKey，必须和 runtime.js 的格式一致 */
export function sessionKeyFromEvent(event) {
    if (!event) return '';
    if (event.message_type === 'group' && event.group_id) {
        return `group:${event.group_id}`;
    }
    if (event.message_type === 'private' && event.user_id) {
        return `private:${event.user_id}`;
    }
    if (event.group_id) return `group:${event.group_id}`;
    if (event.user_id) return `private:${event.user_id}`;
    return '';
}

/**
 * 等到可以发送为止。
 * @returns {Promise<boolean>} true=可以发，false=本轮已被新消息作废，放弃发送
 */
export async function waitUntilSendable(sessionKey, sleepFn, logger = console) {
    try {
        const holdUntil = getHoldUntil(sessionKey);
        if (!holdUntil) return true;
        const wait = typeof sleepFn === 'function'
            ? sleepFn
            : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        for (;;) {
            if (isSuperseded(sessionKey)) {
                // >>> group-no-supersede patch >>>
                // INFO 级 + 无条件打印「回复下发完成」= 日志在骗人（看日志像发了、看 QQ 像没发）
                logger.warn?.('[闸门] 本轮已被新消息作废，放弃发送', {
                    sessionKey,
                    reason: getSupersededReason(sessionKey)
                });
                // <<< group-no-supersede patch <<<
                return false;
            }
            const left = holdUntil - Date.now();
            if (left <= 0) return true;
            // 分片等待，便于新消息一到就立刻中止，而不是等满整个窗口
            await wait(Math.min(left, 500));
        }
    } catch (error) {
        // 闸门出错一律放行
        logger.warn?.(`[闸门] 等待异常，按可发送处理: ${error?.message || error}`);
        return true;
    }
}
