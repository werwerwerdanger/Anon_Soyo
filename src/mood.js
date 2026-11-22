/**
 * 情绪状态机（v / a 二维）
 *
 * 为什么需要这个（2026-11-17）：
 *   她以前每一轮都是同一个温度 —— 被骂完下一句还是元气，被夸也一样。
 *   这是最像机器的地方：真人的情绪有惯性，会衰减，会影响说话的长短和语气。
 *
 * 设计参考：kaikan111/pangting-bot 的 mood-core.mjs（Russell 环形模型）
 *   v = 愉悦 (-1 ~ 1)，a = 唤醒 (0 ~ 1)，基线 v=0.1 / a=0.4（不冷不热）
 *   v 半衰期 45 分钟（心情慢），a 半衰期 22 分钟（兴奋退得快）
 *
 * 两条硬规则（照抄它的经验，都是踩过坑换来的）：
 *   ① **只写"怎么说"，不写"我什么情绪"**。一旦告诉她"你现在心情不好"，
 *      她就会在回复里说出来（"我心情不太好"），那比没有情绪更假。
 *   ② **本地规则宁可漏判也别乱判**。判断错了会凭空给她情绪，
 *      比"没情绪"更像 bug。
 *
 * 隔离方式：**按会话各存一份**（群 A 被骂，群 B 不受影响）。
 *   pangting 是全局单份，但我们是多群多实例，跨群污染会被用户当成 bug。
 */

import fs from 'node:fs';
import path from 'node:path';

export const MOOD = {
    baseV: 0.1,
    baseA: 0.4,
    halfV: 45,          // 分钟
    halfA: 22,
    turnHalfV: 10,      // 轮
    turnHalfA: 6,
    clamp: 0.25,        // 单个事件最大增量
    localClamp: 0.12,   // 本地规则一轮合计上限
    vTh: 0.2,           // 偏离多少才注入状态句
    aTh: 0.25,
    maxEvents: 20,
    maxSessions: 80
};

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const num = (x, d) => (Number.isFinite(Number(x)) ? Number(x) : d);

/** sessionKey -> { v, a, updatedAt, events: [] } */
const states = new Map();
let storePath = '';
let dirty = false;
let flushTimer = null;

/** 指定状态文件（实例根目录下的 data/mood.json）。不调用则纯内存。 */
export function setMoodStore(file) {
    storePath = String(file || '');
    if (storePath) loadFromDisk();
}

function loadFromDisk() {
    try {
        if (!storePath || !fs.existsSync(storePath)) return;
        const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
        const now = Date.now();
        for (const [key, m] of Object.entries(raw || {})) {
            if (!m || typeof m !== 'object') continue;
            states.set(key, {
                v: clamp(num(m.v, MOOD.baseV), -1, 1),
                a: clamp(num(m.a, MOOD.baseA), 0, 1),
                updatedAt: num(m.updatedAt, now),
                events: Array.isArray(m.events) ? m.events.slice(-MOOD.maxEvents) : []
            });
        }
    } catch {
        // 读不出来就从基线开始，绝不因为一个坏文件让她带着 NaN 说话
    }
}

function flushSoon() {
    if (!storePath) return undefined;
    dirty = true;
    if (flushTimer) return flushTimer;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        if (!dirty) return;
        dirty = false;
        try {
            const dir = path.dirname(storePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const out = {};
            for (const [k, m] of states) out[k] = m;
            fs.writeFileSync(storePath, JSON.stringify(out, null, 2), 'utf8');
        } catch {
            // 写盘失败不影响运行，内存里继续用
        }
    }, 3000);
    if (flushTimer.unref) flushTimer.unref();
    return flushTimer;
}

/** 按时间自然消退（懒计算：谁来读谁先算，不起定时器） */
function decayByTime(m, now = Date.now()) {
    const dtMin = Math.max(0, (now - (m.updatedAt || now)) / 60000);
    if (dtMin < 0.5) return m;
    m.v = MOOD.baseV + (m.v - MOOD.baseV) * Math.pow(0.5, dtMin / MOOD.halfV);
    m.a = MOOD.baseA + (m.a - MOOD.baseA) * Math.pow(0.5, dtMin / MOOD.halfA);
    m.updatedAt = now;
    return m;
}

/** 取某个会话的当前情绪（已做时间衰减） */
export function moodGet(sessionKey = '') {
    const key = String(sessionKey || '');
    if (!key) return { v: MOOD.baseV, a: MOOD.baseA, updatedAt: Date.now(), events: [] };
    let m = states.get(key);
    if (!m) {
        m = { v: MOOD.baseV, a: MOOD.baseA, updatedAt: Date.now(), events: [] };
        if (states.size >= MOOD.maxSessions) {
            // 超量时丢掉最久没动的那个，防内存涨
            let oldestKey = '';
            let oldest = Infinity;
            for (const [k, s] of states) if ((s.updatedAt || 0) < oldest) { oldest = s.updatedAt || 0; oldestKey = k; }
            if (oldestKey) states.delete(oldestKey);
        }
        states.set(key, m);
    }
    return decayByTime(m);
}

/**
 * 记一笔事件。dv/da 单次钳到 ±clamp。
 * 私聊/主人那边坏情绪折半 —— 群里的气不该拿主人出。
 */
export function moodApply(sessionKey = '', dv = 0, da = 0, meta = {}) {
    const key = String(sessionKey || '');
    if (!key) return null;
    const m = moodGet(key);
    let dvv = clamp(num(dv, 0), -MOOD.clamp, MOOD.clamp);
    let daa = clamp(num(da, 0), -MOOD.clamp, MOOD.clamp);
    if (meta.isPrivate) {
        dvv = dvv < 0 ? dvv * 0.5 : Math.min(MOOD.clamp, dvv * 1.5);
    }
    const before = { v: m.v, a: m.a };
    m.v = clamp(m.v + dvv, -1, 1);
    m.a = clamp(m.a + daa, 0, 1);
    const ev = {
        at: Date.now(),
        dv: Number((m.v - before.v).toFixed(3)),
        da: Number((m.a - before.a).toFixed(3)),
        why: String(meta.why || '').slice(0, 40)
    };
    if (ev.dv || ev.da) {
        m.events.push(ev);
        while (m.events.length > MOOD.maxEvents) m.events.shift();
        flushSoon();
    }
    m.updatedAt = Date.now();
    return ev;
}

/** 每聊一轮也走一点（聊得密的时候，钟表可能几十分钟才过 10 轮） */
export function moodTickTurn(sessionKey = '', n = 1) {
    const key = String(sessionKey || '');
    if (!key || !states.has(key)) return;
    const m = states.get(key);
    m.v = MOOD.baseV + (m.v - MOOD.baseV) * Math.pow(0.5, n / MOOD.turnHalfV);
    m.a = MOOD.baseA + (m.a - MOOD.baseA) * Math.pow(0.5, n / MOOD.turnHalfA);
    flushSoon();
}

/** 本地即时规则：只挑"这句话本身就有温度"的说法，量小、方向准。 */
const LOCAL_RULES = [
    { re: /(滚|闭嘴|傻[逼比]|蠢|废物|垃圾|有病|脑残|神经病|去死|恶心|弱智|滚蛋|什么玩意|你懂个?啥|少来这套|别烦|烦死你)/, dv: -0.12, da: 0.06, why: '被骂' },
    { re: /(随便你|无所谓|懒得跟你说|别说了|烦不烦|你懂什么|行了吧|你算老几|不关你事)/, dv: -0.06, da: 0.02, why: '被敷衍' },
    { re: /(对不起|抱歉|我错了|别生气|哄你|是我不对|我赔|原谅)/, dv: 0.12, da: -0.03, why: '被哄' },
    { re: /(厉害|可爱|好听|喜欢你|想你|聪明|靠谱|爱你|辛苦了|谢谢|真棒|牛啊|好强|太强了)/, dv: 0.08, da: 0.03, why: '被夸' },
    { re: /(哈哈|笑死|笑不活|乐死|梗|乐子|绷不住)/, dv: 0.05, da: 0.05, why: '有人在笑' },
    { re: /(卧槽|牛逼|绝了|!{2,}|！{2,})/, dv: 0.02, da: 0.08, why: '热闹' },
    { re: /(难受|不开心|好累|emo|撑不住|委屈|崩溃|想哭|焦虑)/, dv: -0.03, da: -0.07, why: '对方情绪低' }
];

/**
 * 从一句话里读出情绪增量。返回 null 表示"这句话没温度，别动"。
 * @param {string} text 纯文本（信封已剥）
 */
export function moodClassifyText(text = '') {
    const t = String(text || '').slice(0, 300);
    if (!t.trim()) return null;
    let dv = 0;
    let da = 0;
    const whys = [];
    for (const r of LOCAL_RULES) {
        if (r.re.test(t)) {
            dv += r.dv;
            da += r.da;
            whys.push(r.why);
        }
    }
    if (!whys.length) return null;
    return {
        dv: clamp(dv, -MOOD.localClamp, MOOD.localClamp),
        da: clamp(da, -MOOD.localClamp, MOOD.localClamp),
        why: whys.join('+')
    };
}

function levels(m) {
    const dev = (x, base, th) => {
        const d = x - base;
        if (Math.abs(d) < th) return 0;
        return Math.abs(d) >= 0.65 ? 3 : Math.abs(d) >= 0.4 ? 2 : 1;
    };
    return { bv: dev(m.v, MOOD.baseV, MOOD.vTh), ba: dev(m.a, MOOD.baseA, MOOD.aTh) };
}

/**
 * 把 (v,a) 翻成一句**行为指令**。
 *
 * 关键：只写"怎么说"，绝不写"你什么情绪"。否则她会在回复里复述
 * 「我现在心情不太好」，那就露馅了。
 */
export function moodPromptFrom(m) {
    if (!m || !Number.isFinite(m.v)) return '';
    const { bv, ba } = levels(m);
    const dv = m.v - MOOD.baseV;
    const da = m.a - MOOD.baseA;
    const lines = [];

    if (bv) {
        if (dv < 0) {
            lines.push(bv === 3
                ? '这会儿你心气很低：只回必要的几个字，语气淡，不接梗，不带 emoji，不发表情包，也别主动起话头。对方哄你、把话说清楚，你会松一点，但不会立刻好。'
                : bv === 2
                    ? '这会儿你有点不爽：回话比平时短，不接梗、不带 emoji、不发表情包；会刺两句、会说"行吧"，但别长篇。'
                    : '这会儿你兴致不高：话少一点，别主动起话头，也别硬搞笑。');
        } else {
            lines.push(bv === 3
                ? '这会儿你心情很好：话比平时多一点，爱接梗、爱逗对方，但不许宣布自己心情好。'
                : bv === 2
                    ? '这会儿你心情不错：语气轻快，可以多接一句、开个小玩笑。'
                    : '这会儿你心情略好：语气放松一点就行。');
        }
    }
    if (ba) {
        if (da > 0) {
            lines.push(ba === 3
                ? '你正兴奋着：句子短而快，可以多用感叹号，但别每句都喊。'
                : '你有点亢奋：节奏快一点，别拖长句。');
        } else {
            lines.push(ba === 3
                ? '你现在很没劲：一句话能说完就一句，别主动接话。'
                : '你有点蔫：回得干脆点，别起话头。');
        }
    }
    if (!lines.length) return '';
    return [
        '【此刻的状态】',
        ...lines.map((l) => '- ' + l),
        // ⚠ 这里绝不能写"不许说我心情不好"—— 那等于把那句话喂给模型，
        // 我们踩过这个坑（否定式 = 二次 priming，越禁越说）。只给正面描述。
        '这些只影响你说话的方式，不要用文字交代自己的状态，也不要解释这条提示。'
    ].join('\n');
}

/** 给提示词用的一步到位版本 */
export function moodPromptFor(sessionKey = '') {
    return moodPromptFrom(moodGet(sessionKey));
}

/** 调试/面板用 */
export function moodSnapshot(sessionKey = '') {
    const m = moodGet(sessionKey);
    return {
        v: Number(m.v.toFixed(3)),
        a: Number(m.a.toFixed(3)),
        level: levels(m),
        recent: m.events.slice(-5)
    };
}

/** 测试用：清空 */
export function resetMood() {
    states.clear();
    dirty = false;
}
