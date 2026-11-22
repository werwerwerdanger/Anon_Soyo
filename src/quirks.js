/**
 * 口癖 —— 让她偶发地学着群里人说话。
 *
 * 为什么从「她本来就能看到的历史」里提，而不是建一个词库：
 *   1. 群里的高频词换个说法就是"黑话"，建库要人肉维护，很快过期；
 *   2. 她已经能看到最近几十条原文，缺的不是数据，是**注意力**——
 *      提示词里明说"最近大家爱这么说"，比让她自己从 40 条里归纳要稳；
 *   3. 不额外读库、不跨会话串味。
 *
 * 三条安全边界（不设就是坑）：
 *   · 只统计**纯文字**消息（跳过图片转述、URL、@ 标记、名片）；
 *   · 脏话黑名单直接剔除 —— 见过"她学群里骂人"的后果；
 *   · 同一句 30 分钟内不重复 + 每轮有概率才注入，避免变成复读机。
 */

const BLACKLIST = ['傻逼', '煞笔', '妈的', '你妈', '操你', 'cnm', 'sb', '滚', '去死', '垃圾', '弱智', '脑瘫'];
const STOPWORDS = new Set([
    '这个', '那个', '什么', '怎么', '没有', '就是', '不是', '可以', '我们', '你们', '他们',
    '一个', '现在', '今天', '明天', '昨天', '哈哈', '真的', '有点', '感觉', '知道', '还是',
    '这样', '那样', '因为', '所以', '但是', '如果', '已经', '可能', '应该', '需要', '自己',
    '时候', '东西', '问题', '看看', '一下', '不太', '不是', '好多', '感觉'
]);

/** 把一条历史消息压成"人说的话"，去掉信封、@ 标记、图片转述。 */
export function plainFromEnvelope(content) {
    let s = String(content ?? '');
    // 信封：[群聊|QQ:1|昵称:x|...] 正文
    const m = s.match(/\]\]\s*([\s\S]*)$/);
    if (m) s = m[1];
    s = s.replace(/\[[^\]\n]{0,60}\|[^\]\n]{0,60}\]/g, ' ');   // [@某人|扣扣:123]
    s = s.replace(/图片转述[\s\S]*$/g, ' ');
    s = s.replace(/<image_caption>[\s\S]*$/gi, ' ');
    s = s.replace(/\[图片[^\]]*\]/g, ' ').replace(/\[动画表情\]/g, ' ');
    s = s.replace(/https?:\/\/\S+/g, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    return s;
}

/**
 * 从最近的消息里找"大家都爱说的话"。
 * @returns {Array<{text: string, count: number}>} 按出现次数降序
 */
export function extractQuirks(messages = [], options = {}) {
    const minLen = options.minLen ?? 2;
    const maxLen = options.maxLen ?? 5;
    const minCount = options.minCount ?? 2;
    const limit = options.limit ?? 6;

    const counts = new Map();
    let used = 0;
    for (const msg of Array.isArray(messages) ? messages : []) {
        if (msg?.role === 'assistant') continue;              // 不学自己的
        const body = plainFromEnvelope(msg?.content);
        if (!body || body.length > 60) continue;              // 长段落不是口癖
        if (/^\[/.test(body)) continue;
        used += 1;
        const seen = new Set();                               // 同一条只算一次
        for (let n = minLen; n <= maxLen; n += 1) {
            for (let i = 0; i + n <= body.length; i += 1) {
                const g = body.slice(i, i + n);
                if (!/^[\u4e00-\u9fa5A-Za-z0-9]+$/.test(g)) continue;
                if (/^[0-9]+$/.test(g)) continue;             // QQ 号之类
                if (STOPWORDS.has(g)) continue;
                if (seen.has(g)) continue;
                seen.add(g);
                counts.set(g, (counts.get(g) || 0) + 1);
            }
        }
    }

    const out = [];
    for (const [text, count] of counts) {
        if (count < minCount) continue;
        if (BLACKLIST.some((w) => text.includes(w))) continue;
        out.push({ text, count });
    }
    // 长短语优先（更"像一句话"），次数其次
    out.sort((a, b) => (b.count - a.count) || (b.text.length - a.text.length));
    // 去掉被更长候选包含的碎片（"绷不住" 里的 "不住"）
    const picked = [];
    for (const item of out) {
        if (picked.some((p) => p.text.includes(item.text) || item.text.includes(p.text))) continue;
        picked.push(item);
        if (picked.length >= limit) break;
    }
    return { quirks: picked, messageCount: used };
}

// sessionId -> [{ text, at }]
const recentUse = new Map();

/**
 * 随机决定这一轮要不要"学一句口癖"，返回要注入的短语或 null。
 * @param {string} sessionId
 * @param {Array<{text:string,count:number}>} quirks
 */
export function pickQuirk(sessionId, quirks = [], options = {}) {
    const chance = Number.isFinite(options.chance) ? options.chance : 0.25;
    const cooldownMs = Number.isFinite(options.cooldownMs) ? options.cooldownMs : 30 * 60 * 1000;
    const now = options.now ?? Date.now();
    if (!Array.isArray(quirks) || quirks.length === 0) return null;
    if (Math.random() >= chance) return null;

    const key = String(sessionId || '');
    const usedList = (recentUse.get(key) || []).filter((x) => now - x.at < cooldownMs);
    recentUse.set(key, usedList);
    const fresh = quirks.filter((q) => !usedList.some((u) => u.text === q.text));
    if (fresh.length === 0) return null;
    const pick = fresh[Math.floor(Math.random() * fresh.length)];
    usedList.push({ text: pick.text, at: now });
    return pick.text;
}

/** 测试用：清冷却 */
export function resetQuirkCooldown() {
    recentUse.clear();
}
