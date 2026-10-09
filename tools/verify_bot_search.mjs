/**
 * End-to-end check of the bot's own search path.
 *
 * Imports MimirLink's real runSearch() with the real config.json, so this
 * exercises exactly what the QQ bot exercises: provider chain, circuit
 * breaker, domain filters, snippet truncation and the 5-result cap -- not just
 * SearXNG's raw output.
 *
 * Run from the MimirLink directory:
 *     node ../WorkBuddy/.../mimir-tools/verify_bot_search.mjs
 * or with an absolute path. It resolves imports relative to itself, so it must
 * live outside src/ only if it uses absolute specifiers -- it uses absolute
 * file URLs to be safe.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROOT = 'C:/Users/20633/MimirLink';
const searchUrl = pathToFileURL(`${ROOT}/src/search/index.js`).href;

const { runSearch, getProviderHealthSnapshot, listSearchProviders } =
    await import(searchUrl);

const config = JSON.parse(readFileSync(`${ROOT}/config.json`, 'utf-8'));

console.log('='.repeat(74));
console.log('BOT SEARCH PATH -- runSearch() with the live config.json');
console.log('='.repeat(74));
const ws = config.ai?.tools?.webSearch || {};
console.log(`provider          : ${ws.provider}`);
console.log(`fallbackProviders : ${(ws.fallbackProviders || []).join(', ') || '(none)'}`);
console.log(`searxngBaseUrl    : ${ws.searxngBaseUrl}`);
console.log(`maxResults        : ${ws.maxResults}   timeoutMs: ${ws.timeoutMs}`);
console.log(`fetchPage         : ${ws.fetch?.enabled ? 'on' : 'off'}`);
console.log();
console.log('registered providers:', listSearchProviders().map((p) => p.id).join(', '));
console.log();

const QUERIES = [
    '成都理工大学 2026 年招生简章',
    '蓝桥杯 2026 报名时间',
    'rust borrow checker explained',
];

let failures = 0;
for (const query of QUERIES) {
    console.log('-'.repeat(74));
    console.log(`QUERY: ${query}`);
    console.log('-'.repeat(74));
    const t0 = Date.now();
    try {
        const out = await runSearch({
            config,
            query,
            limit: ws.maxResults || 5,
            logger: { info() {}, warn() {}, error() {}, debug() {} }
        });
        console.log(`RESULT: ok=${out.ok} provider=${out.provider} `
            + `source=${out.source} ${out.durationMs}ms `
            + `results=${out.resultCount} (wall ${Date.now() - t0}ms)`);
        for (const [i, r] of out.results.entries()) {
            console.log(`  ${i + 1}. ${r.title}`);
            console.log(`     ${r.url}`);
        }
        console.log('  attempts:');
        for (const a of out.attempts) {
            console.log(`    - ${a.provider}: ${a.error
                ? `ERROR ${a.error}`
                : `${a.resultCount} kept / ${a.rawCount} raw in ${a.durationMs}ms`}`);
        }
    } catch (err) {
        failures += 1;
        console.log(`RESULT: FAILED ${err.code || err.name}: ${err.message}`);
        for (const a of err.attempts || []) {
            console.log(`    - ${a.provider}: ${a.error || `${a.resultCount} results`}`);
        }
    }
    console.log();
}

const health = getProviderHealthSnapshot();
console.log('='.repeat(74));
console.log('CIRCUIT BREAKER STATE');
console.log('='.repeat(74));
if (health.length === 0) {
    console.log('  all providers healthy (no cooldowns)');
} else {
    for (const h of health) {
        console.log(`  ${h.provider}: ${h.failures} failures, `
            + `cooling ${Math.ceil(h.cooldownRemainingMs / 1000)}s, last="${h.lastError}"`);
    }
}
console.log();
console.log(failures === 0 ? 'OVERALL: PASS' : `OVERALL: ${failures} QUERY FAILURES`);
process.exit(failures === 0 ? 0 : 1);
