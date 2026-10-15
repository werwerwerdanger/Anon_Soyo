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
    ['MimirLink', 'Anon_Chihaya', ['乐队是我拉起来的'], ['涨粉', '自拍发了搞笑视频', '我的个人账号']],
    ['MimirLink-soyo', 'Soyo_Nagasaki', null, ['涨粉']],
];

/**
 * 「她自己的人设素材」必须**在卡里活着**（不限于 first_mes）。
 *
 * 2026-10-13 修：原来这里断言的是两句逐字台词 ——「这个乐队是我拉起来的」「演出服也是我做的」。
 * 卡后来重写过，first_mes 变成「乐队是我拉起来的哦」（**少了个"这个"**，逐字断言就挂了），
 * 而"设计演出服"整条从 first_mes 挪进了 description。所以真正该守的不变量是
 * 「这两条人设素材没被弄丢」，而不是「某一句台词逐字还在」——
 * 前者跟着卡走，后者每次改文案就假报一次。
 */
const OWN_MATERIAL = ['乐队是我拉起来的', '演出服'];

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
    // 只在 anon 这一例上守「人设素材没丢」：soyo 的 mustHave 是 null（那两张卡本来就没这条素材）
    if (mustHave) {
        for (const item of OWN_MATERIAL) {
            check(all.includes(item), `own material "${item}" survives somewhere in the prompt`);
        }
    }
    console.log('');
}

console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
