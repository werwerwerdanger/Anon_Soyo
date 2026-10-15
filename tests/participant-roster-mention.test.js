/**
 * 「注意:」行的提及提示（participantRosterMention）不能拿**信封**里的发送者身份去匹配。
 *
 * 事故（2026-10-13 实测）：`options.messageText` 传进来的是 `processedInput`，带结构化信封：
 *   `[私聊|QQ:2063362809|昵称:werwer|…|messageSegments:[{…}]] 当素世你就会好好对我了`
 * 信封里必然有**发送者自己的 QQ 和昵称**，而发送者本来就在联系人名单里
 * ⇒ 每条消息都命中 ⇒ 每一轮都在杠杆最高的「注意:」行注入
 *   「对方提到的那个人就在你的联系人名单里：werwer(2063362809)…直接照名单回答就行。」
 * 连「嗯」「今天吃什么」都命中，而**真的**有人被提到时那行一模一样 ⇒ 信号被淹没。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildParticipantRoster } from '../src/participant-roster.js';
// 🔴 剥离器的家是 `structured-envelope.js`（只留一份，roster 与 prompt 共用）
import { stripStructuredEnvelope, hasStructuredEnvelope } from '../src/structured-envelope.js';

const ME = '2063362809';
const OTHER = '1000000005';

const CONTACTS = [
    {
        participant_id: ME, display_name: 'werwer', name_history: '["W"]',
        last_seen_at: 1791900000000, message_count: 12,
        last_scope_kind: 'private', last_scope_key: `private:${ME}`
    },
    {
        participant_id: OTHER, display_name: '曲奇饼干全肯定bot', name_history: '[]',
        last_seen_at: 1791890000000, message_count: 4,
        last_scope_kind: 'private', last_scope_key: `private:${OTHER}`
    }
];
const sm = { listRecentContacts: () => CONTACTS.map((c) => ({ ...c })) };
const cfg = { enabled: true, maxAgeDays: 3650, maxEntries: 12, maxListedTotal: 40, minMessages: 1, excludeIds: [] };
const now = 1791905000000;

/** 造一条真实形状的信封（和线上 `processedInput` 同构）。 */
const envelope = (body, { qq = ME, nick = 'werwer', groupId = 'N/A', groupName = 'N/A' } = {}) =>
    `[${groupId === 'N/A' ? '私聊' : '群聊'}|QQ:${qq}|昵称:${nick}|群号:${groupId}|群名:${groupName}`
    + `|时间:2026/10/14 00:56:07|eventType:message|isAtBot:false`
    + `|messageSegments:[{"type":"text","text":"${body}"}]] ${body}`;

const mentionOf = (text, speakerId) => buildParticipantRoster(sm, cfg,
    { now, messageText: text, speakerId }).mention;

// 🔴 实测（2026-10-13）：群里 `小摸` 发了句「小摸听到了，在看呢」——它自己在名单里、
//   昵称又出现在正文里 ⇒ 每轮都注入「对方提到的那个人就在你的联系人名单里：小摸(596443457)」。
//   这句话的前提就是错的：那不是"被提到的人"，那是**正在说话的人**。
test('发言人自己提到自己的昵称，不算"对方提到的那个人"', () => {
    const text = '曲奇饼干全肯定bot在吗';
    assert.equal(mentionOf(text, OTHER), '', '发言人 = 曲奇饼干 ⇒ 不该命中自己');
    assert.match(mentionOf(text, ME), /1000000005/, '换个发言人（werwer）⇒ 该命中');
    assert.match(mentionOf(text), /1000000005/, '没给 speakerId 时保持旧行为（向后兼容）');
});

test('发言人报自己的 QQ 号也不算被提到', () => {
    assert.equal(mentionOf(`我的号是${OTHER}`, OTHER), '');
    assert.match(mentionOf(`他的号是${OTHER}`, ME), /1000000005/);
});

// 🔴 2026-10-14 实测（群里）：`白` @她问「我是谁」——
//   名单第 3 行就写着 `白(1000000004)`、focus 里也标了 `发言人: 白(1000000004)`，
//   她还是答「白？没见过这个名字诶」。**信息全在，就是没人告诉她把发言人也对一遍**：
//   名册原来的收尾句只说"对方**提到**昵称/号码时去名单里找"。
const rosterText = (speakerId) => buildParticipantRoster(sm, cfg, {
    now, messageText: '？', speakerId
}).text;

test('名册开头明确写出「现在跟你说话的是谁」', () => {
    const t = rosterText(OTHER);
    assert.match(t, /现在跟你说话的就是名单里的：/);
    assert.match(t, /曲奇饼干全肯定bot\(1000000005\)/);
    assert.match(t, /「我是谁」/, '要直接点出「我是谁」这类问法');
});

test('发言人不在名单里时不写这一行（不留空话）', () => {
    assert.ok(!rosterText('99999999999').includes('现在跟你说话的就是名单里的'));
    assert.ok(!rosterText('').includes('现在跟你说话的就是名单里的'));
});

test('信封里的发送者 QQ 不再触发提及（连「嗯」都不该触发）', () => {
    for (const body of ['嗯', '今天吃什么', '当素世你就会好好对我了', '1']) {
        assert.equal(mentionOf(envelope(body)), '', `「${body}」不该命中提及`);
    }
});

test('信封里的发送者昵称也不触发提及', () => {
    assert.equal(mentionOf(envelope('随便说点什么')), '');
});

test('群聊信封里的群号不触发提及', () => {
    const text = envelope('入店了吗', { groupId: '929159193', groupName: '2026程序设计协会' });
    assert.equal(mentionOf(text), '');
});

test('🔴 正文里真的报了某个 QQ 号时，仍然必须命中（别修过头）', () => {
    const m = mentionOf(envelope(`他qq号是这个${OTHER}`));
    assert.match(m, /1000000005/);
    assert.match(m, /曲奇饼干全肯定bot/);
});

test('正文里提到昵称同样命中', () => {
    assert.match(mentionOf(envelope('你觉得曲奇饼干全肯定bot怎么样')), /1000000005/);
});

test('批里任意一条提到都命中', () => {
    const text = envelope('在吗') + '\n' + envelope(`他qq号是这个${OTHER}`);
    assert.match(mentionOf(text), /1000000005/);
});

test('stripStructuredEnvelope：纯文本原样、信封被剥、正文保留', () => {
    assert.equal(stripStructuredEnvelope('就是一句普通的话'), '就是一句普通的话');
    assert.equal(stripStructuredEnvelope(''), '');
    assert.equal(stripStructuredEnvelope(null), '');
    const stripped = stripStructuredEnvelope(envelope('当素世你就会好好对我了'));
    assert.equal(stripped, '当素世你就会好好对我了');
    assert.ok(!stripped.includes('|QQ:'), '信封被剥掉');
    assert.ok(!stripped.includes('messageSegments'), 'JSON 段被剥掉');
    // ⚠ 别断言精确的剥离串：替换用的分隔符是空格，和原文换行叠起来很容易写出错误期望
    //   （第一版就写错了）。断言**性质**：信封没了、正文两条都在。
    const multi = stripStructuredEnvelope(envelope('甲') + '\n' + envelope('乙'));
    assert.ok(!multi.includes('|QQ:') && !multi.includes('messageSegments'), '多批的信封都被剥掉');
    assert.ok(multi.includes('甲') && multi.includes('乙'), '多批的正文都保留');
});

// ⚠ 别只覆盖 `[私聊|` —— 实测还有其他形态会一起漏进来（2026-10-13 补了私聊/群聊之后，
//   `[回复上文|…]` 仍然被【会话感知】当成"反复出现的话"，又踩了一次）。
test('stripStructuredEnvelope 覆盖全部信封形态', () => {
    const cases = [
        ['消息信封（单条）', envelope('在吗')],
        ['引用信封', '[回复上文|发送者:chihaya_anon|QQ:2458713318|内容:你才死掉了呢]'],
        ['合并转发信封', '[合并转发聊天记录|发送者:甲|内容:乙]'],
        ['图片指纹', '你看这个 [图片标识 #c7599898]'],
    ];
    for (const [label, text] of cases) {
        assert.ok(hasStructuredEnvelope(text), `${label}: 应被识别为含信封/元数据`);
        const stripped = stripStructuredEnvelope(text);
        assert.ok(!/[|]/.test(stripped.replace(/[^\u4e00-\u9fa5A-Za-z0-9，。？!：；、「」（）]/g, '')),
            `${label}: 剥完不该留管道符等机器标记 -> ${JSON.stringify(stripped)}`);
    }
    // 引用信封整体算元数据 ⇒ 剥完为空（引用里的内容**不**参与"对方提到谁"的匹配：
    // 引用是"她刚才说的"，不是"对方这次说的"）
    assert.equal(stripStructuredEnvelope(cases[1][1]), '');
    assert.equal(stripStructuredEnvelope(cases[3][1]).trim(), '你看这个');
    // 纯文本不受影响
    assert.equal(hasStructuredEnvelope('就是一句普通的话'), false);
    assert.equal(stripStructuredEnvelope('他qq号是这个1000000005'), '他qq号是这个1000000005');
});

// 🔴 2026-10-14 实测：信封里会**嵌套方括号**，任何"匹配到第一个 ]"的写法都会漏。
//    真实原文（群里「白」发的那条）：
//      …|replyQuotedText:[图片:[动画表情]]|messageSegments:[…]] [回复上文|…|内容:[图片:[动画表情]]]
//    用 `[^\]]*` 匹配会停在 `[动画表情]` 的那个 `]`，删完还剩一截 `]]` 留在正文里 ——
//    历史区真的渲染出过 `[白(1000000004) 10:45:24] ]]` 这种行。
test('信封里嵌套方括号时也能整块剥干净（不留 ] ）', () => {
    const real = '[群聊|QQ:1000000004|昵称:白|群号:929159193|群名:2026程序设计协会'
        + '|时间:2026/10/14 10:45:24|eventType:message|isAtBot:false|replyToBot:false'
        + '|replyQuotedText:[图片:[动画表情]]'
        + '|messageSegments:[{"type":"reply","id":"45048518"},{"type":"at","qq":"3397756294"},'
        + '{"type":"text","text":"？"}]]'
        + ' [回复上文|发送者:残月|扣扣:3397756294|内容:[图片:[动画表情]]]\n'
        + '[@某人|扣扣:3397756294]  ？';

    const out = stripStructuredEnvelope(real);
    assert.ok(!out.includes('昵称:白'), '消息信封被剥掉');
    assert.ok(!out.includes('发送者:残月'), '引用信封被剥掉（哪怕内容里有嵌套括号）');
    assert.ok(!/\]\]/.test(out), `不该留下孤立的 ]] -> ${JSON.stringify(out)}`);
    assert.ok(out.includes('？'), '正文保留');

    // 反向：嵌套括号**不能**让整块信封原样留着（`[^[\]]*` 那种写法就会这样）
    assert.ok(!hasStructuredEnvelope(out), '剥完不该再被判定为含信封');
});
