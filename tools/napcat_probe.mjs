// Probe NapCat via OneBot WS: login info + group member status (read-only).
// Usage: node napcat_probe.mjs <wsUrl> <token> <groupId> <selfQq>
import WebSocket from 'file:///C:/Users/20633/MimirLink-soyo/node_modules/ws/index.js';

const [wsUrl, token, groupId, selfQq] = process.argv.slice(2);
if (!wsUrl || !token) {
  console.error('usage: node napcat_probe.mjs ws://127.0.0.1:4242 TOKEN GROUP SELFQQ');
  process.exit(1);
}

const url = `${wsUrl}/?access_token=${encodeURIComponent(token)}`;
const ws = new WebSocket(url);

let seq = 0;
const pending = new Map();

function call(action, params = {}) {
  const echo = `p${++seq}`;
  return new Promise((resolve, reject) => {
    pending.set(echo, { resolve, reject });
    ws.send(JSON.stringify({ action, params, echo }));
    setTimeout(() => {
      if (pending.has(echo)) {
        pending.delete(echo);
        reject(new Error(`timeout: ${action}`));
      }
    }, 12000);
  });
}

ws.on('open', async () => {
  console.log('WS opened');
  try {
    const me = await call('get_login_info');
    console.log('login_info:', JSON.stringify(me));

    if (groupId && selfQq) {
      const info = await call('get_group_member_info', {
        group_id: Number(groupId),
        user_id: Number(selfQq),
        no_cache: true,
      });
      const d = info?.data || {};
      const shut = d.shut_up_timestamp ?? 0;
      const now = Math.floor(Date.now() / 1000);
      console.log('self member:', JSON.stringify({
        card: d.card, nickname: d.nickname, role: d.role,
        level: d.level, shut_up_timestamp: shut,
      }));
      if (shut && shut > now) {
        console.log(`>>> MUTED for ${shut - now}s (until ${new Date(shut * 1000).toLocaleString()})`);
      } else {
        console.log('>>> NOT muted (shut_up_timestamp is in the past or 0)');
      }
      // 全员禁言?
      const gi = await call('get_group_info', { group_id: Number(groupId), no_cache: true });
      const g = gi?.data || {};
      console.log('group_info:', JSON.stringify({
        group_name: g.group_name, member_count: g.member_count,
        shut_up_all_timestamp: g.shut_up_all_timestamp,
        max_member_count: g.max_member_count,
      }));
      const allShut = g.shut_up_all_timestamp ?? 0;
      if (allShut && allShut > now) {
        console.log(`>>> GROUP IS ALL-MUTED (${allShut - now}s left) -- admins still can speak`);
      }
    }
  } catch (e) {
    console.error('ERR', e.message);
  } finally {
    ws.close();
    process.exit(0);
  }
});

ws.on('message', (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  if (msg.echo && pending.has(msg.echo)) {
    const { resolve } = pending.get(msg.echo);
    pending.delete(msg.echo);
    resolve(msg);
  }
});

ws.on('error', (e) => {
  console.error('WS error:', e.message);
  process.exit(2);
});

setTimeout(() => {
  console.error('hard timeout');
  process.exit(3);
}, 20000);
