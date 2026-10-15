/**
 * Verify the reply-decision module. No network: aiClient is mocked.
 *
 * The single most important property is FAIL-OPEN. A decision layer that can silence
 * the bot when its own call breaks is worse than no decision layer at all.
 *
 *   node verify_reply_decision.mjs
 */
const ROOTS = ['C:/Users/20633/MimirLink-soyo', 'C:/Users/20633/MimirLink'];

let failed = 0;
const check = (ok, label, extra = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
    if (!ok) failed++;
};

for (const ROOT of ROOTS) {
    const { decideReply, parseDecision, buildDecisionContext, DEFAULT_DECISION_PROMPT } =
        await import(`file:///${ROOT}/src/reply-decision.js`);
    console.log(`===== ${ROOT.split('/').pop()} =====`);

    check(typeof decideReply === 'function' && typeof parseDecision === 'function',
        'module exports load');
    check(DEFAULT_DECISION_PROMPT.includes('不回'), 'default prompt present');

    // --- parse
    check(parseDecision('YES') === true, 'parse YES');
    check(parseDecision('no') === false, 'parse no (lowercase)');
    check(parseDecision('  NO.  ') === false, 'parse NO. with padding');
    check(parseDecision('回') === true, 'parse 回');
    check(parseDecision('不回') === false, 'parse 不回');
    check(parseDecision('嗯...') === null, 'garbage -> null');

    // --- context builder
    // ⚠ 2026-10-13 修：原来钉死「对方: 你在干嘛」。标签后来改成了 `decisionSpeakerName(raw) || '某人'`
    //   （认得出是谁就写谁的名字，认不出才是「某人」），而且 fixture 里没带结构化头 ⇒ 必然是「某人」。
    //   这条 check 的**本意**是"谁是谁标得出来"（它就叫 context marks who is who），
    //   跟标签具体叫「对方」还是「某人」无关 ⇒ 改成正交断言：
    //     ① 她自己的话必须标成「我」
    //     ② 对方的话**不许**被标成「我」（两者不能混）
    //     ③ 新进来的那条要单独标出来
    const ctx = buildDecisionContext(
        [{ role: 'user', content: '你在干嘛' }, { role: 'assistant', content: '没干嘛' }],
        '素世你来说');
    check(ctx.includes('我: 没干嘛'), 'context：她自己的话标成「我」');
    check(/^.+: 你在干嘛$/m.test(ctx) && !ctx.includes('我: 你在干嘛'),
        'context：对方的话**不**被标成「我」（谁是谁分得开）', JSON.stringify(ctx));
    check(ctx.includes('【刚进来的这条】') && ctx.includes('素世你来说'),
        'context：新进来的那条被显式标出', JSON.stringify(ctx));

    // --- disabled by default
    const off = await decideReply({ config: { chat: {} }, aiClient: {}, plainText: 'hi' });
    check(off.skip === false && off.reason === 'disabled', 'disabled unless explicitly enabled');

    const cfg = (extra = {}) => ({ chat: { replyDecision: { enabled: true, ...extra } } });
    const mock = (raw, throwIt = false) => ({
        chat: async () => {
            if (throwIt) throw new Error('AI_TIMEOUT');
            return { raw };
        },
        getVisibleResponseContent: () => raw
    });

    // ⚠ 2026-10-13 修：下面所有 decideReply 调用都要带 `messageType: 'group'`。
    //   group-reply-gate patch 之后，`scope` 默认 'group' —— 不传 messageType 会在
    //   AI 之前就 `return { skip:false, reason:'scope:group' }`，于是"NO -> skip=true"这类
    //   断言全部拿到 raw=''、报成"决策没生效"，其实只是被判成了非群聊、压根没走到判断。
    const group = { messageType: 'group' };

    const yes = await decideReply({ config: cfg(), aiClient: mock('NO'), plainText: '谁在说话', logger: {}, ...group });
    check(yes.skip === true && yes.reason === 'no', 'NO -> skip=true', JSON.stringify(yes));
    const keep = await decideReply({ config: cfg(), aiClient: mock('YES'), plainText: '谁在说话', logger: {}, ...group });
    check(keep.skip === false && keep.reason === 'yes', 'YES -> skip=false');

    // --- FAIL OPEN, the property that matters most
    const boom = await decideReply({ config: cfg(), aiClient: mock('', true), plainText: '谁在说话', logger: {}, ...group });
    check(boom.skip === false && boom.reason === 'timeout', 'API error -> fail OPEN (reply)', JSON.stringify(boom));
    const weird = await decideReply({ config: cfg(), aiClient: mock('嗯……'), plainText: '谁在说话', logger: {}, ...group });
    check(weird.skip === false && weird.reason === 'unparsed', 'unparseable -> fail OPEN (reply)');
    const shortMsg = await decideReply({ config: cfg({ minChars: 500 }), aiClient: mock('NO'), plainText: '短', logger: {}, ...group });
    check(shortMsg.skip === false, 'below minChars -> no call, reply');

    // --- scope 闸门（group-reply-gate patch）的回归：默认只判群聊
    const priv = await decideReply({
        config: cfg(), aiClient: mock('NO'), plainText: '谁在说话', logger: {},
        messageType: 'private'
    });
    check(priv.skip === false && priv.reason === 'scope:group',
        '默认只判群聊：私聊直接放行（且不调用模型）', JSON.stringify(priv));
    const privAll = await decideReply({
        config: cfg({ scope: 'all' }), aiClient: mock('NO'), plainText: '谁在说话', logger: {},
        messageType: 'private'
    });
    check(privAll.skip === true && privAll.reason === 'no',
        "scope:'all' 时私聊也会被判（NO -> 不回）", JSON.stringify(privAll));
    console.log('');
}

console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
