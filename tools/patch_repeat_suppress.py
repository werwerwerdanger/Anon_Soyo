# -*- coding: utf-8 -*-
"""Suppress "same person repeats the same line" -- the message_id key cannot.

WHAT WENT WRONG (observed 2026-10-09 20:28, soyo private chat)
-------------------------------------------------------------
The user sent 「我是来结束这一切的」 nine times in ~40s. The bot answered seventeen
lines, complete with a running tally:

    这句话是我的，别乱用 / 同一句话复读两遍，你是想让我夸你有梗吗
    第三遍了 / 第四次了 / 第五次了 / 第六遍了 ...

Cause: `runtime.enqueue()` dedupes on `item.dedupeKey`, and index.js built that key
from `event.message_id` -- QQ mints a NEW id for every send, so identical text is
never deduped. The key only ever caught the same message being redelivered.
(`runtime.js:119` drops a hit, and the entry's timestamp is set once at first insert,
so a 10s window also expires between repeats.)

WHAT THIS PATCH DOES
--------------------
index.js
  * adds buildMessageDedupeKey(config, sessionKey, event, plainText, messageSegments)
      - pure-text messages >= chat.repeatSuppressMinChars (default 4) key on CONTENT
      - the key includes user_id, so two different people saying the same thing are
        NOT merged -- group-repeat detection keeps working
      - images / stickers keep the message_id key: repeated stickers are untouched
  * the enqueue site now calls it

config.json
  * chat.dedupeWindowMs 10000 -> 60000, so a spam burst cannot outlive the window

Usage:
    python patch_repeat_suppress.py [--dry-run] [--revert]
"""
import argparse
import json
import pathlib
import shutil
import subprocess
import time

STAMP = time.strftime('%Y%m%d-%H%M%S')
MARKER = 'repeat-suppress patch'
INSTANCES = ['MimirLink', 'MimirLink-soyo']
ROOTS = [pathlib.Path(r'C:\Users\20633') / n for n in INSTANCES]

HELPER_ANCHOR = 'function buildStructuredMessage(event, plainText, meta = {}) {'
HELPER_NEW = '''// >>> repeat-suppress patch (managed by patch_repeat_suppress.py) >>>
// 原去重键只用 message_id：那只挡得住"同一条消息被重投"，挡不住"同一个人复读同一句"
// —— 2026-10-09 私聊里用户把同一句话发了九遍，她逐条回应还数起"第三遍了"，最出戏。
// 纯文本消息改用内容做键（带 user_id，免得把不同人的同句话并掉、毁掉群聊复读）；
// 图片/表情继续用 message_id，重复发表情不受影响。
function normalizeRepeatText(value) {
    return String(value ?? '').trim().replace(/\\s+/g, ' ');
}

function buildMessageDedupeKey(config, sessionKey, event, plainText, messageSegments = []) {
    const normalized = normalizeRepeatText(plainText);
    const minChars = Math.max(1, Number(config?.chat?.repeatSuppressMinChars) || 4);
    const onlyText = Array.isArray(messageSegments) && messageSegments.length > 0
        && messageSegments.every((segment) => segment && segment.type === 'text');
    if (onlyText && normalized.length >= minChars) {
        return `${sessionKey}:u${event?.user_id}:text:${normalized}`;
    }
    return event?.message_id
        ? `${sessionKey}:${event.message_id}`
        : `${sessionKey}:${event?.time}:${normalized}`;
}
// <<< repeat-suppress patch <<<

''' + HELPER_ANCHOR

KEY_ANCHOR = "        dedupeKey: event.message_id ? `${sessionKey}:${event.message_id}` : `${sessionKey}:${event.time}:${plainText}`,"
KEY_NEW = '''        // >>> repeat-suppress patch <<<
        dedupeKey: buildMessageDedupeKey(config, sessionKey, event, plainText, messageSegments),
        // <<< repeat-suppress patch <<<'''

EDITS = {'src/index.js': [(HELPER_ANCHOR, HELPER_NEW), (KEY_ANCHOR, KEY_NEW)]}

OLD_WINDOW_LINE = '"dedupeWindowMs": 10000,'
NEW_WINDOW_LINE = '"dedupeWindowMs": 60000,\n    "repeatSuppressMinChars": 4,'


def node_check(path):
    node = r'C:\Users\20633\.workbuddy\binaries\node\versions\22.22.2-6\node.exe'
    if not pathlib.Path(node).exists():
        node = 'node'
    return subprocess.run([node, '--check', str(path)], capture_output=True, text=True)


def revert():
    n = 0
    for root in ROOTS:
        for backup in sorted(root.glob('src/*.bak-*repeat*')):
            target = backup.with_name(backup.name.split('.bak-')[0])
            shutil.copy2(backup, target)
            print('restored %s' % target)
            n += 1
        for cbackup in sorted(root.glob('config.json.bak-*repeat*')):
            shutil.copy2(cbackup, root / 'config.json')
            print('restored %s' % (root / 'config.json'))
            n += 1
    print('RESTART both instances to apply.' if n else 'no repeat backups found; nothing reverted')
    return 0


def patch_config(root, dry_run):
    path = root / 'config.json'
    text = path.read_text(encoding='utf-8')
    if '"repeatSuppressMinChars"' in text:
        print('  [SKIP] config.json already patched')
        return 0
    if text.count(OLD_WINDOW_LINE) != 1:
        print('  [FAIL] config.json: dedupeWindowMs anchor appears %d times (want 1)'
              % text.count(OLD_WINDOW_LINE))
        return 1
    new_text = text.replace(OLD_WINDOW_LINE, NEW_WINDOW_LINE, 1)
    json.loads(new_text)  # refuse to write anything that is not valid JSON
    before = json.loads(text)['chat']['dedupeWindowMs']
    after = json.loads(new_text)['chat']['dedupeWindowMs']
    if dry_run:
        print('  [dry-run] config.json: dedupeWindowMs %s -> %s, +repeatSuppressMinChars'
              % (before, after))
        return 0
    shutil.copy2(path, path.with_name('config.json.bak-%s-repeat' % STAMP))
    path.write_text(new_text, encoding='utf-8')
    check = json.loads(path.read_text(encoding='utf-8'))
    assert check['chat']['dedupeWindowMs'] == 60000
    assert check['chat']['repeatSuppressMinChars'] == 4
    print('  [OK] config.json: dedupeWindowMs %s -> %s, +repeatSuppressMinChars=4'
          % (before, after))
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--revert', action='store_true')
    args = ap.parse_args()
    if args.revert:
        return revert()

    print('=' * 72)
    print('patch repeat suppression   dry-run=%s' % args.dry_run)
    print('=' * 72)
    failures = 0
    for root in ROOTS:
        print('')
        print('--- %s ---' % root.name)
        failures += patch_config(root, args.dry_run)

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
                          % (rel, n, anchor.strip().splitlines()[0][:60]))
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
            backup = path.with_name('%s.bak-%s-repeat' % (path.name, STAMP))
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
        print('RESTART both MimirLink instances: code + config changes.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
