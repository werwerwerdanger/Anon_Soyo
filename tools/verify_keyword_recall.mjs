// verify_keyword_recall.mjs -- 断言 keyword-recall 补丁生效且没有副作用
// 用法: node verify_keyword_recall.mjs [soyo|anon|both]
import fs from 'node:fs';
import path from 'node:path';
import { SessionManager } from 'file:///C:/Users/20633/MimirLink-soyo/src/session.js';
import { SessionManager as AnonSM } from 'file:///C:/Users/20633/MimirLink/src/session.js';

// ⚠ 2026-10-13 修：这里原来读 `_prod_query.txt` —— 一个 `_*` 前缀的一次性产物，
// 而且内容根本不对口：那是 2026-10-10 **群 929159193** 的发言，本脚本查的却是
// **私聊 private:2063362809**。两个作用域不重叠 ⇒ 必然 0 命中，报出来却是
// 「3 关键词检索命中 0」+「5a recallMemory 有返回 n=0」，看着像召回功能坏了，
// 其实只是探针文本跟被测作用域八竿子打不着。
//
// 新取法**自愈**：从被测作用域里挑最近一条**正文够长**的真实记忆条目当探针，
// 并把它的 `时间:` 字段改掉 —— 于是
//   ① 整段当 LIKE 模式仍然 0 命中（原脚本要对比的正是这个）；
//   ② 逐关键词检索必然命中（关键词本来就抽自这条真实文本）。
// 库里的数据怎么涨跌都不会再假报。
function pickProbe(sm, scopeKey, characterName, presetName) {
  const rows = sm.db.prepare(
    'SELECT m.content AS content FROM memory_entries m'
    + ' JOIN memory_namespaces ns ON ns.id = m.namespace_id'
    + ' WHERE ns.scope_key = ? AND ns.character_name = ? AND ns.preset_name = ?'
    + ' ORDER BY m.rowid DESC LIMIT 200'
  ).all(scopeKey, characterName, presetName);
  for (const row of rows) {
    const body = String(row.content || '').split(']] ').slice(1).join(']] ').trim();
    if (body.length >= 6) {
      return String(row.content).replace(/时间:[^|]*/, '时间:2000/01/01 00:00:00');
    }
  }
  return '';
}

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${extra ? '  <- ' + extra : ''}`); }
};

function build(which) {
  const ROOT = which === 'soyo' ? 'C:/Users/20633/MimirLink-soyo' : 'C:/Users/20633/MimirLink';
  const SM = which === 'soyo' ? SessionManager : AnonSM;
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  // 🔴 2026-10-13 修（这是本脚本最大的一个坑，比断言过期严重得多）：
  //    config 里 `memory.storage.path` 是**相对路径** `./data/chats/memory-store.sqlite`，
  //    而 session.js 的 resolveDbPath() 对相对路径走 `path.resolve(process.cwd(), ...)`。
  //    本脚本在 mimir-tools/ 下跑 ⇒ cwd 是 mimir-tools ⇒ 解析成
  //      mimir-tools/data/chats/memory-store.sqlite
  //    —— **另一个库**。更糟的是 DatabaseSync 对不存在的路径会**静默新建空库**，
  //    所以这个脚本一直在对着一个幽灵库里断言（mimir-tools/data/chats/ 下那个
  //    2026-10-10 的 98304 字节文件就是证据），从不报错、只是"什么都查不到"。
  //    ⇒ 必须显式把 dbPath 覆盖成实例真实的库，并断言它真的存在。
  const dbPath = path.join(ROOT, 'data', 'chats', 'memory-store.sqlite');
  if (!fs.existsSync(dbPath)) throw new Error(`实例库不存在，别对着空库跑断言: ${dbPath}`);
  const scopedConfig = {
    ...config,
    memory: { ...(config.memory || {}), storage: { ...(config.memory?.storage || {}), path: dbPath } }
  };
  const sm = new SM(path.join(ROOT, 'data'), scopedConfig, { info() {}, warn() {}, error() {} });
  return { sm, config, dbPath };
}

for (const which of ['soyo', 'anon']) {
  console.log(`\n########## ${which} ##########`);
  const { sm, config } = build(which);

  // ⚠ 2026-10-13 修：角色名/预设名一律从 config 读。原来对**两个实例都**写死
  //    characterName: 'Soyo_Nagasaki'，但 anon 实例库里的命名空间是 Anon_Chihaya
  //    ⇒ 拼不出 ns id ⇒ 检索恒为 0 条，报出来却是「关键词检索命中 0」（像功能坏了）。
  //    实测：soyo 库 7 个 ns 全是 Soyo_Nagasaki，anon 库 9 个 ns 全是 Anon_Chihaya。
  //    路径是 chat.defaultCharacter（不是顶层 character.*），已核实。
  const CHAR = config.chat?.defaultCharacter || '';
  const PRESET = config.preset?.name || 'Default Preset';
  ok(!!CHAR, '0a 从 config 取到角色名', CHAR);
  const NS = {
    scopeType: 'private_user',
    scopeKey: 'private:2063362809',
    characterName: CHAR,
    presetName: PRESET
  };
  const RAW = pickProbe(sm, NS.scopeKey, NS.characterName, NS.presetName);
  ok(RAW.length > 0, '0b 从该作用域取到真实探针文本', `len=${RAW.length}`);

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
  const rawHits = sm.searchMemoryEntries(NS, RAW, 8).length;
  const kwHits = sm.searchMemoryEntriesByKeywords(NS, kws, 8).length;
  ok(kwHits > 0, `3 关键词检索命中 (整段=${rawHits} 关键词=${kwHits})`);
  console.log(`        （对照：整段当 LIKE 模式 = ${rawHits} 条）`);

  // ---- 4. 隔离：私聊 namespace 不许返回群聊条目
  const nsPriv = NS;
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
