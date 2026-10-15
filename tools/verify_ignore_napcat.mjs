/**
 * verify_ignore_napcat.mjs -- 断言 NapCat 输出过滤器真的接进了真实路由
 *
 * 做法（沿用 verify_trigger_routing.mjs）：
 *   · `isNapcatNoise` 直接 **import 各实例部署的那个模块**（不是复刻一份）
 *   · `buildRoutingDecision` 从 src/index.js 里按大括号配对抽真身，用 new Function 求值
 *   · 测试用例用**日志里的真实 NapCat 输出原文**
 *
 *   node verify_ignore_napcat.mjs
 */
import fs from 'node:fs';

let pass = 0;
let fail = 0;
const ok = (cond, label, extra) => {
    if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
    else { fail += 1; console.log(`  FAIL  ${label}${extra ? '  <- ' + extra : ''}`); }
};

function extractFunction(src, name) {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`function ${name} not found`);
    let i = -1;
    let paren = 0;
    for (let k = src.indexOf('(', start); k < src.length; k++) {
        if (src[k] === '(') paren++;
        else if (src[k] === ')') paren--;
        else if (src[k] === '{' && paren === 0) { i = k; break; }
    }
    if (i < 0) throw new Error(`body brace not found for ${name}`);
    let depth = 0;
    for (let j = i; j < src.length; j++) {
        const c = src[j];
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return src.slice(start, j + 1);
        }
    }
    throw new Error(`unbalanced braces for ${name}`);
}

/** 取带后缀的补丁标记块；终点只在起点之后找（两个静默失效的坑见 verify_trigger_routing.mjs） */
function markedBlock(src, label) {
    const startRe = new RegExp(`// >>> ${label}[^\\n]*>>>`);
    const m = startRe.exec(src);
    if (!m) throw new Error(`marked block not found: ${label}`);
    const start = m.index;
    const rel = src.slice(start).indexOf(`// <<< ${label} <<<`);
    if (rel < 0) throw new Error(`marked block end not found: ${label}`);
    return src.slice(start, start + rel);
}

// 日志里抓下来的真实原文（群 929159193 一条 `#napcat` 炸出多个实例的输出）
const NAPCAT_REAL = [
    'NapCat 信息\n版本: 4.15.19\n平台: linux (64-bit)\n运行时间: 20天 16小时 16分钟',
    'NapCat 信息\n版本: 4.18.2\n平台: linux (64-bit)\n运行时间: 19天 16小时 56分钟',
    'NapCat 信息\n版本: 4.18.4\n平台: win32 (64-bit)\n运行时间: 17小时 11分钟',
];
const NAPCAT_BATCH = NAPCAT_REAL.join('\n');

for (const [inst, label] of [['MimirLink-soyo', 'soyo'], ['MimirLink', 'anon']]) {
    const ROOT = `C:/Users/20633/${inst}`;
    const src = fs.readFileSync(`${ROOT}/src/index.js`, 'utf8');
    const config = JSON.parse(fs.readFileSync(`${ROOT}/config.json`, 'utf8'));
    const modUrl = 'file:///' + `${ROOT}/src/napcat-output.js`.replace(/\\/g, '/');

    console.log(`\n########## ${inst} (${label}) ##########`);

    // ---- 0. 模块存在且可 import
    let mod = null;
    try {
        mod = await import(modUrl);
    } catch (e) {
        ok(false, '0a 模块可 import', e.message);
        continue;
    }
    const { isNapcatNoise } = mod;
    ok(typeof isNapcatNoise === 'function', '0a 模块导出 isNapcatNoise');

    // ---- 1. 单元：真实样例必须判真
    for (const [i, t] of NAPCAT_REAL.entries()) {
        ok(isNapcatNoise(t) === true, `1.${i} 真实 NapCat 输出判真`);
    }
    ok(isNapcatNoise(NAPCAT_BATCH) === true, '1.3 三条合并判真');
    ok(isNapcatNoise('#napcat') === true, '1.4 命令本身判真');
    ok(isNapcatNoise('#napat') === true, '1.5 拼错的命令也判真');

    // ---- 2. 单元：不许误伤正常聊天
    const NEG = [
        ['', '空串'],
        ['今天中午吃什么', '普通闲聊'],
        ['诶 干嘛突然@我啊', '群里的插话'],
        ['这集有教育意义', '普通发言'],
        ['版本: 1.0', '只有版本字段'],
        ['运行时间: 3小时', '只有运行时间字段'],
        ['#napcat 这命令怎么用', '命令 + 正文'],
        ['[图片:[动画表情]]', '纯表情'],
    ];
    for (const [t, d] of NEG) {
        ok(isNapcatNoise(t) === false, `2 不误伤：${d}`);
    }

    // ---- 3. 把真实的 buildRoutingDecision 抽出来跑
    // ⚠ 不抽 `napcat-output-ignore patch` 块本身 —— 它含 import 语句，
    //    new Function 里不能有 import（踩过一次）。闸门在 buildRoutingDecision 内部，
    //    抽那个函数就带上了；isNapcatNoise 用参数注入。
    const code = [
        markedBlock(src, 'group-repeat-and-names patch'),
        markedBlock(src, 'bot-banter-limit patch'),
        markedBlock(src, 'sticker-assertion patch'),
        extractFunction(src, 'matchesKeywords'),
        extractFunction(src, 'toComparableId'),
        extractFunction(src, 'isAllowed'),
        extractFunction(src, 'isTriggerUser'),
        // 🔴 2026-10-13 补：`accept()` 里调了 coBotYieldMarkSpoken / coBotYieldNoteCoBot，
        //    它们又依赖 coBotYieldState(Map) —— 以前这些都没进求值环境，
        //    一走到 accept() 就是 `ReferenceError: coBotYieldNoteCoBot is not defined`
        //    （verify_trigger_routing.mjs 踩过同一个坑，照同一套补）。
        'const coBotYieldState = new Map();',
        extractFunction(src, 'coBotYieldNoteCoBot'),
        extractFunction(src, 'coBotYieldDecision'),
        extractFunction(src, 'coBotYieldMarkSpoken'),
        extractFunction(src, 'buildRoutingDecision'),
        'return { buildRoutingDecision };',
    ].join('\n');
    let buildRoutingDecision;
    try {
        ({ buildRoutingDecision } = new Function('isNapcatNoise', code)(isNapcatNoise));
    } catch (e) {
        ok(false, '3a 装配真实 buildRoutingDecision', e.message);
        continue;
    }
    ok(typeof buildRoutingDecision === 'function', '3a 装配真实 buildRoutingDecision');

    // 静态：import 与闸门都在位，且闸门确实在 buildRoutingDecision 体内
    const body = extractFunction(src, 'buildRoutingDecision');
    ok(src.includes("import { isNapcatNoise } from './napcat-output.js';"), '3a2 index.js 有 import');
    ok(body.includes('napcat_output') && body.includes('ignoreNapcatOutput'),
        '3a3 闸门写在 buildRoutingDecision 体内');

    const KEYWORD = config.chat.triggerKeywords[0];
    // 线上触发它的正是 NapCat 输出；这里额外拼一个关键词，
    // 好证明「拦住它的确实是新闸门」而不是「本来就没人能触发它」。
    const WITH_KW = `${NAPCAT_BATCH}\n${KEYWORD} 你看这个`;
    const ev = { message_type: 'group', group_id: 1045582694, user_id: 2458713318 };

    const swallow = buildRoutingDecision(config, ev, NAPCAT_BATCH, false, {});
    ok(swallow.shouldRespond === false && swallow.skipReason === 'napcat_output',
        '3b 纯 NapCat 输出被拦', `should=${swallow.shouldRespond} skip=${swallow.skipReason}`);

    const swallowKw = buildRoutingDecision(config, ev, WITH_KW, false, {});
    ok(swallowKw.shouldRespond === false && swallowKw.skipReason === 'napcat_output',
        '3c 带关键词也照样被拦', `should=${swallowKw.shouldRespond} skip=${swallowKw.skipReason}`);

    // 私聊也要吃到（群聊/私聊两条路同一处闸门）
    const priv = buildRoutingDecision(config, { message_type: 'private', user_id: 2458713318 }, NAPCAT_BATCH, false, {});
    ok(priv.shouldRespond === false && priv.skipReason === 'napcat_output',
        '3d 私聊同样被拦', `skip=${priv.skipReason}`);

    // ---- 4. 关掉开关必须恢复原行为（闸门可逆）
    const off = JSON.parse(JSON.stringify(config));
    off.chat.ignoreNapcatOutput = false;
    const offRes = buildRoutingDecision(off, ev, WITH_KW, false, {});
    ok(offRes.shouldRespond === true, '4a ignoreNapcatOutput=false 时恢复触发（可逆）',
        `should=${offRes.shouldRespond} skip=${offRes.skipReason}`);

    // ---- 5. 正常聊天不受影响
    for (const [t, d, want] of [
        [`${KEYWORD} 你看这个`, '带关键词的普通发言', true],
        ['今天中午吃什么', '无关闲聊', false],
        ['版本更新了吗', '含「版本」二字但不含运行时间', false],
    ]) {
        const r = buildRoutingDecision(config, ev, t, false, {});
        ok(r.shouldRespond === want, `5 正常聊天不受影响：${d}`, `should=${r.shouldRespond} skip=${r.skipReason}`);
    }

    // ---- 6. 配置键已落盘
    ok(config.chat.ignoreNapcatOutput === true, '6a config.chat.ignoreNapcatOutput = true',
        String(config.chat.ignoreNapcatOutput));

    console.log(`\n  ${label}: PASS ${pass} / FAIL ${fail}`);
}

console.log(`\n===== 合计：PASS ${pass}，FAIL ${fail} =====`);
process.exit(fail === 0 ? 0 : 1);
