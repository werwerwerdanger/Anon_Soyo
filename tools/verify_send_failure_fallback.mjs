/**
 * Verify patch_send_failure_fallback.py against the REAL source text.
 *
 * isOutboundSendFailure() is not exported, so this extracts it from the shipped
 * src/index.js by brace matching and drives it with the exact strings seen in the
 * 2026-10-09 log (plus normal AI failures that must NOT be treated as send errors,
 * or we would swallow the user-facing message on a genuine model outage).
 *
 *   node verify_send_failure_fallback.mjs
 */
import fs from 'node:fs';

function extractFunction(src, name) {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`function ${name} not found`);
    let i = -1;
    let paren = 0;
    for (let k = src.indexOf('(', start); k < src.length; k++) {
        if (src[k] === '(') paren++;
        else if (src[k] === ')') paren--;
        else if (src[k] === '{' && paren === 0) { i = k; break; }
    }
    if (i < 0) throw new Error(`body brace not found for ${name}`);
    let depth = 0;
    for (let j = i; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
    }
    throw new Error(`unbalanced braces for ${name}`);
}

const SEND_FAILURES = [
    'EventChecker Failed: NTEvent serviceAndMethod:NodeIKernelMsgService/sendMsg ListenerName:NodeIKernelMsgListener/onMsgInfoListUpdate EventRet:\n{\n    "result": 120,\n    "errMsg": ""\n}\n',
    'ActionFailed(status=\'failed\', retcode=1200, data=None)',
    'sendMsg rejected',
];

const NOT_SEND_FAILURES = [
    'AI_TIMEOUT',
    'AI API 返回了空消息内容',
    'fetch failed',
    'connect ECONNREFUSED 127.0.0.1:8888',
    'AI 服务返回 401',
    '',
];

let failed = 0;
const check = (ok, label, extra = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
    if (!ok) failed++;
};

for (const inst of ['MimirLink', 'MimirLink-soyo']) {
    const ROOT = `C:/Users/20633/${inst}`;
    const src = fs.readFileSync(`${ROOT}/src/index.js`, 'utf8');
    console.log(`===== ${inst} =====`);

    check(src.includes('send-failure-fallback patch'), 'marker present');
    check(!/logger\.error\(`处理会话 \$\{sessionId\} 失败: \$\{error\.message\}`\);\s*\n\s*await sendQuotedStatusMessage/.test(src),
        'catch no longer sends the fallback unconditionally');

    const fn = new Function(`${extractFunction(src, 'isOutboundSendFailure')}\nreturn isOutboundSendFailure;`)();
    for (const msg of SEND_FAILURES) {
        check(fn({ message: msg }) === true, 'detected as send failure', JSON.stringify(msg.slice(0, 42)));
    }
    for (const msg of NOT_SEND_FAILURES) {
        check(fn({ message: msg }) === false, 'NOT a send failure', JSON.stringify(msg.slice(0, 42)));
    }
    check(fn(undefined) === false, 'undefined error does not crash');
    console.log('');
}

console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
