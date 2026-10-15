/**
 * verify_oj_feedback.mjs
 * ---------------------------------------------------------------------------
 * 验证「OJ 反馈轮询 + 转发」。
 *
 * 起因（2026-10-11）：用户要「让爱音把 OJ 的反馈转过来（原文 + 她补一句），
 * 邮箱那个每分钟轮询一次」。查完服务器后确认 OJ 早有现成接口
 * `GET /api/admin/feedback`（`require_admin`），所以走"本机主动拉"，
 * 不需要任何入站可达性。
 *
 * 这个脚本分四段，其中 Part 3 **真的连线上 OJ**（只读），
 * 因为这一段最容易出假阳性：接口形状/鉴权/证书任一变了，纯 mock 测试全绿也没用。
 *
 * 用法:  node verify_oj_feedback.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
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

const OJ = await import(pathToFileURL(`${SRC}/oj-feedback.js`).href);

// ---------------------------------------------------------------------------
console.log('=== Part 1  配置归一化 ===');

const n = OJ.normalizeOjFeedbackConfig;
check('空对象 ⇒ 默认关（保守默认，不能因为默认值就把线上打开）',
    n({}).enabled === false);
check('baseUrl 去掉尾部斜杠', n({ baseUrl: 'https://x.example/' }).baseUrl === 'https://x.example');
check('intervalMs 有下限（低于 15s 会变成打接口）', n({ intervalMs: 100 }).intervalMs === 15000);
check('intervalMs 有上限（1 小时）', n({ intervalMs: 999999999 }).intervalMs === 3600000);
check('intervalMs 非数字回落到 60s', n({ intervalMs: 'abc' }).intervalMs === 60000);
check('群号统一成字符串（OneBot 那边可能是 number）',
    JSON.stringify(n({ notifyGroups: [929159193, '1045582694'] }).notifyGroups) === '["929159193","1045582694"]');
check('群号去重', n({ notifyGroups: ['1', 1, '123456789'] }).notifyGroups.length === 1);
check('非数字群号被丢掉（防止把空串当群号发出去）',
    JSON.stringify(n({ notifyGroups: ['', 'abc', null] }).notifyGroups) === '[]');
check('maxPerPoll 夹在 1..50', n({ maxPerPoll: 0 }).maxPerPoll === 1 && n({ maxPerPoll: 999 }).maxPerPoll === 50);
check('maxContentChars 有上下限',
    n({ maxContentChars: 1 }).maxContentChars === 100 && n({ maxContentChars: 99999 }).maxContentChars === 5000);
check('password 保持原样（含特殊字符不能被 trim 掉）',
    n({ password: ' a b ' }).password === ' a b ');
check('幂等：归一化结果再喂一遍不变',
    JSON.stringify(n(n({ intervalMs: 30000, notifyGroups: [1, '2'], enabled: true })))
    === JSON.stringify(n({ intervalMs: 30000, notifyGroups: [1, '2'], enabled: true })));
check('非对象入参不炸', n(null).baseUrl === OJ.OJ_FEEDBACK_DEFAULTS.baseUrl && n('x').enabled === false);

// ---------------------------------------------------------------------------
console.log('\n=== Part 2  解析 / 游标 / 排版 ===');

const ITEM = {
    id: 7, user_id: 4, username: 'Yuno', kind: 'suggestion',
    content: '题单不能改变题目排列顺序\n希望能按题目名字检索',
    page_url: 'https://47.109.76.66:3002/', contact: '123@qq.com',
    status: 'open', created_at: '2026-10-11T12:42:25+00:00'
};
const norm = OJ.normalizeFeedbackItem(ITEM);
check('字段名转成驼峰（后面不用再猜）',
    norm.userId === 4 && norm.pageUrl.endsWith('/') && norm.contact === '123@qq.com');
check('kind 转小写', OJ.normalizeFeedbackItem({ id: 1, kind: 'BUG' }).kind === 'bug');
check('没有 id 的条目返回 null（不能把 undefined 当一条发出去）',
    OJ.normalizeFeedbackItem({ content: 'x' }) === null && OJ.normalizeFeedbackItem({ id: 0 }) === null);
check('username 缺失时给占位而不是空串',
    OJ.normalizeFeedbackItem({ id: 1 }).username === '匿名');
check('默认 status=open', OJ.normalizeFeedbackItem({ id: 1 }).status === 'open');
check('items 不是数组时返回 0 条（接口换形状时不炸）',
    OJ.parseFeedbackList({}).length === 0 && OJ.parseFeedbackList(null).length === 0);
check('只保留合法条目', OJ.parseFeedbackList({ items: [ITEM, { no: 'id' }] }).length === 1);

check('kind 中文标签', OJ.ojKindLabel('suggestion') === '建议' && OJ.ojKindLabel('bug') === '错误');
check('未知 kind 给"反馈"而不是 undefined', OJ.ojKindLabel('other') === '反馈');

const sel = OJ.selectNewFeedback([{ id: 3 }, { id: 9 }, { id: 5 }], 4, 5);
check('挑出 id > 游标 的条目', sel.pending.map((i) => i.id).join(',') === '5,9');
check('游标推进到**所有**条目里的最大 id',
    sel.newestId === 9);
check('resolved 的不发但推进游标', (() => {
    const r = OJ.selectNewFeedback([{ id: 10, status: 'resolved' }, { id: 11, status: 'open' }], 5, 5);
    return r.pending.map((i) => i.id).join(',') === '11' && r.skippedResolved === 1 && r.newestId === 11;
})());
check('maxPerPoll 截断并给出 deferred（下一轮继续，不是丢）', (() => {
    const r = OJ.selectNewFeedback([{ id: 1 }, { id: 2 }, { id: 3 }], 0, 2);
    return r.pending.length === 2 && r.deferred === 1;
})());
check('🔴 截断时 cursorId 只走到最后一条发出的（按 newestId 走会把没发的永久跳过）', (() => {
    const r = OJ.selectNewFeedback([{ id: 1 }, { id: 2 }, { id: 3 }], 0, 2);
    return r.cursorId === 2 && r.newestId === 3;
})());
check('没截断时 cursorId 走到最大 id（含被跳过的已处理条目）', (() => {
    const r = OJ.selectNewFeedback([{ id: 8, status: 'resolved' }, { id: 9 }], 0, 5);
    return r.cursorId === 9 && r.pending.map((i) => i.id).join(',') === '9';
})());
check('没有新条目时 pending 空、游标不动',
    (() => { const r = OJ.selectNewFeedback([{ id: 2 }], 5, 5); return r.pending.length === 0 && r.cursorId === 5; })());

check('UTC ISO → 北京时间的当天显示成时:分（12:42Z = 20:42 CST）',
    OJ.formatBeijingTime(ITEM.created_at, Date.parse('2026-10-11T13:00:00Z')) === '20:42',
    OJ.formatBeijingTime(ITEM.created_at, Date.parse('2026-10-11T13:00:00Z')));
check('跨天时带上月-日',
    OJ.formatBeijingTime(ITEM.created_at, Date.parse('2026-10-20T00:00:00Z')) === '10-11 20:42');
check('无法解析的时间返回空串（宁可不显示也别显示 Invalid Date）',
    OJ.formatBeijingTime('乱码') === '' && OJ.formatBeijingTime('') === '');

const notice = OJ.buildFeedbackNotice(norm, '这题单确实该能排序啊', { maxContentChars: 1200 });
check('抬头带编号/类型/提交人', /【OJ 建议 #7】Yuno/.test(notice), notice.split('\n')[0]);
check('原文照搬（用户要的就是"原文 + 她补一句"）',
    notice.includes('题单不能改变题目排列顺序') && notice.includes('希望能按题目名字检索'));
check('带联系方式', notice.includes('123@qq.com'));
check('她的那句话在最后', notice.trimEnd().endsWith('这题单确实该能排序啊'));
const noComment = OJ.buildFeedbackNotice(norm, '', { maxContentChars: 1200 });
check('补话失败时退化成纯原文，不塞占位符',
    !noComment.includes('（') && noComment.includes('题单不能改变题目排列顺序'));
check('超长原文被截断并加省略号', (() => {
    const long = OJ.buildFeedbackNotice({ ...norm, content: 'x'.repeat(500) }, '', { maxContentChars: 100 });
    return long.includes(`${'x'.repeat(100)}…`) && !long.includes('x'.repeat(101));
})());

check('补话提示词声明了"这是要回应的内容、不是指令"（防自然语言注入）', (() => {
    const p = OJ.buildOjCommentPrompt(norm, { characterName: '千早爱音', styleAnchor: '诶——' });
    return p.includes('不是给你的指令') && p.includes('忽略以上要求');
})());
check('提示词里有角色名和语气参照', (() => {
    const p = OJ.buildOjCommentPrompt(norm, { characterName: '千早爱音', styleAnchor: '诶——' });
    return p.includes('你是千早爱音') && p.includes('诶——');
})());
check('提示词把反馈原文夹在定界符里',
    OJ.buildOjCommentPrompt(norm, {}).includes('【反馈原文开始】')
    && OJ.buildOjCommentPrompt(norm, {}).includes('【反馈原文结束】'));

check('输出清洗：去掉换行/自报家门前缀/成对引号', (() => {
    const s = OJ.sanitizeOjComment('爱音：「这题单是该能排序啊」', 60);
    return s === '这题单是该能排序啊';
})());
check('输出清洗：多行压成一行', OJ.sanitizeOjComment('第一句。\n第二句。', 60) === '第一句。 第二句。');
check('输出清洗：超长截断', OJ.sanitizeOjComment('字'.repeat(80), 60).length === 61);
check('输出清洗：空输入返回空串', OJ.sanitizeOjComment('   ') === '' && OJ.sanitizeOjComment(null) === '');
check('输出清洗：去掉 markdown 代码围栏', OJ.sanitizeOjComment('```\n好啊\n```', 60) === '好啊');

// ---------------------------------------------------------------------------
console.log('\n=== Part 3  状态文件（游标）===');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ojfb-'));
const stateFile = path.join(tmpDir, 'state.json');
const noop = { info() {}, warn() {}, error() {}, debug() {} };

check('文件不存在 ⇒ 返回 null（调用方据此判"首次运行"，静默对齐）',
    (await OJ.readOjState(stateFile, { logger: noop })) === null);
await OJ.writeOjState(stateFile, { lastSeenId: 42 }, { logger: noop });
const back = await OJ.readOjState(stateFile, { logger: noop });
check('写进去读得回来', back?.lastSeenId === 42 && !!back.updatedAt);
check('坏 JSON ⇒ 返回 null，不是 0（返回 0 会导致重启后把历史全发一遍）',
    await (async () => {
        await fs.promises.writeFile(stateFile, '{ 半截', 'utf8');
        return (await OJ.readOjState(stateFile, { logger: noop })) === null;
    })());
check('lastSeenId 为负/非数字时归零',
    await (async () => {
        await fs.promises.writeFile(stateFile, JSON.stringify({ lastSeenId: 'x' }), 'utf8');
        const s = await OJ.readOjState(stateFile, { logger: noop });
        return s.lastSeenId === 0;
    })());

// ---------------------------------------------------------------------------
console.log('\n=== Part 4  轮询器（mock fetch：首次静默 / 新增触发 / 401 重登 / 失败不推进游标）===');

function makePoller({ items = [], onLoginFail = false } = {}) {
    const calls = [];
    const notified = [];
    const state = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ojfb2-')), 'state.json');
    // ⚠ items 必须是**可变**的：首次运行会把游标对齐到当轮最大 id，
    //   用静态数组的话后续轮询永远看不到"新增"，测出来的全是假绿。
    const store = { items: [...items] };
    const fetchImpl = async (url, options = {}) => {
        calls.push({ url, method: options.method || 'GET', auth: options.headers?.Authorization || '' });
        if (url.includes('/api/auth/login')) {
            if (onLoginFail) {
                return { ok: false, status: 401, text: async () => 'bad creds' };
            }
            return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'TOK1', user_id: 104, username: 'Chihaya_Anon' }) };
        }
        if (options.headers?.Authorization !== 'Bearer TOK1') {
            return { ok: false, status: 401, text: async () => 'expired' };
        }
        return {
            ok: true, status: 200,
            text: async () => JSON.stringify({
                items: store.items, total: store.items.length,
                counts: { open: store.items.filter((i) => i.status !== 'resolved').length }
            })
        };
    };
    const poller = new OJ.OjFeedbackPoller({
        getConfig: () => ({
            enabled: true, baseUrl: 'https://oj.example', username: 'Chaya', password: 'pw',
            intervalMs: 60000, notifyPrivate: true, notifyGroups: ['123456789']
        }),
        logger: noop,
        fetchImpl,
        stateFile: state,
        onNewFeedback: async (item) => { notified.push(item.id); }
    });
    return { poller, calls, notified, state, store };
}

const a = makePoller({ items: [{ id: 1, status: 'resolved' }, { id: 2, status: 'open' }] });
const firstRun = await a.poller.pollOnce();
check('首次运行：一条都不发（防上线即刷屏）', a.notified.length === 0 && firstRun.notified === 0);
check('首次运行把游标对齐到当前最大 id', firstRun.lastSeenId === 2 && firstRun.firstRun === true);
check('首次运行的状态已落盘', JSON.parse(fs.readFileSync(a.state, 'utf8')).lastSeenId === 2);
check('首次运行只打了一次登录 + 一次列表（同一轮不该打两次接口）',
    a.calls.filter((c) => c.url.includes('/api/auth/login')).length === 1
    && a.calls.filter((c) => c.url.includes('/api/admin/feedback')).length === 1,
    JSON.stringify(a.calls.map((c) => c.url)));

const b = makePoller({ items: [{ id: 2, status: 'open' }] });
await b.poller.pollOnce();                 // 首次：游标对齐到 2
b.store.items.push({ id: 3, status: 'open' });   // 来了一条新的
const secondPoll = await b.poller.pollOnce();
check('后续轮询只发新的那条', JSON.stringify(b.notified) === '[3]', JSON.stringify(b.notified));
check('已发过的不会重发', b.notified.length === 1);
check('游标推进到 3', secondPoll.lastSeenId === 3);

// resolved 的不打扰，但游标要跟着走
const br = makePoller({ items: [{ id: 2 }] });
await br.poller.pollOnce();
br.store.items.push({ id: 4, status: 'resolved' });
const rResolved = await br.poller.pollOnce();
check('新来的已处理条目不通知（但游标推进，不会下轮再考虑）',
    br.notified.length === 0 && rResolved.lastSeenId === 4, `notified=${JSON.stringify(br.notified)}`);

// 游标持久化后重启：不该重发
const c = makePoller({ items: [{ id: 3, status: 'open' }] });
await c.poller.pollOnce();          // 首次运行：对齐到 3
const afterRestart = await c.poller.pollOnce();
check('重启后不会把已有的重发一遍', c.notified.length === 0 && afterRestart.lastSeenId === 3);

// 401 → 自动重登一次
const d = makePoller({ items: [] });
d.poller.accessToken = 'STALE';
const r401 = await d.poller.pollOnce();
check('token 过期时自动重登并重试（不用人工干预）',
    r401.ok === true && d.calls.filter((c) => c.url.includes('/api/auth/login')).length === 1,
    JSON.stringify(d.calls.map((c) => c.url)));

// 登录失败 → 不抛错、只记数
const e = makePoller({ items: [], onLoginFail: true });
const rFail = await e.poller.pollOnce();
check('登录失败不抛错（调度器不能被单次失败打断）', rFail.ok === false && !!rFail.error);
check('失败计数 +1 且记下原因', e.poller.failureCount === 1 && e.poller.lastError.includes('401'));

// 转发抛错 → 游标不推进（下一轮重试同一条，通知不会永久丢）
const g = makePoller({ items: [{ id: 5 }] });
await g.poller.pollOnce();                        // 首次：对齐到 5
g.store.items.push({ id: 6, status: 'open' });
g.poller.onNewFeedback = async (item) => { if (item.id === 6) throw new Error('群不在'); };
const failPoll = await g.poller.pollOnce();
check('🔴 转发失败时**不推进游标**（否则这条通知永久丢失）',
    JSON.parse(fs.readFileSync(g.state, 'utf8')).lastSeenId === 5,
    `state=${fs.readFileSync(g.state, 'utf8').replace(/\s+/g, '')}`);
check('转发失败时本轮返回 ok=false', failPoll.ok === false && failPoll.notified === 0);
g.poller.onNewFeedback = async (item) => { g.notified.push(item.id); };
const retryPoll = await g.poller.pollOnce();
check('下一轮把同一条重发成功', JSON.stringify(g.notified) === '[6]' && retryPoll.lastSeenId === 6,
    JSON.stringify(g.notified));
check('重发成功后游标才推进',
    JSON.parse(fs.readFileSync(g.state, 'utf8')).lastSeenId === 6);

// 一次多条 → 最多发 maxPerPoll 条，剩下的下轮继续
const h = makePoller({ items: [{ id: 1 }] });
await h.poller.pollOnce();
h.store.items.push({ id: 2 }, { id: 3 }, { id: 4 });
h.poller.getConfig = () => ({
    enabled: true, baseUrl: 'https://oj.example', username: 'a', password: 'b',
    intervalMs: 60000, maxPerPoll: 2, notifyGroups: []
});
const capped = await h.poller.pollOnce();
check('maxPerPoll 截断（不是丢，剩下那条留到下一轮）',
    capped.notified === 2 && h.notified.length === 2, `notified=${JSON.stringify(h.notified)}`);
check('被截断时游标只推进到已处理的那条',
    capped.lastSeenId === 3, `cursor=${capped.lastSeenId}`);
const rest = await h.poller.pollOnce();
check('下一轮把剩下的补上', JSON.stringify(h.notified) === '[2,3,4]' && rest.lastSeenId === 4,
    JSON.stringify(h.notified));

const desc = h.poller.describe();
check('describe() 给出状态指令要用的字段',
    desc.enabled === true && desc.lastSeenId === 4 && Array.isArray(desc.notifyGroups)
    && typeof desc.ago === 'function' && desc.ago(0) === '从未');

// ---------------------------------------------------------------------------
console.log('\n=== Part 5  `/反馈` 指令句柄 ===');

function fakePoller({ notify = 0, ok = true } = {}) {
    return {
        describe: () => ({
            enabled: true, running: true, baseUrl: 'https://oj.example',
            username: 'Chihaya_Anon', intervalMs: 60000, lastSeenId: 7,
            initialized: true, lastPollAt: Date.now() - 5000, lastSuccessAt: Date.now() - 5000,
            lastError: '', failureCount: 0,
            stats: { polls: 3, delivered: 9, failed: 0 },
            notifyPrivate: true, notifyGroups: ['929159193'],
            ago: (ts) => (ts ? '5s 前' : '从未')
        }),
        pollNow: async () => (ok
            ? { ok: true, notified: notify, lastSeenId: 9 }
            : { ok: false, notified: 0, lastSeenId: 7, error: 'HTTP 500' })
    };
}

async function runCmd({ plainText = '/反馈', enabled = true, isAdmin = true, poller = fakePoller() } = {}) {
    const sent = [];
    const res = await OJ.executeOjFeedbackCommand({
        event: { user_id: 2063362809, message_type: 'private' },
        plainText,
        command: '/反馈',
        enabled,
        isAdmin,
        poller,
        onCommandAccepted: () => {},
        sendStatusMessage: (m) => sent.push(m),
        sendFailureMessage: (m) => sent.push('FAIL:' + m),
        logger: noop
    });
    return { res, sent };
}

check('非 /反馈 的文本不接管', (await runCmd({ plainText: '你好' })).res.handled === false);
check('开关关了不接管', (await runCmd({ enabled: false })).res.handled === false);
check('/反馈x 不算指令（不误伤普通发言）', (await runCmd({ plainText: '/反馈x' })).res.handled === false);
const notAdmin = await runCmd({ isAdmin: false });
check('🔴 非管理员被挡并给出提示（不是静默吞掉）',
    notAdmin.res.handled === true && notAdmin.sent[0].startsWith('FAIL:'), JSON.stringify(notAdmin.sent));
const noPoller = await runCmd({ poller: null });
check('轮询器没初始化时明确报错', noPoller.sent[0].startsWith('FAIL:'), JSON.stringify(noPoller.sent));

const status = await runCmd({});
check('不带参数 ⇒ 输出状态', status.sent.length === 1 && /OJ 反馈轮询：开/.test(status.sent[0]));
check('状态里有游标', status.sent[0].includes('#7'));
check('状态里有接口 / 账号 / 间隔', status.sent[0].includes('https://oj.example')
    && status.sent[0].includes('Chihaya_Anon') && status.sent[0].includes('60s'));
check('状态里有通知目标', status.sent[0].includes('私聊=发') && status.sent[0].includes('929159193'));
check('状态里有累计计数', status.sent[0].includes('轮询 3 次') && status.sent[0].includes('转发 9 条'));
check('没有错误时不显示"最近错误"行', !status.sent[0].includes('最近错误'));
const statusErr = await runCmd({
    poller: { ...fakePoller(), describe: () => ({ ...fakePoller().describe(), lastError: 'HTTP 401' }) }
});
check('有错误时把原因显示出来', statusErr.sent[0].includes('最近错误：HTTP 401'));

const pull = await runCmd({ plainText: '/反馈 拉' });
check('/反馈 拉 ⇒ 立刻轮询并回报条数',
    pull.sent[0].includes('本轮转发 0 条') && pull.sent[0].includes('#9'), pull.sent[0]);
const pullFail = await runCmd({ plainText: '/反馈 拉', poller: fakePoller({ ok: false }) });
check('/反馈 拉 失败时报原因', pullFail.sent[0].includes('拉取失败') && pullFail.sent[0].includes('HTTP 500'));
check('大小写/空格容错（/反馈  拉）', (await runCmd({ plainText: '/反馈  拉' })).sent[0].includes('本轮转发'));

// ---------------------------------------------------------------------------
console.log('\n=== Part 6  真连线上 OJ（只读：登录 + 拉列表 + 排版真实数据）===');

const realCfgPath = `${MIMIR}/config.json`;
const realCfg = JSON.parse(fs.readFileSync(realCfgPath, 'utf8'));
const ojCfg = realCfg.ojFeedback || {};
console.log(`  （配置）baseUrl=${ojCfg.baseUrl} username=${ojCfg.username} `
    + `password长度=${(ojCfg.password || '').length} 群=${JSON.stringify(ojCfg.notifyGroups)}`);

if (!ojCfg.username || !ojCfg.password) {
    check('config.json 里有 OJ 账号密码', false, '没配就没法验');
} else {
    const live = new OJ.OjFeedbackPoller({
        getConfig: () => ({ ...ojCfg, enabled: true }),
        logger: noop,
        stateFile: path.join(tmpDir, 'live-state.json'),
        onNewFeedback: async () => { throw new Error('这一步不该发生通知'); }
    });
    try {
        const result = await live.pollNow();
        check('🔴 真登录 + 真拉取成功（HTTP 2xx，不是 mock）', result.ok === true, JSON.stringify(result));
        check('首次运行仍然是静默对齐（哪怕连着真库）',
            result.notified === 0 && live.lastSeenId >= 0, JSON.stringify(result));
        // 再拉一次：拿到真实条目来验排版
        await live.pollOnce();
        const { items, counts, total } = await live.fetchOpenFeedback();
        check('拿到真实条目数组', Array.isArray(items), typeof items);
        console.log(`  （线上）总反馈=${total} 待处理=${counts?.open} 已处理=${counts?.resolved}`);
        if (items.length > 0) {
            const sample = items[0];
            check('真实条目的字段都归一化成功',
                typeof sample.id === 'number' && !!sample.username && !!sample.kind && !!sample.content);
            const text = OJ.buildFeedbackNotice(sample, OJ.sanitizeOjComment('这确实得改', 60), {});
            check('用真实条目渲染出的通知符合"原文 + 她补一句"',
                text.includes(`【OJ ${OJ.ojKindLabel(sample.kind)} #${sample.id}】`)
                && text.includes(sample.content.slice(0, 10))
                && text.endsWith('这确实得改'), text.slice(0, 120));
            console.log('  ---- 实际会发出去的样子（示例）----');
            console.log(text.split('\n').map((l) => '  | ' + l).join('\n'));
            console.log('  ----------------------------------');
        }
    } catch (error) {
        check('🔴 真登录 + 真拉取成功（HTTP 2xx，不是 mock）', false, error?.message);
    }
}

// ---------------------------------------------------------------------------
console.log("\n=== Part 7  index.js / 配置接线 ===");

check('index.js 引入了 oj-feedback 模块', IDX_SRC.includes("from './oj-feedback.js'"));
check('启动时拉起轮询器', IDX_SRC.includes('startOjFeedbackPoller();'));
check('`/反馈` 挂进 dispatch 链', IDX_SRC.includes('await handleOjFeedbackCommand(event, commandInput)'));
check('`/反馈` 在 buildRoutingDecision 之前（不然会被触发规则吃掉）',
    IDX_SRC.indexOf('await handleOjFeedbackCommand(event, commandInput)')
    < IDX_SRC.indexOf('const routingDecision = buildRoutingDecision('));
check('配置归一化接上了', IDX_SRC.includes('config.ojFeedback = normalizeOjFeedbackConfig(config.ojFeedback);'));
check('状态文件按实例根解析（不是 cwd —— memory.storage.path 就栽在这）',
    IDX_SRC.includes('isAbsolute(cfg.stateFile) ? cfg.stateFile : join(ROOT_DIR, cfg.stateFile)'));
check('补话失败退化成只发原文', IDX_SRC.includes('补话失败，改为只发原文'));
check('全部目标发送失败时抛错（让游标不推进、下一轮重试）',
    IDX_SRC.includes('全部目标发送失败'));
check('没配通知目标时明确报错（不静默丢掉这条反馈）',
    IDX_SRC.includes('没有通知目标'));
check('补话走 LLM 且关思考（maxTokens 太小会被推理吃光）',
    IDX_SRC.includes("thinking: { type: 'disabled' }"));
check('私聊目标取 chat.adminUsers', IDX_SRC.includes('for (const admin of (config.chat?.adminUsers || []))'));

check('config.json: ojFeedback 打开且凭据齐全',
    ojCfg.enabled === true && !!ojCfg.username && !!ojCfg.password);
check('config.json: 通知群已配', Array.isArray(ojCfg.notifyGroups) && ojCfg.notifyGroups.length > 0);
check('🔴 config.json: chat.adminUsers 配上了（之前是空的 ⇒ 所有管理指令都对所有人返回"只有管理员"）',
    Array.isArray(realCfg.chat?.adminUsers) && realCfg.chat.adminUsers.length > 0,
    JSON.stringify(realCfg.chat?.adminUsers));
check('config.json: /反馈 指令已注册',
    realCfg.chat?.commands?.ojFeedback?.command === '/反馈');

for (const rel of ['configs/anon.json', 'config.example.json']) {
    const c = JSON.parse(fs.readFileSync(`${MIMIR}/${rel}`, 'utf8'));
    check(`🔴 ${rel}: 不带真凭据（这文件进 git，发布管线还会扫）`,
        (c.ojFeedback?.password || '') === '' && c.ojFeedback.enabled === false,
        JSON.stringify({ pwd: (c.ojFeedback?.password || '').length, enabled: c.ojFeedback?.enabled }));
    check(`${rel}: adminUsers 是空数组（别把管理 QQ 也发布出去）`,
        Array.isArray(c.chat?.adminUsers) && c.chat.adminUsers.length === 0);
    check(`${rel}: /反馈 指令占位在`, c.chat?.commands?.ojFeedback?.command === '/反馈');
}

// ---------------------------------------------------------------------------
console.log(`\n=== 汇总: ${pass} 通过 / ${failures.length} 失败 ===`);
if (failures.length > 0) {
    console.log('失败项:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exitCode = 1;
}
