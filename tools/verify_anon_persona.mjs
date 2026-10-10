/**
 * Guard against the persona-swap bug of 2026-10-09: Anon's first_mes had been written
 * with 喵梦 (Nyamu / 祐天寺若麦)'s premise -- "我账号涨粉卡住了 / 自拍发了搞笑视频".
 * Nyamu is the beauty-streamer who chases view counts; Anon merely RUNS MyGO!!!!!'s
 * social account and WATCHES beauty videos.
 *
 * Checks, end to end through the real PromptBuilder:
 *   1. the "涨粉" premise appears nowhere in the built messages
 *   2. first_mes is injected as an assistant message (meta.source = first_message)
 *   3. the new Anon first_mes carries her own material (starts the band / designs outfits)
 *
 *   node verify_anon_persona.mjs
 */
import path from 'node:path';

const CASES = [
    ['MimirLink', 'Anon_Chihaya', ['这个乐队是我拉起来的', '演出服也是我做的'], ['涨粉', '自拍发了搞笑视频', '我的个人账号']],
    ['MimirLink-soyo', 'Soyo_Nagasaki', null, ['涨粉']],
];

let failed = 0;
const check = (ok, label, extra = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
    if (!ok) failed++;
};

for (const [inst, cardName, mustHave, mustNotHave] of CASES) {
    const ROOT = `C:/Users/20633/${inst}`;
    const { CharacterManager } = await import(`file:///${ROOT}/src/character.js`);
    const { WorldBookManager } = await import(`file:///${ROOT}/src/worldbook.js`);
    const { PromptBuilder } = await import(`file:///${ROOT}/src/prompt.js`);

    const dataDir = path.join(ROOT, 'data');
    const characters = new CharacterManager(dataDir);
    const worldBooks = new WorldBookManager(dataDir);
    worldBooks.scanWorldBooks?.();

    const builder = new PromptBuilder(characters, worldBooks, { bindings: { global: {}, characters: {} } }, console);
    const { messages } = await builder.build(
        cardName,
        '你好，你是谁？',
        { recentMessages: [], summaries: [] },
        new Set(),
        { sessionId: 'persona', messageType: 'group', participants: [] }
    );

    const all = messages.map((m) => String(m.content ?? '')).join('\n\n');
    const firstMsgs = messages.filter((m) => m.meta?.source === 'first_message');
    const firstText = firstMsgs.map((m) => String(m.content ?? '')).join('\n');

    console.log(`--- ${inst} / ${cardName}  msgs=${messages.length}  first_message msgs=${firstMsgs.length} ---`);

    check(firstMsgs.length > 0, 'first_mes is injected into the prompt');
    if (firstMsgs.length) {
        check(firstMsgs.every((m) => m.role === 'assistant'), 'first_mes arrives as an assistant message',
            firstMsgs.map((m) => m.role).join(','));
    }

    for (const bad of mustNotHave) {
        check(!all.includes(bad), `"${bad}" appears nowhere in the prompt`);
    }
    for (const good of mustHave ?? []) {
        check(firstText.includes(good), `first_mes carries "${good}"`);
    }
    console.log('');
}

console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
