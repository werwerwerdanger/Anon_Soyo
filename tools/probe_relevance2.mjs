/**
 * Widen the sample so the relevance threshold comes from data, not taste.
 *
 * probe_relevance.mjs showed the gap on four queries. Four points is not
 * enough to pick a cut-off: the risk is a perfectly good result set scoring低
 * because the query happens to use wording the pages do not repeat, and that
 * would make the bot refuse to answer questions it could have answered.
 *
 * So this runs a wider set of realistic queries and reports, for each, the
 * BEST and MEAN score, then prints the worst good case and the best bad case.
 * The threshold has to sit in the gap between those two numbers.
 *
 * Rescored with three variants of the same idea to see which is most robust:
 *   best   -- highest single-result score. "Is ANY result on topic?"
 *   mean   -- average over all results. Sensitive to how many are junk.
 *   top3   -- mean of the best three. A compromise: ignores long junk tails
 *             without being decided by one lucky hit.
 *
 *     node probe_relevance2.mjs
 */
import { extractTerms, scoreResult, summarize } from './relevance_scorer.mjs';

const BASE = 'http://127.0.0.1:8888';

// GOOD = the engine this project trusts for that language.
// BAD  = an engine known to answer this query badly.
const CASES = [
    // --- CJK: 360search is the trusted engine, bing the known-bad one ------
    ['CJK', '成都理工大学 2026 年招生简章', '!360search', '!bing'],
    ['CJK', '蓝桥杯 2026 报名时间', '!360search', '!bing'],
    ['CJK', '成都理工大学 计算机学院 复试分数线', '!360search', '!bing'],
    ['CJK', '考研国家线 2026 公布时间', '!360search', '!bing'],
    ['CJK', '成都 明天 天气', '!360search', '!bing'],
    ['CJK', '王者荣耀 新英雄 上线时间', '!360search', '!bing'],
    ['CJK', '洛谷 P1001 A+B Problem 题解', '!360search', '!bing'],
    ['CJK', '数字电路 74LS161 计数器 进制', '!360search', '!bing'],
    ['CJK', '成都理工大学 宿舍 条件', '!360search', '!bing'],
    ['CJK', '六级 报名 时间 2026', '!360search', '!bing'],
    // --- Latin: yandex/bing are usable, sogou wechat is Chinese-only junk --
    ['LATIN', 'what is the capital of peru', '!yandex', '!sogou_wechat'],
    ['LATIN', 'rust borrow checker explained', '!bing', '!sogou_wechat'],
    ['LATIN', 'python asyncio timeout example', '!bing', '!sogou_wechat'],
    ['LATIN', 'latest stable node.js version', '!bing', '!sogou_wechat'],
];

async function search(bang, query, limit = 10) {
    const url = `${BASE}/search?` + new URLSearchParams({
        q: `${bang} ${query}`,
        format: 'json',
        categories: 'general',
        language: 'zh-cn',
        safesearch: '1',
        pageno: '1'
    });
    const body = await (await fetch(url)).json();
    return (body.results || []).slice(0, limit).map((r) => ({
        title: r.title || '', url: r.url || '', snippet: r.content || ''
    }));
}

function stats(query, results) {
    // uses the shared scorer so the numbers here match what the gate would see
    const terms = extractTerms(query);
    const scores = results.map((r) => scoreResult(terms, r));
    const sorted = [...scores].sort((a, b) => b - a);
    const top = sorted.slice(0, 3);
    return {
        terms: terms.length,
        n: results.length,
        best: sorted[0] ?? 0,
        mean: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
        top3: top.length ? top.reduce((a, b) => a + b, 0) / top.length : 0,
        scores, results
    };
}

const rows = [];
for (const [lang, query, goodBang, badBang] of CASES) {
    console.log('='.repeat(80));
    console.log(`[${lang}] ${query}`);
    console.log('='.repeat(80));
    for (const [label, bang] of [['GOOD', goodBang], ['BAD ', badBang]]) {
        let results;
        try {
            results = await search(bang, query);
        } catch (err) {
            console.log(`  ${label} ${bang}: request failed: ${err.message}`);
            continue;
        }
        if (!results.length) {
            console.log(`  ${label} ${bang}: 0 results (engine unavailable)`);
            continue;
        }
        const s = stats(query, results);
        rows.push({ lang, query, label: label.trim(), bang, ...s });
        console.log(`  ${label} ${bang}  n=${s.n} terms=${s.terms}  `
            + `best=${s.best.toFixed(2)} top3=${s.top3.toFixed(2)} mean=${s.mean.toFixed(2)}`);
        const worst = s.scores.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]).slice(0, 3);
        console.log(`      lowest 3: ${worst.map(([v, i]) =>
            `[${v.toFixed(2)}] ${s.results[i].title.slice(0, 40)}`).join('\n                ')}`);
    }
    console.log();
}

console.log('='.repeat(80));
console.log('SCORE TABLE');
console.log('='.repeat(80));
console.log('  %s  %s  %s', 'lang'.padEnd(6), 'set'.padEnd(5), 'query'.padEnd(34)
    + '    best  top3   mean');
for (const r of rows) {
    console.log('  %s  %s  %s  %5s %5s %6s',
        r.lang.padEnd(6), r.label.padEnd(5), r.query.slice(0, 32).padEnd(34),
        r.best.toFixed(2), r.top3.toFixed(2), r.mean.toFixed(2));
}

console.log();
console.log('='.repeat(80));
console.log('SEPARATION -- can a single threshold split GOOD from BAD?');
console.log('='.repeat(80));
for (const metric of ['best', 'top3', 'mean']) {
    const good = rows.filter((r) => r.label === 'GOOD').map((r) => r[metric]);
    const bad = rows.filter((r) => r.label === 'BAD').map((r) => r[metric]);
    if (!good.length || !bad.length) continue;
    const worstGood = Math.min(...good);
    const bestBad = Math.max(...bad);
    const ok = worstGood > bestBad;
    console.log(`\n  ${metric}:`);
    console.log(`    worst GOOD = ${worstGood.toFixed(2)}`);
    console.log(`    best  BAD  = ${bestBad.toFixed(2)}`);
    console.log(`    ${ok ? `GAP EXISTS -- any threshold in (${bestBad.toFixed(2)}, ${worstGood.toFixed(2)}] works. `
        + `Midpoint suggestion: ${(((bestBad + worstGood) / 2)).toFixed(2)}`
        : 'NO GAP -- this metric cannot separate the groups.'}`);
    if (!ok) {
        const offenders = rows.filter((r) => r[metric] >= worstGood && r.label === 'BAD');
        for (const o of offenders) {
            console.log(`      overlapping BAD: [${o.lang}] ${o.query} = ${o[metric].toFixed(2)}`);
        }
    }
}
