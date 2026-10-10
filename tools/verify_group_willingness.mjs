// verify_group_willingness.mjs
// 按 §9.6 硬规则：从**目标文件本身**切出代码求值，不抄副本。
import fs from 'node:fs';

const DIRS = ['C:/Users/20633/MimirLink/src', 'C:/Users/20633/MimirLink-soyo/src'];
let fail = 0;
const assert = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail += 1; };

function extractBetween(src, startMark, endMark, label) {
  const a = src.indexOf(startMark);
  const b = src.indexOf(endMark);
  if (a < 0 || b < 0 || b <= a) throw new Error(`${label}: 找不到标记`);
  return src.slice(a + startMark.length, b);
}

// ---- 语法自检：文件必须能被 node 解析
for (const d of DIRS) {
  for (const f of ['index.js', 'reply-dispatcher.js', 'ai.js']) {
    const p = `${d}/${f}`;
    const src = fs.readFileSync(p, 'utf8');
    assert(src.includes('sticker-assertion patch') || src.includes('cobot-turn patch')
      || src.includes('cobot-truncate patch') || src.includes('reason-log-full patch'),
      `${d.split('/').pop()}/${f}: 补丁标记存在`);
  }
}

for (const SRC of DIRS) {
  const name = SRC.split('/').filter(Boolean).slice(-2)[0];
  console.log('='.repeat(74));
  console.log(name);

  // ============================================ 1) isStickerOnlyMessage
  const idx = fs.readFileSync(`${SRC}/index.js`, 'utf8');
  const helper = extractBetween(idx, '// >>> sticker-assertion patch >>>', '// <<< sticker-assertion patch <<<', 'helper');
  // 助手块 = 注释 + const STICKER_SEG_TYPES + function isStickerOnlyMessage
  // ⇒ 不能当单一表达式求值，要当函数体跑，再 return 出来。
  const isStickerOnlyMessage = new Function(`${helper}\nreturn isStickerOnlyMessage;`)();

  const cases = [
    ['纯动画表情', [{ type: 'image', summary: '[动画表情]' }], true],
    ['图 + 占位文字[图片]', [{ type: 'image' }, { type: 'text', text: '[图片]' }], true],
    ['小黄脸', [{ type: 'face' }], true],
    ['图 + 真文字', [{ type: 'image' }, { type: 'text', text: '你看这张' }], false],
    ['纯文字', [{ type: 'text', text: '在吗' }], false],
    ['空段', [], false],
    ['图 + 引用段', [{ type: 'reply' }, { type: 'image' }], true],
    ['图 + at', [{ type: 'at' }, { type: 'image' }], true],
  ];
  for (const [label, segs, want] of cases) {
    const got = isStickerOnlyMessage({ messageSegments: segs });
    assert(got === want, `isStickerOnlyMessage(${label}) = ${got}（期望 ${want}）`);
  }

  // ============================================ 2) 互怼硬截断
  const rd = fs.readFileSync(`${SRC}/reply-dispatcher.js`, 'utf8');
  const block = extractBetween(rd, '// >>> cobot-truncate patch >>>', '// <<< cobot-truncate patch <<<', 'trunc');
  const runTrunc = new Function('processedReply', 'config', 'options', 'logger', `
    let processedReply_ = processedReply;
    {
      let processedReply = processedReply_;
      ${block}
      processedReply_ = processedReply;
    }
    return processedReply_;
  `);
  const logSpy = { msg: '' };
  const lg = { info: (m) => { logSpy.msg = m; } };
  const cfg2 = { chat: { coBotMaxSentences: 2 } };

  const r1 = runTrunc('第一句。第二句。第三句。第四句。', cfg2, { isCoBotTurn: true }, lg);
  assert(r1.split('\n').filter(Boolean).length === 2, `4 句 → 截到 2 句（实得 ${JSON.stringify(r1)}）`);
  assert(logSpy.msg.includes('截断'), '截断时写了日志');

  const r2 = runTrunc('就一句。', cfg2, { isCoBotTurn: true }, lg);
  assert(r2 === '就一句。', `没超上限时不截断（实得 ${JSON.stringify(r2)}）`);

  const r3 = runTrunc('第一句。第二句。第三句。', cfg2, { isCoBotTurn: false }, lg);
  assert(r3.includes('第三句'), '非互怼轮次不截断');

  const r4 = runTrunc('甲！乙？丙。丁', { chat: {} }, { isCoBotTurn: true }, lg);
  assert(r4.includes('丁'), '没配 coBotMaxSentences 时不截断');

  const r5 = runTrunc('换行一\n换行二\n换行三', cfg2, { isCoBotTurn: true }, lg);
  assert(r5 === '换行一\n换行二', `按换行也算句边界（实得 ${JSON.stringify(r5)}）`);

  // ============================================ 3) ai.js 透传 thinking
  const ai = fs.readFileSync(`${SRC}/ai.js`, 'utf8');
  assert(/thinking: overrides\.thinking/.test(ai), 'ai.js: resolveChatOptions 透传 thinking');
  assert(/if \(options\.thinking\) payload\.thinking = options\.thinking;/.test(ai),
    'ai.js: buildChatPayload 带上 thinking');
  // 抽出 buildChatPayload 的方法体（不要抄一份），去掉结尾花括号后当函数体跑
  let methodBody = extractBetween(ai, '    buildChatPayload(messages, overrides = {}) {',
    '\n    buildToolsChatPayload', 'payload');
  methodBody = methodBody.replace(/\n\s*\}\s*$/, '');
  const buildPayload = new Function('messages', 'overrides', `${methodBody}\nreturn payload;`);
  const selfWithThink = { resolveChatOptions: () => ({ model: 'm', maxTokens: 1, temperature: 0.8, thinking: { type: 'disabled' } }) };
  const withThink = buildPayload.call(selfWithThink, [], {});
  assert(withThink.thinking && withThink.thinking.type === 'disabled', 'thinking disabled 进了 payload');
  const selfNoThink = { resolveChatOptions: () => ({ model: 'm', maxTokens: 1, temperature: 0.8 }) };
  const noThink = buildPayload.call(selfNoThink, [], {});
  assert(!('thinking' in noThink), '未要求时不带 thinking 字段');

  // ============================================ 4) 互怼轮次判定接线
  assert(/const coBotTurn = event\.message_type === 'group' && isCoBot\(config, event\);/.test(idx),
    'index.js: coBotTurn = 群聊 && 发言人∈coBotIds');
  assert(/chatAIOverrides\.thinking = \{ type: 'disabled' \};/.test(idx),
    'index.js: 互怼轮次停思考');
  assert(/isCoBotTurn: coBotTurn === true/.test(idx), 'index.js: 把标记传给 dispatchReply');
}

console.log('='.repeat(74));
console.log(fail === 0 ? 'ALL PASS' : `${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
