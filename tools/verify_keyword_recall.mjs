// verify_keyword_recall.mjs -- 断言 keyword-recall 补丁生效且没有副作用
// 用法: node verify_keyword_recall.mjs [soyo|anon|both]
import fs from 'node:fs';
import path from 'node:path';
import { SessionManager } from 'file:///C:/Users/20633/MimirLink-soyo/src/session.js';
import { SessionManager as AnonSM } from 'file:///C:/Users/20633/MimirLink/src/session.js';

const QUERY_FILE = 'C:/Users/20633/WorkBuddy/2026-05-28-17-36-40/mimir-tools/_prod_query.txt';
const RAW = fs.readFileSync(QUERY_FILE, 'utf8');

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${extra ? '  <- ' + extra : ''}`); }
};

function build(which) {
  const ROOT = which === 'soyo' ? 'C:/Users/20633/MimirLink-soyo' : 'C:/Users/20633/MimirLink';
  const SM = which === 'soyo' ? SessionManager : AnonSM;
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const sm = new SM(path.join(ROOT, 'data'), config, { info() {}, warn() {}, error() {} });
  return { sm, config };
}

for (const which of ['soyo', 'anon']) {
  console.log(`\n########## ${which} ##########`);
  const { sm, config } = build(which);

  // ---- 1. 剥头
  const stripped = sm.stripStructuredHeaders(RAW);
  ok(!stripped.includes('私聊|QQ:'), '1a 结构化头被剥掉');
  ok(!stripped.includes('messageSegments'), '1b JSON 段被剥掉');
  ok(!/[\[\]{}]/.test(stripped), '1c 已无任何括号残留', stripped.slice(0, 60));
  ok(stripped.length > 0 && stripped.length < RAW.length, '1d 正文保留且变短',
     `${RAW.length} -> ${stripped.length}`);
  ok(/[一-龥]/.test(stripped), '1e 中文正文还在');

  // ---- 2. 抽词
  const kws = sm.buildRecallKeywords(RAW, 16);
  const noise = kws.filter((k) => ['私聊', 'qq', '昵称', '群号', '群名', '时间'].includes(k));
  ok(noise.length === 0, '2a 没有头部噪音词', JSON.stringify(noise));
  ok(kws.every((k) => !/^[0-9]+$/.test(k)), '2b 没有纯数字关键词', JSON.stringify(kws.filter((k) => /^[0-9]+$/.test(k))));
  ok(kws.length > 0, '2c 抽到了关键词', JSON.stringify(kws.slice(0, 8)));

  // ---- 3. 逐关键词检索确实能命中（原实现 0 命中）
  const rawHits = sm.searchMemoryEntries(
    { scopeType: 'private_user', scopeKey: 'private:2063362809', characterName: 'Soyo_Nagasaki', presetName: 'Default Preset' },
    RAW, 8).length;
  const kwHits = sm.searchMemoryEntriesByKeywords(
    { scopeType: 'private_user', scopeKey: 'private:2063362809', characterName: 'Soyo_Nagasaki', presetName: 'Default Preset' },
    kws, 8).length;
  ok(kwHits > 0, `3 关键词检索命中 (整段=${rawHits} 关键词=${kwHits})`);
  console.log(`        （对照：整段当 LIKE 模式 = ${rawHits} 条）`);

  // ---- 4. 隔离：私聊 namespace 不许返回群聊条目
  const nsPriv = { scopeType: 'private_user', scopeKey: 'private:2063362809', characterName: 'Soyo_Nagasaki', presetName: 'Default Preset' };
  const privRows = sm.searchMemoryEntriesByKeywords(nsPriv, ['小睦', '睦', 'soyo', '奶'], 6);
  const leaked = privRows.filter((r) => String(r.sourceSessionId || '').startsWith('group:'));
  ok(leaked.length === 0, '4a 私聊召回不串群聊', JSON.stringify(leaked.map((r) => r.sourceSessionId)));

  // ---- 5. recallMemory 端到端
  const recalled = sm.recallMemory(nsPriv, RAW, { limit: 8 });
  const matched = recalled.filter((r) => r.recallReason === 'keyword_match');
  ok(recalled.length > 0, '5a recallMemory 有返回', `n=${recalled.length}`);
  ok(matched.length > 0, '5b 出现 keyword_match 结果', `matched=${matched.length}`);
  ok(recalled.every((r) => Number.isFinite(r.recallScore)), '5c recallScore 全是数字');

  // ---- 6. 边界：空 query / 纯噪音 不许抛错
  for (const [label, q] of [['空串', ''], ['纯噪音头', '[私聊|QQ:1|昵称:a|群号:N/A|群名:N/A]']]) {
    let crashed = null;
    try { sm.recallMemory(nsPriv, q, { limit: 4 }); } catch (e) { crashed = e.message; }
    ok(!crashed, `6 ${label} 不抛错`, crashed || '');
  }
  let crashed2 = null;
  try { sm.searchMemoryEntriesByKeywords(nsPriv, [], 4); } catch (e) { crashed2 = e.message; }
  ok(!crashed2, '6c 空关键词列表不抛错', crashed2 || '');

  // ---- 7. 配置已调
  ok(config.chat.historyLimit === 100, '7a chat.historyLimit = 100', String(config.chat.historyLimit));
  ok(config.memory.summary.triggerMessages === 100, '7b triggerMessages = 100', String(config.memory.summary.triggerMessages));
  ok(config.memory.summary.keepRecent === 50, '7c keepRecent = 50', String(config.memory.summary.keepRecent));

  console.log(`\n  ${which}: PASS ${pass} / FAIL ${fail}`);
}

console.log(`\n===== 合计：PASS ${pass}，FAIL ${fail} =====`);
process.exit(fail === 0 ? 0 : 1);
