/**
 * 人物类管理指令 + 思考显示
 * ---------------------------------------------------------------------------
 * 这一层只放**管理员用**的运维指令与一小段"给模型看的可选输出"，不参与任何
 * 角色扮演逻辑。三条能力：
 *
 *   /名册            列出"她认识谁" —— **QQ号 + 所有别称**
 *   /忘记 <昵称|QQ>   把一个人从 `participant_contacts` 与 `memory_entries` 里删掉
 *   /思考 开|关       热开关：把自己回复的思考内容用括号带出来
 *
 * 为什么 `/名册` 输出的是「QQ号 + 所有别称」而不是「昵称(QQ)」
 * ------------------------------------------------------------
 * 实测（2026-10-11）同一个 QQ 出现过两个昵称（`werwer` / `W`），两个不同 QQ 又叫
 * 同一个昵称（`werwer` 2063362809 与 `werwer` 1000000003）。⇒ 昵称做不了键，
 * **QQ 才能**；而"以前那个名字"必须靠 `name_history` 留住。
 * 所以运维视角的正确排布是：**主键在前（QQ），别称全部跟在后面**（当前昵称在最前）。
 *
 * 为什么 `/忘记` 不删 `messages`
 * ------------------------------
 * 群历史是**批量合并**存的 —— 实测同一条 `messages` 里混着好几个人的发言（一条记录
 * 对应一批消息）。按作者删会连累别人。`summaries` 同理（摘要里混着多人的事，而且会
 * 随时间自然滚掉）。所以这个指令的语义是"**让她不再认得这个人**"，不是"抹掉他说过的
 * 每一句话"。要清到什么程度必须让使用者知道，所以回执里写清楚。
 */

import { parseNameHistory } from './participant-roster.js';

export const ROSTER_COMMAND_DEFAULTS = {
    enabled: true,
    command: '/名册',
    maxEntries: 100,
    maxAliases: 8
};

export const FORGET_COMMAND_DEFAULTS = {
    enabled: true,
    command: '/忘记'
};

export const THINKING_COMMAND_DEFAULTS = {
    enabled: true,
    command: '/思考'
};

export const THINKING_DISPLAY_DEFAULTS = {
    enabled: false,
    // paren = 用括号包住思考内容（用户口径：「打开以后会用括号显示思考内容」）
    // debug = 旧的 【思维链】/【正文】 分节格式（保留给 chat.sendReasoningToQQ）
    format: 'paren',
    // 括号里的前缀标签。想要纯内白式括号（像角色的心理活动）就设成 ''
    label: '思考',
    // 思考内容经常几千字，直接塞进 QQ 会糊成一屏；0 = 不截断
    maxChars: 1200,
    // after = 正文在前、思考在后；before = 反过来
    position: 'after',
    // all | private | group —— 群聊里开着会让所有人都看见
    scope: 'all'
};

function cleanText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * 取指令后面那段参数。`/名册 涵` → `涵`；`/名册` → `''`。
 * 顺带吃掉手打的 `@昵称`（真的 at 段由调用方用 extractMentionedParticipant 处理）。
 */
export function parseCommandArgument(plainText, command) {
    const text = cleanText(plainText);
    const cmd = cleanText(command);
    if (!text || !cmd || !text.startsWith(cmd)) {
        return '';
    }
    return text.slice(cmd.length).replace(/^[\s@]+/, '').trim();
}

/**
 * 一个人的全部称呼：当前昵称在前，曾用名跟在后面，去重、去掉空串。
 */
export function collectContactAliases(row = {}, maxAliases = ROSTER_COMMAND_DEFAULTS.maxAliases) {
    const names = [];
    const push = (value) => {
        const name = cleanText(value);
        if (name && !names.includes(name)) {
            names.push(name);
        }
    };
    push(row.display_name ?? row.displayName);
    for (const name of parseNameHistory(row.name_history ?? row.nameHistory)) {
        push(name);
    }
    const limit = Number(maxAliases) > 0 ? Math.floor(Number(maxAliases)) : names.length;
    return names.slice(0, limit);
}

/**
 * 一行的形态：`2063362809：werwer、小W`。
 * 没有任何称呼时只留 QQ —— 绝不留一个空壳标签。
 */
export function formatContactLine(row = {}, options = {}) {
    const id = cleanText(row.participant_id ?? row.participantId);
    if (!id) {
        return '';
    }
    const aliases = collectContactAliases(row, options.maxAliases ?? ROSTER_COMMAND_DEFAULTS.maxAliases);
    return aliases.length > 0 ? `${id}：${aliases.join('、')}` : id;
}

function matchesKeyword(row, keyword) {
    const needle = cleanText(keyword);
    if (!needle) {
        return true;
    }
    const lower = needle.toLowerCase();
    const id = cleanText(row.participant_id ?? row.participantId).toLowerCase();
    if (id.includes(lower)) {
        return true;
    }
    return collectContactAliases(row, Infinity)
        .some((alias) => alias.toLowerCase().includes(lower));
}

/**
 * `/名册` 的正文。`keyword` 为空时列全部（按最近联系排序，调用方已经排好）。
 * 截断时必须**明说还有多少人没列**——本项目吃过"只给前 N 条静默失效"的亏：
 * 外部完全看不出名单被砍过。
 */
export function buildContactListText(rows = [], options = {}) {
    const list = Array.isArray(rows) ? rows : [];
    const keyword = cleanText(options.keyword);
    const maxEntries = Number(options.maxEntries) > 0
        ? Math.floor(Number(options.maxEntries))
        : ROSTER_COMMAND_DEFAULTS.maxEntries;
    const matched = list.filter((row) => matchesKeyword(row, keyword));

    if (matched.length === 0) {
        return keyword
            ? `没有匹配「${keyword}」的人。用 ${cleanText(options.command) || ROSTER_COMMAND_DEFAULTS.command} 看全部。`
            : '联系人是空的——她还没跟任何人说过话，或者数据库还没回填。';
    }

    const shown = matched.slice(0, maxEntries);
    const lines = shown
        .map((row) => formatContactLine(row, { maxAliases: options.maxAliases }))
        .filter(Boolean);

    const header = keyword
        ? `匹配「${keyword}」的 ${matched.length} 个人：`
        : `她一共认识 ${matched.length} 个人（最近联系的在前）：`;
    const footer = matched.length > shown.length
        ? `\n……还有 ${matched.length - shown.length} 人没列出来。`
        : '';
    return `${header}\n\n${lines.join('\n')}${footer}`;
}

/**
 * `/忘记` 的参数判定：一串数字当 QQ，其余当昵称。
 * ⚠ QQ 号长度按 5~12 位判（真实 QQ 最短 5 位；本项目测试里有 10 位的假号）。
 */
export function parseForgetArgument(argument) {
    const value = cleanText(argument);
    if (!value) {
        return { kind: 'none', value: '' };
    }
    return /^\d{5,12}$/.test(value)
        ? { kind: 'qq', value }
        : { kind: 'name', value };
}

/**
 * 昵称撞车时把候选列出来，让使用者改用 QQ —— 绝不自作主张挑一个删。
 */
export function buildForgetCandidateText(name, candidates = [], options = {}) {
    const command = cleanText(options.command) || FORGET_COMMAND_DEFAULTS.command;
    const lines = candidates
        .map((row) => formatContactLine(row, { maxAliases: options.maxAliases }))
        .filter(Boolean);
    return `叫「${cleanText(name)}」的有 ${candidates.length} 个，请用 ${command} <QQ号> 指定：\n\n${lines.join('\n')}`;
}

/**
 * `/忘记` 的回执。写清楚"删了什么、没删什么"——避免使用者以为历史也被清了。
 */
export function formatForgetResult({ participantId, displayName, contactDeleted, memoryEntriesDeleted } = {}) {
    const id = cleanText(participantId) || '(未知)';
    const name = cleanText(displayName);
    const label = name ? `${id}（${name}）` : id;
    const rows = Number(contactDeleted) || 0;
    const memories = Number(memoryEntriesDeleted) || 0;
    if (rows === 0 && memories === 0) {
        return `QQ ${label} 本来就不在名册里，没删任何东西。`;
    }
    return `已经把她对 ${label} 的印象清掉了：联系人 ${rows} 条、记忆副本 ${memories} 条。\n（群聊历史与摘要没动——那些是多人混存的，按人删会连累别人。）`;
}

/** 数字串 → 只在 3 段以内、且带数字的地方加分隔，便于核对位数。 */
function normalizeThinkingText(reasoningContent, maxChars) {
    const text = cleanText(reasoningContent).replace(/\s*\n\s*/g, ' ').trim();
    if (!text) {
        return '';
    }
    const limit = Number(maxChars);
    if (!Number.isFinite(limit) || limit <= 0 || text.length <= limit) {
        return text;
    }
    return `${text.slice(0, Math.floor(limit))}…`;
}

/**
 * 思考内容 → 送去 QQ 的那一小段。`paren` 是用户口径的形态。
 * 返回 `''` 表示"这段不该出现"（没有思考内容 / 被截成空）。
 */
export function formatThinkingBlock(reasoningContent, options = {}) {
    const text = normalizeThinkingText(reasoningContent, options.maxChars);
    if (!text) {
        return '';
    }
    const format = cleanText(options.format).toLowerCase();
    if (format === 'debug' || format === 'chain') {
        return `【思维链】\n${text}`;
    }
    const label = options.label === undefined
        ? THINKING_DISPLAY_DEFAULTS.label
        : cleanText(options.label);
    return label ? `（${label}：${text}）` : `（${text}）`;
}

/**
 * 正文 + 思考块拼成一条。position 管前后；正文为空时只留思考块。
 */
export function buildThinkingAnnotatedReply(reasoningContent, visibleReply, options = {}) {
    const block = formatThinkingBlock(reasoningContent, options);
    const reply = cleanText(visibleReply);
    if (!block) {
        return reply;
    }
    if (!reply) {
        return block;
    }
    return cleanText(options.position).toLowerCase() === 'before'
        ? `${block}\n${reply}`
        : `${reply}\n${block}`;
}

/**
 * 这条事件该不该带思考内容出来。scope 之外一律 false。
 */
export function isThinkingDisplayAllowed(thinkingConfig = {}, event = {}) {
    if (thinkingConfig?.enabled !== true) {
        return false;
    }
    const scope = cleanText(thinkingConfig.scope || THINKING_DISPLAY_DEFAULTS.scope).toLowerCase();
    if (scope === 'private') {
        return event?.message_type !== 'group';
    }
    if (scope === 'group') {
        return event?.message_type === 'group';
    }
    return true;
}

// >>> roster-commands patch >>>
/**
 * `/名册`。管理员专用；`sessionManager.listRecentContacts` 读的是持久表
 * `participant_contacts`（不是会被摘要删掉的 `messages`）。
 */
export async function executeRosterCommand({
    event = {},
    plainText = '',
    command = ROSTER_COMMAND_DEFAULTS.command,
    enabled = true,
    maxEntries = ROSTER_COMMAND_DEFAULTS.maxEntries,
    maxAliases = ROSTER_COMMAND_DEFAULTS.maxAliases,
    isAdmin = false,
    sessionManager = null,
    onCommandAccepted = null,
    sendStatusMessage = null,
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
    if (!isAdmin) {
        if (typeof sendFailureMessage === 'function') {
            await sendFailureMessage('只有管理员可以查看联系人名册');
        }
        return { handled: true };
    }

    const keyword = parseCommandArgument(plainText, command);
    let rows = [];
    try {
        rows = typeof sessionManager?.listRecentContacts === 'function'
            ? sessionManager.listRecentContacts(500) : [];
    } catch (error) {
        logger?.warn?.('[名册] 读取联系人失败', { error: error?.message });
    }

    const text = buildContactListText(rows, { keyword, maxEntries, maxAliases, command });
    logger?.info?.('[名册] 指令输出', { keyword, total: rows.length, length: text.length });
    if (typeof sendStatusMessage === 'function') {
        await sendStatusMessage(text);
    }
    return { handled: true };
}

/**
 * `/忘记 <昵称|QQ>`。删 `participant_contacts` 的一行 + 他署名过的 `memory_entries`。
 * 昵称撞车（实测真的会撞）时列候选让别人指定 QQ，不自作主张。
 */
export async function executeForgetCommand({
    event = {},
    plainText = '',
    command = FORGET_COMMAND_DEFAULTS.command,
    enabled = true,
    maxAliases = ROSTER_COMMAND_DEFAULTS.maxAliases,
    mentionedParticipantId = '',
    isAdmin = false,
    sessionManager = null,
    onCommandAccepted = null,
    sendStatusMessage = null,
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
    if (!isAdmin) {
        if (typeof sendFailureMessage === 'function') {
            await sendFailureMessage('只有管理员可以忘记联系人');
        }
        return { handled: true };
    }

    const argument = parseCommandArgument(plainText, command);
    const target = mentionedParticipantId
        ? { kind: 'qq', value: String(mentionedParticipantId) }
        : parseForgetArgument(argument);

    if (target.kind === 'none') {
        if (typeof sendFailureMessage === 'function') {
            await sendFailureMessage(`用法：${command} <昵称> 或 ${command} <QQ号>（也可以直接 @某人）`);
        }
        return { handled: true };
    }

    let participantId = target.value;
    let displayName = '';
    if (target.kind === 'name') {
        let candidates = [];
        try {
            candidates = typeof sessionManager?.findContactsByName === 'function'
                ? sessionManager.findContactsByName(target.value) : [];
        } catch (error) {
            logger?.warn?.('[名册] 按昵称找人失败', { name: target.value, error: error?.message });
        }
        if (candidates.length === 0) {
            if (typeof sendFailureMessage === 'function') {
                await sendFailureMessage(`没找到叫「${target.value}」的人。用 ${ROSTER_COMMAND_DEFAULTS.command} 看看她到底认识谁。`);
            }
            return { handled: true };
        }
        if (candidates.length > 1) {
            if (typeof sendStatusMessage === 'function') {
                await sendStatusMessage(buildForgetCandidateText(target.value, candidates, { command, maxAliases }));
            }
            return { handled: true };
        }
        participantId = candidates[0].participantId;
        displayName = candidates[0].displayName || '';
    }

    let result = { participantId, contactDeleted: 0, memoryEntriesDeleted: 0 };
    try {
        if (typeof sessionManager?.forgetContact === 'function') {
            result = sessionManager.forgetContact(participantId);
        }
    } catch (error) {
        logger?.warn?.('[名册] 删除失败', { participantId, error: error?.message });
    }

    const text = formatForgetResult({ ...result, participantId, displayName });
    logger?.info?.('[名册] 忘记指令', {
        participantId,
        contactDeleted: result.contactDeleted,
        memoryEntriesDeleted: result.memoryEntriesDeleted
    });
    if (typeof sendStatusMessage === 'function') {
        await sendStatusMessage(text);
    }
    return { handled: true };
}
// <<< roster-commands patch <<<
