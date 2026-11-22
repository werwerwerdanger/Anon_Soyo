/**
 * 反射层：把零散的小插曲提炼成一句「关系认知」
 *
 * 出处：Generative Agents（Park et al., UIST 2023）的 reflection。
 * 原始设计是"最近事件的重要性累计超过阈值 → 问三个高层问题 → 检索 → 写回记忆流"。
 * 这里裁到最小可用：每攒够 N 条新事件，让模型重写一遍 pairs[pair].note。
 *
 * 为什么要它：没有这一层，events 只是一串流水账，关系不会自己长。
 * 用户要的是「从队友慢慢升温」，写死的 note 只能定起点，走向得靠这层推。
 *
 * 成本控制：默认每 6 条事件反思一次、每天最多 2 次。一次请求 ~600 token。
 */
import { readDoc, updateDoc, todayKey, llmText, cleanOneLine } from './store.js';
import { eventsForPair } from './capture.js';

const DEFAULTS = { every: 6, maxPerDay: 2, maxChars: 140, model: '' };

/**
 * 够条件就反思一次。
 * @returns {Promise<{reflected: boolean, reason?: string, note?: string}>}
 */
export async function maybeReflect({ aiClient = null, cfg = {}, pair = '', logger = console, now = Date.now() } = {}) {
    const conf = { ...DEFAULTS, ...(cfg.reflect || {}) };
    if (cfg.enabled === false || conf.enabled === false) return { reflected: false, reason: 'disabled' };
    if (!aiClient || !pair) return { reflected: false, reason: 'no-deps' };

    const doc = readDoc(cfg);
    const entry = doc.pairs?.[pair] || {};
    const events = eventsForPair(cfg, pair);
    const seen = Number(entry.reflectedCount) || 0;
    const fresh = events.length - seen;
    if (fresh < Math.max(2, Number(conf.every) || DEFAULTS.every)) {
        return { reflected: false, reason: 'not-enough', fresh };
    }

    const day = todayKey(now);
    const countToday = entry.reflectDay === day ? (Number(entry.reflectToday) || 0) : 0;
    if (countToday >= (Number(conf.maxPerDay) || DEFAULTS.maxPerDay)) {
        return { reflected: false, reason: 'daily-cap' };
    }

    const recent = events.slice(-12);
    const current = String(entry.note || '').trim();
    const messages = [
        {
            role: 'system',
            content: '你是一个只做归纳的读者。你看的是一支女子乐队里两个人之间最近发生的小事，'
                + '要据此更新对她们关系的描述。输出只有一段话，不要标题、不要列表、不要解释你怎么想的。'
        },
        {
            role: 'user',
            content: `【现在的描述】\n${current || '（还没有）'}\n\n`
                + `【最近的小事】\n${recent.map((e, i) => `${i + 1}. ${e.text}`).join('\n')}\n\n`
                + '写一段她们关系现在的样子：两个人谁更主动、隔阂在哪、最近是在靠近还是拉开。'
                + `一个自然段，${conf.maxChars} 字以内，用陈述句。`
        }
    ];

    let text = '';
    try {
        const result = await aiClient.chat(messages, {
            maxTokens: 220,
            temperature: 0.7,
            thinking: { type: 'disabled' }
        });
        text = cleanOneLine(llmText(result));
    } catch (e) {
        logger?.warn?.('[canon/反射] 生成失败', { error: e?.message || String(e) });
        return { reflected: false, reason: 'llm-error' };
    }
    if (!text || text.length < 10) return { reflected: false, reason: 'empty' };

    const ok = updateDoc(cfg, (draft) => {
        draft.pairs = draft.pairs || {};
        const prev = draft.pairs[pair] || {};
        draft.pairs[pair] = {
            ...prev,
            note: text,
            reflectedCount: events.length,
            reflectDay: day,
            reflectToday: countToday + 1,
            reflectedAt: now
        };
    });
    if (!ok) return { reflected: false, reason: 'lock-busy' };

    logger?.info?.('[canon/反射] 关系描述已更新', { pair, events: events.length, chars: text.length });
    return { reflected: true, note: text };
}
