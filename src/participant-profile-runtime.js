export function getParticipantProfileTimerKey(namespaceOptions, speakerIdentity) {
    return [
        speakerIdentity?.participantId || '',
        namespaceOptions?.scopeType || '',
        namespaceOptions?.scopeKey || '',
        namespaceOptions?.characterName || '',
        namespaceOptions?.presetName || ''
    ].join('|');
}

export function buildParticipantProfileTaskMeta(namespaceOptions, speakerIdentity) {
    return {
        taskKey: getParticipantProfileTimerKey(namespaceOptions, speakerIdentity),
        participantId: String(speakerIdentity?.participantId || ''),
        participantName: speakerIdentity?.participantName || String(speakerIdentity?.participantId || ''),
        scopeType: namespaceOptions?.scopeType || null,
        scopeKey: namespaceOptions?.scopeKey || null,
        characterName: namespaceOptions?.characterName || null,
        presetName: namespaceOptions?.presetName || null
    };
}

export function trackParticipantProfileTarget(targets, namespaceOptions, speakerIdentity) {
    if (!speakerIdentity?.participantId) {
        return null;
    }

    const timerKey = getParticipantProfileTimerKey(namespaceOptions, speakerIdentity);
    targets.set(timerKey, {
        namespaceOptions: { ...namespaceOptions },
        speakerIdentity: { ...speakerIdentity }
    });
    return timerKey;
}

export function shouldUseIdleParticipantProfileTrigger(participantProfileConfig) {
    return participantProfileConfig.triggerMode === 'idle' || participantProfileConfig.triggerMode === 'both';
}

export function shouldUseIntervalParticipantProfileTrigger(participantProfileConfig) {
    return participantProfileConfig.triggerMode === 'interval' || participantProfileConfig.triggerMode === 'both';
}

export function resolveParticipantProfilePromptSpeakerLabel(item = {}, speakerIdentity = null) {
    const speakerType = String(item?.speakerType || '').trim().toLowerCase();
    const speakerId = String(item?.speakerId || item?.metadata?.userId || '').trim();
    const speakerName = String(item?.speakerName || item?.metadata?.participantName || '').trim();
    const targetId = String(speakerIdentity?.participantId || '').trim();
    const targetName = String(speakerIdentity?.participantName || targetId || '目标人物').trim();

    if (speakerType === 'target' || (targetId && speakerId && speakerId === targetId)) {
        return `目标人物|${speakerName || targetName}${speakerId ? `|QQ:${speakerId}` : ''}`;
    }
    if (speakerType === 'bot' || String(item?.role || '').toLowerCase() === 'assistant') {
        return 'Bot';
    }
    if (speakerType === 'third_party') {
        return `第三者|${speakerName || '群友'}${speakerId ? `|QQ:${speakerId}` : ''}`;
    }
    if (String(item?.role || '').toLowerCase() === 'user') {
        return `其他用户|${speakerName || speakerId || '未知'}${speakerId ? `|QQ:${speakerId}` : ''}`;
    }
    return `未知说话人|${speakerName || speakerId || item?.role || 'unknown'}`;
}

export function formatParticipantProfilePromptMessage(item = {}, speakerIdentity = null) {
    const sessionId = item?.sessionId || '-';
    const speakerLabel = resolveParticipantProfilePromptSpeakerLabel(item, speakerIdentity);
    const ownContent = String(item?.content || '').trim() || '（空）';
    const lines = [`[${sessionId}] [说话人:${speakerLabel}] ${ownContent}`];

    const quotes = Array.isArray(item?.quotes) && item.quotes.length > 0
        ? item.quotes
        : (item?.quote ? [item.quote] : []);
    for (const quote of quotes) {
        const quoteName = String(quote?.speakerName || '').trim();
        const quoteId = String(quote?.speakerId || '').trim();
        const quoteContent = String(quote?.content || '').trim();
        if (!quoteContent) {
            continue;
        }
        const who = [quoteName || '被引用者', quoteId ? `QQ:${quoteId}` : ''].filter(Boolean).join('|');
        lines.push(`  引用原文(仅背景，不是本人发言，来自:${who}): ${quoteContent}`);
    }

    return lines.join('\n');
}

export function buildParticipantProfilePrompt(source = {}, analysisMode, speakerIdentity = null) {
    const targetId = String(
        speakerIdentity?.participantId
        || source?.participantId
        || source?.targetParticipantId
        || source?.existing?.participantId
        || source?.existing?.metadata?.participantId
        || ''
    ).trim();
    const targetName = String(
        speakerIdentity?.participantName
        || source?.participantName
        || source?.targetParticipantName
        || source?.existing?.participantName
        || source?.existing?.metadata?.participantName
        || targetId
        || '目标人物'
    ).trim();

    const identity = {
        participantId: targetId,
        participantName: targetName
    };

    // 2026-10-22：【当前状态】原来没有任何时间锚点 —— 一段"最近如何"被当成永久定性，
    // 正好踩中"episodic 被压成 semantic"那个坑。这里把今天日期喂给模型，并要求逐条标时间。
    const nowDate = new Date();
    const todayStamp = `${nowDate.getMonth() + 1}月${nowDate.getDate()}日`;

    const messages = Array.isArray(source?.messages) ? source.messages : [];
    const messageText = messages.length > 0
        ? messages.map((item) => formatParticipantProfilePromptMessage(item, identity)).join('\n')
        : '（无新增消息）';

    const isBotOnly = analysisMode === 'bot_only_messages' || analysisMode === 'bot_only_profile';
    const isMessagesOnly = analysisMode === 'messages_only' || analysisMode === 'bot_only_messages';

    const rules = [
        '归因硬约束：',
        `1. 档案只描述目标人物：${targetName}${targetId ? `（QQ:${targetId}）` : ''}。`,
        '2. 必须把说话人掰开：目标人物 / Bot / 第三者；不得把 Bot 或第三者的话写成目标人物说的。',
        '3. 标记为“引用原文”的内容只作背景，不可记为目标人物观点、口头禅、性格或行为。',
        '4. 目标人物的稳定画像与当前状态，只能依据“说话人=目标人物”的本人发言归纳。',
        '5. Bot 与第三者内容可以用于理解语境，但禁止写入成目标人物自己的表达。',
        '6. 不要臆测未出现的信息；冲突时宁可写不确定或省略。',
        // >>> profile-no-selfref patch >>>
        '7. 档案写的是“这个人是什么样”，不是“我们聊过什么”：对方问过哪些问题、问了几次，以及 Bot 回答了什么、用什么态度，都不属于档案内容。',
        '8. 档案里不得出现 Bot 的发言、措辞、口吻或态度，也不要记录对话发生的次数；只保留目标人物自己的稳定特征与当前状态。',
        // <<< profile-no-selfref patch <<<
// >>> profile-quote-scrub patch >>>
        // 引号引语会变成台词本：实测她照着画像里的原话念，还念出了半句没听见的话。
        '9. 档案只描述这个人的样子，不要抄录他的原话：原话一旦带引号写进档案，就会被原样当成台词念出来。要写就转述成场合、语气和情绪，不要保留任何引文或例句。',
        '10. 输出里不要出现引号引语。',
        // >>> profile-no-prescription patch >>>
        // 2026-10-31：实测档案里长出「需要反复安抚」「倾向把对方的限制理解为针对自己」这类句子。
        // 它们读起来是"分析用户"，实际对读者（角色）是一份**处置处方**：
        // 她看到"需要反复安抚"就会主动哄，看到"倾向把限制理解为针对"就提前退让，
        // 于是自我实现：她哄 → 他更像需要哄 → 下次继续写"需要反复安抚"。
        // 档案只回答"这个人是什么样"，不回答"该怎么对待他"。
        '11. 只写能观察到的行为：他说了什么、怎么说的、在什么场合。不要写需求或心理推断 —— 「需要被安抚」「需要反复解释」「倾向把…理解为…」「缺乏安全感」「渴望被关注」这类判断不写。',
        '12. 不写处置建议或应对方式（「需要哄」「要慢慢引导」「别跟他硬顶」之类），也不写"他期待你如何反应"。',
        // <<< profile-no-prescription patch >>>
// <<< profile-quote-scrub patch <<<
    ].join('\n');

    const scopeHint = isBotOnly
        ? '范围说明：以下优先包含目标人物与 Bot 的交互上下文；其中 Bot 发言仅作背景，不是目标人物本人发言。\n'
        : '范围说明：以下包含目标人物锚点附近的对话上下文，请按说话人标签拆开理解。\n';

    const header = [
        `请基于以下真实聊天内容${isMessagesOnly ? '更新' : '增量更新'}人物档案。`,
        `目标人物：${targetName}${targetId ? `（QQ:${targetId}）` : ''}`,
        rules,
        scopeHint.trim()
    ].join('\n');

    if (isMessagesOnly) {
        return [
            header,
            '',
            '仅允许依据这些新增消息总结，不要臆测未出现的信息。',
            '新增消息如下：',
            messageText,
            '',
            '输出格式：',
            '稳定画像: ...',
            `当前状态: ...（今天是 ${todayStamp}。这一段的每一条都带上时间：哪一天、什么时段。）`
        ].join('\n');
    }

    const priorProfile = String(source?.existing?.content || '').trim() || '无';
    return [
        header,
        '',
        '已有档案如下：',
        priorProfile,
        '',
        '新增消息如下：',
        messageText,
        '',
        '输出格式：',
        '稳定画像: ...',
        `当前状态: ...（今天是 ${todayStamp}。这一段的每一条都带上时间：哪一天、什么时段。）`
    ].join('\n');
}


export function buildParticipantProfileMergePrompt({ participantId = '', participantName = '', oldProfile = '', newProfile = '' } = {}) {
    return [
        '请合并同一个 QQ 用户的人物档案。',
        `QQ：${participantId || '-'}`,
        `当前昵称：${participantName || participantId || '-'}`,
        '',
        '要求：',
        '1. 只保留一个最终档案，不要输出两个版本，也不要解释合并过程。',
        '2. 以新版本中的最新状态为准，但不要丢掉旧档案里仍稳定、未被新版本推翻的信息。',
        '3. 删除重复、冲突、空泛和模型自述内容；冲突处按“新版本 > 旧档案”，无法判断时写成不确定或省略。',
        '4. 不要编造聊天记录中没有出现的信息。',
        '5. 输出纯文本人物档案，建议包含“稳定画像”和“当前状态”两段。',
        // >>> profile-no-selfref patch >>>
        '6. 旧档案里若混进了 Bot 的发言、Bot 的措辞口吻，或对话来往过程与问答次数的记录，直接删掉，不要保留。',
        '7. “当前状态”只保留最近仍然成立的少量条目，不要无限追加历史事件；每一条都要带时间（哪一天、什么时段）。',
        // <<< profile-no-selfref patch <<<
// >>> profile-quote-scrub patch >>>
        '8. 新版本里若带引号的原话，一律改写成转述，不要保留引文。',
// <<< profile-quote-scrub patch <<<
        '',
        '旧档案：',
        String(oldProfile || '').trim() || '无',
        '',
        '新版本：',
        String(newProfile || '').trim() || '无'
    ].join('\n');
}

export function buildParticipantProfileAIOverrides(participantProfileConfig) {
    const overrides = {};
    if (participantProfileConfig.model) {
        overrides.model = participantProfileConfig.model;
    }
    if (participantProfileConfig.baseUrl) {
        overrides.baseUrl = participantProfileConfig.baseUrl;
    }
    if (participantProfileConfig.apiKey) {
        overrides.apiKey = participantProfileConfig.apiKey;
    }
    return overrides;
}
