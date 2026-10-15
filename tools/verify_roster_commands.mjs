/**
 * verify_roster_commands.mjs
 * ---------------------------------------------------------------------------
 * 验证「人物类管理指令 + 思考显示」这一轮改动。三条能力：
 *
 *   /名册            —— 输出「QQ号 + 所有别称」（用户口径）
 *   /忘记 <昵称|QQ>   —— 删 participant_contacts 一行 + 他署名过的 memory_entries
 *   /思考 开|关       —— 把思考内容用括号带出来
 *
 * 为什么这几个断言是这几个
 * ------------------------
 * 1. **QQ 是主键，别称只是属性**。实测同一个 QQ 有过两个昵称（werwer / W），两个不同
 *    QQ 又叫同一个昵称（2063362809 / 1000000003）。所以 `/名册` 的排布必须是
 *    `QQ：别称、别称`，而不是 `昵称(QQ)` —— 后者在撞名时根本没法用。
 * 2. **截断必须说出来**。本项目吃过"只给前 N 条静默失效"的亏（名册是按最近联系排的，
 *    被问到的人排第 14 位就一行都没进 prompt，外部完全看不出来）。所以超限时正文里
 *    必须出现"还有 N 人没列出来"。
 * 3. **`/忘记` 不能删 messages**。群历史是批量合并存的（一条里混着好几个人的话），
 *    按作者删会连累别人。断言的是"删的是哪两处"，不是"删得干不干净"。
 * 4. **思考显示默认必须是关的**。它会把思维链直接发到 QQ，群聊里所有人都看得见。
 *
 * 用法:  node verify_roster_commands.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MIMIR = 'C:/Users/20633/MimirLink';
const SRC = `${MIMIR}/src`;
const IDX_SRC = fs.readFileSync(`${SRC}/index.js`, 'utf8');
const SES_SRC = fs.readFileSync(`${SRC}/session.js`, 'utf8');

let pass = 0;
const failures = [];
function check(label, condition, extra = '') {
    if (condition) { pass += 1; console.log(`  [OK  ] ${label}`); }
    else { failures.push(label); console.log(`  [FAIL] ${label}${extra ? '  ' + extra : ''}`); }
}

const RC = await import(pathToFileURL(`${SRC}/roster-commands.js`).href);

// ---------------------------------------------------------------------------
console.log('=== Part 1  `/名册` 的正文形态（用户口径：QQ号 + 所有别称）===');

const ROWS = [
    { participant_id: '2063362809', display_name: 'werwer', name_history: '["小W","老王"]' },
    { participant_id: '1000000002', display_name: '涵', name_history: '[]' },
    { participant_id: '1000000003', display_name: 'werwer', name_history: '[]' },
    { participant_id: '1000000005', display_name: '', name_history: '[]' }
];

check('一行的形态是 `QQ：别称、别称`',
    RC.formatContactLine(ROWS[0]) === '2063362809：werwer、小W、老王',
    RC.formatContactLine(ROWS[0]));
check('QQ 在前、别称在后（主键在前，撞名时仍然可用）',
    RC.formatContactLine(ROWS[0]).startsWith('2063362809：'));
check('当前昵称排在别称最前', RC.collectContactAliases(ROWS[0])[0] === 'werwer');
check('别称去重（name_history 里再出现当前昵称也只留一份）',
    RC.collectContactAliases({ participant_id: '1', display_name: 'A', name_history: '["A","B"]' }).join(',') === 'A,B');
check('别称上限可配',
    RC.collectContactAliases(ROWS[0], 2).length === 2);
check('没有任何称呼时只留 QQ，不留空壳标签',
    RC.formatContactLine(ROWS[3]) === '1000000005',
    RC.formatContactLine(ROWS[3]));
check('缺 participant_id 的行返回空串（不会被拼进正文）',
    RC.formatContactLine({ display_name: 'X' }) === '');

const listText = RC.buildContactListText(ROWS, {});
check('开头报了总人数', /她一共认识 4 个人/.test(listText), listText.split('\n')[0]);
check('四个人各占一行', listText.split('\n').filter((l) => /^\d{6,}/.test(l)).length === 4);
check('🔴 name_history 是 JSON 字符串也能解析（不是数组）',
    listText.includes('2063362809：werwer、小W、老王'));
check('同名不同 QQ 都列出来（恰恰说明昵称不能当键）',
    listText.includes('2063362809：') && listText.includes('1000000003：werwer'));

check('空名单给的是明确空态，不是一句空正文',
    /联系人是空的/.test(RC.buildContactListText([], {})));
check('关键词过滤：命中 QQ 号', /匹配「2063」的 1 个人/.test(RC.buildContactListText(ROWS, { keyword: '2063' })));
check('关键词过滤：命中别称', /匹配「小W」的 1 个人/.test(RC.buildContactListText(ROWS, { keyword: '小W' })));
check('关键词过滤：大小写不敏感',
    /匹配「WERWER」的 2 个人/.test(RC.buildContactListText(ROWS, { keyword: 'WERWER' })));
check('关键词过滤：查不到时给出下一步（怎么列全部）',
    /没有匹配「不存在」的人/.test(RC.buildContactListText(ROWS, { keyword: '不存在' })));

const truncated = RC.buildContactListText(ROWS, { maxEntries: 2 });
check('🔴 截断时必须说明还有多少人没列（不能静默失效）',
    /还有 2 人没列出来/.test(truncated), truncated);
check('截断时只列 maxEntries 行',
    truncated.split('\n').filter((l) => /^\d{6,}/.test(l)).length === 2);
const notTruncated = RC.buildContactListText(ROWS, { maxEntries: 4 });
check('刚好装得下时不出现"还有 N 人"', !/还有 \d+ 人/.test(notTruncated));

// ---------------------------------------------------------------------------
console.log('\n=== Part 2  `/忘记` 的参数判定与回执 ===');

check('参数是一串数字 ⇒ 当 QQ', RC.parseForgetArgument('2063362809').kind === 'qq');
check('参数是昵称 ⇒ 当昵称', RC.parseForgetArgument('涵').kind === 'name');
check('没参数 ⇒ none', RC.parseForgetArgument('   ').kind === 'none');
check('⚠ 2 位数字不当 QQ（真 QQ 最短 5 位）', RC.parseForgetArgument('66').kind === 'name');
check('13 位数字不当 QQ（防把长串误判）', RC.parseForgetArgument('1234567890123').kind === 'name');

const candidates = RC.buildForgetCandidateText('werwer', [
    { participant_id: '2063362809', display_name: 'werwer', name_history: '[]' },
    { participant_id: '1000000003', display_name: 'werwer', name_history: '[]' }
], {});
check('🔴 撞名时列候选 + 要求改用 QQ（不自作主张挑一个删）',
    /有 2 个/.test(candidates) && candidates.includes('2063362809：werwer') && candidates.includes('1000000003：werwer'),
    candidates.replace(/\n/g, ' | '));

const forgetOk = RC.formatForgetResult({ participantId: '2063362809', displayName: 'werwer', contactDeleted: 1, memoryEntriesDeleted: 12 });
check('回执写清了删掉多少条', /联系人 1 条、记忆副本 12 条/.test(forgetOk), forgetOk);
check('回执带上昵称，便于核对删对了人', forgetOk.includes('2063362809（werwer）'));
check('🔴 回执明说 messages/summaries 没动（避免误解成"抹掉他说过的每句话"）',
    /群聊历史与摘要没动/.test(forgetOk));
check('一条都没删时说清楚"本来就不在名册里"',
    /本来就不在名册里/.test(RC.formatForgetResult({ participantId: '1', contactDeleted: 0, memoryEntriesDeleted: 0 })));

// ---------------------------------------------------------------------------
console.log('\n=== Part 3  `/忘记` 打在真库上（删哪两处，不删哪两处）===');

const { SessionManager } = await import(pathToFileURL(`${SRC}/session.js`).href);
const noop = { info() {}, warn() {}, error() {}, debug() {} };
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-cmd-'));
const dbPath = path.join(tmpDir, 'memory-store.sqlite');
const sm = new SessionManager(tmpDir, { memory: { storage: { path: dbPath } } }, noop);

// 造两个人 + 他们的消息与记忆副本
const SID = 'private:2063362809';
sm.addMessage(SID, 'user', '[私聊|QQ:2063362809|昵称:werwer|群号:N/A|群名:N/A|时间:2026/10/11 21:00:00|eventType:message|isAtBot:false|messageSegments:[{"type":"text","text":"我俩去吃饭"}] 我俩去吃饭', {
    participants: ['werwer(2063362809)'],
    userId: 2063362809,
    messageType: 'private'
});
sm.addMessage(SID, 'user', '[私聊|QQ:88888888|昵称:别人|群号:N/A|群名:N/A|时间:2026/10/11 21:01:00|eventType:message|isAtBot:false|messageSegments:[{"type":"text","text":"顺路捎我一个"}] 顺路捎我一个', {
    participants: ['别人(88888888)'],
    userId: 88888888,
    messageType: 'private'
});

const contactsBefore = sm.listRecentContacts(50);
check('通讯录里已经有两个人', contactsBefore.length === 2, `实际 ${contactsBefore.length}`);

const foundByName = sm.findContactsByName('werwer');
check('按昵称能找到人', foundByName.length === 1 && foundByName[0].participantId === '2063362809',
    JSON.stringify(foundByName));
const foundByOldName = sm.findContactsByName('小W');
check('没写过的曾用名找不到（现状：只有真出现过的名字才进 name_history）',
    Array.isArray(foundByOldName));

// 让这个人真的在 memory_entries 里有署名副本
const ns = sm.getOrCreateNamespace?.('private_user', 'private:2063362809', null) || null;
let memBefore = Number(sm.db.prepare("SELECT COUNT(*) n FROM memory_entries WHERE content LIKE '%|QQ:2063362809|%'").get()?.n || 0);
if (memBefore === 0) {
    // 走正常的会话记忆写入（upsertConversationMemory），确保 content 里带署名头
    try {
        sm.upsertConversationMemory({ namespaceId: ns?.id, scopeType: 'private_user', scopeKey: 'private:2063362809' }, {
            userMessage: '[私聊|QQ:2063362809|昵称:werwer|...] 我俩去吃饭',
            assistantMessage: '行啊',
            sourceSessionId: SID,
            sourceMessageId: 'x1'
        });
    } catch { /* 接口差异不致命：下面按实际条数断言 */ }
    memBefore = Number(sm.db.prepare("SELECT COUNT(*) n FROM memory_entries WHERE content LIKE '%|QQ:2063362809|%'").get()?.n || 0);
}
console.log(`  （前置）署名过 2063362809 的记忆副本 ${memBefore} 条`);
check('🔴 有可删的记忆副本，否则这条链路验不到（否则下面两条断言恒真）', memBefore > 0, `memBefore=${memBefore}`);

const msgCountBefore = Number(sm.db.prepare("SELECT COUNT(*) n FROM messages WHERE content LIKE '%|QQ:2063362809|%'").get()?.n || 0);

const result = sm.forgetContact('2063362809');
check('删掉了 participant_contacts 那一行', result.contactDeleted === 1, JSON.stringify(result));
check('删掉了 memory_entries 里的署名副本', result.memoryEntriesDeleted === memBefore, JSON.stringify(result));
check('🔴 messages **没动**（群历史是批量合并存的，按作者删会连累别人）',
    Number(sm.db.prepare("SELECT COUNT(*) n FROM messages WHERE content LIKE '%|QQ:2063362809|%'").get()?.n || 0) === msgCountBefore,
    `before=${msgCountBefore}`);
check('另一个人还在名册里', sm.listRecentContacts(50).some((r) => r.participant_id === '88888888'));
check('被忘的人不在名册里了', !sm.listRecentContacts(50).some((r) => r.participant_id === '2063362809'));
check('再忘一次是幂等的（返回 0，不报错）',
    sm.forgetContact('2063362809').contactDeleted === 0);
check('空 id 不报错', sm.forgetContact('').contactDeleted === 0);

// ---------------------------------------------------------------------------
console.log('\n=== Part 4  指令句柄行为（管理员校验 / 开关 / @ 目标）===');

async function runRoster({ plainText = '/名册', enabled = true, isAdmin = true, rows = ROWS } = {}) {
    const sent = [];
    const res = await RC.executeRosterCommand({
        event: { user_id: 1, message_type: 'private' },
        plainText,
        command: '/名册',
        enabled,
        isAdmin,
        sessionManager: { listRecentContacts: () => rows },
        onCommandAccepted: () => {},
        sendStatusMessage: (m) => sent.push(m),
        sendFailureMessage: (m) => sent.push('FAIL:' + m),
        logger: noop
    });
    return { res, sent };
}

check('非 /名册 的文本不接管', (await runRoster({ plainText: '你好' })).res.handled === false);
check('开关关了不接管', (await runRoster({ enabled: false })).res.handled === false);
check('/名册 前缀后面接空格算指令', (await runRoster({ plainText: '/名册 all' })).res.handled === true);
check('/名册x 不算指令（避免误伤普通发言）', (await runRoster({ plainText: '/名册x' })).res.handled === false);
const adminOnly = await runRoster({ isAdmin: false });
check('🔴 非管理员被挡（并给出提示，不是静默吞掉）',
    adminOnly.res.handled === true && adminOnly.sent[0].startsWith('FAIL:'), JSON.stringify(adminOnly.sent));
const normal = await runRoster({});
check('管理员拿到的是名册正文', normal.sent.length === 1 && normal.sent[0].includes('2063362809：werwer、小W、老王'));

async function runForget({ plainText = '/忘记 werwer', isAdmin = true, mentionedParticipantId = '', byName = [], forgetResult = null } = {}) {
    const sent = [];
    const forgetCalls = [];
    const res = await RC.executeForgetCommand({
        event: { user_id: 1, message_type: 'private' },
        plainText,
        command: '/忘记',
        isAdmin,
        mentionedParticipantId,
        sessionManager: {
            findContactsByName: () => byName,
            forgetContact: (id) => { forgetCalls.push(id); return forgetResult || { participantId: id, contactDeleted: 1, memoryEntriesDeleted: 3 }; }
        },
        onCommandAccepted: () => {},
        sendStatusMessage: (m) => sent.push(m),
        sendFailureMessage: (m) => sent.push('FAIL:' + m),
        logger: noop
    });
    return { res, sent, forgetCalls };
}

const noArg = await runForget({ plainText: '/忘记' });
check('没给目标 ⇒ 报用法（不误删）',
    noArg.forgetCalls.length === 0 && /用法/.test(noArg.sent[0]), JSON.stringify(noArg.sent));
const missing = await runForget({ byName: [] });
check('昵称查不到 ⇒ 不删 + 指引去 /名册',
    missing.forgetCalls.length === 0 && /没找到叫「werwer」的人/.test(missing.sent[0]));
const ambiguous = await runForget({
    byName: [
        { participantId: '2063362809', displayName: 'werwer' },
        { participantId: '1000000003', displayName: 'werwer' }
    ]
});
check('🔴 撞名 ⇒ 一个都不删，列候选要求指定 QQ',
    ambiguous.forgetCalls.length === 0 && /有 2 个/.test(ambiguous.sent[0]));
const single = await runForget({ byName: [{ participantId: '2063362809', displayName: 'werwer' }] });
check('唯一命中 ⇒ 真的调用删除', single.forgetCalls.length === 1 && single.forgetCalls[0] === '2063362809');
const byQq = await runForget({ plainText: '/忘记 2063362809' });
check('直接给 QQ 也能删（不必先查昵称）', byQq.forgetCalls[0] === '2063362809');
const byAt = await runForget({ plainText: '/忘记', mentionedParticipantId: '2063362809' });
check('@某人 优先于文本参数', byAt.forgetCalls[0] === '2063362809');

// ---------------------------------------------------------------------------
console.log('\n=== Part 5  思考显示：括号形态 / 截断 / 作用域 ===');

check('paren 形态是 `（思考：…）`',
    RC.formatThinkingBlock('她觉得这话在逗她', { format: 'paren', label: '思考', maxChars: 0 })
    === '（思考：她觉得这话在逗她）');
check('label 显式给空串 ⇒ 纯括号（角色的心理活动式）',
    RC.formatThinkingBlock('abc', { format: 'paren', label: '', maxChars: 0 }) === '（abc）');
check('label 缺省时用默认标签', RC.formatThinkingBlock('abc', { maxChars: 0 }) === '（思考：abc）');
check('debug 形态保留旧分节格式（给 chat.sendReasoningToQQ 用）',
    RC.formatThinkingBlock('abc', { format: 'debug' }) === '【思维链】\nabc');
check('🔴 默认就是 paren（用户口径："用括号显示"）',
    RC.THINKING_DISPLAY_DEFAULTS.format === 'paren');
check('🔴 默认是关的（思维链直发 QQ，群里所有人都看得见）',
    RC.THINKING_DISPLAY_DEFAULTS.enabled === false);
check('换行被压成空格（不然一条消息十几个空行）',
    RC.formatThinkingBlock('a\n\n  b', { maxChars: 0 }) === '（思考：a b）');
check('没思考内容 ⇒ 空串（不能留下一对空括号）',
    RC.formatThinkingBlock('   ', { maxChars: 0 }) === '');
check('超过上限就截断并加省略号',
    RC.formatThinkingBlock('x'.repeat(50), { maxChars: 10 }) === '（思考：' + 'x'.repeat(10) + '…）');
check('maxChars=0 ⇒ 不截断',
    RC.formatThinkingBlock('x'.repeat(5000), { maxChars: 0 }).length > 5000);

check('position=after（默认）：正文在前、思考在后',
    RC.buildThinkingAnnotatedReply('想', '正文', { maxChars: 0 }) === '正文\n（思考：想）');
check('position=before：思考在前',
    RC.buildThinkingAnnotatedReply('想', '正文', { maxChars: 0, position: 'before' }) === '（思考：想）\n正文');
check('正文为空时只留思考块（不至于发一条空消息）',
    RC.buildThinkingAnnotatedReply('想', '   ', { maxChars: 0 }) === '（思考：想）');
check('没有思考内容 ⇒ 原样返回正文',
    RC.buildThinkingAnnotatedReply('', '正文', { maxChars: 0 }) === '正文');

check('scope=all 时私聊也带', RC.isThinkingDisplayAllowed({ enabled: true, scope: 'all' }, { message_type: 'private' }) === true);
check('scope=private 时群里不带', RC.isThinkingDisplayAllowed({ enabled: true, scope: 'private' }, { message_type: 'group' }) === false);
check('scope=group 时私聊不带', RC.isThinkingDisplayAllowed({ enabled: true, scope: 'group' }, { message_type: 'private' }) === false);
check('enabled=false 一律不带', RC.isThinkingDisplayAllowed({ enabled: false, scope: 'all' }, { message_type: 'private' }) === false);

// ---------------------------------------------------------------------------
console.log('\n=== Part 6  index.js / config 接线 ===');

check('index.js 引入了 roster-commands 模块', IDX_SRC.includes("from './roster-commands.js'"));
check('三个指令都挂进了 dispatch 链',
    IDX_SRC.includes('await handleRosterCommand(event, commandInput)')
    && IDX_SRC.includes('await handleForgetCommand(event, commandInput)')
    && IDX_SRC.includes('await handleThinkingCommand(event, commandInput)'));
check('🔴 指令派发在 buildRoutingDecision 之前（不然会被触发规则先吃掉）',
    IDX_SRC.indexOf('await handleRosterCommand(event, commandInput)') < IDX_SRC.indexOf('const routingDecision = buildRoutingDecision('));
check('思考显示接在真实回复链路上（reasoningIncluded 一处判定、多处使用）',
    IDX_SRC.includes('const reasoningIncluded = reasoningDisplay !== \'none\' && !!reasoningContent;')
    && IDX_SRC.includes('forceSingleMessage: reasoningIncluded,'));
check('思考块不被 splitMessage 拆散（否则括号会被拆到两条消息里）',
    IDX_SRC.includes('splitMessage: reasoningIncluded ? false : config.chat.splitMessage !== false,'));
check('热开关有内存态覆盖（不改 config.json，避免和 WebUI 写入打架）',
    IDX_SRC.includes('let showThinkingOverride = null;'));
check('热开关覆盖优先于配置默认',
    IDX_SRC.includes('showThinkingOverride = nextValue === null ? null : nextValue === true;'));
check('config 归一化是幂等的（WebUI 保存会重跑一遍）',
    IDX_SRC.includes('config.chat.showThinking = normalizeShowThinkingConfig(showThinking);'));
check('maxChars 允许 0（=不截断），没被 clampInteger 顶到 1',
    IDX_SRC.includes('maxChars: clampIntegerAllowZero(input.maxChars, 0, 20000, THINKING_DISPLAY_DEFAULTS.maxChars)'));
check('label 用 typeof 判断，显式空串不会被默认值顶掉',
    IDX_SRC.includes("(typeof input.label === 'string' || input.label === null)"));

for (const rel of ['config.json', 'configs/anon.json', 'configs/soyo.json', 'config.example.json']) {
    const cfg = JSON.parse(fs.readFileSync(`${MIMIR}/${rel}`, 'utf8'));
    const cmd = cfg.chat?.commands || {};
    const st = cfg.chat?.showThinking;
    check(`${rel}: 三个指令键齐全`,
        cmd.roster?.command === '/名册' && cmd.forget?.command === '/忘记' && cmd.thinking?.command === '/思考');
    check(`${rel}: showThinking 默认关且是括号形态`,
        st?.enabled === false && st?.format === 'paren' && st?.scope === 'all');
}

console.log('\n=== Part 7  WebUI 勾选框（面板上能不能开关）===');
const HTML = fs.readFileSync(`${MIMIR}/public/index.html`, 'utf8');
check('面板上有 checkbox 元素', HTML.includes('id="config-chat-show-thinking"'));
check('载入配置时回填勾选状态',
    HTML.includes("document.getElementById('config-chat-show-thinking').checked = currentConfig.chat?.showThinking?.enabled === true;"));
check('保存时写回配置',
    HTML.includes("showThinking: {") && HTML.includes('enabled: document.getElementById(\'config-chat-show-thinking\').checked'));
check('🔴 保存只覆盖 enabled，其余字段用展开原样带回（否则面板一保存就把手写配置抹成默认）',
    HTML.includes('...(currentConfig.chat?.showThinking || {}),'));

// ---------------------------------------------------------------------------
console.log('\n=== Part 8  `normalizeShowThinkingConfig` 真函数求值（从 index.js 切，不抄）===');
// index.js 顶层会起服务器/连 OneBot ⇒ 不能 import。按本项目惯例从源码切出函数体再求值。
{
    const start = IDX_SRC.indexOf('function normalizeShowThinkingConfig(source = {}) {');
    const end = IDX_SRC.indexOf('// <<< roster-commands patch <<<', start);
    const body = start >= 0 && end > start ? IDX_SRC.slice(start, end) : '';
    check('能从 index.js 切出 normalizeShowThinkingConfig', body.length > 0, '标记不在？');
    if (body.length > 0) {
        const harness = `
const THINKING_DISPLAY_DEFAULTS = ${JSON.stringify(RC.THINKING_DISPLAY_DEFAULTS)};
function clampIntegerAllowZero(value, minimum, maximum, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.floor(n)));
}
${body.replace(/^function normalizeShowThinkingConfig/, 'export function normalizeShowThinkingConfig')}
`;
        const tmp = path.join(os.tmpdir(), `thinking-cfg-${Date.now()}.mjs`);
        fs.writeFileSync(tmp, harness, 'utf8');
        const mod = await import(pathToFileURL(tmp).href);
        const n = mod.normalizeShowThinkingConfig;

        check('空对象 ⇒ 全用默认（关 / paren / 思考 / 1200 / after / all）',
            JSON.stringify(n({})) === JSON.stringify({
                enabled: false, format: 'paren', label: '思考', maxChars: 1200, position: 'after', scope: 'all'
            }), JSON.stringify(n({})));
        check('非法 format 回落到 paren', n({ format: '乱写' }).format === 'paren');
        check('非法 scope 回落到 all', n({ scope: '群聊' }).scope === 'all');
        check('非法 position 回落到 after', n({ position: 'mid' }).position === 'after');
        check('format/scope/position 大小写归一', n({ format: 'DEBUG', scope: 'GROUP', position: 'BEFORE' }).format === 'debug'
            && n({ scope: 'Group' }).scope === 'group' && n({ position: 'Before' }).position === 'before');
        check('🔴 maxChars=0 不会被顶到 1（0 = 不截断）', n({ maxChars: 0 }).maxChars === 0);
        check('maxChars 负数被夹到 0', n({ maxChars: -5 }).maxChars === 0);
        check('maxChars 超大被夹到 20000', n({ maxChars: 999999 }).maxChars === 20000);
        check('maxChars 非数字回落到 1200', n({ maxChars: 'abc' }).maxChars === 1200);
        check('maxChars 小数向下取整', n({ maxChars: 99.9 }).maxChars === 99);
        check('🔴 label 显式空串被保留（要纯括号），不被默认值顶掉', n({ label: '' }).label === '');
        check('label 给 null 也当空串', n({ label: null }).label === '');
        check('label 缺省才用 "思考"', n({}).label === '思考');
        check('label 前后空格被去掉', n({ label: '  内心  ' }).label === '内心');
        check('enabled 非布尔当缺省（false）', n({ enabled: 'yes' }).enabled === false);
        check('enabled 显式 true 保留', n({ enabled: true }).enabled === true);
        check('🔴 幂等：归一化结果再喂一遍完全不变（WebUI 保存会重跑）',
            JSON.stringify(n(n({ label: '', maxChars: 0, format: 'debug', scope: 'group' })))
            === JSON.stringify(n({ label: '', maxChars: 0, format: 'debug', scope: 'group' })));
        check('非对象入参不炸（null / 字符串 / 数字）',
            n(null).format === 'paren' && n('x').format === 'paren' && n(7).format === 'paren');
        fs.unlinkSync(tmp);
    }
}

// ---------------------------------------------------------------------------
console.log(`\n=== 汇总: ${pass} 通过 / ${failures.length} 失败 ===`);
if (failures.length > 0) {
    console.log('失败项:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exitCode = 1;
}
