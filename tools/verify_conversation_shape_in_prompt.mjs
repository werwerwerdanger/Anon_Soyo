/**
 * verify_conversation_shape_in_prompt.mjs
 * ---------------------------------------------------------------------------
 * 验证「这段对话的形状」真的进了**装配后的系统提示词**（不是只在代码里）。
 *
 * 起因（2026-10-13）：用户观察到 WorkBuddy 的 agent 能从日志看出「这不像在测机器人」，
 * 而机器人看不出来 —— 查证发现她的【会话感知】只有 4 个字段，**没有"形状"**。
 * 已加：时长/双方句数、反复出现的话、不正常的时间点（`buildConversationShape`，纯计算）。
 *
 * ⚠ 为什么要单独验"进没进 prompt"：本项目踩过多次"代码里改了但没生效"
 *   （注入被截断、config 没加载、prefix 打错……）。所以这一段必须看**装配产物**。
 *
 * 用法:  node verify_conversation_shape_in_prompt.mjs
 */
import path from 'node:path';

let failed = 0;
const log = (ok, label, extra = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
    if (!ok) failed += 1;
};

const ROOT = 'C:/Users/20633/MimirLink';
const CARD = 'Anon_Chihaya';
const { CharacterManager } = await import(`file:///${ROOT}/src/character.js`);
const { WorldBookManager } = await import(`file:///${ROOT}/src/worldbook.js`);
const { PromptBuilder } = await import(`file:///${ROOT}/src/prompt.js`);

const dataDir = path.join(ROOT, 'data');
const characters = new CharacterManager(dataDir);
const worldBooks = new WorldBookManager(dataDir);
worldBooks.scanWorldBooks?.();
const builder = new PromptBuilder(characters, worldBooks, { bindings: { global: {}, characters: {} } }, console);

async function buildWith(recentMessages) {
    const { messages } = await builder.build(
        CARD,
        '我好难受',
        { recentMessages, summaries: [] },
        new Set(),
        { sessionId: 'shape-check', messageType: 'private', participants: [] }
    );
    const system = messages.map((m) => m.content).join('\n\n');
    const at = system.indexOf('【会话感知】');
    const block = at >= 0 ? system.slice(at, system.indexOf('\n\n', at) >= 0 ? system.indexOf('\n\n', at) : at + 400) : '';
    return { system, block };
}

const T2AM = new Date('2026-10-13T02:00:00+08:00').getTime();
const m = (role, content, offMin) => ({ role, content, timestamp: T2AM + offMin * 60000 });

// ── 场景 A：凌晨、连着聊、同一件事反复说（就是那晚的样子）
const A = [
    m('user', '爱音我好难受', 0),
    m('assistant', '怎么了', 1),
    m('user', '大家都觉得嫌弃我', 6),
    m('assistant', '谁啊 说', 7),
    m('user', '所有人都嫌弃我', 20),
    m('assistant', '我在呢', 21),
    m('user', '就是所有人都嫌弃我', 40)
];
const a = await buildWith(A);
console.log('=== 场景 A（凌晨 + 40 分钟 + 反复）===');
console.log(a.block || '(没有【会话感知】块)');
console.log();
log(a.block.includes('【会话感知】'), '块还在');
log(/最近 4\d 分钟里：对方说了 4 句/.test(a.block), '有"时长 + 双方句数"', a.block.match(/最近[^\n]*/)?.[0] || '');
log(a.block.includes('反复在说同一件事'), '有"反复在说同一件事"', a.block.match(/对方反复[^\n]*/)?.[0] || '');
// ⚠ 这条**不能**在这里断言：真装配走的是 `Date.now()`，脚本无法把"现在"设成凌晨。
//    「凌晨/深夜才加时间点」这条逻辑在单测 `tests/conversation-shape.test.js` 里
//    用注入的 now 覆盖（3 点→凌晨、23 点→深夜、14 点→不加）✓
log(a.block.includes('会话ID'), '原来的 4 个字段没丢');
log(!/情绪|心情|需要安慰|低落|状态不好/.test(a.block), '不替她下结论（无"情绪/安慰"这类词）');

// ── 场景 B：白天、只有两三轮 ⇒ 不该加噪音行
const T_NOON = new Date('2026-10-13T14:00:00+08:00').getTime();
const B = [
    { role: 'user', content: '在吗', timestamp: T_NOON },
    { role: 'assistant', content: '在', timestamp: T_NOON + 60000 },
    { role: 'user', content: '帮我看看这个', timestamp: T_NOON + 120000 }
];
const b = await buildWith(B);
console.log('=== 场景 B（下午、刚开头）===');
console.log(b.block || '(没有块)');
console.log();
log(!b.block.includes('分钟里'), '短对话不加"时长"行');
log(!b.block.includes('现在是'), '正常时间不加"现在是"行');
log(b.block.includes('会话ID'), '原字段仍在');

console.log();
console.log(failed === 0 ? '=== ALL CHECKS PASSED ===' : `=== ${failed} CHECK(S) FAILED ===`);
process.exit(failed === 0 ? 0 : 1);
