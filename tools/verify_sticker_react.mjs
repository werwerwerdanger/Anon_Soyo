// verify_sticker_react.mjs -- 真跑 buildCurrentMessageFocus，确认收到表情时的策略变了
import fs from 'node:fs';

const SRC = 'C:/Users/20633/MimirLink/src';
const { buildCurrentMessageFocus, formatCurrentMessageFocus } = await import(`file:///${SRC}/current-message-focus.js`);

let failures = 0;
const assert = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) failures += 1; };

console.log('='.repeat(70));
console.log('收到表情包时的策略（真跑）');

// QQ 表情包在 OneBot 里是 face / mface / marketface 段
for (const segType of ['face', 'mface', 'marketface']) {
  const focus = buildCurrentMessageFocus({
    primaryStandardEvent: {
      eventType: 'message',
      messageType: 'private',
      segments: [{ type: segType }],
      contentText: '',
      sender: { id: '2063362809', name: 'werwer' },
    },
    currentUserMessage: '',
  });
  const text = formatCurrentMessageFocus(focus);
  const line = (text.match(/策略: (.*)/) || [])[1] || '';
  console.log(`  [${segType}] 策略: ${line}`);
  assert(!line.includes('describe_visible_emoji_or_mood'),
    `${segType}: 不再有"描述表情"指令`);
  assert(line.includes('react_to_sticker_briefly_do_not_describe_it'),
    `${segType}: 已改为"对表情做反应"`);
  assert((text.match(/注意: (.*)/) || [])[1]?.includes('不要报图里画的是什么') === true,
    `${segType}: 注意行里有中文提示`);
}

// 纯文字消息不该被这条规则影响
console.log('='.repeat(70));
console.log('纯文字消息不受影响');
const plain = formatCurrentMessageFocus(buildCurrentMessageFocus({
  primaryStandardEvent: {
    eventType: 'message', messageType: 'private',
    segments: [{ type: 'text' }], contentText: '你吉他练得怎么样',
    sender: { id: '2063362809', name: 'werwer' },
  },
  currentUserMessage: '你吉他练得怎么样',
}));
assert(!plain.includes('react_to_sticker'), '纯文字消息不带表情策略');
assert(!plain.includes('不要报图里画的是什么'), '纯文字消息不带表情警告');
assert(plain.includes('keep_lines_short_like_typing_on_a_phone'), '长度锚点仍在（没被这次改动碰掉）');

// 结构断言
console.log('='.repeat(70));
console.log('源码断言');
const src = fs.readFileSync(`${SRC}/current-message-focus.js`, 'utf8');
assert(!src.includes("push('describe_visible_emoji_or_mood')"), '旧的 push 调用已彻底移除');
assert(src.includes("push('react_to_sticker_briefly_do_not_describe_it')"), '新策略已就位');

console.log('='.repeat(70));
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
