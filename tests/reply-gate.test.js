/**
 * reply-gate 的闸门语义测试（2026-10-13 新建）
 *
 * 背景：原来「只要有新消息就作废在途回复」，用户实测**私聊被作废 17 次** ——
 * 连打时每来一句就吃掉上一句已生成好的回复 ⇒ 用户看到漏答 + 跳答
 * （他自己发了「你是不是又死了」）。改成"只有判出换了话题才作废"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isTopicSwitch,
    noteInbound,
    beginReply,
    endReply,
    isSuperseded,
    getSupersededReason
} from '../src/reply-gate.js';

test('isTopicSwitch: 短句一律当"接着说"，不判换话题', () => {
    assert.equal(isTopicSwitch('爱音我好难受', '嗯嗯'), false);
    assert.equal(isTopicSwitch('爱音我好难受', '不知道'), false);          // 3 字 < 8
    assert.equal(isTopicSwitch('爱音我好难受', '[图片]'), false);          // 占位文本归一化后为空
});

test('isTopicSwitch: 有词面重叠 ⇒ 接着说', () => {
    assert.equal(isTopicSwitch('大家都觉得嫌弃我', '就是所有人都嫌弃我'), false);
    assert.equal(isTopicSwitch('你说那首歌叫什么', '那首歌我忘了'), false);
});

test('isTopicSwitch: 够长 + 零词面重叠 ⇒ 换话题', () => {
    assert.equal(isTopicSwitch('爱音我好难受', '你昨天说的那首翻唱叫什么来着'), true);
});

test('isTopicSwitch: 本轮文本为空 ⇒ 不判换话题（保守，宁可多发）', () => {
    assert.equal(isTopicSwitch('', '你昨天说的那首翻唱叫什么来着'), false);
    assert.equal(isTopicSwitch(null, '随便一句够长的话都算'), false);
});

test('noteInbound: 有在途回复 + 新消息接着说 ⇒ 不作废（原来会作废）', () => {
    const sk = 'private:1001';
    beginReply(sk, Date.now() + 1000, '大家都觉得嫌弃我');
    noteInbound(sk, '就是所有人都嫌弃我');       // 有重叠 ⇒ 接着说
    assert.equal(isSuperseded(sk), false);
    assert.equal(getSupersededReason(sk), 'related_keep');
    endReply(sk);
});

test('noteInbound: 有在途回复 + 新消息换了话题 ⇒ 作废', () => {
    const sk = 'private:1002';
    beginReply(sk, Date.now() + 1000, '爱音我好难受');
    noteInbound(sk, '你昨天说的那首翻唱叫什么来着');
    assert.equal(isSuperseded(sk), true);
    assert.equal(getSupersededReason(sk), 'topic_switch');
    endReply(sk);
});

test('noteInbound: 没有在途回复时什么都不发生', () => {
    const sk = 'private:1003';
    noteInbound(sk, '随便一句够长的话都算换话题吗');
    assert.equal(isSuperseded(sk), false);
});

test('beginReply 会清掉上一轮的作废标记', () => {
    const sk = 'private:1004';
    beginReply(sk, Date.now() + 1000, '爱音我好难受');
    noteInbound(sk, '你昨天说的那首翻唱叫什么来着');
    assert.equal(isSuperseded(sk), true);
    beginReply(sk, Date.now() + 1000, '新的一轮目标文本');
    assert.equal(isSuperseded(sk), false);
    endReply(sk);
});

test('归一化：占位文本/标点/空白不参与比较', () => {
    // 「[图片]」被剥掉后，新消息其实是空的 ⇒ 短句 ⇒ 接着说
    assert.equal(isTopicSwitch('这是一句够长的目标文本', '[图片][动画表情] ...'), false);
});
