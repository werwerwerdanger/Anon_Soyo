/**
 * Verify the repeat-suppression key against the REAL source text.
 *
 * Scenario under test (2026-10-09 20:28, soyo private chat): the user sent
 * 「我是来结束这一切的」 nine times in ~40s and the bot answered seventeen lines,
 * counting them out loud ("第三遍了 / 第四次了"). The old dedupeKey was built from
 * event.message_id, which QQ re-mints on every send, so nothing was ever deduped.
 *
 * Also replays runtime.js's dedupe semantics to show how many replies survive.
 *
 *   node verify_repeat_suppress.mjs
 */
import fs from 'node:fs';

function extractFunction(src, name) {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`function ${name} not found`);
    let i = -1;
    let paren = 0;
    for (let k = src.indexOf('(', start); k < src.length; k++) {
        if (src[k] === '(') paren++;
        else if (src[k] === ')') paren--;
        else if (src[k] === '{' && paren === 0) { i = k; break; }
    }
    if (i < 0) throw new Error(`body brace not found for ${name}`);
    let depth = 0;
    for (let j = i; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
    }
    throw new Error(`unbalanced braces for ${name}`);
}

let failed = 0;
const check = (ok, label, extra = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
    if (!ok) failed++;
};

const LINE = '我是来结束这一切的';
const TIMES = [0, 4, 8, 12, 18, 24, 30, 37, 44]; // seconds, from the real log

for (const inst of ['MimirLink', 'MimirLink-soyo']) {
    const ROOT = `C:/Users/20633/${inst}`;
    const src = fs.readFileSync(`${ROOT}/src/index.js`, 'utf8');
    const config = JSON.parse(fs.readFileSync(`${ROOT}/config.json`, 'utf8'));
    console.log(`===== ${inst} =====`);

    check(config.chat.dedupeWindowMs === 60000, 'config dedupeWindowMs = 60000', String(config.chat.dedupeWindowMs));
    check(config.chat.repeatSuppressMinChars === 4, 'config repeatSuppressMinChars = 4', String(config.chat.repeatSuppressMinChars));
    check(src.includes('repeat-suppress patch'), 'marker present');
    check(src.includes('dedupeKey: buildMessageDedupeKey(config, sessionKey, event, plainText, messageSegments)'),
        'enqueue site uses the new key');

    const code = [
        extractFunction(src, 'normalizeRepeatText'),
        extractFunction(src, 'buildMessageDedupeKey'),
        'return { buildMessageDedupeKey };',
    ].join('\n');
    const { buildMessageDedupeKey } = new Function(code)();

    const ev = (id, user = 2063362809) => ({ message_id: id, user_id: user, time: 1 });
    const seg = (t) => [{ type: t }];
    const key = (id, text, segments, user) =>
        buildMessageDedupeKey(config, 'private:2063362809', ev(id, user), text, segments);

    // 1) the real scenario: identical long text, same person -> all identical keys
    const k1 = key('1001', LINE, seg('text'));
    const k2 = key('1002', LINE, seg('text'));
    check(k1 === k2, 'same person + same text -> same key (would be deduped)');

    // 2) a different speaker must NOT collide, or group-repeat detection dies
    const other = key('1003', LINE, seg('text'), 999);
    check(other !== k1, 'different user -> different key');

    // 3) short interjections are left alone (nobody wants "哈哈" swallowed)
    const short = key('1004', '哈哈', seg('text'));
    check(short.includes('1004'), 'short text falls back to message_id', short.split(':').pop());

    // 4) images / stickers unchanged: every sticker is its own message
    const st1 = key('1005', '[图片:[动画表情]]', seg('image'));
    const st2 = key('1006', '[图片:[动画表情]]', seg('image'));
    check(st1 !== st2, 'repeated sticker uses message_id (not deduped)');

    // 5) text + sticker in one message keeps message_id too
    const mix = key('1007', LINE, [{ type: 'text' }, { type: 'image' }]);
    check(mix.includes('1007'), 'mixed text+image falls back to message_id');

    // 6) replay runtime.js dedupe: first insert registers, hits within the window are dropped
    const seen = new Map();
    let delivered = 0;
    for (const t of TIMES) {
        for (const [k, ts] of [...seen.entries()]) {
            if (t - ts > config.chat.dedupeWindowMs / 1000) seen.delete(k);
        }
        const dedupeKey = key(`m${t}`, LINE, seg('text'));
        if (seen.has(dedupeKey)) continue;
        seen.set(dedupeKey, t);
        delivered++;
    }
    check(delivered === 1, '9 repeats -> 1 reply', `delivered=${delivered}/9`);

    // 7) and the OLD key is shown to fail the same replay, for the record
    const seenOld = new Map();
    let deliveredOld = 0;
    for (const t of TIMES) {
        for (const [k, ts] of [...seenOld.entries()]) {
            if (t - ts > config.chat.dedupeWindowMs / 1000) seenOld.delete(k);
        }
        const oldKey = `private:2063362809:m${t}`;
        if (seenOld.has(oldKey)) continue;
        seenOld.set(oldKey, t);
        deliveredOld++;
    }
    check(deliveredOld === 9, '(old message_id key would deliver all 9)', `delivered=${deliveredOld}/9`);
    console.log('');
}

console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
