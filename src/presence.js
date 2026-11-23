/**
 * 在线感（presence）：她这个点到底回不回得了
 *
 * 用户 2026-11-23：「有没有什么办法让他们故意不回消息，或者知道对面在不回消息」
 *
 * 能做的：
 *   ① 故意不回 —— 按"这个点忙不忙"掷骰子，跳过的消息照样入库，所以她**知道自己漏了**
 *   ② 回不了 —— 上课/深夜/社团时段概率拉高，事后可以解释成"刚没看见"
 * 做不到的（协议层）：
 *   ✗ "对方正在输入" —— OneBot 不推这个事件
 *   ✗ 私聊已读回执 —— QQ 私聊没有这个机制
 *   所以"知道对面已读不回"只能靠时间推断（见 describePendingGap）
 *
 * 设计取向：**默认很轻**（6%）。这个东西做重了会像机器人坏了，
 * 用户第一反应是"她不理我"而不是"她大概在忙"。要重就调 baseSkip / hours。
 */
const DEFAULTS = {
    enabled: true,
    baseSkip: 0.06,        // 平时看到但有 6% 不回
    privateFactor: 0.5,    // 私聊要更及时，概率打对折
    atBotAlwaysReply: true,// 被点名一定回
    hours: {
        '0-6': 0.55,       // 深夜，多半睡着了
        '8-12': 0.32,      // 上午的课，手机在桌下
        '13-17': 0.22,     // 下午课/社团
        '22-24': 0.18      // 该睡了但还醒着
    }
};

function cfgOf(config) {
    const raw = config?.chat?.presence || {};
    return {
        ...DEFAULTS,
        ...raw,
        hours: { ...DEFAULTS.hours, ...(raw.hours || {}) }
    };
}

/** 这个点的基础不回概率（按时段取最大命中值）。 */
export function skipChanceAt(config, now = Date.now()) {
    const cfg = cfgOf(config);
    const hour = new Date(now).getHours();
    let chance = Number(cfg.baseSkip) || 0;
    for (const [range, value] of Object.entries(cfg.hours || {})) {
        const [from, to] = String(range).split('-').map(Number);
        if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
        const hit = from <= to ? (hour >= from && hour < to) : (hour >= from || hour < to);
        if (hit) chance = Math.max(chance, Number(value) || 0);
    }
    return Math.max(0, Math.min(1, chance));
}

/**
 * 这一轮要不要故意不回。
 * @returns {{silent: boolean, reason: string, chance: number, roll: number}}
 */
export function shouldStaySilent({ config = {}, event = null, isAtMe = false, now = Date.now() } = {}) {
    const cfg = cfgOf(config);
    if (!cfg.enabled) return { silent: false, reason: 'disabled', chance: 0, roll: 1 };
    // 被点名、下指令，一律回 —— 否则用户会觉得坏了
    if (isAtMe && cfg.atBotAlwaysReply !== false) {
        return { silent: false, reason: 'at_bot', chance: 0, roll: 1 };
    }
    let chance = skipChanceAt(config, now);
    if (event?.message_type === 'private') {
        chance *= Number(cfg.privateFactor ?? DEFAULTS.privateFactor);
    }
    chance = Math.max(0, Math.min(1, chance));
    const roll = Math.random();
    return {
        silent: roll < chance,
        reason: roll < chance ? 'busy' : 'ok',
        chance: Number(chance.toFixed(3)),
        roll: Number(roll.toFixed(3))
    };
}

/**
 * 她"刚才没回"这件事要让她自己知道。
 *
 * 判据：最后一条是对方说的，且已经过去一段时间，之后没有她的回复。
 * 返回一句给模型看的话（没有就返回空串）。
 */
export function describePendingGap({ messages = [], now = Date.now(), minGapMs = 25 * 60 * 1000 } = {}) {
    const list = Array.isArray(messages) ? messages : [];
    if (!list.length) return '';
    const last = list[list.length - 1];
    if (!last || last.role === 'assistant') return '';
    const at = Number(last.timestamp || last.at || 0);
    if (!at) return '';
    const gap = now - at;
    if (gap < minGapMs) return '';
    const minutes = Math.floor(gap / 60000);
    const text = minutes < 90 ? `${minutes} 分钟前` : `${Math.floor(minutes / 60)} 小时前`;
    return `【刚才】对方 ${text} 说的那句，你还没回。可以说一句刚在忙，也可以直接接着回，别装作没看见。`;
}

export { DEFAULTS as PRESENCE_DEFAULTS };
