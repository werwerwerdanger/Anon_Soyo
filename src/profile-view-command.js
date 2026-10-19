/**
 * `/画像` —— 查看「她把某人记成了什么样」
 * ---------------------------------------------------------------------------
 * 与 `/人物档案` 的分工（别混）：
 *   /人物档案 @某人  = **触发一次分析**（写）
 *   /画像     @某人  = **把已经记下来的档案读出来**（读）
 *
 * 为什么需要它
 * ------------
 * 档案是她每轮都在看的东西（提示词里的【当前发言人画像】），但**问她本人永远问不出
 * 原话** —— 她会按人设回答，不会照念档案。想核对「她到底把我记成什么样了」以前只能
 * 去翻库，这条指令把这件事变成一条命令。
 *
 * 权限：管理员。档案里混着别人的私事（L3 隐私窄口那套讨论），不能谁都能拉。
 *
 * 两种模式
 * --------
 *   不带参数 → 列全部：一份一行（名字 + QQ + 场景 + 字数 + 更新 + 摘要）
 *   带参数   → 详情：这个人**每个场景**的档案正文（私聊 / 各群各一份，不是只有一份）
 *
 * 截断一律**明说**还有多少没显示 —— 本项目吃过「只给前 N 条静默失效」的亏。
 */

export const PROFILE_VIEW_COMMAND_DEFAULTS = {
    enabled: true,
    command: '/画像',
    maxEntries: 30,
    // 单条消息里，一份正文最多写多少字（超了按行/句切到下一片）
    perScopeChars: 1200,
    // 单条消息总长上限；超了就**分下一条继续说**，而不是截断后打一句「还有 N 份放不下」
    maxChars: 1600,
    // 分条之间的间隔（QQ 发太快会风控）
    chunkDelayMs: 700,
    forwardMinChars: 600,  // 超过这个长度（或不止一条）就改走合并转发
    access: 'admin',       // admin | self | everyone
    allowOthersInGroup: false
};

function cleanText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/** `/画像 涵` → `涵`；`/画像` → `''`。手打的 `@昵称` 也一并吃掉。 */
export function parseProfileViewArgument(plainText, command) {
    const text = cleanText(plainText);
    const cmd = cleanText(command);
    if (!text || !cmd || !text.startsWith(cmd)) {
        return '';
    }
    return text.slice(cmd.length).replace(/^[\s@]+/, '').trim();
}

/**
 * 场景 → 人话标签。档案按 (人, scope) 分组存，**同一个人往往有好几份**
 * （私聊一份、每个常去的群一份、还有一份全局共享），所以不能只显示最新那份。
 */
export function formatProfileScopeLabel(profile = {}) {
    const type = cleanText(profile.scopeType);
    const key = cleanText(profile.scopeKey);
    if (!type) {
        return key || '未知场景';
    }
    // scopeKey 自带前缀（'group:929159193' / 'private:2063362809'），直接拼进
    // 中文标签会变成「群 group:929159193」这种重复，先把冒号前面那段剥掉。
    const colon = key.indexOf(':');
    const shortKey = colon > 0 ? (key.slice(colon + 1) || key) : key;
    // 真实库里只出现这三种：global_shared / group_shared / private_user。
    // ⚠ 第一版按 'private' / 'group' 写，实测**两个都不匹配**、全落进兜底分支，
    //   是用真实数据跑 verify_profile_view_command.mjs 才抓到的。两个名字都认，
    //   免得以后 scope 命名再变一次又静默退化成 "group_shared group:xxx"。
    if (type === 'global_shared') {
        return '全局共享';
    }
    if (type === 'group_shared' || type === 'group') {
        return shortKey ? `群 ${shortKey}` : '群聊';
    }
    if (type === 'private_user' || type === 'private') {
        return shortKey ? `私聊 ${shortKey}` : '私聊';
    }
    return key ? `${type} ${key}` : type;
}

function formatTimestamp(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
        return '';
    }
    const d = new Date(n);
    if (Number.isNaN(d.getTime())) {
        return '';
    }
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function truncateText(text, maxChars) {
    const t = cleanText(text);
    const limit = Number(maxChars);
    if (!Number.isFinite(limit) || limit <= 0 || t.length <= limit) {
        return t;
    }
    return `${t.slice(0, Math.floor(limit))}…`;
}

/** 折成一行用于列表里的摘要，避免多行档案把列表撑爆。 */
function oneLine(text, maxChars = 60) {
    return truncateText(cleanText(text).replace(/\s*\n\s*/g, ' '), maxChars);
}

function displayName(profile = {}) {
    return cleanText(profile.participantName) || cleanText(profile.title) || '(无名)';
}

/**
 * 列表模式：一份一行。
 * 注意这里列的是**份数**不是人数 —— 同一个人有私聊/群聊多份是正常的，
 * 所以标题写「画像 N 份」而不是「N 个人」。
 */
export function buildProfileListText(profiles = [], options = {}) {
    const command = cleanText(options.command) || PROFILE_VIEW_COMMAND_DEFAULTS.command;
    if (profiles.length === 0) {
        const manual = cleanText(options.manualCommand) || '/人物档案';
        return `她现在还没有给任何人建立画像。用 ${manual} @某人 可以立刻分析一个。`;
    }
    const limit = Number(options.maxEntries);
    const maxEntries = Number.isFinite(limit) && limit > 0
        ? Math.floor(limit) : PROFILE_VIEW_COMMAND_DEFAULTS.maxEntries;
    const shown = profiles.slice(0, maxEntries);
    const lines = shown.map((p, i) => {
        const id = cleanText(p.participantId);
        const who = id ? `${displayName(p)}（${id}）` : displayName(p);
        const when = formatTimestamp(p.updatedAt);
        const size = cleanText(p.content).length;
        return `${i + 1}. ${who} · ${formatProfileScopeLabel(p)} · ${size} 字${when ? ` · ${when}` : ''}\n   ${oneLine(p.content, 60)}`;
    });
    const head = `她记着的画像（共 ${profiles.length} 份，按最近更新排）：`;
    // 提示文案走**自然语言分块**：一条一行、各自成句。
    // ⛔ 不写成「（A；B）」那种分号堆在一对括号里的机器日志腔。
    const footer = profiles.length > shown.length
        ? `\n还有 ${profiles.length - shown.length} 份没列出来。\n想看某个人就用 ${command} <昵称|QQ号>。`
        : `\n想看某个人就用 ${command} <昵称|QQ号>。`;
    return `${head}\n\n${lines.join('\n')}${footer}`;
}

/** 按行 → 按句切长文本，保证每片不超过 maxLen。 */
function splitLongBody(text, maxLen) {
    const body = cleanText(text);
    const limit = Number(maxLen) > 0 ? Math.floor(Number(maxLen)) : 900;
    if (body.length <= limit) {
        return [body];
    }
    const out = [];
    let buf = '';
    const push = () => { if (buf) { out.push(buf); buf = ''; } };
    for (const rawLine of body.split('\n')) {
        let line = rawLine;
        if (line.length > limit) {
            // 单行超长 ⇒ 先按中文句末标点切；仍超就硬切
            for (const part of line.split(/(?<=[。！？；!?;])/)) {
                if (buf && (buf.length + part.length) > limit) {
                    push();
                }
                buf += part;
                while (buf.length > limit) {
                    out.push(buf.slice(0, limit));
                    buf = buf.slice(limit);
                }
            }
            continue;
        }
        if (buf && (buf.length + 1 + line.length) > limit) {
            push();
        }
        buf = buf ? `${buf}\n${line}` : line;
    }
    push();
    return out;
}

/**
 * 详情模式：**按结构分块，返回多条消息**。
 * 一次说不完的就分几条说完 —— 而不是截断之后打一句「还有 N 份放不下」。
 * 分块单位是「一个场景的一份正文」：能整份放进一条就整份放；
 * 整份超长时先按行、再按句切开，续片标「（续）」。
 */
export function buildProfileDetailChunks(profiles = [], options = {}) {
    const keyword = cleanText(options.keyword);
    if (profiles.length === 0) {
        return [`没有找到「${keyword}」的画像。她可能还没记住这个人，或者这个名字对不上。`];
    }
    const totalRaw = Number(options.maxChars);
    const maxChars = Number.isFinite(totalRaw) && totalRaw > 0
        ? Math.floor(totalRaw) : PROFILE_VIEW_COMMAND_DEFAULTS.maxChars;
    const perScopeRaw = Number(options.perScopeChars);
    const perScopeChars = Number.isFinite(perScopeRaw) && perScopeRaw > 0
        ? Math.floor(perScopeRaw) : PROFILE_VIEW_COMMAND_DEFAULTS.perScopeChars;

    const first = profiles[0];
    const id = cleanText(first.participantId);
    const head = id
        ? `${displayName(first)}（${id}）的画像，共 ${profiles.length} 份：`
        : `${displayName(first)}的画像，共 ${profiles.length} 份：`;

    const blocks = [];
    for (const p of profiles) {
        const full = cleanText(p.content).length;
        const when = formatTimestamp(p.updatedAt);
        const baseLabel = `【${formatProfileScopeLabel(p)}】${when ? ` ${when}` : ''}（${full} 字）`;
        const pieceLimit = Math.min(perScopeChars, Math.max(200, maxChars - 120));
        const pieces = splitLongBody(p.content, pieceLimit);
        pieces.forEach((piece, i) => {
            const label = i === 0 ? baseLabel : `${baseLabel}（续）`;
            blocks.push(`${label}\n${piece || '(空)'}`);
        });
    }

    const chunks = [];
    let cur = '';
    for (const block of blocks) {
        const candidate = cur ? `${cur}\n\n${block}` : block;
        if (cur && candidate.length > maxChars) {
            chunks.push(cur);
            cur = block;
        } else {
            cur = candidate;
        }
    }
    if (cur) {
        chunks.push(cur);
    }
    if (chunks.length > 0) {
        chunks[0] = `${head}\n\n${chunks[0]}`;
    }
    return chunks;
}

/** 拼成一条（测试或不需要分条时用）。 */
export function buildProfileDetailText(profiles = [], options = {}) {
    return buildProfileDetailChunks(profiles, options).join('\n\n');
}

/**
 * `search` 是 SQL LIKE %kw%，会把**正文里**提到这个词的人也捞出来。
 * 详情模式必须再按「人」过滤一次，否则会把别人的画像一起列进来。
 */
function matchesProfile(profile = {}, keyword = '') {
    const needle = cleanText(keyword).toLowerCase();
    if (!needle) {
        return true;
    }
    return [profile.participantId, profile.participantName, profile.title]
        .map((v) => cleanText(v).toLowerCase())
        .some((v) => v && v.includes(needle));
}

export async function executeProfileViewCommand({
    event = {},
    plainText = '',
    command = PROFILE_VIEW_COMMAND_DEFAULTS.command,
    enabled = true,
    access = PROFILE_VIEW_COMMAND_DEFAULTS.access,
    allowOthersInGroup = PROFILE_VIEW_COMMAND_DEFAULTS.allowOthersInGroup,
    maxEntries = PROFILE_VIEW_COMMAND_DEFAULTS.maxEntries,
    perScopeChars = PROFILE_VIEW_COMMAND_DEFAULTS.perScopeChars,
    maxChars = PROFILE_VIEW_COMMAND_DEFAULTS.maxChars,
    chunkDelayMs = PROFILE_VIEW_COMMAND_DEFAULTS.chunkDelayMs,
    isAdmin = false,
    sessionManager = null,
    mentionedParticipantId = '',
    manualCommand = '',
    onCommandAccepted = null,
    sendStatusMessage = null,
    sendForwardMessage = null,
    forwardMinChars = PROFILE_VIEW_COMMAND_DEFAULTS.forwardMinChars,
    sendFailureMessage = null,
    logger = console
} = {}) {
    const { isCommandInvocation } = await import('./qq-interactions.js');
    if (!isCommandInvocation(plainText, command)) {
        return { handled: false };
    }
    if (!enabled) {
        return { handled: false };
    }
    if (typeof onCommandAccepted === 'function') {
        onCommandAccepted();
    }
    const argument = parseProfileViewArgument(plainText, command);
    // @ 段在调用方已被剥掉，所以「@了谁」要靠 mentionedParticipantId 兜底
    const keyword = argument || cleanText(mentionedParticipantId);

    // >>> profile-access patch >>>
    // 2026-10-19：用户要「所有人都能查画像」。做成分级，而不是把管理员门禁直接拆掉：
    //   admin    —— 只有 chat.adminUsers 能查
    //   self     —— 谁都能查，但只能查自己
    //   everyone —— 谁都能查任何人
    // 两条防线在 everyone 下仍然生效：
    //   ① 不带关键词的**列表模式**只给管理员 —— 否则等于把"机器人记了谁"摊开
    //   ② 群聊里查别人默认不允许（allowOthersInGroup）—— 画像里有私聊细节，
    //      贴进群是扩散给别人看，不属于"自己查自己"
    const deny = async (message) => {
        if (typeof sendFailureMessage === 'function') {
            await sendFailureMessage(message);
        }
    };
    const requesterId = cleanText(event?.user_id);
    const selfQuery = Boolean(keyword) && keyword === requesterId;
    const isGroupChat = String(event?.message_type || '') === 'group';
    const accessMode = ['admin', 'self', 'everyone'].includes(String(access)) ? String(access) : 'admin';
    if (!isAdmin) {
        if (accessMode === 'admin') {
            await deny('这个指令现在只有管理员能用');
            return { handled: true };
        }
        if (!keyword) {
            await deny('要查谁？发 /画像 加 QQ 号，或者 @ 一下对方');
            return { handled: true };
        }
        if (!selfQuery) {
            if (accessMode === 'self') {
                await deny('只能查自己的画像');
                return { handled: true };
            }
            if (isGroupChat && allowOthersInGroup !== true) {
                await deny('群里只能查自己的，别人的到私聊问我');
                return { handled: true };
            }
        }
    }
    // <<< profile-access patch <<<

    let rows = [];
    try {
        rows = typeof sessionManager?.listParticipantProfiles === 'function'
            ? sessionManager.listParticipantProfiles({ limit: 500, search: keyword })
            : [];
    } catch (error) {
        logger?.warn?.('[画像] 读取画像失败', { error: error?.message });
    }

    const matched = keyword ? rows.filter((p) => matchesProfile(p, keyword)) : rows;
    // 列表模式一条说完；详情模式**按结构分成几条说**，不截断、不打「还有 N 份放不下」。
    const texts = keyword
        ? buildProfileDetailChunks(matched, { keyword, perScopeChars, maxChars })
        : [buildProfileListText(matched, { command, maxEntries, manualCommand })];

    const delay = Number(chunkDelayMs);
    const delayMs = Number.isFinite(delay) && delay >= 0 ? Math.floor(delay) : 0;
    const totalLength = texts.reduce((n, t) => n + t.length, 0);

    logger?.info?.('[画像] 指令输出', {
        keyword,
        requesterId,
        selfQuery,
        access: accessMode,
        total: rows.length,
        matched: matched.length,
        chunks: texts.length,
        length: totalLength
    });

    // >>> forward-msg patch >>>
    // 2026-10-19：多份画像连发会刷屏 —— 能合并就合并成一张"聊天记录"卡片。
    // 单条短回复仍走原来的引用发送（转发卡片带不了引用，也不值当）。
    const forwardThresholdRaw = Number(forwardMinChars);
    const forwardThreshold = Number.isFinite(forwardThresholdRaw) && forwardThresholdRaw > 0
        ? Math.floor(forwardThresholdRaw) : PROFILE_VIEW_COMMAND_DEFAULTS.forwardMinChars;
    if (typeof sendForwardMessage === 'function'
        && (texts.length > 1 || totalLength >= forwardThreshold)) {
        try {
            await sendForwardMessage(texts);
            logger?.info?.('[画像] 已合并转发', { nodes: texts.length, length: totalLength });
            return { handled: true };
        } catch (error) {
            // 转发失败（接口不支持 / 风控）就退回分条，别让指令变成没回复
            logger?.warn?.('[画像] 合并转发失败，退回分条发送', { error: error?.message });
        }
    }
    // <<< forward-msg patch <<<

    for (let i = 0; i < texts.length; i += 1) {
        if (i > 0 && delayMs > 0) {
            // QQ 连发太快会被风控；间隔可配（chunkDelayMs）
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        if (typeof sendStatusMessage === 'function') {
            // 第一条带引用，后面几条不带 —— 每条都引用同一条消息会很难看
            await sendStatusMessage(texts[i], i === 0 ? {} : { quote: false });
        }
    }
    return { handled: true };
}
