/**
 * canon 存储层：两份文件 + 一把锁
 *
 * 为什么要换成 append-only 的 jsonl：
 *   初版是「读整个 canon.json → 改 events 数组 → 整个写回」。两个进程（爱音/素世）
 *   同时捕获时后写的会把先写的那条覆盖掉 —— Letta 的共享记忆块文档里明确写了这个坑：
 *   "多个 Agent 同时写入时以最后一次写入为准，因此共享块要避免并发改写"。
 *   现在 events 只追加（一行一条，O_APPEND），改 canon.json 这种"小文档"才加锁。
 *
 * 文件布局（dir 默认 C:/Users/20633/mimir-shared）：
 *   canon.json      stage / pairs / world —— 小，整体重写，写前加锁 + 快照
 *   events.jsonl    小插曲，只追加，不重写（超过阈值才 compaction）
 *   .canon.lock     写锁（wx 原子创建；超过 staleMs 视为僵尸锁）
 *   snapshots/      每次重写 canon.json 前的副本，出错能回滚
 */
import fs from 'fs';
import path from 'path';

const DEFAULT_DIR = 'C:/Users/20633/mimir-shared';
const MAX_EVENTS = 240;      // 行数超过就 compaction
const KEEP_EVENTS = 80;      // compaction 后保留（按时间取最新）
const MAX_SNAPSHOTS = 20;
const LOCK_STALE_MS = 10000;
const LOCK_TIMEOUT_MS = 1500;

const cache = new Map();     // file -> { mtimeMs, value }

function dirOf(cfg = {}) {
    const raw = String(cfg.dir || cfg.path || DEFAULT_DIR).trim() || DEFAULT_DIR;
    // 兼容旧配置：path 指向 canon.json 本身
    return /\.json$/i.test(raw) ? path.dirname(raw) : raw;
}

export function paths(cfg = {}) {
    const dir = dirOf(cfg);
    return {
        dir,
        doc: path.join(dir, 'canon.json'),
        events: path.join(dir, 'events.jsonl'),
        lock: path.join(dir, '.canon.lock'),
        snapshots: path.join(dir, 'snapshots')
    };
}

/** 同步睡一会儿（Node 没有 sleepSync，用 Atomics.wait 不 burning CPU）。 */
function sleepSync(ms) {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch (e) {
        const end = Date.now() + ms;
        while (Date.now() < end) { /* spin */ }
    }
}

/** 本地日期 YYYY-MM-DD。⚠ 不要用 toISOString —— 那是 UTC，凌晨会跨天。 */
export function todayKey(now = Date.now()) {
    const d = new Date(now);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function pairKey(a, b) {
    const x = String(a || '').trim();
    const y = String(b || '').trim();
    if (!x || !y) return '';
    return [x, y].sort().join(':');
}

export function otherIdFromSession(sessionId) {
    const m = /^private:(\d+)$/.exec(String(sessionId || ''));
    return m ? m[1] : '';
}

function emptyDoc() {
    return {
        version: 2,
        updatedAt: 0,
        stage: '',
        pairs: {},
        world: null
    };
}

/** 读 canon.json（按 mtime 缓存）。坏了也不抛，退回上一次成功的值。 */
export function readDoc(cfg = {}) {
    const file = paths(cfg).doc;
    try {
        const st = fs.statSync(file);
        const hit = cache.get(file);
        if (hit && hit.mtimeMs === st.mtimeMs) return hit.value;
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const doc = {
            version: Number(raw?.version) || 2,
            updatedAt: Number(raw?.updatedAt) || 0,
            stage: String(raw?.stage || ''),
            pairs: (raw && typeof raw.pairs === 'object' && raw.pairs) || {},
            world: raw?.world && typeof raw.world === 'object' ? raw.world : null
        };
        cache.set(file, { mtimeMs: st.mtimeMs, value: doc });
        return doc;
    } catch (e) {
        const hit = cache.get(file);
        return hit ? hit.value : emptyDoc();
    }
}

/** 读 events.jsonl。坏行跳过（写一半崩了不该让整条链断掉）。 */
export function readEvents(cfg = {}) {
    const file = paths(cfg).events;
    try {
        const st = fs.statSync(file);
        const hit = cache.get(file);
        if (hit && hit.mtimeMs === st.mtimeMs) return hit.value;
        const text = fs.readFileSync(file, 'utf8');
        const list = [];
        for (const line of text.split('\n')) {
            const s = line.trim();
            if (!s) continue;
            try {
                const item = JSON.parse(s);
                if (item && item.text) list.push(item);
            } catch (e) { /* 跳过坏行 */ }
        }
        cache.set(file, { mtimeMs: st.mtimeMs, value: list });
        return list;
    } catch (e) {
        const hit = cache.get(file);
        return hit ? hit.value : [];
    }
}

function ensureDir(cfg = {}) {
    const p = paths(cfg);
    try { fs.mkdirSync(p.dir, { recursive: true }); } catch (e) { /* ignore */ }
    return p;
}

/** 取写锁。拿不到就返回 false —— 调用方应该**跳过这次写**，绝不能卡住回复链路。 */
export function acquireLock(cfg = {}) {
    const p = ensureDir(cfg);
    const t0 = Date.now();
    for (;;) {
        try {
            const fd = fs.openSync(p.lock, 'wx');
            fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}`);
            fs.closeSync(fd);
            return true;
        } catch (e) {
            if (e.code !== 'EEXIST') return false;
            try {
                const st = fs.statSync(p.lock);
                if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
                    fs.unlinkSync(p.lock);   // 僵尸锁（进程被杀留下的）
                    continue;
                }
            } catch (err) { /* 锁刚好被释放，重试即可 */ }
            if (Date.now() - t0 > LOCK_TIMEOUT_MS) return false;
            sleepSync(15);
        }
    }
}

export function releaseLock(cfg = {}) {
    try { fs.unlinkSync(paths(cfg).lock); } catch (e) { /* ignore */ }
}

function snapshot(cfg = {}, file = '') {
    const p = paths(cfg);
    try {
        if (!fs.existsSync(p.doc)) return;
        fs.mkdirSync(p.snapshots, { recursive: true });
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        fs.copyFileSync(p.doc, path.join(p.snapshots, `canon-${stamp}.json`));
        const files = fs.readdirSync(p.snapshots).filter((f) => f.startsWith('canon-')).sort();
        while (files.length > MAX_SNAPSHOTS) {
            const old = files.shift();
            try { fs.unlinkSync(path.join(p.snapshots, old)); } catch (e) { /* ignore */ }
        }
    } catch (e) { /* 快照失败不该拦着写 */ }
}

function atomicWrite(file, text) {
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
}

/**
 * 读-改-写 canon.json。mutator 拿到的 doc 可以直接改，返回值忽略。
 * 拿不到锁返回 false（这次不写，下一次 tick 再说）。
 */
export function updateDoc(cfg = {}, mutator) {
    if (typeof mutator !== 'function') return false;
    const p = ensureDir(cfg);
    if (!acquireLock(cfg)) return false;
    try {
        const doc = readDoc(cfg);
        const next = { ...doc };
        mutator(next);
        next.updatedAt = Date.now();
        snapshot(cfg);
        atomicWrite(p.doc, JSON.stringify(next, null, 2) + '\n');
        cache.delete(p.doc);
        return true;
    } catch (e) {
        return false;
    } finally {
        releaseLock(cfg);
    }
}

/**
 * 追加事件。不需要锁 —— O_APPEND 对单行小写入是原子的。
 * 写顺带做一次 compaction（超阈值时把文件收敛成最新 N 条）。
 */
export function appendEvents(cfg = {}, items = []) {
    const list = (Array.isArray(items) ? items : []).filter((i) => i && i.text);
    if (!list.length) return 0;
    const p = ensureDir(cfg);
    try {
        const payload = list.map((i) => JSON.stringify(i)).join('\n') + '\n';
        fs.appendFileSync(p.events, payload, 'utf8');
        cache.delete(p.events);
        const all = readEvents(cfg);
        if (all.length > MAX_EVENTS) {
            const kept = all.slice(-KEEP_EVENTS);
            atomicWrite(p.events, kept.map((i) => JSON.stringify(i)).join('\n') + '\n');
            cache.delete(p.events);
        }
        return list.length;
    } catch (e) {
        return 0;
    }
}

/** 从 LLM 返回值里取正文（不同 provider 字段不一样）。 */
export function llmText(result) {
    return String(result?.content ?? result?.text ?? '').trim();
}

/** 压成一行：去首尾引号、换行变空格、多空格合一。 */
export function cleanOneLine(text = '') {
    return String(text)
        .replace(/^["“'「]+|["”'」]+$/g, '')
        .replace(/\s*\n+\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** 去重用的归一化键（去掉标点和空白，取前 26 字）。 */
export function dedupeKey(text) {
    return String(text || '')
        .replace(/[\s。！？!?，,、…~～「」“”"'’]/g, '')
        .slice(0, 26);
}

export { DEFAULT_DIR, MAX_EVENTS, KEEP_EVENTS };
