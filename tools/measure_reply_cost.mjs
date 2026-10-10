/**
 * Measure the REAL per-reply prompt size for an instance, from its live session DB.
 * Answers "群里消息多会不会烧 token" with numbers instead of guesses.
 *
 * Reads history straight out of data/chats/memory-store.sqlite (SessionManager's
 * own getContext() needs a live constructor path we do not want here), then feeds
 * it through the real PromptBuilder so the system block is the real one.
 *
 *   node measure_reply_cost.mjs [instance] [card] [sessionId ...]
 */
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const INSTANCE = process.argv[2] || 'MimirLink-soyo';
const CARD = process.argv[3] || 'Soyo_Nagasaki';
const SESSIONS = process.argv.slice(4);
const ROOT = `C:/Users/20633/${INSTANCE}`;

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const { CharacterManager } = await import(`file:///${ROOT}/src/character.js`);
const { WorldBookManager } = await import(`file:///${ROOT}/src/worldbook.js`);
const { PromptBuilder } = await import(`file:///${ROOT}/src/prompt.js`);
const { buildToolPhaseMessages } = await import(`file:///${ROOT}/src/tools.js`);

const dataDir = path.join(ROOT, 'data');
const characters = new CharacterManager(dataDir);
const worldBooks = new WorldBookManager(dataDir);
worldBooks.scanWorldBooks?.();
const quiet = { info() {}, warn() {}, debug() {}, error() {} };
const builder = new PromptBuilder(characters, worldBooks, config, quiet);
const limit = config.chat.historyLimit || 30;

const db = new DatabaseSync(path.join(dataDir, 'chats', 'memory-store.sqlite'), { readOnly: true });
const q = db.prepare('SELECT role, content, timestamp, date_iso, metadata_json FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?');

for (const SESSION of SESSIONS) {
    const rows = q.all(SESSION, limit).reverse();
    const recentMessages = rows.map((r) => ({
        role: r.role,
        content: r.content,
        timestamp: r.timestamp,
        date: r.date_iso,
        metadata: JSON.parse(r.metadata_json || '{}')
    }));

    const ctx = { sessionId: SESSION, recentMessages, summaries: [], stickyKeys: [] };
    const { messages } = await builder.build(
        CARD, '你好，你是谁？', ctx, new Set(),
        { sessionId: SESSION, messageType: SESSION.startsWith('group') ? 'group' : 'private', participants: [] }
    );
    const sysChars = messages.filter((m) => m.role === 'system').reduce((a, m) => a + m.content.length, 0);
    const histChars = messages.filter((m) => m.role !== 'system').reduce((a, m) => a + String(m.content).length, 0);

    const toolMsgs = buildToolPhaseMessages(messages, ['（工具说明占位）'], { characterName: CARD, chatScope: SESSION });
    const toolSys = toolMsgs.filter((m) => m.role === 'system').reduce((a, m) => a + m.content.length, 0);
    const toolHist = toolMsgs.filter((m) => m.role !== 'system').reduce((a, m) => a + String(m.content).length, 0);

    const total = sysChars + histChars + toolSys + toolHist;
    console.log(`===== ${SESSION} (historyLimit=${limit}) =====`);
    console.log(`  history pulled from db : ${recentMessages.length} msgs`);
    console.log(`  reply phase : system ${sysChars} + history ${histChars} = ${sysChars + histChars} chars`);
    console.log(`  tool  phase : system ${toolSys} + history ${toolHist} = ${toolSys + toolHist} chars`);
    console.log(`  BOTH CALLS  : ${total} chars  ≈ ${Math.round(total * 0.45)}–${Math.round(total * 0.7)} tokens`);
    for (const m of messages.filter((x) => x.role === 'system')) {
        console.log(`      [sys] ${String(m.content.length).padStart(6)}  ${m.meta?.source || '?'}`);
    }
    console.log('');
}
