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
    const ctx = buildDecisionContext(
        [{ role: 'user', content: '你在干嘛' }, { role: 'assistant', content: '没干嘛' }],
        '素世你来说');
    check(ctx.includes('对方: 你在干嘛') && ctx.includes('我: 没干嘛') && ctx.includes('素世你来说'),
        'context marks who is who', JSON.stringify(ctx.slice(0, 40)));

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

    const yes = await decideReply({ config: cfg(), aiClient: mock('NO'), plainText: '谁在说话', logger: {} });
    check(yes.skip === true && yes.reason === 'no', 'NO -> skip=true', JSON.stringify(yes));
    const keep = await decideReply({ config: cfg(), aiClient: mock('YES'), plainText: '谁在说话', logger: {} });
    check(keep.skip === false && keep.reason === 'yes', 'YES -> skip=false');

    // --- FAIL OPEN, the property that matters most
    const boom = await decideReply({ config: cfg(), aiClient: mock('', true), plainText: '谁在说话', logger: {} });
    check(boom.skip === false && boom.reason === 'timeout', 'API error -> fail OPEN (reply)', JSON.stringify(boom));
    const weird = await decideReply({ config: cfg(), aiClient: mock('嗯……'), plainText: '谁在说话', logger: {} });
    check(weird.skip === false && weird.reason === 'unparsed', 'unparseable -> fail OPEN (reply)');
    const shortMsg = await decideReply({ config: cfg({ minChars: 500 }), aiClient: mock('NO'), plainText: '短', logger: {} });
    check(shortMsg.skip === false, 'below minChars -> no call, reply');
    console.log('');
}

console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
