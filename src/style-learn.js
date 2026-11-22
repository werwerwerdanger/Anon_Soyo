/**
 * 学说话风格（style rules）
 *
 * 我们原来的 quirks 只是"提取高频短语"——「最近大家常挂嘴边的是「绷不住了」」。
 * 这有两个毛病：
 *   ① 不知道**什么场合**用，所以经常用错地方；
 *   ② 高频词往往是刷屏的口头禅，学过来就是复读机。
 *
 * 做法参考：Mai-with-u/MaiBot 的 `prompts/zh-CN/main/learn_style.prompt`
 *   它让模型从群聊里提炼成规则：**当「某情境」时，可以「某表达」**
 *   - 只考虑文字，不考虑表情包图片
 *   - **不总结自己的发言**（防自我强化）
 *   - 不涉及人名/具体名词（防过拟合到某个梗）
 *   - 3~5 条，不超过 10 条
 *
 * 我们这边的实现差异：
 *   - 提炼是**离线低频**的（每会话若干个新样本才跑一次），不在回复链路上，不拖延迟；
 *   - 结果存盘，注入时只读文件，不额外花 token 去算；
 *   - 顺手做一层禁词过滤（脏话、政治、人身攻击），学歪了比不学更糟。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 提炼用的提示词（照抄麦麦的骨架，改成能直接照做的格式） */
export function buildStylePrompt(lines = []) {
    const body = (Array.isArray(lines) ? lines : [])
        .map((l) => String(l || '').trim())
        .filter(Boolean)
        .slice(-60)
        .join('\n');
    return [
        body,
        '',
        '请从上面这段群聊里提取**群友**的语言风格和说话方式。',
        '1. 只考虑文字，不要考虑表情包和图片。',
        '2. 标注为"我"的是机器人自己的发言，**不要学习它**。',
        '3. 不要涉及具体人名，也不要涉及只有这个小圈子才懂的专有名词。',
        '4. 如果里面有反复出现的梗，一并总结成"什么场合怎么说"。',
        '5. 必须严格根据上面的聊天内容总结，不要凭想象补。',
        '',
        '输出格式：每条写成「当 A 时，可以 B」的规律。',
        '- A 是场景，不超过 20 个字',
        '- B 是对应的说法或句式，不超过 20 个字',
        '- 一共 3~5 条，最多不超过 8 条',
        '',
        '只输出 JSON 数组，不要解释，不要 markdown 代码围栏：',
        '[',
        '  {"situation": "对某件事表示十分惊叹", "style": "我嘞个"},',
        '  {"situation": "表示讽刺的赞同", "style": "对对对"}',
        ']'
    ].join('\n');
}

/** 脏话/敏感词：学过来就是灾难，宁可少学几条 */
const BLOCK_RE = /(傻[逼比]|妈的|他妈的|cnm|nmsl|操你|艹|滚你|去死|死妈|弱智|脑残|约炮|开房|政治|共产党|政府|习|台独|港独)/i;

/**
 * 解析模型输出。容错到"只要里面有 JSON 数组就能救回来"。
 * @returns {{situation:string, style:string}[]}
 */
export function parseStyleRules(text = '') {
    const raw = String(text || '');
    let body = raw.trim();
    // 剥 ```json ... ``` 围栏
    const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) body = fence[1].trim();
    // 找第一个 [ 到最后一个 ]
    const start = body.indexOf('[');
    const end = body.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) return [];
    let arr;
    try {
        arr = JSON.parse(body.slice(start, end + 1));
    } catch {
        return [];
    }
    if (!Array.isArray(arr)) return [];
    const out = [];
    const seen = new Set();
    for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        const situation = String(item.situation ?? '').trim().slice(0, 24);
        const style = String(item.style ?? '').trim().slice(0, 24);
        if (!situation || !style) continue;
        if (BLOCK_RE.test(situation) || BLOCK_RE.test(style)) continue;
        const key = situation + '|' + style;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ situation, style });
        if (out.length >= 8) break;
    }
    return out;
}

function safeName(sessionKey = '') {
    return String(sessionKey || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
}

let styleDir = '';
/** 指定风格库根目录（实例的 data/）。由 index.js 启动时调用。 */
export function setStyleDir(dir) {
    styleDir = String(dir || '');
}

export function styleFileFor(dir, sessionKey = '') {
    return path.join(String(dir || styleDir || 'data'), 'style', `${safeName(sessionKey)}.json`);
}

// 每轮都读文件太重，缓存 60 秒；写完立刻失效（见 saveStyle）
const cache = new Map();   // file -> { at, value }

/** 带缓存的读取（提示词注入走这个） */
export function loadStyleCached(file, ttlMs = 60000) {
    const now = Date.now();
    const hit = cache.get(file);
    if (hit && now - hit.at < ttlMs) return hit.value;
    const value = loadStyle(file);
    cache.set(file, { at: now, value });
    return value;
}

/** 会话键 -> 注入段（拿不到规则就返回空串） */
export function styleSectionFor(sessionKey = '', limit = 3) {
    if (!styleDir) return '';
    try {
        const file = styleFileFor(styleDir, sessionKey);
        const { rules } = loadStyleCached(file);
        return buildStyleSection(rules, limit);
    } catch {
        return '';
    }
}

/** @returns {{updatedAt:number, sampleCount:number, rules:{situation:string,style:string}[]}} */
export function loadStyle(file) {
    try {
        if (!file || !fs.existsSync(file)) return { updatedAt: 0, sampleCount: 0, rules: [] };
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const rules = Array.isArray(raw?.rules) ? raw.rules.filter((r) => r && r.situation && r.style).slice(0, 8) : [];
        return { updatedAt: Number(raw?.updatedAt) || 0, sampleCount: Number(raw?.sampleCount) || 0, rules };
    } catch {
        return { updatedAt: 0, sampleCount: 0, rules: [] };
    }
}

export function saveStyle(file, rules = [], sampleCount = 0) {
    try {
        const dir = path.dirname(file);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            file,
            JSON.stringify({ updatedAt: Date.now(), sampleCount, rules: rules.slice(0, 8) }, null, 2),
            'utf8'
        );
        cache.delete(file);   // 立刻失效，下一轮就能用上新的
        return true;
    } catch {
        return false;
    }
}

/**
 * 注入段。故意写得**很轻**：
 *   不要求她"必须用"，只给参考 —— 一旦要求使用，她就会硬套，反而更假。
 */
export function buildStyleSection(rules = [], limit = 3) {
    const list = (Array.isArray(rules) ? rules : []).slice(0, limit);
    if (!list.length) return '';
    return [
        '【群里的说话习惯】（参考，不必照用）',
        ...list.map((r) => `- ${r.situation}的时候，可以说「${r.style}」`),
        '碰上正好对得上的场合再带一句，别硬套，也别每句都用。'
    ].join('\n');
}

/**
 * 该重新提炼了吗？
 * 规则：距上次 >= minIntervalMs，且新样本 >= minNewSamples。
 */
export function shouldRefreshStyle(meta = {}, newSamples = 0, options = {}) {
    const minIntervalMs = Number(options.minIntervalMs ?? 12 * 3600 * 1000);   // 默认 12 小时
    const minNewSamples = Number(options.minNewSamples ?? 40);
    const now = Date.now();
    if (newSamples < minNewSamples) return false;
    if (!meta?.updatedAt) return true;
    return now - meta.updatedAt >= minIntervalMs;
}
