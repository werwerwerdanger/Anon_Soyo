/**
 * Reply-decision layer: before the expensive two-call reply path runs, ask the model
 * a single question -- should this character answer this message at all?
 *
 * WHY (user, 2026-10-09): "对每个进大模型的话先决定要不要回复再回复", and for the two
 * bots "他们两个一个被骂的时候另一个最好有点反应". Chosen design: B -- the model judges
 * tone, because "is this a scolding / should I step in" is not something a keyword list
 * can decide (same lesson as 素食: mechanical matching cannot read context).
 *
 * COST: this is a third LLM call (+1), but it is tiny (short prompt, ~4 tokens out) and
 * a NO verdict SKIPS the two big calls that follow. Net saving in a busy group.
 *
 * SAFETY: fails OPEN. If the call errors, times out, or returns something unparseable,
 * we return { skip: false } -- i.e. behave exactly like today. A decision layer must
 * never be the reason a reply silently disappears.
 */
export const DEFAULT_DECISION_PROMPT = `你在替一个群里的角色决定：**这一轮我该不该开口**。

只输出一个词，不要解释、不要标点：
YES = 回
NO  = 不回

默认是 NO。宁可少说一句，也不要为了刷存在感硬接一句。
只有下面这些才回 YES：
- 有人直接点了你的名字、@ 了你、或者直接问你 —— **这一条最优先**：只要这条成立就回 YES，
  哪怕这件事你刚才已经答过、哪怕那句话很短、哪怕你觉得自己没什么新话可说；
- 有人在跟你说话，是接着你上一条在说；
- 话题就是你 —— 在议论你、夸你、损你、拿你开玩笑；
- 你被挑衅、被骂，或者你该替谁出面（有人被欺负了）。

出现下面任何一条就回 NO：
- **这一轮要收尾了**：对方在收（好 / 行 / 就这样 / 睡了 / 晚安 / 明天见 / 嗯 / 哦 / ？），
  或者上一句已经把话说完，或者同一件事你上一条已经回应过；
- **话题已经换了**：现在聊的事、聊的人跟刚才不是一拨，或者明显没你什么事。
  只要你感觉话题从你身上移开了，就立刻回 NO —— 不要接一句来留住这个话头；
- 是别人之间的对话，只是碰巧提到了某个词；
- 纯表情包 / 贴图 / 复读 / 刷屏 / 广告 / 系统消息 / 机器人自己的输出 / 跟你无关的技术问答；
- 极短、没有信息量、像打错字或随手试探（单个字、哦、？、aa、1）。

拿不准就回 NO。`;

export const DEFAULT_PRIVATE_DECISION_PROMPT = `你在私聊里替一个角色决定：这一条消息，值不值得回。

只输出一个词，不要解释，不要标点：
YES = 回
NO  = 不回

私聊里你们是熟人，大部分话都该回。只有这几种「这一轮没什么可接的」才回 NO：
- 对方只是在收尾（晚安、睡了、明天见、先这样、我走了），把话关掉；
- 对方发的是纯表情或贴图，没有文字要接；
- 对方明显在自言自语、刷屏、连发同一类东西；
- 你上一条已经说过要去睡了或要走了，对方只是随手再补一句；
- 极短、没有信息量、像打错字或随手试探（单字、哦、？、aa、1、在吗）。

其余都回 YES：对方在问你、跟你说话、补充或纠正刚才的话题、吐槽、调侃你，
或者话题跟你有关。拿不准就回 YES。`;

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 把最近几条消息压成一段短文本，够模型判断语气即可。 */
const DECISION_HEADER_RE = /\[(群聊|私聊)\|QQ:([^|\]]*)\|昵称:([^|\]]*)\|/;

/** 剥掉结构化消息头 / JSON 段。头里嵌了 messageSegments:[{...}]，所以要反复剥最内层。 */
export function stripStructuredHeader(raw) {
    let s = text(raw);
    let prev = null;
    let rounds = 0;
    while (prev !== s && rounds < 20) {
        prev = s;
        s = s.replace(/\[[^\[\]]*\]/g, ' ').replace(/\{[^{}]*\}/g, ' ');
        rounds += 1;
    }
    return s.replace(/\s+/g, ' ').trim();
}

/** 从结构化头里取发言人昵称（群里有好几个人，判定时必须分得清谁在说）。 */
function decisionSpeakerName(raw) {
    const m = DECISION_HEADER_RE.exec(text(raw));
    return m ? text(m[3]) : '';
}

function decisionContentText(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
        return value.filter((p) => p?.type === 'text').map((p) => p.text).join(' ');
    }
    return '';
}

/**
 * 把最近的对话压成一段短文本。
 * 「这一轮结束了没 / 换话题了没」是**序列判断** —— 没有历史就只能瞎猜，
 * 所以这里必须带上下文，并且标出说话人。
 */
// >>> decision-at-marker patch >>>
/**
 * 这一条有没有直接 @ 到 bot。
 *
 * ⚠ 必须在 `stripStructuredHeader` **之前**判 —— 它会把 `[...]` 整段删掉，
 * 而 @ 的标记有两种写法，**两种都会被吃掉**：
 *   - 结构化头里的 `isAtBot:true`
 *   - 正文前的 `[@bot]`（standard-event 的 readableText）
 * 2026-10-11 实测事故：有人 @ 了爱音问一句话，决策层看到的只有
 * `【刚进来的这条】werwer: 你觉得…怎么样`，**完全不知道被 @ 了**，
 * 于是按提示词里那句「默认是 NO」判了 NO —— 被直接点名却不回。
 * @ 是显式召唤，所以这个标记必须活到决策层看见。
 */
export function detectAtBot(raw) {
    const s = text(raw);
    if (!s) return false;
    if (/isAtBot\s*:\s*true/i.test(s)) return true;
    if (/\[@bot\]/.test(s)) return true;
    // ⚠ 刻意**不认** `[CQ:at,qq=123]`：这里拿不到 bot 自己的 QQ，
    //   认了就等于"群里 @ 谁都算 @ 了我"（会让她对每条 @别人的消息都插嘴）。
    //   上面两个标记都是本 pipeline 权威产出的：
    //   `isAtBot` 由 buildStructuredMessage 算，`[@bot]` 由 standard-event
    //   在 `segment.isBot || qq === botSelfId` 时才写。
    return false;
}
// <<< decision-at-marker patch <<<

export function buildDecisionContext(recentMessages = [], plainText = '', limit = 10) {
    const lines = [];
    const list = Array.isArray(recentMessages) ? recentMessages : [];
    for (const message of list.slice(-limit)) {
        const raw = text(decisionContentText(message?.content));
        if (!raw) continue;
        const atMe = detectAtBot(raw) ? '（@了我）' : '';
        const body = stripStructuredHeader(raw).slice(0, 160);
        // 纯 @ 没文字的也要留一行 —— 那也是"在叫你"
        if (!body && !atMe) continue;
        if (message?.role === 'assistant') {
            lines.push(`我: ${body}`);
        } else {
            lines.push(`${decisionSpeakerName(raw) || '某人'}${atMe}: ${body || '（只有 @，没有文字）'}`);
        }
    }
    const nowRaw = text(plainText);
    const nowAtMe = detectAtBot(nowRaw) ? '（@了我）' : '';
    const now = stripStructuredHeader(nowRaw).slice(0, 300);
    if (now || nowAtMe) {
        lines.push(`【刚进来的这条】${decisionSpeakerName(nowRaw) || '某人'}${nowAtMe}: `
            + `${now || '（只有 @，没有文字）'}`);
    }
    return lines.join('\n');
}

export function parseDecision(raw) {
    const s = text(raw).toUpperCase();
    if (!s) return null;
    if (/\bNO\b/.test(s)) return false;
    if (/\bYES\b/.test(s)) return true;
    if (s.startsWith('回')) return true;
    if (s.startsWith('不回')) return false;
    return null;
}

/**
 * @returns {Promise<{skip: boolean, reason: string, raw: string}>}
 *   skip === true  -> do not send a reply this turn
 *   anything unexpected -> { skip: false } (fail open)
 */
export async function decideReply({ config = {}, aiClient, logger = console, recentMessages = [], plainText = '', speaker = '', messageType = '' } = {}) {
    const cfg = config.chat?.replyDecision || {};
    if (cfg.enabled !== true) return { skip: false, reason: 'disabled', raw: '' };

    // >>> group-reply-gate patch (managed by patch_group_reply_gate.py) >>>
    // scope: 'group'（默认）只判群聊，私聊不碰；'all' 连私聊一起判。
    const decisionScope = String(cfg.scope || 'group').toLowerCase();
    if (decisionScope !== 'all' && String(messageType) !== 'group') {
        return { skip: false, reason: 'scope:' + decisionScope, raw: '' };
    }
    // <<< group-reply-gate patch <<<
    if (!aiClient || typeof aiClient.chat !== 'function') {
        return { skip: false, reason: 'no-ai-client', raw: '' };
    }
    const minChars = clampInt(cfg.minChars, 0, 10000, 0);
    if (text(plainText).length < minChars) {
        return { skip: false, reason: 'too-short-to-judge', raw: '' };
    }

// >>> decision-private patch (managed by patch_decision_private.py) >>>
    // 私聊与群聊的判据不同：群聊要判断「这条闲话点没点到我」，
    // 私聊要判断「这一句还有没有可接的」。默认改判据，promptPrivate 可覆盖。
    const isPrivateChat = String(messageType) === 'private';
    const judgePrompt = isPrivateChat
        ? (text(cfg.promptPrivate) || DEFAULT_PRIVATE_DECISION_PROMPT)
        : (text(cfg.prompt) || DEFAULT_DECISION_PROMPT);
// <<< decision-private patch <<<
// >>> group-reply-gate patch (managed by patch_group_reply_gate.py) >>>
    const prompt = `${judgePrompt}\n\n【前面的对话（越靠下越新）】\n`
        + `${buildDecisionContext(recentMessages, plainText)}\n`
        + `${speaker ? `\n【正在说话的人】${speaker}` : ''}`;
    // <<< group-reply-gate patch <<<
// >>> group-reply-gate patch (managed by patch_group_reply_gate.py) >>>
    const overrides = {
        maxTokens: clampInt(cfg.maxTokens, 1, 64, 4),
        temperature: 0,
        allowModelFallback: false,
        // 🔴 必须关掉思维链：4 个 token 一旦被推理吃掉就拿不到 YES/NO，
        //    parseDecision 返回 null ⇒ 走「失败放行」⇒ 闸门**静默失效**。
        thinking: { type: 'disabled' }
    };
    // <<< group-reply-gate patch <<<

    try {
        // >>> decision-timeout patch (managed by patch_group_reply_gate.py) >>>
        // 决策调用在 index.js 里**没有**被 callWithTimeout 包住（实测 src/ai.js 里
        // 根本没用到 config.ai.timeout）⇒ 请求一挂就拖住整轮回复，fail-open 也来不及生效。
        // 自己加一道上限，超时抛 AI_TIMEOUT，走下面的 catch ⇒ 按「回」处理。
        const decisionTimeoutMs = clampInt(cfg.timeoutMs, 500, 60000, 8000);
        const result = await Promise.race([
            aiClient.chat([{ role: 'user', content: prompt }], overrides),
            new Promise((_, reject) => setTimeout(
                () => reject(new Error('AI_TIMEOUT')), decisionTimeoutMs))
        ]);
        // <<< decision-timeout patch <<<
        const raw = text(aiClient.getVisibleResponseContent(result));
        const verdict = parseDecision(raw);
        const atBot = detectAtBot(plainText);
        // 🔴 把"这条 @ 了我没有"打进日志：这次事故从日志上完全看不出来
        //    （只看到 raw=NO，看不出它根本不知道被 @ 了）。
        logger.info?.('[决策] 裁决', {
            messageType: isPrivateChat ? 'private' : 'group',
            raw,
            atBot,
            preview: stripStructuredHeader(plainText).slice(0, 60)
        });
        if (verdict === null) {
            logger.warn?.(`[决策] 无法解析，按"回"处理: ${JSON.stringify(raw.slice(0, 40))}`);
            return { skip: false, reason: 'unparsed', raw, atBot };
        }
        return { skip: verdict === false, reason: verdict ? 'yes' : 'no', raw, atBot };
    } catch (error) {
        // 失败一律放行 —— 决策层绝不能成为"回复凭空消失"的原因
        const reason = String(error?.message || '') === 'AI_TIMEOUT' ? 'timeout' : 'error';
        logger.warn?.(`[决策] 判定失败(${reason})，按"回"处理: ${error?.message || error}`);
        return { skip: false, reason, raw: '' };
    }
}
