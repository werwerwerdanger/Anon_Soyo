// verify_example_dialogue.mjs -- 解析器单元测试 + 端到端确认注入进了 prompt
import fs from 'node:fs';

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

// 真实卡片里的 mes_example 必须能解出内容
const real = fs.readFileSync('C:/Users/20633/WorkBuddy/2026-05-28-17-36-40/mimir-tools/_anon_mes.json', 'utf8');
const mes = JSON.parse(real).mes_example;
const tr = PromptBuilder.parseExampleDialogue(mes);
assert(tr.length === 30, `卡片 mes_example 解析出 30 轮（实际 ${tr.length}）`);
const chars = tr.filter((x) => x.role === 'assistant');
assert(chars.length === 20, `其中她自己的台词 20 条（实际 ${chars.length}）`);
const long = chars.filter((x) => x.content.length > 20);
assert(long.length === 0, `范例里没有超过 20 字的（最长 ${Math.max(...chars.map((x) => x.content.length))}）`);
const withBang = chars.filter((x) => /[!！~～]/.test(x.content));
assert(withBang.length / chars.length >= 0.5,
  `范例一半以上带感叹号/波浪号（${withBang.length}/${chars.length}）`);
const withParen = chars.filter((x) => /[（(]/.test(x.content));
assert(withParen.length === 0, '范例里没有括号动作描写的残留');

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
