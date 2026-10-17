/**
 * `/帮助` —— 指令清单
 * ---------------------------------------------------------------------------
 * 设计要点：**指令名和开关都从 `config` 实时解析，不写死在文本里**。
 *
 * 为什么必须这样
 * --------------
 * 帮助文本最容易腐烂：`chat.commands.*.command` 是可配置的（用户随时能把 `/名册`
 * 改成 `/花名册`），`chat.music.enabled` 也能随时关。一旦把指令名/状态抄进固定字符串，
 * 帮助就开始骗人 —— 而且没人会去同步它。所以这里只维护一张**表**，
 * 文本在每次调用时按当前 config 现拼。
 *
 * 权限分层
 * --------
 * - 所有人：`/帮助` 本身 + 面向普通用户的指令（点歌）
 * - 管理员：再加人物类 / OJ 反馈 / 档案 / 戳一戳 / 主动 @
 * 非管理员只看到自己那一屏，不会看到一堆用不了的指令。
 *
 * 未开启的指令**照样列出但标注「未开启」**，而不是隐藏 —— 否则用户会以为功能没了
 * （点歌当前就是关的，藏起来反而让人来问）。
 */

export const HELP_COMMAND_DEFAULTS = {
    enabled: true,
    command: '/帮助'
};

function cleanText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * 指令表。`resolve` 每次都从 config 取当前值。
 * - `usage` 是函数：要拼进真实指令名，不能写死
 * - `adminOnly` 决定分屏
 * - `section` 决定归到哪一节
 */
const HELP_ENTRIES = [
    {
        id: 'help',
        section: 'common',
        resolve: (config) => ({
            command: cleanText(config.chat?.commands?.help?.command) || HELP_COMMAND_DEFAULTS.command,
            enabled: config.chat?.commands?.help?.enabled !== false
        }),
        usage: (cmd) => `${cmd} [关键词]`,
        desc: '显示指令列表；附带关键词时仅显示匹配项'
    },
    {
        id: 'music',
        section: 'common',
        resolve: (config) => ({
            command: cleanText(config.chat?.music?.command) || '/music',
            enabled: config.chat?.music?.enabled === true
        }),
        usage: (cmd) => `${cmd} <歌名>`,
        desc: '点歌，支持以语音发送'
    },
    {
        id: 'musicExit',
        section: 'common',
        resolve: (config) => ({
            command: cleanText(config.chat?.music?.exitCommand) || '/music-exit',
            enabled: config.chat?.music?.enabled === true
        }),
        usage: (cmd) => cmd,
        desc: '退出点歌会话'
    },
    {
        id: 'roster',
        section: 'admin',
        adminOnly: true,
        resolve: (config) => ({
            command: cleanText(config.chat?.commands?.roster?.command) || '/名册',
            enabled: config.chat?.commands?.roster?.enabled !== false
        }),
        usage: (cmd) => `${cmd} [关键词]`,
        desc: '列出联系人：QQ 号及其全部别称'
    },
    {
        id: 'forget',
        section: 'admin',
        adminOnly: true,
        resolve: (config) => ({
            command: cleanText(config.chat?.commands?.forget?.command) || '/忘记',
            enabled: config.chat?.commands?.forget?.enabled !== false
        }),
        usage: (cmd) => `${cmd} <昵称|QQ号|@某人>`,
        desc: '移除指定联系人与相关记忆副本；不改动群聊历史'
    },
    {
        id: 'thinking',
        section: 'admin',
        adminOnly: true,
        resolve: (config) => ({
            command: cleanText(config.chat?.commands?.thinking?.command) || '/思考',
            enabled: config.chat?.commands?.thinking?.enabled !== false
        }),
        usage: (cmd) => `${cmd} 开|关|配置`,
        desc: '切换回复中是否附带思考内容（括号形式）'
    },
    {
        id: 'ojFeedback',
        section: 'admin',
        adminOnly: true,
        resolve: (config) => ({
            command: cleanText(config.chat?.commands?.ojFeedback?.command) || '/反馈',
            enabled: (config.chat?.commands?.ojFeedback?.enabled !== false)
                && config.ojFeedback?.enabled === true
        }),
        usage: (cmd) => `${cmd} [拉]`,
        desc: '查看 OJ 反馈轮询状态；附加「拉」立即拉取并转发一次'
    },
    {
        id: 'participantProfileManual',
        section: 'admin',
        adminOnly: true,
        resolve: (config) => ({
            command: cleanText(config.chat?.commands?.participantProfileManual?.command) || '/人物档案',
            enabled: config.chat?.commands?.participantProfileManual?.enabled !== false
        }),
        usage: (cmd) => `${cmd} @某人`,
        desc: '手动分析指定用户的性格档案'
    },
    {
        id: 'adminPoke',
        section: 'admin',
        adminOnly: true,
        resolve: (config) => ({
            command: cleanText(config.chat?.commands?.adminPoke?.command) || '/戳一戳',
            enabled: config.chat?.commands?.adminPoke?.enabled !== false
        }),
        usage: (cmd) => `${cmd} @某人`,
        desc: (config) => `连续戳一戳，共 ${config.chat?.commands?.adminPoke?.repeatCount ?? 5} 次`
    },
    // >>> profile-view-command patch >>>
    {
        id: 'profileView',
        section: 'admin',
        adminOnly: true,
        resolve: (config) => ({
            command: cleanText(config.chat?.commands?.profileView?.command) || '/画像',
            enabled: config.chat?.commands?.profileView?.enabled !== false
        }),
        usage: (cmd) => `${cmd} [@某人|昵称|QQ号]`,
        desc: '查看她把某人记成了什么样；不带参数则列出全部画像'
    },
    // <<< profile-view-command patch <<<
    {
        id: 'adminMention',
        section: 'admin',
        adminOnly: true,
        resolve: (config) => ({
            command: cleanText(config.chat?.commands?.adminMention?.command) || '/at',
            enabled: config.chat?.commands?.adminMention?.enabled !== false
        }),
        usage: (cmd) => `${cmd} @某人 <要求>`,
        desc: '以角色口吻主动 @ 指定用户并生成一段发言'
    }
];

/**
 * 「触发方式」这一节 —— 从触发配置现算，别让人去猜为什么群里说话它不理。
 *
 * 措辞口径（用户 2026-10-12 要求「公正一点、书面一点」）：
 * 说明文口吻，用「机器人」作主语而不是「她」，不用「就行 / 好麻烦」这类聊天腔。
 */
function buildTriggerLines(config, options = {}) {
    const lines = [];
    const isGroup = options.messageType === 'group';
    const keywords = Array.isArray(config.chat?.triggerKeywords) ? config.chat.triggerKeywords.filter(Boolean) : [];
    const requireAt = config.chat?.requireAtInGroup !== false;
    const isAdmin = options.isAdmin === true;
    const kw = keywords.slice(0, 6).join('、') + (keywords.length > 6 ? ' 等' : '');

    if (isGroup) {
        if (requireAt && keywords.length > 0) {
            lines.push(`群聊：需 @机器人，或消息中包含以下关键词 —— ${kw}`);
        } else if (requireAt) {
            lines.push('群聊：需 @机器人。');
        } else if (keywords.length > 0) {
            lines.push(`群聊：消息包含以下关键词即会响应 —— ${kw}；@机器人 同样有效。`);
        } else {
            lines.push('群聊：由机器人的群聊意愿自行决定是否响应。');
        }
        // 回复窗口：最容易被忽略、也最影响体验的一条
        if (config.chat?.replyWindow?.enabled === true) {
            const sec = Math.round((config.chat.replyWindow.ms ?? 180000) / 1000);
            lines.push(`回复窗口：机器人回复后 ${sec} 秒内，同一发送者再次发言无需 @；每次回复会重置该计时。`);
        }
        const triggerUsers = Array.isArray(config.chat?.triggerUsers) ? config.chat.triggerUsers.filter(Boolean) : [];
        if (triggerUsers.length > 0 && !isAdmin) {
            lines.push('注：本群设有免 @ 名单。');
        }
    } else {
        lines.push('私聊：发送消息或指令均无需 @。');
    }
    if (isGroup) {
        // 指令的 @ 口径与「说话」不同：指令绕过了触发规则，所以单独设了闸门
        // （见 index.js 的 group-command-at-gate patch），这里必须如实写出来。
        lines.push('指令：群聊中需 @机器人 才会执行。');
    }
    return lines;
}

/**
 * 拼整段帮助文本。纯函数：给定 config + 视角，输出稳定。
 */
export function buildHelpText(config = {}, options = {}) {
    const isAdmin = options.isAdmin === true;
    const keyword = cleanText(options.keyword).replace(/^\//, '').toLowerCase();

    const resolved = HELP_ENTRIES.map((entry) => {
        const state = entry.resolve(config);
        return {
            ...entry,
            command: state.command,
            enabled: state.enabled,
            usageText: entry.usage(state.command),
            // desc 可以是字符串，也可以是 config 的函数（凡是带动态数字的都用函数）
            descText: typeof entry.desc === 'function' ? entry.desc(config) : entry.desc
        };
    });

    const visible = resolved.filter((entry) => (entry.adminOnly ? isAdmin : true));
    // 关键词过滤：指令名 / 用法 / 说明任一命中
    const matched = keyword
        ? visible.filter((e) => [e.command, e.usageText, e.descText].join(' ').toLowerCase().includes(keyword))
        : visible;

    if (keyword && matched.length === 0) {
        const hint = isAdmin ? '' : '管理指令仅对管理员显示。';
        return `未找到与「${cleanText(options.keyword)}」相关的指令。${hint}\n`
            + `发送 ${cleanText(resolved[0]?.command) || HELP_COMMAND_DEFAULTS.command} 可查看全部指令。`;
    }

    const sections = [];
    if (!keyword) {
        sections.push({ title: '触发方式', lines: buildTriggerLines(config, { ...options, isAdmin }) });
    }

    const common = matched.filter((e) => e.section === 'common');
    const admin = matched.filter((e) => e.section === 'admin');
    const formatEntry = (e) => `· ${e.usageText} —— ${e.descText}${e.enabled ? '' : '（未启用）'}`;

    if (common.length > 0) {
        sections.push({ title: '通用指令', lines: common.map(formatEntry) });
    }
    if (admin.length > 0) {
        sections.push({ title: '管理员指令', lines: admin.map(formatEntry) });
    }

    const head = keyword
        ? `与「${cleanText(options.keyword)}」相关的指令：`
        : `指令列表${isAdmin ? '（当前身份：管理员，含管理指令）' : ''}：`;
    const body = sections
        .map((s) => `【${s.title}】\n${s.lines.join('\n')}`)
        .join('\n\n');
    const tail = (!keyword && !isAdmin)
        ? '\n\n注：管理指令仅对管理员显示，故未在此列出。'
        : '';
    return `${head}\n\n${body}${tail}`;
}

// >>> help-command patch >>>
/**
 * `/帮助` 句柄。面向所有人，所以和点歌一样**必须过访问控制** ——
 * 不在允许名单里的群/人，连指令清单都不该拿到。
 */
export async function executeHelpCommand({
    event = {},
    plainText = '',
    getConfig = null,
    command = HELP_COMMAND_DEFAULTS.command,
    enabled = true,
    isAdmin = false,
    allowed = true,
    characterName = '',
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
    if (!allowed) {
        // 静默：不要在未授权会话里回一句"你没权限"，那本身就是信息泄露
        return { handled: true };
    }
    if (typeof onCommandAccepted === 'function') {
        onCommandAccepted();
    }

    const config = (typeof getConfig === 'function' ? getConfig() : null) || {};
    const keyword = plainText.slice(command.length).replace(/^[\s@]+/, '').trim();
    const text = buildHelpText(config, {
        isAdmin,
        keyword,
        messageType: event.message_type,
        characterName
    });

    logger?.info?.('[帮助] 指令', {
        isAdmin,
        messageType: event.message_type,
        keyword,
        length: text.length
    });
    if (typeof sendStatusMessage === 'function') {
        await sendStatusMessage(text);
    }
    return { handled: true };
}
// <<< help-command patch <<<
