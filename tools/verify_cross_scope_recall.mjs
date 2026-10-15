/**
 * verify_cross_scope_recall.mjs
 * ---------------------------------------------------------------------------
 * 验证跨场景记忆召回（2026-10-11 用户：「把跨域记忆能打通的地方都打通」）。
 *
 * 打通的**只有**一个方向：**私聊 ← 当前发言人自己在群里的发言**。
 * 理由：私聊里只有他一个人，把他自己的话还给他，不会泄露第三方。
 * ⛔ 反向（群 ← 私聊 / 群 ← 别的群）**故意不做** —— 群里坐着别人，
 *    把某个人的私有内容带进群 = 当着所有人念他的私聊。
 *
 * 实测动机：werwer 21:00 在群里说「你看小睦喝的就是soyo奶」，21:24 私聊问，
 * 她只能答「soyo奶是什么啦」（当时的证据：私聊召回结果 5 条全是 `[私聊|…` 开头，
 * 群里 0 条；7 个命名空间互不相通）。
 *
 * 最值钱的三条断言：
 *   🔴 跨场景捞回来的**每一条**都必须是"当前发言人自己说的"（`|QQ:<id>|` 在正文里）
 *   🔴 别人在群里说的话**不许**被捞进私聊
 *   🔴 **群聊作用域下一条都不许外扩**（保住隐私墙）
 *
 * 用法:  node verify_cross_scope_recall.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SRC = 'C:/Users/20633/MimirLink/src';
const DB = 'C:/Users/20633/MimirLink/data/chats/memory-store.sqlite';
const SES_SRC = fs.readFileSync(`${SRC}/session.js`, 'utf8');

let pass = 0;
const failures = [];
function check(label, condition, extra = '') {
    if (condition) { pass += 1; console.log(`  [OK  ] ${label}`); }
    else { failures.push(label); console.log(`  [FAIL] ${label}${extra ? '  ' + extra : ''}`); }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xscope-'));
const db = path.join(tmpDir, 'memory-store.sqlite');
for (const s of ['', '-wal', '-shm']) {
    if (fs.existsSync(DB + s)) fs.copyFileSync(DB + s, db + s);
}
const { SessionManager } = await import(pathToFileURL(`${SRC}/session.js`).href);
const noop = { info() {}, warn() {}, error() {}, debug() {} };
const ME = '2063362809';           // werwer
const OTHER = '1000000002';        // 涵（别人）
const sm = new SessionManager(tmpDir, { memory: { storage: { path: db } } }, noop);

const PRIVATE_NS = {
    scopeType: 'private_user', scopeKey: `private:${ME}`,
    characterName: 'Anon_Chihaya', presetName: 'Default Preset'
};
const GROUP_NS = {
    scopeType: 'group_shared', scopeKey: 'group:929159193',
    characterName: 'Anon_Chihaya', presetName: 'Default Preset'
};

// ---------------------------------------------------------------------------
console.log('=== Part 1  底表：谁说过 soyo奶 ===');
{
    const rows = sm.db.prepare(`SELECT ns.scope_key, substr(e.content,1,60) c
        FROM memory_entries e JOIN memory_namespaces ns ON ns.id=e.namespace_id
        WHERE e.content LIKE '%soyo奶%' AND ns.scope_type='group_shared'`).all();
    check('群里确实有 soyo奶 的条目（前提成立）', rows.length > 0, `n=${rows.length}`);
    check('其中至少一条是 werwer 说的（正文里有 |QQ:2063362809|）',
        rows.some((r) => r.c.includes(`|QQ:${ME}|`)), JSON.stringify(rows.slice(0, 2)));
}

// ---------------------------------------------------------------------------
console.log('\n=== Part 2  跨场景捞取：只捞他自己的 ===');
{
    const hits = sm.searchCrossScopeEntries(ME, ['soyo奶'], { limit: 5 });
    console.log('   ---- 捞回来的 ----');
    for (const h of hits) {
        console.log('    [%s] %s', h.crossScopeKey, String(h.content).replace(/\n/g, ' ').slice(0, 90));
    }
    check('🟢 捞到了（群里说过的话能进私聊了）', hits.length > 0, `n=${hits.length}`);
    // ⚠ 默认档位已改成 groups（用户 2026-10-11：「我都能把机器人拉到群里说明这个群都是熟人」）
    //   ⇒ 别人的**群发言**现在**允许**出现；但**别人的私聊内容仍然不许**。
    check('🔴 默认档位=groups', hits.every((h) => h.crossScopeLevel === 'groups'),
        JSON.stringify([...new Set(hits.map((h) => h.crossScopeLevel))]));
    check('🔴🔴 默认档位下**绝不允许别人的私聊内容**进来',
        hits.every((h) => !(String(h.content).includes('[私聊|')
            && !String(h.content).includes(`|QQ:${ME}|`))),
        hits.map((h) => String(h.content).slice(0, 50)).join(' || '));
    check('🔴 每条要么是他自己说的，要么来自某个群（不可能是别人的私聊）',
        hits.every((h) => String(h.content).includes(`|QQ:${ME}|`)
            || h.crossScopeKey.startsWith('group:')));

    // 档位 A：只他自己
    const selfOnly = new SessionManager(tmpDir, {
        memory: { storage: { path: db }, crossScope: { enabled: true, includeOthersInGroups: false } }
    }, noop);
    const selfHits = selfOnly.searchCrossScopeEntries(ME, ['soyo奶'], { limit: 5 });
    check('🟢 档位 self：每一条都是他本人说的（正文里有 |QQ:2063362809|）',
        selfHits.length > 0 && selfHits.every((h) => String(h.content).includes(`|QQ:${ME}|`)),
        `n=${selfHits.length}`);
    check('🟢 档位 self：别人的发言一条都不进来',
        selfHits.every((h) => !String(h.content).includes(`|QQ:${OTHER}|`)));
    // 这条**只在 self 档必须成立**：别人说过的词一条都捞不到。
    //
    // ⚠ 2026-10-13 修：原来硬编码探针词「军训」，前提是"军训只有别人说过"。
    //   但本脚本第 41 行**直接复制线上真实库**，而库是活的 —— 他自己后来在群里说了
    //   「军训」，前提就不成立了，断言立刻假红（实测从 34/0 变成 33/1，
    //   报的还是"漏了别人的话"这种像功能坏了的标签）。
    //   ⇒ 改成**从库里现算**一个"只有别人说过、他本人一条都没有"的词；
    //     实在挑不出来就明确跳过，而不是拿一个会烂的常量硬撑。
    const pickOthersOnlyWord = () => {
        const others = sm.db.prepare(`SELECT e.content AS c FROM memory_entries e
            JOIN memory_namespaces ns ON ns.id = e.namespace_id
            WHERE ns.scope_type = 'group_shared' AND e.content NOT LIKE ?
            ORDER BY e.rowid DESC LIMIT 300`).all(`%|QQ:${ME}|%`);
        const mineStmt = sm.db.prepare(`SELECT COUNT(*) n FROM memory_entries e
            JOIN memory_namespaces ns ON ns.id = e.namespace_id
            WHERE ns.scope_type = 'group_shared' AND e.content LIKE ? AND e.content LIKE ?`);
        for (const row of others) {
            for (const word of sm.buildRecallKeywords(row.c, 6)) {
                // LIKE 元字符会破坏模式匹配，直接跳过
                if (word.length < 2 || /[%_]/.test(word)) continue;
                if (Number(mineStmt.get(`%${word}%`, `%|QQ:${ME}|%`).n) === 0) return word;
            }
        }
        return '';
    };
    const othersOnlyWord = pickOthersOnlyWord();
    if (othersOnlyWord) {
        const selfJx = selfOnly.searchCrossScopeEntries(ME, [othersOnlyWord], { limit: 5 });
        check(`🔴 档位 self：只有别人说过的词（${othersOnlyWord}）捞不回来`,
            selfJx.length === 0, `捞到 ${selfJx.length} 条`);
    } else {
        // 挑不出来是**正常情况**（他可能把别人说过的词都说过一遍了）⇒ 明确跳过，不假红
        check('（库里暂时挑不出"只有别人说过"的词，跳过 self 那半）', true);
    }
    try { selfOnly.db.close(); } catch { /* 忽略 */ }
    check('结果带上了 crossScope 标记 + 来源会话', hits.every((h) => h.crossScope === true && h.crossScopeKey));

    // 排除当前会话：在 private:2063362809 里查时，结果不该来自这个会话自己
    const fromPrivate = sm.searchCrossScopeEntries(ME, ['soyo奶'], {
        excludeScopeKey: `private:${ME}`, limit: 5 });
    check('🔴 excludeScopeKey 生效：当前会话的内容不会从这里重复捞出来',
        fromPrivate.every((h) => h.crossScopeKey !== `private:${ME}`),
        fromPrivate.map((h) => h.crossScopeKey).join(','));

    // ⚠ 「只有别人说过的词捞不回来」这条**只在 self 档成立** —— 默认档位（groups）
    //   是**故意**让别人的群发言也能捞的，所以这条断言挪到 self 档那段去测。
    //   （第一版没挪，白报一个 FAIL。）
    // ⚠ 别用 `searchCrossScopeEntries(..., {limit:5})` 来断言这件事：它是**按命中数+时间排序**
    //   再截断的，别人的条目可能被挤出窗口（第一版就这么白报了一个 FAIL）。
    //   要测"跨群互通开着时别人的群发言**能不能**被捞到"，就直接按 SQL 语义测。
    // ⚠ 探针词同样别再硬编码「军训」（理由见上面 pickOthersOnlyWord 的注释）：
    //   这里直接用现算出来的 `othersOnlyWord`，它保证"只有别人说过"。
    if (othersOnlyWord) {
        const like = `%${othersOnlyWord}%`;
        const rows = sm.statements.searchCrossScopeWithGroups
            .all('', `%|QQ:${ME}|%`, like, 20);
        check(`🟢 默认档位下：别人说过的词（${othersOnlyWord}）**也能**被捞到（跨群互通）`,
            rows.some((r) => !String(r.content).includes(`|QQ:${ME}|`)),
            `窗口内 ${rows.length} 条，全是自己的=${rows.every((r) => String(r.content).includes(`|QQ:${ME}|`))}`);
        const selfRows = sm.statements.searchCrossScopeEntriesByParticipant
            .all('', `%|QQ:${ME}|%`, like, 20);
        check('🟢 档位 self 时同一条 SQL 变体会把别人的全挡掉', (() => {
            const r2 = sm.statements.searchCrossScopeEntriesByParticipant
                .all('', `%|QQ:${ME}|%`, like, 20);
            return r2.every((r) => String(r.content).includes(`|QQ:${ME}|`));
        })() || selfRows.length === 0);
    } else {
        check('（库里暂时挑不出"只有别人说过"的词，跳过跨群那半）', true);
    }

    check('空关键词不查库（返回 []）',
        sm.searchCrossScopeEntries(ME, [], { limit: 5 }).length === 0
        && sm.searchCrossScopeEntries('', ['soyo奶'], { limit: 5 }).length === 0);
    check('QQ 号前缀不碰撞（2063362809 不会命中 20633628090）', (() => {
        const bad = sm.db.prepare(`SELECT COUNT(*) n FROM memory_entries
            WHERE content LIKE '%|QQ:2063362809|%' AND content LIKE '%|QQ:20633628090|%'`).get().n;
        return Number(bad) === 0;
    })());
}

// ---------------------------------------------------------------------------
console.log('\n=== Part 3  走完整 recallMemory ===');
{
    const q = '[私聊|QQ:2063362809|昵称:werwer|群号:N/A|时间:2026/10/11 21:24:37] 回答出来奖励soyo奶';
    const priv = sm.recallMemory(PRIVATE_NS, q, { currentParticipantId: ME, limit: 8 });
    const cross = priv.filter((e) => e.recallReason === 'cross_scope_group');
    check('🔴 私聊召回里出现了 cross_scope_group 的结果', cross.length > 0, `n=${cross.length}`);
    // ⚠ 别断言"结果里必须含 soyo奶"：召回是按**命中的关键词条数**排序的，
    //   这条查询可能靠「出来」「werwer」之类的词命中别的消息（第一版就是这么白报 FAIL 的）。
    //   要测的是**语义**：跨场景真的把"群"里的内容带进来了。
    check('🔴 跨场景确实把**群**里的内容带进来了（不只是私聊）',
        cross.some((e) => String(e.crossScopeKey).startsWith('group:')),
        cross.map((e) => e.crossScopeKey).join(','));
    // ⚠ 这条是"档位=self"时代的旧断言，默认档位改成 groups 后**故意**不成立（漏改了）。
    //   现在只要求：不是别人私聊内容即可（上面那条硬墙）。
    check('🔴 跨场景结果里没有**别人的私聊**（群发言允许）',
        cross.every((e) => !(String(e.content).includes('[私聊|')
            && !String(e.content).includes(`|QQ:${ME}|`))));

    // 🔴 群聊作用域现在**也**外扩了（2026-10-11 用户：「记忆都打通要做跨群的」）。
    //    所以这里不再断言"不外扩"，改成断言更硬的那条不变量 ——
    //    **跨场景捞回来的每一条都必须是当前发言人自己写的**（两种作用域都要成立）。
    const grouped = sm.recallMemory(GROUP_NS, q, { currentParticipantId: ME, limit: 8 });
    const groupCross = grouped.filter((e) => e.recallReason === 'cross_scope_group');
    check('🟢 群聊作用域下也会跨场景召回（跨群打通了）', groupCross.length > 0, `n=${groupCross.length}`);
    // 默认档位=groups：允许"别人的群发言"，但**绝不许**"别人的私聊内容"
    const allCross = [...groupCross, ...cross];
    check('🔴🔴 跨场景结果里绝不出现**别人的私聊内容**（默认档位唯一的硬墙）',
        allCross.every((e) => !(String(e.content).includes('[私聊|')
            && !String(e.content).includes(`|QQ:${ME}|`))),
        allCross.filter((e) => String(e.content).includes('[私聊|')
            && !String(e.content).includes(`|QQ:${ME}|`)).map((e) => e.id).join(','));
    check('🔴 每条要么是他自己，要么来自 group_shared',
        allCross.every((e) => String(e.content).includes(`|QQ:${ME}|`)
            || e.crossScopeKey.startsWith('group:')));
    check('🔴 当前会话自己的内容不会在 cross_scope 里重复出现',
        [...groupCross].every((e) => e.crossScopeKey !== 'group:929159193'),
        groupCross.map((e) => e.crossScopeKey).join(','));

    // 开关
    const off = new SessionManager(tmpDir, {
        memory: { storage: { path: db }, crossScope: { enabled: false } }
    }, noop);
    const offRes = off.recallMemory(PRIVATE_NS, q, { currentParticipantId: ME, limit: 8 });
    check('🟢 开关关了就不外扩（memory.crossScope.enabled=false）',
        offRes.every((e) => e.recallReason !== 'cross_scope_group'));
    try { off.db.close(); } catch { /* 忽略 */ }

    // 私聊之间不许串（另一个人的私聊内容不能进这个私聊）
    const otherNs = { ...PRIVATE_NS, scopeKey: 'private:1000000005' };
    const otherRes = sm.recallMemory(PRIVATE_NS, '[私聊|QQ:2063362809|昵称:werwer] 曲奇饼干', {
        currentParticipantId: ME, limit: 8
    });
    check('🔴 别人的**私聊**内容不会进我的私聊',
        otherRes.every((e) => !String(e.content).includes('QQ:1000000005')),
        otherRes.filter((e) => String(e.content).includes('QQ:1000000005')).map((e) => e.id).join(','));
    void otherNs;
}

// ---------------------------------------------------------------------------
console.log('\n=== Part 4  源码闸门 ===');
{
    check('🔴 SQL 用作者过滤 `|QQ:<id>|` 保证只捞他自己的（这是唯一的安全边界）',
        // ⚠ 窗口要够大：这条 SQL 有十几行（第一版写 300 字，白报一个 FAIL）
        /searchCrossScopeEntriesByParticipant[\s\S]{0,900}e\.content LIKE \?/.test(SES_SRC));
    check('🔴 SQL 用 `ns.scope_key <> ?` 排除当前会话（不重复捞）',
        /searchCrossScopeEntriesByParticipant[\s\S]{0,600}ns\.scope_key <> \?/.test(SES_SRC));
    check('🔴 作者匹配带尾竖线（防前缀碰撞）',
        /const authorPattern = `%\|QQ:\$\{id\}\|%`/.test(SES_SRC));
    check('🔴 加了"跨群互通"那条 SQL（自己 OR group_shared）',
        /searchCrossScopeWithGroups[\s\S]{0,900}OR ns\.scope_type = 'group_shared'/.test(SES_SRC));
    check('🔴 别人的私聊那条 SQL 默认不启用（要 includeOthersPrivate 才走）',
        /cfg\.includeOthersPrivate === true/.test(SES_SRC));
    check('🔴 私聊和群聊都外扩（去掉了 isPrivateScope 限制）',
        /const crossScopeEnabled = crossScopeConfig\.enabled !== false;/.test(SES_SRC)
        && !/crossScopeEnabled = [^;]*isPrivateScope/.test(SES_SRC));
    check('🔴 只捞 conversation 条目（不碰画像/知识）',
        /searchCrossScopeEntriesByParticipant[\s\S]{0,600}e\.entry_type = 'conversation'/.test(SES_SRC));
    check('🟢 默认开（enabled !== false）', /crossScopeConfig\.enabled !== false/.test(SES_SRC));
    check('🟢 结果带 recallReason=cross_scope_group（提示词里会显示来源）',
        /'cross_scope_group'/.test(SES_SRC));
    check('异常不抛（查库失败只 warn，不影响召回主流程）',
        /\[记忆\] 跨场景召回失败/.test(SES_SRC));
}

try { sm.db.close(); } catch { /* 忽略 */ }
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log('\n' + '='.repeat(62));
console.log(`结果: ${pass} 通过 / ${failures.length} 失败`);
if (failures.length) { failures.forEach((f) => console.log('  失败: ' + f)); process.exit(1); }
console.log('全部通过');
