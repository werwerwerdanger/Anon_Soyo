/**
 * Verify the patched tool-result header behaves differently by tool status.
 *
 * The patch is only worth anything if the text that reaches the model actually
 * changes. So this imports the real buildToolPhaseResultMessage() from the
 * patched file and feeds it synthetic transcripts, printing what comes out.
 *
 * Usage:
 *     node verify_result_honesty.mjs <instance-root>
 */
import { pathToFileURL } from 'node:url';

const ROOT = process.argv[2] || 'C:/Users/20633/MimirLink';
const { buildToolPhaseResultMessage } =
    await import(pathToFileURL(`${ROOT}/src/tools/index.js`).href)
        .catch(async () => import(pathToFileURL(`${ROOT}/src/tools.js`).href));

console.log('='.repeat(76));
console.log(`buildToolPhaseResultMessage() -- ${ROOT}`);
console.log('='.repeat(76));

const CASES = [
    {
        label: 'ALL FAILED (no results at all)',
        transcript: [{
            name: 'web_search',
            ok: false,
            arguments: { query: '成都理工大学 2026 年招生简章' },
            result: { ok: false, error: '未找到合适的搜索结果', results: [], attempts: [] }
        }],
        expect: ['全部失败', '不要凭记忆编造', '没能查到'],
        forbid: ['以它们为准']
    },
    {
        label: 'SUCCEEDED (results came back)',
        transcript: [{
            name: 'web_search',
            ok: true,
            arguments: { query: '成都理工大学 2026 年招生简章' },
            result: {
                ok: true, provider: 'searxng', resultCount: 2,
                results: [
                    { title: '成都理工大学2026年招生简章 - 高考100', url: 'https://example.com/a', snippet: '...' },
                    { title: '2026年成都理工大学招生章程', url: 'https://example.com/b', snippet: '...' }
                ]
            }
        }],
        expect: ['优先采用', '核对相关性', '宁可说没查到'],
        forbid: []
    },
    {
        label: 'MIXED (one failed, one succeeded)',
        transcript: [
            {
                name: 'web_search', ok: false,
                arguments: { query: 'x' },
                result: { ok: false, error: '搜索失败', results: [] }
            },
            {
                name: 'get_weather', ok: true,
                arguments: { location: '成都' },
                result: { ok: true, summary: '晴 22C' }
            }
        ],
        expect: ['优先采用', '核对相关性'],
        forbid: ['全部失败']
    },
    {
        label: 'NO ENTRIES (nothing ran)',
        transcript: [],
        expect: [],
        forbid: []
    }
];

let problems = 0;
for (const c of CASES) {
    let text = '';
    try {
        text = buildToolPhaseResultMessage(c.transcript, { maxChars: 4000 });
    } catch (err) {
        console.log(`\n[${c.label}] THREW: ${err.message}`);
        problems += 1;
        continue;
    }
    console.log(`\n${'-'.repeat(76)}`);
    console.log(`[${c.label}]`);
    console.log('-'.repeat(76));
    if (!text) {
        console.log('  (returned empty string -- expected for the no-entries case)');
    } else {
        for (const line of text.split('\n').slice(0, 8)) {
            console.log('  ' + line.slice(0, 96));
        }
    }
    const missing = c.expect.filter((s) => !text.includes(s));
    const present = c.forbid.filter((s) => text.includes(s));
    if (missing.length) {
        console.log(`  !! MISSING expected phrases: ${missing.join(' | ')}`);
        problems += 1;
    }
    if (present.length) {
        console.log(`  !! FOUND phrases that should be absent: ${present.join(' | ')}`);
        problems += 1;
    }
    if (!missing.length && !present.length) {
        console.log('  OK');
    }
}

console.log(`\n${'='.repeat(76)}`);
console.log(problems === 0
    ? 'OVERALL: PASS -- the header now depends on whether the tools worked'
    : `OVERALL: ${problems} PROBLEM(S)`);
process.exit(problems === 0 ? 0 : 1);
