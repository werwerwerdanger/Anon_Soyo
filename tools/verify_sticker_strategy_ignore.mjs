// verify_sticker_strategy_ignore.mjs
// 真跑 buildCurrentMessageFocus（从目标文件本身 import，不抄副本），
// 确认收到表情包时：策略里**没有**任何"做反应"的指令，且与「注意:」行口径一致。
import fs from 'node:fs';

const DIRS = ['C:/Users/20633/MimirLink/src', 'C:/Users/20633/MimirLink-soyo/src'];

let failures = 0;
const assert = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) failures += 1; };

// QQ 表情包在 OneBot 里实测是 image（summary "[动画表情]"），face/mface/marketface 也一并覆盖
const STICKER_SEGS = [
  { type: 'image', data: { summary: '[动画表情]', file: 'x.jpg' } },
  { type: 'face', data: { id: '1' } },
  { type: 'mface', data: {} },
  { type: 'marketface', data: {} },
];

for (const SRC of DIRS) {
  console.log('='.repeat(72));
  console.log(SRC);

  // 先确认补丁的源码真的在磁盘上（别验证一个没打上的补丁）
  const raw = fs.readFileSync(`${SRC}/current-message-focus.js`, 'utf8');
  assert(raw.includes('ignore_sticker_keep_talking_about_text'), '源码含新策略名');
  assert(!raw.includes("strategies.push('react_to_sticker_briefly_do_not_describe_it')"),
    '源码里旧 push 已消失');

  const { buildCurrentMessageFocus, formatCurrentMessageFocus } =
    await import(`file:///${SRC}/current-message-focus.js?t=${Date.now()}`);

  for (const seg of STICKER_SEGS) {
    const text = formatCurrentMessageFocus(buildCurrentMessageFocus({
      primaryStandardEvent: {
        eventType: 'message',
        messageType: 'private',
        segments: [seg],
        contentText: '',
        sender: { id: '2063362809', name: 'werwer' },
      },
      currentUserMessage: '',
    }));
    const strat = (text.match(/策略: (.*)/) || [])[1] || '';
    const warn = (text.match(/注意: (.*)/) || [])[1] || '';
    console.log(`  [${seg.type}] 策略: ${strat}`);

    assert(strat.includes('ignore_sticker_keep_talking_about_text'),
      `${seg.type}: 策略已改为"忽略表情包、接着聊文字"`);
    // 关键词级断言：策略里不能出现任何"去反应"的动词
    const REACT_WORDS = ['react', 'describe', 'acknowledge', 'briefly'];
    const badWord = REACT_WORDS.find((w) => strat.includes(w));
    assert(!badWord, `${seg.type}: 策略里无"反应/描述"类词（命中: ${badWord || '无'}）`);
    assert(!strat.includes('describe_visible_emoji_or_mood'), `${seg.type}: 无旧描述指令`);

    // 策略与警告必须同口径，不能一个说"react"一个说"当没发过"
    assert(warn.includes('默认不用管表情包'), `${seg.type}: 注意行仍是"默认不用管"`);
    assert(!/笑一下|吐槽一句|做.*反应/.test(text), `${seg.type}: 整块里无"做反应"话术`);
  }

  // 纯文字消息不该被这条规则碰掉
  const plain = formatCurrentMessageFocus(buildCurrentMessageFocus({
    primaryStandardEvent: {
      eventType: 'message', messageType: 'private',
      segments: [{ type: 'text' }], contentText: '你吉他练得怎么样',
      sender: { id: '2063362809', name: 'werwer' },
    },
    currentUserMessage: '你吉他练得怎么样',
  }));
  assert(!plain.includes('ignore_sticker_keep_talking_about_text'), '纯文字消息不带表情策略');
  assert(!plain.includes('默认不用管表情包'), '纯文字消息不带表情警告');
  assert(plain.includes('keep_lines_short_like_typing_on_a_phone'), '长度锚点仍在（没被这次改动碰掉）');
}

console.log('='.repeat(72));
console.log(failures === 0 ? 'ALL PASS' : `${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
