/**
 * 答疑知识库（比赛群用）—— 命中就答，找不到就**闭嘴**。
 *
 * 与 keywordReplies 的分工：
 *   keywordReplies 是"死记硬背"：关键词硬命中 → 原样弹出固定答案；
 *   faq 是"能查的问答库"：先按相似度找候选，候选够像就直接答；
 *   候选不够像但也不离谱时，才让模型在**候选条目内**挑一条改写；
 *   模型说没有 → **不回**（不要"我也不知道呢"这种废话，答疑群最烦这个）。
 *
 * 三条原则：
 *   1. 答案只能来自知识库，禁止自由发挥（比赛规则说错一句就是事故）；
 *   2. 宁可沉默，也不猜（找不到就不回，人在群里自然会问第二遍）；
 *   3. 只有"像问题"的消息才进入这条路，闲聊不占用。
 */

const QUESTION_HINT = /[?？]|怎么|怎样|多少|几点|在哪|哪里|能不能|可不可以|是否|请问|有没有|是什么|怎么办|在哪看|何时|报名|提交|签到|规则|账号|密码|环境|机房|评测|题目/;

/** 这句话像不像在问问题。 */
export function isQuestionLike(text = '') {
    const s = String(text || '').trim();
    if (s.length < 3) return false;
    if (s.length > 200) return false;          // 长文多半是讨论，不是提问
    return QUESTION_HINT.test(s);
}

function normalize(s) {
    return String(s || '')
        .replace(/\[[^\]]{0,60}\|[^\]]{0,60}\]/g, ' ')
        .replace(/[^\u4e00-\u9fa5A-Za-z0-9?？]+/g, ' ')
        .toLowerCase()
        .trim();
}

function bigrams(s) {
    const out = new Set();
    for (let i = 0; i + 1 < s.length; i += 1) out.add(s.slice(i, i + 2));
    return out;
}

/**
 * 给知识库条目打分：关键词命中 + 二元组重叠。
 * @returns {Array<{item, score, hitKeywords}>} 降序
 */
export function scoreFaq(question = '', items = []) {
    const q = normalize(question);
    if (!q) return [];
    const qb = bigrams(q);
    const scored = [];
    for (const item of Array.isArray(items) ? items : []) {
        if (!item || item.enabled === false || !item.answer) continue;
        const keywords = Array.isArray(item.keywords) ? item.keywords.filter(Boolean) : [];
        const hitKeywords = keywords.filter((k) => q.includes(normalize(k)));
        let score = hitKeywords.length * 3;
        const qText = normalize([item.title || '', ...(item.questions || []), ...keywords].join(' '));
        const ib = bigrams(qText);
        let overlap = 0;
        for (const g of qb) if (ib.has(g)) overlap += 1;
        score += Math.min(6, overlap * 0.5);
        if (score > 0) scored.push({ item, score, hitKeywords });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored;
}

/** 给模型看的候选（只要前几条，太多它会挑错）。 */
export function buildFaqCandidatesText(scored = [], limit = 4) {
    return scored.slice(0, limit).map((s, i) => {
        const qs = [s.item.title, ...(s.item.questions || [])].filter(Boolean).slice(0, 3).join(' / ');
        return `[${i + 1}] 问法：${qs || s.item.id}\n答案：${String(s.item.answer).slice(0, 300)}`;
    }).join('\n\n');
}

export function buildFaqPrompt(question = '', scored = [], limit = 4) {
    return [
        '你在一个编程比赛群里答疑。下面是知识库里**可能相关**的条目：',
        '',
        buildFaqCandidatesText(scored, limit),
        '',
        `群里有人问：${String(question).slice(0, 300)}`,
        '',
        '要求：',
        '1. 只能用上面的条目回答；条目里没写的，一个字都不要编。',
        '2. 用一两句口语短句回答，像群里热心同学，不要客套、不要列 1234。',
        '3. 如果上面的条目都答不了这个问题，只输出 NO_ANSWER 这一个词，不要解释。'
    ].join('\n');
}

/** 解析模型输出：没有答案就返回 null（→ 静默）。 */
export function parseFaqAnswer(raw = '') {
    const text = String(raw || '').trim();
    if (!text) return null;
    if (/NO[_ ]?ANSWER|无法回答|没有相关|不知道/i.test(text)) return null;
    const cleaned = text
        .replace(/^[\s"'「『]+|[\s"'」』]+$/g, '')
        .replace(/^(?:回答|答案)[:：]\s*/i, '')
        .trim();
    if (cleaned.length < 2) return null;
    return cleaned.slice(0, 300);
}

/**
 * 整库模式：把**所有**问答条目一次性喂给模型，让它自己认领。
 *
 * 为什么要这个模式（2026-10-31 用户要求）：
 *   二元组打分只认字面重叠，"交题在哪" 和 "怎么提交" 打分很低，直接漏答；
 *   知识库只有几十条时，全量塞进去比先检索再回答更准，也更省心。
 *   代价是每次多几千字输入 —— 只在"像提问"时才触发，可以接受。
 *
 * @param {string} question 群里的提问
 * @param {Array} items 知识库条目
 * @param {object} options { maxItems, maxChars, rewrite }
 */
export function buildFaqFullPrompt(question = '', items = [], options = {}) {
    const maxItems = Number(options.maxItems ?? 40);
    const maxChars = Number(options.maxChars ?? 6000);
    const list = (Array.isArray(items) ? items : [])
        .filter((it) => it && it.enabled !== false && it.answer)
        .slice(0, maxItems);

    const blocks = [];
    let used = 0;
    for (const it of list) {
        const qs = [it.title, ...(it.questions || [])].filter(Boolean).join(' / ');
        const block = `【${it.id}】问法：${qs || it.id}\n答案：${String(it.answer).slice(0, 400)}`;
        if (used + block.length > maxChars) break;
        used += block.length;
        blocks.push(block);
    }

    const rewrite = options.rewrite === true;
    return [
        '你在一个编程比赛群里答疑。下面是这个群已有的问答库，**全部**内容：',
        '',
        blocks.join('\n\n'),
        '',
        `群里有人问：${String(question).slice(0, 300)}`,
        '',
        '要求：',
        '1. 先判断这个问题能不能被上面某一条**直接回答**。能，就用那条的答案；不能，只输出 NO_ANSWER 这一个词。',
        '2. 答案里的信息必须来自上面那些条目，不要补充、不要推测、不要加自己的经验。',
        rewrite
            ? '3. 可以用你的口吻把答案说得自然一点，但不许改变任何事实（时间、链接、账号规则）。'
            : '3. 原样给出那条答案的文字，不要改写、不要加开场白。'
    ].join('\n');
}

// 同一条答案在一个群里反复出现很像机器人 —— 加一层"答案冷却"。
// 按答案正文哈希计，不依赖条目 id（整库模式下模型只回文字）。
const recentAnswers = new Map();   // "<session>|<hash>" -> ts

function hash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i += 1) {
        h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    return String(h);
}

/**
 * 这条答案刚在这个群说过吗？说过就跳过（默认 3 分钟内不重复）。
 * 返回 true 表示"别发了"。
 */
export function shouldSkipByRepeat(sessionKey = '', answer = '', options = {}) {
    const cooldownMs = Number(options.cooldownMs ?? 180000);
    const now = options.now ?? Date.now();
    const text = String(answer || '').trim();
    if (!text || cooldownMs <= 0) return false;
    const key = `${sessionKey}|${hash(text)}`;
    // 顺手清理过期项，避免内存涨
    for (const [k, ts] of recentAnswers) {
        if (now - ts > cooldownMs * 4) recentAnswers.delete(k);
    }
    const last = recentAnswers.get(key);
    // 没见过（undefined）＝不是重复；只有真的说过才比较时间
    if (last !== undefined && now - last < cooldownMs) return true;
    recentAnswers.set(key, now);
    return false;
}

/** 测试用 */
export function resetAnswerRepeat() {
    recentAnswers.clear();
}
