/**
 * 注入层：把 canon 拼成交给模型的一段文字
 *
 * 三条边界（都是踩过的）：
 *   ① `stage`（舞台）所有会话都注入 —— 它是"世界在哪"，谁都需要
 *   ② `pairs[].note`（关系认知）和 `events`（小插曲）**只在对应私聊注入**
 *      —— 群里"你们"指代不清，而且当众翻私聊旧账容易出戏
 *   ③ 事件按 pair 过滤 —— 跟用户的往事不能串到另一个 bot 那边
 */
import { readDoc, todayKey } from './store.js';
import { eventsForPair } from './capture.js';
import { pairKey, otherIdFromSession } from './store.js';

const MAX_EVENTS_IN_PROMPT = 24;

function md(ts) {
    const d = new Date(Number(ts) || Date.now());
    return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 世界事件只当天有效，隔天就不再提（否则会一直卡在同一个下雨天）。 */
function todayWorld(world, now = Date.now()) {
    if (!world || !world.text) return '';
    return String(world.date || '') === todayKey(now) ? String(world.text) : '';
}

/**
 * 生成注入文本。没有内容就返回空串（调用方据此决定要不要 push 这段）。
 */
export function buildBlock({ cfg = {}, isPrivate = false, sessionId = '', selfId = '', now = Date.now() } = {}) {
    const doc = readDoc(cfg);
    const parts = [];

    const stage = String(doc.stage || '').trim();
    if (stage) parts.push(`【你们共用的舞台】\n${stage}`);

    if (!isPrivate) return parts.join('\n\n');

    const world = todayWorld(doc.world, now);
    if (world) parts.push(`【今天】\n${world}`);

    const pair = pairKey(selfId, otherIdFromSession(sessionId));
    if (!pair) return parts.join('\n\n');

    const note = String(doc.pairs?.[pair]?.note || '').trim();
    if (note) parts.push(`【你们之间】\n${note}`);

    const events = eventsForPair(cfg, pair);
    if (events.length) {
        const lines = events
            .slice(-MAX_EVENTS_IN_PROMPT)
            .map((e, i) => `${i + 1}. ${md(e.at)} ${String(e.text).trim()}`);
        parts.push('【你们之间真实发生过的小事】\n'
            + lines.join('\n')
            + '\n（这些是你们共有的记忆，聊到相关的事会自然想起来。）');
    }
    return parts.join('\n\n');
}

/** 单独取今天的世界事件（主动开口时当话题用）。 */
export function worldLineToday(cfg = {}, now = Date.now()) {
    return todayWorld(readDoc(cfg).world, now);
}
