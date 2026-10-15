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

  // ⚠ 2026-10-13 修：这组夹具写在两个改动**之前**，四处期望值已经和现行口径相反：
  //   ① 夹具用 `{ type: 'image' }`（**没有 summary**）来表示"表情包"——
  //      但 sticker-vs-image patch 之后，`summary` 为空 + 没有 `subType` 意味着
  //      **用户上传的图/截图**，不是表情包 ⇒ 整条不该算"纯表情包"。
  //      夹具要写真表情包就得带上 `summary: '[动画表情]'`（实测的真实形状）。
  //   ② `face`（小黄脸）期望 true —— 但 builtin-face-split patch 之后 `face` 已被
  //      **故意**移出 `STICKER_SEG_TYPES`（2026-10-11 用户：「把内置表情从『默认无视
  //      表情包』里摘出来」）⇒ 内置表情不该吃 stickerReplyChance 低意愿，期望 false。
  //   顺带补上这次改动的**真事故**回归：舞萌成绩截图（summary 空）曾被判成表情包、
  //   20% 概率丢掉、连库都没入 ⇒ 表现成"她不认识我朋友的成绩"。
  const cases = [
    ['纯动画表情', [{ type: 'image', summary: '[动画表情]' }], true],
    ['动画表情 + 占位文字[图片]',
      [{ type: 'image', summary: '[动画表情]' }, { type: 'text', text: '[图片]' }], true],
    ['mface（自制大表情）', [{ type: 'mface' }], true],
    ['marketface（商店表情）', [{ type: 'marketface' }], true],
    ['小黄脸（QQ 内置表情）——已被故意移出表情包集合', [{ type: 'face' }], false],
    ['动画表情 + 真文字',
      [{ type: 'image', summary: '[动画表情]' }, { type: 'text', text: '你看这张' }], false],
    ['纯文字', [{ type: 'text', text: '在吗' }], false],
    ['空段', [], false],
    ['动画表情 + 引用段', [{ type: 'reply' }, { type: 'image', summary: '[动画表情]' }], true],
    ['动画表情 + at', [{ type: 'at' }, { type: 'image', summary: '[动画表情]' }], true],
    // 🔴 真事故回归：上传的图（summary 为空）不是表情包
    ['上传的图（summary 空）', [{ type: 'image' }], false],
    ['上传的成绩截图 + 真文字', [{ type: 'image' }, { type: 'text', text: '你看我成绩' }], false],
    ['老客户端用 subType=1 标表情包', [{ type: 'image', subType: 1 }], true],
    ['subType=0 ⇒ 上传的图', [{ type: 'image', subType: 0 }], false],
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
