/**
 * Verify patch_code_safety.py against the REAL modules.
 *
 * Real case (2026-10-09, group 929159193): the bot answered a competitive-programming
 * question and the code came out destroyed. Log evidence:
 *     replyPreview   : ```cpp\n#include <bits/stdc++.h>\nusing namespace std;\nint main(){
 *     processedReply : ```cpp\n#include \nusing namespace std;\nint main(){
 * ...and the anon instance received it as one QQ message per line.
 *
 * Two independent checks:
 *   1. stripInternalTags() from the real variable-bridge.js must keep C++ templates
 *   2. the real dispatchReply() must ship a fenced block as ONE message
 *
 *   node verify_code_safety.mjs
 */
import fs from 'node:fs';

const CODE_REPLY = [
    '又是题目。这题的思路：先模拟一遍求出置换。',
    '',
    '```cpp',
    '#include <bits/stdc++.h>',
    'using namespace std;',
    'int main(){',
    '    int n; vector<int> v; map<int,int> m;',
    '    pair<int,int> p;',
    '    return 0;',
    '}',
    '```',
].join('\n');

let failed = 0;
const check = (ok, label, extra = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
    if (!ok) failed++;
};

for (const inst of ['MimirLink', 'MimirLink-soyo']) {
    const ROOT = `C:/Users/20633/${inst}`;
    console.log(`===== ${inst} =====`);

    // --- 1) tag stripping must not eat templates
    const { stripInternalTags } = await import(`file:///${ROOT}/src/variable-bridge.js`);
    const cleaned = stripInternalTags(CODE_REPLY);
    for (const needle of ['<bits/stdc++.h>', 'vector<int>', 'map<int,int>', 'pair<int,int>']) {
        check(cleaned.includes(needle), `template survives: ${needle}`);
    }
    // …and the strip must still do its real job
    const dirty = '正文\n<thinking>内心戏</thinking>\n结束';
    const cleanedDirty = stripInternalTags(dirty);
    check(!cleanedDirty.includes('内心戏') && cleanedDirty.includes('正文')
        && cleanedDirty.includes('结束'), 'internal tags are still removed');
    check(stripInternalTags('<bginfor>x</bginfor>hi').includes('hi')
        && !stripInternalTags('<bginfor>x</bginfor>hi').includes('bginfor'),
        'html-ish tags around prose still stripped');

    // --- 2) the real dispatcher must not shred a fenced block
    const { dispatchReply } = await import(`file:///${ROOT}/src/reply-dispatcher.js`);
    const config = JSON.parse(fs.readFileSync(`${ROOT}/config.json`, 'utf8'));
    const sent = [];
    const bot = {
        sendGroupMessage: async (_g, m) => sent.push(typeof m === 'string' ? m : JSON.stringify(m)),
        sendGroupReply: async (_g, _id, m) => sent.push(String(m)),
        sendPrivateMessage: async (_u, m) => sent.push(String(m)),
        sendPrivateReply: async (_u, _id, m) => sent.push(String(m)),
    };
    const sleeps = [];
    await dispatchReply(
        { message_type: 'group', group_id: 929159193, user_id: 2063362809, message_id: '1' },
        CODE_REPLY,
        {},
        { config, bot, logger: { info() {}, warn() {}, debug() {} },
          sleep: async (ms) => { sleeps.push(ms); }, recordDashboardMetric() {} }
    );
    const joined = sent.join('\n');
    check(sent.length <= 3, 'fenced block ships as a few messages, not one per line',
        `sent=${sent.length}`);
    check(joined.includes('<bits/stdc++.h>'), 'code reaches the wire intact');
    check(joined.includes('vector<int>') && joined.includes('map<int,int>'),
        'templates reach the wire intact');
    console.log(`  ..  per-message sleeps requested: ${JSON.stringify(sleeps)}`);
    console.log('');
}

console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
