/**
 * 发送状态 —— 让角色知道「刚才那条没送达」
 * ---------------------------------------------------------------------------
 * 为什么需要
 * ----------
 * 发送链路是：`reply-dispatcher.js` → `onebot._call('send_group_msg')` → 失败时
 * **reject(Error)** → 抛到上层只记 `logger.warn`。⇒ 角色**完全无感**。
 *
 * 真正的害处不是"她不说话"，而是**认知错位**：
 *   - 回复在生成时就已经写进 `messages`，她以为自己说过了；
 *   - 群里其实一条都没发出去，用户以为她没说话；
 *   - 于是她下一轮可能反问「我刚才不是说过了吗」。
 *
 * 本项目历史：`index.js` 里那句「而且已经导致群内被禁言」是真的 ——
 * 两个 bot 互相刷屏曾经被群管禁言过。所以禁言不是假想状态。
 *
 * 三条纪律
 * --------
 * ① **只提示一次**（`notified` 去重）。每轮都注入 ⇒ 她会变成「我发不出去」复读机。
 * ② **发送成功立刻清**，另有 TTL 兜底 —— 禁言是定时的，但我们拿不到时长。
 * ③ 文案只陈述事实，不规定她怎么回（见 §5.1：规则只描述情境）。
 */

/** sessionKey -> { reason, detail, at, notified, failures } */
const sendStates = new Map();

/** 兜底过期：禁言通常有明确时长，但 OneBot 的失败回包不一定带 ⇒ 保守 10 分钟。 */
const SEND_STATE_TTL_MS = 10 * 60 * 1000;

/** 最多记多少条，防止极端情况下无限增长（一个进程里会话数是有上限的，这里只是保险）。 */
const SEND_STATE_MAX = 200;

const MUTE_RE = /禁言|发言受限|无法发言|不能发言|muted|shut[_\s-]?up/i;
const DENIED_RE = /权限|不足|不在.{0,3}群|群不存在|被踢|踢出|kicked|forbidden|not\s*allowed/i;
const THROTTLE_RE = /风控|风险|频率|过于频繁|太快|too\s*fast|rate\s*limit|频繁/i;

/**
 * 事件 -> 会话键。必须和 `reply-gate.js::sessionKeyFromEvent` 保持同一套规则，
 * 否则"记的那个键"和"读的那个键"对不上（本项目在画像上踩过同款命名空间不一致）。
 */
export function buildSendSessionKey(event = {}) {
    if (event?.message_type === 'group' && event?.group_id) {
        return `group:${event.group_id}`;
    }
    if (event?.user_id) {
        return `private:${event.user_id}`;
    }
    return '';
}

/** 失败原因分档。分档只影响文案，不影响"记不记"。 */
export function classifySendError(error) {
    const detail = String(error?.message || error || '').trim();
    if (MUTE_RE.test(detail)) {
        return { reason: 'muted', detail };
    }
    if (DENIED_RE.test(detail)) {
        return { reason: 'denied', detail };
    }
    if (THROTTLE_RE.test(detail)) {
        return { reason: 'throttled', detail };
    }
    return { reason: 'failed', detail };
}

function trimStates() {
    if (sendStates.size <= SEND_STATE_MAX) {
        return;
    }
    // 按记录时间淘汰最老的
    const entries = [...sendStates.entries()].sort((a, b) => (a[1]?.at || 0) - (b[1]?.at || 0));
    const overflow = sendStates.size - SEND_STATE_MAX;
    for (let i = 0; i < overflow; i += 1) {
        sendStates.delete(entries[i][0]);
    }
}

/** 发送失败时调用。`logger` 可选，只用于留痕。 */
export function recordSendFailure(event, error, logger = null) {
    const key = buildSendSessionKey(event);
    if (!key) {
        return '';
    }
    const cls = classifySendError(error);
    const prev = sendStates.get(key);
    sendStates.set(key, {
        reason: cls.reason,
        detail: cls.detail,
        at: Date.now(),
        // 新的一次失败 ⇒ 可以再提示一次（但会被 getSendFailureHint 消费）
        notified: false,
        failures: (Number(prev?.failures) || 0) + 1
    });
    trimStates();
    logger?.warn?.('[发送状态] 记录发送失败', {
        sessionKey: key,
        reason: cls.reason,
        detail: cls.detail.slice(0, 120)
    });
    return key;
}

/** 发送成功时调用。 */
export function clearSendFailure(event) {
    const key = buildSendSessionKey(event);
    if (!key) {
        return;
    }
    if (sendStates.delete(key)) {
        // 静默：成功是常态，不值得打日志
    }
}

/**
 * 取一条给模型看的事实。**有副作用**：返回后会标记已提示，同一次失败不再重复。
 * 拿不到 / 已过期 / 已提示过 ⇒ 返回 `''`（调用方直接不注入）。
 */
export function getSendFailureHint(event, now = Date.now()) {
    const key = buildSendSessionKey(event);
    if (!key) {
        return '';
    }
    const state = sendStates.get(key);
    if (!state) {
        return '';
    }
    if (now - (state.at || 0) > SEND_STATE_TTL_MS) {
        sendStates.delete(key);
        return '';
    }
    if (state.notified) {
        return '';
    }
    state.notified = true;

    if (state.reason === 'muted') {
        return '你上一条回复没有送达（对方看不到内容），这个群现在不让你发言。';
    }
    if (state.reason === 'denied') {
        return '你上一条回复没有送达（对方看不到内容），机器人在这个群里没有发言权限。';
    }
    if (state.reason === 'throttled') {
        return '你上一条回复没有送达（对方看不到内容），刚才发得太快被挡下了。';
    }
    return '你上一条回复没有送达（对方看不到内容）。';
}

/** 测试/运维用：读状态但不消费。 */
export function peekSendStatus(event) {
    const key = buildSendSessionKey(event);
    return key ? (sendStates.get(key) || null) : null;
}

/** 测试用：清空全部。 */
export function resetSendStatus() {
    sendStates.clear();
}

export const SEND_STATUS_CONSTANTS = {
    TTL_MS: SEND_STATE_TTL_MS,
    MAX: SEND_STATE_MAX
};
