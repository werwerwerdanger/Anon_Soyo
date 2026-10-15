/**
 * verify_reply_window.mjs
 * ---------------------------------------------------------------------------
 * 验证「回复窗口」（2026-10-11 用户：「加一个热开关在自己回复消息以后提高回复意愿一段时间，
 * 不然每次在群里和他聊天都要 @ 好麻烦的」）。
 *
 * 语义：她刚在这个会话里说过话 ⇒ 给**刚才那个人**开一段窗口，窗内他再说话不需要 @。
 *
 * ⚠ 这些函数在 index.js 里，而 index.js **不能 import**（顶层就起服务器/连 OneBot）。
 *   按本项目惯例**从文件本身切出函数体**求值（不抄一份），并给 config/logger 补惰性 stub。
 *
 * 用法:  node verify_reply_window.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SRC = 'C:/Users/20633/MimirLink/src';
const IDX = fs.readFileSync(`${SRC}/index.js`, 'utf8');

let pass = 0;
const failures = [];
function check(label, condition, extra = '') {
    if (condition) { pass += 1; console.log(`  [OK  ] ${label}`); }
    else { failures.push(label); console.log(`  [FAIL] ${label}${extra ? '  ' + extra : ''}`); }
}

// ---------------------------------------------------------------------------
console.log('=== Part 1  行为（切真函数 + 惰性 stub）===');
{
    const start = IDX.indexOf('// >>> reply-window patch >>>');
    const end = IDX.indexOf('// <<< reply-window patch <<<');
    check('能从 index.js 切出 reply-window 块', start > 0 && end > start);
    const body = IDX.slice(start, end);
    const harness = `
// ⚠ 惰性读取：\`const config = globalThis.__STATE__.config\` 会在 import 时绑死引用
const config = { get chat() { return globalThis.__STATE__.config.chat; } };
const logs = [];
const logger = { info: (...a) => logs.push(a), warn() {}, error() {}, debug() {} };
${body}
export { openReplyWindow, isReplyWindowOpen, getReplyWindowConfig, logs };
`;
    const tmp = path.join(os.tmpdir(), `replywin-${Date.now()}.mjs`);
    fs.writeFileSync(tmp, harness, 'utf8');
    const m = await import(pathToFileURL(tmp).href);
    const setCfg = (chat) => { globalThis.__STATE__ = { config: { chat } }; };
    const GROUP = 'group:929159193';
    const ME = 2063362809;
    const OTHER = 1000000002;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    setCfg({ replyWindow: { enabled: true, ms: 5000, sameSpeakerOnly: true } });
    check('🟢 没开窗时不开', m.isReplyWindowOpen(GROUP, ME) === false);
    m.openReplyWindow(GROUP, ME);
    check('🔴 她刚回过话 ⇒ 同一个人的下一条**不需要 @**（开窗成功）',
        m.isReplyWindowOpen(GROUP, ME) === true);
    check('🟢 别人插话**不算**开窗（sameSpeakerOnly 默认开）',
        m.isReplyWindowOpen(GROUP, OTHER) === false);
    check('🟢 别的群不受影响', m.isReplyWindowOpen('group:757026023', ME) === false);
    check('🟢 开窗写了一条 info 日志（可观测）',
        m.logs.some((args) => String(args[0]).includes('[回复窗口] 打开')));

    // 续期
    const before = m.getReplyWindowConfig().ms;
    m.openReplyWindow(GROUP, ME);
    check('🟢 再次开窗会续期（extended=true）',
        m.logs[m.logs.length - 1]?.[1]?.extended === true, JSON.stringify(m.logs[m.logs.length - 1]?.[1]));
    check('🟢 ms 配置生效', before === 5000, String(before));

    // 过期
    setCfg({ replyWindow: { enabled: true, ms: 60, sameSpeakerOnly: true } });
    m.openReplyWindow(GROUP, ME);
    check('🟢 窗口内还是 true', m.isReplyWindowOpen(GROUP, ME) === true);
    await sleep(120);
    check('🔴 过期后自动关闭', m.isReplyWindowOpen(GROUP, ME) === false);

    // sameSpeakerOnly: false ⇒ 群里谁说话都算
    setCfg({ replyWindow: { enabled: true, ms: 5000, sameSpeakerOnly: false } });
    m.openReplyWindow(GROUP, ME);
    check('🟢 sameSpeakerOnly:false 时别人说话也算', m.isReplyWindowOpen(GROUP, OTHER) === true);

    // 总开关
    setCfg({ replyWindow: { enabled: false, ms: 5000 } });
    m.openReplyWindow(GROUP, ME);
    check('🟢 enabled:false ⇒ 开不上也查不到',
        m.isReplyWindowOpen(GROUP, ME) === false);

    // 缺省 / 脏值
    setCfg({});
    check('🟢 没有 replyWindow 配置时默认开启、默认 180s',
        m.getReplyWindowConfig().enabled === true && m.getReplyWindowConfig().ms === 180000);
    setCfg({ replyWindow: { ms: 'abc' } });
    check('🟢 ms 是脏值时回落到 180s', m.getReplyWindowConfig().ms === 180000);
    setCfg({ replyWindow: { enabled: true, ms: 5000 } });
    check('🟢 空 sessionKey / 空 participantId 不炸',
        (m.openReplyWindow('', ME), m.openReplyWindow(GROUP, ''), m.isReplyWindowOpen('', ME)) === false);
    fs.rmSync(tmp, { force: true });
}

// ---------------------------------------------------------------------------
console.log('\n=== Part 2  路由接线（位置很关键）===');
{
    const saniIdx = IDX.indexOf('function sanitizeForInjection');
    const branchIdx = IDX.indexOf('if (hints.replyWindowOpen)');
    const napcatIdx = IDX.indexOf("return skip('napcat_output')");
    const stickerIdx = IDX.indexOf("return skip('sticker_low_willingness')");
    check('🔴 路由里有 replyWindowOpen 分支', branchIdx > 0);
    check('🔴 它在 NapCat/黑名单**之后**（安全项优先）',
        branchIdx > napcatIdx && napcatIdx > 0, `napcat=${napcatIdx} branch=${branchIdx}`);
    check('🔴 它在表情包低意愿**之前**（聊到一半的表情包别被概率掐掉）',
        branchIdx < stickerIdx && stickerIdx > 0, `branch=${branchIdx} sticker=${stickerIdx}`);
    // ⚠ 2026-10-13 修：原来钉死「`if (hints.replyWindowOpen) {` 后面紧跟 `return accept(...)`」。
    //   后来在两者之间插了「纯表情包子闸门」（stickersTrigger），正则就再也匹配不上 ——
    //   报的是「用的是 accept 而不是 skip」，看着像窗口被改成不触发了，其实只是插了一段代码。
    //   ⇒ 改成「分支体内确实有 accept('reply_window')」+ 子闸门的独立断言。
    check('🟢 用的是 accept(...) 而不是 skip(...)（＝算触发）',
        /hints\.replyWindowOpen\) \{[\s\S]{0,900}?return accept\('reply_window'\)/.test(IDX));
    // >>> reply-window-sticker patch 的回归闸门 >>>
    // 起因：群里连着聊时窗口一直开着，用户发个动画表情她也回，看起来像"不描述表情包"失效。
    // 实际是窗口在表情包检查**之前**就放行了 ⇒ 只挡纯表情包，图+文字照旧。
    check('🟢 子闸门确实嵌在窗口分支**内部**、且 accept 排在它之后',
        /hints\.replyWindowOpen\) \{[\s\S]{0,900}?stickersTrigger !== false[\s\S]{0,200}?isStickerOnlyMessage\(messageInfo\)[\s\S]{0,300}?return accept\('reply_window'\)/
            .test(IDX));
    check('🟢 关掉 stickersTrigger 时纯表情包不再被窗口放行',
        /config\?\.chat\?\.replyWindow\?\.stickersTrigger !== false/.test(IDX));
    check('🔴 子闸门必须读**传入的 config**，不许调 getReplyWindowConfig()',
        !/hints\.replyWindowOpen\) \{[\s\S]{0,900}?getReplyWindowConfig\(\)\.stickersTrigger/.test(IDX));
    // <<< reply-window-sticker patch >>>
    check('🔴 buildRoutingDecision 签名多了 hints 参数',
        /function buildRoutingDecision\(config, event, plainText, isAtMe, messageInfo = \{\}, hints = \{\}\)/.test(IDX));
    check('🔴 唯一调用点把 replyWindowOpen 传进去了',
        /routingWindowOpen|replyWindowOpen: isReplyWindowOpen\(routingSessionKey, event\.user_id\)/.test(IDX));
    check('🔴 「回复下发完成」之后会开窗',
        /回复下发完成'[\s\S]{0,160}openReplyWindow\(sessionId, event\.user_id\)/.test(IDX));
    void saniIdx;
}

// ---------------------------------------------------------------------------
console.log('\n=== Part 3  配置 ===');
{
    const cfg = JSON.parse(fs.readFileSync('C:/Users/20633/MimirLink/config.json', 'utf8'));
    check('🟢 chat.replyWindow 在配置里', !!cfg.chat?.replyWindow,
        JSON.stringify(cfg.chat?.replyWindow));
    check('🟢 默认开启', cfg.chat?.replyWindow?.enabled === true);
    check('🟢 窗口时长合理（60s ~ 30min）', (() => {
        const ms = Number(cfg.chat?.replyWindow?.ms);
        return ms >= 60000 && ms <= 1800000;
    })(), String(cfg.chat?.replyWindow?.ms));
    check('🟢 默认只对同一个人放宽', cfg.chat?.replyWindow?.sameSpeakerOnly !== false);
}

console.log('\n' + '='.repeat(62));
console.log(`结果: ${pass} 通过 / ${failures.length} 失败`);
if (failures.length) { failures.forEach((f) => console.log('  失败: ' + f)); process.exit(1); }
console.log('全部通过');
