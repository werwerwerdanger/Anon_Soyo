/**
 * verify_reply_decision_at.mjs
 * ---------------------------------------------------------------------------
 * 验证群聊「回复决策层」能看见 **@ 的标记**。
 *
 * 起因（2026-10-11 20:41）：有人 @ 了爱音问一句话，决策层却判 NO、她没回。
 * 用户怀疑「你是不是把群聊不回复写死了」—— 实际统计是当天 回复 35 / 不回复 2，
 * 不是写死；真因是 **@ 标记在进决策层之前就被剥掉了**：
 *
 *   buildDecisionContext() 用 stripStructuredHeader() 压平历史，
 *   而它是把 `[...]` 整段删掉的正则 ⇒ `[@bot]` 被吃掉，
 *   结构化头里的 `isAtBot:true` 也被一起剥掉。
 *   决策层最后看到的是：
 *       【刚进来的这条】werwer: 你觉得曲奇饼干全肯定bot怎么样
 *   —— 完全不知道被 @ 了。而它的提示词里写着「默认是 NO」，
 *   所以判 NO 是"忠于输入"的合理结果。
 *
 * 这条最值钱的断言是 Part 1 的 **"标记必须活到决策层看见"** —— 只用
 * `detectAtBot()` 单测是防不住的（那是它自己的逻辑），必须断言
 * `buildDecisionContext()` **输出文本**里带着标记。
 *
 * 用法:  node verify_reply_decision_at.mjs
 */
import { pathToFileURL } from 'node:url';

const SRC = 'C:/Users/20633/MimirLink/src';
const rj = await import(pathToFileURL(`${SRC}/reply-decision.js`).href);

let pass = 0;
const failures = [];
function check(label, condition, extra = '') {
    if (condition) { pass += 1; console.log(`  [OK  ] ${label}`); }
    else { failures.push(label); console.log(`  [FAIL] ${label}${extra ? '  ' + extra : ''}`); }
}

// 用户那天那条的真身（从 logs/mimirlink-2026-10-11.log 抄的，只截断群名）
const HEAD = (extra) => `[群聊|QQ:2063362809|昵称:werwer|群号:1045582694|群名:Hikari|`
    + `时间:2026/10/11 20:40:48|eventType:message|${extra}`;
const AT_RAW = `${HEAD('isAtBot:true|messageSegments:[{"type":"at","qq":"2458713318"},'
    + '{"type":"text","text":"你觉得曲奇饼干全肯定bot怎么样"}]')}] [@bot]  你觉得曲奇饼干全肯定bot怎么样`;
const PLAIN_RAW = '[群聊|QQ:1000000002|昵称:涵|群号:929159193|群名:2026程序|'
    + '时间:2026/10/11 20:41:56|eventType:message|isAtBot:false|'
    + 'messageSegments:[{"type":"text","text":"爆典 av神"}]] 爆典 av神';
const BARE_AT_RAW = HEAD('isAtBot:true|messageSegments:[{"type":"at","qq":"2458713318"}]')
    + '] [@bot]';
const OTHER_AT_RAW = '[群聊|QQ:2063362809|昵称:werwer|群号:929159193|群名:2026程序|'
    + '时间:2026/10/11 20:50:00|eventType:message|isAtBot:false|'
    + 'messageSegments:[{"type":"at","qq":"111111"},{"type":"text","text":"@某人 你看"}]] @某人 你看';

// ---------------------------------------------------------------------------
console.log('=== Part 1  标记必须活到决策层看见（真事故复现）===');

const atCtx = rj.buildDecisionContext([], AT_RAW);
console.log('  ---- 决策层实际看到的文本 ----');
atCtx.split('\n').forEach((l) => console.log('    ' + l));
check('🔴 被 @ 的那条带上了「（@了我）」', atCtx.includes('（@了我）'), atCtx);
check('🔴 正文本身没丢（还看得见问了什么）',
    atCtx.includes('你觉得曲奇饼干全肯定bot怎么样'));
check('说话人还在（werwer）', atCtx.includes('werwer'));

const plainCtx = rj.buildDecisionContext([], PLAIN_RAW);
check('🟢 没被 @ 的**不**带标记（否则等于天天喊她）',
    !plainCtx.includes('（@了我）'), plainCtx);
check('🟢 剥头本身仍然生效（结构化头不该漏进决策层）',
    !plainCtx.includes('messageSegments') && !plainCtx.includes('isAtBot')
    && !plainCtx.includes('eventType'), plainCtx);

// ---------------------------------------------------------------------------
console.log('\n=== Part 2  detectAtBot 的边界 ===');

check('isAtBot:true 认出来', rj.detectAtBot(AT_RAW) === true);
check('正文里的 [@bot] 认出来（即使头里没有 isAtBot）',
    rj.detectAtBot('[群聊|QQ:1|昵称:x|群号:2|时间:1|eventType:message][@bot] 在吗') === true);
check('isAtBot:false 不算', rj.detectAtBot(PLAIN_RAW) === false);
check('空串 / null 安全', rj.detectAtBot('') === false && rj.detectAtBot(null) === false);
// ⚠ 刻意不认 [CQ:at,qq=N]：拿不到 bot 自己的 QQ，认了就等于"@ 谁都算 @ 我"
check('@ 别人（CQ 码形式）**不算** @ 我',
    rj.detectAtBot('[群聊|QQ:1|昵称:x|群号:2|时间:1][CQ:at,qq=999999] 你看') === false);
check('@ 别人（isAtBot:false + 别的 qq）不算 @ 我',
    rj.detectAtBot(OTHER_AT_RAW) === false);

// ---------------------------------------------------------------------------
console.log('\n=== Part 3  只有 @ 没有文字也要留一行 ===');

const bareCtx = rj.buildDecisionContext([], BARE_AT_RAW);
check('🔴 纯 @（没有文字）仍然产生一行（那也是在叫她）',
    bareCtx.includes('（@了我）') && bareCtx.includes('没有文字'), bareCtx);
check('纯 @ 的行里有说话人', bareCtx.includes('werwer'));

// ---------------------------------------------------------------------------
console.log('\n=== Part 4  历史里的 @ 也要标 ===');
{
    const ctx = rj.buildDecisionContext(
        [{ role: 'user', content: AT_RAW }, { role: 'assistant', content: '诶 我在' }], PLAIN_RAW);
    const lines = ctx.split('\n');
    check('历史里被 @ 的那条带标记', lines.some((l) => l.includes('（@了我）')), ctx);
    check('机器人自己那条不误标（前缀是「我:」）',
        lines.some((l) => l.startsWith('我:') && !l.includes('（@了我）')), ctx);
    check('最新一条仍然是最后一行（顺序没乱）',
        lines[lines.length - 1].startsWith('【刚进来的这条】'), ctx);
}

// ---------------------------------------------------------------------------
console.log('\n=== Part 5  提示词：@ 那条要压过「同一件事已答过 / 太短」===');

const P = rj.DEFAULT_DECISION_PROMPT;
check('🔴 提示词里 @/点你名 那一条写明"最优先"',
    /有人直接点了你的名字、@ 了你、或者直接问你[^\n]*最优先/.test(P)
    || /最优先/.test(P.split('\n').filter((l) => l.includes('@ 了你')).join('')));
check('🔴 并且明说"哪怕这件事你刚才已经答过"',
    /哪怕这件事你刚才已经答过/.test(P));
check('「默认是 NO」这句还在（保守基调没被破坏）', /默认是 NO/.test(P));
check('私聊判据没被误改（仍以"大部分都该回"为基调）',
    /大部分话都该回/.test(rj.DEFAULT_PRIVATE_DECISION_PROMPT));
check('@ 这条进的是 YES 列表（不是 NO 列表）', (() => {
    const yesBlock = P.split('只有下面这些才回 YES')[1] || '';
    const noBlock = P.split('出现下面任何一条就回 NO')[1] || '';
    return yesBlock.includes('@ 了你') && !noBlock.includes('@ 了你');
})());

console.log('\n' + '='.repeat(62));
console.log(`结果: ${pass} 通过 / ${failures.length} 失败`);
if (failures.length) { failures.forEach((f) => console.log('  失败: ' + f)); process.exit(1); }
console.log('全部通过');
