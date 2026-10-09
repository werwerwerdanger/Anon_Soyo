/**
 * End-to-end check for the Bocha provider.
 *
 * Loads each MimirLink instance's own search module with its own config.json and
 * runs a real query through the full pipeline (provider chain, key lookup,
 * normalization, domain filter). A pass here means the bot will work, because
 * this is the exact code path the bot takes.
 *
 *   node verify_bocha.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOTS = [
    ['anon', 'C:/Users/20633/MimirLink'],
    ['soyo', 'C:/Users/20633/MimirLink-soyo']
];

const QUERY = '成都理工大学 2026 年招生';

let failures = 0;

for (const [name, root] of ROOTS) {
    console.log('='.repeat(66));
    console.log(name + '   ' + root);

    const cfgPath = path.join(root, 'config.json');
    let cfg;
    try {
        cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch (error) {
        console.log('  [FAIL] cannot read config.json: ' + error.message);
        failures++;
        continue;
    }

    const ws = cfg?.ai?.tools?.webSearch;
    console.log('  config provider : ' + ws?.provider);
    console.log('  config enabled  : ' + ws?.enabled);
    const key = ws?.apiKeys?.bocha || '';
    console.log('  bocha key       : ' + (key ? key.slice(0, 6) + '...' + key.slice(-4) + ' (' + key.length + ' chars)' : 'EMPTY'));

    let mod;
    try {
        mod = await import(pathToFileURL(path.join(root, 'src', 'search', 'index.js')).href);
    } catch (error) {
        console.log('  [FAIL] cannot import search module: ' + error.message);
        failures++;
        continue;
    }

    const ids = mod.SEARCH_PROVIDERS.map((p) => p.id);
    console.log('  registered      : ' + ids.join(', '));
    if (!ids.includes('bocha')) {
        console.log('  [FAIL] bocha is not registered');
        failures++;
        continue;
    }

    const started = Date.now();
    let result;
    try {
        result = await mod.runSearch({ config: cfg, query: QUERY, limit: 3 });
    } catch (error) {
        console.log('  [FAIL] runSearch threw: ' + error.message);
        failures++;
        continue;
    }

    const ms = Date.now() - started;
    console.log('  ok              : ' + result.ok);
    console.log('  provider used   : ' + result.provider + '  (' + ms + ' ms)');
    console.log('  results         : ' + result.resultCount);
    for (const a of result.attempts || []) {
        console.log('  attempt         : ' + a.provider + (a.error ? '  error=' + a.error : '  ok'));
    }
    for (const r of (result.results || []).slice(0, 3)) {
        console.log('   - ' + String(r.title || '').slice(0, 58));
        console.log('     ' + r.url);
        console.log('     ' + String(r.snippet || '').replace(/\s+/g, ' ').slice(0, 90) + '...');
    }

    if (!result.ok || result.resultCount === 0) {
        failures++;
    }
    console.log('');
}

console.log('='.repeat(66));
console.log(failures === 0 ? 'RESULT: PASS' : 'RESULT: FAIL (' + failures + ' instance(s))');
process.exit(failures === 0 ? 0 : 1);
