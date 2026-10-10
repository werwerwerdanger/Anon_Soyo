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

function hasEmojiSegment(event = {}) {
    // >>> image-as-sticker patch (managed by patch_image_as_sticker.py) >>>
    // QQ 的表情包/动画表情在 OneBot 里是 image 段（summary: [动画表情]），
    // 不是 face/mface/marketface。只认后三个会让「收图」这条路径完全不生效：
    // emoji_reaction 意图不触发 ⇒ 对应策略和警告都不会出现（2026-10-10 实测踩到）。
    return getSegmentTypes(event).some((type) =>
        ['face', 'mface', 'marketface', 'image'].includes(type));
    // <<< image-as-sticker patch <<<
}

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

function buildWarnings({ event, text, intent, routing, styleAnchor = '', humanShapeHint = '' }) {
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
    // <<< length-anchor patch <<<
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
            humanShapeHint: options.humanShapeHint || ''
            // <<< human-shape patch <<<
            // <<< style-anchor-config patch <<<
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
