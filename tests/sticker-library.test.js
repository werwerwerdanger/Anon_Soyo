/**
 * 本地表情包库：让她能**发**表情包。
 *
 * 🔴 核心不变量：发出去的段必须带 `sub_type: 1`。
 *   QQ 侧 `picElement.picSubType`：0 = 图片 / 1 = 动画表情。NapCat 收发两侧都用它
 *   （`napcat.mjs`：收 `sub_type: element.picSubType`；发 `createValidSendPicElement(ctx, path,
 *   data.summary, data.sub_type, …)` → `uploadFile(..., ElementType.PIC, subType)`）。
 *   **少了这个字段，QQ 就把表情当普通图片发** —— 用户 2026-10-14 明确要求过这一点。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    STICKER_DEFAULTS,
    STICKER_MARKER_TEST,
    buildStickerHint,
    buildStickerSegment,
    clearStickerCache,
    extractStickerMarkers,
    getStickerConfig,
    listStickerCategories,
    normalizeStickerConfig,
    pickSticker,
    scanStickerLibrary
} from '../src/sticker-library.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-'));
const put = (rel) => {
    const p = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from([0x47, 0x49, 0x46]));   // 内容不重要
    return p;
};
const HAPPY = [put('开心/a.gif'), put('开心/b.gif')];
const LOST = [put('无语/c.png')];
const GENERAL = [put('d.jpg'), put('note.txt')];   // note.txt 不是图，必须被忽略

test('配置归一化：默认关闭，字段补齐', () => {
    const cfg = {};
    assert.deepEqual(normalizeStickerConfig(cfg), { ...STICKER_DEFAULTS });
    const on = { chat: { stickers: { enabled: true, dir: '  ', maxPerReply: 0 } } };
    assert.deepEqual(normalizeStickerConfig(on), {
        enabled: true, dir: STICKER_DEFAULTS.dir, maxPerReply: STICKER_DEFAULTS.maxPerReply
    });
    // 直接读（不归一化）也要能拿到安全默认值
    assert.deepEqual(getStickerConfig({}), { ...STICKER_DEFAULTS });
});

test('扫描：子目录=类别，根目录=通用池，非图片文件被忽略', () => {
    clearStickerCache();
    const lib = scanStickerLibrary(tmp, { useCache: false });
    assert.deepEqual(listStickerCategories(lib).sort(), ['开心', '无语']);
    assert.deepEqual(lib.categories['开心'].slice().sort(), HAPPY.slice().sort());
    assert.deepEqual(lib.categories['无语'], LOST);
    assert.deepEqual(lib.general, [GENERAL[0]]);
    // 总数 = 2 + 1 + 1，note.txt 不算
    assert.equal(lib.total, 4);
});

test('目录不存在 = 空库，不是错误', () => {
    clearStickerCache();
    const lib = scanStickerLibrary(path.join(tmp, 'does-not-exist'), { useCache: false });
    assert.equal(lib.total, 0);
    assert.deepEqual(listStickerCategories(lib), []);
    assert.equal(pickSticker(lib, '开心'), '');
});

test('抽图：命中类别时连通用池一起抽（避免只有一张太单调）', () => {
    const lib = scanStickerLibrary(tmp, { useCache: false });
    const seen = new Set();
    for (let i = 0; i < 80; i += 1) seen.add(pickSticker(lib, '开心', () => i / 80));
    assert.ok(HAPPY.every((p) => seen.has(p)), '该类别里的图都会出现');
    assert.ok(seen.has(GENERAL[0]), '通用池也会被抽到');
    assert.ok(!seen.has(LOST[0]), '别的类别的图不该混进来');
});

test('抽图：类别不存在 / 没给类别 ⇒ 从全部图里抽', () => {
    const lib = scanStickerLibrary(tmp, { useCache: false });
    const all = new Set([...HAPPY, ...LOST, GENERAL[0]]);
    for (const cat of ['', '不存在的类别']) {
        const seen = new Set();
        for (let i = 0; i < 120; i += 1) seen.add(pickSticker(lib, cat, () => i / 120));
        assert.deepEqual([...seen].sort(), [...all].sort(), `category=${JSON.stringify(cat)}`);
    }
});

test('标记解析：中英文冒号都认，标记从正文里摘干净', () => {
    const a = extractStickerMarkers('哈哈[表情:开心]');
    assert.deepEqual(a.requests.map((r) => r.category), ['开心']);
    assert.equal(a.cleaned, '哈哈');

    const b = extractStickerMarkers('无语……[sticker：无语]算了');
    assert.deepEqual(b.requests.map((r) => r.category), ['无语']);
    assert.equal(b.cleaned, '无语……算了');

    const c = extractStickerMarkers('[表情:开心][表情:无语]');
    assert.deepEqual(c.requests.map((r) => r.category), ['开心', '无语']);
    assert.equal(c.cleaned, '');

    // 没有标记时原样返回
    const d = extractStickerMarkers('就是一句普通的话');
    assert.deepEqual(d.requests, []);
    assert.equal(d.cleaned, '就是一句普通的话');
});

test('🔴 判"有没有标记"的正则必须非全局（全局 test 会推进 lastIndex）', () => {
    const s = '哈哈[表情:开心]';
    assert.equal(STICKER_MARKER_TEST.test(s), true);
    assert.equal(STICKER_MARKER_TEST.test(s), true, '同一字符串连判两次结果必须一致');
    assert.equal(STICKER_MARKER_TEST.test('没有标记'), false);
    assert.equal(STICKER_MARKER_TEST.test(s), true, 'false 之后也不能被 lastIndex 影响');
});

test('🔴 发出去的段必须带 sub_type: 1（否则 QQ 当普通图片发）', () => {
    const seg = buildStickerSegment('C:\\x\\开心\\a.gif');
    assert.equal(seg.type, 'image');
    assert.equal(seg.data.sub_type, 1);
    assert.equal(seg.data.summary, '[动画表情]');
    assert.equal(seg.data.file, 'C:\\x\\开心\\a.gif');
});

test('🔴 传整份 config 还是 chat 对象，都必须认（传错一层会静默变未启用）', () => {
    // 2026-10-14 实测踩到：prompt.js 手里是 chatConfig（已经是 chat 对象），
    // 而取值只读 config.chat.stickers ⇒ 静默读成未启用 ⇒ 提示根本不注入（最难查的那种）。
    const full = { chat: { stickers: { enabled: true, dir: tmp, maxPerReply: 3 } } };
    const chatOnly = { stickers: { enabled: true, dir: tmp, maxPerReply: 3 } };
    for (const [label, cfg] of [['整份 config', full], ['chat 对象本身', chatOnly]]) {
        assert.deepEqual(getStickerConfig(cfg),
            { enabled: true, dir: tmp, maxPerReply: 3 }, label);
    }
    // 没有任何 stickers 配置时回到默认（关闭）
    assert.equal(getStickerConfig({}).enabled, false);
    assert.equal(getStickerConfig({ chat: {} }).enabled, false);
});

test('提示只在「启用 + 库非空」时才生成，且类别名照实列出', () => {
    clearStickerCache();
    // 关闭
    assert.equal(buildStickerHint({ chat: { stickers: { enabled: false, dir: tmp } } }), '');
    // 启用但库空
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-empty-'));
    assert.equal(buildStickerHint({ chat: { stickers: { enabled: true, dir: emptyDir } } }), '');
    // 启用且有图
    const hint = buildStickerHint({ chat: { stickers: { enabled: true, dir: tmp } } });
    assert.match(hint, /\[表情:类别\]/);
    assert.match(hint, /开心/);
    assert.match(hint, /无语/);
    assert.ok(!hint.includes('不存在的类别'), '别把不存在的类别写进去');
});

// ---------------------------------------------------------------------------
// 端到端：走**真的** dispatchReply（桩 bot），确认段真的带 sub_type:1 发出去
// ---------------------------------------------------------------------------
import { dispatchReply } from '../src/reply-dispatcher.js';

const baseConfig = (overrides = {}) => ({
    chat: {
        splitMessage: false,
        segmentDelayMs: 0,
        proactiveMessageIntervalMs: 0,
        quoteReplyEnabled: false,
        mentionSenderOnReply: false,
        stickers: { enabled: true, dir: tmp, maxPerReply: 1 },
        ...overrides
    }
});
const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };
const makeBot = (calls) => ({
    async sendGroupMessage(groupId, message) { calls.push({ groupId, message }); },
    async sendPrivateMessage(userId, message) { calls.push({ userId, message }); }
});
const GROUP_EVENT = { message_type: 'group', group_id: 10001, user_id: 20002, message_id: 30003 };

test('端到端：文字 + 标记 ⇒ 先发文字、再发一个 sub_type:1 的表情段', async () => {
    clearStickerCache();
    const calls = [];
    await dispatchReply(GROUP_EVENT, '哈哈[表情:开心]', {}, {
        config: baseConfig(), bot: makeBot(calls), logger: noopLogger
    });
    assert.equal(calls.length, 2, JSON.stringify(calls));
    assert.equal(calls[0].message, '哈哈', '标记不能留在文字里');
    const seg = calls[1].message;
    assert.ok(Array.isArray(seg), '表情必须走段数组');
    const img = seg.find((s) => s.type === 'image');
    assert.ok(img, `没有 image 段: ${JSON.stringify(seg)}`);
    assert.equal(img.data.sub_type, 1, '🔴 sub_type 必须是 1，否则 QQ 当图片发');
    assert.ok(HAPPY.includes(img.data.file) || img.data.file === GENERAL[0]);
});

test('端到端：整条回复只有标记 ⇒ 只发一个表情，不发空文字', async () => {
    clearStickerCache();
    const calls = [];
    await dispatchReply(GROUP_EVENT, '[表情:无语]', {}, {
        config: baseConfig(), bot: makeBot(calls), logger: noopLogger
    });
    assert.equal(calls.length, 1, JSON.stringify(calls));
    const img = calls[0].message.find((s) => s.type === 'image');
    assert.equal(img.data.sub_type, 1);
    // ⚠ 别钉死是 LOST[0]：按设计类别池**会混进通用池**（避免某类别只有一张太单调）
    assert.ok([LOST[0], GENERAL[0]].includes(img.data.file),
        `抽到的不该是别的类别的图: ${img.data.file}`);
    assert.ok(!HAPPY.includes(img.data.file), '开心类别的图不该被「无语」抽到');
});

test('端到端：库空时不能静默丢消息（宁可把原文发出去）', async () => {
    clearStickerCache();
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-none-'));
    const calls = [];
    await dispatchReply(GROUP_EVENT, '[表情:开心]', {}, {
        config: baseConfig({ stickers: { enabled: true, dir: emptyDir, maxPerReply: 1 } }),
        bot: makeBot(calls), logger: noopLogger
    });
    assert.equal(calls.length, 1, '不许一个字节都不发');
    assert.equal(calls[0].message, '[表情:开心]', '兜底要发得出来（可见的失败优于静默）');
});

test('端到端：功能关闭时标记当普通文字原样发出（不动她的输出）', async () => {
    clearStickerCache();
    const calls = [];
    await dispatchReply(GROUP_EVENT, '哈哈[表情:开心]', {}, {
        config: baseConfig({ stickers: { enabled: false, dir: tmp, maxPerReply: 1 } }),
        bot: makeBot(calls), logger: noopLogger
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].message, '哈哈[表情:开心]');
});
