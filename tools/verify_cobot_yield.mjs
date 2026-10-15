// verify_cobot_yield.mjs —— 从**真实的** src/index.js 里切出补丁函数，喂假时间跑断言。
//
// 为什么要这样验：这套逻辑全是时间相关的（窗口 / 冷却），
// 光看代码看不出来。而且必须用**真实源码**，重写一份等价实现等于没验。
//
// 用法: node verify_cobot_yield.mjs [实例目录]
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2] || 'C:\\Users\\20633\\MimirLink';
const SRC = path.join(ROOT, 'src', 'index.js');
const text = fs.readFileSync(SRC, 'utf8');

// ---- 1. 切出 isCoBot（顶层函数，用括号配对找结尾）----
function cutFunction(src, decl) {
    const i = src.indexOf(decl);
    if (i < 0) throw new Error('找不到: ' + decl);
    let depth = 0, j = src.indexOf('{', i);
    for (let k = j; k < src.length; k++) {
        if (src[k] === '{') depth++;
        else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); }
    }
    throw new Error('括号不配对: ' + decl);
}

const isCoBotSrc = cutFunction(text, 'function isCoBot(config, event) {');

// ---- 2. 切出 cobot-yield 整块 ----
const BEGIN = 'const coBotYieldState = new Map();';
const END = '// <<< cobot-yield patch <<<';
const b = text.indexOf(BEGIN);
const e = text.indexOf(END);
if (b < 0 || e < 0) { console.error('❌ 找不到 cobot-yield 补丁块，补丁没打上？'); process.exit(1); }
const blockSrc = text.slice(b, e);

// ---- 3. 把 Date.now() 换成可注入的 __now() ----
const code = (isCoBotSrc + '\n' + blockSrc).replace(/Date\.now\(\)/g, '__now()');

let nowMs = 1700000000000;
const factory = new Function('__now', `
${code}
return { coBotYieldState, coBotYieldNoteCoBot, coBotYieldDecision, coBotYieldMarkSpoken, isCoBot };
`);
const M = factory(() => nowMs);

// ---- 4. 假环境 ----
const CFG = { chat: { coBotIds: ['3628056487'], coBotActiveMs: 300000, coBotMyMaxLines: 2, coBotCooldownMs: 300000 } };
const GID = '1045582694';
const peerEvent = () => ({ message_type: 'group', group_id: GID, user_id: '3628056487' }); // 对方 bot
const humanEvent = () => ({ message_type: 'group', group_id: GID, user_id: '2063362809' }); // 群友
const T = (sec) => { nowMs += sec * 1000; };
const MIN = 60;

let pass = 0, fail = 0;
const check = (label, got, want) => {
    const ok = got === want;
    ok ? pass++ : fail++;
    console.log(`  ${ok ? '✅' : '❌'} ${label}  got=${got} want=${want}`);
};

console.log(`\n源: ${SRC}`);
console.log(`单例: maxLines=${CFG.chat.coBotMyMaxLines} activeMs=${CFG.chat.coBotActiveMs} cooldownMs=${CFG.chat.coBotCooldownMs}\n`);

console.log('【场景 1】对方 bot 不在场 → 完全不受限');
M.coBotYieldState.clear();
check('对方没说过话时 allow', M.coBotYieldDecision(CFG, humanEvent()), 'allow');
M.coBotYieldMarkSpoken(CFG, humanEvent());
M.coBotYieldMarkSpoken(CFG, humanEvent());
M.coBotYieldMarkSpoken(CFG, humanEvent());
check('说了 3 句仍 allow', M.coBotYieldDecision(CFG, humanEvent()), 'allow');

console.log('\n【场景 2】对方 bot 刚在本群发过言 → 我最多说 2 句');
M.coBotYieldState.clear();
M.coBotYieldNoteCoBot(CFG, peerEvent());          // 对方发言
T(1);
check('第 1 句 allow', M.coBotYieldDecision(CFG, humanEvent()), 'allow');
M.coBotYieldMarkSpoken(CFG, humanEvent());
T(1);
check('第 2 句 allow', M.coBotYieldDecision(CFG, humanEvent()), 'allow');
M.coBotYieldMarkSpoken(CFG, humanEvent());
T(1);
check('第 3 句 limit（说两句就停）', M.coBotYieldDecision(CFG, humanEvent()), 'limit');

console.log('\n【场景 3】冷却期内一直 limit');
T(1 * MIN);
check('+1min 仍 limit', M.coBotYieldDecision(CFG, humanEvent()), 'limit');
T(3 * MIN);
check('+4min 仍 limit', M.coBotYieldDecision(CFG, humanEvent()), 'limit');

console.log('\n【场景 4】冷却结束 + 对方仍在场 → 配额重置，又能说 2 句');
M.coBotYieldState.clear();
M.coBotYieldNoteCoBot(CFG, peerEvent());
T(1);
M.coBotYieldMarkSpoken(CFG, humanEvent());
T(1);
M.coBotYieldMarkSpoken(CFG, humanEvent());
T(1);
check('配额用尽 → limit', M.coBotYieldDecision(CFG, humanEvent()), 'limit');
// 冷却期间对方又说话了 —— 刷新 lastCoBotAt，让「在场」状态延续到冷却之后
T(30);
M.coBotYieldNoteCoBot(CFG, peerEvent());
T(5 * MIN);                                        // 冷却结束
check('冷却结束后 allow（配额已重置）', M.coBotYieldDecision(CFG, humanEvent()), 'allow');

console.log('\n【场景 5】对方沉寂超过 activeMs → 局面解除');
M.coBotYieldState.clear();
M.coBotYieldNoteCoBot(CFG, peerEvent());
T(1);
M.coBotYieldMarkSpoken(CFG, humanEvent());
M.coBotYieldMarkSpoken(CFG, humanEvent());
T(6 * MIN);                                        // 对方 6 分钟没说话
check('对方过期后 allow', M.coBotYieldDecision(CFG, humanEvent()), 'allow');

console.log('\n【场景 6】对方 bot 自己的发言不占我的配额');
M.coBotYieldState.clear();
M.coBotYieldNoteCoBot(CFG, peerEvent());
M.coBotYieldMarkSpoken(CFG, peerEvent());          // 对方发言被 markSpoken 走到
check('对方发言不计入 myLines', M.coBotYieldState.get(GID).myLines.length, 0);

console.log('\n【场景 7】私聊 / 缺 group_id 不参与');
M.coBotYieldState.clear();
check('私聊 allow', M.coBotYieldDecision(CFG, { message_type: 'private', user_id: '1' }), 'allow');
check('群聊但无 group_id allow', M.coBotYieldDecision(CFG, { message_type: 'group', user_id: '1' }), 'allow');

console.log('\n【场景 8】开关关闭 → 一律 allow');
M.coBotYieldState.clear();
const off = { chat: { ...CFG.chat, coBotYieldEnabled: false } };
M.coBotYieldNoteCoBot(off, peerEvent());
check('关闭后 allow', M.coBotYieldDecision(off, humanEvent()), 'allow');

console.log(`\n${'='.repeat(50)}\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
