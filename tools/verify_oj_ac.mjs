/**
 * verify_oj_ac.mjs
 * ---------------------------------------------------------------------------
 * 验证「OJ AC 播报」。分三段，其中 **Part 3 真的连线上 OJ**（只读、不发 QQ），
 * 因为这一段最容易出假阳性：接口形状/字段名/status 取值任一变了，纯 mock 全绿也没用。
 *
 * 用法:  node verify_oj_ac.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MIMIR = 'C:/Users/20633/MimirLink';
const SRC = `${MIMIR}/src`;
const IDX_SRC = fs.readFileSync(`${SRC}/index.js`, 'utf8');
const cfg = JSON.parse(fs.readFileSync(`${MIMIR}/config.json`, 'utf8'));

const M = await import(pathToFileURL(`${SRC}/oj-ac.js`).href);

let pass = 0;
const failures = [];
function check(label, condition, extra = '') {
    if (condition) { pass += 1; console.log(`  [OK  ] ${label}`); }
    else { failures.push(label); console.log(`  [FAIL] ${label}${extra ? '  ' + extra : ''}`); }
}

// ─────────────────────────────────────────────────────────── Part 1: 纯函数
console.log('=== Part 1: 纯函数 ===');

const inherited = M.normalizeOjAcConfig(cfg.ojAc, cfg.ojFeedback);
check('enabled 读到', inherited.enabled === true);
check('notifyGroups 读到', inherited.notifyGroups.includes('929159193'), JSON.stringify(inherited.notifyGroups));
check('baseUrl 从 ojFeedback 继承', inherited.baseUrl === cfg.ojFeedback.baseUrl && !!inherited.baseUrl);
check('username 继承', inherited.username === cfg.ojFeedback.username);
check('password 继承（不打印）', inherited.password === cfg.ojFeedback.password && inherited.password.length > 0);
check('ojAc 自己配了值就用自己的', M.normalizeOjAcConfig({ baseUrl: 'https://x.test' }, { baseUrl: 'https://y.test' }).baseUrl === 'https://x.test');

const item = M.normalizeSubmissionItem({
    id: 999, problem_no: '12', problem_title: '标题', username: 'u', language: 'c++17',
    status: 'AC', time_used_ms: 30, memory_used_kb: 2048, score: 100, created_at: '2026-10-12T13:03:07+00:00'
});
check('status 归一化成小写', item.status === 'ac');
check('id<=0 返回 null（脏数据不进队列）', M.normalizeSubmissionItem({ id: 0 }) === null);

const pool = [
    { id: 5, status: 'ac' },
    { id: 4, status: 'wa' },
    { id: 3, status: 'ac' },
    { id: 2, status: 'ac' },
    { id: 1, status: 'wa' }
];
const sel = M.selectNewAc(pool, 2, 5);
check('只挑 ac（wa 被过滤）', sel.every((i) => i.status === 'ac'));
check('只挑比 lastSeenId 新的', sel.every((i) => i.id > 2));
check('按 id 升序（旧的先发）', JSON.stringify(sel.map((i) => i.id)) === '[3,5]', JSON.stringify(sel.map((i) => i.id)));
check('maxPerPoll 截断（取最早的几条）', M.selectNewAc(pool, 0, 2).map((i) => i.id).join(',') === '2,3');
check('游标取本轮最大 id', M.maxSubmissionId(pool) === 5);

const notice = M.buildAcNotice({
    id: 1731, username: 'Clement', problemNo: '28', problemTitle: '语文成绩 (easy version)',
    language: 'c++17', timeUsedMs: 32, memoryUsedKb: 1228, score: 100,
    createdAt: '2026-10-12T13:03:07+00:00'
}, { baseUrl: 'https://47.109.76.66:3002' });
// 2026-10-13 用户澄清：「我只是想让你把最后一句话从鼓励里面调用一句，而不是直接改格式」
//   ⇒ 格式保持原样（【】头 + `·` 罗列，含耗时/内存），只把**末句**做成从 AC_PRAISE 池里取。
//   ⚠ 我中间一度把整个格式重做了（去标签/去 ·/去内存）—— 那是做多了，已回滚。
check('格式保持原样：有【OJ AC #】头', notice.includes('【OJ AC #1731】'));
check('格式保持原样：有 · 罗列', notice.includes(' · '));
check('格式保持原样：带语言', /c\+\+17/.test(notice));
check('格式保持原样：带耗时', notice.includes('32ms'));
check('格式保持原样：带内存', /1\.2MB/.test(notice));
check('含用户名', notice.includes('Clement'));
check('含题号与标题', notice.includes('#28') && notice.includes('语文成绩'));
check('含详情链接', notice.includes('https://47.109.76.66:3002/submissions/1731'));

// 末句 = 从鼓励池里调一句
check('末句来自 AC_PRAISE 池', M.AC_PRAISE.includes(notice.trimEnd().split('\n').slice(-1)[0]), notice.split('\n').slice(-1)[0]);
check('末句在链接**下面**（最后一行）', notice.trimEnd().split('\n').slice(-1)[0] === M.pickAcPraise(1731));
check('池子够大（>=20 句，反复见同几句本身才"人机"）', M.AC_PRAISE.length >= 20, 'size=' + M.AC_PRAISE.length);
// 2026-10-13 用户：「你现在夸得也好怪，可以随便说点话就是」⇒ 这一句是**随口一句**，不是"夸"。
// 钉住"短"这个性质，防止以后又漂回"用力夸"。
check('末句是随口一句：都在 8 字以内', M.AC_PRAISE.every((p) => p.length <= 8),
    '最长=' + M.AC_PRAISE.reduce((a, b) => (a.length >= b.length ? a : b)));
check('末句不捧人（不含"厉害/佩服/崇拜"这类用力词）',
    !M.AC_PRAISE.some((p) => /厉害|佩服|崇拜|大神|膜/.test(p)));
check('不同提交会换末句', new Set([1731, 1732, 1733, 1734, 1735, 1736].map(M.pickAcPraise)).size >= 5);
check('同一条提交的末句稳定（at-least-once 重发不会换句）',
    M.pickAcPraise(1731) === M.pickAcPraise(1731));
check('praise:false 可关掉末句', !M.buildAcNotice({ id: 1, username: 'x' }, { praise: false })
    .includes(M.pickAcPraise(1)));
check('praise 传字符串可替换末句', M.buildAcNotice({ id: 1, username: 'x' }, { praise: '自定义' })
    .trimEnd().endsWith('自定义'));

// ─────────────────────────────────────── Part 3: 真连 OJ（只读，不发 QQ）
console.log('\n=== Part 3: 真连线上 OJ（只读；不往 QQ 发）===');
const tmpState = path.join(os.tmpdir(), `oj-ac-verify-${Date.now()}.json`);
try {
    // 先探一次拿到当前最大 id，好把游标故意往回拨一点，制造"有新的 AC"
    const probe = new M.OjAcPoller({
        getConfig: () => cfg.ojAc,
        getFallbackConfig: () => cfg.ojFeedback,
        logger: { info() {}, warn() {} },
        stateFile: tmpState,
        onNewAc: () => {}
    });
    const payload = await probe.requestJson('/api/submissions?limit=20');
    const items = M.parseSubmissionList(payload);
    check('登录 + 取列表成功', items.length > 0, `拿到 ${items.length} 条`);
    check('字段名与实测一致（problem_no/status/username）',
        typeof items[0].problemNo === 'string' && typeof items[0].status === 'string' && !!items[0].username,
        JSON.stringify(items[0]).slice(0, 140));

    const maxId = M.maxSubmissionId(items);
    const acCount = items.filter((i) => i.status === 'ac').length;
    console.log(`  （本页 ${items.length} 条，最大 id=${maxId}，其中 ac ${acCount} 条）`);

    // 把游标往回拨 40，保证一定有"新的 AC"可播
    fs.writeFileSync(tmpState, JSON.stringify({ lastSeenId: Math.max(0, maxId - 40) }), 'utf8');
    const captured = [];
    const poller = new M.OjAcPoller({
        getConfig: () => cfg.ojAc,
        getFallbackConfig: () => cfg.ojFeedback,
        logger: { info() {}, warn() {} },
        stateFile: tmpState,
        onNewAc: (it) => { captured.push(it); }
    });
    const res = await poller.pollOnce();
    check('pollOnce 跑通', res && !res.skipped, JSON.stringify(res));
    check('挑出的全是 ac', captured.every((i) => i.status === 'ac'));
    check('真的挑出了 AC（说明 status 取值没变）', captured.length > 0, `本轮 ${captured.length} 条`);
    check('数量不超过 maxPerPoll', captured.length <= cfg.ojAc.maxPerPoll);
    console.log('  本轮将播报:');
    for (const it of captured) {
        console.log('    · ' + M.buildAcNotice(it, { baseUrl: cfg.ojFeedback.baseUrl }).split('\n').slice(0, 3).join(' | '));
    }

    const st = JSON.parse(fs.readFileSync(tmpState, 'utf8'));
    check('游标推进到本轮最大 id（不是最后一条 AC 的 id）', st.lastSeenId === maxId, `state=${st.lastSeenId} max=${maxId}`);

    // 再跑一次应当 0 条（游标已推进 ⇒ 幂等，不会重复播）
    const again = [];
    const p2 = new M.OjAcPoller({
        getConfig: () => cfg.ojAc,
        getFallbackConfig: () => cfg.ojFeedback,
        logger: { info() {}, warn() {} },
        stateFile: tmpState,
        onNewAc: (it) => { again.push(it); }
    });
    await p2.pollOnce();
    check('连跑第二次不重复播（游标幂等）', again.length === 0, `第二次仍播了 ${again.length} 条`);

    // ── 可见性闸门：对着**线上真实数据**断言隐藏题不在可播集合里（2026-10-12 用户报的 bug）
    const gate = new M.OjAcPoller({
        getConfig: () => cfg.ojAc,
        getFallbackConfig: () => cfg.ojFeedback,
        logger: { info() {}, warn() {} },
        stateFile: tmpState,
        onNewAc: () => {}
    });
    const visible = await gate.getVisibleProblemIds();
    check('拿到可播题目集合', visible instanceof Set && visible.size > 0, `size=${visible.size}`);
    // 117–124 = 比赛 5（upcoming, 10-25 开赛）的题，属"同学看不到"⇒ 必须在集合外
    const hid = [117, 118, 119, 120, 121, 122, 123, 124];
    const leaked = hid.filter((id) => visible.has(id));
    check('🔴 隐藏题(117-124)不在可播集合里（这正是被播出去的那类）',
        leaked.length === 0, `漏了 ${leaked.join(',')}`);
    // 反例保护：公开题必须在集合里，否则"全拦"也能蒙过上面的断言
    check('公开题在集合里（防止"全拦"造成假通过）', visible.has(125), '题125 阶梯三角形');
    check('可播集合规模接近公开题总数(92)', visible.size >= 80, `size=${visible.size}`);
    fs.writeFileSync(tmpState, JSON.stringify({ lastSeenId: Math.max(0, maxId - 40) }), 'utf8');
    const p3 = new M.OjAcPoller({
        getConfig: () => cfg.ojAc,
        getFallbackConfig: () => cfg.ojFeedback,
        logger: { info() {}, warn() {} },
        stateFile: tmpState,
        onNewAc: () => { throw new Error('模拟 NapCat 掉线'); }
    });
    const r3 = await p3.pollOnce();
    const st3 = JSON.parse(fs.readFileSync(tmpState, 'utf8'));
    check('发送全失败时游标停在失败点之前（不丢事件）',
        r3.failed > 0 && st3.lastSeenId < maxId, `state=${st3.lastSeenId} max=${maxId} failed=${r3.failed}`);
    // 正确语义：游标应停在**本轮第一条被播的 AC 之前** ⇒ 那批下轮会被重新取到
    const firstId = captured.length > 0 ? captured[0].id : null;
    check('失败后下轮能重新拿到同一批（at-least-once）',
        firstId !== null && st3.lastSeenId === firstId - 1,
        `state=${st3.lastSeenId} 期望=${firstId === null ? 'n/a' : firstId - 1}`);
} catch (error) {
    check('真连 OJ 成功', false, error.message);
} finally {
    try { fs.unlinkSync(tmpState); } catch {}
}

console.log(`\n=== 汇总: ${pass} 通过 / ${failures.length} 失败 ===`);
if (failures.length) {
    console.log('失败项:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
}
