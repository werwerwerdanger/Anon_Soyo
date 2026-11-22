/**
 * oj-list-watch.js —— 题单更新监控（每天固定时刻扫一次）
 *
 * 需求（2026-11-19 用户）：每天早 9 点看 `OJ /lists/3`（新人训练总题单）有没有加题，
 * 有就在新群（2026cdut-acm-候选）说一声。
 *
 * 为什么不用轮询式（像 oj-ac 那样每分钟对比）：
 *   题单是**人手动编的**，一天最多改一次，每分钟去拉纯属浪费。所以做成
 *   "每天一个时刻"的定时任务，跟 oj-contest 的 dailyAtMinutes 同一套时间口径。
 *
 * 🔴 首次运行只对齐、不播报：
 *   第一次跑时库里没有快照，如果直接比对，会把整张题单 22 题全当成"新增"刷一遍。
 *   和 oj-ac 的 `首次运行，游标对齐，不回补历史` 是同一条规矩。
 *
 * 🔴 状态文件同时存 `dayDate`：
 *   bot 重启后 `start()` 会重新计时，如果只靠内存记"今天跑过没"，
 *   一天重启三次就会发三条。日期必须落盘。
 */

import fs from 'node:fs';
import path from 'node:path';

export const OJ_LIST_DEFAULTS = Object.freeze({
    enabled: false,
    baseUrl: '',
    username: '',
    password: '',
    listId: 3,
    notifyGroups: [],
    atMinutes: 9 * 60,        // 北京时间 09:00
    timeoutMs: 15000,
    stateFile: 'data/oj-list-state.json'
});

const BEIJING_OFFSET_MS = 8 * 3600 * 1000;

const cleanText = (v) => String(v ?? '').trim();
const toInt = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);

export function normalizeOjListConfig(source = {}, fallback = {}) {
    const src = source && typeof source === 'object' ? source : {};
    const fb = fallback && typeof fallback === 'object' ? fallback : {};
    const groups = Array.isArray(src.notifyGroups) ? src.notifyGroups : [];
    return {
        enabled: src.enabled === true,
        baseUrl: cleanText(src.baseUrl || fb.baseUrl).replace(/\/+$/, ''),
        username: cleanText(src.username || fb.username),
        password: cleanText(src.password || fb.password),
        listId: Math.max(1, toInt(src.listId, OJ_LIST_DEFAULTS.listId)),
        notifyGroups: groups.map((g) => cleanText(g)).filter(Boolean),
        atMinutes: Math.min(23 * 60 + 59, Math.max(0, toInt(src.atMinutes, OJ_LIST_DEFAULTS.atMinutes))),
        timeoutMs: Math.max(1000, toInt(src.timeoutMs, OJ_LIST_DEFAULTS.timeoutMs)),
        stateFile: cleanText(src.stateFile) || OJ_LIST_DEFAULTS.stateFile
    };
}

/** 北京时间 {date, hour, minute} */
export function beijingClock(ms = Date.now()) {
    const d = new Date(Number(ms) + BEIJING_OFFSET_MS);
    return {
        date: d.toISOString().slice(0, 10),
        hour: d.getUTCHours(),
        minute: d.getUTCMinutes()
    };
}

/** 从「枚举 / B．基础枚举」里取出模块名「枚举」。没有分隔符就整段当模块名。 */
export function parseModuleName(sectionName = '') {
    const raw = cleanText(sectionName);
    if (!raw) return '未分类';
    const head = raw.split(/[\/／>»›]/)[0];
    return cleanText(head) || '未分类';
}

/**
 * 把 `/api/lists/{id}` 的返回压平成题目数组。
 * 结构（2026-11-19 实测）：
 *   { id, title, description, sections: [{ name, problems: [{ problem_id, label, display_no, title, ... }] }] }
 */
export function extractListProblems(payload = {}) {
    const out = [];
    const sections = Array.isArray(payload?.sections) ? payload.sections : [];
    for (const sec of sections) {
        const sectionName = cleanText(sec?.name);
        const problems = Array.isArray(sec?.problems) ? sec.problems : [];
        for (const p of problems) {
            const id = toInt(p?.problem_id, 0);
            if (id <= 0) continue;
            out.push({
                problemId: id,
                label: cleanText(p?.label),
                displayNo: toInt(p?.display_no, 0),
                title: cleanText(p?.title),
                difficulty: toInt(p?.difficulty, 0),
                section: sectionName,
                // >>> module patch >>>
                // 题单页面把小题归成「训练模块」（枚举 / 排序 / 前缀和），
                // section 名的格式是「模块 / 小节」，第一段就是模块。
                // 播报要按模块说"加在哪儿"，用户才看得懂（2026-11-19 要求）。
                module: parseModuleName(sectionName),
                // <<< module patch >>>
                source: cleanText(p?.source)
            });
        }
    }
    return out;
}

/** 对比两次快照，返回新增的题（按 problemId）。`prev` 为空 = 首次运行。 */
export function diffListProblems(prevProblems = [], curProblems = []) {
    const prev = Array.isArray(prevProblems) ? prevProblems : [];
    const cur = Array.isArray(curProblems) ? curProblems : [];
    if (prev.length === 0) return { firstRun: true, added: [], removed: [] };
    const prevIds = new Set(prev.map((p) => Number(p?.problemId)).filter((n) => n > 0));
    const curIds = new Set(cur.map((p) => Number(p?.problemId)).filter((n) => n > 0));
    return {
        firstRun: false,
        added: cur.filter((p) => !prevIds.has(Number(p.problemId))),
        removed: prev.filter((p) => !curIds.has(Number(p.problemId)))
    };
}

/**
 * 更新播报文案。
 * 只列前 8 题（再多群里没人看），后面的写"等 N 题"。
 */
export function buildListNotice({ listTitle = '', listId = 3, total = 0, added = [], allProblems = [], baseUrl = '' } = {}) {
    const list = Array.isArray(added) ? added : [];
    if (list.length === 0) return '';

    // 2026-11-19 用户要求：要说清楚加在哪个**训练模块**（枚举 / 排序 / 前缀和）。
    // 按 module 分组、保持题单里的原始顺序（Map 插入序 = 首次出现序）。
    const order = [];
    const groups = new Map();
    for (const p of list) {
        const mod = cleanText(p?.module) || parseModuleName(p?.section);
        if (!groups.has(mod)) {
            groups.set(mod, []);
            order.push(mod);
        }
        groups.get(mod).push(p);
    }

    // 每个模块一共有多少题（用户看到的「枚举 (3 / 10)」里的那个 10）
    const moduleTotals = new Map();
    for (const p of (Array.isArray(allProblems) ? allProblems : [])) {
        const mod = cleanText(p?.module) || parseModuleName(p?.section);
        moduleTotals.set(mod, (moduleTotals.get(mod) || 0) + 1);
    }

    const lines = [
        `【题单更新】「${listTitle || `题单 #${listId}`}」加了 ${list.length} 题（现在共 ${total} 题）`
    ];

    // 总展示上限 8 题（再多群里没人看）；单个板块最多列 4 题，超了写"等 N 题"
    const MAX_SHOWN = 8;
    const MAX_PER_SECTION = 4;
    let shown = 0;
    const hidden = [];      // 完全没轮到的板块：只报名字和数量，别让人猜是哪儿
    for (const sec of order) {
        const items = groups.get(sec);
        const room = Math.min(items.length, MAX_PER_SECTION, MAX_SHOWN - shown);
        if (room <= 0) {
            hidden.push({ sec, count: items.length });
            continue;
        }
        const modTotal = moduleTotals.get(sec);
        const scale = Number.isFinite(modTotal) && modTotal > 0 ? `共 ${modTotal} 题，` : '';
        lines.push(`· ${sec}（${scale}本次 +${items.length}）`);
        for (let i = 0; i < room; i += 1) {
            const p = items[i];
            const tag = p.label ? `${p.label} ` : (p.displayNo > 0 ? `#${p.displayNo} ` : '');
            lines.push(`  + ${tag}${p.title}`);
            shown += 1;
        }
        if (items.length > room) {
            lines.push(`  ……这个板块还有 ${items.length - room} 题`);
        }
    }
    if (hidden.length > 0) {
        const names = hidden.map((h) => `「${h.sec}」`).join('');
        const count = hidden.reduce((n, h) => n + h.count, 0);
        lines.push(`……另外 ${count} 题在${names}`);
    }

    const base = cleanText(baseUrl).replace(/\/+$/, '');
    if (base) lines.push(`${base}/lists/${listId}`);
    return lines.join('\n');
}

// ------------------------------------------------------------------ 状态

function readState(file, logger) {
    try {
        if (!fs.existsSync(file)) return { dayDate: '', listId: 0, problems: [], updatedAt: 0 };
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        return {
            dayDate: cleanText(raw?.dayDate),
            listId: toInt(raw?.listId, 0),
            problems: Array.isArray(raw?.problems) ? raw.problems : [],
            updatedAt: toInt(raw?.updatedAt, 0)
        };
    } catch (error) {
        logger?.warn?.(`[题单监控] 状态文件读取失败（按首次运行处理）: ${error?.message}`);
        return { dayDate: '', listId: 0, problems: [], updatedAt: 0 };
    }
}

function writeState(file, state, logger) {
    try {
        const dir = path.dirname(file);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
        return true;
    } catch (error) {
        logger?.warn?.(`[题单监控] 状态文件写入失败: ${error?.message}`);
        return false;
    }
}

// ------------------------------------------------------------------ 轮询器

export class OjListWatcher {
    constructor({ getConfig, getFallbackConfig, logger = console, stateFile, onUpdate }) {
        this.getConfig = getConfig;
        this.getFallbackConfig = getFallbackConfig;
        this.logger = logger;
        this.stateFile = stateFile;
        this.onUpdate = onUpdate;
        this.accessToken = '';
        this.state = null;
        this.timer = null;
        this.running = false;
    }

    config() {
        return normalizeOjListConfig(this.getConfig?.() || {}, this.getFallbackConfig?.() || {});
    }

    async login() {
        const cfg = this.config();
        if (!cfg.username || !cfg.password) throw new Error('缺少 OJ 账号（ojListWatch.username/password）');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
        try {
            const res = await fetch(`${cfg.baseUrl}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: cfg.username, password: cfg.password }),
                signal: controller.signal
            });
            const text = await res.text();
            if (!res.ok) throw new Error(`登录失败 ${res.status}: ${text.slice(0, 120)}`);
            const data = JSON.parse(text);
            const token = cleanText(data?.access_token);
            if (!token) throw new Error('登录响应里没有 access_token');
            this.accessToken = token;
            return token;
        } finally {
            clearTimeout(timer);
        }
    }

    async requestJson(pathname, { retryOnAuth = true } = {}) {
        const cfg = this.config();
        if (!cfg.baseUrl) throw new Error('缺少 OJ 地址（ojListWatch.baseUrl 没配）');
        if (!this.accessToken) await this.login();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
        try {
            const res = await fetch(`${cfg.baseUrl}${pathname}`, {
                headers: { Authorization: `Bearer ${this.accessToken}`, Accept: 'application/json' },
                signal: controller.signal
            });
            const text = await res.text();
            if (res.status === 401 && retryOnAuth) {
                this.accessToken = '';
                await this.login();
                return this.requestJson(pathname, { retryOnAuth: false });
            }
            if (!res.ok) throw new Error(`请求 ${pathname} 失败 ${res.status}: ${text.slice(0, 120)}`);
            return JSON.parse(text);
        } finally {
            clearTimeout(timer);
        }
    }

    async ensureState() {
        if (this.state) return this.state;
        this.state = readState(this.stateFile, this.logger);
        return this.state;
    }

    async saveState() {
        writeState(this.stateFile, this.state || {}, this.logger);
    }

    /**
     * 跑一次（不判断时间）。`force` 为 true 时忽略"今天已经跑过"。
     */
    async pollOnce({ now = Date.now(), force = false } = {}) {
        const cfg = this.config();
        if (!cfg.enabled) return { skipped: true };
        if (!cfg.baseUrl) throw new Error('缺少 OJ 地址（ojListWatch.baseUrl 没配）');
        if (cfg.notifyGroups.length === 0) throw new Error('没有通知目标（ojListWatch.notifyGroups 是空的）');

        const clock = beijingClock(now);
        const state = await this.ensureState();
        if (!force && state.dayDate === clock.date) return { skipped: true, reason: 'already_today' };

        const payload = await this.requestJson(`/api/lists/${cfg.listId}`);
        const problems = extractListProblems(payload);
        const listTitle = cleanText(payload?.title);
        const diff = diffListProblems(state.listId === cfg.listId ? state.problems : [], problems);

        let sent = 0;
        if (diff.firstRun) {
            this.logger.info?.(`[题单监控] 首次运行，只对齐不回补（${problems.length} 题）`);
        } else if (diff.added.length > 0) {
            const text = buildListNotice({
                listTitle,
                listId: cfg.listId,
                total: problems.length,
                added: diff.added,
                allProblems: problems,        // 用来算"这个模块一共几题"
                baseUrl: cfg.baseUrl
            });
            for (const groupId of cfg.notifyGroups) {
                try {
                    await this.onUpdate?.(text, { groupId, listId: cfg.listId, added: diff.added });
                    sent += 1;
                } catch (error) {
                    this.logger.warn?.(`[题单监控] group:${groupId} 发送失败: ${error?.message}`);
                }
            }
            if (sent === 0) throw new Error('全部目标发送失败');
            this.logger.info?.(`[题单监控] 新增 ${diff.added.length} 题，已播报`, {
                listId: cfg.listId,
                total: problems.length,
                added: diff.added.map((p) => p.problemId).slice(0, 10)
            });
        } else {
            this.logger.debug?.('[题单监控] 没有新增题目');
        }

        // 发送成功（或本来就没更新）才把快照落盘 —— 失败时下轮还能重试
        state.dayDate = clock.date;
        state.listId = cfg.listId;
        state.problems = problems;
        state.updatedAt = now;
        await this.saveState();
        return { sent, added: diff.added.length, total: problems.length, firstRun: diff.firstRun };
    }

    /** 每分钟看一眼：到点了、今天还没跑过，就跑一次。 */
    start() {
        if (this.timer) return this.timer;
        const tick = async () => {
            if (this.running) return;
            const cfg = this.config();
            if (!cfg.enabled) return;
            const clock = beijingClock();
            const nowMinutes = clock.hour * 60 + clock.minute;
            // 只在 atMinutes 之后 3 小时内触发（错过就不补，避免下午突然发一条）
            if (nowMinutes < cfg.atMinutes || nowMinutes - cfg.atMinutes > 180) return;
            const state = await this.ensureState();
            if (state.dayDate === clock.date) return;

            this.running = true;
            try {
                await this.pollOnce({ force: true });
            } catch (error) {
                this.logger.warn?.(`[题单监控] 执行失败: ${error?.message}`);
            } finally {
                this.running = false;
            }
        };
        this.timer = setInterval(() => { tick().catch(() => {}); }, 60 * 1000);
        if (this.timer.unref) this.timer.unref();
        // 启动时先看一眼（重启后当天没跑过就补上）
        tick().catch(() => {});
        return this.timer;
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }
}
