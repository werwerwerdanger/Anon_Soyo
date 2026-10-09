/**
 * Can a cheap, deterministic scorer tell good search results from garbage?
 *
 * Before adding a quality gate to MimirLink, measure whether one is even
 * possible. The two failure modes seen in practice are different in kind:
 *
 *   A. TOTAL MISMATCH  -- bing answered "成都理工大学 2026 年招生简章" with
 *      "鉴赏丨日本大漆金莳绘漆器" and "纳碧安燃气热水器 - 京东". Shares not a
 *      single content word with the query. A lexical scorer should catch this.
 *
 *   B. PLAUSIBLE BUT EMPTY -- bing answered "what is the capital of peru" with
 *      "capital（英语单词）_百度百科" and a Cambridge Dictionary entry. These
 *      are dictionary pages ABOUT the word "capital", not answers about Peru.
 *      Every keyword is present, so a lexical scorer will score them HIGH and
 *      be fooled. Only a reader can tell these apart.
 *
 * The point of this script is to find out which of the two a code-side gate can
 * actually handle, and to get a threshold from data rather than from taste.
 *
 * Query SearXNG directly with !bang so the good and bad sets are guaranteed to
 * come from a known engine.
 *
 *     node probe_relevance.mjs
 */
const BASE = 'http://127.0.0.1:8888';

const LATIN_STOP = new Set([
    'what', 'is', 'the', 'of', 'a', 'an', 'to', 'in', 'for', 'and', 'or',
    'how', 'why', 'when', 'where', 'who', 'are', 'was', 'were', 'be', 'do',
    'does', 'did', 'can', 'could', 'should', 'would', 'it', 'its', 'on',
    'at', 'by', 'with', 'from', 'that', 'this', 'these', 'those', 'vs'
]);

const CJK_STOP = new Set(['的', '了', '是', '在', '和', '与', '吗', '呢', '啊', '我', '你']);

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/;

/** Split a query into the terms a relevant page ought to contain. */
export function extractTerms(query) {
    const text = String(query || '');
    const terms = new Set();

    // Latin words and bare numbers (years matter a lot for these queries).
    for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9'-]{1,}|\d{2,}/g)) {
        const word = m[0].toLowerCase();
        if (!LATIN_STOP.has(word)) {
            terms.add(word);
        }
    }

    // CJK: use character bigrams. Chinese has no spaces, so a single character
    // matches far too much (成 / 学 / 生 appear everywhere) and the whole phrase
    // matches too little (the page may write 成都理工 without 大学). Bigrams are
    // the usual compromise: 成都理工大学 -> 成都 都理 理工 工大 大学.
    for (const run of text.match(new RegExp(CJK_RE.source + '+', 'g')) || []) {
        const clean = [...run].filter((ch) => !CJK_STOP.has(ch)).join('');
        if (clean.length < 2) {
            if (clean) terms.add(clean);
            continue;
        }
        for (let i = 0; i + 2 <= clean.length; i += 1) {
            terms.add(clean.slice(i, i + 2));
        }
    }

    return [...terms];
}

/** Fraction of the query's terms that appear in the result. 0..1 */
export function scoreResult(terms, result) {
    if (terms.length === 0) {
        return 0;
    }
    const hay = `${result.title || ''} ${result.snippet || ''}`.toLowerCase();
    let hit = 0;
    for (const t of terms) {
        if (hay.includes(t)) {
            hit += 1;
        }
    }
    return hit / terms.length;
}

/**
 * Aggregate a whole result set into the numbers a gate would threshold on.
 *   best    -- is ANY result on topic? (recall)
 *   mean    -- is the set as a whole on topic?
 *   goodRate-- what share is on topic?
 */
export function summarize(query, results) {
    const terms = extractTerms(query);
    const scores = results.map((r) => scoreResult(terms, r));
    const sorted = [...scores].sort((a, b) => b - a);
    return {
        terms,
        scores,
        best: sorted[0] || 0,
        mean: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
        goodRate: scores.length ? scores.filter((s) => s >= 0.5).length / scores.length : 0
    };
}

async function search(bang, query, limit = 10) {
    const url = `${BASE}/search?` + new URLSearchParams({
        q: `${bang} ${query}`,
        format: 'json',
        categories: 'general',
        language: 'zh-cn',
        safesearch: '1',
        pageno: '1'
    });
    const resp = await fetch(url);
    const body = await resp.json();
    return (body.results || []).slice(0, limit).map((r) => ({
        title: r.title || '',
        url: r.url || '',
        snippet: r.content || ''
    }));
}

const CASES = [
    // [label, query, engine expected to do WELL, engine expected to do BADLY]
    ['A total mismatch (CJK)', '成都理工大学 2026 年招生简章', '!360search', '!bing'],
    ['A total mismatch (CJK)', '蓝桥杯 2026 报名时间', '!360search', '!bing'],
    ['A total mismatch (CJK)', '成都理工大学 计算机学院 复试分数线', '!360search', '!bing'],
    ['B plausible-but-empty (Latin)', 'what is the capital of peru', '!yandex', '!bing'],
];

const rows = [];
for (const [kind, query, goodBang, badBang] of CASES) {
    console.log('='.repeat(78));
    console.log(`${kind}\nQUERY: ${query}`);
    console.log('='.repeat(78));

    for (const [label, bang] of [['GOOD set', goodBang], ['BAD set ', badBang]]) {
        let results = [];
        try {
            results = await search(bang, query);
        } catch (err) {
            console.log(`  ${label} ${bang}: request failed ${err.message}`);
            continue;
        }
        if (results.length === 0) {
            console.log(`  ${label} ${bang}: 0 results (engine down)`);
            continue;
        }
        const s = summarize(query, results);
        rows.push({ kind, query, label: label.trim(), bang, ...s, n: results.length });
        console.log(`\n  ${label} ${bang}  n=${results.length}`);
        console.log(`    terms=${s.terms.length}  best=${s.best.toFixed(2)}  `
            + `mean=${s.mean.toFixed(2)}  goodRate(>=0.5)=${s.goodRate.toFixed(2)}`);
        for (const [i, r] of results.entries()) {
            const mark = s.scores[i] >= 0.5 ? 'OK ' : 'BAD';
            console.log(`      [${mark} ${s.scores[i].toFixed(2)}] ${r.title.slice(0, 58)}`);
        }
    }
    console.log();
}

console.log('='.repeat(78));
console.log('SUMMARY -- can a threshold separate them?');
console.log('='.repeat(78));
console.log('  %-30s %-8s %6s %6s %8s' % ['query', 'set', 'best', 'mean', 'goodRate']);
for (const r of rows) {
    console.log('  %-30s %-8s %6.2f %6.2f %8.2f',
        r.query.slice(0, 28), r.label, r.best, r.mean, r.goodRate);
}
console.log();
const bad = rows.filter((r) => r.label === 'BAD');
const good = rows.filter((r) => r.label === 'GOOD');
if (bad.length && good.length) {
    console.log('  worst GOOD  mean = %s', Math.min(...good.map((r) => r.mean)).toFixed(2));
    console.log('  best  BAD   mean = %s', Math.max(...bad.map((r) => r.mean)).toFixed(2));
    const gMin = Math.min(...good.map((r) => r.mean));
    const bMax = Math.max(...bad.map((r) => r.mean));
    console.log(gMin > bMax
        ? '  => mean separates the two groups; a threshold exists.'
        : '  => mean does NOT separate them. Case B defeats a lexical gate.');
}
