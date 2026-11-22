/**
 * 接力窗口（follow window）
 *
 * 问题（2026-11-17）：
 *   我们改成了"群里只有 @ 才回"。结果是：@ 她一次，她说一句，然后就永久闭嘴。
 *   真人不这样 —— 你叫一个人过来聊天，他会接着聊几句，不是答完就走。
 *
 * 做法参考：kaikan111/pangting-bot 的 GROUP_FOLLOW_TURNS / GROUP_FOLLOW_MINUTES
 *   默认 **7 句 / 4 分钟**：@ 一次之后，接下来 4 分钟内她可以主动接最多 7 句。
 *
 * 边界：
 *   - 只在**群聊**用（私聊本来就不需要 @）；
 *   - 窗口是**被 @ 才开**，且每次 @ 重新计数（不是叠加）；
 *   - 超过额度或超时立即关闭，之后又要 @ 才能说话；
 *   - 窗口开着 ≠ 一定说话：还要过决策和发言预算，只是"允许她说"。
 */

const windows = new Map();   // sessionKey -> { openedAt, used }
const DEFAULTS = { enabled: true, minutes: 4, turns: 7 };
const MAX_KEYS = 200;

function cfgOf(config) {
    const raw = config?.chat?.followWindow || config?.followWindow || {};
    return {
        enabled: raw.enabled !== false,
        minutes: Number.isFinite(Number(raw.minutes)) ? Number(raw.minutes) : DEFAULTS.minutes,
        turns: Number.isFinite(Number(raw.turns)) ? Number(raw.turns) : DEFAULTS.turns
    };
}

/** 被 @ / 被人回复时调用：开一个新窗口（重开，不叠加） */
export function openFollow(sessionKey = '', config = {}, now = Date.now()) {
    const cfg = cfgOf(config);
    if (!cfg.enabled) return false;
    const key = String(sessionKey || '');
    if (!key) return false;
    if (windows.size > MAX_KEYS) windows.clear();   // 简单粗暴地防内存涨
    windows.set(key, { openedAt: now, used: 0 });
    return true;
}

/** 窗口还开着吗？还有额度吗？（纯查询，不消耗） */
export function canFollow(sessionKey = '', config = {}, now = Date.now()) {
    const cfg = cfgOf(config);
    if (!cfg.enabled) return false;
    const w = windows.get(String(sessionKey || ''));
    if (!w) return false;
    if (now - w.openedAt > cfg.minutes * 60000) {
        windows.delete(String(sessionKey || ''));
        return false;
    }
    return w.used < cfg.turns;
}

/** 真的说了一句，扣一次额度。返回剩余次数。 */
export function consumeFollow(sessionKey = '', config = {}, now = Date.now()) {
    const cfg = cfgOf(config);
    const key = String(sessionKey || '');
    const w = windows.get(key);
    if (!w) return 0;
    if (now - w.openedAt > cfg.minutes * 60000) {
        windows.delete(key);
        return 0;
    }
    w.used += 1;
    if (w.used >= cfg.turns) windows.delete(key);
    return Math.max(0, cfg.turns - w.used);
}

/** 调试用 */
export function followState(sessionKey = '', config = {}, now = Date.now()) {
    const cfg = cfgOf(config);
    const w = windows.get(String(sessionKey || ''));
    if (!w) return { open: false, used: 0, left: 0 };
    const expired = now - w.openedAt > cfg.minutes * 60000;
    return {
        open: !expired && w.used < cfg.turns,
        used: w.used,
        left: Math.max(0, cfg.turns - w.used),
        ageSec: Math.round((now - w.openedAt) / 1000)
    };
}

/** 测试用 */
export function resetFollow() {
    windows.clear();
}

/**
 * 从 OneBot 事件推导会话键（与 index.js 里的用法保持一致）。
 * 群聊返回 group:xxx，私聊返回 private:xxx。
 */
export function sessionKeyOf(event = {}) {
    if (!event) return '';
    if (event.message_type === 'group' && event.group_id) return `group:${event.group_id}`;
    if (event.user_id) return `private:${event.user_id}`;
    return '';
}
