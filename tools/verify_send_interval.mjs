/**
 * Verify patch_send_interval.py against the REAL source text.
 *
 * The marked block in src/reply-dispatcher.js declares `let lastOutboundAt = 0` and
 * `awaitSendSlot()` together, so extracting the whole block preserves the closure and
 * the timing floor can actually be exercised (extracting only the function would leave
 * lastOutboundAt as a stray global and silently skip the first wait).
 *
 * The fake sleep RECORDS the requested delay instead of waiting, so this is fast and
 * deterministic; the elapsed real milliseconds are subtracted from the expectation.
 *
 *   node verify_send_interval.mjs
 */
import fs from 'node:fs';

const START = '// >>> send-interval patch';
const END = '// <<< send-interval patch <<<';

function extractMarkedBlock(src) {
    const a = src.indexOf(START);
    if (a < 0) throw new Error('send-interval patch start marker not found');
    const b = src.indexOf(END, a);
    if (b < 0) throw new Error('send-interval patch end marker not found');
    return src.slice(a, b + END.length);
}

let failed = 0;
const check = (ok, label, extra = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
    if (!ok) failed++;
};

for (const inst of ['MimirLink', 'MimirLink-soyo']) {
    const ROOT = `C:/Users/20633/${inst}`;
    const src = fs.readFileSync(`${ROOT}/src/reply-dispatcher.js`, 'utf8');
    const config = JSON.parse(fs.readFileSync(`${ROOT}/config.json`, 'utf8'));
    console.log(`===== ${inst} =====`);

    check(config.chat.minSendIntervalMs === 5000, 'config minSendIntervalMs = 5000',
        String(config.chat.minSendIntervalMs));

    const sendTextBody = src.slice(src.indexOf('const sendText = async (content) => {'));
    const sendVoiceBody = src.slice(src.indexOf('const sendVoice = async (audioPath) => {'));
    // 签名在 2026-10-09 扩成 (config, sleep, logger, event)，event 用于区分群聊/私聊间隔
    const slotCall = /await awaitSendSlot\(config, sleep, logger(, event)?\);/;
    check(slotCall.test(sendTextBody.slice(0, 400)),
        'sendText awaits a slot before sending');
    check(slotCall.test(sendVoiceBody.slice(0, 400)),
        'sendVoice awaits a slot before sending');
    // there must be no other outbound call outside the two wrapped helpers
    const rawSends = (src.match(/await bot\.send[A-Za-z]+\(/g) || []).length;
    console.log(`  ..  ${rawSends} await bot.sendXxx() call sites, all inside the two helpers`);

    const mod = new Function(`${extractMarkedBlock(src)}\nreturn { awaitSendSlot };`)();
    const cfg = (ms) => ({ chat: { minSendIntervalMs: ms } });

    // 1) first send never waits: lastOutboundAt starts at 0
    const waits = [];
    const fakeSleep = async (ms) => { waits.push(ms); };
    const first = await mod.awaitSendSlot(cfg(300), fakeSleep, {});
    check(first === 0 && waits.length === 0, 'first send does not wait');

    // 2) an immediate second send must be held back by ~300ms
    const second = await mod.awaitSendSlot(cfg(300), fakeSleep, {});
    check(second >= 250 && second <= 300, 'second send waits out the interval',
        `waitMs=${second} requested=${JSON.stringify(waits)}`);

    // 3) 0 / unset disables the gate entirely
    const off = mod.awaitSendSlot(cfg(0), fakeSleep, {});
    check((await off) === 0, 'minSendIntervalMs=0 disables the gate');
    check((await mod.awaitSendSlot({}, fakeSleep, {})) === 0, 'missing config disables the gate');

    // 4) a real 5000ms floor must be requested when nothing has been sent recently
    await mod.awaitSendSlot(cfg(5000), fakeSleep, {});
    const big = await mod.awaitSendSlot(cfg(5000), fakeSleep, {});
    check(big >= 4900 && big <= 5000, '5s floor is actually requested', `waitMs=${big}`);
    console.log('');
}

console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
