/**
 * verify_command_no_memory.mjs
 * ---------------------------------------------------------------------------
 * 用户要求：「这几个指令的消息不要弄到记忆里面去了」。
 *
 * 为什么不能只读代码就答
 * ----------------------
 * 读代码能看出 `handleMessage` 里的指令派发在 `maybeStoreUntriggeredMessage()` 与
 * `processBatch()`（它才调 `addMessage`）之前 ⇒ 命中指令就 `return`，不入库。
 * 但**"读起来是"和"真的是"是两件事**，而这个项目已经踩过太多次"看起来对、实际静默
 * 出问题"的坑。所以这里造一个**假 OneBot 服务端**，把真的 MimirLink 起起来，
 * 打真消息进去，然后直接查数据库有没有多东西。
 *
 * 关键设计：**带阴性对照**
 * ----------------------
 * 只断言"指令之后数据库没变"是**没有意义的** —— 万一整条链路根本没跑通（进程没起来、
 * WS 收到但没处理、库连接坏了），一样会"没变"，测试全绿而实际上什么都没验证。
 * 所以多加一步：发一条**群里没 @ 也没关键词**的消息，它必须被打进库（被动入库路径）。
 * 那一步绿了，前面那些"没变"才算数。
 *
 * 探针用**全新的 QQ 号**（不是已有联系人），否则 `participant_contacts` 本来就有一行，
 * 断言"没新增"会因为撞上已有行而变得没有分辨力。
 *
 * ⚠ 会临时改 soyo 的 `config.json`（改 WS 地址和 adminUsers），跑完在 `finally` 里还原
 *   并用 sha256 校验还原结果。**只在 soyo（8002）上跑，绝不碰 8001 上正在用的实例。**
 *
 * 用法:  node verify_command_no_memory.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const MIMIR = 'C:/Users/20633/MimirLink';
const SOYO = path.join(path.dirname(MIMIR), 'MimirLink-soyo');
const CFG_PATH = path.join(SOYO, 'config.json');
const DB_PATH = path.join(SOYO, 'data', 'chats', 'memory-store.sqlite');
const WS_PORT = 14242;

// 探针：全新的 QQ 号，确保"没新增"是有分辨力的
const PROBE_ADMIN_QQ = 777666555;
const PROBE_GROUP_ID = 888777666;
const NEGCTRL_USER_QQ = 999888777;
const GATE_USER_QQ = 555444333;   // 群聊 @ 闸门探针（不是管理员）
const NEGCTRL_TEXT = 'E2E阴性对照探针_7f3a1c';

let pass = 0;
const failures = [];
function check(label, condition, extra = '') {
    if (condition) { pass += 1; console.log(`  [OK  ] ${label}`); }
    else { failures.push(label); console.log(`  [FAIL] ${label}${extra ? '  ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
const DB = (await import('file:///C:/Users/20633/MimirLink/node_modules/better-sqlite3/lib/index.js')).default;
const WS = (await import('file:///C:/Users/20633/MimirLink/node_modules/ws/index.js')).default;

function snapshot() {
    const d = new DB(DB_PATH, { readonly: true });
    const q = (sql, ...args) => d.prepare(sql).get(...args).n;
    const s = {
        messages: q('SELECT COUNT(*) n FROM messages'),
        assistant: q("SELECT COUNT(*) n FROM messages WHERE role='assistant'"),
        memory: q('SELECT COUNT(*) n FROM memory_entries'),
        contacts: q('SELECT COUNT(*) n FROM participant_contacts'),
        probeContact: q('SELECT COUNT(*) n FROM participant_contacts WHERE participant_id = ?', String(PROBE_ADMIN_QQ)),
        probeRows: q('SELECT COUNT(*) n FROM messages WHERE content LIKE ?', `%${PROBE_ADMIN_QQ}%`)
    };
    d.close();
    return s;
}

const backupText = fs.readFileSync(CFG_PATH, 'utf8');
const backupHash = crypto.createHash('sha256').update(backupText).digest('hex');
fs.writeFileSync(`${CFG_PATH}.bak-e2e`, backupText);

const cfg = JSON.parse(backupText);
cfg.onebot.url = `ws://127.0.0.1:${WS_PORT}`;
cfg.chat.adminUsers = [String(PROBE_ADMIN_QQ)];
// 阴性对照要的：群里不 @ 就跳过（走被动入库那条路，且不需要 LLM）
cfg.chat.requireAtInGroup = true;
cfg.chat.accessControlMode = 'disabled';
cfg.chat.ignoreGroupMessages = false;
cfg.ojFeedback = { ...(cfg.ojFeedback || {}), enabled: false };
cfg.chat.emojiReaction = false;   // 少一种要应答的 API，别干扰观察
fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));

const before = snapshot();

// ---------------------------------------------------------------------------
// Part 0：静态护栏 —— 便宜、快、失败信息直指原因。
// 端到端那部分才是真证据，但它慢（~40s）且有副作用（临时改 config），
// 所以先来一道源码顺序闸门：指令派发必须整体排在"入库两条路"之前。
console.log('\n=== Part 0  源码顺序护栏（指令派发必须在入库之前）===');
{
    const idxSrc = fs.readFileSync(path.join(MIMIR, 'src', 'index.js'), 'utf8');
    const start = idxSrc.indexOf('async function handleMessage(event) {');
    const end = idxSrc.indexOf("bot.on('message'");
    const body = idxSrc.slice(start, end);
    check('能切出 handleMessage 函数体', start > 0 && end > start);

    // 入库只有两条路：被动入库（maybeStoreUntriggeredMessage）与批量处理（runtime.enqueue
    // → processBatch → addMessage）。指令必须两条都在前面。
    const storeAt = body.indexOf('maybeStoreUntriggeredMessage({');
    const enqueueAt = body.indexOf('runtime.enqueue({');
    check('找到被动入库调用点', storeAt > 0);
    check('找到批量入队调用点', enqueueAt > 0);
    check('🔴 handleMessage 里**没有**直接 addMessage（入库全在 processBatch 里）',
        !body.includes('addMessage('), `出现 ${body.split('addMessage(').length - 1} 次`);

    const calls = [...body.matchAll(/await (handle\w+)\(event, commandInput\)/g)];
    check('切到所有指令处理调用点（≥5 个）', calls.length >= 5, `实际 ${calls.length}`);
    const tooLate = calls.filter((m) => m.index > storeAt || m.index > enqueueAt).map((m) => m[1]);
    check('🔴 每条指令都在被动入库与批量入队之前 return（否则指令会被写进历史）',
        tooLate.length === 0, `排在后面的有: ${tooLate.join(', ')}`);
    for (const m of calls) {
        check(`  · ${m[1]} 在入库之前`, m.index < storeAt && m.index < enqueueAt);
    }
}

console.log('\n=== 前置：探针 QQ 必须是全新的，否则断言没有分辨力 ===');
check(`探针 ${PROBE_ADMIN_QQ} 在 participant_contacts 里原本不存在`, before.probeContact === 0);
check(`探针 ${PROBE_ADMIN_QQ} 原本没有任何消息`, before.probeRows === 0);
console.log(`  （基线）messages=${before.messages} assistant=${before.assistant} `
    + `memory_entries=${before.memory} contacts=${before.contacts}`);

// ---------------------------------------------------------------------------
// 假 OneBot：只做三件事 —— 应答所有 API、记录机器人发出去的消息、把事件喂回去
const outbound = [];
let wsClient = null;
let sawLoginInfo = false;
const wss = new WS.WebSocketServer({ port: WS_PORT });
wss.on('connection', (socket) => {
    wsClient = socket;
    socket.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        // 事件（没有 action）：忽略
        if (!msg.action) return;
        if (msg.action === 'get_login_info') sawLoginInfo = true;
        if (msg.action === 'send_private_msg' || msg.action === 'send_group_msg') {
            outbound.push({ action: msg.action, params: msg.params });
        }
        const data = msg.action === 'get_login_info'
            ? { user_id: 3628056487, nickname: 'Nagasaki_soyo' }
            : (msg.action === 'get_group_list' || msg.action === 'get_friend_list' ? [] : {});
        socket.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: msg.echo }));
    });
});

function sendEvent(event) {
    wsClient.send(JSON.stringify(event));
}

/**
 * 把发出去的消息取成纯文本。
 * ⚠ 出站 message 是**分段数组**（`[{type:'reply'},{type:'text',data:{text}}]`），
 *   `String(msg)` 会得到 `[object Object],[object Object]` —— 第一次跑就栽在这，
 *   4 条断言全红而实际功能是好的。
 */
function textOf(message) {
    if (typeof message === 'string') return message;
    if (!Array.isArray(message)) return '';
    return message
        .map((seg) => (seg?.type === 'text' ? String(seg?.data?.text ?? '') : ''))
        .join('');
}

function privateText(text, userId = PROBE_ADMIN_QQ, messageId = Date.now()) {
    return {
        post_type: 'message', message_type: 'private', sub_type: 'friend',
        self_id: 3628056487, user_id: userId, message_id: messageId,
        raw_message: text, time: Math.floor(Date.now() / 1000),
        message: [{ type: 'text', data: { text } }],
        sender: { user_id: userId, nickname: 'E2E探针' }
    };
}

function groupText(text, userId = NEGCTRL_USER_QQ, messageId = Date.now(), withAt = false) {
    const message = [];
    if (withAt) {
        // 只有带 at 段时 isAtMe 才为真（extractMessageInfo 只认 at.qq === bot.selfId）
        message.push({ type: 'at', data: { qq: '3628056487' } });
    }
    message.push({ type: 'text', data: { text } });
    return {
        post_type: 'message', message_type: 'group', sub_type: 'normal',
        self_id: 3628056487, user_id: userId, group_id: PROBE_GROUP_ID,
        message_id: messageId, raw_message: withAt ? `[CQ:at,qq=3628056487]${text}` : text,
        time: Math.floor(Date.now() / 1000),
        message,
        sender: { user_id: userId, nickname: 'E2E探针', card: 'E2E探针', role: 'member' }
    };
}

async function waitForReply(countBefore, timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (outbound.length > countBefore) return outbound.slice(countBefore);
        await sleep(200);
    }
    return outbound.slice(countBefore);
}

const childLog = [];
let child = null;
let restored = false;

try {
    console.log('\n=== 启动真 MimirLink（soyo 实例，连假 OneBot）===');
    child = spawn(process.execPath, ['src/index.js'], { cwd: SOYO, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (b) => childLog.push(b.toString()));
    child.stderr.on('data', (b) => childLog.push(b.toString()));

    const bootDeadline = Date.now() + 30000;
    while (Date.now() < bootDeadline && !(wsClient && sawLoginInfo)) await sleep(300);
    check('机器人连上了假 OneBot 并完成 get_login_info', !!wsClient && sawLoginInfo,
        childLog.join('').slice(-400));

    // ── 1. /帮助 ───────────────────────────────────────────────────────────
    console.log('\n=== /帮助（管理员，私聊）===');
    let n0 = outbound.length;
    sendEvent(privateText('/帮助'));
    let replies = await waitForReply(n0);
    check('机器人回了 /帮助', replies.length > 0, '没有收到任何回复');
    const helpText = textOf(replies[0]?.params?.message);
    check('回复内容是帮助清单', helpText.includes('指令列表'), helpText.slice(0, 80));
    check('管理员看得到管理指令', helpText.includes('/名册'));
    check('回复走的是私聊', replies[0]?.action === 'send_private_msg', replies[0]?.action);

    // ── 2. /名册 ───────────────────────────────────────────────────────────
    console.log('\n=== /名册（管理员，私聊）===');
    n0 = outbound.length;
    sendEvent(privateText('/名册'));
    replies = await waitForReply(n0);
    check('机器人回了 /名册', replies.length > 0);
    const rosterText = textOf(replies[0]?.params?.message);
    check('回复是名册正文（QQ号 + 别称）', /她一共认识 \d+ 个人/.test(rosterText), rosterText.slice(0, 80));

    // ── 3. /思考 ───────────────────────────────────────────────────────────
    console.log('\n=== /思考（管理员，私聊）===');
    n0 = outbound.length;
    sendEvent(privateText('/思考'));
    replies = await waitForReply(n0);
    check('机器人回了 /思考 状态', textOf(replies[0]?.params?.message).includes('思考显示：'));

    await sleep(2500);   // 让可能的写库路径跑完

    // ── 4. 核心断言：指令没进任何一张表 ────────────────────────────────────
    console.log('\n=== 核心：指令消息与指令回复都不该进库 ===');
    const afterCmd = snapshot();
    check('🔴 messages 没增加（用户发的指令没被当成历史）',
        afterCmd.messages === before.messages,
        `${before.messages} -> ${afterCmd.messages}`);
    check('🔴 assistant 也没增加（指令回复没被当成"她说过的话"）',
        afterCmd.assistant === before.assistant,
        `${before.assistant} -> ${afterCmd.assistant}`);
    check('🔴 memory_entries 没增加（没进记忆副本）',
        afterCmd.memory === before.memory, `${before.memory} -> ${afterCmd.memory}`);
    check('🔴 探针 QQ 没被记进 participant_contacts（没进"她认识谁"）',
        afterCmd.probeContact === 0, `probeContact=${afterCmd.probeContact}`);
    check('🔴 库里搜不到探针 QQ 的痕迹', afterCmd.probeRows === 0, `probeRows=${afterCmd.probeRows}`);
    check('整体联系人数没变', afterCmd.contacts === before.contacts,
        `${before.contacts} -> ${afterCmd.contacts}`);

    // ── 5. 阴性对照：非指令消息必须被打进库 ────────────────────────────────
    console.log('\n=== 阴性对照：群里没 @ 没关键词的闲话，必须进库 ===');
    console.log('  （这一步绿了，上面那些"没变"才有意义）');
    sendEvent(groupText(NEGCTRL_TEXT));
    let grew = false;
    const negDeadline = Date.now() + 20000;
    while (Date.now() < negDeadline) {
        await sleep(600);
        if (snapshot().messages > afterCmd.messages) { grew = true; break; }
    }
    const afterNeg = snapshot();
    check('🔴 对照组把 messages 写进去了（证明观测链路有效）',
        grew, `${afterCmd.messages} -> ${afterNeg.messages}`);

    // ── 6. 🔴 群聊 @ 闸门：没 @ 不认指令，@ 了才认 ──────────────────────────
    console.log('\n=== 群聊 @ 闸门（用户 2026-10-12 要求：指令在群里只有 @ 才触发）===');
    // ⚠ 两次探针必须用**不同文本**：`dedupeWindowMs` 默认 10s，同一人同一句连着发
    //   第二条会被去重掉，测出来就是"@ 了也不回"的假失败（第一次跑就栽在这）。
    const gateBase = outbound.length;
    sendEvent(groupText('/反馈', GATE_USER_QQ));          // 群里发指令，但没 @
    await sleep(4000);
    check('🔴 群里没 @ ⇒ 指令不执行（她不许开口）',
        outbound.length === gateBase, `多发了 ${outbound.length - gateBase} 条`);

    n0 = outbound.length;
    sendEvent(groupText('/帮助', GATE_USER_QQ, Date.now(), true));   // 换一条指令 + 带上 @
    replies = await waitForReply(n0, 20000);
    check('🔴 群里 @ 了 ⇒ 指令执行', replies.length > 0, '没有收到任何回复');
    const groupHelp = textOf(replies[0]?.params?.message);
    check('回复走群聊', replies[0]?.action === 'send_group_msg', replies[0]?.action);
    check('非管理员在群里拿到的是精简版（看不到 /名册）',
        groupHelp.includes('指令列表') && !groupHelp.includes('/名册'), groupHelp.slice(0, 90));

    console.log('\n  ---- 机器人日志里的路由结论 ----');
    const logText = childLog.join('');
    for (const line of logText.split('\n')) {
        if (/路由|跳过|passive|未触发|触发/.test(line)) console.log('  | ' + line.trim().slice(0, 140));
    }
} finally {
    // ── 清理 ───────────────────────────────────────────────────────────────
    console.log('\n=== 清理 ===');
    if (child) { child.kill('SIGKILL'); await sleep(500); }
    try { wss.close(); } catch { /* ignore */ }

    try {
        const d = new DB(DB_PATH);
        const del = (sql, ...args) => d.prepare(sql).run(...args).changes;
        const c1 = del("DELETE FROM messages WHERE content LIKE ?", `%${NEGCTRL_TEXT}%`);
        const c2 = del('DELETE FROM messages WHERE content LIKE ?', `%${NEGCTRL_USER_QQ}%`);
        const c3 = del("DELETE FROM memory_entries WHERE content LIKE ?", `%${NEGCTRL_TEXT}%`);
        const c4 = del('DELETE FROM participant_contacts WHERE participant_id = ?', String(NEGCTRL_USER_QQ));
        // 闸门探针（群里那两条 /帮助 会被当成"未触发消息"入库，必须清掉）
        const c5 = del('DELETE FROM messages WHERE content LIKE ?', `%${GATE_USER_QQ}%`);
        const c6 = del("DELETE FROM memory_entries WHERE content LIKE ?", `%${GATE_USER_QQ}%`);
        const c7 = del('DELETE FROM participant_contacts WHERE participant_id = ?', String(GATE_USER_QQ));
        d.close();
        console.log(`  清掉对照/闸门残留: messages=${c1 + c2 + c5} memory_entries=${c3 + c6} contacts=${c4 + c7}`);
    } catch (error) {
        console.log('  清理失败（手工看一眼）: ' + error.message);
    }

    // 还原配置并校验
    try {
        fs.copyFileSync(`${CFG_PATH}.bak-e2e`, CFG_PATH);
        const nowHash = crypto.createHash('sha256').update(fs.readFileSync(CFG_PATH, 'utf8')).digest('hex');
        restored = nowHash === backupHash;
        console.log(`  soyo config.json 还原: ${restored ? '一致 ✓' : '不一致 !!'}`);
        if (restored) fs.unlinkSync(`${CFG_PATH}.bak-e2e`);
    } catch (error) {
        console.log('  !! 配置还原失败，请手工处理: ' + error.message);
    }
}
check('soyo config.json 已还原（sha256 与跑之前一致）', restored);

console.log(`\n=== 汇总: ${pass} 通过 / ${failures.length} 失败 ===`);
if (failures.length > 0) {
    console.log('失败项:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exitCode = 1;
}
