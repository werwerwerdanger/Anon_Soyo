/**
 * canon 门面 —— 两个实例共用的「世界 / 关系 / 小插曲」
 *
 * 一句话：让爱音和素世活在同一个世界里，而不是各自现编一套历史。
 *
 * 四层结构（从下往上）：
 *   store    存：canon.json（舞台/关系/世界）+ events.jsonl（小插曲，只追加）
 *   capture  写：从她的回复里抓「上次我们一起…」这类陈述句
 *   inject   读：拼成交给模型的一段文字，按会话类型和 pair 过滤
 *   reflect  炼：攒够 N 条事件，让模型重写一遍关系认知
 *   world    推：每天扔一件外部小事进来，给她们一个能聊的共同背景
 *
 * 对外只有三个入口：normalizeConfig / buildBlock / onReply，外加一个 tick。
 *
 * 来历（网上参考）：
 *   - Worldbook Sync（SillyTavern 扩展）：共享 canon 与单会话 story 分层，canon 生成时不读当前剧情
 *   - Generative Agents（arXiv 2304.03442）：记忆流 + 反思；论文列出的失败模式里就有
 *     "fabricated embellishments to the agent's memory"，正是用户抱怨的"编造化妆吃蛋糕"
 *   - Letta（原 MemGPT）：共享记忆块，多 agent 同时写以最后一次为准 ⇒ 所以这里 events 走 append-only
 *   - NBN（nbn-agentic-ai-memory-rag）：orchestrator 当世界模型，主动往对话里投事件
 */
import {
    readDoc, updateDoc, appendEvents, readEvents, dedupeKey,
    pairKey, otherIdFromSession, paths
} from './store.js';
import { buildBlock, worldLineToday } from './inject.js';
import { captureReply, extractSentences, eventsForPair } from './capture.js';
import { maybeReflect } from './reflect.js';
import { maybeRefreshWorld } from './world.js';

export const CANON_DEFAULTS = {
    enabled: true,
    capture: true,
    reflect: { enabled: true, every: 6, maxPerDay: 2, maxChars: 140 },
    world: { enabled: true, windowStart: 0, windowEnd: 24, maxChars: 60, historyKeep: 5 }
};

/** 统一旧键 `chat.sharedCanon` 与新键 `chat.canon`。 */
export function normalizeConfig(chat = {}) {
    const raw = (chat && (chat.canon || chat.sharedCanon)) || {};
    const dir = String(raw.dir || raw.path || '').trim();
    return {
        enabled: raw.enabled !== false,
        dir: dir || undefined,
        capture: raw.capture !== false,
        reflect: { ...CANON_DEFAULTS.reflect, ...(raw.reflect || {}) },
        world: { ...CANON_DEFAULTS.world, ...(raw.world || {}) }
    };
}

/**
 * 一条回复发出去之后的统一入口：抓事件，够了就顺手反思。
 * 不阻塞发送链路（反思是 fire-and-forget）。
 */
export function onReply({ chat = {}, event = null, replyText = '', selfId = '', characterName = '', aiClient = null, logger = console } = {}) {
    const cfg = normalizeConfig(chat);
    if (!cfg.enabled || !cfg.capture) return 0;
    if (event?.message_type !== 'private' || !event?.user_id) return 0;
    const pair = pairKey(selfId, String(event.user_id));
    if (!pair) return 0;

    const added = captureReply({
        text: replyText,
        by: characterName,
        sessionId: `private:${event.user_id}`,
        selfId,
        cfg
    });
    if (added > 0 && cfg.reflect.enabled !== false) {
        const run = maybeReflect({ aiClient, cfg, pair, logger });
        if (run && typeof run.catch === 'function') run.catch(() => {});
    }
    return added;
}

/** 定时任务：刷新今天的 world（幂等，两个实例都跑也不会重复）。 */
export async function tick({ chat = {}, aiClient = null, logger = console } = {}) {
    const cfg = normalizeConfig(chat);
    if (!cfg.enabled) return { created: false, reason: 'disabled' };
    return maybeRefreshWorld({ aiClient, cfg, logger });
}

export {
    buildBlock,
    worldLineToday,
    captureReply,
    extractSentences,
    eventsForPair,
    maybeReflect,
    maybeRefreshWorld,
    readDoc,
    updateDoc,
    appendEvents,
    readEvents,
    dedupeKey,
    pairKey,
    otherIdFromSession,
    paths
};
