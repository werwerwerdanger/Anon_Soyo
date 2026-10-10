/**
 * Verify the card-v2-flatten patch (patch_character_card_v2.py).
 *
 * Calls the real PromptBuilder.build() with a synthetic context and asserts that
 * the persona segments actually make it into the system message. Reading the card
 * back is necessary but not sufficient -- the point is whether prompt.js emits
 * 【角色描述】/【<name>的性格】/【场景】. Before the patch, none of them existed.
 *
 *   node verify_character_card_v2.mjs            # soyo instance
 *   node verify_character_card_v2.mjs MimirLink  # anon instance
 */
import path from 'node:path';

const INSTANCE = process.argv[2] || 'MimirLink-soyo';
const ROOT = `C:/Users/20633/${INSTANCE}`;

const { CharacterManager } = await import(`file:///${ROOT}/src/character.js`);
const { WorldBookManager } = await import(`file:///${ROOT}/src/worldbook.js`);
const { PromptBuilder } = await import(`file:///${ROOT}/src/prompt.js`);

const cardFile = INSTANCE === 'MimirLink-soyo'
    ? 'Soyo_Nagasaki'
    : (process.argv[3] || 'Anon_Chihaya');

const dataDir = path.join(ROOT, 'data');
const characters = new CharacterManager(dataDir);
const worldBooks = new WorldBookManager(dataDir);
worldBooks.scanWorldBooks?.();

const card = characters.readFromPng(cardFile);
console.log(`instance   : ${INSTANCE}`);
console.log(`card       : ${cardFile}`);
console.log(`spec       : ${card.spec} ${card.spec_version}`);
console.log(`name       : ${JSON.stringify(card.name)}`);
console.log(`description: ${String(card.description || '').length} chars`);
console.log(`personality: ${String(card.personality || '').length} chars`);
console.log(`scenario   : ${String(card.scenario || '').length} chars`);
console.log(`first_mes  : ${String(card.first_mes || '').length} chars`);
console.log(`data kept  : ${!!(card.data && card.data.name)} (needed for the PNG round-trip)`);
console.log('');

const builder = new PromptBuilder(characters, worldBooks, { bindings: { global: {}, characters: {} } }, console);
const { messages } = await builder.build(
    cardFile,
    '你好，你是谁？',
    { recentMessages: [], summaries: [] },
    new Set(),
    { sessionId: 'verify', messageType: 'group', participants: [] }
);

const system = messages.map((m) => m.content).join('\n\n');
const checks = [
    ['【角色描述】 segment', system.includes('【角色描述】')],
    ['character description text', String(card.description || '').slice(0, 40) && system.includes(String(card.description).slice(0, 40))],
    ['personality segment', system.includes('的性格】') || String(card.personality || '') === ''],
    ['scenario segment', String(card.scenario || '') === '' || system.includes('【场景】')],
    ['system message not empty', system.trim().length > 200],
];

let failed = 0;
for (const [label, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
    if (!ok) failed += 1;
}

console.log('');
console.log(`system message: ${system.length} chars`);
console.log('---- first 400 chars ----');
console.log(system.slice(0, 400));
console.log('--------------------------------------------');
console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
