/**
 * Assert the new "态度要求" block really reaches the built system message.
 * verify_character_card_v2.mjs only prints the first 400 chars, and the attitude
 * block sits far below that -- so this checks the whole string.
 */
import path from 'node:path';

const CASES = [
    // 素世是冷淡刻薄的那个 —— 但 2026-10-09 起限定「只对熟人」，
    // 因为她对陌生人也开始不客气了（礼貌是壳，这层壳对外人必须戴着）
    ['MimirLink-soyo', 'Soyo_Nagasaki',
        ['刻薄只对熟人', '这层壳必须戴着', '永远只会见到礼貌那一面'], []],
    // 爱音是亲切的那个：2026-10-09 起明确「不刻薄」，旧措辞必须彻底消失
    ['MimirLink', 'Anon_Chihaya',
        ['爱音是亲切的那一个，不是刻薄的那一个', '不会拆台', '不要用自己的名字指代自己', '施舍式的宽容'],
        ['允许刻薄', '可以抬杠、拆台、自吹自擂顺便挤兑别人']],
];

const MUST_HAVE = [
    '态度要求（同样必须遵守）',
    // 2026-10-09 起：不再要求"每条都要有反应、有立场"（那条读起来像机器），
    // 改成"长短要像真人"，同时保留"别缩成客服式"这一端，避免退回死人感
    '长短要像真人',
    '也别缩成客服式的一句话交差',
    '不做人身攻击',
    // 2026-10-09：「用别人的刀捅人」这种文学比喻飘出来了，补的格式规则
    '说人话。用手机打字的大白话',
    '不要比喻',
    // 2026-10-09：她认不出「素食」这类常见称呼，补的自称清单
    '都是在叫你',
];

let failed = 0;
for (const [inst, cardName, extraMustHave, mustNotHave] of CASES) {
    const ROOT = `C:/Users/20633/${inst}`;
    const { CharacterManager } = await import(`file:///${ROOT}/src/character.js`);
    const { WorldBookManager } = await import(`file:///${ROOT}/src/worldbook.js`);
    const { PromptBuilder } = await import(`file:///${ROOT}/src/prompt.js`);

    const dataDir = path.join(ROOT, 'data');
    const characters = new CharacterManager(dataDir);
    const worldBooks = new WorldBookManager(dataDir);
    worldBooks.scanWorldBooks?.();

    const card = characters.readFromPng(cardName);
    const builder = new PromptBuilder(characters, worldBooks, { bindings: { global: {}, characters: {} } }, console);
    const { messages } = await builder.build(
        cardName,
        '你好，你是谁？',
        { recentMessages: [], summaries: [] },
        new Set(),
        { sessionId: 'att', messageType: 'group', participants: [] }
    );
    const system = messages.map((m) => m.content).join('\n\n');

    console.log(`--- ${inst} / ${cardName}  system=${system.length} chars ---`);
    for (const needle of [...MUST_HAVE, ...(extraMustHave || [])]) {
        const ok = system.includes(needle);
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${needle}`);
        if (!ok) failed += 1;
    }
    const stale = system.includes('只留第一句就够了');
    console.log(`${stale ? 'FAIL' : 'PASS'}  old "只留第一句" line removed`);
    if (stale) failed += 1;

    for (const banned of mustNotHave || []) {
        const present = system.includes(banned);
        console.log(`${present ? 'FAIL' : 'PASS'}  dropped "${banned}"`);
        if (present) failed += 1;
    }

    const stars = (system.match(/\*/g) || []).length;
    console.log(`${stars === 0 ? 'PASS' : 'FAIL'}  literal '*' glyphs = ${stars}`);
    if (stars !== 0) failed += 1;

    // Renumbering the rule list is the easiest thing to get wrong in a text edit,
    // so assert the numbering is 1..7 (format) then consecutive (attitude).
    // Scope it to the card's OWN system_prompt -- the ~3700-char description card
    // carries its own numbered lists, which would otherwise show up here.
    const ownBlock = messages
        .map((m) => String(m.content ?? ''))
        .find((c) => c.includes('输出格式要求（必须遵守）')) || '';
    // ...and slice from the rules heading, because the same system message also
    // carries the description card, whose own numbered list starts before this.
    const rulesStart = ownBlock.indexOf('输出格式要求（必须遵守）');
    const rulesBlock = rulesStart >= 0 ? ownBlock.slice(rulesStart) : ownBlock;
    const nums = [...rulesBlock.matchAll(/(?:^|\n)\s*(\d+)\. /g)].map((m) => Number(m[1]));
    const formatOk = JSON.stringify(nums.slice(0, 7)) === JSON.stringify([1, 2, 3, 4, 5, 6, 7]);
    const attitude = nums.slice(7);
    const attitudeOk = attitude.length > 0
        && JSON.stringify(attitude) === JSON.stringify(attitude.map((_, i) => i + 8));
    console.log(`${formatOk ? 'PASS' : 'FAIL'}  format rules numbered 1..7`, JSON.stringify(nums.slice(0, 7)));
    console.log(`${attitudeOk ? 'PASS' : 'FAIL'}  attitude rules consecutive from 8`, JSON.stringify(attitude));
    if (!formatOk || !attitudeOk) failed += 1;
}
console.log('');
console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
