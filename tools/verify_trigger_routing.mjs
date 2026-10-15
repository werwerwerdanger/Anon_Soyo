/**
 * Verify the keyword-trigger switch against the REAL routing code.
 *
 * buildRoutingDecision() is not exported, so rather than re-implement it (which
 * would only test my copy) this pulls the actual source text out of src/index.js
 * by brace matching, evaluates those functions, and drives them with the real
 * config.json of each instance.
 *
 *   node verify_trigger_routing.mjs
 */
import fs from 'node:fs';

function extractFunction(src, name) {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`function ${name} not found`);
    // The body brace is the first '{' at paren depth 0 -- a naive indexOf('{')
    // lands inside default params like `messageInfo = {}`.
    let i = -1;
    let paren = 0;
    for (let k = src.indexOf('(', start); k < src.length; k++) {
        if (src[k] === '(') paren++;
        else if (src[k] === ')') paren--;
        else if (src[k] === '{' && paren === 0) { i = k; break; }
    }
    if (i < 0) throw new Error(`body brace not found for ${name}`);
    let depth = 0;
    for (let j = i; j < src.length; j++) {
        const c = src[j];
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return src.slice(start, j + 1);
        }
    }
    throw new Error(`unbalanced braces for ${name}`);
}

function markedBlock(src, label) {
    // ⚠ 两个坑，都是本脚本静默失效的原因（2026-10-10 才发现）：
    //   1) 起始标记常带后缀，如 `// >>> bot-banter-limit patch (managed by xxx.py) >>>`，
    //      而 `indexOf('// >>> label >>>')` 匹配不到它，会落到**函数体内的行内标记**上；
    //   2) 行内标记在函数内部、而第一个结束标记在它前面 ⇒ start > end ⇒ slice 返回空串。
    //      不抛错，只是悄悄少测一大块（isCoBot 变 undefined 才暴露）。
    // ⇒ 起点允许任意后缀，终点只在**起点之后**找。
    const startRe = new RegExp(`// >>> ${label}[^\\n]*>>>`);
    const m = startRe.exec(src);
    if (!m) throw new Error(`marked block not found: ${label}`);
    const start = m.index;
    const rel = src.slice(start).indexOf(`// <<< ${label} <<<`);
    if (rel < 0) throw new Error(`marked block end not found: ${label}`);
    return src.slice(start, start + rel);
}

const CASES = [
    ['MimirLink-soyo', 'soyo'],
    ['MimirLink', 'anon'],
];

let failed = 0;
for (const [inst, label] of CASES) {
    const ROOT = `C:/Users/20633/${inst}`;
    const src = fs.readFileSync(`${ROOT}/src/index.js`, 'utf8');
    const config = JSON.parse(fs.readFileSync(`${ROOT}/config.json`, 'utf8'));

    const code = [
        markedBlock(src, 'group-repeat-and-names patch'),
        markedBlock(src, 'bot-banter-limit patch'),
        markedBlock(src, 'sticker-assertion patch'),
        extractFunction(src, 'matchesKeywords'),
        extractFunction(src, 'toComparableId'),
        extractFunction(src, 'isAllowed'),
        extractFunction(src, 'isTriggerUser'),
        // 🔴 2026-10-13 补：`accept()` 里调了 coBotYieldMarkSpoken / coBotYieldNoteCoBot，
        //    它们又依赖 coBotYieldState(Map) —— 以前这些都没进求值环境，脚本一起跑就 ReferenceError。
        'const coBotYieldState = new Map();',
        extractFunction(src, 'coBotYieldNoteCoBot'),
        extractFunction(src, 'coBotYieldDecision'),
        extractFunction(src, 'coBotYieldMarkSpoken'),
        extractFunction(src, 'buildRoutingDecision'),
        'return { buildRoutingDecision };',
    ].join('\n');
    // 🔴 2026-10-13 修：`buildRoutingDecision` 里调了 `isNapcatNoise`（napcat-output-ignore patch），
    //    而它是 `import` 进来的 —— `new Function` 的环境里没有 import ⇒ **ReferenceError**。
    //    也就是说：**这个脚本自 napcat 补丁之后一直是坏的**，一直没真正跑过
    //    （它可是"群聊触发口径的唯一可信验证"，坏了就意味着那段逻辑一直没被回归）。
    //    修法：把真函数当参数注入，别用 stub（stub 会让相关用例永远假通过）。
    const { isNapcatNoise } = await import(`file:///${ROOT}/src/napcat-output.js`);
    const { buildRoutingDecision } = new Function('isNapcatNoise', code)(isNapcatNoise);

    const kw = config.chat.triggerKeywords[0];
    // 表情包断言按概率 ⇒ 测试里必须把概率钉死，否则会飘
    const cfgStickerOn = JSON.parse(JSON.stringify(config));
    cfgStickerOn.chat.stickerReplyChance = 1;
    const cfgStickerOff = JSON.parse(JSON.stringify(config));
    cfgStickerOff.chat.stickerReplyChance = 0;
    // ⚠ 2026-10-13 修：原来这里只造 `{ type: t }`，**造不出表情包**。
    //    `isStickerImageSegment()` 认 `summary`（如「[动画表情]」）或 `subType=1`，
    //    两者都没有 ⇒ 判成"上传的图" ⇒ `isStickerOnlyMessage()` 返回 false。
    //    后果：**所有名叫 sticker 的用例其实一直在测"上传的图"**，
    //    表情包低意愿那段逻辑一次都没被跑到（长期 FAIL 的 `sticker chance=0 (私聊)` 就是它）。
    const seg = (t) => [{ type: t, summary: '[动画表情]' }];
    const scenarios = [
        ['group  @bot                 ', { message_type: 'group', group_id: 1, user_id: 2 }, 'hi', true, {}, true],
        [`group  mentions "${kw}"        `, { message_type: 'group', group_id: 1, user_id: 2 }, `你们觉得${kw}怎么样`, false, {}, true],
        ['group  reply-to-bot         ', { message_type: 'group', group_id: 1, user_id: 2 }, 'ok', false, { replyToBot: true }, true],
        ['group  unrelated chatter    ', { message_type: 'group', group_id: 1, user_id: 2 }, '今天中午吃什么', false, {}, false],
        ['group  bot own message      ', { message_type: 'group', group_id: 1, user_id: 999 }, '自说自话', false, {}, false],
        ['private message             ', { message_type: 'private', user_id: 2 }, 'hi', false, {}, true],
        ['private sticker only        ', { message_type: 'private', user_id: 2 }, '[图片:[动画表情]]', false, {}, true],
        ['group  sticker only         ', { message_type: 'group', group_id: 1, user_id: 2 }, '[图片:[动画表情]]', false, {}, false],
        [`group  sticker + "${kw}"      `, { message_type: 'group', group_id: 1, user_id: 2 }, `${kw} 看这个 [图片:[动画表情]]`, false, {}, true],
        // 🔄 2026-10-10：triggerUsers 已清空（用户要"群聊意愿压到最低"）
        //     ⇒ 群主说话不再免检，一样要 @ 或关键词。
        ['group  owner, no @/keyword ', { message_type: 'group', group_id: 1, user_id: 2063362809 }, '今天吃什么', false, {}, false],
        ['group  stranger, no trigger ', { message_type: 'group', group_id: 1, user_id: 77777 }, '今天吃什么', false, {}, false],
        ['private sticker -> reply bot', { message_type: 'private', user_id: 2 }, '[图片:[动画表情]]', false, { replyToBot: true }, true],
        // 🔄 2026-10-10 keyword-boundary patch：ASCII 关键词按词边界匹配
        //    罗马名小写形式不再误命中别的英文词（`anon` ⊄ `canon`）
        ['ASCII 边界: "canon" 不该命中 ', { message_type: 'group', group_id: 1, user_id: 2 }, '来首卡农吧 Canon in D', false, {}, false],
        ['ASCII 边界: "anonymous"      ', { message_type: 'group', group_id: 1, user_id: 2 }, 'anonymous 是谁', false, {}, false],
        ['ASCII 名字独立出现          ', { message_type: 'group', group_id: 1, user_id: 2 }, `hey ${kw.toLowerCase()} 在吗`, false, {}, true],
        ['ASCII 名字后接标点          ', { message_type: 'group', group_id: 1, user_id: 2 }, `${kw.toLowerCase()}!!`, false, {}, true],
        // 官方译名（爽世）也必须能触发
        ['官方译名 爽世                ', { message_type: 'group', group_id: 1, user_id: 2 }, '爽世你怎么看', false, {}, config.chat.triggerKeywords.includes('爽世')],
        ['官方全名 长崎爽世            ', { message_type: 'group', group_id: 1, user_id: 2 }, '长崎爽世 在吗', false, {}, config.chat.triggerKeywords.includes('长崎爽世')],
    ];

    // 🔄 2026-10-10 新增：表情包回复断言（纯表情包低意愿）
    // ⚠ 文本不能用空串 —— `plainText` 为空会先被 `empty_text` 拦掉（在断言之前），
    //    测出来是 empty_text 而不是我们的 sticker_low_willingness。
    //    线上纯表情包的实际 plainText 是「[图片]」这类占位文本。
    const PLACEHOLDER = '[图片]';
    const txtSeg = (t) => ([{ type: 'text', text: t }]);
    const stickerScenarios = [
        // chance=1 → 一定回；chance=0 → 一定不回。都要带 messageSegments 才认得出来。
        ['sticker chance=1 (私聊)      ', cfgStickerOn, { message_type: 'private', user_id: 2 }, PLACEHOLDER, false,
            { replyToBot: false, messageSegments: [...txtSeg(PLACEHOLDER), ...seg('image')] }, true],
        ['sticker chance=0 (私聊)      ', cfgStickerOff, { message_type: 'private', user_id: 2 }, PLACEHOLDER, false,
            { replyToBot: false, messageSegments: [...txtSeg(PLACEHOLDER), ...seg('image')] }, false],
        ['sticker chance=0 (群+关键词)  ', cfgStickerOff, { message_type: 'group', group_id: 1, user_id: 2 },
            `${kw} ${PLACEHOLDER}`, false,
            { replyToBot: false, messageSegments: [...txtSeg(`${kw} ${PLACEHOLDER}`), ...seg('image')] }, true],
        ['sticker chance=0 但被@        ', cfgStickerOff, { message_type: 'private', user_id: 2 }, PLACEHOLDER, true,
            { replyToBot: false, messageSegments: [...txtSeg(PLACEHOLDER), ...seg('image')] }, true],
        ['sticker chance=0 但被回复     ', cfgStickerOff, { message_type: 'private', user_id: 2 }, PLACEHOLDER, false,
            { replyToBot: true, messageSegments: [...txtSeg(PLACEHOLDER), ...seg('image')] }, true],
        ['图文混合(有真文字) chance=0   ', cfgStickerOff, { message_type: 'private', user_id: 2 }, `你看这个 ${PLACEHOLDER}`, false,
            { replyToBot: false, messageSegments: [...seg('image'), ...txtSeg(`你看这个 ${PLACEHOLDER}`)] }, true],
    ];

    console.log(`===== ${inst} (${label})  triggerMode=${config.chat.triggerMode} requireAtInGroup=${config.chat.requireAtInGroup} =====`);
    console.log(`      keywords: ${config.chat.triggerKeywords.join(', ')}`);
    for (const [label2, event, text, isAtMe, info, expected] of scenarios) {
        const d = buildRoutingDecision(config, event, text, isAtMe, info);
        const ok = d.shouldRespond === expected;
        if (!ok) failed++;
        console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label2} respond=${String(d.shouldRespond).padEnd(5)} reason=${(d.triggerReason || d.skipReason).padEnd(24)} (expect ${expected})`);
    }
    for (const [label2, cfg, event, text, isAtMe, info, expected] of stickerScenarios) {
        const d = buildRoutingDecision(cfg, event, text, isAtMe, info);
        const ok = d.shouldRespond === expected;
        if (!ok) failed++;
        console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label2} respond=${String(d.shouldRespond).padEnd(5)} reason=${(d.triggerReason || d.skipReason).padEnd(24)} (expect ${expected})`);
    }
    console.log('');

    // group-repeat suppression: the SAME line said twice in one group must not trigger
    // twice, even when it contains a trigger keyword (that is the whole point -- before
    // this check sat after the keyword branch and therefore never fired).
    // 🔄 2026-10-13 新增：回复窗口 × 纯表情包（chat.replyWindow.stickersTrigger）
    // 起因：群里连着聊时窗口一直开着，用户发个动画表情她也回，看起来像"不描述表情包"失效。
    // 真相是窗口在表情包检查**之前**就 accept 了（原意是"聊到一半发个表情包不该被概率掐掉"）。
    // 现在 stickersTrigger=false ⇒ 窗口只对"带真文字"的消息生效。
    const cfgWinStickerOff = JSON.parse(JSON.stringify(config));
    cfgWinStickerOff.chat.replyWindow = { ...(cfgWinStickerOff.chat.replyWindow || {}), stickersTrigger: false };
    cfgWinStickerOff.chat.stickerReplyChance = 0;   // 钉死概率，否则结果会飘
    const cfgWinStickerOn = JSON.parse(JSON.stringify(cfgWinStickerOff));
    cfgWinStickerOn.chat.replyWindow.stickersTrigger = true;
    const winCases = [
        // ⚠ 三个坑，都在我第一版用例里踩过：
        //  1) 必须用**群聊** —— 私聊有独立的 accept 分支（reason=private）无条件放行，
        //     走不到窗口/表情包这段（事故也发生在群里）。
        //  2) `hints` 是**第 6 个参数**（第 5 个是 messageInfo）！传错位置 ⇒
        //     `hints.replyWindowOpen` 恒为 undefined ⇒ 窗口分支永不进入（假失败）。
        //  3) 每个用例要换**不同的群号 + 文本** —— 同群同样的话说第二遍会被复读闸门
        //     挡成 `repeated_text`，污染结果。
        ['窗口开 + stickersTrigger=false + 纯表情包 → 不回', cfgWinStickerOff, 9001, PLACEHOLDER,
            { messageSegments: [...txtSeg(PLACEHOLDER), ...seg('image')] }, true, false],
        ['窗口开 + stickersTrigger=false + 带文字   → 回', cfgWinStickerOff, 9002, '在吗在吗',
            { messageSegments: txtSeg('在吗在吗') }, true, true],
        ['窗口开 + stickersTrigger=true(旧行为) 表情包 → 回', cfgWinStickerOn, 9003, PLACEHOLDER,
            { messageSegments: [...txtSeg(PLACEHOLDER), ...seg('image')] }, true, true],
        ['窗口开 + 被明确回复时表情包仍回（关着也回）', cfgWinStickerOff, 9004, PLACEHOLDER,
            { replyToBot: true, messageSegments: [...txtSeg(PLACEHOLDER), ...seg('image')] }, true, true],
        ['没窗口 + sticker 关着 + 群纯表情包 → 不回(基线)', cfgWinStickerOff, 9005, PLACEHOLDER,
            { messageSegments: [...txtSeg(PLACEHOLDER), ...seg('image')] }, false, false],
    ];
    for (const [label2, cfg, gid, text, msgInfo, winOpen, expected] of winCases) {
        const d = buildRoutingDecision(cfg, { message_type: 'group', group_id: gid, user_id: 878787 },
            text, false, msgInfo, { replyWindowOpen: winOpen });
        const ok = d.shouldRespond === expected;
        if (!ok) failed++;
        console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label2} respond=${String(d.shouldRespond).padEnd(5)} reason=${(d.triggerReason || d.skipReason)}`);
    }

    const repeatText = `${kw} ${kw}`;
    const ev1 = { message_type: 'group', group_id: 555, user_id: 11 };
    const ev2 = { message_type: 'group', group_id: 555, user_id: 22 };
    const d1 = buildRoutingDecision(config, ev1, repeatText, false, {});
    const d2 = buildRoutingDecision(config, ev2, repeatText, false, {});
    const ok1 = d1.shouldRespond === true;
    const ok2 = d2.shouldRespond === false && d2.skipReason === 'repeated_text';
    if (!ok1) failed++;
    if (!ok2) failed++;
    console.log(`  ${ok1 ? 'PASS' : 'FAIL'}  repeat 1st speaker triggers        respond=${d1.shouldRespond} reason=${d1.triggerReason || d1.skipReason}`);
    console.log(`  ${ok2 ? 'PASS' : 'FAIL'}  repeat 2nd speaker suppressed     respond=${d2.shouldRespond} reason=${d2.skipReason}`);
    // ...but quoting the bot still gets through
    const d3 = buildRoutingDecision(config, ev2, repeatText, false, { replyToBot: true });
    const ok3 = d3.shouldRespond === true;
    if (!ok3) failed++;
    console.log(`  ${ok3 ? 'PASS' : 'FAIL'}  reply-to-bot bypasses the repeat gate reason=${d3.triggerReason || d3.skipReason}`);

    // bot-to-bot banter cap: two bots must not ping-pong in a group forever
    const G = 777;
    const anonQQ = 2458713318;
    const botMsg = '爱音，你又来了';
    const humanMsg = '你们两个停一下';
    const r1 = buildRoutingDecision(config, { message_type: 'group', group_id: G, user_id: anonQQ }, botMsg, false, {});
    const r2 = buildRoutingDecision(config, { message_type: 'group', group_id: G, user_id: anonQQ }, botMsg + '2', false, {});
    const r3 = buildRoutingDecision(config, { message_type: 'group', group_id: G, user_id: anonQQ }, botMsg + '3', false, {});
    const b1 = r1.triggerReason === 'co_bot';
    const b2 = r2.triggerReason === 'co_bot';
    const b3 = r3.shouldRespond === false && r3.skipReason === 'bot_banter_limit';
    if (!b1 || !b2 || !b3) failed++;
    console.log(`  ${b1 && b2 ? 'PASS' : 'FAIL'}  bot banter within cap        r1=${r1.triggerReason} r2=${r2.triggerReason}`);
    console.log(`  ${b3 ? 'PASS' : 'FAIL'}  bot banter capped at 2       r3=${r3.shouldRespond} ${r3.skipReason}`);
    // a human speaking must NOT reset the cap any more (2026-10-09 fix: with a reset,
    // an active group never reached the limit -- real logs showed co_bot and no limit)
    buildRoutingDecision(config, { message_type: 'group', group_id: G, user_id: 2063362809 }, humanMsg, false, {});
    const r4 = buildRoutingDecision(config, { message_type: 'group', group_id: G, user_id: anonQQ }, botMsg + '4', false, {});
    const b4 = r4.shouldRespond === false && r4.skipReason === 'bot_banter_limit';
    if (!b4) failed++;
    console.log(`  ${b4 ? 'PASS' : 'FAIL'}  human turn does NOT reset cap  r4=${r4.shouldRespond} ${r4.skipReason}`);
}

console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
