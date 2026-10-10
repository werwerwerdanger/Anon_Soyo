/**
 * Verify STICKER BEHAVIOUR after reverting patch_sticker_handling.py (2026-10-09).
 *
 * History, because this file has now asserted both directions:
 *   - v1 filter: stickers were dropped from the vision pipeline and a sticker-only
 *     message was skipped in routing.
 *   - The user's reaction -- "她现在完全不理表情包了，我发她自己的表情包都不理我"
 *     plus log evidence that the model HAD been reading stickers correctly
 *     ("又是乐奈", and a correct read of a 丰川祥子 dog meme) -- showed the filter
 *     removed a working feature. Reverted.
 *
 * What must hold now:
 *   1. the sticker helpers are GONE (a stray re-introduction should fail this test)
 *   2. a sticker image reaches the model exactly like any other image
 *   3. a sticker-only message is a normal message to the image pipeline (count 1),
 *      not a zero-image no-op
 *
 * Routing (private answers a bare sticker, group does not) lives in
 * verify_trigger_routing.mjs.
 *
 * Downloads are stubbed via globalThis.fetch, so this runs fully offline.
 *
 *   node verify_sticker_handling.mjs
 */
import fs from 'node:fs';

// 1x1 transparent PNG
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');

globalThis.fetch = async () => new Response(PNG, {
    status: 200,
    headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) },
});

const INSTANCES = ['MimirLink-soyo', 'MimirLink'];
let failed = 0;
const check = (ok, label, extra = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
    if (!ok) failed++;
};

const item = (message) => ({ event: { message } });
const STICKER = { type: 'image', data: { summary: '[动画表情]', url: 'https://gchat.qpic.cn/sticker.png' } };
const PHOTO = { type: 'image', data: { summary: 'IMG_1.jpg', url: 'https://gchat.qpic.cn/photo.jpg' } };

for (const inst of INSTANCES) {
    const ROOT = `C:/Users/20633/${inst}`;
    const mod = await import(`file:///${ROOT}/src/image-input.js`);
    const config = JSON.parse(fs.readFileSync(`${ROOT}/config.json`, 'utf8'));

    console.log(`===== ${inst} =====`);

    // --- 1) the sticker helpers must be gone
    for (const name of ['isStickerImageSummary', 'isStickerImageSegment', 'STICKER_SEGMENT_TYPES']) {
        check(mod[name] === undefined, `helper ${name} is NOT exported any more`);
    }

    // --- 2) a sticker is an image, and reaches the model
    const r1 = await mod.prepareImageInput({ items: [item([STICKER])], config, bot: {} });
    check(r1.imageCount === 1, 'sticker-only message still sends its image to the model',
        `mode=${r1.mode} count=${r1.imageCount}`);
    check(r1.mode !== 'none', 'sticker-only message is not a no-op', `mode=${r1.mode}`);

    const r2 = await mod.prepareImageInput({ items: [item([PHOTO])], config, bot: {} });
    check(r2.imageCount === 1, 'a photo is unaffected', `mode=${r2.mode} count=${r2.imageCount}`);

    const r3 = await mod.prepareImageInput({ items: [item([STICKER, PHOTO, STICKER])], config, bot: {} });
    check(r3.imageCount === 3, 'a mixed message keeps every image', `count=${r3.imageCount}`);

    // --- 3) the source must not carry the old markers either
    const src = fs.readFileSync(`${ROOT}/src/index.js`, 'utf8');
    check(!src.includes('sticker-handling patch'), 'src/index.js has no sticker-handling marker');

    console.log('');
}

console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
