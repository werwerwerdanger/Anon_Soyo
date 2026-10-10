// verify_burst_interval.mjs -- 真跑一遍 awaitSendSlot，验证连发时序
// 从 reply-dispatcher.js 里按标记切出真实函数体（不是抄一份），写进临时模块再 import。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const targets = [
  'C:/Users/20633/MimirLink-soyo/src/reply-dispatcher.js',
  'C:/Users/20633/MimirLink/src/reply-dispatcher.js',
];

const START = 'let lastOutboundAt = 0;';
const END = '\n// <<< send-interval patch <<<';

function extract(src) {
  const s = src.indexOf(START);
  if (s < 0) throw new Error('找不到 lastOutboundAt');
  const e = src.indexOf(END, s);
  if (e < 0) throw new Error('找不到 send-interval patch 结束标记');
  return src.slice(s, e + 1);
}

const CFG = {
  chat: {
    minSendIntervalMs: 5000,
    minSendIntervalMsPrivate: 10000,
    burstIntervalMs: 1200,
  },
};

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log('  PASS  ' + msg);
  } else {
    console.log('  FAIL  ' + msg);
    failures += 1;
  }
}

// Date.now() 会走，等待时长允许 3ms 抖动
function near(actual, expected, tol = 3) {
  return Math.abs(actual - expected) <= tol;
}

// 断言 waits 恰好是一次等待，且时长约等于 expected
function assertWait(log, expected, msg) {
  assert(log.length === 1 && near(log[0], expected),
    `${msg}（期望 ~${expected}ms，实际 ${JSON.stringify(log)}）`);
}

// 可控时钟：不真睡，只记录请求的等待时长
function makeSleep(log) {
  return (ms) => {
    log.push(ms);
    return Promise.resolve();
  };
}

for (const file of targets) {
  console.log('='.repeat(70));
  console.log(file);
  const src = fs.readFileSync(file, 'utf8');
  const body = extract(src);
  const mod = path.join(os.tmpdir(), `slottest_${Math.random().toString(36).slice(2)}.mjs`);
  // 导出函数 + 时钟复位口，便于逐个用例断言
  fs.writeFileSync(mod, body + `
export { awaitSendSlot };
export function resetLastOutbound() { lastOutboundAt = 0; }
export function peekLastOutbound() { return lastOutboundAt; }
`, 'utf8');

  const m = await import('file://' + mod.replace(/\\/g, '/'));
  const silentLog = { info: () => {} };

  // 群聊，burst=false：第一段应吃掉完整 5000ms 间隔
  m.resetLastOutbound();
  let log = [];
  await m.awaitSendSlot(CFG, makeSleep(log), silentLog, { message_type: 'group' }, false);
  assert(log.length === 0, `burst=false 首次下发不等待（无历史）  waits=${JSON.stringify(log)}`);

  // 紧接着再来一条 burst=false：应等满 5000
  log = [];
  await m.awaitSendSlot(CFG, makeSleep(log), silentLog, { message_type: 'group' }, false);
  assertWait(log, 5000, 'burst=false 紧随其后等 5000ms');

  // burst=true：同一轮内的后续分段应只等 burstIntervalMs
  m.resetLastOutbound();
  log = [];
  await m.awaitSendSlot(CFG, makeSleep(log), silentLog, { message_type: 'group' }, false);
  log = [];
  await m.awaitSendSlot(CFG, makeSleep(log), silentLog, { message_type: 'group' }, true);
  assertWait(log, 1200, 'burst=true 段间只等 1200ms');

  // burst=true 之后，下一轮第一段仍要回到 5000（跨轮保护不能被绕过）
  log = [];
  await m.awaitSendSlot(CFG, makeSleep(log), silentLog, { message_type: 'group' }, false);
  assertWait(log, 5000, 'burst 之后下一轮恢复 5000ms');

  // 私聊仍走 10000
  m.resetLastOutbound();
  log = [];
  await m.awaitSendSlot(CFG, makeSleep(log), silentLog, { message_type: 'private' }, false);
  log = [];
  await m.awaitSendSlot(CFG, makeSleep(log), silentLog, { message_type: 'private' }, false);
  assertWait(log, 10000, '私聊 burst=false 仍为 10000ms');

  // 私聊连发
  log = [];
  await m.awaitSendSlot(CFG, makeSleep(log), silentLog, { message_type: 'private' }, true);
  assertWait(log, 1200, '私聊 burst=true 段间 1200ms');

  fs.unlinkSync(mod);
}

console.log('='.repeat(70));
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
