# -*- coding: utf-8 -*-
"""Cap bot-to-bot banter inside a group, so two bots cannot ping-pong forever.

WHY (2026-10-09; user: "只有soyo和anon吵起来的时候会去私聊 平时都是吵一下就不吵了")
-------------------------------------------------------------------------------
Verified premise: the two instances really do see each other. Soyo's log contains 902
messages from anon's QQ (2458713318); anon's log contains 1325 from soyo's (3628056487).
Both bots sit in group 929159193, so a line that mentions the other's trigger keyword
starts a loop -- and the group log shows the fallout ("素食和爱音都被禁言了").

What this patch does (the half that needs no new assumptions):
  * chat.coBotIds        -- the bot accounts that must not start/mod长 a group argument
  * chat.botBanterMaxTurns -- how many consecutive bot-to-bot lines a group may carry
                              (default 2); a human speaking resets the count
  * once the cap is hit the bot stops answering in the group: skip('bot_banter_limit')

What is NOT here: "take it to private chat". Sending a private message to the other bot
requires the two accounts to be QQ friends; if they are not, the send simply fails. That
is an account-level precondition, not something the code can work around.

Usage:
    python patch_bot_banter_limit.py [--dry-run] [--revert]
"""
import argparse
import json
import pathlib
import shutil
import subprocess
import time

STAMP = time.strftime('%Y%m%d-%H%M%S')
MARKER = 'bot-banter-limit patch'
INSTANCES = ['MimirLink', 'MimirLink-soyo']
ROOTS = [pathlib.Path(r'C:\Users\20633') / n for n in INSTANCES]

BLOCK = '''// >>> bot-banter-limit patch (managed by patch_bot_banter_limit.py) >>>
// 群里两个机器人互相触发会形成循环（实测两边都能看见对方：902 / 1325 条），
// 而且已经导致群内被禁言。
// ⚠ 2026-10-09 修：初版是「人类一说话就清零」—— 但活跃群里人类一直在插话，
// 计数**永远到不了上限**，等于没做（实测 21:20 有 co_bot 却始终没有 bot_banter_limit）。
// 改成**滑动窗口计数**：在 botBanterWindowMs 内机器人之间的来回累计到上限就停，
// 人类插话不再清零。
const botBanterTurns = new Map();

function isCoBot(config, event) {
    const list = config?.chat?.coBotIds;
    if (!Array.isArray(list) || list.length === 0) return false;
    const id = String(event?.user_id ?? '').trim();
    return Boolean(id) && list.some((v) => String(v ?? '').trim() === id);
}

// 返回 'human'（不是机器人）/ 'allow' / 'limit'
function botBanterDecision(config, event) {
    if (event?.message_type !== 'group' || !event?.group_id) return 'human';
    if (!isCoBot(config, event)) return 'human';
    const maxTurns = Math.max(0, Number(config?.chat?.botBanterMaxTurns) || 0);
    const windowMs = Math.max(1000, Number(config?.chat?.botBanterWindowMs) || 300000);
    const key = String(event.group_id);
    const now = Date.now();
    const recent = (botBanterTurns.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= maxTurns) {
        botBanterTurns.set(key, recent);
        return 'limit';
    }
    recent.push(now);
    botBanterTurns.set(key, recent);
    return 'allow';
}
// <<< bot-banter-limit patch <<<

'''

ROUTE_ANCHOR = '''    if (event.message_type === 'group') {
        if (messageInfo.replyToBot) {
            return accept('reply_to_bot');
        }'''
ROUTE_NEW = '''    if (event.message_type === 'group') {
        if (messageInfo.replyToBot) {
            return accept('reply_to_bot');
        }
        // >>> bot-banter-limit patch <<<
        const banter = botBanterDecision(config, event);
        if (banter === 'limit') {
            return skip('bot_banter_limit');
        }
        if (banter === 'allow') {
            return accept('co_bot');
        }
        // <<< bot-banter-limit patch <<<'''

CFG_MARK = '"coBotIds"'
CFG_ANCHOR = '"triggerUsers": ['


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
    if chat.get('coBotIds') != ['3628056487', '2458713318']:
        chat['coBotIds'] = ['3628056487', '2458713318']
        changed.append('coBotIds=[' + ','.join(chat['coBotIds']) + ']')
    if chat.get('botBanterMaxTurns') != 2:
        chat['botBanterMaxTurns'] = 2
        changed.append('botBanterMaxTurns=2')
    if chat.get('botBanterWindowMs') != 300000:
        chat['botBanterWindowMs'] = 300000
        changed.append('botBanterWindowMs=300000')
    if not changed:
        print('  [SKIP] config.json already patched')
        return 0
    if dry_run:
        print('  [dry-run] config.json: %s' % '; '.join(changed))
        return 0
    shutil.copy2(path, path.with_name('config.json.bak-%s-banter' % STAMP))
    path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding='utf-8')
    back = json.loads(path.read_text(encoding='utf-8'))['chat']
    assert back['botBanterMaxTurns'] == 2 and len(back['coBotIds']) == 2
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
            for b in sorted(root.glob('src/*.bak-*banter*')):
                shutil.copy2(b, b.with_name(b.name.split('.bak-')[0]))
                n += 1
            for b in sorted(root.glob('config.json.bak-*banter*')):
                shutil.copy2(b, root / 'config.json')
                n += 1
        print('reverted %d file(s)' % n)
        return 0

    print('=' * 72)
    print('patch bot-banter limit   dry-run=%s' % args.dry_run)
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
        anchor = 'function buildRoutingDecision(config, event, plainText, isAtMe, messageInfo = {}) {'
        for a in (ROUTE_ANCHOR, anchor):
            if text.count(a) != 1:
                print('  [FAIL] anchor appears %d times (want 1): %r' % (text.count(a), a[:50]))
                failures += 1
                break
        else:
            new_text = text.replace(anchor, BLOCK + anchor, 1).replace(ROUTE_ANCHOR, ROUTE_NEW, 1)
            if args.dry_run:
                print('  [dry-run] src/index.js: 2 edits (%d -> %d bytes)' % (len(text), len(new_text)))
                continue
            backup = path.with_name('%s.bak-%s-banter' % (path.name, STAMP))
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
