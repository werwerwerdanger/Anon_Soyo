/**
 * Lexical relevance scoring, shared by the probes and by the eventual gate.
 *
 * The question this answers: given a query and a set of search results, do the
 * results actually talk about the query? It is deliberately dumb -- term
 * overlap, no model, no network -- because it has to run on every search
 * without adding latency or cost.
 *
 * What it CAN catch: results that share no content words with the query. This
 * is the dominant Chinese failure here. bing answered "蓝桥杯 2026 报名时间"
 * with 汉语字典 pages about the character 蓝, and "成都理工大学 2026 年招生简章"
 * with Chengdu tourism guides.
 *
 * What it CANNOT catch: results that use every keyword but answer nothing.
 * bing answered "what is the capital of peru" with "capital（英语单词）_百度百科".
 * That page contains the word "capital", so it scores; only a reader can see it
 * is a dictionary entry rather than an answer about Peru. A lexical gate must
 * never be the only line of defence.
 */

const LATIN_STOP = new Set([
    'what', 'is', 'the', 'of', 'a', 'an', 'to', 'in', 'for', 'and', 'or',
    'how', 'why', 'when', 'where', 'who', 'are', 'was', 'were', 'be', 'do',
    'does', 'did', 'can', 'could', 'should', 'would', 'it', 'its', 'on',
    'at', 'by', 'with', 'from', 'that', 'this', 'these', 'those', 'vs',
    'about', 'into', 'than', 'then', 'there', 'their', 'have', 'has', 'not'
]);

const CJK_STOP = new Set(['的', '了', '是', '在', '和', '与', '吗', '呢', '啊', '我', '你', '有', '个']);

export const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/;

/**
 * Split a query into the terms a relevant page ought to contain.
 *
 * CJK uses character bigrams. Chinese has no spaces, so single characters match
 * far too much (成 / 学 / 生 are everywhere) and the whole phrase matches too
 * little (a page may write 成都理工 without 大学). Bigrams are the usual
 * compromise: 成都理工大学 -> 成都 都理 理工 工大 大学.
 */
export function extractTerms(query) {
    const text = String(query || '');
    const terms = new Set();

    for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9'._-]{1,}|\d{2,}/g)) {
        const word = m[0].toLowerCase();
        if (!LATIN_STOP.has(word)) {
            terms.add(word);
        }
    }

    const cjkRuns = text.match(new RegExp(`${CJK_RE.source}+`, 'g')) || [];
    for (const run of cjkRuns) {
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
    if (!terms.length) {
        return 0;
    }
    const hay = `${result?.title || ''} ${result?.snippet || ''}`.toLowerCase();
    let hit = 0;
    for (const t of terms) {
        if (hay.includes(t)) {
            hit += 1;
        }
    }
    return hit / terms.length;
}

/**
 * Aggregate a result set.
 *   best -- is ANY result on topic? Handles the case where a long junk tail
 *           hides one good hit.
 *   top3 -- mean of the best three; ignores a long junk tail without letting a
 *           single lucky hit decide.
 *   mean -- average over everything; most sensitive to bulk junk.
 */
export function summarize(query, results) {
    const terms = extractTerms(query);
    const scored = results.map((r) => ({ result: r, score: scoreResult(terms, r) }));
    const desc = [...scored].sort((a, b) => b.score - a.score);
    const top3 = desc.slice(0, 3);
    return {
        terms,
        scored,
        n: results.length,
        best: desc[0]?.score ?? 0,
        top3: top3.length ? top3.reduce((a, b) => a + b.score, 0) / top3.length : 0,
        mean: scored.length ? scored.reduce((a, b) => a + b.score, 0) / scored.length : 0
    };
}
