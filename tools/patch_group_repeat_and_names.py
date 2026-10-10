# -*- coding: utf-8 -*-
"""Two group-chat annoyances, in one patch.

1) "重复发言不要在群聊触发"
   The 2026-10-31 repeat-suppress patch dedupes on session + USER + text, which was
   deliberate: it must not swallow 群聊复读 (different people saying the same thing),
   because groupRepeat detection depends on seeing those. But the flip side is that in
   a group, ten people pasting the same line still each trigger a reply -- the observed
   complaint. So add a GROUP-ONLY, sender-agnostic text memory at the routing layer:
   the second and later identical line in the same group within the window is skipped
   (and simply not answered -- the message is still let through, so groupRepeat keeps
   working).

2) "素世不认识自己是素食"
   '素食' (the homophone the group uses for her) was added to her personality as a name,
   but NOT to triggerKeywords -- so she never even got a turn when someone used it.
   Add it (plus そよ) to soyo's triggerKeywords.

What is deliberately NOT here: turning long group replies into private messages. That
needs a choice (private send fails outright when the sender is not a friend), so it is
left for an explicit decision.

Usage:
    python patch_group_repeat_and_names.py [--dry-run] [--revert]
"""
import argparse
import json
import pathlib
import shutil
import subprocess
import time

STAMP = time.strftime('%Y%m%d-%H%M%S')
MARKER = 'group-repeat-and-names patch'
INSTANCES = ['MimirLink', 'MimirLink-soyo']
ROOTS = [pathlib.Path(r'C:\Users\20633') / n for n in INSTANCES]

BLOCK = '''// >>> group-repeat-and-names patch (managed by patch_group_repeat_and_names.py) >>>
// 群里「同一句被多人重复」不该每条都触发一次回复。注意与 patch_repeat_suppress.py 的分工：
// 那个按「会话+用户+内容」去重（保住群聊复读的探测能力），这个按「群+内容」不区分发言者，
// 只用来**抑制触发**，消息本身照常入库。
const recentGroupTexts = new Map();

function groupTextKey(groupId, text) {
    return `${groupId}:${String(text ?? '').trim().replace(/\\s+/g, ' ')}`;
}

function isRepeatedGroupText(config, event, plainText) {
    const windowMs = Math.max(0, Number(config?.chat?.groupRepeatSuppressMs) || 0);
    if (windowMs <= 0) return false;
    if (event?.message_type !== 'group' || !event?.group_id) return false;
    const key = groupTextKey(event.group_id, plainText);
    if (!key.split(':')[1]) return false;
    const now = Date.now();
    for (const [k, ts] of [...recentGroupTexts.entries()]) {
        if (now - ts > windowMs) recentGroupTexts.delete(k);
    }
    if (recentGroupTexts.has(key)) return true;
    recentGroupTexts.set(key, now);
    return false;
}
// <<< group-repeat-and-names patch <<<

'''

ROUTE_ANCHOR = '''        // <<< trigger-users patch <<<'''
ROUTE_NEW = '''        // <<< trigger-users patch <<<
        // >>> group-repeat-and-names patch <<<
        // 放在关键词/@ 之前：否则复读的那句只要含关键词，照样每条都触发一次。
        // 只让「直接回复机器人」绕开它（那是有明确指向的动作）。
        if (isRepeatedGroupText(config, event, routingText)) {
            return skip('repeated_text');
        }
        // <<< group-repeat-and-names patch <<<'''

EDITS = {'src/index.js': [(ROUTE_ANCHOR, ROUTE_NEW)]}


def node_check(path):
    node = r'C:\Users\20633\.workbuddy\binaries\node\versions\22.22.2-6\node.exe'
    if not pathlib.Path(node).exists():
        node = 'node'
    return subprocess.run([node, '--check', str(path)], capture_output=True, text=True)


def patch_config(root, dry_run):
    path = root / 'config.json'
    cfg = json.loads(path.read_text(encoding='utf-8'))
    chat = cfg['chat']
    changed = []
    if chat.get('groupRepeatSuppressMs') != 120000:
        chat['groupRepeatSuppressMs'] = 120000
        changed.append('groupRepeatSuppressMs=120000')
    # only soyo is addressed as 素食
    if root.name.endswith('soyo'):
        kws = chat.get('triggerKeywords') or []
        for extra in ('素食', 'そよ'):
            if extra not in kws:
                kws.append(extra)
                changed.append('triggerKeywords += %s' % extra)
        chat['triggerKeywords'] = kws
    if not changed:
        print('  [SKIP] config.json already patched')
        return 0
    if dry_run:
        print('  [dry-run] config.json: %s' % '; '.join(changed))
        return 0
    shutil.copy2(path, path.with_name('config.json.bak-%s-grepeat' % STAMP))
    path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding='utf-8')
    back = json.loads(path.read_text(encoding='utf-8'))['chat']
    assert back['groupRepeatSuppressMs'] == 120000
    print('  [OK] config.json: %s' % '; '.join(changed))
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--revert', action='store_true')
    args = ap.parse_args()

    if args.revert:
        n = 0
        for root in ROOTS:
            for b in sorted(root.glob('src/*.bak-*grepeat*')):
                shutil.copy2(b, b.with_name(b.name.split('.bak-')[0]))
                n += 1
            for b in sorted(root.glob('config.json.bak-*grepeat*')):
                shutil.copy2(b, root / 'config.json')
                n += 1
        print('reverted %d file(s)' % n)
        return 0

    print('=' * 72)
    print('patch group repeat + names   dry-run=%s' % args.dry_run)
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
        n = text.count(ROUTE_ANCHOR)
        if n != 1:
            print('  [FAIL] anchor appears %d times (want 1)' % n)
            failures += 1
            continue
        # insert the marked block right before buildRoutingDecision, then the route edit
        helper_anchor = 'function buildRoutingDecision(config, event, plainText, isAtMe, messageInfo = {}) {'
        if text.count(helper_anchor) != 1:
            print('  [FAIL] buildRoutingDecision anchor is not unique')
            failures += 1
            continue
        new_text = text.replace(helper_anchor, BLOCK + helper_anchor, 1)
        new_text = new_text.replace(ROUTE_ANCHOR, ROUTE_NEW, 1)
        if args.dry_run:
            print('  [dry-run] src/index.js: 2 edits (%d -> %d bytes)' % (len(text), len(new_text)))
            continue
        backup = path.with_name('%s.bak-%s-grepeat' % (path.name, STAMP))
        shutil.copy2(path, backup)
        path.write_text(new_text, encoding='utf-8', newline='\n')
        check = node_check(path)
        if check.returncode != 0:
            print('  [FAIL] node --check failed, restoring')
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
        print('RESTART both MimirLink instances.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
