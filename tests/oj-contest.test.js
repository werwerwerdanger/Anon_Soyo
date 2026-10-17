import test from 'node:test';
import assert from 'node:assert/strict';

import {
    OJ_CONTEST_DEFAULTS,
    normalizeOjContestConfig,
    parseOjTime,
    parseContestList,
    selectNextContest,
    beijingParts,
    formatContestWhen,
    formatCountdown,
    buildContestNotice,
    pickDueNotices,
    expiredNoticeKeys,
    pickDueDailyProblem,
    buildDailyProblemNotice
} from '../src/oj-contest.js';

const BEIJING = 8 * 3600 * 1000;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 造一场"北京某天 14:00 开始、4 小时"的比赛 */
function contestStartingBeijing(dateText, hour = 14, id = 5) {
    const startMs = Date.parse(`${dateText}T${String(hour - 8).padStart(2, '0')}:00:00Z`);
    return { id, title: '测试赛', startMs, endMs: startMs + 4 * HOUR, isPublic: 1, status: 'upcoming' };
}

const CFG = normalizeOjContestConfig({
    enabled: true,
    notifyGroups: ['1'],
    baseUrl: 'https://oj.example.com',
    dailyAtMinutes: [20 * 60],
    countdownWindowDays: 7,
    leadMinutes: [1440, 60, 10],
    maxPerDay: 3
});

test('时间口径：无时区的 ISO 当 UTC，带时区的按原样（与 oj-feedback 同约定）', () => {
    assert.equal(parseOjTime('2026-10-25T06:00:00'), Date.parse('2026-10-25T06:00:00Z'));
    assert.equal(parseOjTime('2026-10-25T06:00:00+00:00'), Date.parse('2026-10-25T06:00:00Z'));
    assert.equal(parseOjTime('2026-10-25T14:00:00+08:00'), Date.parse('2026-10-25T06:00:00Z'));
    assert.ok(Number.isNaN(parseOjTime('')));
});

test('只挑最近一场没结束的公开比赛', () => {
    const now = Date.parse('2026-10-15T00:00:00Z');
    const items = parseContestList({
        items: [
            { id: 1, title: '已结束', start_time: '2026-10-01T06:00:00+00:00', end_time: '2026-10-01T10:00:00+00:00', is_public: 1 },
            { id: 2, title: '最远', start_time: '2026-11-01T06:00:00+00:00', end_time: '2026-11-01T10:00:00+00:00', is_public: 1 },
            { id: 3, title: '最近', start_time: '2026-10-20T06:00:00+00:00', end_time: '2026-10-20T10:00:00+00:00', is_public: 1 },
            { id: 4, title: '非公开', start_time: '2026-10-16T06:00:00+00:00', end_time: '2026-10-16T10:00:00+00:00', is_public: 0 }
        ]
    });
    assert.equal(selectNextContest(items, now).id, 3);
    assert.equal(selectNextContest([], now), null);
});

test('倒计时/日期说人话（北京口径）', () => {
    const c = contestStartingBeijing('2026-10-25');            // 10/25 14:00 北京
    const before = Date.parse('2026-10-15T00:00:00Z');
    assert.equal(formatContestWhen(c.startMs, before), '10/25 14:00');
    assert.equal(formatCountdown(c.startMs, before), '还有 10 天');
    // 前一天同一时刻 ⇒ "明天"
    assert.equal(formatContestWhen(c.startMs, c.startMs - DAY), '明天 14:00');
    // 一小时内
    assert.equal(formatCountdown(c.startMs, c.startMs - 30 * MINUTE), '还有 30 分钟');
    assert.equal(formatCountdown(c.startMs, c.startMs + MINUTE), '已经开始了');
    assert.equal(beijingParts(Date.parse('2026-10-24T16:00:00Z')).date, '2026-10-25');
});

test('每日倒计时：只在「赛前 N 天」的 9 点念，同一天只念一次', () => {
    // 2026-10-16 用户要求：9 点 + 只在赛前 7/3/2/1 天
    const c = contestStartingBeijing('2026-10-23');            // 10-16 看 ⇒ 还剩 7 天
    const at0900 = Date.parse('2026-10-16T01:00:00Z');          // 北京 09:00
    const cfg9 = normalizeOjContestConfig({ ...CFG, dailyAtMinutes: [540], countdownDays: [7, 3, 2, 1] });
    assert.deepEqual(pickDueNotices(c, at0900, { notified: {} }, cfg9),
        [{ kind: 'daily', key: '5:daily:2026-10-16' }]);

    // 当天已念过 ⇒ 不再念
    assert.deepEqual(pickDueNotices(c, at0900, { notified: { '5:daily:2026-10-16': at0900 } }, cfg9), []);

    // 还没到 9:00（北京 08:30）⇒ 不念
    assert.deepEqual(pickDueNotices(c, Date.parse('2026-10-16T00:30:00Z'), { notified: {} }, cfg9), []);
});

test('每日倒计时：不在名单上的天数（如赛前 5 天）不念；名单留空则退回窗口行为', () => {
    const cfg9 = normalizeOjContestConfig({ ...CFG, dailyAtMinutes: [540], countdownDays: [7, 3, 2, 1] });
    const at0900 = Date.parse('2026-10-16T01:00:00Z');
    // 赛前 5 天（10-21 开始，10-16 看）
    const in5 = contestStartingBeijing('2026-10-21');
    assert.deepEqual(pickDueNotices(in5, at0900, { notified: {} }, cfg9), []);

    // 赛前 3 天 要念
    const in3 = contestStartingBeijing('2026-10-19');
    assert.deepEqual(pickDueNotices(in3, at0900, { notified: {} }, cfg9),
        [{ kind: 'daily', key: '5:daily:2026-10-16' }]);

    // countdownDays 显式留空 ⇒ 退回「窗口内每天都念」的旧行为
    const cfgWindow = normalizeOjContestConfig({ ...CFG, dailyAtMinutes: [540], countdownDays: [] });
    assert.deepEqual(pickDueNotices(in5, at0900, { notified: {} }, cfgWindow),
        [{ kind: 'daily', key: '5:daily:2026-10-16' }]);
});

test('每日一题：到点才发、当天只发一次、没安排题目就不发', () => {
    const cfg9 = normalizeOjContestConfig({ ...CFG, dailyAtMinutes: [540] });
    const at0900 = Date.parse('2026-10-16T01:00:00Z');
    const item = { date: '2026-10-16', title: '将军的高考志愿', link: '/problems/104', displayNo: 81 };

    assert.deepEqual(pickDueDailyProblem(item, at0900, { notified: {} }, cfg9),
        { kind: 'dailyProblem', key: 'daily-problem:2026-10-16' });
    // 当天已发过
    assert.equal(pickDueDailyProblem(item, at0900,
        { notified: { 'daily-problem:2026-10-16': at0900 } }, cfg9), null);
    // 还没到 9 点
    assert.equal(pickDueDailyProblem(item, Date.parse('2026-10-16T00:30:00Z'), { notified: {} }, cfg9), null);
    // 那天没安排题目（link 为空）
    assert.equal(pickDueDailyProblem({ date: '2026-10-17', link: '' }, at0900, { notified: {} }, cfg9), null);

    const text = buildDailyProblemNotice(item, { baseUrl: 'https://oj.example.com/' });
    assert.match(text, /【每日一题】/);
    assert.match(text, /#81/);
    assert.match(text, /将军的高考志愿/);
    assert.match(text, /https:\/\/oj\.example\.com\/problems\/104/);
});

test('赛前提醒：到点才发、过点太久只标记不发、开赛有单独一条', () => {
    const c = contestStartingBeijing('2026-10-20');
    const t24 = c.startMs - DAY;
    assert.deepEqual(pickDueNotices(c, t24, { notified: {} }, CFG).map((d) => d.key), ['5:lead:1440']);

    const t10 = c.startMs - 10 * MINUTE;
    assert.deepEqual(pickDueNotices(c, t10, { notified: {} }, CFG).map((d) => d.key), ['5:lead:10']);

    // 过了 grace 才轮询到 ⇒ 这条 10 分钟提醒**不补发**
    // （此刻已经开赛，所以 due 里只会有"开始了"那条，不该再有 lead:10）
    const late = c.startMs - 9 * MINUTE + CFG.graceMs + MINUTE;
    assert.deepEqual(pickDueNotices(c, late, { notified: {} }, CFG).map((d) => d.key), ['5:start']);
    // 但会被标成"已处理"，避免每轮重复判定（此刻三条 lead 全都过期了）
    assert.deepEqual(expiredNoticeKeys(c, late, { notified: {} }, CFG).sort(), ['5:lead:10', '5:lead:1440', '5:lead:60']);

    // 开赛瞬间
    const start = pickDueNotices(c, c.startMs + 1000, { notified: {} }, CFG);
    assert.deepEqual(start.map((d) => d.kind), ['start']);
    // 赛后很久 ⇒ 不补发
    assert.deepEqual(pickDueNotices(c, c.endMs + HOUR, { notified: {} }, CFG), []);
});

test('文案：包含标题/倒计时/时间/链接，三种播报口吻不同', () => {
    const c = contestStartingBeijing('2026-10-20');
    const soon = buildContestNotice(c, { kind: 'soon', now: c.startMs - HOUR, baseUrl: 'https://oj.example.com/', seed: '5:lead:60' });
    assert.match(soon, /测试赛/);
    assert.match(soon, /还有 1 小时/);
    assert.match(soon, /今天 14:00 开始/);
    assert.match(soon, /https:\/\/oj\.example\.com\/contests\/5/);

    const daily = buildContestNotice(c, { kind: 'daily', now: c.startMs - 5 * DAY, baseUrl: 'https://oj.example.com' });
    assert.match(daily, /【比赛倒计时】/);
    const start = buildContestNotice(c, { kind: 'start', now: c.startMs + 1000, baseUrl: 'https://oj.example.com' });
    assert.match(start, /已经开始了/);
});

test('配置归一化：留空则继承 ojFeedback，非法值回落默认', () => {
    const cfg = normalizeOjContestConfig({ enabled: true, notifyGroups: [' 123 ', ''] }, { baseUrl: 'https://a.example.com/', username: 'u' });
    assert.equal(cfg.baseUrl, 'https://a.example.com');
    assert.equal(cfg.username, 'u');
    assert.deepEqual(cfg.notifyGroups, ['123']);
    assert.equal(cfg.intervalMs, OJ_CONTEST_DEFAULTS.intervalMs);
    assert.deepEqual(cfg.leadMinutes, OJ_CONTEST_DEFAULTS.leadMinutes);
    assert.equal(normalizeOjContestConfig({}, {}).enabled, false);
});
