/**
 * 关键词应答 —— 命中就给固定答案，**不调模型**。
 *
 * 场景（2026-10-31 用户需求）：soyo 要拉进比赛群，群里有大量重复问题
 * （在哪报名 / 几点开始 / 怎么提交 / 群文件在哪）。
 * 这类问题让模型现场编既慢又可能编错，直接查表最稳。
 *
 * 设计要点：
 *   · 匹配在**指令之后、AI 之前**：`/画像` 这类指令优先，不会被关键词吃掉；
 *   · 三种匹配方式：exact（全等）/ contains（包含，默认）/ regex（正则）；
 *   · 每条可独立设冷却，避免同一个问题被连问十次就刷十遍；
 *   · 作用域：只对指定群生效（比赛群 vs 日常群互不干扰）；
 *   · 命中后**不进入 AI 流程**，省钱、零延迟、零幻觉。
 */

const lastHit = new Map();   // "<sessionKey>|<itemId>" -> ts

function normalize(text) {
    return String(text ?? '')
        .replace(/\[[^\]]{0,60}\|[^\]]{0,60}\]/g, ' ')   // [@某人|扣扣:123]
        .replace(/\[[^\]]{0,20}\]/g, ' ')                // [图片] 之类
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * @returns {{reply: string, itemId: string}|null} 命中则返回要发的内容
 */
export function matchKeywordReply(chatConfig = {}, sessionKey = '', plainText = '', options = {}) {
    const cfg = chatConfig?.keywordReplies || {};
    if (cfg.enabled !== true) return null;
    const items = Array.isArray(cfg.items) ? cfg.items : [];
    if (items.length === 0) return null;

    const now = options.now ?? Date.now();
    const text = normalize(plainText);
    if (!text) return null;
    // 指令优先：以 / 或常见前缀开头的交给指令处理
    if (/^[/／]/.test(text)) return null;

    const scope = String(sessionKey || '');
    for (const item of items) {
        if (!item || item.enabled === false) continue;
        if (!item.reply) continue;
        // 作用域：不写＝所有会话；写了则只在这些会话生效
        const scopes = Array.isArray(item.scopes) ? item.scopes.map(String) : [];
        if (scopes.length > 0 && !scopes.includes(scope)) continue;

        const keywords = Array.isArray(item.keywords) ? item.keywords.filter(Boolean) : [];
        if (keywords.length === 0) continue;

        const mode = String(item.match || 'contains').toLowerCase();
        const hit = keywords.some((kw) => {
            const k = String(kw);
            if (mode === 'exact') return text === k;
            if (mode === 'regex') {
                try { return new RegExp(k, 'i').test(text); } catch { return false; }
            }
            return text.includes(k);
        });
        if (!hit) continue;

        // 冷却
        const cooldownMs = Number(item.cooldownMs ?? cfg.defaultCooldownMs ?? 60000);
        const id = String(item.id || keywords[0]);
        const key = `${scope}|${id}`;
        const last = lastHit.get(key) || 0;
        if (cooldownMs > 0 && now - last < cooldownMs) {
            return { reply: '', itemId: id, cooled: true };
        }
        lastHit.set(key, now);
        return { reply: String(item.reply), itemId: id, cooled: false };
    }
    return null;
}

/** 测试用：清空冷却表 */
export function resetKeywordCooldown() {
    lastHit.clear();
}
