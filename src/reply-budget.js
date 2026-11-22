/**
 * 发言预算 —— 防止"别人说一句她接一句"。
 *
 * 2026-11-01 事故（音游群 573896722）：
 *   79 条消息她回 11 条（13.9%），总量不算多，但**相邻两次回复只隔 17~46 秒**，
 *   变成"每句都接"，群里直接说「这机器人好欠啊」。
 *   问题不在比例，在**节奏**：真人不会对每一句都回应。
 *
 * 两条规则：
 *   ① 她自己刚说完话（默认 2 分钟内），除非有人 @ 她 / 接着她的话，否则不再开口；
 *   ② 滑动窗口内最多回 N 条（默认 10 分钟 4 条），防止长时间絮叨。
 *
 * 注意：被点名的（@ / 回复她）**永远不受限** —— 喊她就得答应。
 */

const lastReplyAt = new Map();      // sessionKey -> ts
const replyTimes = new Map();       // sessionKey -> [ts]

/**
 * 她刚发完这条，登记一下。
 */
export function noteOwnReply(sessionKey = '', now = Date.now()) {
    const key = String(sessionKey || '');
    if (!key) return;
    lastReplyAt.set(key, now);
    const arr = (replyTimes.get(key) || []).filter((t) => now - t < 30 * 60 * 1000);
    arr.push(now);
    replyTimes.set(key, arr);
}

/**
 * 现在该不该闭嘴。
 * @returns {{skip: boolean, reason: string}}
 */
export function shouldStaySilent(sessionKey = '', options = {}) {
    const cfg = options.cfg || {};
    if (cfg.enabled === false) return { skip: false, reason: 'disabled' };
    // 被点名永远放行
    if (options.addressed === true) return { skip: false, reason: 'addressed' };

    const now = options.now ?? Date.now();
    const key = String(sessionKey || '');
    if (!key) return { skip: false, reason: 'no-session' };

    const silentAfterOwnMs = Number(cfg.silentAfterOwnMs ?? 120000);
    const windowMs = Number(cfg.windowMs ?? 600000);
    const maxReplies = Number(cfg.maxReplies ?? 4);

    const last = lastReplyAt.get(key);
    if (silentAfterOwnMs > 0 && last !== undefined && now - last < silentAfterOwnMs) {
        return { skip: true, reason: `just-spoke(${Math.round((now - last) / 1000)}s)` };
    }

    if (maxReplies > 0) {
        const arr = (replyTimes.get(key) || []).filter((t) => now - t < windowMs);
        replyTimes.set(key, arr);
        if (arr.length >= maxReplies) {
            return { skip: true, reason: `window-limit(${arr.length}/${maxReplies})` };
        }
    }
    return { skip: false, reason: 'ok' };
}

/** 测试用 */
export function resetReplyBudget() {
    lastReplyAt.clear();
    replyTimes.clear();
}
