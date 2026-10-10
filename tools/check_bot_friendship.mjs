/**
 * Can the two bots private-message each other?
 * A private send only works between QQ friends, so ask each NapCat for its friend list
 * and look for the other bot's account.
 *
 *   4242 = soyo account 3628056487
 *   2424 = anon account 2458713318
 *
 *   node check_bot_friendship.mjs
 */
import fs from 'node:fs';

// OneBot access_token 从实例配置里读 —— 本文件会发布到公开仓库，不能硬编码。
// （以前写成 const TOKEN = '<真实 token>'，2026-10-11 修）
const TOKEN = JSON.parse(
    fs.readFileSync('C:/Users/20633/MimirLink-soyo/config.json', 'utf8')
).onebot?.accessToken || '';
const TARGETS = [
    { name: 'soyo', port: 4242, self: '3628056487', other: '2458713318' },
    { name: 'anon', port: 2424, self: '2458713318', other: '3628056487' },
];

let failed = 0;
const check = (ok, label, extra = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
    if (!ok) failed++;
};

const call = (port, action) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?access_token=${TOKEN}`);
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve({ error: 'timeout' }); }, 8000);
    ws.onopen = () => ws.send(JSON.stringify({ action, echo: 'x' }));
    ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(String(ev.data)); } catch { return; }
        if (msg.echo !== 'x') return;
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve(msg);
    };
    ws.onerror = () => { clearTimeout(timer); resolve({ error: 'ws_error' }); };
});

for (const t of TARGETS) {
    console.log(`===== ${t.name} (self ${t.self}) on :${t.port} =====`);
    const info = await call(t.port, 'get_login_info');
    if (info.error || !info.data) {
        console.log(`  [SKIP] cannot reach :${t.port} (${info.error || 'no data'})`);
        failed++;
        console.log('');
        continue;
    }
    console.log(`  login: ${info.data.user_id} / ${info.data.nickname}`);

    const friends = await call(t.port, 'get_friend_list');
    if (friends.error || !Array.isArray(friends.data)) {
        console.log(`  [FAIL] get_friend_list failed (${friends.error || 'not an array'})`);
        failed++;
        console.log('');
        continue;
    }
    const ids = friends.data.map((f) => String(f.user_id));
    console.log(`  friends: ${ids.length}`);
    check(ids.includes(t.other), `is a friend of the other bot (${t.other})`,
        ids.includes(t.other) ? '' : 'NOT a friend');
    console.log('');
}

console.log(failed === 0
    ? 'BOTH ARE FRIENDS -- private hand-off is possible'
    : `${failed} issue(s) -- private hand-off would FAIL`);
process.exit(failed === 0 ? 0 : 1);
