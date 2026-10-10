/**
 * verify_group_reply_gate.mjs -- 断言群聊回复闸门真的按「保守 + 看得到历史」在跑
 *
 * 做法：
 *   · 直接 import 各实例部署的 src/reply-decision.js（测真代码，不是复刻）
 *   · aiClient 用桩，捕获它**实际收到**的 prompt 与 overrides（不打真实 API）
 *
 *   node verify_group_reply_gate.mjs
 */
import fs from 'node:fs';

let pass = 0;
let fail = 0;
const ok = (cond, label, extra) => {
    if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
    else { fail += 1; console.log(`  FAIL  ${label}${extra ? '  <- ' + extra : ''}`); }
};

/** 按日志里的真实格式造一条带结构化头的群消息 */
const header = (qq, nick, body) =>
    `[群聊|QQ:${qq}|昵称:${nick}|群号:929159193|群名:2026程序设计协会|时间:2026/10/10 14:12:51`
    + `|eventType:message|isAtBot:false|messageSegments:[{"type":"text","text":"${body}"}]] ${body}`;

function makeStub(verdict, opts = {}) {
    const seen = {};
    return {
        seen,
        async chat(messages, overrides) {
            seen.prompt = messages?.[0]?.content || '';
            seen.overrides = overrides;
            if (opts.throwError) throw new Error(opts.throwError);
            return { choices: [{ message: { content: verdict } }] };
        },
        getVisibleResponseContent(result) {
            return result?.choices?.[0]?.message?.content || '';
        }
    };
}
const quietLogger = { info() {}, warn() {}, debug() {}, error() {} };

const HISTORY = [
    { role: 'user', content: header('2063362809', 'werwer', '你记得我刚刚和你的私聊内容吗') },
    { role: 'assistant', content: '……我们好像没私聊过吧\n是不是认错人了' },
    { role: 'user', content: header('2458713318', 'chihaya_anon', '诶 无视我?') },
    { role: 'assistant', content: '没无视你\n……刚在回别人的话' },
];
const CURRENT = header('2063362809', 'werwer', '嗯 行吧');
const GROUP_EV = { message_type: 'group', group_id: '929159193', user_id: '2063362809' };

for (const [inst, label] of [['MimirLink-soyo', 'soyo'], ['MimirLink', 'anon']]) {
    const ROOT = `C:/Users/20633/${inst}`;
    const config = JSON.parse(fs.readFileSync(`${ROOT}/config.json`, 'utf8'));
    const modUrl = 'file:///' + `${ROOT}/src/reply-decision.js`.replace(/\\/g, '/');

    console.log(`\n########## ${inst} (${label}) ##########`);
    let mod;
    try {
        mod = await import(modUrl);
    } catch (e) {
        ok(false, '0 模块可 import', e.message);
        continue;
    }
    const { decideReply, parseDecision, buildDecisionContext, stripStructuredHeader } = mod;
    ok(typeof decideReply === 'function' && typeof buildDecisionContext === 'function',
        '0 模块导出齐备');

    // ---------------- 1. 结构化头剥离
    const stripped = stripStructuredHeader(CURRENT);
    ok(!stripped.includes('群聊|QQ:'), '1a 头被剥掉');
    ok(!stripped.includes('messageSegments'), '1b JSON 段被剥掉');
    ok(stripped.includes('嗯 行吧'), '1c 正文保留', stripped.slice(0, 40));

    // ---------------- 2. 判定上下文：必须看得到历史 + 分得清谁在说
    const ctx = buildDecisionContext(HISTORY, CURRENT, 10);
    ok(ctx.includes('我: '), '2a 机器人自己的发言标成「我」');
    ok(ctx.includes('werwer: ') && ctx.includes('chihaya_anon: '), '2b 群友按昵称区分');
    ok(!ctx.includes('群聊|QQ:'), '2c 上下文里没有结构化头');
    ok(ctx.includes('【刚进来的这条】'), '2d 当前这条被单独标出');
    ok(ctx.includes('没无视你'), '2e 真的带上了历史内容');
    const ctx1 = buildDecisionContext(HISTORY, CURRENT, 2);
    ok(ctx1.split('\n').length <= 3, '2f limit 生效', `${ctx1.split('\n').length} 行`);

    // ---------------- 3. scope：默认只判群聊
    const cfgGroup = JSON.parse(JSON.stringify(config));
    const stubPriv = makeStub('NO');
    const privRes = await decideReply({
        config: cfgGroup, aiClient: stubPriv, logger: quietLogger,
        recentMessages: HISTORY, plainText: CURRENT, speaker: 'werwer', messageType: 'private',
    });
    ok(privRes.skip === false && String(privRes.reason).startsWith('scope'),
        '3a 默认 scope=group ⇒ 私聊不判', `skip=${privRes.skip} reason=${privRes.reason}`);
    ok(!stubPriv.seen.prompt, '3b 私聊时根本没发判定请求');

    const cfgAll = JSON.parse(JSON.stringify(config));
    cfgAll.chat.replyDecision.scope = 'all';
    const stubAll = makeStub('NO');
    const allRes = await decideReply({
        config: cfgAll, aiClient: stubAll, logger: quietLogger,
        recentMessages: HISTORY, plainText: CURRENT, speaker: 'werwer', messageType: 'private',
    });
    ok(allRes.skip === true && stubAll.seen.prompt, '3c scope=all 时私聊也判');

    // ---------------- 4. 判定提示词内容（保守口径必须真的在里面）
    const stub = makeStub('NO');
    const res = await decideReply({
        config: cfgGroup, aiClient: stub, logger: quietLogger,
        recentMessages: HISTORY, plainText: CURRENT, speaker: 'werwer', messageType: 'group',
    });
    const p = stub.seen.prompt || '';
    ok(p.includes('话题已经换了'), '4a 判据含「话题已经换了」');
    ok(p.includes('这一轮要收尾了'), '4b 判据含「这一轮要收尾了」');
    ok(p.includes('拿不准就回 NO'), '4c 判据含「拿不准就回 NO」');
    ok(p.includes('默认是 NO'), '4d 判据含「默认是 NO」');
    ok(p.includes('不要接一句来留住这个话头'), '4e 判据明确「别硬接」');
    ok(p.includes('【前面的对话（越靠下越新）】'), '4f 提示词带上历史段');
    ok(p.includes('我: ') && p.includes('werwer: '), '4g 提示词里历史带发言人');
    ok(p.includes('【正在说话的人】werwer'), '4h 当前发言人已注入');
    ok(p.includes('刚进来的这条'), '4i 当前这条在提示词里');
    ok(res.skip === true, '4j 桩回 NO ⇒ skip', `skip=${res.skip} reason=${res.reason}`);

    // ---------------- 5. overrides：thinking 必须关（否则 4 token 被推理吃掉 ⇒ 静默失效）
    const ov = stub.seen.overrides || {};
    ok(ov.thinking && ov.thinking.type === 'disabled', '5a thinking 已关',
        JSON.stringify(ov.thinking));
    ok(ov.temperature === 0, '5b temperature=0');
    ok(Number(ov.maxTokens) === 4, '5c maxTokens=4', String(ov.maxTokens));
    ok(ov.allowModelFallback === false, '5d 不允许模型回退');

    // ---------------- 6. 判决解析
    ok(parseDecision('NO') === false, '6a 解析 NO');
    ok(parseDecision('YES') === true, '6b 解析 YES');
    ok(parseDecision('no.') === false, '6c 容忍标点');
    ok(parseDecision('随便写点东西') === null, '6d 无法解析返回 null');

    // ---------------- 7. 失效方向：任何异常都必须「照常回」
    const stubYes = makeStub('YES');
    const yesRes = await decideReply({
        config: cfgGroup, aiClient: stubYes, logger: quietLogger,
        recentMessages: HISTORY, plainText: CURRENT, messageType: 'group',
    });
    ok(yesRes.skip === false, '7a 桩回 YES ⇒ 照常回');

    const stubGarbage = makeStub('我 觉 得 应 该 回 吧');
    const garbRes = await decideReply({
        config: cfgGroup, aiClient: stubGarbage, logger: quietLogger,
        recentMessages: HISTORY, plainText: CURRENT, messageType: 'group',
    });
    ok(garbRes.skip === false && garbRes.reason === 'unparsed', '7b 解析不了 ⇒ 照常回（fail open）',
        `skip=${garbRes.skip} reason=${garbRes.reason}`);

    const stubThrow = makeStub('NO', { throwError: 'AI_TIMEOUT' });
    const errRes = await decideReply({
        config: cfgGroup, aiClient: stubThrow, logger: quietLogger,
        recentMessages: HISTORY, plainText: CURRENT, messageType: 'group',
    });
    ok(errRes.skip === false, '7c 调用抛错 ⇒ 照常回（fail open）', `reason=${errRes.reason}`);

    // ---------------- 8. 开关与门槛
    const cfgOff = JSON.parse(JSON.stringify(config));
    cfgOff.chat.replyDecision.enabled = false;
    const offRes = await decideReply({
        config: cfgOff, aiClient: makeStub('NO'), logger: quietLogger,
        recentMessages: HISTORY, plainText: CURRENT, messageType: 'group',
    });
    ok(offRes.skip === false && offRes.reason === 'disabled', '8a 关掉后不判');

    const cfgMin = JSON.parse(JSON.stringify(config));
    cfgMin.chat.replyDecision.minChars = 20;
    const minRes = await decideReply({
        config: cfgMin, aiClient: makeStub('NO'), logger: quietLogger,
        recentMessages: HISTORY, plainText: '嗯', messageType: 'group',
    });
    ok(minRes.skip === false && minRes.reason === 'too-short-to-judge', '8b minChars 门槛生效');

    // ---------------- 9. 配置与接线
    ok(config.chat.replyDecision.enabled === true, '9a config 已开启');
    ok(config.chat.replyDecision.scope === 'group', '9b config scope=group',
        String(config.chat.replyDecision.scope));
    const idx = fs.readFileSync(`${ROOT}/src/index.js`, 'utf8');
    ok(idx.includes('recentMessages: (context?.recentMessages || [])'),
        '9c index.js 传的是真实会话历史');
    ok(idx.includes('primary?.event?.sender?.card'), '9d index.js 传了真实发言人');
    ok(!idx.includes("speaker: primary?.structuredText ? '' : ''"), '9e 旧的空 speaker 已移除');

    // ---------------- 10. 决策调用自带超时（否则挂住的请求会拖死整轮回复）
    const rd = fs.readFileSync(`${ROOT}/src/reply-decision.js`, 'utf8');
    ok(rd.includes('Promise.race') && rd.includes('decisionTimeoutMs'), '10a 源码里有超时竞速');
    const cfgTo = JSON.parse(JSON.stringify(config));
    cfgTo.chat.replyDecision.timeoutMs = 500;
    const hangStub = {
        seen: {},
        chat() { return new Promise(() => {}); },   // 永不 resolve
        getVisibleResponseContent() { return ''; },
    };
    const t0 = Date.now();
    const toRes = await decideReply({
        config: cfgTo, aiClient: hangStub, logger: quietLogger,
        recentMessages: HISTORY, plainText: CURRENT, messageType: 'group',
    });
    const cost = Date.now() - t0;
    ok(toRes.skip === false, '10b 请求挂住 ⇒ 照常回（fail open）', `skip=${toRes.skip}`);
    ok(toRes.reason === 'timeout', '10c 记为 timeout', String(toRes.reason));
    ok(cost < 3000, `10d 在配置上限内返回（实测 ${cost}ms）`);

    console.log(`\n  ${label}: PASS ${pass} / FAIL ${fail}`);
}

console.log(`\n===== 合计：PASS ${pass}，FAIL ${fail} =====`);
process.exit(fail === 0 ? 0 : 1);
