export const DEFAULT_QQ_EMOJI_REACTION_ID = '289';

export const QQ_EMOJI_REACTION_ALIASES = Object.freeze({
    default: DEFAULT_QQ_EMOJI_REACTION_ID,
    '默认': DEFAULT_QQ_EMOJI_REACTION_ID,
    '收到': DEFAULT_QQ_EMOJI_REACTION_ID,
    ok: DEFAULT_QQ_EMOJI_REACTION_ID,
    okay: DEFAULT_QQ_EMOJI_REACTION_ID,
    '好的': DEFAULT_QQ_EMOJI_REACTION_ID,
    like: '76',
    thumb: '76',
    thumbs_up: '76',
    '赞': '76',
    '点赞': '76',
    heart: '66',
    love: '66',
    '爱心': '66',
    doge: '277',
    '狗头': '277'
});

// >>> qq-face-names patch >>>
/**
 * QQ **内置表情** 的 id → 中文名。
 *
 * 为什么要有这张表：收进来的 face 段里 `name` **经常是空串**（实测
 * `{"type":"face","id":"66","name":""}`），于是提示词里只剩 `[QQ表情|id=66]` ——
 * 模型不可能从一个数字知道 66 是「爱心」，所以看上去就是"她不认识这个表情"
 * （2026-10-11 用户实测：连发两个爱心，她只回「来了来了」「怎么了~」）。
 *
 * 数据来源：NapCat 自带的表情定义 `static/assets/qface-Cp_sIXAp.js` 里的 `QSid`/`QDes`
 * （**不是手抄的**，是脚本抽出来的；`QSid` 就是 OneBot face 段的 id，实测 66=爱心、
 * 76=赞、63=玫瑰、67=心碎，与 `QQ_EMOJI_REACTION_ALIASES` 的口径一致）。
 * 共 275 条，id 范围 0..348，无重名。
 * ⚠ 升级 NapCat 后这张表可能过时；`resolveQqFaceName()` 对表外的 id 返回空串，
 *   不会瞎猜（宁可没名字，也不要给错名字）。
 */
export const QQ_FACE_NAMES = Object.freeze({
    '0': '惊讶', '1': '撇嘴', '2': '色', '3': '发呆', '4': '得意', '5': '流泪', '6': '害羞', '7': '闭嘴',
    '8': '睡', '9': '大哭', '10': '尴尬', '11': '发怒', '12': '调皮', '13': '呲牙', '14': '微笑', '15': '难过',
    '16': '酷', '18': '抓狂', '19': '吐', '20': '偷笑', '21': '可爱', '22': '白眼', '23': '傲慢', '24': '饥饿',
    '25': '困', '26': '惊恐', '27': '流汗', '28': '憨笑', '29': '悠闲', '30': '奋斗', '31': '咒骂', '32': '疑问',
    '33': '嘘', '34': '晕', '35': '折磨', '36': '衰', '37': '骷髅', '38': '敲打', '39': '再见', '41': '发抖',
    '42': '爱情', '43': '跳跳', '46': '猪头', '49': '拥抱', '53': '蛋糕', '54': '闪电', '55': '炸弹', '56': '刀',
    '57': '足球', '59': '便便', '60': '咖啡', '61': '饭', '63': '玫瑰', '64': '凋谢', '66': '爱心', '67': '心碎',
    '69': '礼物', '74': '太阳', '75': '月亮', '76': '赞', '77': '踩', '78': '握手', '79': '胜利', '85': '飞吻',
    '86': '怄火', '89': '西瓜', '96': '冷汗', '97': '擦汗', '98': '抠鼻', '99': '鼓掌', '100': '糗大了', '101': '坏笑',
    '102': '左哼哼', '103': '右哼哼', '104': '哈欠', '105': '鄙视', '106': '委屈', '107': '快哭了', '108': '阴险', '109': '左亲亲',
    '110': '吓', '111': '可怜', '112': '菜刀', '113': '啤酒', '114': '篮球', '115': '乒乓', '116': '示爱', '117': '瓢虫',
    '118': '抱拳', '119': '勾引', '120': '拳头', '121': '差劲', '122': '爱你', '123': 'NO', '124': 'OK', '125': '转圈',
    '126': '磕头', '127': '回头', '128': '跳绳', '129': '挥手', '130': '激动', '131': '街舞', '132': '献吻', '133': '左太极',
    '134': '右太极', '136': '双喜', '137': '鞭炮', '138': '灯笼', '140': 'K歌', '144': '喝彩', '145': '祈祷', '146': '爆筋',
    '147': '棒棒糖', '148': '喝奶', '151': '飞机', '158': '钞票', '168': '药', '169': '手枪', '171': '茶', '172': '眨眼睛',
    '173': '泪奔', '174': '无奈', '175': '卖萌', '176': '小纠结', '177': '喷血', '178': '斜眼笑', '179': 'doge', '180': '惊喜',
    '181': '骚扰', '182': '笑哭', '183': '我最美', '184': '河蟹', '185': '羊驼', '187': '幽灵', '188': '蛋', '190': '菊花',
    '192': '红包', '193': '大笑', '194': '不开心', '197': '冷漠', '198': '呃', '199': '好棒', '200': '拜托', '201': '点赞',
    '202': '无聊', '203': '托脸', '204': '吃', '205': '送花', '206': '害怕', '207': '花痴', '208': '小样儿', '210': '飙泪',
    '211': '我不看', '212': '托腮', '214': '啵啵', '215': '糊脸', '216': '拍头', '217': '扯一扯', '218': '舔一舔', '219': '蹭一蹭',
    '220': '拽炸天', '221': '顶呱呱', '222': '抱抱', '223': '暴击', '224': '开枪', '225': '撩一撩', '226': '拍桌', '227': '拍手',
    '228': '恭喜', '229': '干杯', '230': '嘲讽', '231': '哼', '232': '佛系', '233': '掐一掐', '234': '惊呆', '235': '颤抖',
    '236': '啃头', '237': '偷看', '238': '扇脸', '239': '原谅', '240': '喷脸', '241': '生日快乐', '242': '头撞击', '243': '甩头',
    '244': '扔狗', '245': '加油必胜', '246': '加油抱抱', '247': '口罩护体', '260': '搬砖中', '261': '忙到飞起', '262': '脑阔疼', '263': '沧桑',
    '264': '捂脸', '265': '辣眼睛', '266': '哦哟', '267': '头秃', '268': '问号脸', '269': '暗中观察', '270': 'emm', '271': '吃瓜',
    '272': '呵呵哒', '273': '我酸了', '274': '太南了', '276': '辣椒酱', '277': '汪汪', '278': '汗', '279': '打脸', '280': '击掌',
    '281': '无眼笑', '282': '敬礼', '283': '狂笑', '284': '面无表情', '285': '摸鱼', '286': '魔鬼笑', '287': '哦', '288': '请',
    '289': '睁眼', '290': '敲开心', '291': '震惊', '292': '让我康康', '293': '摸锦鲤', '294': '期待', '295': '拿到红包', '296': '真好',
    '297': '拜谢', '298': '元宝', '299': '牛啊', '300': '胖三斤', '301': '好闪', '302': '左拜年', '303': '右拜年', '304': '红包包',
    '305': '右亲亲', '306': '牛气冲天', '307': '喵喵', '308': '求红包', '309': '谢红包', '310': '新年烟花', '311': '打call', '312': '变形',
    '313': '嗑到了', '314': '仔细分析', '315': '加油', '316': '我没事', '317': '菜狗', '318': '崇拜', '319': '比心', '320': '庆祝',
    '321': '老色痞', '322': '拒绝', '323': '嫌弃', '324': '吃糖', '325': '惊吓', '326': '生气', '327': '加一', '328': '错号',
    '329': '对号', '330': '完成', '331': '明白', '332': '举牌牌', '333': '烟花', '334': '虎虎生威', '336': '豹富', '337': '花朵脸',
    '338': '我想开了', '339': '舔屏', '340': '热化了', '341': '打招呼', '342': '酸Q', '343': '我方了', '344': '大怨种', '345': '红包多多',
    '346': '你真棒棒', '347': '大展宏兔', '348': '福萝卜',
});

const QQ_FACE_NAME_MAX = 12;   // 昵称/描述混进来的长文本不该被当成表情名

/** id → 中文名；查不到或 id 不合法就返回 ''（调用方据此决定要不要补名字）。 */
export function resolveQqFaceName(value) {
    const id = String(value ?? '').trim();
    if (!/^\d+$/.test(id)) return '';
    const name = QQ_FACE_NAMES[id];
    if (typeof name !== 'string') return '';
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > QQ_FACE_NAME_MAX) return '';
    return trimmed;
}
// <<< qq-face-names patch <<<

function sanitizeText(value) {
    return String(value ?? '').trim();
}

function clampInteger(value, minimum, maximum, fallback) {
    const normalized = Number(value);
    if (!Number.isFinite(normalized)) {
        return fallback;
    }
    return Math.min(maximum, Math.max(minimum, Math.floor(normalized)));
}

export function normalizeEmojiReactionId(value, fallback = DEFAULT_QQ_EMOJI_REACTION_ID) {
    const rawValue = Array.isArray(value) ? value[0] : value;
    const normalizedFallback = /^\d+$/.test(sanitizeText(fallback)) ? sanitizeText(fallback) : DEFAULT_QQ_EMOJI_REACTION_ID;
    const rawText = sanitizeText(rawValue);
    if (!rawText) {
        return normalizedFallback;
    }

    const withoutPrefix = rawText.replace(/^qq[:：]/i, '').replace(/^id[:：]/i, '').trim();
    if (/^\d+$/.test(withoutPrefix)) {
        return withoutPrefix;
    }

    const lowerKey = withoutPrefix.toLowerCase();
    return QQ_EMOJI_REACTION_ALIASES[withoutPrefix]
        || QQ_EMOJI_REACTION_ALIASES[lowerKey]
        || normalizedFallback;
}

export function resolveEmojiReactionId(config = {}) {
    const chatConfig = config?.chat || {};
    return normalizeEmojiReactionId(
        chatConfig.emojiReactionId ?? chatConfig.emojiReactionEmojiId ?? chatConfig.emojiReaction?.id,
        DEFAULT_QQ_EMOJI_REACTION_ID
    );
}

// >>> group-command-at-gate patch >>>
/**
 * 剥掉开头的 `@` 标记。
 *
 * 为什么必须剥：群里 @ 了机器人之后，`plainText` 开头会留下由 @ 段生成的
 * `[@bot] ` / `[@某人|QQ:123] `（见 index.js 的 summarizeOneBotSegment）。
 * 指令判定是 `startsWith(command)`，带着这个前缀就**永远匹配不上** ——
 * 于是"群里必须 @ 才能用指令"和"@ 了反而匹配不上"互相打架，
 * 两条规则同时生效的结果是**指令在群里一次都不会响应**（2026-10-12 实测）。
 *
 * 连续多个 @ 也一起吃掉（有人习惯 @bot @某人 再打指令）。
 * ⚠ 只剥**开头**的：指令后面的 @ 是参数（`/戳一戳 @某人`），不能动。
 */
const LEADING_AT_MARKER_RE = /^(?:\s*\[@[^\]]*\])+/;

export function stripLeadingAtMarkers(text) {
    return sanitizeText(text).replace(LEADING_AT_MARKER_RE, '').trim();
}
// <<< group-command-at-gate patch <<<

export function isCommandInvocation(plainText = '', command = '') {
    const normalizedText = stripLeadingAtMarkers(plainText);
    const normalizedCommand = sanitizeText(command);
    if (!normalizedText || !normalizedCommand) {
        return false;
    }
    if (normalizedText === normalizedCommand) {
        return true;
    }
    if (!normalizedText.startsWith(normalizedCommand)) {
        return false;
    }

    const nextChar = normalizedText.slice(normalizedCommand.length, normalizedCommand.length + 1);
    return !nextChar || /\s/.test(nextChar) || nextChar === '@' || nextChar === '[' || nextChar === '［';
}

export function extractMentionedUserIds(event = {}) {
    const segments = Array.isArray(event.message) ? event.message : [];
    const seen = new Set();
    const targetUserIds = [];
    for (const segment of segments) {
        if (segment?.type !== 'at') {
            continue;
        }
        const qq = segment.data?.qq;
        if (qq === undefined || qq === null || String(qq) === 'all') {
            continue;
        }
        const targetUserId = sanitizeText(qq);
        if (targetUserId && !seen.has(targetUserId)) {
            seen.add(targetUserId);
            targetUserIds.push(targetUserId);
        }
    }
    return targetUserIds;
}

export function extractFirstMentionedUserId(event = {}) {
    return extractMentionedUserIds(event)[0] || '';
}

export function hasAtAllMention(event = {}) {
    const segments = Array.isArray(event.message) ? event.message : [];
    return segments.some((segment) => segment?.type === 'at' && String(segment.data?.qq) === 'all');
}

export function normalizePokeRepeatCount(value, fallback = 5) {
    return clampInteger(value, 1, 10, fallback);
}

export async function executeAdminPokeCommand({
    event = {},
    plainText = '',
    command = '/戳一戳',
    enabled = true,
    repeatCount = 5,
    isAdmin = false,
    bot = null,
    onCommandAccepted = null,
    sendFailureMessage = null,
    sendStatusMessage = null,
    logger = console
} = {}) {
    const normalizedCommand = sanitizeText(command) || '/戳一戳';
    if (!isCommandInvocation(plainText, normalizedCommand)) {
        return { handled: false, ok: false, reason: 'not_command' };
    }

    if (enabled === false) {
        return { handled: false, ok: false, reason: 'disabled' };
    }

    if (typeof onCommandAccepted === 'function') {
        onCommandAccepted();
    }

    const fail = async (message, reason) => {
        if (typeof sendFailureMessage === 'function') {
            await sendFailureMessage(message);
        }
        return { handled: true, ok: false, reason, error: message };
    };

    if (!isAdmin) {
        return fail('只有管理员可以使用戳一戳命令', 'not_admin');
    }

    if (event.message_type !== 'group' || !event.group_id) {
        return fail('戳一戳命令仅支持群聊使用', 'not_group');
    }

    if (hasAtAllMention(event)) {
        return fail('戳一戳不支持 @全体成员', 'at_all');
    }

    const targetUserIds = extractMentionedUserIds(event);
    if (targetUserIds.length === 0) {
        return fail(`请使用 ${normalizedCommand} @某人`, 'missing_target');
    }

    if (!bot || typeof bot.sendGroupPoke !== 'function') {
        return fail('当前 OneBot 不支持 group_poke，无法戳一戳', 'unsupported');
    }

    const normalizedRepeatCount = normalizePokeRepeatCount(repeatCount, 5);
    const completedByTarget = new Map(targetUserIds.map((targetUserId) => [targetUserId, 0]));
    let currentTargetUserId = targetUserIds[0];
    try {
        for (const targetUserId of targetUserIds) {
            currentTargetUserId = targetUserId;
            for (let index = 0; index < normalizedRepeatCount; index += 1) {
                await bot.sendGroupPoke(event.group_id, targetUserId);
                completedByTarget.set(targetUserId, (completedByTarget.get(targetUserId) || 0) + 1);
            }
        }
    } catch (error) {
        const completedCurrent = completedByTarget.get(currentTargetUserId) || 0;
        const completedTotal = Array.from(completedByTarget.values()).reduce((sum, count) => sum + count, 0);
        logger?.warn?.(`[戳一戳] 执行失败: ${currentTargetUserId} ${error.message}`);
        return fail(`戳一戳失败: ${error.message}（QQ ${currentTargetUserId} 已执行 ${completedCurrent}/${normalizedRepeatCount} 下，总计 ${completedTotal}/${targetUserIds.length * normalizedRepeatCount} 下）`, 'poke_failed');
    }

    return {
        handled: true,
        ok: true,
        groupId: String(event.group_id),
        targetUserId: targetUserIds[0],
        targetUserIds,
        targetCount: targetUserIds.length,
        repeatCount: normalizedRepeatCount
    };
}
