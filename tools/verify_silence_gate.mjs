// verify_silence_gate.mjs -- 真跑 reply-gate 的状态机 + 断言 runtime.js 的结构
import fs from 'node:fs';

const SRC = 'C:/Users/20633/MimirLink/src';
const GATE = `file:///${SRC}/reply-gate.js`;

let failures = 0;
function assert(cond, msg) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + msg);
  if (!cond) failures += 1;
}

const g = await import(GATE);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const silentLog = { info: () => {}, warn: () => {} };

console.log('='.repeat(70));
console.log('reply-gate 状态机（真跑）');

// 1) 没有状态 ⇒ 立刻放行
{
  const t0 = Date.now();
  const ok = await g.waitUntilSendable('none:1', sleep, silentLog);
  assert(ok === true && Date.now() - t0 < 50, '无状态时立刻放行');
}

// 2) 设置 holdUntil ⇒ 必须等够再放行
{
  const key = 'group:test2';
  g.beginReply(key, Date.now() + 700);
  const t0 = Date.now();
  const ok = await g.waitUntilSendable(key, sleep, silentLog);
  const dt = Date.now() - t0;
  assert(ok === true, 'holdUntil 到点后放行');
  assert(dt >= 600 && dt < 1500, `等待时长约等于 holdUntil（实测 ${dt}ms，期望 ~700ms）`);
  g.endReply(key);
}

// 3) 在途回复被新消息作废 ⇒ 必须放弃
{
  const key = 'group:test3';
  g.beginReply(key, Date.now() + 1500);
  setTimeout(() => g.noteInbound(key), 200);
  const t0 = Date.now();
  const ok = await g.waitUntilSendable(key, sleep, silentLog);
  const dt = Date.now() - t0;
  assert(ok === false, '新消息到达后放弃发送');
  assert(dt < 900, `必须及时中止而不是等满窗口（实测 ${dt}ms）`);
  g.endReply(key);
}

// 4) endReply 之后不再被旧状态影响
{
  const key = 'group:test4';
  g.beginReply(key, Date.now() + 5000);
  g.endReply(key);
  g.beginReply(key, 0);
  const t0 = Date.now();
  const ok = await g.waitUntilSendable(key, sleep, silentLog);
  assert(ok === true && Date.now() - t0 < 50, 'endReply 后新一轮不被上一轮 holdUntil 拖住');
  g.endReply(key);
}

// 5) superseded 只在 active 时设置
{
  const key = 'group:test5';
  g.noteInbound(key);            // 没有在途回复
  assert(g.isSuperseded(key) === false, '没有在途回复时 inbound 不产生作废标记');
  g.beginReply(key, 0);          // 新回复开始应清掉标记
  assert(g.isSuperseded(key) === false, 'beginReply 会清掉作废标记');
  g.noteInbound(key);            // 现在在途 ⇒ 作废
  assert(g.isSuperseded(key) === true, '有在途回复时 inbound 正确作废');
  g.endReply(key);
}

// 6) sessionKey 映射必须和 runtime 的格式一致
{
  const cases = [
    [{ message_type: 'group', group_id: 929159193 }, 'group:929159193'],
    [{ message_type: 'private', user_id: 2063362809 }, 'private:2063362809'],
    [{ group_id: 1 }, 'group:1'],
    [{}, ''],
  ];
  const bad = cases.filter(([ev, want]) => g.sessionKeyFromEvent(ev) !== want);
  assert(bad.length === 0, `sessionKey 映射正确（${bad.length} 个不符）`);
}

// 7) sleepFn 抛错时放行，不能把发送堵死
{
  const key = 'group:test7';
  g.beginReply(key, Date.now() + 1000);
  const ok = await g.waitUntilSendable(key, () => { throw new Error('boom'); }, silentLog);
  assert(ok === true, 'sleep 异常时按可发送处理（失败方向放行）');
  g.endReply(key);
}

// ---------------------------------------------------------------- runtime.js 结构断言
console.log('='.repeat(70));
console.log('runtime.js / reply-dispatcher.js 结构断言');
const rt = fs.readFileSync(`${SRC}/runtime.js`, 'utf8');
const dp = fs.readFileSync(`${SRC}/reply-dispatcher.js`, 'utf8');

assert(rt.includes("from './reply-gate.js'"), 'runtime.js 已导入闸门');
assert(dp.includes("from './reply-gate.js'"), 'reply-dispatcher.js 已导入闸门');
assert(/this\.firstBufferWindowMs = chatConfig\.firstBufferWindowMs/.test(rt), '已支持 firstBufferWindowMs');
assert(/this\.bufferPrefetchMs = chatConfig\.bufferPrefetchMs/.test(rt), '已支持 bufferPrefetchMs');
assert(rt.includes('noteInbound(item.sessionKey)'), 'enqueue 会通知闸门');
assert(rt.includes('beginReply(sessionKey,'), 'flush 会标记本轮开始');
assert(rt.includes('endReply(sessionKey)'), '批处理结束会清理');
assert(rt.includes('state.prefetchTimer = setTimeout'), '已加预生成计时器');
assert(rt.includes('prefetchTimer: null'), '缓冲状态里有 prefetchTimer');
assert(rt.includes('freshTurn'), '已实现「第一句等更久」的判定');
// 关键顺序：holdUntil 必须在 setTimeout 之前算好
assert(rt.indexOf('state.holdUntil = nowTs + silentMs') < rt.indexOf('}, silentMs);'),
  'holdUntil 在 setTimeout 之前赋值（顺序错了就不会生效）');
// dispatcher：闸门必须在实际下发之前
assert(dp.indexOf('await waitUntilSendable(gateKey') < dp.indexOf('await awaitSendSlot('),
  '闸门在 awaitSendSlot 之前（顺序反了就白等）');
assert(dp.includes('if (!sendable)'), '被作废时会放弃发送');

console.log('='.repeat(70));
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
