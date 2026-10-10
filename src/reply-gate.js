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

/** 某会话上一轮的静默窗口还没到就又有新消息进来了 */
export function noteInbound(sessionKey) {
    if (!sessionKey) return;
    const state = sessions.get(sessionKey) || {};
    state.lastInboundAt = Date.now();
    // 已经有在途回复 ⇒ 作废它（它生的是上一轮的内容，不能再发）
    if (state.active) {
        state.superseded = true;
    }
    sessions.set(sessionKey, state);
}

/** 一轮回复开始（无论是提前 flush 还是正常 flush） */
export function beginReply(sessionKey, holdUntilTs) {
    if (!sessionKey) return;
    const state = sessions.get(sessionKey) || {};
    state.active = true;
    state.superseded = false;
    state.holdUntil = Math.max(0, Number(holdUntilTs) || 0);
    sessions.set(sessionKey, state);
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
                logger.info?.('[闸门] 本轮已被新消息作废，放弃发送', { sessionKey });
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
