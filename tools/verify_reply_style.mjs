/**
 * Verify patch_reply_style.py by driving the REAL dispatchReply() with a mock bot
 * and inspecting exactly what would have been sent.
 *
 *   node verify_reply_style.mjs            # soyo instance
 *   node verify_reply_style.mjs MimirLink  # anon instance
 *
 * Cases:
 *   1. short reply, one line, contains 。  -> 2 plain private messages, no quote
 *   2. reply with 8 lines                  -> quote IS used (long enough to deserve it)
 *   3. short group reply                   -> plain group message carrying the @, no reply segment
 *   4. reverted behaviour check (minLines 0) -> quote is used even for short replies
 */
const INSTANCE = process.argv[2] || 'MimirLink-soyo';
const ROOT = `C:/Users/20633/${INSTANCE}`;

const { dispatchReply } = await import(`file:///${ROOT}/src/reply-dispatcher.js`);

function makeBot(sent) {
    return {
        async sendPrivateMessage(userId, message) {
            sent.push({ kind: 'private', userId, message, quoted: false });
        },
        async sendPrivateReply(userId, messageId, message) {
            sent.push({ kind: 'private', userId, messageId, message, quoted: true });
        },
        async sendGroupMessage(groupId, payload) {
            sent.push({ kind: 'group', groupId, payload, quoted: false });
        },
        async sendGroupReply(groupId, messageId, message) {
            sent.push({ kind: 'group', groupId, messageId, message, quoted: true });
        }
    };
}

function baseConfig(overrides = {}) {
    return {
        chat: {
            splitMessage: true,
            segmentDelayMs: 0,
            proactiveMessageIntervalMs: 0,
            quoteReplyEnabled: true,
            mentionSenderOnReply: true,
            splitOnPeriod: true,
            quoteReplyMinLines: 6,
            ...overrides
        }
    };
}

const noTts = { getConfig: () => ({ enabled: false }), synthesize: async () => '' };
const noSleep = async () => {};

async function run(label, { reply, event, chatOverrides = {} }) {
    const sent = [];
    await dispatchReply(event, reply, {}, {
        config: baseConfig(chatOverrides),
        bot: makeBot(sent),
        ttsManager: noTts,
        logger: { info() {}, warn() {}, debug() {}, error() {} },
        recordDashboardMetric: () => {},
        sleep: noSleep
    });
    console.log(`--- ${label} ---`);
    console.log(`    input lines: ${reply.split('\n').filter((l) => l.trim()).length}`);
    sent.forEach((s, i) => {
        if (s.kind === 'private') {
            console.log(`    [${i}] private quoted=${s.quoted}  "${s.message}"`);
        } else if (typeof s.payload === 'string') {
            console.log(`    [${i}] group  quoted=${s.quoted}  "${s.payload}"`);
        } else {
            const kinds = s.payload.map((x) => x.type).join('+');
            const text = s.payload.find((x) => x.type === 'text')?.data?.text ?? '';
            console.log(`    [${i}] group  segments=[${kinds}] quoted=${s.quoted}  "${text}"`);
        }
    });
    console.log('');
    return sent;
}

const privateEvent = { message_type: 'private', user_id: '20633', message_id: 'MID-1' };
const groupEvent = { message_type: 'group', group_id: '929159193', user_id: '20633', message_id: 'MID-2' };

let failed = 0;
const check = (label, ok) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
    if (!ok) failed += 1;
};

// 1. 短消息：句号处拆成两条，且不引用
const s1 = await run('1. 短回复（单行，含句号）— 私聊', {
    reply: '月之森二年级，MyGO!!!!! 的贝斯手。你是真的忘了，还是压根没在看？',
    event: privateEvent
});
check('拆成 2 条', s1.length === 2);
check('第一条不含句号', s1[0]?.message === '月之森二年级，MyGO!!!!! 的贝斯手');
check('第二条保留问号', s1[1]?.message === '你是真的忘了，还是压根没在看？');
check('两条都不引用', s1.every((s) => s.quoted === false));

// 2. 长消息（8 行）仍然引用
const longReply = Array.from({ length: 8 }, (_, i) => `第${i + 1}行内容`).join('\n');
const s2 = await run('2. 长回复（8 行）— 私聊', { reply: longReply, event: privateEvent });
check('8 行 => 第一条使用引用回复', s2[0]?.quoted === true);
check('8 行 => 后面 7 条都不再挂引用（只回复第一句）', s2.slice(1).every((s) => s.quoted === false));
check('8 行 => 8 条', s2.length === 8);

// 3. 群聊短消息：不引用，但仍然 @
const s3 = await run('3. 短回复 — 群聊', {
    reply: '嗯，我知道了。然后呢？',
    event: groupEvent
});
check('群聊短消息不引用', s3.every((s) => s.quoted === false));
check('群聊仍然 @ 了发送者', typeof s3[0]?.payload === 'string' && s3[0].payload.startsWith('[CQ:at,qq=20633]'));
check('群聊拆成 2 条', s3.length === 2);

// 4. quoteReplyMinLines=0 应还原旧行为
const s4 = await run('4. quoteReplyMinLines=0（旧行为）— 私聊', {
    reply: '好。',
    event: privateEvent,
    chatOverrides: { quoteReplyMinLines: 0 }
});
check('minLines=0 => 永远引用（旧行为可还原）', s4[0]?.quoted === true);

// 5. 正式场合：splitOnPeriod=false 时句号保留
const s5 = await run('5. splitOnPeriod=false — 私聊', {
    reply: '第一句话。第二句话。',
    event: privateEvent,
    chatOverrides: { splitOnPeriod: false }
});
check('关闭句号拆分 => 保持一条且句号留存', s5.length === 1 && s5[0].message === '第一句话。第二句话。');

console.log('='.repeat(60));
console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
