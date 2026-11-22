/**
 * 世界层（orchestrator）：每天扔一件外部小事进 canon
 *
 * 出处：NBN（brendanhogan/nbn-agentic-ai-memory-rag）的 orchestrator ——
 * 它当"世界模型"，主动往两个 agent 的对话里投事件（好消息/坏消息/吵架），
 * 这样它们不会每次都从"我今天照镜子发现刘海翘了"开始。
 *
 * 这里只做最轻的一档：**外部环境**。天气、街上的店、车站、学校、RiNG 的设备。
 * 不写人物心理、不写对话 —— 那些留给她们自己接。
 *
 * 幂等：两个实例都会调这个函数，靠 canon.json 里的 `world.date` 判断当天是否已经生成过，
 * 写回时在锁内再确认一次。
 */
import { readDoc, updateDoc, todayKey, llmText, cleanOneLine } from './store.js';

const DEFAULTS = {
    // 0-24 = 全天。世界事件不是"打扰"，它只是背景（凌晨下雨也是天气），
    // 真正决定要不要开口的是 proactiveChat 的作息窗口。
    windowStart: 0,
    windowEnd: 24,
    maxChars: 60,
    historyKeep: 5
};

const SAMPLE_KINDS = [
    '天气（下雨、闷热、突然降温）',
    '车站或电车（延误、末班车、站台广播）',
    '街上的店（新开的、关门的、排队的）',
    '学校（考试周、社团招新、教室整修）',
    'livehouse（RiNG 的设备、排期、门口的伞架）'
];

function inWindow(now, start, end) {
    const h = new Date(now).getHours();
    return start <= end ? (h >= start && h < end) : (h >= start || h < end);
}

/**
 * 够条件就生成今天的 world。
 * @returns {Promise<{created: boolean, reason?: string, text?: string}>}
 */
export async function maybeRefreshWorld({ aiClient = null, cfg = {}, logger = console, now = Date.now() } = {}) {
    const conf = { ...DEFAULTS, ...(cfg.world || {}) };
    if (cfg.enabled === false || conf.enabled === false) return { created: false, reason: 'disabled' };
    if (!aiClient) return { created: false, reason: 'no-ai' };

    const day = todayKey(now);
    const doc = readDoc(cfg);
    if (String(doc.world?.date || '') === day) return { created: false, reason: 'already-today' };

    if (!inWindow(now, Number(conf.windowStart) || DEFAULTS.windowStart, Number(conf.windowEnd) || DEFAULTS.windowEnd)) {
        return { created: false, reason: 'out-of-window' };
    }

    const history = Array.isArray(doc.world?.history) ? doc.world.history : [];
    const recent = history.slice(-3).map((h) => `- ${h}`).join('\n');
    const messages = [
        {
            role: 'system',
            content: '你负责给一个日常故事写背景。输出只有一句话，不要解释、不要标题。'
        },
        {
            role: 'user',
            content: '写一件今天在东京发生的外部小事，它会成为几个人今天聊天的背景。\n'
                + `可以从这些里挑一个角度：${SAMPLE_KINDS.join(' / ')}。\n`
                + `一句话，${conf.maxChars} 字以内，具体到能被人当成真的（时间、地点、细节）。\n`
                + (recent ? `换一件跟这些不同的：\n${recent}\n` : '')
                + '只写外面发生的事，人只是碰上了它。'
        }
    ];

    let text = '';
    try {
        const result = await aiClient.chat(messages, {
            maxTokens: 160,
            temperature: 0.95,
            thinking: { type: 'disabled' }
        });
        text = cleanOneLine(llmText(result));
    } catch (e) {
        logger?.warn?.('[canon/世界] 生成失败', { error: e?.message || String(e) });
        return { created: false, reason: 'llm-error' };
    }
    if (!text || text.length < 8) return { created: false, reason: 'empty' };

    let created = false;
    const ok = updateDoc(cfg, (draft) => {
        if (String(draft.world?.date || '') === day) return;   // 另一个实例抢先写了
        const prevHistory = Array.isArray(draft.world?.history) ? draft.world.history : [];
        draft.world = {
            id: `w${now.toString(36)}`,
            date: day,
            at: now,
            text,
            history: [...prevHistory, text].slice(-(Number(conf.historyKeep) || DEFAULTS.historyKeep))
        };
        created = true;
    });
    if (!ok) return { created: false, reason: 'lock-busy' };
    if (!created) return { created: false, reason: 'race-lost' };

    logger?.info?.('[canon/世界] 今天的事已生成', { date: day, text: text.slice(0, 40) });
    return { created: true, text };
}
