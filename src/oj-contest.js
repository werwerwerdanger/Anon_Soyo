/**
 * oj-contest.js —— 比赛倒计时播报（给她一个"主动开口"的正当理由）
 *
 * 和 oj-ac.js 同一套骨架（登录 / requestJson / 轮询 / 状态文件 / 游标式去重），
 * 区别是它播的**不是事件流而是时间点**，所以要自己算"什么时候该开口"。
 *
 * 两类播报
 *   ① 每日倒计时（`dailyAtMinutes`，北京时间的时刻，如 20:00）：
 *      距离最近的比赛还有 N 天（超过 `countdownWindowDays` 天就不念，免得变成背景噪音）
 *   ② 临近提醒（`leadMinutes`：24 小时 / 1 小时 / 10 分钟）+ 开赛那一刻
 *
 * 🔴 时间口径（踩过就回不来）：OJ 后端跑在 **UTC** 容器里，`start_time` 可能是
 *    `...T06:00:00+00:00`，也可能是**无时区**的 `...T06:00:00`（老数据）。
 *    无时区的一律**当 UTC**（与 `oj-feedback.js` 的 `formatBeijingTime` 同一约定），
 *    展示时再 +8 小时。搞反了倒计时会偏 8 小时。
 *
 * 🔴 去重 / 防刷屏
 *    · 每条播报的键是 `<contestId>:<kind>`，进了状态文件就不再重复
 *    · `graceMs` 之外过期的提醒**只标记不发**（bot 停了几小时再起来，不该一次补三条）
 *    · 每天最多 `maxPerDay` 条（按北京日期记）—— 主动说话最容易翻车的地方就是刷屏
 */
import fs from 'node:fs/promises';

export const OJ_CONTEST_DEFAULTS = Object.freeze({
    enabled: false,
    baseUrl: '',
    username: '',            // 留空则不带 Authorization（比赛列表接口是公开的）
    password: '',
    notifyGroups: [],
    intervalMs: 600000,      // 10 分钟一轮
    dailyAtMinutes: [20 * 60],   // 每天的北京时刻（分钟数）：20:00
    countdownWindowDays: 7,      // 只对 7 天内的比赛念倒计时
    countdownDays: [7, 3, 2, 1], // ⭐ 只在「赛前 N 天」这些日子念倒计时（空数组 = 退回 countdownWindowDays 的旧行为）
    leadMinutes: [1440, 60, 10], // 赛前提醒：24h / 1h / 10min
    dailyProblem: { enabled: false, groups: [] },   // 每日一题：同一时刻发直达链接（groups 为空则用 notifyGroups）
    graceMs: 30 * 60 * 1000,     // 过点超过这么久就只标记不发
    maxPerDay: 3,
    timeoutMs: 15000,
    stateFile: 'data/oj-contest-state.json'
});

const BEIJING_OFFSET_MS = 8 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

function cleanText(value) {
    return String(value ?? '').trim();
}

function toInt(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function toIntArray(value, fallback = []) {
    const list = Array.isArray(value)
        ? value
        : (typeof value === 'string' ? value.split(/[,，\s]+/) : []);
    const out = list
        .map((item) => Number(item))
        .filter((n) => Number.isFinite(n) && n >= 0)
        .map((n) => Math.trunc(n));
    return out.length > 0 ? out : [...fallback];
}

export function normalizeOjContestConfig(source = {}, fallback = {}) {
    const src = source && typeof source === 'object' ? source : {};
    const fb = fallback && typeof fallback === 'object' ? fallback : {};
    return {
        enabled: src.enabled === true,
        // 凭据允许继承 ojFeedback（和一串密码只存一份的约定一致）
        baseUrl: cleanText(src.baseUrl || fb.baseUrl).replace(/\/+$/, ''),
        username: cleanText(src.username || fb.username),
        password: cleanText(src.password || fb.password),
        notifyGroups: (Array.isArray(src.notifyGroups) ? src.notifyGroups : [])
            .map((id) => cleanText(id)).filter(Boolean),
        intervalMs: Math.max(60000, toInt(src.intervalMs, OJ_CONTEST_DEFAULTS.intervalMs)),
        dailyAtMinutes: toIntArray(src.dailyAtMinutes, OJ_CONTEST_DEFAULTS.dailyAtMinutes)
            .filter((m) => m >= 0 && m < 24 * 60),
        countdownWindowDays: Math.max(0, toInt(src.countdownWindowDays, OJ_CONTEST_DEFAULTS.countdownWindowDays)),
        // 只在这些「赛前 N 天」念倒计时；显式给空数组 = 退回窗口行为
        countdownDays: Array.isArray(src.countdownDays)
            ? toIntArray(src.countdownDays, [])
            : [...OJ_CONTEST_DEFAULTS.countdownDays],
        leadMinutes: toIntArray(src.leadMinutes, OJ_CONTEST_DEFAULTS.leadMinutes),
        dailyProblem: (() => {
            const dp = (src.dailyProblem && typeof src.dailyProblem === 'object') ? src.dailyProblem : {};
            return {
                enabled: dp.enabled === true,
                groups: (Array.isArray(dp.groups) ? dp.groups : []).map((id) => cleanText(id)).filter(Boolean)
            };
        })(),
        graceMs: Math.max(60000, toInt(src.graceMs, OJ_CONTEST_DEFAULTS.graceMs)),
        maxPerDay: Math.max(0, toInt(src.maxPerDay, OJ_CONTEST_DEFAULTS.maxPerDay)),
        timeoutMs: Math.max(1000, toInt(src.timeoutMs, OJ_CONTEST_DEFAULTS.timeoutMs)),
        stateFile: cleanText(src.stateFile) || OJ_CONTEST_DEFAULTS.stateFile
    };
}

/** 无时区的 ISO 一律当 UTC（与 oj-feedback 的 formatBeijingTime 同约定）。 */
export function parseOjTime(value) {
    const text = cleanText(value);
    if (!text) return NaN;
    const hasZone = text.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(text);
    const ms = Date.parse(hasZone ? text : `${text}Z`);
    return Number.isFinite(ms) ? ms : NaN;
}

export function normalizeContestItem(raw = {}) {
    const startMs = parseOjTime(raw.start_time ?? raw.startTime);
    const endMs = parseOjTime(raw.end_time ?? raw.endTime);
    return {
        id: toInt(raw.id, 0),
        title: cleanText(raw.title) || `比赛 #${toInt(raw.id, 0)}`,
        startMs,
        endMs: Number.isFinite(endMs) ? endMs : startMs,
        status: cleanText(raw.status),
        isPublic: raw.is_public === undefined ? 1 : toInt(raw.is_public, 1),
        participantCount: toInt(raw.participant_count ?? raw.participantCount, 0)
    };
}

export function parseContestList(payload = {}) {
    const list = Array.isArray(payload)
        ? payload
        : (Array.isArray(payload?.items) ? payload.items
            : (Array.isArray(payload?.data) ? payload.data : []));
    return list
        .map(normalizeContestItem)
        .filter((item) => item.id > 0 && Number.isFinite(item.startMs));
}

/** 最近一场还没结束的公开比赛（进行中的也算，用于"已经开始了"那句）。 */
export function selectNextContest(items = [], now = Date.now()) {
    const candidates = items
        .filter((item) => item.isPublic !== 0)
        .filter((item) => item.endMs > now || item.startMs > now)
        .sort((a, b) => a.startMs - b.startMs);
    return candidates[0] || null;
}

/** 北京时间口径的 {date, hour, minute}，用于"今天/明天/N 天"和每日时刻判断。 */
export function beijingParts(ms) {
    const d = new Date(Number(ms) + BEIJING_OFFSET_MS);
    return {
        date: d.toISOString().slice(0, 10),
        hour: d.getUTCHours(),
        minute: d.getUTCMinutes(),
        days: Math.floor(d.getTime() / DAY_MS)
    };
}

function pad(n) {
    return String(n).padStart(2, '0');
}

/** 用"天差"（北京日期）说人话：今天 / 明天 / N 天后。 */
export function formatContestWhen(startMs, now = Date.now()) {
    const s = beijingParts(startMs);
    const n = beijingParts(now);
    const clock = `${pad(s.hour)}:${pad(s.minute)}`;
    const diff = s.days - n.days;
    if (diff === 0) return `今天 ${clock}`;
    if (diff === 1) return `明天 ${clock}`;
    if (diff === 2) return `后天 ${clock}`;
    return `${s.date.slice(5).replace('-', '/')} ${clock}`;
}

/** 倒计时短语：按剩余时间给"还有 N 天/N 小时/N 分钟"。 */
export function formatCountdown(startMs, now = Date.now()) {
    const left = startMs - now;
    if (left <= 0) return '已经开始了';
    const days = Math.floor((beijingParts(startMs).days - beijingParts(now).days));
    if (left >= DAY_MS && days >= 1) return `还有 ${days} 天`;
    const hours = Math.floor(left / 3600000);
    if (hours >= 1) return `还有 ${hours} 小时`;
    const minutes = Math.max(1, Math.round(left / 60000));
    return `还有 ${minutes} 分钟`;
}

// 收尾那句：从池子里挑（按比赛 id 定，稳定可复现），不列进提示词规则里
// —— 项目规律：规则里列举范词会收敛到第一个。
export const CONTEST_TAILS = Object.freeze({
    daily: ['记得留时间。', '先记着。', '到时候别忘。', '有空就来。'],
    soon: ['准备好。', '别迟到。', '手边留点时间。', '差不多该准备了。'],
    start: ['开始了。', '现在就可以进了。', '开始了，去吧。']
});

function pickTail(kind, seed) {
    const pool = CONTEST_TAILS[kind] || CONTEST_TAILS.soon;
    return pool[Math.abs(toInt(seed, 0)) % pool.length];
}

/** 种子可能是 `5:lead:60` 这种字符串 ⇒ 先哈希成数字，否则 toInt 一律吃成 0（三条尾巴会一模一样）。 */
export function seedFrom(value) {
    const text = cleanText(value);
    if (/^\d+$/.test(text)) return toInt(text, 0);
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

/**
 * @param {'daily'|'soon'|'start'} kind
 */
export function buildContestNotice(contest = {}, options = {}) {
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const kind = options.kind || 'soon';
    const base = cleanText(options.baseUrl).replace(/\/+$/, '');
    const when = formatContestWhen(contest.startMs, now);
    const countdown = formatCountdown(contest.startMs, now);

    let head;
    if (kind === 'start') {
        head = `【比赛】「${contest.title}」${countdown}`;
    } else if (kind === 'daily') {
        head = `【比赛倒计时】「${contest.title}」${countdown}`;
    } else {
        head = `【比赛提醒】「${contest.title}」${countdown}`;
    }

    const lines = [head, `${when} 开始 · ${pickTail(kind, seedFrom(options.seed ?? contest.id))}`];
    if (base && contest.id) {
        lines.push(`${base}/contests/${contest.id}`);
    }
    return lines.join('\n');
}

// ------------------------------------------------------------------ 每日一题

/**
 * OJ `/api/daily-problem` 的返回（2026-10-16 实测）：
 * `{ date, title, note, luogu_pid, problem_id, published_problem_id, link, display_no }`
 * - 已发布到 OJ ⇒ `link = /problems/{id}`；否则 ⇒ `link = /luogu/{pid}`
 * - **没安排的那天 `link` 是 null** ⇒ 直接跳过，别发空消息
 */
export function normalizeDailyProblem(raw = {}) {
    return {
        date: cleanText(raw.date),
        title: cleanText(raw.title),
        link: cleanText(raw.link),
        luoguPid: cleanText(raw.luogu_pid),
        displayNo: toInt(raw.display_no ?? raw.published_problem_id ?? raw.problem_id, 0),
        note: cleanText(raw.note)
    };
}

/** 每日一题播报文案（素世口吻：短、只给题和链接） */
export function buildDailyProblemNotice(item = {}, options = {}) {
    const base = cleanText(options.baseUrl).replace(/\/+$/, '');
    const label = item.luoguPid || (item.displayNo > 0 ? `#${item.displayNo}` : '');
    const head = ['【每日一题】', label, item.title].filter(Boolean).join(' ');
    const lines = [head];
    if (item.link) {
        lines.push(`${base}${item.link}`);
    }
    return lines.join('\n');
}

/**
 * 今天这一条该不该发（纯函数，便于单测）。
 * 口径：过了当天时刻且在 grace（默认 3 小时）内 ⇒ 发；当天已发过 ⇒ 不发。
 * ⚠ 与比赛倒计时**共用** `dailyAtMinutes`（9 点），但用 `daily-problem:<日期>` 单独去重，
 *   也**不占** maxPerDay 的额度（它是每天例行的，不是提醒）。
 */
export function pickDueDailyProblem(item = {}, now = Date.now(), state = {}, cfg = {}) {
    if (!cleanText(item?.link)) return null;
    const key = `daily-problem:${beijingParts(now).date}`;
    if ((state.notified || {})[key]) return null;
    const nowMinutes = beijingParts(now).hour * 60 + beijingParts(now).minute;
    const slots = Array.isArray(cfg.dailyAtMinutes) ? cfg.dailyAtMinutes : [];
    if (!slots.some((slot) => nowMinutes >= slot && nowMinutes - slot <= 180)) return null;
    return { kind: 'dailyProblem', key };
}

// ------------------------------------------------------------------ 状态文件

export async function readOjContestState(stateFile, { logger = console } = {}) {
    try {
        const raw = await fs.readFile(stateFile, 'utf8');
        const data = JSON.parse(raw);
        return {
            notified: data && typeof data.notified === 'object' && data.notified ? data.notified : {},
            dailyDate: cleanText(data?.dailyDate),
            dayDate: cleanText(data?.dayDate),
            dayCount: toInt(data?.dayCount, 0),
            updatedAt: cleanText(data?.updatedAt)
        };
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            logger.warn?.(`[比赛倒计时] 读取状态失败，按空状态处理: ${error?.message}`);
        }
        return { notified: {}, dailyDate: '', dayDate: '', dayCount: 0, updatedAt: '' };
    }
}

export async function writeOjContestState(stateFile, state = {}, { logger = console } = {}) {
    try {
        const payload = JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2);
        await fs.writeFile(stateFile, payload, 'utf8');
    } catch (error) {
        logger.warn?.(`[比赛倒计时] 写入状态失败: ${error?.message}`);
    }
}

const NOTIFIED_CACHE_MAX = 200;

function pruneNotified(notified = {}) {
    const keys = Object.keys(notified);
    if (keys.length <= NOTIFIED_CACHE_MAX) return notified;
    const sorted = keys.sort((a, b) => toInt(notified[a], 0) - toInt(notified[b], 0));
    const out = {};
    for (const key of sorted.slice(sorted.length - NOTIFIED_CACHE_MAX)) {
        out[key] = notified[key];
    }
    return out;
}

/**
 * 算出"这一轮该开口说什么"。纯函数，便于单测；返回 [] 就是不用说话。
 * @returns {Array<{kind: string, key: string}>}
 */
export function pickDueNotices(contest = {}, now = Date.now(), state = {}, cfg = {}) {
    const out = [];
    if (!contest || !Number.isFinite(contest.startMs)) return out;
    const notified = state.notified || {};
    const graceMs = Number.isFinite(cfg.graceMs) ? cfg.graceMs : OJ_CONTEST_DEFAULTS.graceMs;
    const today = beijingParts(now);

    // ① 每日倒计时：过了当天时刻、且**当天符合"赛前 N 天"**、且当天没念过
    //    2026-10-16 用户要求：只在赛前 7/3/2/1 天的 9 点提醒（不是每天都念）。
    const inWindowDays = beijingParts(contest.startMs).days - beijingParts(now).days;
    const nowMinutes = today.hour * 60 + today.minute;
    const windowDays = Number.isFinite(cfg.countdownWindowDays)
        ? cfg.countdownWindowDays : OJ_CONTEST_DEFAULTS.countdownWindowDays;
    const countdownDays = Array.isArray(cfg.countdownDays) ? cfg.countdownDays : [];
    const dayRuleHit = countdownDays.length > 0
        ? countdownDays.includes(inWindowDays)                 // 精确命中「赛前 N 天」
        : (inWindowDays >= 0 && inWindowDays <= windowDays);   // 旧行为：窗口内每天
    const dailySlots = Array.isArray(cfg.dailyAtMinutes) ? cfg.dailyAtMinutes : [];
    const dailyKey = `${contest.id}:daily:${today.date}`;
    if (!notified[dailyKey]
        && contest.startMs > now
        && dayRuleHit
        && dailySlots.some((slot) => nowMinutes >= slot && nowMinutes - slot <= 180)) {
        out.push({ kind: 'daily', key: dailyKey });
    }

    // ② 赛前提醒：到点且没过 grace
    const leads = Array.isArray(cfg.leadMinutes) ? cfg.leadMinutes : [];
    for (const lead of leads) {
        const dueAt = contest.startMs - lead * 60000;
        const key = `${contest.id}:lead:${lead}`;
        if (notified[key]) continue;
        if (now < dueAt) continue;
        if (now >= contest.startMs) continue;      // 已经开赛 ⇒ 交给 ③
        if (now - dueAt > graceMs) continue;       // 过太久 ⇒ 只标记不发（下一段负责标记）
        out.push({ kind: 'soon', key });
    }

    // ③ 开赛
    const startKey = `${contest.id}:start`;
    if (!notified[startKey] && now >= contest.startMs && now <= contest.endMs && now - contest.startMs <= graceMs) {
        out.push({ kind: 'start', key: startKey });
    }

    return out;
}

/** 超过 grace 的旧提醒也要记上，否则下次轮询会一直"到点"（但永远不发）。 */
export function expiredNoticeKeys(contest = {}, now = Date.now(), state = {}, cfg = {}) {
    const notified = state.notified || {};
    const graceMs = Number.isFinite(cfg.graceMs) ? cfg.graceMs : OJ_CONTEST_DEFAULTS.graceMs;
    const keys = [];
    if (!contest || !Number.isFinite(contest.startMs)) return keys;
    for (const lead of (cfg.leadMinutes || [])) {
        const dueAt = contest.startMs - lead * 60000;
        const key = `${contest.id}:lead:${lead}`;
        // 只看"过点超过 grace"：开赛之后这些 key 也一并记上，免得一直悬在那里被反复判定
        if (!notified[key] && now - dueAt > graceMs) {
            keys.push(key);
        }
    }
    const startKey = `${contest.id}:start`;
    if (!notified[startKey] && now > contest.endMs) {
        keys.push(startKey);
    }
    return keys;
}

// ------------------------------------------------------------------ 轮询器

export class OjContestPoller {
    constructor({
        getConfig,
        getFallbackConfig = () => ({}),
        logger = console,
        fetchImpl = globalThis.fetch,
        onNotice = null,
        onDailyProblem = null,
        stateFile = null
    } = {}) {
        this.getConfig = typeof getConfig === 'function' ? getConfig : () => ({});
        this.getFallbackConfig = typeof getFallbackConfig === 'function' ? getFallbackConfig : () => ({});
        this.logger = logger;
        this.fetchImpl = fetchImpl;
        this.onNotice = onNotice;
        this.onDailyProblem = onDailyProblem;
        this.stateFile = stateFile;
        this.timer = null;
        this.running = false;
        this.accessToken = '';
        this.state = null;
    }

    config() {
        return normalizeOjContestConfig(this.getConfig(), this.getFallbackConfig());
    }

    async login() {
        const cfg = this.config();
        if (!cfg.username || !cfg.password) {
            this.accessToken = '';
            return '';
        }
        const response = await this.fetchImpl(`${cfg.baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: cfg.username, password: cfg.password }),
            signal: AbortSignal.timeout(cfg.timeoutMs)
        });
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`登录失败 ${response.status}: ${text.slice(0, 120)}`);
        }
        this.accessToken = cleanText(JSON.parse(text)?.access_token);
        return this.accessToken;
    }

    async requestJson(pathname, { retryOnAuth = true } = {}) {
        const cfg = this.config();
        const doFetch = () => {
            const headers = { Accept: 'application/json' };
            if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;
            return this.fetchImpl(`${cfg.baseUrl}${pathname}`, {
                headers,
                signal: AbortSignal.timeout(cfg.timeoutMs)
            });
        };
        let response = await doFetch();
        if ((response.status === 401 || response.status === 403) && retryOnAuth && cfg.username && cfg.password) {
            await this.login();
            response = await doFetch();
        }
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`请求 ${pathname} 失败 ${response.status}: ${text.slice(0, 120)}`);
        }
        return JSON.parse(text);
    }

    async ensureState() {
        if (this.state) return this.state;
        this.state = await readOjContestState(this.stateFile, { logger: this.logger });
        return this.state;
    }

    async saveState() {
        await writeOjContestState(this.stateFile, this.state || {}, { logger: this.logger });
    }

    async pollOnce({ now = Date.now() } = {}) {
        const cfg = this.config();
        if (!cfg.enabled) return { skipped: true };
        if (!cfg.baseUrl) throw new Error('缺少 OJ 地址（ojContest.baseUrl 没配）');
        const dailyGroups = (cfg.dailyProblem.groups || []).length > 0
            ? cfg.dailyProblem.groups : cfg.notifyGroups;
        if (cfg.notifyGroups.length === 0 && dailyGroups.length === 0) {
            throw new Error('没有通知目标（ojContest.notifyGroups 是空的）');
        }

        const state = await this.ensureState();
        const today = beijingParts(now).date;
        if (state.dayDate !== today) {
            state.dayDate = today;
            state.dayCount = 0;
        }
        let sent = 0;

        // >>> 每日一题 >>>
        // ⚠ 必须**独立于比赛**：没有未结束的比赛时也要照发（所以不能放在下面的 early-return 之后）
        if (cfg.dailyProblem.enabled && dailyGroups.length > 0) {
            try {
                const dailyPayload = await this.requestJson('/api/daily-problem');
                const item = normalizeDailyProblem(dailyPayload);
                const dueDaily = pickDueDailyProblem(item, now, state, cfg);
                if (dueDaily) {
                    await this.onDailyProblem?.(item, { now, key: dueDaily.key, groups: dailyGroups });
                    state.notified[dueDaily.key] = now;   // 发成功才标记（失败下轮重试）
                    sent += 1;
                    this.logger.info?.(`[每日一题] 已播报 ${dueDaily.key}`, {
                        title: item.title,
                        link: item.link,
                        groups: dailyGroups
                    });
                } else if (!item.link) {
                    this.logger.debug?.(`[每日一题] ${item.date || today} 没有安排题目，跳过`);
                }
            } catch (error) {
                this.logger.warn?.(`[每日一题] 拉取或发送失败: ${error?.message}`);
            }
        }
        // <<< 每日一题 >>>

        const payload = await this.requestJson('/api/contests?page_size=50');
        const contest = selectNextContest(parseContestList(payload), now);
        if (!contest) {
            this.logger.debug?.('[比赛倒计时] 没有未结束的比赛');
            state.notified = pruneNotified(state.notified);
            await this.saveState();
            return { sent, contest: null };
        }

        const due = pickDueNotices(contest, now, state, cfg);
        // 过期的旧提醒直接标记，避免每轮重复判定
        for (const key of expiredNoticeKeys(contest, now, state, cfg)) {
            state.notified[key] = now;
        }

        for (const item of due) {
            if (cfg.maxPerDay > 0 && state.dayCount >= cfg.maxPerDay) {
                this.logger.warn?.(`[比赛倒计时] 今天已达上限 ${cfg.maxPerDay} 条，跳过 ${item.key}`);
                break;
            }
            try {
                await this.onNotice?.(contest, item.kind, { now, key: item.key });
                state.notified[item.key] = now;
                state.dayCount += 1;
                sent += 1;
                this.logger.info?.(`[比赛倒计时] 已播报 ${item.kind} ${item.key}（今天第 ${state.dayCount} 条）`);
            } catch (error) {
                // 发失败 ⇒ **不标记**，下一轮重试（播报类功能最忌静默丢事件）
                this.logger.warn?.(`[比赛倒计时] ${item.key} 发送失败，下轮重试: ${error?.message}`);
            }
        }

        state.notified = pruneNotified(state.notified);
        await this.saveState();
        return { sent, contest };
    }

    start() {
        if (this.timer) return this.timer;
        const cfg = this.config();
        const tick = async () => {
            if (this.running) return;
            this.running = true;
            try {
                await this.pollOnce();
            } catch (error) {
                this.logger.warn?.(`[比赛倒计时] 轮询失败: ${error?.message}`);
            } finally {
                this.running = false;
            }
        };
        this.timer = setInterval(tick, cfg.intervalMs);
        this.timer.unref?.();
        tick();
        this.logger.info?.(`[比赛倒计时] 已启动，每 ${Math.round(cfg.intervalMs / 60000)} 分钟检查一次，`
            + `目标群 ${cfg.notifyGroups.join(',')}，每日时刻 ${cfg.dailyAtMinutes.map((m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`).join('/')}`);
        return this.timer;
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}
