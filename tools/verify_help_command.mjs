/**
 * verify_help_command.mjs
 * ---------------------------------------------------------------------------
 * 验证 `/帮助`。
 *
 * 这个脚本的核心是三条：
 *   1. 指令名 / 开关必须从 config **实时解析** —— 把 `/名册` 改成 `/花名册`，
 *      帮助文本必须跟着变（写死字符串的帮助一定会腐烂，而且没人会去同步）。
 *   2. **config 里注册的每条指令都必须在帮助里露脸** —— 以后再加指令忘了写 help，
 *      Part 6 会直接红。这是防"新功能没人知道"的唯一机械手段。
 *   3. 🔴 **群聊里指令要 @ 才执行**，帮助必须如实写出来（帮助不许说谎）。
 *
 * 2026-10-12 用户要求「帮助的回复改得公正一点、书面一点」⇒ 措辞改成说明文口吻，
 * Part 3 里加了"不许出现聊天腔"的断言，防止以后又飘回口语。
 *
 * 用法:  node verify_help_command.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MIMIR = 'C:/Users/20633/MimirLink';
const SRC = `${MIMIR}/src`;
const IDX_SRC = fs.readFileSync(`${SRC}/index.js`, 'utf8');

let pass = 0;
const failures = [];
function check(label, condition, extra = '') {
    if (condition) { pass += 1; console.log(`  [OK  ] ${label}`); }
    else { failures.push(label); console.log(`  [FAIL] ${label}${extra ? '  ' + extra : ''}`); }
}

const H = await import(pathToFileURL(`${SRC}/help-command.js`).href);
const realCfg = JSON.parse(fs.readFileSync(`${MIMIR}/config.json`, 'utf8'));
const noop = { info() {}, warn() {}, error() {}, debug() {} };

// ---------------------------------------------------------------------------
console.log('=== Part 1  指令名 / 开关必须跟着 config 走 ===');

const renamed = JSON.parse(JSON.stringify(realCfg));
renamed.chat.commands.roster.command = '/花名册';
renamed.chat.commands.forget.command = '/忘掉他';
renamed.chat.commands.thinking.command = '/思维链';
renamed.chat.commands.ojFeedback.command = '/oj';
const renamedText = H.buildHelpText(renamed, { isAdmin: true, messageType: 'private' });
check('改了 /名册 ⇒ 帮助里跟着变成 /花名册', renamedText.includes('/花名册'));
check('旧名不残留（说明是现拼的，不是写死）', !renamedText.includes('· /名册'));
check('/忘记 /思考 /反馈 三个改名同步生效',
    renamedText.includes('/忘掉他') && renamedText.includes('/思维链') && renamedText.includes('/oj'));

const disabled = JSON.parse(JSON.stringify(realCfg));
disabled.chat.commands.roster.enabled = false;
disabled.chat.music.enabled = false;
const disabledText = H.buildHelpText(disabled, { isAdmin: true, messageType: 'private' });
check('🔴 关掉的指令**照样列出**但标注「未启用」（藏起来会让人以为功能没了）',
    disabledText.includes('/名册') && /\/名册.*（未启用）/.test(disabledText));
check('未启用的点歌也标注出来', /\/music.*（未启用）/.test(disabledText));
check('启用的指令不标注', !/\/帮助.*（未启用）/.test(disabledText));

const pokeCfg = JSON.parse(JSON.stringify(realCfg));
pokeCfg.chat.commands.adminPoke.repeatCount = 9;
check('desc 里的动态数字也来自 config（戳一戳 9 次）',
    H.buildHelpText(pokeCfg, { isAdmin: true }).includes('共 9 次'));

const offOj = JSON.parse(JSON.stringify(realCfg));
offOj.ojFeedback.enabled = false;
check('/反馈 的开关同时看 chat.commands 与 ojFeedback.enabled',
    /\/反馈.*（未启用）/.test(H.buildHelpText(offOj, { isAdmin: true })));

// ---------------------------------------------------------------------------
console.log('\n=== Part 2  权限分屏 ===');

const adminText = H.buildHelpText(realCfg, { isAdmin: true, messageType: 'private' });
const userText = H.buildHelpText(realCfg, { isAdmin: false, messageType: 'private' });
check('管理员看得到管理指令',
    adminText.includes('【管理员指令】') && adminText.includes('/名册') && adminText.includes('/反馈'));
check('🔴 普通用户看不到管理指令（不列一堆用不了的）',
    !userText.includes('【管理员指令】') && !userText.includes('/名册') && !userText.includes('/忘记')
    && !userText.includes('/反馈') && !userText.includes('/人物档案'));
check('普通用户仍看得到 /帮助', userText.includes('/帮助'));
check('普通用户那句"管理指令仅对管理员显示"在', userText.includes('管理指令仅对管理员显示'));
check('管理员的抬头说明了当前身份', adminText.includes('当前身份：管理员'));

// ---------------------------------------------------------------------------
console.log('\n=== Part 3  「触发方式」四种组合 + 措辞口径 ===');

function triggerBlock(cfg, opts = {}) {
    const text = H.buildHelpText(cfg, { isAdmin: true, messageType: 'group', ...opts });
    const m = text.match(/【触发方式】\n([\s\S]*?)\n\n【/);
    return m ? m[1] : '';
}
const atOnly = JSON.parse(JSON.stringify(realCfg));
atOnly.chat.requireAtInGroup = true;
atOnly.chat.triggerKeywords = [];
check('要 @ + 没关键词 ⇒ 明说"需 @机器人"', /群聊：需 @机器人。/.test(triggerBlock(atOnly)),
    triggerBlock(atOnly));
atOnly.chat.triggerKeywords = ['爱音', 'anon'];
check('要 @ + 有关键词 ⇒ 两种方式都给出',
    /需 @机器人，或消息中包含以下关键词 —— 爱音、anon/.test(triggerBlock(atOnly)),
    triggerBlock(atOnly));
const kwOnly = JSON.parse(JSON.stringify(realCfg));
kwOnly.chat.requireAtInGroup = false;
kwOnly.chat.triggerKeywords = ['爱音'];
check('不要 @ + 有关键词 ⇒ 明说关键词即会响应',
    /消息包含以下关键词即会响应 —— 爱音；@机器人 同样有效。/.test(triggerBlock(kwOnly)),
    triggerBlock(kwOnly));
kwOnly.chat.triggerKeywords = [];
check('不要 @ + 没关键词 ⇒ 说按群聊意愿',
    /群聊意愿自行决定是否响应/.test(triggerBlock(kwOnly)), triggerBlock(kwOnly));
check('🔴 关键词多于 6 个时截断加"等"（别把一行塞爆）', (() => {
    const many = JSON.parse(JSON.stringify(realCfg));
    many.chat.requireAtInGroup = false;
    many.chat.triggerKeywords = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const b = triggerBlock(many);
    return b.includes('a、b、c、d、e、f 等') && !b.includes(' 等、');
})());
check('私聊时说"发送消息或指令均无需 @"',
    /私聊：发送消息或指令均无需 @。/.test(triggerBlock(realCfg, { messageType: 'private' })));

const rwOff = JSON.parse(JSON.stringify(realCfg));
rwOff.chat.replyWindow = { enabled: false, ms: 180000 };
check('回复窗口关了就不提它', !/回复窗口/.test(triggerBlock(rwOff)));
const rwOn = JSON.parse(JSON.stringify(realCfg));
rwOn.chat.replyWindow = { enabled: true, ms: 90000 };
check('回复窗口开着就说清秒数（90000ms → 90 秒）',
    /机器人回复后 90 秒内，同一发送者再次发言无需 @/.test(triggerBlock(rwOn)), triggerBlock(rwOn));

check('🔴 指令在群里要 @ 这条写出来了（帮助不许说谎）',
    /指令：群聊中需 @机器人 才会执行。/.test(triggerBlock(realCfg)));
check('私聊视角不提"群里要 @"',
    !/指令：群聊中需/.test(triggerBlock(realCfg, { messageType: 'private' })));
check('节标题是书面的「触发方式」', adminText.includes('【触发方式】'));

// 措辞口径（用户 2026-10-12：「公正一点、书面一点」）
const CHATTY = /就行|好麻烦|她刚回过你|你是管理员|～/;
check('🔴 不再出现聊天腔（就行/好麻烦/她刚回过你/你是管理员/～）',
    !CHATTY.test(adminText), `命中: ${adminText.match(CHATTY)?.[0] || ''}`);
check('🔴 不再出现聊天腔（普通用户视角也一样）',
    !CHATTY.test(userText), `命中: ${userText.match(CHATTY)?.[0] || ''}`);
check('用「机器人」作主语描述触发（不是口语的「她」）',
    triggerBlock(realCfg).includes('@机器人'));

// ---------------------------------------------------------------------------
console.log('\n=== Part 4  关键词过滤 ===');

const hit = H.buildHelpText(realCfg, { isAdmin: true, keyword: '/名册' });
check('命中时只给那一条', hit.includes('/名册') && !hit.includes('/戳一戳') && !hit.includes('/at'));
check('命中时带表头', hit.includes('与「/名册」相关的指令'));
const hitTodo = H.buildHelpText(realCfg, { isAdmin: true, keyword: '点歌' });
check('按说明里的词也能搜到（点歌 → /music）', hitTodo.includes('/music'), hitTodo.slice(0, 80));
const hitNoSlash = H.buildHelpText(realCfg, { isAdmin: true, keyword: '名册' });
check('关键词不用带斜杠也能搜', hitNoSlash.includes('/名册'));
const miss = H.buildHelpText(realCfg, { isAdmin: true, keyword: '不存在的指令' });
check('搜不到时给出下一步（发送 /帮助 查看全部）',
    miss.includes('未找到与') && miss.includes('查看全部指令'), miss);
const missUser = H.buildHelpText(realCfg, { isAdmin: false, keyword: '名册' });
check('普通用户搜管理指令 ⇒ 明确提示"管理指令仅对管理员显示"',
    missUser.includes('管理指令仅对管理员显示'), missUser);

// ---------------------------------------------------------------------------
console.log('\n=== Part 5  句柄行为 ===');

async function runHelp({ plainText = '/帮助', enabled = true, isAdmin = false, allowed = true, messageType = 'private' } = {}) {
    const sent = [];
    const res = await H.executeHelpCommand({
        event: { user_id: 2063362809, message_type: messageType },
        plainText,
        getConfig: () => realCfg,
        command: '/帮助',
        enabled,
        isAdmin,
        allowed,
        onCommandAccepted: () => {},
        sendStatusMessage: (m) => sent.push(m),
        sendFailureMessage: (m) => sent.push('FAIL:' + m),
        logger: noop
    });
    return { res, sent };
}

check('非 /帮助 的文本不接管', (await runHelp({ plainText: '你好' })).res.handled === false);
check('开关关了不接管', (await runHelp({ enabled: false })).res.handled === false);
check('/帮助x 不算指令', (await runHelp({ plainText: '/帮助x' })).res.handled === false);
check('/帮助 后面接空格算指令', (await runHelp({ plainText: '/帮助 名册' })).res.handled === true);
const blocked = await runHelp({ allowed: false });
check('🔴 未授权会话里**静默返回**（不回"你没权限"，那本身就是信息泄露）',
    blocked.res.handled === true && blocked.sent.length === 0, JSON.stringify(blocked.sent));
const asUser = await runHelp({ isAdmin: false });
check('普通用户拿到精简版', asUser.sent.length === 1 && !asUser.sent[0].includes('/名册'));
const asAdmin = await runHelp({ isAdmin: true });
check('管理员拿到完整版', asAdmin.sent.length === 1 && asAdmin.sent[0].includes('/名册'));
check('群里也是同样输出',
    (await runHelp({ isAdmin: true, messageType: 'group' })).sent[0].includes('【管理员指令】'));

// ---------------------------------------------------------------------------
console.log('\n=== Part 6  🔴 帮助不许漏指令（与 config 交叉核对）===');

const registered = Object.keys(realCfg.chat.commands);
for (const key of registered) {
    const cmd = realCfg.chat.commands[key]?.command;
    check(`config 注册的 chat.commands.${key}（${cmd}）在帮助里有`,
        typeof cmd === 'string' && adminText.includes(cmd), `cmd=${cmd}`);
}
check('点歌（chat.music.command）也在帮助里',
    adminText.includes(realCfg.chat.music.command) || realCfg.chat.music.enabled !== true,
    `music=${realCfg.chat.music.command} enabled=${realCfg.chat.music.enabled}`);
check('点歌退出指令在帮助里', adminText.includes(realCfg.chat.music.exitCommand));
check('帮助文本长度适合一条 QQ 消息（< 2000 字）',
    adminText.length < 2000, `实际 ${adminText.length} 字`);

// ---------------------------------------------------------------------------
console.log('\n=== Part 7  index.js / 配置接线 ===');

check('index.js 引入了 help-command 模块', IDX_SRC.includes("from './help-command.js'"));
check('`/帮助` 挂进 dispatch 链', IDX_SRC.includes('await handleHelpCommand(event, commandInput)'));
check('`/帮助` 在 buildRoutingDecision 之前（不然会被触发规则吃掉）',
    IDX_SRC.indexOf('await handleHelpCommand(event, commandInput)')
    < IDX_SRC.indexOf('const routingDecision = buildRoutingDecision('));
check('配置归一化接上了', IDX_SRC.includes('config.chat.commands.help = {'));
check('🔴 帮助也过访问控制（和点歌同一条口径）', IDX_SRC.includes('allowed: isAllowed(config, event)'));
check('未授权时静默（executeHelpCommand 里 return 前不发送）',
    fs.readFileSync(`${SRC}/help-command.js`, 'utf8').includes('不要在未授权会话里回一句"你没权限"'));

// 🔴 2026-10-12 新要求：群里指令必须 @
check('🔴 群里指令必须 @ 才执行（group-command-at-gate）',
    IDX_SRC.includes("const commandGate = event.message_type !== 'group' || isAtMe;")
    && IDX_SRC.includes('if (commandGate) {'));
check('闸门盖住了 /llm', IDX_SRC.includes("if (commandGate && commandInput.trim() === '/llm'"));
check('闸门盖住了点歌', IDX_SRC.includes('if (commandGate && await handleMusicCommand(event, commandInput))'));
check('🔴 `!llmEnabled` 留在闸门外面（否则群里没 @ 时"关掉 LLM 就不处理"会一起失效）', (() => {
    const gateOpen = IDX_SRC.indexOf('if (commandGate) {');
    const llmCheck = IDX_SRC.indexOf('if (!llmEnabled) {');
    return llmCheck > 0 && gateOpen > 0 && llmCheck < gateOpen;
})());
check('闸门只对群聊生效（私聊 commandGate 恒为真）',
    IDX_SRC.includes("event.message_type !== 'group' || isAtMe"));

for (const rel of ['config.json', 'configs/anon.json', 'config.example.json']) {
    const c = JSON.parse(fs.readFileSync(`${MIMIR}/${rel}`, 'utf8'));
    check(`${rel}: /帮助 已注册`,
        c.chat?.commands?.help?.command === '/帮助' && c.chat.commands.help.enabled === true);
}
for (const rel of ['config.json', 'config.example.json']) {
    const c = JSON.parse(fs.readFileSync(path.join(path.dirname(MIMIR), 'MimirLink-soyo', rel), 'utf8'));
    check(`soyo ${rel}: /帮助 已注册`, c.chat?.commands?.help?.command === '/帮助');
}

// ---------------------------------------------------------------------------
console.log(`\n=== 汇总: ${pass} 通过 / ${failures.length} 失败 ===`);
if (failures.length > 0) {
    console.log('失败项:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exitCode = 1;
}
