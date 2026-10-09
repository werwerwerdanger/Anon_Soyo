/**
 * Prove that the language-based engine selection actually reaches SearXNG.
 *
 * Reading result titles is indirect: if yandex happens not to appear in the
 * top five, that could mean the bang worked or that it simply ranked low. This
 * script intercepts globalThis.fetch -- MimirLink's src/search/http.js uses
 * plain fetch -- and prints the exact URL the provider built, so the injected
 * '!engine' tokens are visible directly.
 *
 * Usage:
 *     node verify_lang_engines.mjs <instance-root>
 * e.g. node verify_lang_engines.mjs C:/Users/20633/MimirLink
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROOT = process.argv[2] || 'C:/Users/20633/MimirLink';

// Intercept before the module under test is loaded.
const realFetch = globalThis.fetch;
const captured = [];
globalThis.fetch = async (input, init) => {
    captured.push(typeof input === 'string' ? input : String(input?.url ?? input));
    return realFetch(input, init);
};

const { runSearch, normalizeWebSearchConfig } =
    await import(pathToFileURL(`${ROOT}/src/search/index.js`).href);

const config = JSON.parse(readFileSync(`${ROOT}/config.json`, 'utf-8'));
const ws = normalizeWebSearchConfig(config.ai?.tools?.webSearch || {});

console.log('='.repeat(74));
console.log(`INSTANCE: ${ROOT}`);
console.log('='.repeat(74));
console.log(`searxngEngines      : ${ws.searxngEngines || '(empty)'}`);
console.log(`searxngEnginesCjk   : ${ws.searxngEnginesCjk || '(empty)'}`);
console.log(`searxngEnginesLatin : ${ws.searxngEnginesLatin || '(empty)'}`);
console.log();

const QUERIES = [
    ['CJK  ', '成都理工大学 2026 年招生简章'],
    ['CJK  ', '蓝桥杯 2026 报名时间'],
    ['LATIN', 'what is the capital of peru'],
    ['LATIN', 'rust borrow checker explained'],
];

let problems = 0;
for (const [kind, query] of QUERIES) {
    captured.length = 0;
    const t0 = Date.now();
    let out = null;
    let failure = '';
    try {
        out = await runSearch({
            config,
            query,
            limit: ws.maxResults || 5,
            logger: { info() {}, warn() {}, error() {}, debug() {} }
        });
    } catch (err) {
        failure = `${err.code || err.name}: ${err.message}`;
    }

    const url = captured[0] || '';
    let sentQuery = '';
    try {
        sentQuery = decodeURIComponent(new URL(url).searchParams.get('q') || '');
    } catch {
        sentQuery = '(could not parse)';
    }

    const bangs = (sentQuery.match(/!\S+/g) || []);
    const cjkBang = bangs.some((b) => /!bing$/.test(b));
    const latinBang = bangs.some((b) => /!sogou_wechat|!sogou$|!quark$|!baidu$/.test(b));

    console.log('-'.repeat(74));
    console.log(`[${kind}] ${query}`);
    console.log(`  requested q  : ${sentQuery}`);
    if (kind.trim() === 'CJK' && cjkBang) {
        console.log('  !! WRONG LIST: a CJK query was sent the Latin list (bing)');
        problems += 1;
    }
    if (kind.trim() === 'LATIN' && latinBang) {
        console.log('  !! WRONG LIST: a Latin query was sent the Chinese list');
        problems += 1;
    }
    if (!url) {
        console.log('  !! no request captured');
        problems += 1;
    }
    if (failure) {
        console.log(`  FAILED ${failure} after ${Date.now() - t0}ms`);
    } else {
        console.log(`  -> ${out.resultCount} results from ${out.provider} in ${out.durationMs}ms`);
        for (const [i, r] of out.results.entries()) {
            console.log(`     ${i + 1}. ${r.title}`);
        }
    }
    console.log();
}

console.log('='.repeat(74));
console.log(problems === 0 ? 'OVERALL: PASS - engine list matched the query script'
                           : `OVERALL: ${problems} PROBLEM(S)`);
process.exit(problems === 0 ? 0 : 1);
