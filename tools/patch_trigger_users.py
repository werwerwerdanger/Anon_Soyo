# -*- coding: utf-8 -*-
"""Let specific people reach the LLM in a group without @-mentioning the bot.

WHY (user: "在群聊里面要一直@才进llm好麻烦")
------------------------------------------
Group routing today (triggerMode 'auto' + requireAtInGroup false) needs a prefix, a
keyword, an @, or a reply-to-bot. There IS a "triggerMode: 'always'" that accepts every
group message -- but this group has 270 members, and every accepted message costs two
LLM calls plus the new 5s send gate, so 'always' would queue the bot into uselessness.

What the user actually wants is "I can just talk and she answers, other people still
have to @". That is a per-sender whitelist.

WHAT THIS PATCH DOES
--------------------
index.js
  * adds isTriggerUser(config, event) -- true when event.user_id is in chat.triggerUsers
  * buildRoutingDecision() accepts such a group message as 'trigger_user', checked
    right after reply_to_bot (quoting the bot is still the strongest signal)

config.json
  * chat.triggerUsers = [2063362809]   (werwer, the owner)

Leave triggerUsers as [] to disable and fall back to the current keyword/@ behaviour.

Usage:
    python patch_trigger_users.py [--dry-run] [--revert]
"""
import argparse
import json
import pathlib
import shutil
import subprocess
import time

STAMP = time.strftime('%Y%m%d-%H%M%S')
MARKER = 'trigger-users patch'
INSTANCES = ['MimirLink', 'MimirLink-soyo']
ROOTS = [pathlib.Path(r'C:\Users\20633') / n for n in INSTANCES]

HELPER_ANCHOR = 'function buildRoutingDecision(config, event, plainText, isAtMe, messageInfo = {}) {'
HELPER_NEW = '''// >>> trigger-users patch (managed by patch_trigger_users.py) >>>
// 群里「免 @ 直通 LLM」的白名单：名单里的人说话就触发，其他人仍要 @ 或关键词。
// 为什么不用 triggerMode='always'：270 人群里每条消息都触发 = 每条 2 次 LLM 调用
// 再叠 5s 下发间隔，队列会拖到回复完全没有时效。
function isTriggerUser(config, event) {
    const list = config?.chat?.triggerUsers;
    if (!Array.isArray(list) || list.length === 0) return false;
    const id = String(event?.user_id ?? '').trim();
    if (!id) return false;
    return list.some((value) => String(value ?? '').trim() === id);
}
// <<< trigger-users patch <<<

''' + HELPER_ANCHOR

ROUTE_ANCHOR = '''        if (messageInfo.replyToBot) {
            return accept('reply_to_bot');
        }'''
ROUTE_NEW = '''        if (messageInfo.replyToBot) {
            return accept('reply_to_bot');
        }
        // >>> trigger-users patch <<<
        if (isTriggerUser(config, event)) {
            return accept('trigger_user');
        }
        // <<< trigger-users patch <<<'''

CFG_ANCHOR = '"triggerKeywords": ['
CFG_NEW = '"triggerUsers": [\n      2063362809\n    ],\n  "triggerKeywords": ['


def node_check(path):
    node = r'C:\Users\20633\.workbuddy\binaries\node\versions\22.22.2-6\node.exe'
    if not pathlib.Path(node).exists():
        node = 'node'
    return subprocess.run([node, '--check', str(path)], capture_output=True, text=True)


def revert():
    n = 0
    for root in ROOTS:
        for b in sorted(root.glob('src/*.bak-*triggeruser*')):
            shutil.copy2(b, b.with_name(b.name.split('.bak-')[0]))
            print('restored %s' % b.with_name(b.name.split('.bak-')[0]))
            n += 1
        for b in sorted(root.glob('config.json.bak-*triggeruser*')):
            shutil.copy2(b, root / 'config.json')
            print('restored %s' % (root / 'config.json'))
            n += 1
    print('RESTART both instances to apply.' if n else 'no trigger-users backups found')
    return 0


def patch_config(root, dry_run):
    path = root / 'config.json'
    text = path.read_text(encoding='utf-8')
    if '"triggerUsers"' in text:
        print('  [SKIP] config.json already has triggerUsers')
        return 0
    if text.count(CFG_ANCHOR) != 1:
        print('  [FAIL] config.json: triggerKeywords anchor appears %d times'
              % text.count(CFG_ANCHOR))
        return 1
    new_text = text.replace(CFG_ANCHOR, CFG_NEW, 1)
    cfg = json.loads(new_text)
    assert cfg['chat']['triggerUsers'] == [2063362809], cfg['chat'].get('triggerUsers')
    if dry_run:
        print('  [dry-run] config.json: +triggerUsers=[2063362809]')
        return 0
    shutil.copy2(path, path.with_name('config.json.bak-%s-triggeruser' % STAMP))
    path.write_text(new_text, encoding='utf-8')
    print('  [OK] config.json: +triggerUsers=[2063362809]')
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--revert', action='store_true')
    args = ap.parse_args()
    if args.revert:
        return revert()

    print('=' * 72)
    print('patch trigger users (no @ needed)   dry-run=%s' % args.dry_run)
    print('=' * 72)
    failures = 0
    for root in ROOTS:
        print('')
        print('--- %s ---' % root.name)
        failures += patch_config(root, args.dry_run)
        path = root / 'src/index.js'
        text = path.read_text(encoding='utf-8')
        if MARKER in text:
            print('  [SKIP] src/index.js already patched')
            continue
        broken = False
        for anchor in (HELPER_ANCHOR, ROUTE_ANCHOR):
            n = text.count(anchor)
            if n != 1:
                print('  [FAIL] src/index.js: anchor appears %d times (want 1): %r'
                      % (n, anchor.strip().splitlines()[0][:60]))
                failures += 1
                broken = True
                break
        if broken:
            continue
        new_text = text.replace(HELPER_ANCHOR, HELPER_NEW, 1).replace(ROUTE_ANCHOR, ROUTE_NEW, 1)
        if args.dry_run:
            print('  [dry-run] src/index.js: 2 edits (%d -> %d bytes)' % (len(text), len(new_text)))
            continue
        backup = path.with_name('%s.bak-%s-triggeruser' % (path.name, STAMP))
        shutil.copy2(path, backup)
        path.write_text(new_text, encoding='utf-8', newline='\n')
        check = node_check(path)
        if check.returncode != 0:
            print('  [FAIL] src/index.js: node --check failed, restoring')
            print(check.stderr.strip()[:400])
            shutil.copy2(backup, path)
            failures += 1
            continue
        print('  [OK] src/index.js: 2 edits, %d -> %d bytes, node --check passed'
              % (len(text), len(new_text)))

    print('')
    if failures:
        print('%d problem(s)' % failures)
        return 1
    if not args.dry_run:
        print('RESTART both MimirLink instances: code + config changes.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
