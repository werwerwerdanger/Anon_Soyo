/**
 * 身份名册（participant roster）
 * ---------------------------------------------------------------------------
 * 解决什么问题
 * ------------
 * 记忆层是按「人」分库的：`memory_namespaces` 里每个 `private:<QQ>` / `group:<gid>`
 * 各占一个命名空间，召回时 namespace 钉死在**当前会话**，还带 currentParticipantId
 * 过滤。结果：她知道**此刻正在和她说话的人**是谁（历史头 `[昵称(QQ) hh:mm:ss]`），
 * 但"我刚刚还跟谁说过话"对她自己完全不可见。
 *
 * 实测（2026-10-11）：她在 private:1000000005 聊了 15 分钟，回到 private:2063362809
 * 被问「你觉得 1000000005 这个qq号的人怎么样」，那一轮 prompt 里 `1000000005`
 * 出现 0 次 —— 只能答「诶 这谁啊 / 一串数字我哪认得出来」。
 *
 * 代码里本来有一条能跨作用域查的 SQL（session.js 的 listParticipantProfilesFiltered），
 * 但（a）它只被网页面板/MCP 调用，聊天路径没用；（b）`memory.participantProfile.enabled`
 * 是 false，`participant_profile` 条目一条都没生成过。而 `getParticipantProfile`
 * 只喂**当前发言人**，本质是"我正在跟谁说话"，不是通讯录。
 *
 * 两层结构
 * --------
 * 1) **存储层**（`session.js`）：`participant_contacts` 表，写消息时 upsert。
 *    只存**身份**：QQ、昵称、曾用名、首次/最近见到、累计条数、最近在哪见的。
 *    ⇒ 与 `messages` 的摘要清理彻底解耦 —— 否则一个只在被清掉那段里说过话的人
 *      会**静默**从名单里消失（实测 group:929159193 累计 560 条、现存 106）。
 * 2) **渲染层**（本文件）：把表里的行合成一小段文本注入 prompt。
 *
 * 为什么 QQ 是唯一键（数据直接印证）
 * ----------------------------------
 * - 同一个 QQ 出现过两个昵称：`werwer(2063362809)` 与 `W(2063362809)`
 * - 两个不同 QQ 又叫同一个昵称：`werwer(2063362809)` 与 `werwer(1000000003)`
 * ⇒ **昵称做不了键，QQ 才能**；而"以前那个名字"必须靠 `name_history` 留住。
 *
 * 设计约束（都是本项目已经踩过的坑）
 * ----------------------------------
 * - 这块文本**每一轮都在** prompt 里 ⇒ 只放事实，不放形容词、行为标签、范例句。
 * - 卡里给带引号的例句会被逐字输出（同日两例）⇒ 这里只陈述事实，不给句子。
 * - 用**肯定式**。⛔ 不写"别说不认识"：本项目规律「否定句 = 二次 priming」，
 *   写"不认识"反而把"不认识"再喂一遍。
 * - **一个字正文都不放**。绝不要把 `private_user` 并成共享命名空间来"打通" ——
 *   那会在 A 的会话里说出 B 的私聊内容。
 */

import { stripStructuredEnvelope } from './structured-envelope.js';

export const PARTICIPANT_ROSTER_DEFAULTS = {
    enabled: false,
    // 详细条目（带"今天/昨天 + 时间"）的个数
    maxEntries: 12,
    // 名单里最多出现多少人。**详细之外的会压成一行只留 `昵称(QQ)`**。
    // ⚠ 为什么必须有这一层：只按"最近联系"截前 maxEntries 个，会导致
    // **被问到的那个人恰好排在第 maxEntries+1 位时静默消失** ——
    // 2026-10-11 实测：`曲奇饼干全肯定bot(1000000005)` 排在 25 人里的第 14 位，
    // maxEntries=12 把它截掉，于是用户问"你觉得 1000000005 这个人怎么样"、
    // 她答「诶 真没印象啊」—— 不是不肯认，是那行字真的不在上下文里。
    maxListedTotal: 40,
    maxAgeDays: 30,
    minMessages: 1,
    includeGroupMembers: true,
    excludeIds: [],
    // 「很多个称呼」：存 8 个曾用名，注入时最多显示 3 个（其余仍留在库里可检索）
    maxNameHistory: 8,
    maxAliasesShown: 3
};

const HEADER = '【你最近联系过的人】';
const DAY_MS = 24 * 60 * 60 * 1000;
// 「注意:」行里最多点几个提及（那行本来就短，多了会挤掉别的约束）
const MENTION_HINT_MAX = 2;

function clean(value) {
    return value === undefined || value === null ? '' : String(value).trim();
}

function normalizeIdList(value) {
    if (!Array.isArray(value)) return [];
    return Array.from(new Set(value.map((item) => clean(item)).filter(Boolean)));
}

function toPositiveInt(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.floor(n);
}

export function normalizeParticipantRosterConfig(raw = {}) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
        enabled: source.enabled === true,
        maxEntries: toPositiveInt(source.maxEntries, PARTICIPANT_ROSTER_DEFAULTS.maxEntries),
        maxListedTotal: toPositiveInt(source.maxListedTotal, PARTICIPANT_ROSTER_DEFAULTS.maxListedTotal),
        maxAgeDays: toPositiveInt(source.maxAgeDays, PARTICIPANT_ROSTER_DEFAULTS.maxAgeDays),
        minMessages: toPositiveInt(source.minMessages, PARTICIPANT_ROSTER_DEFAULTS.minMessages),
        includeGroupMembers: source.includeGroupMembers !== false,
        excludeIds: normalizeIdList(source.excludeIds),
        maxNameHistory: toPositiveInt(source.maxNameHistory, PARTICIPANT_ROSTER_DEFAULTS.maxNameHistory),
        maxAliasesShown: toPositiveInt(source.maxAliasesShown, PARTICIPANT_ROSTER_DEFAULTS.maxAliasesShown)
    };
}

/** 从 `private:2063362809` / `group:929159193` 里取类型与数字 id。 */
export function parseSessionKey(sessionId) {
    const text = clean(sessionId);
    const m = text.match(/^(private|group)[:_](\d+)$/i);
    if (!m) return null;
    return { kind: m[1].toLowerCase() === 'group' ? 'group' : 'private', id: m[2] };
}

/**
 * 从 `metadata_json.participants` 的元素里取昵称 / QQ 号。
 * 元素格式是 MimirLink 自己的 `昵称(QQ)`（见 buildParticipants），例如
 *   `明末美食家(3184426518)` / `- 逆转「Reverse Hierarchy」 (961716628)`
 *       / `摸术师（移动）(1115617951)`
 * ⚠ 昵称里可能有全角括号（`摸术师（移动）`），也可能带 ASCII 括号的数字，
 *   所以取**最后**一组 `(4 位以上数字)` 当 QQ，前面整段都是昵称。
 */
export function parseContactToken(token) {
    const text = clean(token);
    if (!text) return null;
    const m = text.match(/^(.*)\((\d{4,})\)\s*$/);
    if (!m) return null;
    return { participantId: m[2], name: clean(m[1]) };
}

// 昵称字段偶尔会混进系统通知文本（实测库里有一条
// `群主邀请了："猫娘"加入本群。(1000000001)` —— QQ 是对的，名字是通知）。
// 名字不可信时宁可只留 QQ 号，也别让她把一句通知当成人名。
const NAME_NOTICE_RE = /加入本群|退出了群|撤回|邀请|移出|禁言|全体成员|红包|拍了拍|上线了/;

export function isPlausibleName(name) {
    const n = clean(name);
    if (!n) return false;
    if (n.length > 24) return false;          // 通知文本通常很长
    if (NAME_NOTICE_RE.test(n)) return false;
    return true;
}

/**
 * 从一条用户消息的正文头里取昵称 / QQ 号（**兜底**用）。
 * 主数据源是 `metadata_json.participants`（写库时已在 session.js 里处理）。
 * ⚠ 头的结尾要按括号配对找：`messageSegments:[{…}]` 里含 ']'，配不上就返回 null。
 */
export function parseContactFromMessage(content) {
    const text = clean(content);
    const start = text.search(/\[(?:群聊|私聊)\|/);
    if (start < 0) return null;
    let depth = 0;
    let end = -1;
    for (let i = start; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === '[') depth += 1;
        else if (ch === ']') {
            depth -= 1;
            if (depth === 0) { end = i; break; }
        }
    }
    if (end < 0) return null;                       // 配不上就放弃，别猜
    const head = text.slice(start, end + 1);
    const qq = clean((head.match(/QQ:([^|\]]*)/) || [])[1]);
    const name = clean((head.match(/昵称:([^|\]]*)/) || [])[1]);
    if (!qq) return null;
    return { participantId: qq, name };
}

/** `name_history` 列是 JSON 数组（最近在前）。坏数据一律当空数组，别抛。 */
export function parseNameHistory(value) {
    if (Array.isArray(value)) return value.map(clean).filter(Boolean);
    const text = clean(value);
    if (!text) return [];
    try {
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed.map(clean).filter(Boolean) : [];
    } catch {
        return [];
    }
}

/**
 * 把新看到的昵称并进曾用名历史：最近在前、去重、截断到 maxNameHistory。
 * ⚠ 这是"很多个称呼"能留住的地方 —— 昵称会改，而旧名字是她重建联系的唯一锚。
 * 不可信的名字（系统通知）不进历史。
 */
export function mergeNameHistory(existing, name, maxNameHistory = PARTICIPANT_ROSTER_DEFAULTS.maxNameHistory) {
    const list = parseNameHistory(existing);
    const next = isPlausibleName(name) ? clean(name) : '';
    const out = next ? [next, ...list.filter((n) => n !== next)] : list;
    return out.slice(0, Math.max(1, maxNameHistory));
}

/** 「今天 15:13」/「昨天 09:02」/「10-09 21:53」。now 可注入，便于测试。 */
export function formatContactTime(timestampMs, now = Date.now()) {
    const ts = Number(timestampMs);
    if (!Number.isFinite(ts) || ts <= 0) return '';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const startOf = (base) => new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime();
    const nowDate = new Date(now);
    const diffDays = Math.round((startOf(nowDate) - startOf(d)) / DAY_MS);
    if (diffDays === 0) return `今天 ${hm}`;
    if (diffDays === 1) return `昨天 ${hm}`;
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

/**
 * 把一行规范化成统一的联系人口径。支持三种行形状：
 *   (A) `participant_contacts` 表（主）：
 *       { participant_id, display_name, name_history, first_seen_at, last_seen_at,
 *         message_count, last_scope_kind, last_scope_key }
 *   (B) 「会话×发言人」的聚合行（回填/旧路径）：{ session_id, who, timestamp, count }
 *   (C) 带正文的旧行（兜底）：{ session_id, content, timestamp, count }
 * 返回 null 表示这行认不出人。
 */
function readContactRow(row) {
    // (A) 表行
    const tableId = clean(row?.participant_id ?? row?.participantId);
    if (tableId && row?.last_seen_at !== undefined) {
        const kind = clean(row?.last_scope_kind ?? row?.lastScopeKind);
        return {
            participantId: tableId,
            name: clean(row?.display_name ?? row?.displayName),
            names: parseNameHistory(row?.name_history ?? row?.nameHistory),
            lastTs: Number(row?.last_seen_at ?? row?.lastSeenAt),
            count: Number(row?.message_count ?? row?.messageCount) || 1,
            fromGroup: kind === 'group',
            scopeKey: clean(row?.last_scope_key ?? row?.lastScopeKey)
        };
    }

    // (B)/(C) 会话行
    const session = parseSessionKey(row?.session_id ?? row?.sessionId);
    if (!session) return null;
    const parsed = row?.who ? parseContactToken(row.who) : parseContactFromMessage(row?.content);
    const participantId = parsed?.participantId || session.id;
    if (!participantId) return null;
    return {
        participantId,
        name: isPlausibleName(parsed?.name) ? clean(parsed.name) : '',
        names: isPlausibleName(parsed?.name) ? [clean(parsed.name)] : [],
        lastTs: Number(row?.timestamp ?? row?.lastTs),
        count: Number(row?.count) || 1,
        fromGroup: session.kind === 'group',
        scopeKey: clean(row?.session_id ?? row?.sessionId)
    };
}

/**
 * 合成「按人」的名单。
 *
 * 合并规则：
 *  - **按 QQ 合并**，不是按昵称（见文件头：同 QQ 两名 / 两名同 QQ）。
 *  - 同一个人既在私聊又在群里出现 ⇒ 一条，`lastFromGroup` 跟**最近一次**走。
 *  - 曾用名取并集（表行的 name_history + 逐行看到的）。
 */
export function buildRosterEntries(rows = [], options = {}) {
    const cfg = normalizeParticipantRosterConfig(options.config || options);
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const cutoff = now - cfg.maxAgeDays * DAY_MS;
    const excluded = new Set(cfg.excludeIds);

    const byId = new Map();
    for (const raw of Array.isArray(rows) ? rows : []) {
        const row = readContactRow(raw);
        if (!row) continue;
        if (row.fromGroup && !cfg.includeGroupMembers) continue;
        if (!Number.isFinite(row.lastTs) || row.lastTs < cutoff) continue;
        if (excluded.has(row.participantId)) continue;

        const prev = byId.get(row.participantId);
        if (!prev) {
            byId.set(row.participantId, {
                participantId: row.participantId,
                name: isPlausibleName(row.name) ? row.name : '',
                names: [...row.names],
                lastTs: row.lastTs,
                count: row.count,
                lastFromGroup: row.fromGroup
            });
            continue;
        }
        prev.count += row.count;
        for (const n of row.names) if (!prev.names.includes(n)) prev.names.push(n);
        // ⚠ 标"（群）"要跟着**最近一次**联系走，不能因为"曾经在群里出现过"就打标 ——
        // 否则一个只在私聊里最近联系过的人会被写成（群）。这个 bug 被
        // verify_participant_roster.mjs 抓到过。
        if (row.lastTs >= prev.lastTs) {
            prev.lastTs = row.lastTs;
            prev.lastFromGroup = row.fromGroup;
            if (isPlausibleName(row.name)) prev.name = row.name;   // 名字跟最近一次走
        } else if (!prev.name && isPlausibleName(row.name)) {
            prev.name = row.name;
        }
    }

    return Array.from(byId.values())
        .filter((entry) => entry.count >= cfg.minMessages)
        .map((entry) => {
            // 当前名放最前（表行里本来就是最近在前，但逐行合并后要重新保证）
            const ordered = [entry.name, ...entry.names.filter((n) => n !== entry.name)].filter(Boolean);
            return { ...entry, names: ordered };
        })
        .sort((a, b) => b.lastTs - a.lastTs || a.participantId.localeCompare(b.participantId))
        .slice(0, cfg.maxEntries);
}

export function formatRosterEntry(entry, now = Date.now(), options = {}) {
    const maxAliases = toPositiveInt(options.maxAliasesShown, PARTICIPANT_ROSTER_DEFAULTS.maxAliasesShown);
    const who = entry?.name
        ? `${entry.name}(${entry.participantId})`
        : `QQ ${entry?.participantId}`;
    // 曾用名紧跟在名字后面，括号才不会叠两个
    const aliases = (Array.isArray(entry?.names) ? entry.names : [])
        .filter((n) => n && n !== entry.name)
        .slice(0, maxAliases);
    const alias = aliases.length > 0 ? `（也叫 ${aliases.join(' / ')}）` : '';
    const when = formatContactTime(entry?.lastTs, now);
    const where = entry?.lastFromGroup ? '（群）' : '';
    return `${who}${alias} — ${when}${where}`;
}

/**
 * 一个名字有没有在那个人的消息里被提到。
 *
 * ⚠ 分两种口径（这条规律本项目在触发关键词上已经踩过：朴素 `includes` 会让
 *   小写 `anon` 命中 `canon`）：
 *  - **短 ASCII 名**（`W` 这种 1~3 个字符）按**词边界**匹配，大小写不敏感；
 *  - **其余**（中文、长英文名）用子串匹配，且要求 ≥2 字 —— 单字中文名（「一」「我」）
 *    做子串会让几乎所有消息都命中。
 */
function nameMatchesInText(message, name) {
    const n = clean(name);
    if (!n) return false;
    if (/^[A-Za-z0-9_]{1,3}$/.test(n)) {
        const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(^|[^A-Za-z0-9_])${escaped}($|[^A-Za-z0-9_])`, 'i').test(message);
    }
    return n.length >= 2 && message.includes(n);
}

/**
 * 消息里提到的、名单上的人。
 * 两种命中：① 正文里有 5 位以上的数字，且等于某个联系人的 QQ；
 *           ② 正文里出现了某个联系人的昵称/曾用名（口径见 nameMatchesInText）。
 */
export function findRosterMentions(entries = [], messageText = '', max = MENTION_HINT_MAX, options = {}) {
    const text = clean(messageText);
    if (!text) return [];
    // 🔴 当前发言人自己不算"被提到的人"（2026-10-13 实测）：
    //    群里 `小摸` 发了句「小摸听到了，在看呢」——它**自己在名单里**，昵称又出现在正文里
    //    ⇒ 每轮都注入「对方提到的那个人就在你的联系人名单里：小摸(596443457)」。
    //    这句话的前提就错了：那不是"被提到的人"，那是**正在说话的人**。
    const speakerId = clean(options.speakerId);
    const digits = new Set(text.match(/\d{5,}/g) || []);
    const hits = [];
    for (const entry of entries) {
        if (!entry?.participantId) continue;
        if (speakerId && String(entry.participantId) === speakerId) continue;
        const names = [entry.name, ...(Array.isArray(entry.names) ? entry.names : [])]
            .filter(Boolean);
        const hit = digits.has(String(entry.participantId))
            || names.some((n) => nameMatchesInText(text, n));
        if (!hit) continue;
        hits.push(entry);
        if (hits.length >= max) break;
    }
    return hits;
}

/**
 * 「注意:」行里那句"对方提到的人就在名单上"。
 *
 * 为什么要多这一句：名单本身在系统消息中段，而模型回复前**最后读到**的是「注意:」行
 * （本项目已实测该位置杠杆最高）。2026-10-11 的实证是：名册确确实实在 prompt 里
 * （日志 `[身份名册] main 注入 765 字`），但问她「你觉得曲奇饼干全肯定bot怎么样」时
 * 她的 reasoning **通篇没提名册**，跑去**联网搜**这个昵称了 —— 昵称叫「曲奇饼干…bot」，
 * 搜出来全是饼干做法，反而把她推得更远。
 *
 * ⚠ 用肯定式，且**不给照样句**（本项目规律：卡里给引号例句会被逐字搬用；
 * 否定句 = 二次 priming，写"别去搜"等于把"搜"再喂一遍）。
 */
export function buildRosterMentionHint(entries = [], messageText = '', options = {}) {
    const hits = findRosterMentions(entries, messageText, MENTION_HINT_MAX, options);
    if (hits.length === 0) return '';
    const who = hits
        .map((e) => (e.name ? `${e.name}(${e.participantId})` : `QQ ${e.participantId}`))
        .join('、');
    return `对方提到的那个人就在你的联系人名单里：${who}。`
        + '那是你在 QQ 上认识的人 —— 直接照名单回答就行。';
}

/**
 * 生成名单（并顺带算出「注意:」行要用的那句提及提示）。
 * 返回 { text, entries, mention }；未启用 / 无联系人 / 查库抛错 ⇒ 全是空。
 */
export function buildParticipantRoster(sessionManager, rawConfig, options = {}) {
    const empty = { text: '', entries: [], mention: '' };
    const cfg = normalizeParticipantRosterConfig(rawConfig);
    if (!cfg.enabled) return empty;
    if (!sessionManager || typeof sessionManager.listRecentContacts !== 'function') return empty;

    const now = Number.isFinite(options.now) ? options.now : Date.now();
    let rows = [];
    try {
        // 取够多再筛（maxAgeDays / excludeIds 都可能砍掉一批）
        rows = sessionManager.listRecentContacts(Math.max(cfg.maxListedTotal * 4, 120));
    } catch {
        return empty;
    }

    // ⚠ 这里刻意用 maxListedTotal 而不是 maxEntries 去截断 —— 截前 maxEntries 个会让
    // "被问到的那个人恰好排在下一名"时**静默消失**（2026-10-11 实测踩到，见文件头）。
    //
    // 🔴 2026-10-13 再修（真缺口）：上面这行只把截断线从 12 抬到 40，**没有解决根因** ——
    //    联系人表会一直长（2026-10-13 已 56 人），排到 41 名以后的人**连「注意:」行也看不见**，
    //    因为 `mention` 也是拿这份**已被截断**的 entries 算的。表现就是用户当初报的那个 bug
    //    在数据长大后复发：他知道 QQ 号、她名单里其实也有，但她说"真没印象"。
    //    拆成两份：
    //      - allEntries：只受**语义**过滤（maxAgeDays / excludeIds / minMessages），不受显示上限约束
    //      - entries   ：渲染用，照旧吃 maxListedTotal 硬上限（列表不能无限长，会挤占人设）
    //    `mention` 该用 allEntries —— 命中判定本来就该按"认不认识"，跟"列不列得下"无关。
    const allEntries = buildRosterEntries(rows, {
        config: { ...cfg, maxEntries: Number.MAX_SAFE_INTEGER },
        now
    });
    if (allEntries.length === 0) return empty;
    const entries = allEntries.slice(0, cfg.maxListedTotal);

    const detailed = entries.slice(0, cfg.maxEntries);
    const rest = entries.slice(cfg.maxEntries);
    const lines = detailed.map((entry) => formatRosterEntry(entry, now, cfg));
    if (rest.length > 0) {
        // 紧凑行：只留 `昵称(QQ)`（曾用名/时间/群标记都省掉，只为"认得出是谁"）
        const compact = rest
            .map((entry) => (entry.name
                ? `${entry.name}(${entry.participantId})`
                : `QQ ${entry.participantId}`))
            .join('、');
        lines.push(`其他聊过的：${compact}`);
    }

    // 措辞注意（2026-10-11 实测踩过）：
    //  - 只陈述事实，**不给照样句** —— 卡里给引号例句会被逐字搬用。
    //  - 用肯定式。⛔ 不写"别说不认识"（否定句 = 二次 priming）。
    //  - 明写"没有聊过的内容"，堵住她编造对方说了什么。
    //  - 首句必须点明"是 QQ 上聊过的人、是联系人名单"：实测她会把这个昵称
    //    当成网上的东西去搜（见 buildRosterMentionHint 的注释）。
    // >>> speaker-line patch >>>
    // 🔴 2026-10-14：名单的收尾句原来只说「对方**提到**昵称/号码时去名单里找」，
    //    完全没说「**正在跟你说话的人**也在名单里」。
    //    实测（群里）：`白` @她问「我是谁」，名单第 3 行就写着 `白(1000000004)`、
    //    focus 里也标了 `发言人: 白(1000000004)`，她还是答「白？没见过这个名字诶」——
    //    **信息全在，就是没人告诉她把发言人也拿来对一遍**。
    //    ⇒ 直接把「现在跟你说话的是谁」写进名单开头（名单是联系人卡所在之处，
    //      focus 那行只是个标签，两者对不上时模型不会自己连线）。
    const speakerId = clean(options.speakerId);
    const speakerEntry = speakerId
        ? allEntries.find((e) => String(e.participantId) === speakerId)
        : null;
    const speakerLine = speakerEntry
        ? `现在跟你说话的就是名单里的：${formatRosterEntry(speakerEntry, now, cfg)}`
            + ' —— 他要是问「我是谁」「你认识我吗」，照这一行答。'
        : '';
    // <<< speaker-line patch >>>

    return {
        text: [
            HEADER,
            '这些都是你在 QQ 上聊过的人，是你的联系人名单。'
                + '名单里只有昵称、QQ 号和最后联系时间，没有聊过的内容。',
            ...(speakerLine ? [speakerLine] : []),
            ...lines,
            '对方报一串数字、或者提到上面的昵称，说的就是名单里的这个人 —— 当成认识的人在跟你说话。'
        ].join('\n'),
        entries,
        // 🔴 用 allEntries（未截断）：排到 maxListedTotal 之外的人也必须在"注意:"行里被认出来，
        //    否则表越长、用户越容易问到一个"名单里明明有、但她看不见"的人（2026-10-13 实测复发）。
        // 🔴 用 stripStructuredEnvelope：别拿信封里的发送者 QQ/昵称去匹配（见该函数的注释）。
        // 🔴 传 speakerId：发言人**自己**不算"被提到的人"（群里 `小摸` 发「小摸听到了」实测踩到）。
        mention: buildRosterMentionHint(allEntries, stripStructuredEnvelope(options.messageText),
            { speakerId: options.speakerId })
    };
}

/** 只要那段文本（老调用方 / 测试用）。 */
export function buildParticipantRosterText(sessionManager, rawConfig, options = {}) {
    return buildParticipantRoster(sessionManager, rawConfig, options).text;
}

// >>> envelope-strip patch >>>
// 🔴 剥信封的实现已抽到 `structured-envelope.js`（**只留一份**）——
//    因为 `prompt.js` 的【会话感知】踩了同一个坑（见 2026-10-13 的两次教训）。
//    这里只是 import + 在名册里用，不再自己定义一份。
// <<< envelope-strip patch <<<
