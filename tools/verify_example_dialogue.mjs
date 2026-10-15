// verify_example_dialogue.mjs -- 解析器单元测试 + 端到端确认注入进了 prompt
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'C:/Users/20633/MimirLink/src';
const { PromptBuilder } = await import(`file:///${SRC}/prompt.js`);

let failures = 0;
const assert = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) failures += 1; };

console.log('='.repeat(70));
console.log('parseExampleDialogue');

const ST = [
  '<START>',
  '{{user}}: 你吉他练得怎么样了',
  '{{char}}: 那还用说!我可是每天都在进步~',
  '{{user}}: 你昨天是不是又偷懒了',
  '{{char}}: 才、才没有!我练到手指都疼了!',
  '<START>',
  '{{char}}: 在呀!',
].join('\n');

let t = PromptBuilder.parseExampleDialogue(ST);
assert(t.length === 5, `解析出 5 轮（实际 ${t.length}）`);
assert(t[0].role === 'user' && t[0].content === '你吉他练得怎么样了', 'user 轮正确');
assert(t[1].role === 'assistant' && t[1].content === '那还用说!我可是每天都在进步~', 'assistant 轮正确（保留标点）');
assert(t[4].role === 'assistant' && t[4].content === '在呀!', '跨块续接正确');

// 边界
assert(PromptBuilder.parseExampleDialogue('').length === 0, '空串返回空数组');
assert(PromptBuilder.parseExampleDialogue(null).length === 0, 'null 安全');
assert(PromptBuilder.parseExampleDialogue('随便一段没人设标签的话').length === 0, '无标签文本不产生轮次');

// 全角冒号 / 空格容错 / 大小写
const loose = '{{USER}}: 甲\n{{ Char }} ： 乙';
const tl = PromptBuilder.parseExampleDialogue(loose);
assert(tl.length === 2, `容错解析出 2 轮（实际 ${tl.length}）`);
assert(tl[1].role === 'assistant' && tl[1].content === '乙', '全角冒号 + 空格 + 大写都能解析');

// 真实卡片里的 mes_example 必须能解出内容。
//
// ⚠ 2026-10-13 修：原来读的是 `_anon_mes.json` —— 那是一次性 dump 产物（`_*` 前缀按项目
//   约定永不发布/会被清掉）。文件一没，脚本直接 ENOENT，**后面所有断言一条都跑不到**
//   （扫描时表现为 ERR(1) 而不是 FAIL）。改成直接从角色卡读，和 verify_anon_persona.mjs
//   走同一条路（CharacterManager + 真 PromptBuilder），不再依赖任何 dump。
//
// ⚠ 同一处还修了「硬编码条数」：原来钉死 30 轮 / 20 条台词。卡一扩写就假报（现 118/72）。
//   钉死条数守的其实是「示例别被误删」，那就写成**下界 + 结构性质**：
//   下界防误删，结构性质防退化成"客服腔"或"全是长句"。这类断言只会随着卡增删保持有效。
const CARD_ROOT = 'C:/Users/20633/MimirLink';
const { CharacterManager } = await import(`file:///${CARD_ROOT}/src/character.js`);
const card = await new CharacterManager(path.join(CARD_ROOT, 'data')).loadCharacter('Anon_Chihaya');
const mes = card?.mes_example ?? '';
assert(typeof mes === 'string' && mes.length > 0, '角色卡里能读到 mes_example');

const tr = PromptBuilder.parseExampleDialogue(mes);
const chars = tr.filter((x) => x.role === 'assistant');
const lens = chars.map((x) => x.content.length);
const median = lens.slice().sort((a, b) => a - b)[Math.floor(lens.length / 2)];
console.log(`  ..  解析 ${tr.length} 轮 / 她 ${chars.length} 条；中位 ${median} 字，最长 ${Math.max(...lens)} 字`);

assert(chars.length >= 40, `她的台词够多（${chars.length} 条，下界 40 —— 防示例被误删一半）`);
assert(tr.every((x) => x.role === 'user' || x.role === 'assistant'), '只解析出 user/assistant 两种角色');
assert(chars.length > 0 && chars.every((x) => x.content.trim().length > 0), '没有空台词');
assert(Math.max(...lens) <= 30, `最长一条 ≤30 字（实际 ${Math.max(...lens)}）`);
assert(median <= 12, `中位长度 ≤12 字（实际 ${median} —— 防整体飘向长句）`);
assert(lens.filter((v) => v <= 5).length / chars.length >= 0.15,
  `短句（≤5 字）占比 ≥15%（实际 ${(lens.filter((v) => v <= 5).length / chars.length * 100).toFixed(0)}% —— 真人感靠短句）`);
const withBang = chars.filter((x) => /[!！~～]/.test(x.content));
assert(withBang.length / chars.length >= 0.25,
  `带感叹号/波浪号 ≥25%（${withBang.length}/${chars.length} = ${(withBang.length / chars.length).toFixed(2)}）`);
assert(chars.filter((x) => /[（(]/.test(x.content)).length === 0, '范例里没有括号动作描写的残留');

// 结构断言
console.log('='.repeat(70));
console.log('prompt.js 结构断言');
const pj = fs.readFileSync(`${SRC}/prompt.js`, 'utf8');
assert(pj.includes("meta: { source: 'example_dialogue' }"), '注入时带 example_dialogue 标记');
assert(pj.indexOf('const exampleTurns') < pj.indexOf('for (let index = 0; index < composition.historyMessages.length'),
  '注入位置在历史循环之前');
assert(pj.includes("(this.chatConfig || {}).exampleDialogue === false"), '开关读取正确');

console.log('='.repeat(70));
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
