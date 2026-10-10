# -*- coding: utf-8 -*-
"""Stop sending a second message when the FIRST failure was already a send failure.

WHAT HAPPENED (this install's log, 2026-10-09 20:19:26)
------------------------------------------------------
MimirLink tried to deliver a reply, QQ refused it:

    [OneBot] API 调用失败  error: "EventChecker Failed: NTEvent
      serviceAndMethod:NodeIKernelMsgService/sendMsg ... {\"result\": 120}"

The catch block then did what it always does -- `sendQuotedStatusMessage(event,
'处理消息时出现错误，请稍后重试')`. That second send was refused too (same result 120),
so the group got nothing while we burned an extra request against whatever was
rate-limiting us. One minute later everything worked again, i.e. it was a
transient throttle, and re-sending is exactly the wrong reaction to it.

WHAT THIS PATCH DOES
--------------------
index.js
  * adds isOutboundSendFailure(error) -- recognises QQNT refusal shapes
    (EventChecker Failed / NodeIKernelMsgService/sendMsg / retcode)
  * the catch block now logs instead of re-sending when the failure came from the
    outbound path. Model/API failures still get their user-facing message.

Usage:
    python patch_send_failure_fallback.py [--dry-run] [--revert]
"""
import argparse
import pathlib
import shutil
import subprocess
import time

STAMP = time.strftime('%Y%m%d-%H%M%S')
MARKER = 'send-failure-fallback patch'
INSTANCES = ['MimirLink', 'MimirLink-soyo']
ROOTS = [pathlib.Path(r'C:\Users\20633') / n for n in INSTANCES]

HELPER_ANCHOR = 'function buildAIServiceFailureMessage(error, config = {}) {'
HELPER_NEW = '''// >>> send-failure-fallback patch (managed by patch_send_failure_fallback.py) >>>
// QQNT 拒发时抛的是 EventChecker Failed + NodeIKernelMsgService/sendMsg（result 非 0、
// errMsg 为空）。这类失败重发无意义 —— 2026-10-09 那天我们连错提示一起被拒了两条。
function isOutboundSendFailure(error) {
    const message = String(error?.message || '');
    return /EventChecker Failed|sendMsg|retcode/i.test(message);
}
// <<< send-failure-fallback patch <<<

''' + HELPER_ANCHOR

CATCH_ANCHOR = '''            logger.error(`处理会话 ${sessionId} 失败: ${error.message}`);
            await sendQuotedStatusMessage(event, failMessage);'''
CATCH_NEW = '''            logger.error(`处理会话 ${sessionId} 失败: ${error.message}`);
            // >>> send-failure-fallback patch <<<
            // 失败原因本身就是"发不出去"时，再补一条提示只会多一次被拒的请求，
            // 群里也照样看不到。只记日志，给风控留出恢复时间。
            if (isOutboundSendFailure(error)) {
                logger.warn('[兜底] 本轮失败发生在消息下发环节，已跳过错误提示，避免再次被拒');
            } else {
                await sendQuotedStatusMessage(event, failMessage);
            }
            // <<< send-failure-fallback patch <<<'''

EDITS = {'src/index.js': [(HELPER_ANCHOR, HELPER_NEW), (CATCH_ANCHOR, CATCH_NEW)]}


def revert():
    n = 0
    for root in ROOTS:
        for backup in sorted(root.glob('src/*.bak-*sendfail*')):
            target = backup.with_name(backup.name.split('.bak-')[0])
            shutil.copy2(backup, target)
            print('restored %s' % target)
            n += 1
    print('RESTART both instances to apply.' if n else 'no sendfail backups found; nothing reverted')
    return 0


def node_check(path):
    node = r'C:\Users\20633\.workbuddy\binaries\node\versions\22.22.2-6\node.exe'
    if not pathlib.Path(node).exists():
        node = 'node'
    return subprocess.run([node, '--check', str(path)], capture_output=True, text=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--revert', action='store_true')
    args = ap.parse_args()
    if args.revert:
        return revert()

    print('=' * 72)
    print('patch send-failure fallback   dry-run=%s' % args.dry_run)
    print('=' * 72)
    failures = 0
    for root in ROOTS:
        print('')
        print('--- %s ---' % root.name)
        for rel, edits in EDITS.items():
            path = root / rel
            if not path.exists():
                print('  [SKIP] %s missing' % path)
                failures += 1
                continue
            text = path.read_text(encoding='utf-8')
            if MARKER in text:
                print('  [SKIP] %s already patched' % rel)
                continue
            broken = False
            for anchor, _ in edits:
                n = text.count(anchor)
                if n != 1:
                    print('  [FAIL] %s: anchor appears %d times (want 1): %r'
                          % (rel, n, anchor.splitlines()[0][:60]))
                    failures += 1
                    broken = True
                    break
            if broken:
                continue

            new_text = text
            for anchor, replacement in edits:
                new_text = new_text.replace(anchor, replacement, 1)

            if args.dry_run:
                print('  [dry-run] %s: %d edits would apply (%d -> %d bytes)'
                      % (rel, len(edits), len(text), len(new_text)))
                continue

            backup = path.with_name('%s.bak-%s-sendfail' % (path.name, STAMP))
            shutil.copy2(path, backup)
            path.write_text(new_text, encoding='utf-8', newline='\n')
            check = node_check(path)
            if check.returncode != 0:
                print('  [FAIL] %s: node --check failed, restoring' % rel)
                print(check.stderr.strip()[:500])
                shutil.copy2(backup, path)
                failures += 1
                continue
            print('  [OK] %s: %d edits, %d -> %d bytes, node --check passed'
                  % (rel, len(edits), len(text), len(new_text)))

    print('')
    if failures:
        print('%d problem(s)' % failures)
        return 1
    if not args.dry_run:
        print('RESTART both MimirLink instances: these are code changes.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
