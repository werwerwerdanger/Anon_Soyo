/**
 * OJ AC 播报（提交通过通知）
 * ---------------------------------------------------------------------------
 * 解决什么问题
 * ------------
 * 群里想要一条"谁过题了"的播报。原先 MimirLink 只做**反馈**转发
 * （`oj-feedback.js`，拉 `/api/admin/feedback`），代码里**没有任何判题/AC 逻辑**
 * （全 src 搜 `Accepted`/`AC`/`判题`/`submission` 零命中）。
 * 这里补上：轮询 `/api/submissions`，把**新的 AC** 发到指定群。
 *
 * OJ 侧的既有事实（2026-10-12 在服务器上实测，别再猜）
 * --------------------------------------------------
 * - `GET /api/submissions?limit=&page=` → `{ items, total, page, page_size }`
 *   ⚠ **page_size 被服务端夹在 20**（请求 limit=100 也只回 20 条）⇒ 单页够轮询用，
 *     真要翻历史得靠 `page`。
 * - item 字段：`id / source / problem_id / problem_no / problem_title / user_id /
 *   username / language / status / time_used_ms / memory_used_kb / score / created_at`
 * - 🔴 **`status` 是小写：`'ac'` / `'wa'`**（不是 `'AC'`/`'Accepted'`）。
 *   用大写比较会一条都匹配不到 —— 而且**不会报错，只会静默 0 条**，最难查的那种。
 * - **列表按 id 降序（新在前）** ⇒ 和反馈一样，可以只靠 `lastSeenId` 去重。
 * - `/api/submissions` **不需要 token 也能取**（实测 200）。仍走鉴权请求，
 *   只为和反馈模块共用同一套 client；多一条 token 过期路径，但已有自动重登兜住。
 * - 提交详情页路由是 **`/submissions/<id>`**（不是 `/submission/<id>`、不是 `/submit/<id>`；
 *   后两个实测分别 404 / 是"提交代码页"）。判定方法：拿一个确定不存在的路径当基线比响应长度。
 * - TLS：Let's Encrypt 的 **IP 短效证书**，普通校验就能过 ⇒ **不要关 TLS 校验**。
 *
 * 凭据为什么不在这里重复存一份
 * ----------------------------
 * `ojAc` 的 `baseUrl/username/password` **留空即继承 `ojFeedback`**。
 * 那串密码是本项目唯一允许落进 `config.json` 的凭据，**存两份就是双倍暴露面**，
 * 而且改密码时必然忘掉其中一处（早晚的事）。
 *
 * 首次运行刻意不回补
 * ------------------
 * 状态文件不存在时把 `lastSeenId` 对齐到当前最大 id，**一条都不发**。
 * 不然第一次启动会把 OJ 上 1000+ 条历史提交全播一遍 —— 群里直接刷屏。
 *
 * 🔴 为什么还要自己查题目可见性（2026-10-12 用户实测报的 bug）
 * ----------------------------------------------------------
 * 起因：群友截图 —— 题 125「阶梯三角形」**当时被隐藏着**，Yuno 的 AC 照样播了出去。
 *
 * 查证后的机制（重要，别记错）：
 * - `/api/submissions` **排除的是"未开赛比赛的题"**（如比赛 5 的 117–124，`status=upcoming`），
 *   **不是** `is_hidden`。
 *   实测：全部 1240 条提交里，落在 117–124 上的是 **0 条**；
 *   但这 8 道题 `submit_count` 有 2~3 且都有 accept ⇒ 有人交过，是被提交流滤掉的。
 * - 而**一道普通题被后台临时隐藏（`is_hidden=1`）时，它的提交照样出现在提交流里** ⇒
 *   只看 `status === 'ac'` 就会把隐藏题的 AC 播出去。
 * - ⚠ **`/api/problems/{id}` 详情接口不返回 `is_hidden`**（实测是 undefined），
 *   只有**列表**接口有 ⇒ 可见性必须从列表拿。
 *
 * ⇒ 所以播报前先用**默认列表**（不带 `include_hidden`，即"同学能看到的那份"）
 *   建一个**可播题目集合**，不在集合里的直接跳过。这比只查 `is_hidden` 更稳：
 *   连"未开赛比赛的题"也一并挡住了。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { formatBeijingTime } from './oj-feedback.js';

export const OJ_AC_DEFAULTS = Object.freeze({
    enabled: false,
    baseUrl: '',
    username: '',
    password: '',
    intervalMs: 60000,
    timeoutMs: 15000,
    notifyGroups: [],
    maxPerPoll: 5,
    onlyPublicProblems: true,
    problemCacheMs: 600000,
    stateFile: 'data/oj-ac-state.json'
});

// 只播这些 status（小写）
export const AC_STATUS = 'ac';

function cleanText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function toInt(value, fallback) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
}

/**
 * 归一化。`fallback` 传已归一化的 ojFeedback 配置 ⇒ 空值从那里继承。
 */
export function normalizeOjAcConfig(source = {}, fallback = {}) {
    const input = source && typeof source === 'object' ? source : {};
    const groups = Array.isArray(input.notifyGroups) ? input.notifyGroups : [];
    const pick = (key) => cleanText(input[key]) || cleanText(fallback[key]);
    return {
        enabled: typeof input.enabled === 'boolean' ? input.enabled : OJ_AC_DEFAULTS.enabled,
        baseUrl: pick('baseUrl').replace(/\/+$/, ''),
        username: pick('username'),
        password: pick('password'),
        intervalMs: Math.max(10000, toInt(input.intervalMs, OJ_AC_DEFAULTS.intervalMs)),
        timeoutMs: Math.max(1000, toInt(input.timeoutMs, OJ_AC_DEFAULTS.timeoutMs)),
        notifyGroups: Array.from(new Set(groups.map(cleanText).filter(Boolean))),
        maxPerPoll: Math.min(50, Math.max(1, toInt(input.maxPerPoll, OJ_AC_DEFAULTS.maxPerPoll))),
        // 默认 true：只播"同学能看到"的题（隐藏题/未开赛比赛的题都挡住）
        onlyPublicProblems: typeof input.onlyPublicProblems === 'boolean'
            ? input.onlyPublicProblems : OJ_AC_DEFAULTS.onlyPublicProblems,
        problemCacheMs: Math.max(30000, toInt(input.problemCacheMs, OJ_AC_DEFAULTS.problemCacheMs)),
        stateFile: cleanText(input.stateFile) || OJ_AC_DEFAULTS.stateFile
    };
}

/** 接口返回的一条 → 内部结构。字段名只转一次，后面不用再猜。 */
export function normalizeSubmissionItem(raw = {}) {
    const id = toInt(raw.id, 0);
    if (id <= 0) {
        return null;
    }
    return {
        id,
        problemId: toInt(raw.problem_id, 0),
        problemNo: cleanText(raw.problem_no),
        problemTitle: cleanText(raw.problem_title),
        username: cleanText(raw.username) || '匿名',
        userId: raw.user_id ?? null,
        language: cleanText(raw.language),
        status: cleanText(raw.status).toLowerCase(),
        timeUsedMs: toInt(raw.time_used_ms, 0),
        memoryUsedKb: toInt(raw.memory_used_kb, 0),
        score: raw.score ?? null,
        createdAt: cleanText(raw.created_at)
    };
}

/** 只认真正的数组 —— 接口改结构时宁可 0 条，也别把 undefined 当一条发出去。 */
export function parseSubmissionList(payload = {}) {
    const items = payload && Array.isArray(payload.items) ? payload.items : [];
    return items.map(normalizeSubmissionItem).filter(Boolean);
}

/**
 * 挑出要播的：`ac` + 比 lastSeenId 新。
 * 返回按 id **升序**（旧的先发，群里顺序才自然）。
 */
export function selectNewAc(items = [], lastSeenId = 0, maxPerPoll = 5) {
    return items
        .filter((item) => item.status === AC_STATUS && item.id > lastSeenId)
        .sort((a, b) => a.id - b.id)
        .slice(0, Math.max(1, maxPerPoll));
}

export function maxSubmissionId(items = []) {
    return items.reduce((max, item) => (item.id > max ? item.id : max), 0);
}

/**
 * 按题目可见性分流：`allowedIds` 为 null 表示"没拿到可见性数据"。
 * 纯函数，方便单测（集合从外部传进来）。
 */
export function partitionByVisibility(items = [], allowedIds = null) {
    if (!allowedIds) {
        return { visible: items, hidden: [] };
    }
    const visible = [];
    const hidden = [];
    for (const item of items) {
        (allowedIds.has(item.problemId) ? visible : hidden).push(item);
    }
    return { visible, hidden };
}

function humanSize(kb) {
    const n = toInt(kb, 0);
    if (n <= 0) {
        return '';
    }
    return n >= 1024 ? `${(n / 1024).toFixed(1)}MB` : `${n}KB`;
}

/**
 * 播报末尾那一句。
 *
 * ⚠ 2026-10-13 用户先后两次纠正这里，两次都值得记住：
 *   ① 「在 ac 播报下面夸一下」→ 我写成"夸"（「厉害了 我记住你了」「这题我看一眼都头疼诶」）
 *      ⇒ 用户：「**你现在夸得也好怪，可以随便说点话就是**」。
 *      **问题在于"用力"** —— 真人看到群里过题，随口一句就够了，专门去夸反而假。
 *   ② 所以这里**不是"夸"**，是**随口一句**：以 2~5 字为主，短的、平的、不捧人的。
 *
 * 🔑 按 id 取模而不是随机：这个播报是 **at-least-once** 的
 *（发送失败时游标不前进，下一轮会重发，见 §27.3）。如果随机挑，
 * 重发时会换一句 ⇒ 同一份成绩两次播报内容不同。取模 ⇒ **同一条提交永远同一句**。
 */
export const AC_PRAISE = Object.freeze([
    '哦 过了',
    '可以啊',
    '过了过了',
    '嗯 不错',
    '好耶',
    '稳',
    '行 下一个',
    '诶 过了',
    '哟 可以',
    '这么快',
    '又一道',
    '哦豁',
    '不错嘛',
    '直接过 可以',
    '行啊',
    '过了 收工',
    '可以可以',
    '一次就过啊',
    '挺好',
    '强的',
    '咦 这么快',
    '好 下一个是谁'
]);

export function pickAcPraise(id) {
    const n = Math.abs(toInt(id, 0));
    return AC_PRAISE[n % AC_PRAISE.length];
}

/**
 * 播报文案。
 * ⚠ 2026-10-13 回滚说明：我一度把整个格式重做了（去掉 `【】` 标签、`·` 罗列、内存字段，
 *   把夸句并进主干句）。用户澄清**只想要"最后一句从鼓励池里取"**，格式不该动
 *   ⇒ 已回滚成原格式，并把 `AC_PRAISE` 从 7 句扩到 24 句（反复见同几句本身就"人机"）。
 *   保留 `options.plain`（走同一份原格式，兼容）/`options.praise === false`（关掉夸句）/
 *   `options.praise`（传字符串替换那一句）。
 */
export function buildAcNotice(item = {}, options = {}) {
    const when = formatBeijingTime(item.createdAt, options.now);
    const head = `【OJ AC #${item.id}】${item.username}${when ? ` · ${when}` : ''}`;
    const no = item.problemNo ? `#${item.problemNo}` : '';
    const title = [no, item.problemTitle].filter(Boolean).join(' ');

    const meta = [];
    if (item.language) {
        meta.push(item.language);
    }
    if (item.timeUsedMs > 0) {
        meta.push(`${item.timeUsedMs}ms`);
    }
    const mem = humanSize(item.memoryUsedKb);
    if (mem) {
        meta.push(mem);
    }
    if (item.score !== null && item.score !== undefined && item.score !== '') {
        meta.push(`${item.score} 分`);
    }

    const lines = [head, '', title || `提交 #${item.id}`];
    if (meta.length > 0) {
        lines.push(meta.join(' · '));
    }
    const base = cleanText(options.baseUrl).replace(/\/+$/, '');
    if (base) {
        lines.push(`${base}/submissions/${item.id}`);
    }
    // 最后一句：从鼓励池里调一句（用户要的就是这一条改动）
    if (options.praise !== false) {
        lines.push('', cleanText(options.praise) || pickAcPraise(item.id));
    }
    return lines.join('\n');
}

export async function readOjAcState(stateFile, { logger = console } = {}) {
    try {
        const raw = await fs.readFile(stateFile, 'utf8');
        const data = JSON.parse(raw);
        return { lastSeenId: toInt(data?.lastSeenId, 0), updatedAt: cleanText(data?.updatedAt) };
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            logger.warn?.(`[AC播报] 状态文件读取失败（按首次运行处理）: ${error.message}`);
        }
        return { lastSeenId: 0, updatedAt: '' };
    }
}

export async function writeOjAcState(stateFile, state, { logger = console } = {}) {
    try {
        await fs.mkdir(path.dirname(stateFile), { recursive: true });
        await fs.writeFile(stateFile, JSON.stringify({
            lastSeenId: toInt(state?.lastSeenId, 0),
            updatedAt: new Date().toISOString()
        }, null, 2), 'utf8');
    } catch (error) {
        logger.warn?.(`[AC播报] 状态文件写入失败: ${error.message}`);
    }
}

/** 轮询器。结构与 OjFeedbackPoller 保持一致，方便对着看。 */
export class OjAcPoller {
    constructor({
        getConfig,
        getFallbackConfig = () => ({}),
        logger = console,
        fetchImpl = globalThis.fetch,
        onNewAc = null,
        stateFile = null
    } = {}) {
        this.getConfig = typeof getConfig === 'function' ? getConfig : () => ({});
        this.getFallbackConfig = typeof getFallbackConfig === 'function' ? getFallbackConfig : () => ({});
        this.logger = logger;
        this.fetchImpl = fetchImpl;
        this.onNewAc = onNewAc;
        this.stateFile = stateFile;
        this.timer = null;
        this.running = false;
        this.accessToken = '';
        this.lastSeenId = null;
        this.failureStreak = 0;
        this.visibleProblemIds = null;
        this.visibleProblemAt = 0;
    }

    config() {
        return normalizeOjAcConfig(this.getConfig(), this.getFallbackConfig());
    }

    async login() {
        const cfg = this.config();
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
        const token = cleanText(JSON.parse(text)?.access_token);
        if (!token) {
            throw new Error('登录响应里没有 access_token');
        }
        this.accessToken = token;
        return token;
    }

    async requestJson(pathname, { retryOnAuth = true } = {}) {
        const cfg = this.config();
        if (!this.accessToken) {
            await this.login();
        }
        const doFetch = () => this.fetchImpl(`${cfg.baseUrl}${pathname}`, {
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${this.accessToken}`
            },
            signal: AbortSignal.timeout(cfg.timeoutMs)
        });
        let response = await doFetch();
        // token 过期 → 重登一次再试，只重试一轮
        if ((response.status === 401 || response.status === 403) && retryOnAuth) {
            this.accessToken = '';
            await this.login();
            response = await doFetch();
        }
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`请求 ${pathname} 失败 ${response.status}: ${text.slice(0, 120)}`);
        }
        return JSON.parse(text);
    }

    /**
     * 「同学能看到的题目」id 集合（带 TTL 缓存）。
     *
     * 用**默认列表**（不带 include_hidden）—— 那份列表就是同学看到的那份，
     * 隐藏题和未开赛比赛的题都不在里面。这比单独查 is_hidden 更稳：
     * 详情接口根本不返回 is_hidden（实测 undefined），而且未开赛比赛的题
     * 也不一定带 is_hidden=1。
     *
     * ⚠ page_size 被服务端夹在 20 ⇒ 必须翻页，别只取第一页（否则大部分题会被误判成"不可见"）。
     */
    async getVisibleProblemIds() {
        const cfg = this.config();
        const now = Date.now();
        if (this.visibleProblemIds && (now - this.visibleProblemAt) < cfg.problemCacheMs) {
            return this.visibleProblemIds;
        }
        const ids = new Set();
        let page = 1;
        let total = null;
        while (page <= 50) {
            const payload = await this.requestJson(`/api/problems?limit=100&page=${page}`);
            const items = Array.isArray(payload?.items) ? payload.items : [];
            if (total === null) {
                total = toInt(payload?.total, items.length);
            }
            for (const p of items) {
                const id = toInt(p?.id, 0);
                if (id > 0) {
                    ids.add(id);
                }
            }
            if (items.length === 0 || ids.size >= total) {
                break;
            }
            page += 1;
        }
        if (ids.size === 0) {
            throw new Error('可见题目列表为空，拒绝据此判定（防止把全部提交都当成"不可见"）');
        }
        this.visibleProblemIds = ids;
        this.visibleProblemAt = now;
        return ids;
    }

    async ensureState() {
        if (this.lastSeenId !== null) {
            return;
        }
        const state = await readOjAcState(this.stateFile, { logger: this.logger });
        if (state.lastSeenId > 0) {
            this.lastSeenId = state.lastSeenId;
            return;
        }
        // 首次运行：对齐到当前最大 id，一条都不发（见文件头注释）
        const payload = await this.requestJson('/api/submissions?limit=20');
        const items = parseSubmissionList(payload);
        this.lastSeenId = maxSubmissionId(items);
        await writeOjAcState(this.stateFile, { lastSeenId: this.lastSeenId }, { logger: this.logger });
        this.logger.info?.(`[AC播报] 首次运行，游标对齐到 #${this.lastSeenId}，不回补历史`);
    }

    async pollOnce() {
        const cfg = this.config();
        if (!cfg.enabled) {
            return { skipped: true };
        }
        if (!cfg.baseUrl || !cfg.username || !cfg.password) {
            throw new Error('缺少 OJ 地址或凭据（ojAc 没配且 ojFeedback 也没配）');
        }
        await this.ensureState();

        const payload = await this.requestJson('/api/submissions?limit=20');
        const items = parseSubmissionList(payload);
        const fresh = items.filter((item) => item.id > this.lastSeenId).sort((a, b) => a.id - b.id);
        let targets = selectNewAc(items, this.lastSeenId, cfg.maxPerPoll);

        // 可见性闸门（见文件头「为什么还要自己查题目可见性」）。
        // 拿不到可见性就抛错 ⇒ 走下面的失败路径 ⇒ **游标不前进**，下轮重试。
        // 宁可晚播，也不要把隐藏题播出去 —— 泄露不可撤回，延迟可以。
        let visibleProblemIds = null;
        if (cfg.onlyPublicProblems) {
            visibleProblemIds = await this.getVisibleProblemIds();
            const split = partitionByVisibility(targets, visibleProblemIds);
            for (const item of split.hidden) {
                this.logger.warn?.(`[AC播报] 跳过 #${item.id}：题目 ${item.problemId} 对同学不可见`
                    + `（${item.problemTitle || '无标题'}）`);
            }
            targets = split.visible;
        }

        if (fresh.length > 0) {
            this.logger.info?.(`[AC播报] 新增提交 ${fresh.length} 条，`
                + `其中 AC ${targets.length} 条待播（可见题）`
                + (visibleProblemIds ? `（可播题目 ${visibleProblemIds.size} 道）` : ''));
        }

        let sent = 0;
        const failedIds = [];
        for (const item of targets) {
            try {
                await this.onNewAc?.(item);
                sent += 1;
            } catch (error) {
                failedIds.push(item.id);
                this.logger.warn?.(`[AC播报] #${item.id} 发送失败: ${error?.message}`);
            }
        }

        // 🔴 游标推进规则：**只在没发失败时**才推到本轮最大 id。
        // 否则（比如 NapCat 挂了）游标照样前进，那几条 AC 就**永久丢失**了 ——
        // 播报类功能最忌讳这种静默丢事件。发失败时退到最早失败那条之前，下一轮重试。
        // ⚠ 游标取的是"本轮见过的最大 id"而不是"最后一条 AC 的 id"：
        //   一批里最后一个 WA 之后可能还夹着 AC，用后者会把它们漏掉。
        const maxId = maxSubmissionId(items);
        let nextCursor = maxId;
        if (failedIds.length > 0) {
            nextCursor = Math.min(...failedIds) - 1;
        }
        if (nextCursor > this.lastSeenId) {
            this.lastSeenId = nextCursor;
            await writeOjAcState(this.stateFile, { lastSeenId: nextCursor }, { logger: this.logger });
        }
        return { fresh: fresh.length, sent, failed: failedIds.length, lastSeenId: this.lastSeenId };
    }

    start() {
        if (this.timer) {
            return;
        }
        const cfg = this.config();
        this.logger.info?.(`[AC播报] 轮询启动: ${cfg.baseUrl} 每 ${Math.round(cfg.intervalMs / 1000)}s，`
            + `通知群=${cfg.notifyGroups.join(',') || '无'}（只播 ${AC_STATUS}）`);
        const tick = async () => {
            try {
                await this.pollOnce();
                this.failureStreak = 0;
            } catch (error) {
                this.failureStreak += 1;
                this.logger.warn?.(`[AC播报] 本轮失败（连续 ${this.failureStreak} 次）: ${error?.message}`);
            } finally {
                const delay = Math.min(
                    cfg.intervalMs * Math.pow(2, Math.min(this.failureStreak, 4)),
                    cfg.intervalMs * 16
                );
                this.timer = setTimeout(tick, this.failureStreak > 0 ? delay : cfg.intervalMs);
                this.timer.unref?.();
            }
        };
        this.timer = setTimeout(tick, 1500);
        this.timer.unref?.();
    }

    stop() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
}
