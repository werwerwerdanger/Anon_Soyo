// >>> builtin-face-split patch >>>
// `face` 段的 name 常为空，需要 id→中文名。qq-interactions.js 零依赖，不会成环。
import { resolveQqFaceName } from './qq-interactions.js';
// <<< builtin-face-split patch <<<

// >>> short-answer-hint patch >>>
// 剥信封的唯一实现（零依赖叶子模块）。判断"这条消息有多短"必须看**剥完信封**的正文，
// 否则结构化信封（`[私聊|QQ:…|昵称:…|messageSegments:[…]]`）会让每句话都显得很长。
import { stripStructuredEnvelope } from './structured-envelope.js';
// <<< short-answer-hint patch <<<

function cleanText(value) {
    return String(value ?? '').replace(/\r/g, '').trim();
}

function normalizeText(value) {
    return cleanText(value).replace(/\s+/g, ' ');
}

function compactText(value, limit = 180) {
    const text = normalizeText(value);
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function getLatestEvent(runtimeContext = {}) {
    if (runtimeContext.primaryStandardEvent) {
        return runtimeContext.primaryStandardEvent;
    }
    const events = Array.isArray(runtimeContext.standardEvents) ? runtimeContext.standardEvents : [];
    return events.length > 0 ? events[events.length - 1] : null;
}

function getLatestRouting(runtimeContext = {}) {
    const decisions = Array.isArray(runtimeContext.routingDecisions) ? runtimeContext.routingDecisions : [];
    if (decisions.length > 0) {
        return decisions[decisions.length - 1];
    }
    const event = getLatestEvent(runtimeContext);
    return event?.routing || null;
}

function getSegmentTypes(event = {}) {
    return (Array.isArray(event.segments) ? event.segments : [])
        .map((segment) => cleanText(segment.type))
        .filter(Boolean);
}

// >>> builtin-face-split patch >>>
// 2026-10-11 用户：「把内置表情从『默认无视表情包』里摘出来」。
// 起因：连发两个爱心，她只回「来了来了」「怎么了~」。
// 分两类（之前是一视同仁的）：
//   - **真·表情包** = 自制的图片/大表情/动画表情（`image`/`mface`/`marketface`）
//     ⇒ 保持 2026-10-10 的规则：默认无视、走 `chat.stickerReplyChance` 低意愿。
//   - **QQ 自带表情** = `face`（爱心/赞/心碎…）—— 它有**确定语义**，
//     和一张自制表情包不是一回事 ⇒ 当成"短的、有意义的一句话"对待。
//     ⚠ 光有名字还不够：`face` 段的 `name` 常常是空串（实测
//     `{"type":"face","id":"66","name":""}`），得靠 qq-interactions.js 的
//     `resolveQqFaceName()` 把 id 翻成中文名（同日已修）。
const STICKER_SEG_TYPES = ['image', 'mface', 'marketface'];
const BUILTIN_FACE_SEG_TYPES = ['face'];

function hasEmojiSegment(event = {}) {
    // >>> image-as-sticker patch (managed by patch_image_as_sticker.py) >>>
    // QQ 的表情包/动画表情在 OneBot 里是 image 段（summary: [动画表情]），
    // 不是 face/mface/marketface。只认后三个会让「收图」这条路径完全不生效：
    // emoji_reaction 意图不触发 ⇒ 对应策略和警告都不会出现（2026-10-10 实测踩到）。
    return getSegmentTypes(event).some((type) => STICKER_SEG_TYPES.includes(type));
    // <<< image-as-sticker patch <<<
}

function hasBuiltinFaceSegment(event = {}) {
    return getSegmentTypes(event).some((type) => BUILTIN_FACE_SEG_TYPES.includes(type));
}

/** 这条消息里的 QQ 自带表情叫什么（查 id→中文名；查不到就不提名字，绝不瞎猜）。 */
function getBuiltinFaceNames(event = {}) {
    const out = [];
    for (const segment of Array.isArray(event.segments) ? event.segments : []) {
        if (cleanText(segment?.type) !== 'face') continue;
        const explicit = cleanText(segment?.name || segment?.summary || segment?.text);
        const name = explicit || resolveQqFaceName(segment?.id ?? segment?.data?.id);
        if (name && !out.includes(name)) out.push(name);
    }
    return out;
}
// <<< builtin-face-split patch <<<


function hasOnlyNonTextSegments(event = {}) {
    const segments = Array.isArray(event.segments) ? event.segments : [];
    return segments.length > 0 && segments.every((segment) => cleanText(segment.type) !== 'text');
}

function looksLowInformation(text, event = {}) {
    const normalized = normalizeText(text);
    if (!normalized) return true;
    if (/^[?？!！。.,，~～…]+$/.test(normalized)) return true;
    if (/^(在吗|出来|出来一下|徐缺|滴滴|dd|戳|啊|嗯|哦|草|操|笑死)$/i.test(normalized)) return true;
    if (normalized.length <= 3 && !/[\u4e00-\u9fa5A-Za-z0-9]{3,}/.test(normalized)) return true;
    if (hasOnlyNonTextSegments(event) && normalized.length <= 20) return true;
    return false;
}

function isCallOut(text = '') {
    const normalized = normalizeText(text);
    return /^(徐缺[，, ]*)?(在吗|出来|出来一下|说话|滴滴|dd)$/i.test(normalized)
        || /^徐缺[，, ]*(出来一下|出来|在吗|说话)?$/i.test(normalized);
}

function isTopicShift(text = '') {
    return /(不聊|别聊|换话题|换个话题|先不说|别提|停一下|腻了|突然想|说回|算了)/.test(normalizeText(text));
}

function asksReleaseOldTopic(text = '') {
    return /(别提|不聊|别聊|停一下|腻了|少用|别再|换话题|哪里谈到|哪谈到|谁提|谁说|怎么又|咋又|怎么扯到|咋扯到|刚才有说|前文有说)/.test(normalizeText(text));
}

function detectIntent({ event, text }) {
    if (event?.eventType === 'poke') return 'poke';
    if (event?.reply?.toBot === true) return 'reply_to_bot';
    if (isCallOut(text)) return 'call_out';
    if (hasEmojiSegment(event)) return 'emoji_reaction';
    // >>> builtin-face-split patch >>>
    // QQ 自带表情（爱心/赞/心碎…）**且整条没有文字** ⇒ 当成"有意义的一小句"。
    // ⚠ 必须要求 hasOnlyNonTextSegments：文字里夹个爱心（"在吗[爱心]"）就是普通消息，
    //   不该走这条。
    // ⚠ 放在 hasEmojiSegment **之后**：图 + 爱心混着发时，图的规则优先。
    if (hasBuiltinFaceSegment(event) && hasOnlyNonTextSegments(event)) return 'builtin_face';
    // <<< builtin-face-split patch <<<
    if (isTopicShift(text)) return 'topic_shift';
    if (looksLowInformation(text, event)) return 'low_information';
    if (/[?？]$/.test(normalizeText(text))) return 'question';
    return 'chat';
}

function buildReplyTarget({ event, routing, intent }) {
    if (intent === 'poke') return 'respond_to_poke_user';
    if (event?.reply?.toBot === true || routing?.triggerReason === 'reply_to_bot') return 'reply_to_current_user_about_bot_quote';
    if (event?.bot?.isAtBot || routing?.triggerReason === 'at') return 'reply_to_mentioned_bot_request';
    if (event?.messageType === 'private') return 'reply_to_private_user';
    return 'reply_to_current_user_only_if_triggered';
}

function buildStrategies({ event, text, intent, routing }) {
    const strategies = ['read_header_first', 'answer_latest_user_text'];

    if (event?.reply?.messageId) {
        strategies.push('use_quote_as_context_only');
    }
    if (event?.reply?.toBot === true) {
        strategies.push('treat_as_addressed_to_bot_even_without_at');
    }
    if (intent === 'poke') {
        strategies.push('acknowledge_poke_briefly');
    }
    // >>> sticker-react patch (managed by patch_sticker_react.py) >>>
    // 原来这里 push 的是 'describe_visible_emoji_or_mood'（字面意思：描述可见的表情），
    // 结果机器人收到表情包就逐张描述画面/念图上的字。真人收到表情只会给反应。
    if (intent === 'emoji_reaction') {
        // >>> sticker-strategy-ignore patch >>>
        // 用户 2026-10-10：默认当没发过一样。策略名是原样喂给模型的，
        // 写 'react' 就等于在命令她对表情包做反应（与「注意:」行自相矛盾）。
        strategies.push('ignore_sticker_keep_talking_about_text');
        // <<< sticker-strategy-ignore patch <<<
    }
    // <<< sticker-react patch <<<
    // >>> builtin-face-split patch >>>
    // 策略名是**原样喂给模型**的，所以名字本身就是指令。
    // 这里刻意不写 'ignore_...' —— 内置表情是要回应的。
    if (intent === 'builtin_face') {
        strategies.push('respond_to_builtin_face_in_character');
    }
    // <<< builtin-face-split patch <<<
    if (intent === 'low_information' || intent === 'call_out') {
        strategies.push('give_short_acknowledgement');
        strategies.push('avoid_question_as_crutch');
    }
    if (intent === 'topic_shift' || asksReleaseOldTopic(text)) {
        strategies.push('release_old_topic');
        strategies.push('do_not_repeat_stopped_keyword');
    }
    if (routing?.skipReason) {
        strategies.push('do_not_reply_unless_triggered');
    }

    strategies.push('keep_lines_short_like_typing_on_a_phone');
    return [...new Set(strategies)];
}

// >>> short-answer-hint patch >>>
// 2026-10-15 实证（用户原话：「她好像没懂我在说什么」）：
// 她刚问「你就不能多打两个字啊」，用户回「好嘛」+ 照做的「11111111111」，
// 她当成两句没头没尾的话，答「好嘛什么 / 一串1是几个意思啊」——
// 上下文**没丢**（她自己的问句就在紧邻上一轮），丢的是**语用**：没看出对方在回答她。
// ⚠ 位置：落在「注意:」行**最后**（模型回复前读到的最后一段 system 文本，本项目实测杠杆最高）。
// ⚠ 触发刻意窄（只在极短消息时出现）——「每轮都在的字段」里的常量会被显著度稀释。
// ⚠ 只描述**情境**，不写"她该怎么回"：给引号例句会被逐字搬用（本项目已踩）。
const SHORT_ANSWER_MAX_CHARS = 12;      // 折叠重复字后 ≤12 字，且她刚说过话（reply_window）
const SHORT_ANSWER_ULTRA_CHARS = 6;     // 折叠后 ≤6 字：几乎必然是应答，不给窗口也认
// >>> numeric-chat-hint patch >>>
// 2026-10-19 实测（群 15:32）：「一排16.5的AT全phi摆我脸上」→ 她回
//   「这些数字我听着一阵头疼 / 不过一直刷老曲子 大概也难往上走」：
//   把一句有判断的吐槽压成"数字"这个符号，再用一句空评复述回去。
// ⚠ 判据：**有带小数的数字**（16.5 / 16.47 这种分数感写法）+ **有拉丁词**，
//   再排除编程语境。中文闲聊的「2 点 3 分」没有小数，不算。
const CODE_FENCE_RE = /```|`[^`]+`/;
// 题面/评测类词汇 —— 这类消息里数字是数据范围，不是成绩
const TECH_TALK_RE = /(数据范围|时限|复杂度|样例|输入|输出|评测|提交|编译|代码|wa|tle|mle|\bo\()/i;
// 语气词不算“术语”
const LATIN_STOP = new Set(['ok', 'okay', 'yes', 'no', 'hh', 'hhh', 'em', 'emm', 'www', 'lol', 'orz', 'awa', 'qwq']);
function looksLikeNumbersTalk(text) {
    const plain = String(stripStructuredEnvelope(text) ?? '').trim();
    if (!plain || plain.length > 80) return false;
    if (CODE_FENCE_RE.test(plain)) return false;
    if (TECH_TALK_RE.test(plain)) return false;
    if (!/\d+\.\d+/.test(plain)) return false;
    const latin = (plain.match(/[A-Za-z]{2,6}/g) || []).filter((w) => !LATIN_STOP.has(w.toLowerCase()));
    return latin.length >= 1;
}
const NUMERIC_CHAT_HINT = '他这句里满是他那个圈子的数字和缩写，那是在表态、炫耀或者吐槽；'
    + '接的是说这话的人，数字只是他的说法。';
// <<< numeric-chat-hint patch <<<

const SHORT_ANSWER_HINT = '对方极短的回复（好嘛/嗯/行）很可能是在回答你上一句，先按“他在回答我”理解，顺着接一句。';

function isProbablyShortAnswer(text, routing, event) {
    // 2026-10-19：群里「咬他@某人」这种 2 字指使被判成"在回答我上一句"。
    //   判据：at 段 ≥ 2 且有一段不是机器人 ⇒ 这话冲的是别人，不是在答我。
    const segments = Array.isArray(event?.segments) ? event.segments : [];
    const atSegments = segments.filter((s) => String(s?.type || '') === 'at');
    if (atSegments.length >= 2 && atSegments.some((s) => s?.isBot !== true)) {
        return false;
    }
    const plain = String(stripStructuredEnvelope(text) ?? '');
    // 折叠连续重复字符：'好嘛11111111111' ⇒ '好嘛1'、'哈哈哈哈哈哈' ⇒ '哈'
    const compact = plain.replace(/\s+/g, '').replace(/(.)\1+/g, '$1');
    if (!compact) {
        return false;
    }
    if (/[?？]/.test(compact)) {
        return false;   // 短问句是在提问，不是在回答
    }
    if (compact.length <= SHORT_ANSWER_ULTRA_CHARS) {
        return true;
    }
    return compact.length <= SHORT_ANSWER_MAX_CHARS
        && String(routing?.triggerReason || '') === 'reply_window';
}
// <<< short-answer-hint patch <<<

// >>> code-request-hint patch >>>
// 2026-10-15 实测：用户 @ 素世「给我一份线段树板子」，她**收到了也回了**，但只回「线段树啊」——
//   不是没理，是**没法**：提示词里长度锚点写「长的二三十个字也行」、humanShapeHint 写
//   「一半的消息在六个字以内 / 别攒成一条二十个字的完整句子」⇒ 写 40 行板子直接违反约束，
//   模型于是选择只回一句。修法：**明确要代码时**给一个例外（条件触发，不稀释常态）。
// ⚠ 必须提醒用代码围栏：reply-dispatcher 的 code-safety patch 把 ``` 块**整体算一段**，
//   否则按行拆会把一个程序拆成几十条 QQ 消息。
const CODE_REQUEST_RE = /(?:给|发|写|来|要|求|贴)[^\n]{0,16}(?:板子|模板|代码|题解)/;
const CODE_REQUEST_HINT = '对方明确要代码/板子/模板/题解 —— 直接把完整代码贴出来，'
    + '用 ``` 代码块包起来（这样再长也不会被拆散），别只回一句话。';

function isCodeRequest(text) {
    const plain = String(stripStructuredEnvelope(text) ?? '');
    return CODE_REQUEST_RE.test(plain);
}
// <<< code-request-hint patch <<<

// >>> send-status patch >>>
// sendFailureHint：上一轮那条没送达（禁言/无权限/风控）时的事实，放在最末尾。
// <<< send-status patch <<<
function buildWarnings({ event, text, intent, routing, styleAnchor = '', humanShapeHint = '', participantRosterMention = '', stickerHint = '', sendFailureHint = '', moodHint = '' }) {
    const warnings = [];
    if (event?.reply?.fetchStatus === 'failed') {
        warnings.push(`引用消息获取失败: ${event.reply.fetchReason || 'unknown'}`);
    }
    if (event?.reply?.messageId && event?.reply?.toBot !== true) {
        warnings.push('这是普通引用，不要误判为用户在叫 bot');
    }
    if (intent === 'low_information') {
        warnings.push('低信息输入不要用反问把问题甩回用户');
    }
    if (asksReleaseOldTopic(text)) {
        warnings.push('用户正在要求释放旧话题或旧口癖');
    }
    if (routing?.skipReason) {
        warnings.push(`当前路由未触发回复: ${routing.skipReason}`);
    }
    // >>> length-anchor patch (managed by patch_length_anchor.py) >>>
    // 这一行是模型产出回复前最后读到的 system 文本，压长度的最高杠杆位置。
    // 数字来自实测（本群真人 296 条）：中位 7 字、≤6 字占 49%、换行 0%。
    // >>> style-anchor-config patch (managed by patch_style_anchor_config.py) >>>
    // 范句按角色配（chat.styleAnchor）—— 爱音多用感叹号波浪号，素世几乎不用，
    // 写死在共享代码里会把两个人磨成同一种腔调。
    const anchorText = typeof styleAnchor === 'string' ? styleAnchor.trim() : '';
    warnings.push(
        // 2026-10-10 实测：范句被**逐字照抄**过（输入「算了 不想聊了」时
        // 素世把 styleAnchor 原样背了一遍）。加免责，让它当语气而不是模板。
        (anchorText ? '（下面是语气参照，别原句照搬）' + anchorText + '；' : '')
        + '长短拉开，短的四五个字也行，长的二三十个字也行；'
        + '张嘴就直接接对方说的内容，第一句别去评价对方这句话本身；不要收尾金句'
    );
    // >>> human-shape patch >>>
    // 用户 2026-10-10：「稍微学一学其他人说话」。只借**形状**不借内容（见脚本头注释）。
    const shapeText = typeof humanShapeHint === 'string' ? humanShapeHint.trim() : '';
    if (shapeText) warnings.push(shapeText);
    // <<< human-shape patch <<<
    // <<< style-anchor-config patch <<<
    // >>> sticker-send patch >>>
    // 放在语气/长度锚点**之后**、意图类警告**之前**：
    // 它是"能力说明 + 格式要求"，要看得见，但不该挤掉长度锚点"最后读到"的位置。
    {
        const hintText = typeof stickerHint === 'string' ? stickerHint.trim() : '';
        if (hintText) warnings.push(hintText);
    }
    // <<< sticker-send patch <<<
    // >>> sticker-react patch (managed by patch_sticker_react.py) >>>
    if (intent === 'emoji_reaction') {
        // >>> sticker-default-ignore patch >>>
        // 用户 2026-10-10：表情包一般没特别含义，默认根本不用管，只在被明确问时才解析。
        // >>> bare-sticker patch >>>
        // 用户 2026-10-10：'就当对方没发过一样' 在**空图**时会让她复读上一条
        // （模型 reasoning 原话就引用了这句规则）。拆成两种情况 + 明令禁止复读。
        // 词表会变成模板（实测 anon 7/9 都是「嗯?」）⇒ 只留硬约束，语气交给示例。
        warnings.push('默认不用管表情包，不要提它、不要描述画面、不要念图上的字。'
            + '图里还带了文字就只答那些文字；整条消息只有一张图、没有文字的时候，'
            + '不要重复你上一条说过的话，也不要硬找话题接 —— 随手应一声，或者干脆不回。'
            + '只有对方明确让你看图、或问你图里是什么时才看图');
        // <<< bare-sticker patch <<<
        // <<< sticker-default-ignore patch <<<
    }
    // <<< sticker-react patch <<<
    // >>> builtin-face-split patch >>>
    // QQ 自带表情要说清"它是有意思的"，否则容易像表情包一样被无视/被描述。
    // ⚠ 用肯定式；⛔ 不写"别忽略它"（否定句 = 二次 priming）。
    // ⚠ 不给照样句（本项目规律：给引号例句会被逐字搬用）。
    if (hasBuiltinFaceSegment(event)) {
        const names = getBuiltinFaceNames(event);
        warnings.push('QQ 自带表情是有意思的'
            + `${names.length ? `（这里的是「${names.join('、')}」）` : ''}`
            + ' —— 按它的意思接话就行，不用描述它长什么样。');
    }
    // <<< builtin-face-split patch <<<
    // <<< length-anchor patch <<<
    // >>> participant-roster patch >>>
    // 放在**最后**：这一行是模型产出回复前读到的最后一段 system 文本（杠杆最高）。
    // 触发条件很窄 —— 只有"对方提到的人正好在你联系人名单里"时才出现，没命中不注入。
    if (participantRosterMention) {
        warnings.push(participantRosterMention);
    }
    // <<< participant-roster patch <<<
    // >>> short-answer-hint patch >>>
    // 放在**最末尾**：这是模型产出回复前读到的最后一句 system 文本。
    if (isProbablyShortAnswer(text, routing, event)) {
        warnings.push(SHORT_ANSWER_HINT);
    }
    // <<< short-answer-hint patch <<<
    // >>> code-request-hint patch >>>
    // 紧接着长度锚点之后，把"这次可以长"的例外讲清楚（默认长度约束见 humanShapeHint）
    if (isCodeRequest(text)) {
        warnings.push(CODE_REQUEST_HINT);
    }
    // <<< code-request-hint patch <<<
// >>> send-status patch >>>
    // 放在**最末尾**：这是产出回复前读到的最后一句 system 文本（杠杆最高）。
    // 只在真的失败过、且还没提示过时才有内容 —— 去重在 send-status.js 里做，
    // 不去重会让她对「我发不出去」复读。
    if (sendFailureHint) {
        warnings.push(sendFailureHint);
    }
// <<< send-status patch <<<
    // >>> mood-carry patch >>>
    // 情绪余温：她上一次说的原话 + 隔了多久。放在最末尾（杠杆最高）。
    // 不写「你该是什么情绪」—— 那句话本来带的语气，她自己读到就接得上。
    if (moodHint) {
        warnings.push(moodHint);
    }
    // <<< mood-carry patch <<<
    // >>> numeric-chat-hint patch >>>
    // 放在最后（模型产出回复前读到的最后几句，杠杆最高）。
    if (String(event?.messageType || event?.message_type || '') === 'group'
        && event?.bot?.isAtBot !== true
        && event?.reply?.toBot !== true
        && looksLikeNumbersTalk(text)) {
        warnings.push(NUMERIC_CHAT_HINT);
    }
    // <<< numeric-chat-hint patch <<<
    return warnings;
}

export function buildCurrentMessageFocus(runtimeContext = {}, options = {}) {
    const event = getLatestEvent(runtimeContext) || {};
    const routing = getLatestRouting(runtimeContext) || {};
    const text = normalizeText(event.contentText || event.rawText || runtimeContext.currentUserMessage || '');
    const intent = detectIntent({ event, text });
    const shouldRespond = routing.shouldRespond !== undefined
        ? Boolean(routing.shouldRespond)
        : Boolean(runtimeContext.triggerReason || event.routing?.triggerReason);
    const focus = {
        version: 1,
        eventType: event.eventType || 'message',
        messageType: event.messageType || runtimeContext.messageType || 'group',
        sender: {
            id: cleanText(event.sender?.id),
            name: cleanText(event.sender?.name)
        },
        group: {
            id: cleanText(event.group?.id),
            name: cleanText(event.group?.name)
        },
        intent,
        replyTarget: buildReplyTarget({ event, routing, intent }),
        shouldRespond,
        triggerReason: routing.triggerReason || runtimeContext.triggerReason || '',
        skipReason: routing.skipReason || '',
        isLowInformation: looksLowInformation(text, event),
        isEmojiOnly: hasEmojiSegment(event) && looksLowInformation(text, event),
        isTopicShift: isTopicShift(text),
        shouldReleaseOldTopic: asksReleaseOldTopic(text),
        quote: {
            messageId: cleanText(event.reply?.messageId),
            toBot: event.reply?.toBot === true,
            fetchStatus: cleanText(event.reply?.fetchStatus),
            fetchReason: cleanText(event.reply?.fetchReason),
            quotedText: compactText(event.reply?.quotedText || '', 160)
        },
        latestText: compactText(text, 220),
        segmentTypes: getSegmentTypes(event),
        strategies: buildStrategies({ event, text, intent, routing }),
        warnings: buildWarnings({
            event, text, intent, routing,
            // >>> style-anchor-config patch <<<
            styleAnchor: options.styleAnchor || '',
            // >>> human-shape patch >>>
            humanShapeHint: options.humanShapeHint || '',
            // <<< human-shape patch <<<
            // <<< style-anchor-config patch <<<
            // >>> participant-roster patch >>>
            participantRosterMention: options.participantRosterMention || '',
            // <<< participant-roster patch <<<
            // >>> sticker-send patch >>>
            // 她能**发**表情包了：这里告诉她标记怎么写 + 库里有哪几个类别。
            // 只在库非空时才有内容（空库还教她发就是让她写一个发不出去的标记）。
            stickerHint: options.stickerHint || '',
            // <<< sticker-send patch <<<
// >>> send-status patch >>>
            sendFailureHint: options.sendFailureHint || '',
            // >>> mood-carry patch >>>
            moodHint: options.moodHint || ''
            // <<< mood-carry patch <<<
// <<< send-status patch <<<
        })
    };

    return focus;
}

export function formatCurrentMessageFocus(focus = {}) {
    const lines = [
        '<current-message-focus>',
        `事件: ${focus.eventType || 'message'} / ${focus.messageType || 'group'}`,
        `发言人: ${focus.sender?.name || '未知'}(${focus.sender?.id || 'N/A'})`,
        `意图: ${focus.intent || 'chat'}`,
        `回复目标: ${focus.replyTarget || ''}`,
        `触发: ${focus.shouldRespond ? 'yes' : 'no'}${focus.triggerReason ? ` / ${focus.triggerReason}` : ''}${focus.skipReason ? ` / skip:${focus.skipReason}` : ''}`,
        `低信息: ${focus.isLowInformation ? 'yes' : 'no'} | 表情: ${focus.isEmojiOnly ? 'yes' : 'no'} | 换话题: ${focus.isTopicShift ? 'yes' : 'no'} | 释放旧话题: ${focus.shouldReleaseOldTopic ? 'yes' : 'no'}`
    ];

    if (focus.quote?.messageId) {
        lines.push(`引用: ${focus.quote.toBot ? 'bot' : 'other'} / ${focus.quote.messageId}${focus.quote.quotedText ? ` / ${focus.quote.quotedText}` : ''}`);
    }
    if (focus.latestText) {
        lines.push(`最新输入: ${focus.latestText}`);
    }
    if (Array.isArray(focus.strategies) && focus.strategies.length > 0) {
        lines.push(`策略: ${focus.strategies.join(', ')}`);
    }
    if (Array.isArray(focus.warnings) && focus.warnings.length > 0) {
        lines.push(`注意: ${focus.warnings.join('；')}`);
    }
    lines.push('</current-message-focus>');
    return lines.join('\n');
}
