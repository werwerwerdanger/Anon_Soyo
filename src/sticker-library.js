/**
 * sticker-library.js —— 本地表情包库（让她能**发**表情包，而不是只收）
 *
 * 为什么需要单独一个模块
 * ----------------------
 * MimirLink 原本只有发**文本**（`sendText`）和发**语音**（`sendVoice`）两条路，
 * 一条发图的路径都没有。而"发图"和"发**表情**"在 QQ 侧是两回事：
 *
 *   QQ 的图片元素带 `picElement.picSubType`：**0 = 图片 / 1 = 动画表情**。
 *   NapCat 收发两侧都用这个字段（`NapCat/napcat.mjs` 里查到的）：
 *     收：`data: { …, sub_type: element.picSubType }`
 *     发：`[OB11MessageDataType.image]` → `createValidSendPicElement(ctx, path, data.summary, data.sub_type, …)`
 *         → `uploadFile(path, ElementType.PIC, subType)` → 元素里 `picSubType = subType`
 *   ⇒ **段里带 `sub_type: 1` 才会被 QQ 渲染成表情包，否则就是一张普通图片。**
 *     这是用户 2026-10-14 明确要求的（「发出来的应该被qq读成表情而不是图片」）。
 *
 * 目录约定（用户自己挑图，不依赖"从群里收集"——那样会全是群里的梗）
 * --------------------------------------------------------------
 *   data/stickers/<类别>/*.gif|png|jpg|jpeg|webp|bmp     ← 按类别
 *   data/stickers/*.gif|...                              ← 不分类别，任何类别都能抽到
 * 类别名就是她要在回复里写的那个词（如 `[表情:开心]`）。
 *
 * 为什么要扫描目录而不是写死清单：用户会随时往里丢图，不该每次都要重启。
 * 用"目录 mtime + 短 TTL"做缓存，新增/删除的文件在 TTL 内自动可见。
 */
import fs from 'node:fs';
import path from 'node:path';

export const STICKER_EXTENSIONS = Object.freeze(['.gif', '.png', '.jpg', '.jpeg', '.webp', '.bmp']);
export const STICKER_DEFAULTS = Object.freeze({
    enabled: false,
    dir: 'data/stickers',
    maxPerReply: 1
});
/** 她在回复里请求表情的写法。冒号兼容中英文，类别名不允许带 `]`。 */
export const STICKER_MARKER_RE = /\[表情\s*[:：]\s*([^\[\]]{0,16})\]|\[sticker\s*[:：]\s*([^\[\]]{0,16})\]/gi;
/**
 * 同一件事的**非全局**版本，只用于"有没有标记"的快速判断。
 * ⚠ 不能拿 `STICKER_MARKER_RE.test()` 当判断 —— 它是 `g` 正则，`test()` 会推进 `lastIndex`，
 * 于是"同一条字符串连判两次结果不同"这种最毒的 bug 就来了。本项目在表情那块已经踩过一次。
 */
export const STICKER_MARKER_TEST = /\[(?:表情|sticker)\s*[:：]/i;
/** 目录扫描缓存时长：用户丢完图最多等这么久就能用，不用重启。 */
const SCAN_TTL_MS = 30_000;

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function toPositiveInt(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** 归一化配置（`normalizeStickerConfig` 与其它模块的 normalizeXxx 命名一致）。 */
export function normalizeStickerConfig(config = {}) {
    const raw = readStickerRaw(config);
    // 统一写回**顶层 chat 那份**，与配置文件结构一致
    config.chat = config.chat || {};
    config.chat.stickers = {
        enabled: raw.enabled === true,
        dir: text(raw.dir) || STICKER_DEFAULTS.dir,
        maxPerReply: toPositiveInt(raw.maxPerReply, STICKER_DEFAULTS.maxPerReply)
    };
    return config.chat.stickers;
}

/**
 * 取配置。
 * ⚠ **同时接受整份 config 和 chat 对象本身**（`config.chat.stickers` 或 `config.stickers`）。
 *   原因：调用方很容易传错一层（`prompt.js` 手里的就是 `chatConfig`）。
 *   而"传错一层"的后果是**静默变成未启用**——功能一声不响地不工作，最难查。
 *   2026-10-14 就是这么踩的：`buildStickerHint(builder.chatConfig)` 恒返回空串。
 *   宁可多认一种形状，也不要留一个"看起来配好了其实没开"的坑。
 */
function readStickerRaw(config = {}) {
    return config?.chat?.stickers || config?.stickers || {};
}

export function getStickerConfig(config = {}) {
    const raw = readStickerRaw(config);
    return {
        enabled: raw.enabled === true,
        dir: text(raw.dir) || STICKER_DEFAULTS.dir,
        maxPerReply: toPositiveInt(raw.maxPerReply, STICKER_DEFAULTS.maxPerReply)
    };
}

/** 相对路径按**进程 cwd**（= 实例目录）解析 —— 和 `memory.storage.path` 的约定一致。 */
export function resolveStickerDir(config = {}) {
    const dir = getStickerConfig(config).dir;
    return path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir);
}

const isStickerFile = (name) => STICKER_EXTENSIONS.includes(path.extname(name).toLowerCase());

// ---------------------------------------------------------------------------
// 扫描（带 TTL 缓存）
// ---------------------------------------------------------------------------
const scanCache = new Map();   // absDir -> { at, lib }

/**
 * @returns {{ general: string[], categories: Record<string, string[]>, total: number }}
 */
export function scanStickerLibrary(absDir, { now = Date.now(), ttlMs = SCAN_TTL_MS, useCache = true } = {}) {
    const cached = scanCache.get(absDir);
    if (useCache && cached && now - cached.at < ttlMs) return cached.lib;

    const lib = { general: [], categories: {}, total: 0 };
    let items = [];
    try {
        items = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
        // 目录不存在 = 还没开始挑图 ⇒ 空库，不是错误
        scanCache.set(absDir, { at: now, lib });
        return lib;
    }

    for (const item of items) {
        if (item.isFile() && isStickerFile(item.name)) {
            lib.general.push(path.join(absDir, item.name));
            continue;
        }
        if (!item.isDirectory()) continue;
        let sub = [];
        try {
            sub = fs.readdirSync(path.join(absDir, item.name), { withFileTypes: true });
        } catch {
            continue;
        }
        const files = sub
            .filter((f) => f.isFile() && isStickerFile(f.name))
            .map((f) => path.join(absDir, item.name, f.name));
        if (files.length > 0) lib.categories[item.name] = files;
    }

    lib.general.sort();
    for (const key of Object.keys(lib.categories)) lib.categories[key].sort();
    lib.total = lib.general.length
        + Object.values(lib.categories).reduce((n, arr) => n + arr.length, 0);
    scanCache.set(absDir, { at: now, lib });
    return lib;
}

/** 测试用：清掉扫描缓存。 */
export function clearStickerCache() {
    scanCache.clear();
}

export function listStickerCategories(lib) {
    return Object.keys(lib?.categories || {});
}

/**
 * 挑一张。`category` 命中就用该类别（**连通用池一起抽**，免得某个类别只有一张时太单调）；
 * 类别不存在或没给 ⇒ 从通用池 + 全部类别里随机。
 * @returns {string} 绝对路径；库为空时返回 ''
 */
export function pickSticker(lib, category = '', random = Math.random) {
    if (!lib || lib.total === 0) return '';
    const want = text(category);
    const pool = want && lib.categories[want]
        ? [...lib.categories[want], ...lib.general]
        : [...lib.general, ...Object.values(lib.categories).flat()];
    if (pool.length === 0) return '';
    return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
}

// ---------------------------------------------------------------------------
// 标记解析
// ---------------------------------------------------------------------------

/**
 * 从回复正文里抽出发表情的请求，并把标记从正文中删掉。
 * @returns {{ cleaned: string, requests: Array<{ category: string, raw: string }> }}
 */
export function extractStickerMarkers(content = '') {
    const src = String(content ?? '');
    const requests = [];
    const cleaned = src.replace(STICKER_MARKER_RE, (raw, zh, en) => {
        requests.push({ category: text(zh ?? en), raw });
        return '';
    });
    return {
        // 删掉标记后可能留下空行/多余空格，收拾一下，但**不动段落结构**
        cleaned: cleaned.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim(),
        requests
    };
}

/**
 * 构 OneBot 图片段。
 * 🔴 `sub_type: 1` 是**关键**：QQ 侧 `picSubType` 0=图片 / 1=动画表情。
 * `summary` 只是给人看的占位文本，但 NapCat 收侧就是用它兜底的，一起给上更保险。
 */
export function buildStickerSegment(absPath) {
    return {
        type: 'image',
        data: {
            file: String(absPath),
            sub_type: 1,
            summary: '[动画表情]'
        }
    };
}

/**
 * 生成塞进「注意:」行的提示。**只在库非空时**才注入 —— 空库还教她发就是给她下绊子
 * （她写了标记却发不出来，等于每轮多一次静默失败）。
 * ⚠ 这条是"格式"要求（怎么写标记），不是词表，不违反"规则里别列清单"那条教训；
 *   但类别名必须**照实列出**，否则她会写出库里没有的类别。
 */
export function buildStickerHint(config = {}, { lib } = {}) {
    const cfg = getStickerConfig(config);
    if (!cfg.enabled) return '';
    const library = lib || scanStickerLibrary(resolveStickerDir(config));
    if (library.total === 0) return '';
    const cats = listStickerCategories(library);
    const catPart = cats.length > 0
        ? `可用的有：${cats.join('、')}`
        : '（还没有分类，直接用空类别即可）';
    return `想发一张表情包就在回复里写上 [表情:类别]，系统会替你发出去（QQ 会读成表情包）。`
        + `${catPart}。`
        + '别写别的类别名，写错的发不出去；一张回复最多发一张，不想发就别写。';
}
