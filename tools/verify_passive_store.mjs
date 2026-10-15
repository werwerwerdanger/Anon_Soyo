/**
 * verify_passive_store.mjs
 * ---------------------------------------------------------------------------
 * 验证「群里没触发她的消息也入库 + 定期压缩」这条链路。
 *
 * 起因（2026-10-11）：用户问「群里没触发她的消息能不能入库然后定期压缩」。
 * 原状是跳过分支 `logger.debug(...); return;` —— **什么都不存** ⇒ 她的群历史只有
 * "她愿意接的那些话"（实测：朋友的舞萌成绩截图被 `sticker_low_willingness` 丢掉，
 * 连库都没入）。现在按 skipReason 白名单入库，压缩交给现成的
 * `memory.summary` / `maybeSummarizeSession`。
 *
 * ⚠ `maybeStoreUntriggeredMessage` 在 index.js 里，而 index.js **不能 import**
 *   （顶层就会起服务器/连 OneBot）。按本项目惯例**从文件本身切出函数体**再求值
 *   —— 不抄一份，否则验的是副本。切的时候要给它补 config / sessionManager /
 *   logger / buildParticipants 这几个外部依赖。
 *
 * 用法:  node verify_passive_store.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SRC = 'C:/Users/20633/MimirLink/src';
const DB = 'C:/Users/20633/MimirLink/data/chats/memory-store.sqlite';
const IDX_SRC = fs.readFileSync(`${SRC}/index.js`, 'utf8');

let pass = 0;
const failures = [];
function check(label, condition, extra = '') {
    if (condition) { pass += 1; console.log(`  [OK  ] ${label}`); }
    else { failures.push(label); console.log(`  [FAIL] ${label}${extra ? '  ' + extra : ''}`); }
}

// ---------------------------------------------------------------------------
// 从 index.js 切出 passive-store patch 的函数体（不抄）
function extractPassiveStore() {
    const start = IDX_SRC.indexOf('// >>> passive-store patch >>>');
    const end = IDX_SRC.indexOf('// <<< passive-store patch <<<');
    if (start < 0 || end < start) return null;
    return IDX_SRC.slice(start, end);
}

console.log('=== Part 1  白名单行为（切真函数 + 假 sessionManager）===');
const body = extractPassiveStore();
check('能从 index.js 切出 passive-store 块', !!body, '标记不在？');
if (body) {
    const harness = `
const calls = [];
// ⚠ 必须惰性读取：\`const config = globalThis.__CFG__\` 会在 import 时绑死引用，
//   之后重新赋值 globalThis 完全不生效（第一版就是这样白报 5 个 FAIL）。
const config = { get chat() { return globalThis.__STATE__.config.chat; } };
const logger = { debug: (...a) => calls.push(['debug', ...a]), warn: (...a) => calls.push(['warn', ...a]), info() {}, error() {} };
const sessionManager = { addMessage: (...a) => globalThis.__STATE__.sm.addMessage(...a) };
function buildParticipants(items) {
    return (items || []).map((it) => {
        const e = it.event || {};
        const name = e.sender?.card || e.sender?.nickname || ('QQ:' + e.user_id);
        return \`\${name}(\${e.user_id})\`;
    });
}
${body}
export { maybeStoreUntriggeredMessage, PASSIVE_STORE_SKIP_REASONS, calls };
`;
    const tmp = path.join(os.tmpdir(), `passive-${Date.now()}.mjs`);
    fs.writeFileSync(tmp, harness, 'utf8');

    const makeSm = () => {
        const stored = [];
        return { stored, addMessage: (sid, role, content, md) => { stored.push({ sid, role, content, md }); return { id: 'x' }; } };
    };
    const EVENT = {
        message_type: 'group', user_id: 1000000002, group_id: 929159193, message_id: 123,
        sender: { nickname: '涵' }
    };
    globalThis.__STATE__ = { sm: makeSm(), config: { chat: { storeUntriggeredMessages: true } } };
    const mod = await import(pathToFileURL(tmp).href);

    check('🔴 `sticker_low_willingness`（舞萌成绩那种）会入库',
        mod.maybeStoreUntriggeredMessage({
            event: EVENT, sessionKey: 'group:929159193',
            structuredText: '[群聊|QQ:1000000002|昵称:涵|...] x', plainText: 'x',
            skipReason: 'sticker_low_willingness'
        }) === true && globalThis.__STATE__.sm.stored.length === 1);
    const first = globalThis.__STATE__.sm.stored[0];
    check('🔴 入库时打了 `passive: true`（prompt 靠它把"群闲话"排除出用户意图）',
        first?.md?.passive === true, JSON.stringify(first?.md));
    check('入库时带上了 skipReason（追溯用）', first?.md?.skipReason === 'sticker_low_willingness');
    check('入库时带了 participants（通讯录也能从群闲聊里学人）',
        Array.isArray(first?.md?.participants) && first.md.participants[0] === '涵(1000000002)',
        JSON.stringify(first?.md?.participants));
    check('role 是 user（这样才进她的历史）', first?.role === 'user');
    check('sessionKey 用群会话', first?.sid === 'group:929159193');

    for (const r of ['group_no_trigger_matched', 'keyword_or_at_required',
        'group_requires_at_prefix_keyword_or_reply_to_bot', 'repeated_text']) {
        globalThis.__STATE__.sm = makeSm();
        const ok = mod.maybeStoreUntriggeredMessage({
            event: EVENT, sessionKey: 'group:929159193', structuredText: 'x', plainText: 'x',
            skipReason: r
        });
        check(`🟢 ${r} 也入库`, ok === true && globalThis.__STATE__.sm.stored.length === 1);
    }

    for (const r of ['empty_text', 'access_denied', 'napcat_output', 'cobot_yield', 'cobot_private']) {
        globalThis.__STATE__.sm = makeSm();
        const ok = mod.maybeStoreUntriggeredMessage({
            event: EVENT, sessionKey: 'group:929159193', structuredText: 'x', plainText: 'x',
            skipReason: r
        });
        check(`🚫 ${r} **不**入库（结构性跳过，不是聊天内容）`,
            ok === false && globalThis.__STATE__.sm.stored.length === 0);
    }

    globalThis.__STATE__.sm = makeSm();
    globalThis.__STATE__.config = { chat: { storeUntriggeredMessages: false } };
    check('🟢 开关关了就不入库', (() => {
        const ok = mod.maybeStoreUntriggeredMessage({
            event: EVENT, sessionKey: 'group:929159193', structuredText: 'x', plainText: 'x',
            skipReason: 'group_no_trigger_matched'
        });
        return ok === false && globalThis.__STATE__.sm.stored.length === 0;
    })());

    globalThis.__STATE__.config = { chat: { storeUntriggeredMessages: true } };
    globalThis.__STATE__.sm = { addMessage: () => { throw new Error('boom'); } };
    check('🟢 入库失败不抛（绝不能影响主流程）', (() => {
        try {
            const ok = mod.maybeStoreUntriggeredMessage({
                event: EVENT, sessionKey: 'group:929159193', structuredText: 'x', plainText: 'x',
                skipReason: 'group_no_trigger_matched'
            });
            return ok === false;
        } catch { return false; }
    })());
    globalThis.__STATE__.sm = makeSm();
    check('🟢 空内容不入库',
        mod.maybeStoreUntriggeredMessage({
            event: EVENT, sessionKey: 'group:929159193', structuredText: '', plainText: '',
            skipReason: 'group_no_trigger_matched'
        }) === false);
    fs.rmSync(tmp, { force: true });
}

// ---------------------------------------------------------------------------
console.log('\n=== Part 2  真库：入了历史，但不进「最近用户意图」===');
{
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passive-db-'));
    const db = path.join(tmpDir, 'memory-store.sqlite');
    for (const s of ['', '-wal', '-shm']) {
        if (fs.existsSync(DB + s)) fs.copyFileSync(DB + s, db + s);
    }
    const { SessionManager } = await import(pathToFileURL(`${SRC}/session.js`).href);
    const { PromptBuilder } = await import(pathToFileURL(`${SRC}/prompt.js`).href);
    const noop = { info() {}, warn() {}, error() {}, debug() {} };
    const sm = new SessionManager(tmpDir, { memory: { storage: { path: db } } }, noop);

    const SID = 'group:929159193';
    const before = sm.getContext(SID, 100).recentMessages.length;
    sm.addMessage(SID, 'user', '[群聊|QQ:1000000002|昵称:涵|群号:929159193] 这是群里的闲话', {
        messageType: 'group', userId: 1000000002, groupId: 929159193,
        passive: true, skipReason: 'group_no_trigger_matched'
    });
    sm.addMessage(SID, 'user', '[群聊|QQ:2063362809|昵称:werwer|群号:929159193] 爱音你看这个', {
        messageType: 'group', userId: 2063362809, groupId: 929159193
    });
    const after = sm.getContext(SID, 100).recentMessages;
    // ⚠ 别断言 `after.length === before + 2`：getContext 有 limit 上限（这里 100），
    //   而这个会话早就满 100 条了 ⇒ 加两条长度还是 100（第一版就这么白报 FAIL 的）。
    //   要断言"进没进历史"就按**内容**断言。
    check('🟢 被动消息进了历史',
        after.some((m) => String(m.content).includes('这是群里的闲话')),
        `before=${before} after=${after.length}`);
    check('🟢 在跟她说的那条也在', after.some((m) => String(m.content).includes('爱音你看这个')));
    const passiveOne = after.find((m) => m.content.includes('这是群里的闲话'));
    check('🟢 历史里能读出 passive 标记（metadata 透传）',
        passiveOne?.metadata?.passive === true, JSON.stringify(passiveOne?.metadata));

    // 真 PromptBuilder 装配：被动消息**不能**出现在【最近用户意图】里
    const builder = new PromptBuilder({}, {}, { context: {}, chat: {} }, noop);
    const sections = builder.buildSituationalContext(
        { recentMessages: after }, { sessionId: SID, messageType: 'group', messageCount: 1 });
    const intentBlock = (sections.match(/【最近用户意图】\n([\s\S]*?)(\n\n【|$)/) || [])[1] || '';
    check('🔴 被动消息**不**出现在【最近用户意图】里',
        !intentBlock.includes('这是群里的闲话'), intentBlock.slice(0, 120));
    check('🟢 真正在跟她说的那句还在意图里',
        intentBlock.includes('爱音你看这个'), intentBlock.slice(0, 120));
    // 历史**不在**情境段里（那是 messages 的另一部分）⇒ 要做真 build() 才能断言
    // "她确实能看到群上下文"。第一版我拿 sections 去断言，白报一个 FAIL。
    const { CharacterManager } = await import(pathToFileURL(`${SRC}/character.js`).href);
    const { WorldBookManager } = await import(pathToFileURL(`${SRC}/worldbook.js`).href);
    const cfg = JSON.parse(fs.readFileSync('C:/Users/20633/MimirLink/config.json', 'utf8'));
    const pb = new PromptBuilder(new CharacterManager('C:/Users/20633/MimirLink/data'),
        new WorldBookManager('C:/Users/20633/MimirLink/data'), cfg, noop);
    const built = await pb.build('Anon_Chihaya', '测试一下', sm.getContext(SID, 100), new Set(), {
        sessionId: SID, memoryScope: { sessionKey: SID }, recallNamespace: { scopeKey: SID },
        messageType: 'group', messageCount: 1, participants: ['werwer(2063362809)'], triggerReason: 'at'
    });
    const joined = (built.messages || []).map((m) => String(m.content)).join('\n');
    check('🔴 被动消息出现在**装配后的完整提示词**里（她能看到群上下文）',
        joined.includes('这是群里的闲话'));

    try { sm.db.close(); } catch { /* 忽略 */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

// ---------------------------------------------------------------------------
console.log('\n=== Part 3  静态闸门 ===');
{
    check('🔴 跳过分支里真的调了入库（不是只定义了函数）',
        /logger\.debug\('\[路由\] 消息未触发回复', lastRoutingSnapshot\);[\s\S]{0,260}maybeStoreUntriggeredMessage\(\{/.test(IDX_SRC));
    check('🔴 白名单里没有结构性跳过（黑名单/空文本/机器人自己的输出/coBot）',
        !/PASSIVE_STORE_SKIP_REASONS = new Set\(\[[\s\S]{0,400}'(empty_text|access_denied|napcat_output|cobot_yield|cobot_private)'/.test(IDX_SRC));
    check('prompt.js 按 passive 过滤【最近用户意图】',
        /filter\(\(message\) => !message\?\.metadata\?\.passive\)/.test(
            fs.readFileSync(`${SRC}/prompt.js`, 'utf8')));
    check('自动压缩仍然开着（memory.summary.enabled + useAI）', (() => {
        const cfg = JSON.parse(fs.readFileSync('C:/Users/20633/MimirLink/config.json', 'utf8'));
        return cfg.memory?.summary?.enabled === true && cfg.memory.summary.useAI === true;
    })());
    check('🟢 全局上限已提高（否则入库量变大后会挤掉别的会话的历史）', (() => {
        const cfg = JSON.parse(fs.readFileSync('C:/Users/20633/MimirLink/config.json', 'utf8'));
        return Number(cfg.chat?.maxGlobalMessages) >= 8000;
    })(), (() => {
        const cfg = JSON.parse(fs.readFileSync('C:/Users/20633/MimirLink/config.json', 'utf8'));
        return String(cfg.chat?.maxGlobalMessages);
    })());
    check('🟢 开关在配置里（storeUntriggeredMessages）', (() => {
        const cfg = JSON.parse(fs.readFileSync('C:/Users/20633/MimirLink/config.json', 'utf8'));
        return cfg.chat?.storeUntriggeredMessages === true;
    })());
}

console.log('\n' + '='.repeat(62));
console.log(`结果: ${pass} 通过 / ${failures.length} 失败`);
if (failures.length) { failures.forEach((f) => console.log('  失败: ' + f)); process.exit(1); }
console.log('全部通过');
