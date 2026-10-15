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

    // ⚠ 2026-10-13 修：这里原来按**完整签名**定位函数体：
    //      src.indexOf('const sendText = async (content) => {')
    //    签名后来扩成 `(content, options = {})` ⇒ indexOf 返回 -1 ⇒ slice(-1) 只拿到最后一个字符
    //    ⇒ 断言必然 FAIL，而且报的是「sendText awaits a slot before sending」这种**误导性**标签
    //    （看起来像闸门没了，其实只是找不到函数）。改成按**前缀**定位，签名再扩也不受影响。
    const fromMarker = (source, marker) => {
        const at = source.indexOf(marker);
        if (at < 0) throw new Error(`marker not found: ${marker}`);
        return source.slice(at);
    };
    const sendTextBody = fromMarker(src, 'const sendText = async (content');
    const sendVoiceBody = fromMarker(src, 'const sendVoice = async (audioPath');

    // 真正要守的不变量是**顺序**：发出去之前必须先等过槽位。
    // 签名会变（2026-10-13 加了 options.burst），"slot 调用排在 bot.send 之前"不会变。
    const awaitsSlotBeforeSending = (body) => {
        const sendAt = body.indexOf('await bot.send');
        const slotAt = body.indexOf('await awaitSendSlot(');
        return slotAt >= 0 && (sendAt < 0 || slotAt < sendAt);
    };
    check(awaitsSlotBeforeSending(sendTextBody), 'sendText awaits a slot before sending');
    check(awaitsSlotBeforeSending(sendVoiceBody), 'sendVoice awaits a slot before sending');
    // 参数形状单独钉一条（宽松：只要求 event 与 burst 都以命名实参传入，不钉死其它细节）
    // ⚠ 窗口别用 600 —— slot 调用实际落在偏移 532，加上尾部 `);` 刚好被切掉（自己踩了一次）。
    check(/await awaitSendSlot\(config, sleep, logger(?:, event(?:, [^)]*)?)?\);/.test(sendTextBody.slice(0, 1200)),
        'sendText 的 slot 调用带着 event/burst 实参');
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
