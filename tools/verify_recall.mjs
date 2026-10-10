// verify_recall.mjs -- 真跑撤回：临时库真插入真删除 + runtime 缓冲真移除
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SRC = 'C:/Users/20633/MimirLink/src';
const { SessionManager } = await import(`file:///${SRC}/session.js`);
const { MessageRuntime } = await import(`file:///${SRC}/runtime.js`);

let failures = 0;
const assert = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) failures += 1; };
const silent = { debug() {}, info() {}, warn() {}, error() {} };

// ---------------------------------------------------------------- session 层
console.log('='.repeat(70));
console.log('deleteRecalledMessage（临时库真跑）');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-'));
const sm = new SessionManager(dir, { chat: { historyLimit: 50 } }, silent);
const SID = 'private:999';

const mkMeta = (ids, events) => ({
  messageType: 'private', userId: 999,
  inboundMessageIds: ids,
  standardEvents: events,
  mergedCount: ids.length,
});

// ① 单条行 —— 撤回应当整行删除
sm.addMessage(SID, 'user', '内容-单条-alpha', mkMeta(['1001'], [{ messageId: '1001', rawText: 'alpha' }]));
sm.addMessage(SID, 'user', '内容-单条-beta', mkMeta(['1002'], [{ messageId: '1002', rawText: 'beta' }]));
let r = sm.deleteRecalledMessage(SID, '1001');
let rows = sm.getHistory(SID, 50);
assert(r.removed === 1 && r.stripped === 0, `单条行被整行删除（removed=${r.removed} stripped=${r.stripped}）`);
assert(rows.length === 1 && !JSON.stringify(rows).includes('alpha'), '被撤回那条已不在历史里');

// ② 合并行 —— 只摘撤回那条，不能误伤同批其他消息
sm.addMessage(SID, 'user', '内容-合并-keep1 beta-keep2', mkMeta(
  ['2001', '2002'],
  [{ messageId: '2001', rawText: 'keep1' }, { messageId: '2002', rawText: 'beta-keep2' }]
));
r = sm.deleteRecalledMessage(SID, '2002');
rows = sm.getHistory(SID, 50);
const merged = rows.find((x) => String(x.content).includes('内容-合并'));
assert(r.removed === 0 && r.stripped === 1, `合并行走"摘除"而不是删除（removed=${r.removed} stripped=${r.stripped}）`);
assert(merged && !String(merged.content).includes('beta-keep2'), '撤回的正文已从合并行移除');
assert(merged && String(merged.content).includes('keep1'), '同批的其他消息**没有**被误删（这是关键）');
// getHistory 不返回 metadata_json，直接查库确认 id 列表被清理
const metaRow = sm.db.prepare(
  'SELECT metadata_json FROM messages WHERE session_id = ? AND content LIKE ?'
).get(SID, '%内容-合并%');
const meta2 = JSON.parse(metaRow.metadata_json);
assert(meta2.inboundMessageIds.length === 1 && meta2.inboundMessageIds[0] === '2001',
  '合并行的 inboundMessageIds 已清理');
assert(meta2.standardEvents.length === 1 && String(meta2.standardEvents[0].messageId) === '2001',
  '合并行的 standardEvents 已清理');

// ③ 撤回一条不存在的消息 —— 必须无副作用
const before = sm.getHistory(SID, 50).length;
r = sm.deleteRecalledMessage(SID, '999999');
assert(r.removed === 0 && r.stripped === 0 && sm.getHistory(SID, 50).length === before,
  '撤回不存在的 id 不会动任何数据');

// ④ 空 id —— 必须安全返回
r = sm.deleteRecalledMessage(SID, '');
assert(r.removed === 0 && r.stripped === 0, '空 messageId 安全返回');

// ---------------------------------------------------------------- runtime 层
console.log('='.repeat(70));
console.log('dropBufferedMessage（真跑 enqueue）');
const runtime = new MessageRuntime({ chat: { bufferWindowMs: 60000, firstBufferWindowMs: 60000 } }, silent,
  async () => {});
const KEY = 'private:999';
const mkItem = (id, text) => ({
  sessionKey: KEY, dedupeKey: `k-${id}`, plainText: text, structuredText: text,
  event: { message_type: 'private', user_id: 999, message_id: String(id) },
});
runtime.enqueue(mkItem(3001, '第一条'));
runtime.enqueue(mkItem(3002, '第二条'));
runtime.enqueue(mkItem(3003, '第三条'));
assert(runtime.getStats().bufferedMessages === 3, '三条已入缓冲');

const dropped = runtime.dropBufferedMessage(KEY, '3002');
assert(dropped === 1, `从缓冲摘掉 1 条（实际 ${dropped}）`);
assert(runtime.getStats().bufferedMessages === 2, '缓冲剩 2 条');
const left = runtime.buffers.get(KEY).items.map((i) => i.plainText);
assert(!left.includes('第二条') && left.includes('第一条') && left.includes('第三条'),
  `摘掉的是指定那条，其余不动（剩余 ${JSON.stringify(left)}）`);

const dropped2 = runtime.dropBufferedMessage(KEY, '8888');
assert(dropped2 === 0, '摘不存在的 id 返回 0');

// ---------------------------------------------------------------- 结构断言
console.log('='.repeat(70));
console.log('index.js 接线断言');
const ix = fs.readFileSync(`${SRC}/index.js`, 'utf8');
assert(ix.includes("event.notice_type === 'group_recall'"), '已接群聊撤回通知');
assert(ix.includes("event.notice_type === 'friend_recall'"), '已接私聊撤回通知');
assert(ix.includes('handleRecallEvent(event)'), '撤回分支已调用处理函数');
// 在 bot.on('message') 处理块里，撤回分支必须排在 handleMessage 之前
const blockStart = ix.indexOf("bot.on('message', (event) => {");
const block = blockStart >= 0 ? ix.slice(blockStart, blockStart + 1200) : '';
const iRecall = block.indexOf('group_recall');
const iFallthrough = block.indexOf('    handleMessage(event);');
assert(blockStart >= 0 && iRecall > 0 && iFallthrough > 0 && iRecall < iFallthrough,
  '撤回分支在 handleMessage 之前（顺序反了会被当普通消息处理）');

try { sm.close(); } catch { /* 已关或已释放 */ }
try {
  fs.rmSync(dir, { recursive: true, force: true });
} catch {
  console.log('  (临时目录被句柄占用，跳过清理)');
}
console.log('='.repeat(70));
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
