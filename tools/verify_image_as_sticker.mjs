// verify_image_as_sticker.mjs -- 用数据库里真实的段结构验证「表情包 → 不描述」这条路
import fs from 'node:fs';
import sqlite3 from 'node:sqlite';

const SRC = 'C:/Users/20633/MimirLink/src';
const { buildCurrentMessageFocus, formatCurrentMessageFocus } = await import(`file:///${SRC}/current-message-focus.js`);

let failures = 0;
const assert = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) failures += 1; };

function focusOf(segments, text = '') {
  return formatCurrentMessageFocus(buildCurrentMessageFocus({
    primaryStandardEvent: {
      eventType: 'message', messageType: 'private',
      segments, contentText: text,
      sender: { id: '2063362809', name: 'werwer' },
    },
    currentUserMessage: text,
  }));
}

console.log('='.repeat(74));
console.log('① 数据库里真实的 QQ 表情包结构');

// 直接从 sqlite 抓真实段，避免我凭空构造
let realSegs = null;
try {
  const db = new sqlite3.DatabaseSync('C:/Users/20633/MimirLink/data/chats/memory-store.sqlite',
    { readOnly: true });
  const rows = db.prepare(
    "SELECT metadata_json FROM messages WHERE role='user' AND session_id='private:2063362809' "
    + "AND content LIKE '%image%' ORDER BY timestamp DESC LIMIT 5"
  ).all();
  for (const r of rows) {
    const meta = JSON.parse(r.metadata_json || '{}');
    for (const ev of meta.standardEvents || []) {
      const segs = ev.segments || [];
      if (segs.some((s) => s.type === 'image')) { realSegs = segs; break; }
    }
    if (realSegs) break;
  }
  db.close();
} catch (e) {
  console.log('  (读库失败，改用等价构造:', e.message, ')');
}
if (!realSegs) realSegs = [{ type: 'image', summary: '[动画表情]', readableText: '图片:[动画表情]' }];
console.log('  使用段:', JSON.stringify(realSegs));

const focus = focusOf(realSegs);
const strategies = (focus.match(/策略: (.*)/) || [])[1] || '';
const warn = (focus.match(/注意: (.*)/) || [])[1] || '';
console.log('  意图:', (focus.match(/意图: (.*)/) || [])[1]);
console.log('  策略:', strategies);
assert(focus.includes('意图: emoji_reaction'), 'image 段被识别为 emoji_reaction（原来不是）');
assert(strategies.includes('react_to_sticker_briefly_do_not_describe_it'), '带上「对表情做反应」策略');
assert(warn.includes('不要报图里画的是什么'), '带上「不要报图里画的是什么」');
assert(warn.includes('不要描述画面细节'), '带上「不要描述画面细节」');
assert(!strategies.includes('describe_visible_emoji_or_mood'), '没有「描述表情」的旧指令');

console.log('='.repeat(74));
console.log('② 其他段类型仍然工作');
for (const t of ['face', 'mface', 'marketface']) {
  const f = focusOf([{ type: t }]);
  assert(f.includes('react_to_sticker_briefly_do_not_describe_it'), `${t} 仍然命中`);
}
const textFocus = focusOf([{ type: 'text' }], '你吉他练得怎么样');
assert(!textFocus.includes('react_to_sticker'), '纯文字不误判为表情');
assert(textFocus.includes('keep_lines_short_like_typing_on_a_phone'), '长度锚点仍在');

console.log('='.repeat(74));
console.log('③ 源码断言');
const src = fs.readFileSync(`${SRC}/current-message-focus.js`, 'utf8');
assert(/hasEmojiSegment[\s\S]{0,400}?'marketface', 'image'/.test(src)
  || src.includes("'marketface', 'image'"), "hasEmojiSegment 已包含 'image'");
assert(!src.includes("['face', 'mface', 'marketface'].includes(type)"), '旧的漏判写法已移除');

console.log('='.repeat(74));
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
