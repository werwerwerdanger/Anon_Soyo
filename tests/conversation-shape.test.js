/**
 * 「这段对话的形状」测试（2026-10-13 新建）
 *
 * 起因：用户观察到 agent 能从日志看出「这不像在测机器人」，而机器人看不出来。
 * 根因是她的【会话感知】只有 4 个字段，**没有"形状"** —— 她只看得到"这一句"。
 * 这里保证：形状算对了、只在有意义时才加、且**不替她下结论**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConversationShape } from '../src/prompt.js';

const T0 = new Date('2026-10-13T02:00:00+08:00').getTime();
const msg = (role, content, offsetMin) => ({ role, content, timestamp: T0 + offsetMin * 60000 });

test('历史太少就不加任何东西', () => {
    assert.deepEqual(buildConversationShape([], T0), []);
    assert.deepEqual(buildConversationShape([msg('user', '在吗', 0), msg('assistant', '在', 1)], T0), []);
});

test('算出时长与双方句数', () => {
    const rows = [
        msg('user', '我好难受', 0),
        msg('assistant', '怎么了', 1),
        msg('user', '大家都嫌弃我', 20),
        msg('assistant', '谁啊', 21),
        msg('user', '所有人', 40)
    ];
    const out = buildConversationShape(rows, T0);
    const line = out.find((l) => l.includes('分钟里'));
    assert.ok(line, '应有一行时长+句数: ' + JSON.stringify(out));
    assert.match(line, /最近 40 分钟里：对方说了 3 句，你说了 2 句/);
});

test('时间太短（<5 分钟）不加时长行 —— 没信息量', () => {
    const rows = [msg('user', 'a', 0), msg('assistant', 'b', 1), msg('user', 'c', 2)];
    assert.equal(buildConversationShape(rows, T0).some((l) => l.includes('分钟里')), false);
});

test('反复出现的话会被点出来（>=3 次）', () => {
    const rows = [
        msg('user', '大家都觉得嫌弃我', 0),
        msg('assistant', '谁说你了', 1),
        msg('user', '就是所有人都嫌弃我', 5),
        msg('assistant', '具体点', 6),
        msg('user', '所有人都嫌弃我', 10)
    ];
    const out = buildConversationShape(rows, T0);
    const line = out.find((l) => l.includes('反复在说同一件事'));
    assert.ok(line, '应点出反复提及: ' + JSON.stringify(out));
    assert.match(line, /出现 3 次/);
});

test('只出现两次不点（避免噪音）', () => {
    const rows = [msg('user', '所有人都嫌弃我', 0), msg('assistant', '嗯', 1), msg('user', '所有人都嫌弃我', 2)];
    assert.equal(buildConversationShape(rows, T0).some((l) => l.includes('反复')), false);
});

test('凌晨/深夜才加时间点；正常时间不加（她本来就有当前时间）', () => {
    const rows = [msg('user', 'a啊', 0), msg('assistant', 'b啊', 1), msg('user', 'c啊', 2)];
    const night = new Date('2026-10-13T03:00:00+08:00').getTime();
    assert.ok(buildConversationShape(rows, night).some((l) => l.includes('凌晨')), '3 点应报凌晨');
    const deep = new Date('2026-10-13T23:30:00+08:00').getTime();
    assert.ok(buildConversationShape(rows, deep).some((l) => l.includes('深夜')), '23 点应报深夜');
    const noon = new Date('2026-10-13T14:00:00+08:00').getTime();
    assert.equal(buildConversationShape(rows, noon).some((l) => l.includes('现在是')), false, '下午不该加');
});

test('跨天/超长间隔会断开，只算最近这一段', () => {
    const rows = [
        msg('user', '昨天的事', -24 * 60),
        msg('assistant', '昨天的回复', -23 * 60),
        msg('user', '今天第一句', 0),
        msg('assistant', '今天回一句', 10),
        msg('user', '今天第二句', 20)
    ];
    const line = buildConversationShape(rows, T0).find((l) => l.includes('分钟里'));
    assert.ok(line);
    assert.match(line, /对方说了 2 句，你说了 1 句/, '不该把昨天那两条算进来: ' + line);
});

test('只喂事实，不喂结论（不含"情绪/状态/安慰"这类判断词）', () => {
    const rows = [
        msg('user', '我好难受', 0),
        msg('assistant', '怎么了', 1),
        msg('user', '所有人都嫌弃我', 30),
        msg('assistant', '谁啊', 31),
        msg('user', '所有人都嫌弃我', 40),
        msg('assistant', '嗯', 41),
        msg('user', '所有人都嫌弃我', 50)
    ];
    const all = buildConversationShape(rows, T0).join(' ');
    assert.equal(/情绪|心情|状态不好|需要安慰|低落/.test(all), false, '不该替她下判断: ' + all);
});
