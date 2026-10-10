# -*- coding: utf-8 -*-
"""Enforce a minimum gap between outbound messages, per bot instance.

WHY (user: "给每个机器人加一个至少5s的消息间隔")
----------------------------------------------
2026-10-09 20:19:26 the bot's reply was refused by QQ:

    EventChecker Failed: NTEvent serviceAndMethod:NodeIKernelMsgService/sendMsg
    {"result": 120, "errMsg": ""}

...and the follow-up error notice was refused too. 20:20:41 it recovered on its own.
The messages were short, plain Chinese -- nothing content-worthy of a block. What the
log DOES show is a burst: config has splitMessage on, replies are cut on 。 and on
blank lines, and segmentDelayMs is only 300. So a 4-line reply ships as 4 messages
300ms apart, and the bot was doing that repeatedly across a few minutes.

WHAT THIS PATCH DOES
--------------------
reply-dispatcher.js
  * module-level lastOutboundAt + awaitSendSlot(config, sleep, logger)
  * sendText() and sendVoice() -- the only two outbound exits in dispatchReply --
    each await a slot first, so the floor applies to segment splits, consecutive
    replies, TTS and text alike, and across sessions (module scope = per process).

config.json
  * chat.minSendIntervalMs = 5000

The wait is measured from the END of the previous send, so the effective gap between
message N and N+1 is at least minSendIntervalMs.

Usage:
    python patch_send_interval.py [--dry-run] [--revert]
"""
import argparse
import json
import pathlib
import shutil
import subprocess
import time

STAMP = time.strftime('%Y%m%d-%H%M%S')
MARKER = 'send-interval patch'
INSTANCES = ['MimirLink', 'MimirLink-soyo']
ROOTS = [pathlib.Path(r'C:\Users\20633') / n for n in INSTANCES]

DISPATCH_ANCHOR = 'export async function dispatchReply(event, processedReply, options = {}, deps = {}) {'
DISPATCH_NEW = '''// >>> send-interval patch (managed by patch_send_interval.py) >>>
// 同一个机器人两次下发之间至少间隔 chat.minSendIntervalMs（默认 5000ms）。
// 起因：2026-10-09 群里 300ms 连发，QQ 直接 result:120 拒发（连错误提示一起拒）。
// 模块级变量 ⇒ 跨会话全局生效；sendText / sendVoice 是本文件唯一的两条下发出口。
let lastOutboundAt = 0;

async function awaitSendSlot(config = {}, sleepFn, logger = console) {
    const minIntervalMs = Math.max(0, Number(config?.chat?.minSendIntervalMs) || 0);
    const wait = typeof sleepFn === 'function'
        ? sleepFn
        : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    if (minIntervalMs <= 0) {
        lastOutboundAt = Date.now();
        return 0;
    }
    const waitMs = lastOutboundAt + minIntervalMs - Date.now();
    if (waitMs > 0) {
        logger.info?.(`[限速] 距上次下发不足 ${minIntervalMs}ms，再等 ${waitMs}ms`);
        await wait(waitMs);
    }
    lastOutboundAt = Date.now();
    return Math.max(0, waitMs);
}
// <<< send-interval patch <<<

''' + DISPATCH_ANCHOR

TEXT_ANCHOR = '''    const sendText = async (content) => {
        const message = !hasSentPrimary && mentionPrefix ? `${mentionPrefix}${content}` : content;'''
TEXT_NEW = '''    const sendText = async (content) => {
        // >>> send-interval patch <<<
        await awaitSendSlot(config, sleep, logger);
        // <<< send-interval patch <<<
        const message = !hasSentPrimary && mentionPrefix ? `${mentionPrefix}${content}` : content;'''

VOICE_ANCHOR = '''    const sendVoice = async (audioPath) => {
        // TTS 语音不走文本「必须 @」策略：只保留可选引用，绝不拼 at。'''
VOICE_NEW = '''    const sendVoice = async (audioPath) => {
        // >>> send-interval patch <<<
        await awaitSendSlot(config, sleep, logger);
        // <<< send-interval patch <<<
        // TTS 语音不走文本「必须 @」策略：只保留可选引用，绝不拼 at。'''

EDITS = {'src/reply-dispatcher.js': [
    (DISPATCH_ANCHOR, DISPATCH_NEW),
    (TEXT_ANCHOR, TEXT_NEW),
    (VOICE_ANCHOR, VOICE_NEW),
]}

CFG_ANCHOR = '"repeatSuppressMinChars": 4,'
CFG_NEW = '"repeatSuppressMinChars": 4,\n    "minSendIntervalMs": 5000,'


def node_check(path):
    node = r'C:\Users\20633\.workbuddy\binaries\node\versions\22.22.2-6\node.exe'
    if not pathlib.Path(node).exists():
        node = 'node'
    return subprocess.run([node, '--check', str(path)], capture_output=True, text=True)


def patch_config(root, dry_run):
    path = root / 'config.json'
    text = path.read_text(encoding='utf-8')
    if '"minSendIntervalMs"' in text:
        print('  [SKIP] config.json already patched')
        return 0
    if text.count(CFG_ANCHOR) != 1:
        print('  [FAIL] config.json: anchor appears %d times (want 1)' % text.count(CFG_ANCHOR))
        return 1
    new_text = text.replace(CFG_ANCHOR, CFG_NEW, 1)
    json.loads(new_text)
    if dry_run:
        print('  [dry-run] config.json: +minSendIntervalMs=5000')
        return 0
    shutil.copy2(path, path.with_name('config.json.bak-%s-interval' % STAMP))
    path.write_text(new_text, encoding='utf-8')
    assert json.loads(path.read_text(encoding='utf-8'))['chat']['minSendIntervalMs'] == 5000
    print('  [OK] config.json: +minSendIntervalMs=5000')
    return 0


def revert():
    n = 0
    for root in ROOTS:
        for b in sorted(root.glob('src/*.bak-*interval*')):
            shutil.copy2(b, b.with_name(b.name.split('.bak-')[0]))
            print('restored %s' % b.with_name(b.name.split('.bak-')[0]))
            n += 1
        for b in sorted(root.glob('config.json.bak-*interval*')):
            shutil.copy2(b, root / 'config.json')
            print('restored %s' % (root / 'config.json'))
            n += 1
    print('RESTART both instances to apply.' if n else 'no interval backups found')
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--revert', action='store_true')
    args = ap.parse_args()
    if args.revert:
        return revert()

    print('=' * 72)
    print('patch send interval (min 5s)   dry-run=%s' % args.dry_run)
    print('=' * 72)
    failures = 0
    for root in ROOTS:
        print('')
        print('--- %s ---' % root.name)
        failures += patch_config(root, args.dry_run)
        for rel, edits in EDITS.items():
            path = root / rel
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
                print('  [dry-run] %s: %d edits (%d -> %d bytes)'
                      % (rel, len(edits), len(text), len(new_text)))
                continue
            backup = path.with_name('%s.bak-%s-interval' % (path.name, STAMP))
            shutil.copy2(path, backup)
            path.write_text(new_text, encoding='utf-8', newline='\n')
            check = node_check(path)
            if check.returncode != 0:
                print('  [FAIL] %s: node --check failed, restoring' % rel)
                print(check.stderr.strip()[:400])
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
        print('RESTART both MimirLink instances: code + config changes.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
