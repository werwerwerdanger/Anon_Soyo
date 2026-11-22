/**
 * 从她的回复里抓「共同经历」陈述句，写进 events.jsonl
 *
 * 设计取向：**宁可漏，不可脏**。一条错的 canon 会被两个实例当真，比没有更糟。
 * 所以只收「过去时 + 共同标记」的陈述句，疑问句和未来邀请一律跳过。
 *
 * 已知误判：技术闲聊也可能命中（"上次那个线段树我调了半天"）。这类默认收进来，
 * 因为它在私聊语境里本来就是"我们之间发生的事"，不会伤人格；宁可多一条边角料，
 * 也不要漏掉真正的关系细节。
 */
import { appendEvents, readEvents, dedupeKey, pairKey, otherIdFromSession } from './store.js';

const PAST_MARK = /(上次|那天|之前|前几天|上周|昨天|前阵子|那次|那时候|今年|去年|前些天)/;
// 「你」单独也算共同标记：她常说的是「你上次说要教我化妆」—— 主语是对方，事是两个人的。
const SHARED_MARK = /(我们|咱们|一起|你和我|两个人|你|妳)/;
const FUTURE_MARK = /(下次|以后|待会|等会|明天|后天|要不要|去不去|不如|计划|准备去|打算)/;

const MIN_CHARS = 8;
const MAX_CHARS = 70;

/** 按句末标点/换行切句，顺手去掉列表符号。 */
function splitSentences(text) {
    return String(text || '')
        .split(/(?<=[。！？!?\n])/)
        .map((s) => s.replace(/^[\s\-·•*>]+/, '').trim())
        .filter(Boolean);
}

/**
 * 抽出一段文本里的「共同经历」句。
 * @returns {string[]} 已去重、去尾部句号的句子
 */
export function extractSentences(text) {
    const raw = String(text || '');
    if (!raw) return [];
    const seen = new Set();
    const out = [];
    for (const s of splitSentences(raw)) {
        if (s.length < MIN_CHARS || s.length > MAX_CHARS) continue;
        if (/[？?]/.test(s)) continue;          // 疑问句不是陈述
        if (!PAST_MARK.test(s)) continue;       // 没有过去时
        if (!SHARED_MARK.test(s)) continue;     // 不是两个人的事
        if (FUTURE_MARK.test(s)) continue;      // 未来邀请不是已发生
        const key = dedupeKey(s);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(s.replace(/[。！!]+$/, '').trim());
    }
    return out;
}

/**
 * 从一条回复里抓事件并落盘。
 * @returns {number} 实际新增条数
 */
export function captureReply({ text = '', by = '', sessionId = '', selfId = '', cfg = {} } = {}) {
    const sentences = extractSentences(text);
    if (!sentences.length) return 0;
    const pair = pairKey(selfId, otherIdFromSession(sessionId));
    if (!pair) return 0;
    const existing = new Set(readEvents(cfg).map((e) => dedupeKey(e.text)));
    const now = Date.now();
    const items = [];
    for (const s of sentences) {
        const key = dedupeKey(s);
        if (existing.has(key)) continue;
        existing.add(key);
        items.push({
            id: `e${now.toString(36)}${items.length}`,
            at: now,
            by: String(by || ''),
            pair,
            text: s,
            sess: String(sessionId || '')
        });
    }
    return appendEvents(cfg, items);
}

/** 某个 pair 的事件，按时间升序。 */
export function eventsForPair(cfg = {}, pair = '') {
    if (!pair) return [];
    return readEvents(cfg).filter((e) => String(e.pair || '') === pair);
}
