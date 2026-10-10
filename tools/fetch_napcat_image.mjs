// fetch_napcat_image.mjs -- 通过 NapCat 的 OneBot WS 取回某条消息里的原图
//
// 为什么需要它：MimirLink 把图片段的 url/file 剥掉了，DB 里只剩
//   {"type":"image","summary":"","readableText":"图片"}
// 本地也没有图片缓存（enableLocalFile2Url:false、NapCat 没开 HTTP 口）。
// 但 NapCat 的 OneBot WS 还在（ws://127.0.0.1:4242），可以直接 get_msg
// 拿回带新 rkey 的 CDN url。
//
// ⚠ 这会**另开一条** WS 连接；MimirLink 那条不受影响（NapCat 支持多客户端）。
//
// 用法: node fetch_napcat_image.mjs <message_id> [outfile]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('file:///C:/Users/20633/MimirLink-soyo/');
const WebSocket = require('ws');

const WS = 'ws://127.0.0.1:4242';
// OneBot access_token 从实例配置里读 —— 本文件会发布到公开仓库，不能硬编码。
// （以前写成 const TOKEN = '<真实 token>'，2026-10-11 修）
const TOKEN = JSON.parse(
    fs.readFileSync('C:/Users/20633/MimirLink-soyo/config.json', 'utf8')
).onebot?.accessToken || '';
const mid = process.argv[2];
const out = process.argv[3] || 'C:/Users/20633/WorkBuddy/2026-05-28-17-36-40/mimir-tools/_napcat_img.bin';
if (!mid) { console.error('usage: node fetch_napcat_image.mjs <message_id> [outfile]'); process.exit(2); }

const ws = new WebSocket(WS, { headers: { Authorization: `Bearer ${TOKEN}` } });
let done = false;
const finish = (code) => { if (!done) { done = true; try { ws.close(); } catch {} setTimeout(() => process.exit(code), 100); } };

ws.on('open', () => {
  console.log('已连上', WS);
  ws.send(JSON.stringify({ action: 'get_msg', params: { message_id: Number(mid) }, echo: 'g1' }));
});

ws.on('message', async (buf) => {
  let msg;
  try { msg = JSON.parse(buf.toString()); } catch { return; }
  if (msg.echo !== 'g1') return;
  console.log('status:', msg.status, 'retcode:', msg.retcode);
  const data = msg.data || {};
  const segs = data.message || [];
  const imgs = segs.filter((s) => s.type === 'image');
  if (!imgs.length) {
    console.log('这条消息里没有 image 段。全部段类型:', segs.map((s) => s.type).join(','));
    console.log(JSON.stringify(data).slice(0, 600));
    return finish(1);
  }
  for (const im of imgs) {
    const d = im.data || {};
    console.log('--- image 段 ---');
    for (const k of ['file', 'file_size', 'url', 'summary', 'sub_type']) {
      if (d[k] !== undefined) console.log(`  ${k}: ${String(d[k]).slice(0, 220)}`);
    }
    if (!d.url) { console.log('  (没有 url)'); continue; }
    try {
      const r = await fetch(d.url);
      console.log('  HTTP', r.status, r.headers.get('content-type'));
      const ab = await r.arrayBuffer();
      fs.writeFileSync(out, Buffer.from(ab));
      console.log(`  已保存 ${out}  ${ab.byteLength} bytes`);
    } catch (e) {
      console.log('  下载失败:', e.message);
    }
  }
  finish(0);
});

ws.on('error', (e) => { console.error('WS 错误:', e.message); finish(3); });
setTimeout(() => { console.error('超时'); finish(4); }, 30000);
