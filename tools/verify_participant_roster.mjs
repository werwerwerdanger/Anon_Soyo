/**
 * verify_participant_roster.mjs
 * ---------------------------------------------------------------------------
 * 验证「身份名册」这条链路。刻意分成两层：
 *
 *   Part 1  单元层 —— 直接 import 线上那个模块（不是抄一份），用假行喂进去，
 *           覆盖解析/合并/过滤/渲染的边界。
 *   Part 2  端到端 —— 把**真实的 memory-store.sqlite 复制到临时目录**，
 *           用真实的 SessionManager 跑**真实的 SQL**，再用真实的 config.json
 *           打开开关，断言最终注入文本里认得出那个 QQ 号。
 *           复制是为了不往正在跑的那个库里写任何东西（SessionManager 会
 *           PRAGMA journal_mode=WAL 并 prepareSchema）。
 *
 * 关键断言（就是用户报的那个 bug）：
 *   名单里必须出现 `曲奇饼干全肯定bot(1000000005)` —— 她在另一个会话里
 *   刚聊过的人，之前那轮 prompt 里这个号出现 0 次。
 *
 * 用法:  node verify_participant_roster.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SRC = 'C:/Users/20633/MimirLink/src';
const CONFIG = 'C:/Users/20633/MimirLink/config.json';
const DB = 'C:/Users/20633/MimirLink/data/chats/memory-store.sqlite';

const roster = await import(pathToFileURL(`${SRC}/participant-roster.js`).href);
const { SessionManager } = await import(pathToFileURL(`${SRC}/session.js`).href);

// 源码只读一次，Part 2 / Part 5 共用（Part 5 是"装配点齐全"的回归闸门）
const IDX_SRC = fs.readFileSync(`${SRC}/index.js`, 'utf8');
const PRM_SRC = fs.readFileSync(`${SRC}/prompt.js`, 'utf8');
const SES_SRC = fs.readFileSync(`${SRC}/session.js`, 'utf8');
const CMF_SRC = fs.readFileSync(`${SRC}/current-message-focus.js`, 'utf8');

let pass = 0;
const failures = [];
function check(label, condition, extra = '') {
    if (condition) { pass += 1; console.log(`  [OK  ] ${label}`); }
    else { failures.push(label); console.log(`  [FAIL] ${label}${extra ? '  ' + extra : ''}`); }
}

const DAY = 24 * 60 * 60 * 1000;
// 固定一个"现在"，让时间断言可重复：2026-10-11 15:30 本地时间
const NOW = new Date(2026, 9, 11, 15, 30, 0).getTime();
const at = (h, m, dayOffset = 0) => new Date(2026, 9, 11 + dayOffset, h, m, 0).getTime();

// ---------------------------------------------------------------------------
console.log('=== Part 1  单元层（import 真实模块）===');

const REAL_HEADER = '[私聊|QQ:1000000005|昵称:曲奇饼干全肯定bot|群号:N/A|群名:N/A'
    + '|时间:2026/10/11 15:02:53|eventType:message|isAtBot:false'
    + '|messageSegments:[{"type":"text","text":"在吗"}]] 在吗';

const parsed = roster.parseContactFromMessage(REAL_HEADER);
check('parseContactFromMessage 取到 QQ', parsed?.participantId === '1000000005', JSON.stringify(parsed));
check('parseContactFromMessage 取到昵称（含括号内的 ] 不吃正文）',
    parsed?.name === '曲奇饼干全肯定bot', JSON.stringify(parsed));
check('parseContactFromMessage 对无头文本返回 null',
    roster.parseContactFromMessage('就是一句普通的话') === null);
// 主数据源现在是 `metadata_json.participants` 的元素（`昵称(QQ)`），不是正文头
check('parseContactToken 取普通昵称',
    JSON.stringify(roster.parseContactToken('明末美食家(3184426518)'))
    === JSON.stringify({ participantId: '3184426518', name: '明末美食家' }));
check('parseContactToken 昵称带空格/引号也能取',
    roster.parseContactToken('- 逆转「Reverse Hierarchy」 (961716628)')?.name === '- 逆转「Reverse Hierarchy」',
    JSON.stringify(roster.parseContactToken('- 逆转「Reverse Hierarchy」 (961716628)')));
check('parseContactToken 昵称里带全角括号不被切坏',
    roster.parseContactToken('摸术师（移动）(1115617951)')?.name === '摸术师（移动）',
    JSON.stringify(roster.parseContactToken('摸术师（移动）(1115617951)')));
check('parseContactToken 没有 QQ 时返回 null',
    roster.parseContactToken('没有 QQ 的怪东西') === null);
check('isPlausibleName 拦掉系统通知', roster.isPlausibleName('群主邀请了："猫娘"加入本群。') === false);
check('isPlausibleName 放过正常昵称', roster.isPlausibleName('平田七海') === true);
check('parseSessionKey 认私聊/群',
    roster.parseSessionKey('private:2063362809')?.kind === 'private'
    && roster.parseSessionKey('group:929159193')?.kind === 'group'
    && roster.parseSessionKey('nonsense') === null);

check('formatContactTime 今天', roster.formatContactTime(at(15, 13), NOW) === '今天 15:13',
    roster.formatContactTime(at(15, 13), NOW));
check('formatContactTime 昨天', roster.formatContactTime(at(21, 53, -1), NOW) === '昨天 21:53',
    roster.formatContactTime(at(21, 53, -1), NOW));
check('formatContactTime 更早用 月-日',
    roster.formatContactTime(at(13, 13, -2), NOW) === '10-09 13:13',
    roster.formatContactTime(at(13, 13, -2), NOW));
// 跨零点：今天 00:05 与昨天 23:55 只差 10 分钟，但必须分到"今天/昨天"
check('formatContactTime 跨零点按自然日算',
    roster.formatContactTime(at(0, 5), at(0, 15)) === '今天 00:05'
    && roster.formatContactTime(at(23, 55, -1), at(0, 15)) === '昨天 23:55');

// ⚠ 行的形状是「一个 会话×发言人」（session.js 的 listRecentContacts 用 json_each 平铺
// metadata_json.participants 得到），所以用 `who` 而不是 `content`。
// 第一版夹具写成 `[群聊|…|x` 缺 `]`（且用的是 content 形状），白报了 4 个假 FAIL。
const rows = [
    // 同一个人：私聊（更近）+ 群里（更早、当时叫 W）—— 必须合并成一条、不标（群）、
    // 且把 "W" 记成曾用名
    { session_id: 'private:2063362809', who: 'werwer(2063362809)', timestamp: at(15, 14), count: 95 },
    { session_id: 'group:1045582694', who: 'W(2063362809)', timestamp: at(14, 52, -1), count: 23 },
    { session_id: 'private:1000000005', who: '曲奇饼干全肯定bot(1000000005)', timestamp: at(15, 13), count: 18 },
    { session_id: 'group:929159193', who: '平田七海(3104405143)', timestamp: at(15, 20), count: 101 },
    // 超出 maxAgeDays
    { session_id: 'private:3628056487', who: 'soyo(3628056487)', timestamp: at(21, 53, -40), count: 6 },
    // 解析不到 QQ → 退回 session id
    { session_id: 'private:999999999', who: '没有 QQ 的怪东西', timestamp: at(12, 0), count: 3 },
    // 昵称字段被系统通知污染 → 名字丢掉、只留 QQ
    { session_id: 'group:929159193', who: '群主邀请了："猫娘"加入本群。(1000000001)', timestamp: at(0, 40), count: 4 }
];
const merged = roster.buildRosterEntries(rows, {
    config: { enabled: true, maxAgeDays: 30, maxEntries: 12, minMessages: 1, excludeIds: [] },
    now: NOW
});
const byId = Object.fromEntries(merged.map((e) => [e.participantId, e]));
check('合并同一人的私聊+群（werwer 只有一条）',
    merged.filter((e) => e.participantId === '2063362809').length === 1);
check('合并后标（群）跟着**最近一次**联系走 —— 最近是私聊 ⇒ 不标（群）',
    byId['2063362809']?.lastFromGroup === false, JSON.stringify(byId['2063362809']));
check('🔴 曾用名被收集（werwer 也叫 W，最近在前）',
    JSON.stringify(byId['2063362809']?.names) === JSON.stringify(['werwer', 'W']),
    JSON.stringify(byId['2063362809']?.names));
check('mergeNameHistory：新名插前面、去重、截断，通知文本不进历史',
    JSON.stringify(roster.mergeNameHistory('["werwer","W"]', 'werwer', 8)) === JSON.stringify(['werwer', 'W'])
    && JSON.stringify(roster.mergeNameHistory('[]', '新名', 8)) === JSON.stringify(['新名'])
    && JSON.stringify(roster.mergeNameHistory('["a","b","c"]', 'd', 3)) === JSON.stringify(['d', 'a', 'b'])
    && JSON.stringify(roster.mergeNameHistory('[]', '群主邀请了："猫娘"加入本群。', 8)) === JSON.stringify([]));
check('parseNameHistory 对坏数据返回空数组（不抛）',
    JSON.stringify(roster.parseNameHistory('not json')) === JSON.stringify([])
    && JSON.stringify(roster.parseNameHistory(null)) === JSON.stringify([])
    && JSON.stringify(roster.parseNameHistory(['x', ''])) === JSON.stringify(['x']));
check('只在群里出现的人 ⇒ 标（群）', byId['3104405143']?.lastFromGroup === true);
check('（群）标记真的落到文本上',
    roster.formatRosterEntry(byId['3104405143'], NOW).endsWith('（群）')
    && !roster.formatRosterEntry(byId['2063362809'], NOW).endsWith('（群）'));
check('曾用名落到文本上',
    roster.formatRosterEntry(byId['2063362809'], NOW) === 'werwer(2063362809)（也叫 W） — 今天 15:14',
    roster.formatRosterEntry(byId['2063362809'], NOW));
check('通知文本被丢掉、只留 QQ',
    byId['1000000001']?.name === '' && roster.formatRosterEntry(byId['1000000001'], NOW).startsWith('QQ 1000000001'),
    roster.formatRosterEntry(byId['1000000001'], NOW));
check('合并后取最近一次联系时间', byId['2063362809']?.lastTs === at(15, 14));
check('合并后消息数相加（95+23）', byId['2063362809']?.count === 118, String(byId['2063362809']?.count));
check('缺少 canParse 的 who 时退回 session id', !!byId['999999999']);
check('超龄条目被剔除（40 天前）', !byId['3628056487']);
check('按最后联系时间倒序',
    merged.map((e) => e.participantId).join(',') === '3104405143,2063362809,1000000005,999999999,1000000001',
    merged.map((e) => e.participantId).join(','));

check('excludeIds 生效',
    !roster.buildRosterEntries(rows, {
        config: { enabled: true, maxAgeDays: 30, excludeIds: ['1000000005'] }, now: NOW
    }).some((e) => e.participantId === '1000000005'));
check('minMessages 生效',
    roster.buildRosterEntries(rows, {
        config: { enabled: true, maxAgeDays: 30, minMessages: 50 }, now: NOW
    }).every((e) => e.count >= 50));
check('includeGroupMembers=false 时只留私聊',
    roster.buildRosterEntries(rows, {
        config: { enabled: true, maxAgeDays: 30, includeGroupMembers: false }, now: NOW
    }).every((e) => !String(e.sessionId || '').startsWith('group')));
check('maxEntries 截断',
    roster.buildRosterEntries(rows, {
        config: { enabled: true, maxAgeDays: 30, maxEntries: 2 }, now: NOW
    }).length === 2);

check('formatRosterEntry 形状',
    roster.formatRosterEntry(byId['1000000005'], NOW) === '曲奇饼干全肯定bot(1000000005) — 今天 15:13',
    roster.formatRosterEntry(byId['1000000005'], NOW));
check('没有昵称时退回 QQ <id>',
    roster.formatRosterEntry({ participantId: '123', lastTs: at(9, 2), name: '' }, NOW) === 'QQ 123 — 今天 09:02',
    roster.formatRosterEntry({ participantId: '123', lastTs: at(9, 2), name: '' }, NOW));

check('未启用返回空串',
    roster.buildParticipantRosterText({ listRecentContacts: () => rows }, { enabled: false }, { now: NOW }) === '');
check('没有联系人返回空串',
    roster.buildParticipantRosterText({ listRecentContacts: () => [] }, { enabled: true }, { now: NOW }) === '');
check('sessionManager 缺方法时返回空串（不炸）',
    roster.buildParticipantRosterText({}, { enabled: true }, { now: NOW }) === '');
check('listRecentContacts 抛错时返回空串（不拖垮回复）',
    roster.buildParticipantRosterText({ listRecentContacts: () => { throw new Error('boom'); } },
        { enabled: true }, { now: NOW }) === '');
const fakeText = roster.buildParticipantRosterText({ listRecentContacts: () => rows },
    { enabled: true, maxAgeDays: 30, maxEntries: 12 }, { now: NOW });
check('渲染文本含表头与免责那一行',
    fakeText.startsWith('【你最近联系过的人】')
    && fakeText.includes('只有昵称、QQ 号和最后联系时间'));
check('渲染文本点明"是 QQ 上的人/联系人名单"（实测不说她会去联网搜这个昵称）',
    fakeText.includes('都是你在 QQ 上聊过的人') && fakeText.includes('联系人名单'));
check('渲染文本说明"报数字/提昵称 = 名单里这个人"',
    fakeText.includes('说的就是名单里的这个人'));
check('渲染文本不含否定式 prim（不出现"别说不认识"这类）',
    !fakeText.includes('别说不认识') && !fakeText.includes('不要说不认识'));

// 🔴 回归闸门：只按"最近联系"截前 maxEntries 个，会让**被问到的那个人恰好排在下一位**
// 时静默消失（2026-10-11 实测：`曲奇饼干全肯定bot(1000000005)` 在 25 人里排第 14，
// maxEntries=12 把它截掉 ⇒ 用户问「1000000005 这个人怎么样」她答「真没印象」）。
// 现在详细之外的会压成「其他聊过的：」一行，所有人（到 maxListedTotal）都必须在列。
{
    const many = [];
    for (let i = 1; i <= 20; i += 1) {
        many.push({
            session_id: `private:1000000${String(i).padStart(2, '0')}`,
            who: `联系人${i}(1000000${String(i).padStart(2, '0')})`,
            timestamp: at(20, 59, 0) - i * 60000,   // 0 分钟 .. 19 分钟前，1 最近
            count: 1
        });
    }
    const manyText = roster.buildParticipantRosterText({ listRecentContacts: () => many },
        { enabled: true, maxEntries: 12, maxListedTotal: 40, maxAgeDays: 30 }, { now: NOW });
    // ⚠ 假 id 是 9 位（100000001..），别写成 \d{10} —— 第一版就是这么白报 FAIL 的
    const listed = new Set(manyText.match(/1000000\d{2}/g) || []);
    check('🔴 20 个人全部出现在名单里（第 13~20 名不再被静默截掉）',
        listed.size === 20, `只出现 ${listed.size} 个`);
    check('🔴 第 14 名（原本会被截掉的那个）确实在', manyText.includes('联系人14(100000014)'));
    check('详细条目仍是 12 个（带"今天 hh:mm"）',
        (manyText.match(/— 今天 \d\d:\d\d/g) || []).length === 12,
        String((manyText.match(/— 今天 \d\d:\d\d/g) || []).length));
    check('其余的进了「其他聊过的：」那一行',
        /其他聊过的：/.test(manyText) && manyText.includes('联系人13(100000013)'));
    check('紧凑行不重复放详细条目', (manyText.match(/联系人1\(/g) || []).length === 1);

    const capped = roster.buildParticipantRosterText({ listRecentContacts: () => many },
        { enabled: true, maxEntries: 12, maxListedTotal: 15, maxAgeDays: 30 }, { now: NOW });
    check('maxListedTotal 仍然是硬上限',
        new Set(capped.match(/1000000\d{2}/g) || []).size === 15,
        String(new Set(capped.match(/1000000\d{2}/g) || []).size));
}

// ---------------------------------------------------------------------------
console.log('\n=== Part 1b  提及检测（QQ / 昵称 / 曾用名）===');
{
    const mk = (id, name, names = []) => ({ participantId: id, name, names: [name, ...names].filter(Boolean) });
    const entries = [
        mk('1000000005', '曲奇饼干全肯定bot'),
        mk('2063362809', 'werwer', ['W']),
        mk('3104405143', '平田七海')
    ];
    const hit = (msg) => roster.findRosterMentions(entries, msg).map((e) => e.participantId);

    check('🔴 正文里的 QQ 号命中', hit('他qq号是这个1000000005').join(',') === '1000000005');
    check('🔴 正文里的昵称命中', hit('你觉得曲奇饼干全肯定bot怎么样').join(',') === '1000000005');
    check('曾用名也命中', hit('那个叫 W 的').join(',') === '2063362809');
    check('中性消息不命中', hit('今天天气不错').length === 0);
    check('空消息不命中', hit('').length === 0 && hit(null).length === 0);
    check('单字**中文**名不参与子串匹配（否则「一」「我」会命中几乎所有消息）',
        roster.findRosterMentions([mk('1', '一')], '一二三').length === 0);
    check('短 ASCII 名按词边界匹配（W 不会被 www 里的 w 命中）',
        roster.findRosterMentions([mk('2063362809', 'werwer', ['W'])], '这是 www.example.com').length === 0);
    check('短 ASCII 名大小写不敏感、独立成词时命中',
        roster.findRosterMentions([mk('2063362809', 'werwer', ['W'])], '那个 w 还在吗').length === 1);
    check('最多只点 2 个（注意行本来就短）',
        roster.findRosterMentions([mk('1111', '甲甲'), mk('2222', '乙乙'), mk('3333', '丙丙')],
            '甲甲 乙乙 丙丙', 2).length === 2);
    check('提示句里带上了 昵称(QQ)',
        roster.buildRosterMentionHint(entries, '曲奇饼干全肯定bot').includes('曲奇饼干全肯定bot(1000000005)'));
    check('提示句用肯定式（不出现"别去搜"这类否定式 priming）',
        !/别去搜|不要搜索|不要去查/.test(roster.buildRosterMentionHint(entries, '曲奇饼干全肯定bot')));
    check('没命中就返回空串（不该无条件注入）',
        roster.buildRosterMentionHint(entries, '今天天气不错') === '');
}

console.log('\n=== Part 2  端到端（真实 DB 副本 + 真实 SQL + 真实 config）===');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-verify-'));
for (const suffix of ['', '-wal', '-shm']) {
    const from = DB + suffix;
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(tmpDir, 'memory-store.sqlite' + suffix));
}
const realConfig = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const rosterConfig = realConfig.memory?.participantRoster;
check('config.json 里有 memory.participantRoster', !!rosterConfig);
check('config 里 enabled=true', rosterConfig?.enabled === true, JSON.stringify(rosterConfig));

const logLines = [];
const capturingLogger = {
    info(msg) { logLines.push(String(msg)); },
    warn(msg) { logLines.push('WARN ' + String(msg)); },
    error(msg) { logLines.push('ERROR ' + String(msg)); },
    debug(msg) { logLines.push(String(msg)); }
};

const sessionManager = new SessionManager(tmpDir,
    { memory: { storage: { path: path.join(tmpDir, 'memory-store.sqlite') } } }, capturingLogger);

const rawRows = sessionManager.listRecentContacts(60);
check('listRecentContacts 返回行', Array.isArray(rawRows) && rawRows.length > 0, `n=${rawRows?.length}`);
check('行来自 participant_contacts 表（participant_id/display_name/name_history/…）',
    rawRows.every((r) => r.participant_id && r.last_seen_at !== undefined
        && typeof r.name_history === 'string'),
    JSON.stringify(rawRows[0]));
// ⚠ 这里**不能**断言"一定出现回填日志"：表一旦建过，后续启动就走"已非空 ⇒ 跳过回填"，
// 日志自然没有了（第一版就是这么白报一个 FAIL 的）。真正的不变量是"表非空、人不丢"，
// 回填代码路径另有专门测试（见下面的「升级路径」）。
const contactCount = () => Number(
    sessionManager.db.prepare('SELECT COUNT(*) n FROM participant_contacts').get().n);
check('🔴 表非空且人数 ≥ 15（实测 25）', contactCount() >= 15, String(contactCount()));
check('表已存在时不再重复回填（幂等，靠 count>0 跳过）',
    logLines.some((l) => l.includes('SQLite 初始化完成')));

// 增量写入：新来一条带新昵称的消息，必须追加进 name_history 且 display_name 跟着走
const beforeRow = sessionManager.db.prepare(
    'SELECT display_name, name_history, message_count FROM participant_contacts WHERE participant_id = ?'
).get('2063362809');
sessionManager.addMessage('group:929159193', 'user',
    '[群聊|QQ:2063362809|昵称:临时验证名|群号:929159193] 验证用',
    { participants: ['临时验证名(2063362809)'] });
const afterRow = sessionManager.db.prepare(
    'SELECT display_name, name_history, message_count FROM participant_contacts WHERE participant_id = ?'
).get('2063362809');
check('🟢 新昵称被追加进 name_history（"很多个称呼"）',
    JSON.parse(afterRow.name_history)[0] === '临时验证名'
    && JSON.parse(afterRow.name_history).includes(JSON.parse(beforeRow.name_history)[0]),
    afterRow.name_history);
check('🟢 display_name 跟着最近一次走',
    afterRow.display_name === '临时验证名', afterRow.display_name);
check('🟢 message_count 递增 1',
    Number(afterRow.message_count) === Number(beforeRow.message_count) + 1,
    `${beforeRow.message_count} -> ${afterRow.message_count}`);
// 还原这行，别污染后面的渲染断言
sessionManager.db.prepare(
    'UPDATE participant_contacts SET display_name = ?, name_history = ?, message_count = ? WHERE participant_id = ?'
).run(beforeRow.display_name, beforeRow.name_history, beforeRow.message_count, '2063362809');
check('🟢 名册坏了不拖垮消息写入（addMessage 里是 try/catch 包着的）',
    /catch \(error\) \{[\s\S]{0,200}记录联系人失败/.test(SES_SRC));

const text = roster.buildParticipantRosterText(sessionManager, rosterConfig, { now: Date.now() });
console.log('\n---- 实际会注入的文本 ----');
console.log(text);
console.log('---- 共 %d 字 ----\n', text.length);

// 🔴 2026-10-13 改（真缺口在这里暴露 + 修好）：
//    原来这三条断言写的是「渲染文本里一定能找到 1000000005」+「表里每个人都在名单里（total<=listed）」。
//    但联系人表会长大（2026-10-13 已 56 人），而渲染文本有 maxListedTotal(40) 硬上限，
//    那个号已经排到第 50 ⇒ 这两条断言**结构上不可能成立**，每跑必红。
//    ⚠ 更严重的是它掩盖了一个真 bug：`mention`（「注意:」行那句）原先也是拿**截断后**的
//      entries 算的 ⇒ 排第 41 名以后的人连最高杠杆位置也看不见，用户当初报的
//      「他知道 QQ 号、她说真没印象」在数据长大后**复发**。src 已修成按未截断的 allEntries 算。
//    ⇒ 断言按两个**正交**的不变量重写：
//      ① 显示口径：渲染文本里的人数 === min(表人数, maxListedTotal)（上限被尊重，且只少不丢）
//      ② 认知口径：只要在表里，**提到他（QQ 或昵称）就必须被「注意:」行认出来** —— 与排名无关
const tableTotal = Number(
    sessionManager.db.prepare('SELECT COUNT(*) n FROM participant_contacts').get().n);
// 🔴 2026-10-14：把「现在跟你说话的就是名单里的：X」那一行**排除**再数人数 ——
//   否则发言人若排在上限（40）之外，这一行会额外带进一个 id，计数变 41 就假红。
const listBody = text.split('\n').filter((l) => !l.startsWith('现在跟你说话的就是名单里的')).join('\n');
const listedIds = new Set(listBody.match(/\d{6,}/g) || []);
check('🔴 显示口径：渲染文本里的人数 === min(表人数, maxListedTotal)',
    listedIds.size === Math.min(tableTotal, Number(rosterConfig.maxListedTotal)),
    `表=${tableTotal} 上限=${rosterConfig.maxListedTotal} 名单=${listedIds.size}`);

const mentionProbe = (msg) => roster.buildParticipantRoster(sessionManager, rosterConfig,
    { messageText: msg }).mention;
check('🔴 认知口径：提到这个 QQ 号时「注意:」行必须认出来（**与它排第几无关**）',
    mentionProbe('他qq号是这个1000000005').includes('1000000005')
    && mentionProbe('他qq号是这个1000000005').includes('曲奇饼干全肯定bot'),
    `排名在第 ${(() => {
        const rows = sessionManager.db.prepare(
            'SELECT participant_id FROM participant_contacts ORDER BY last_seen_at DESC').all();
        return rows.findIndex((r) => r.participant_id === '1000000005') + 1;
    })()} 位而渲染上限是 ${rosterConfig.maxListedTotal} ⇒ 走的正是「注意:」行这条路`,
    );

// 反向对照：渲染文本里**能**列出的人，文本里必须真的出现（防"上限生效但内容丢了"）
const topIds = sessionManager.db.prepare(
    'SELECT participant_id FROM participant_contacts ORDER BY last_seen_at DESC LIMIT ?'
).all(Number(rosterConfig.maxListedTotal)).map((r) => r.participant_id);
const missingTop = topIds.filter((id) => !listedIds.has(id));
check('🟢 排进上限内的联系人都真的出现在渲染文本里（没有静默丢人）',
    missingTop.length === 0, `丢了 ${missingTop.length} 个: ${missingTop.slice(0, 5).join(',')}`);
check('🔴 群里不止一个人（旧写法一个群只出"最后发言的那一个"）',
    (text.match(/（群）/g) || []).length >= 2,
    `（群）标记数 = ${(text.match(/（群）/g) || []).length}`);
check('名单没有正文泄漏（不含 messageSegments / eventType / isAtBot）',
    !text.includes('messageSegments') && !text.includes('eventType') && !text.includes('isAtBot'));
check('名单里不出现系统通知文本（「加入本群」这类）',
    !text.includes('加入本群'));
check('不包含 assistant 消息（只取 role=user）', !text.includes('{{char}}'));
check('🟢 用户那两句原话都能命中（QQ / 昵称）', (() => {
    const a = roster.buildParticipantRoster(sessionManager, rosterConfig, {
        messageText: '他不是跟你说过话嘛他qq号是这个1000000005' });
    const b = roster.buildParticipantRoster(sessionManager, rosterConfig, {
        messageText: '你觉得曲奇饼干全肯定bot怎么样' });
    return a.mention.includes('1000000005') && b.mention.includes('1000000005');
})());
check('🟢 中性消息不产生提及提示',
    roster.buildParticipantRoster(sessionManager, rosterConfig,
        { messageText: '今天天气不错' }).mention === '');
check('详细条目不超过 maxEntries 行',
    (text.match(/— (今天|昨天|\d\d-\d\d) /g) || []).length <= (rosterConfig.maxEntries || 12),
    `${(text.match(/— (今天|昨天|\d\d-\d\d) /g) || []).length} 行详细`);
// ⚠ 阈值放宽到 1400：被动入库让通讯录能从群闲聊里学到更多人（25 → 30+），
//   名单自然变长（实测 941 字）。真正该管的是 maxListedTotal（现 40）。
check('注入体量可控（< 1400 字）', text.length < 1400, `${text.length} 字`);

// 收尾：先关库再删临时目录 —— DatabaseSync 不 close 会占着句柄，Windows 上
// rmSync 直接 EPERM（第一版就是这么炸的）。
try { sessionManager.db?.close?.(); } catch { /* 忽略 */ }
try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
} catch (error) {
    console.log(`  [note] 临时目录没删掉（${error.code}），可手动清理: ${tmpDir}`);
}

// ---------------------------------------------------------------------------
// Part 2b 升级路径 —— 把 participant_contacts 删掉再启动，必须自动从历史消息回填。
// 这条最容易被漏：升级后名册如果突然空掉，看起来就是"功能坏了"（今天已经因为别的原因
// 误判过一次），而它是**静默**的。
console.log('\n=== Part 2b  升级路径（表被删掉后能不能自己长回来）===');
{
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-upgrade-'));
    const db2 = path.join(tmp2, 'memory-store.sqlite');
    for (const suffix of ['', '-wal', '-shm']) {
        if (fs.existsSync(DB + suffix)) fs.copyFileSync(DB + suffix, db2 + suffix);
    }
    try {
        const logs2 = [];
        const logger2 = {
            info(m) { logs2.push(String(m)); }, warn(m) { logs2.push('WARN ' + m); },
            error(m) { logs2.push('ERROR ' + m); }, debug(m) { logs2.push(String(m)); }
        };
        const sm2 = new SessionManager(tmp2,
            { memory: { storage: { path: db2 } } }, logger2);
        // 模拟"老库还没有这张表"：删掉，再重建一个 SessionManager
        sm2.db.exec('DROP TABLE IF EXISTS participant_contacts');
        try { sm2.db.close(); } catch { /* 忽略 */ }

        const logs3 = [];
        const logger3 = {
            info(m) { logs3.push(String(m)); }, warn(m) { logs3.push('WARN ' + m); },
            error(m) { logs3.push('ERROR ' + m); }, debug(m) { logs3.push(String(m)); }
        };
        const sm3 = new SessionManager(tmp2,
            { memory: { storage: { path: db2 } } }, logger3);
        const n3 = Number(sm3.db.prepare('SELECT COUNT(*) n FROM participant_contacts').get().n);
        check('🟢🔴 删表后重启会自动回填（不然升级后名册会静默空掉）',
            logs3.some((l) => l.includes('已从历史消息回填联系人')), logs3.join(' | ').slice(0, 200));
        check('🟢🔴 回填出的人数 ≥ 15（实测 25）', n3 >= 15, String(n3));
        check('🟢 回填是幂等的：再启一次不会重复累加 message_count', (() => {
            const before = sm3.db.prepare(
                'SELECT COALESCE(SUM(message_count),0) s FROM participant_contacts').get().s;
            try { sm3.db.close(); } catch { /* 忽略 */ }
            const sm4 = new SessionManager(tmp2,
                { memory: { storage: { path: db2 } } }, { info() {}, warn() {}, error() {}, debug() {} });
            const after = sm4.db.prepare(
                'SELECT COALESCE(SUM(message_count),0) s FROM participant_contacts').get().s;
            try { sm4.db.close(); } catch { /* 忽略 */ }
            return Number(before) === Number(after);
        })());
    } catch (error) {
        check('Part 2b 升级路径跑通', false, String(error && error.message));
    } finally {
        try { fs.rmSync(tmp2, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
}

// ---------------------------------------------------------------------------
// Part 3  装配层 —— 本项目的规矩：改了模块 ≠ 改完，必须验**装配后的提示词**。
// PromptBuilder.buildSituationalContext 只读 this.contextConfig，所以构造时给
// 假 manager 就够了，不需要真的角色卡。
console.log('\n=== Part 3  装配层（真 PromptBuilder 的 buildSituationalContext）===');
const { PromptBuilder } = await import(pathToFileURL(`${SRC}/prompt.js`).href);

const builder = new PromptBuilder({}, {}, { context: {}, chat: {} }, capturingLogger);
const withRoster = builder.buildSituationalContext({ recentMessages: [] }, {
    sessionId: 'private:2063362809',
    messageType: 'private',
    messageCount: 1,
    participants: ['werwer(2063362809)'],
    participantRoster: text
});
check('名册出现在装配后的情境段里', withRoster.includes('【你最近联系过的人】'));
// ⚠ 2026-10-13 改：原断言是「含那个 QQ 号」——但它依赖 1000000005 排进渲染上限，
//   上限 40 / 表 56 ⇒ 必红，而且它要守的其实是**原样透传**，不是某个具体的人。
//   改成逐字透传（prompt.js 里就是 `String(runtimeContext.participantRoster).trim()` 原样拼）。
check('名册内容原样带过去（逐字透传，与谁排在名单里无关）',
    withRoster.includes(text.trim()), `text.len=${text.trim().length}`);
check('名册排在【参与者】之后', withRoster.indexOf('【参与者】') < withRoster.indexOf('【你最近联系过的人】'));

const withoutRoster = builder.buildSituationalContext({ recentMessages: [] }, {
    sessionId: 'private:2063362809',
    messageType: 'private',
    messageCount: 1,
    participants: ['werwer(2063362809)']
});
check('没有名册时不注入空段（不留孤立标题）',
    !withoutRoster.includes('【你最近联系过的人】'));

const emptyRoster = builder.buildSituationalContext({ recentMessages: [] }, {
    sessionId: 'private:2063362809',
    participants: ['werwer(2063362809)'],
    participantRoster: ''
});
check('名册为空串时不注入', !emptyRoster.includes('【你最近联系过的人】'));

// ---------------------------------------------------------------------------
// Part 4  真装配 —— 真角色卡 + 真世界书 + 真 config + 真 DB 副本，走完整 build()，
//         然后把**装配后的提示词整块 grep**。
// 为什么必须有这一层：前三层只证明"模块对"和"情境段拼装对"。本项目规矩是
// 「改卡断言通过 ≠ 改完 —— 必须把装配后的提示词整块 grep」。而且主提示词在日志里的
// contentPreview 只留前 ~120 字，**从日志根本看不出情境段里有什么**（styleAnchor 与
// 名册都在这上面被骗过一次），所以只能在本地把真提示词拉出来看。
console.log('\n=== Part 3b  「注意:」行注入 ===');
{
    const { buildCurrentMessageFocus, formatCurrentMessageFocus } = await import(
        pathToFileURL(`${SRC}/current-message-focus.js`).href);
    const mention = '【PROBE-MENTION】对方提到的那个人就在你的联系人名单里。';
    const focus = buildCurrentMessageFocus(
        { messageType: 'private', segments: [{ type: 'text', text: 'x' }], currentUserMessage: 'x' },
        { participantRosterMention: mention });
    check('提示出现在「注意:」行里',
        formatCurrentMessageFocus(focus).includes('【PROBE-MENTION】'));
    check('🔴 它是最后一条 warning（杠杆最高的位置）',
        focus.warnings[focus.warnings.length - 1] === mention,
        JSON.stringify(focus.warnings[focus.warnings.length - 1] || ''));
    const noMention = buildCurrentMessageFocus(
        { messageType: 'private', segments: [{ type: 'text', text: 'x' }], currentUserMessage: 'x' }, {});
    check('没命中时不注入（不留占位）',
        !formatCurrentMessageFocus(noMention).includes('联系人名单里'));
}

console.log('\n=== Part 4  真装配（真 CharacterManager/WorldBookManager + 真 config + 真 build）===');

const { CharacterManager } = await import(pathToFileURL(`${SRC}/character.js`).href);
const { WorldBookManager } = await import(pathToFileURL(`${SRC}/worldbook.js`).href);
const { chatScopeKey } = await import(pathToFileURL(`${SRC}/chat-scope.js`).href);

const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-assemble-'));
const db4 = path.join(tmp4, 'memory-store.sqlite');
for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(DB + suffix)) fs.copyFileSync(DB + suffix, db4 + suffix);
}
const DATA_DIR = 'C:/Users/20633/MimirLink/data';

try {
    const sm4 = new SessionManager(tmp4, { memory: { storage: { path: db4 } } }, capturingLogger);
    const builder4 = new PromptBuilder(new CharacterManager(DATA_DIR), new WorldBookManager(DATA_DIR),
        realConfig, capturingLogger);

    // ⚠ 2026-10-13 改：原来这里只调 buildParticipantRosterText（只拿 text），
    //   于是「注意:」行那条路**根本没进装配**，而它恰恰是本次真缺口（排到上限之外的人
    //   认不出来）的正解。改成镜像线上 index.js 的 resolveParticipantRoster：
    //   把 text + mention **一起**拿出来、一起交给 build()。
    const ROSTER_PROBE_MSG = '你觉得 1000000005 这个qq号的人怎么样';
    const info4 = roster.buildParticipantRoster(sm4, realConfig.memory?.participantRoster,
        { now: Date.now(), messageText: ROSTER_PROBE_MSG });
    const roster4 = info4.text;
    check('真 config + 真 DB 下名册非空', roster4.length > 0, `${roster4.length} 字`);

    const ctx4 = sm4.getContext('private:2063362809', realConfig.chat?.historyLimit || 30,
        chatScopeKey({ messageType: 'private', groupId: null, userId: 2063362809 }));
    const built = await builder4.build('Anon_Chihaya', '你觉得 1000000005 这个qq号的人怎么样',
        ctx4, new Set(), {
            sessionId: 'private:2063362809',
            memoryScope: { sessionKey: 'private:2063362809' },
            recallNamespace: {
                scopeType: 'private_user', scopeKey: 'private:2063362809',
                characterName: 'Anon_Chihaya', presetName: 'Default Preset'
            },
            messageType: 'private',
            messageCount: 1,
            participants: ['werwer(2063362809)'],
            triggerReason: 'private',
            participantRoster: roster4,
            participantRosterMention: info4.mention
        });

    const msgs = built.messages || [];
    const sysText = msgs.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n');
    const allText = msgs.map((m) => String(m.content)).join('\n');

    check('装出 205 条左右的消息（说明真卡 + 真示例都进来了）', msgs.length > 100, `n=${msgs.length}`);
    check('🔴 装配后的提示词里有【你最近联系过的人】', allText.includes('【你最近联系过的人】'));
    check('🔴 且落在 system 消息里（读作背景资料，不是"用户说的话"）',
        sysText.includes('【你最近联系过的人】'));
    // 🔴 这是本次修复的**核心断言**：用户原话问的就是这个号，而它排在渲染上限之外 ⇒
    //   唯一能救的就是「注意:」行那句。它必须真的落进**装配后的**提示词里（本项目规矩：
    //   改模块 ≠ 改完，必须整块 grep 装配结果）。
    check('🔴 「注意:」行已经算出这个号（mention 走的是未截断名单）',
        info4.mention.includes('1000000005') && info4.mention.includes('曲奇饼干全肯定bot'),
        `mention=${info4.mention.slice(0, 80)}`);
    check('🔴 装配后的提示词里有 曲奇饼干全肯定bot(1000000005)',
        allText.includes('曲奇饼干全肯定bot(1000000005)'),
        `渲染名单 ${roster4.length} 字（该号排在上限外，只可能来自提及提示）`);
    check('🔴 且落在 system 消息的「注意:」行里（杠杆最高的位置）',
        sysText.includes('1000000005') && sysText.includes('联系人名单里'), '');
    check('提及提示是「注意:」行的最后一条（回复前最后读到）',
        (() => {
            const focusMsg = msgs.find((m) => String(m.content).includes('联系人名单里'));
            if (!focusMsg) return false;
            const lines = String(focusMsg.content).split('\n');
            const noteIdx = lines.findIndex((l) => l.startsWith('注意:'));
            if (noteIdx < 0) return false;
            // 「注意:」里最后一段就是 mention
            return lines[noteIdx].trim().endsWith(info4.mention.trim());
        })());
    check('名册没被塞进示例对话区（不会被当成前情对话）',
        !msgs.some((m) => m.meta?.source === 'example_dialogue'
            && String(m.content).includes('你最近联系过的人')));
    check('名册没被塞进历史区',
        !msgs.some((m) => m.meta?.source === 'history'
            && String(m.content).includes('你最近联系过的人')));
    check('🟡 新增的观测日志打出来了（否则日志里无法判断名册进没进）',
        logLines.some((l) => l.includes('注入身份名册')), `debug 行 n=${logLines.length}`);
    check('名册在 system 里的占比很小（不挤占人设/世界书）',
        sysText.length - roster4.length > 8000, `system=${sysText.length} 名册=${roster4.length}`);

    try { sm4.db?.close?.(); } catch { /* 忽略 */ }
} catch (error) {
    check('Part 4 真装配跑通', false, error && error.message);
} finally {
    try { fs.rmSync(tmp4, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

// ---------------------------------------------------------------------------
// Part 5  源码级断言（回归闸门）
// 这类"加一处上下文"的改法最容易漏的就是**第二个装配点**：漏了不会报错，只是某条路径
// 静默没有这个字段。这里直接把两个装配点和两处日志闸门钉死。
console.log('\n=== Part 5  源码级断言（装配点齐全 + 日志闸门在位）===');

// ⚠ 2026-10-14：断言从「传了 messageText」升级为「**messageText + speakerId 都传了**」。
//   speakerId 是新的必需项 —— 缺了它发言人自己会被当成"被提到的人"
//   （实测群里 `小摸` 发「小摸听到了」每轮都命中提及）。
//   同理，这两条也必须**同时**要求 `event?.user_id` 出现在调用里。
check('index.js 主路径用了带日志的包装（messageText + speakerId 都传了）',
    /resolveParticipantRoster\('main',\s*processedInput,\s*String\(event\?\.user_id/.test(IDX_SRC));
check('index.js 管理员@路径也用了包装（messageText + speakerId 都传了）',
    /resolveParticipantRoster\('admin-mention',\s*processedInput,\s*String\(event\?\.user_id/.test(IDX_SRC));
check('index.js 不再有裸的 buildParticipantRosterText 赋值（避免绕过日志）',
    !/runtimeContext\.participantRoster\s*=\s*buildParticipantRosterText/.test(IDX_SRC));
check('index.js 的日志用 info 级别（debug 有可能被日志级别挡掉）',
    /logger\.info\(`\[身份名册\]/.test(IDX_SRC));
check('prompt.js 注入处也有一行日志',
    PRM_SRC.includes('注入身份名册'));
// ⚠ 断言要拿**代码**位置比，不要拿关键词 —— 我第一版用 `indexOf('【当前发言人画像】')`，
// 结果命中的是上面注释里提到它的那一行，白报一个 FAIL。
{
    const fnStart = PRM_SRC.indexOf('buildSituationalContext(context, runtimeContext) {');
    const rosterPush = PRM_SRC.indexOf('sections.push(rosterText)');
    const profileBlock = PRM_SRC.indexOf('if (runtimeContext.currentSpeakerProfile?.content) {');
    check('prompt.js 的注入语句落在 buildSituationalContext 内、且在【当前发言人画像】之前',
        fnStart > 0 && rosterPush > fnStart && profileBlock > rosterPush,
        `fn=${fnStart} push=${rosterPush} profile=${profileBlock}`);
}
check('🔴 session.js 建了持久表 participant_contacts（身份不落盘就会随摘要静默消失）',
    /CREATE TABLE IF NOT EXISTS participant_contacts/.test(SES_SRC));
check('🔴 listRecentContacts 读的是表，不是 messages',
    /listRecentContacts: this\.db\.prepare\(`[\s\S]{0,400}FROM participant_contacts/.test(SES_SRC));
check('🟢 回填查询用 json_each 平铺 participants（按人，不是按会话）',
    /json_each\(json_extract\(m\.metadata_json, '\$\.participants'\)\)/.test(SES_SRC)
    && /GROUP BY m\.session_id, TRIM\(je\.value\)/.test(SES_SRC));
check('🟢 回填按时间**正序**（recordContact 把新名字插前面 ⇒ 历史才是"最近在前"）',
    /backfillContactSources[\s\S]{0,900}ORDER BY timestamp ASC/.test(SES_SRC));
check('session.js 不再用「每会话取一条」的窗口函数写法（那会漏掉群里其他人）',
    !/pick_rank/.test(SES_SRC) && !/contact_count/.test(SES_SRC));
check('session.js 不用 metadata.userId 当发言人（批量合并时对不上）',
    !/json_extract\(m\.metadata_json,\s*'\$\.userId'\)/.test(SES_SRC));
check('index.js 把 mention 放进了 runtimeContext',
    /runtimeContext\.participantRosterMention = rosterInfo\.mention/.test(IDX_SRC));
check('prompt.js 把 mention 转发给 focus（不然落不到「注意:」行）',
    /participantRosterMention: runtimeContext\.participantRosterMention/.test(PRM_SRC));
check('current-message-focus.js 在 buildWarnings 末尾 push 它',
    /if \(participantRosterMention\) \{\s*\n\s*warnings\.push\(participantRosterMention\);/.test(CMF_SRC));
check('session.js 的 addMessage 里挂了记录联系人的钩子',
    /addMessage\(sessionId, role, content, metadata = \{\}\)[\s\S]{0,1200}recordContactsFromMessage/.test(SES_SRC));
check('session.js 用 participants 而不是 participantName 记人',
    /Array\.isArray\(metadata\?\.participants\)/.test(SES_SRC));
check('session.js 的 listRecentContacts 有 try/catch（坏了不能拖垮回复）',
    /listRecentContacts\(limit = 60\)[\s\S]{0,400}catch/.test(SES_SRC));
check('🟢 解析规则只有一份（session.js 从 participant-roster.js import，不各写一套）',
    /from '\.\/participant-roster\.js'/.test(SES_SRC)
    && /parseContactToken/.test(SES_SRC) && /mergeNameHistory/.test(SES_SRC));


// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(62));
console.log(`结果: ${pass} 通过 / ${failures.length} 失败`);
if (failures.length) { failures.forEach((f) => console.log('  失败: ' + f)); process.exit(1); }
console.log('全部通过');
