# -*- coding: utf-8 -*-
"""Co-bot presence quota: when BOTH bots are active in a group, limit my own lines.

WHY (2026-10-11; user: "能不能在另一个bot在5分钟内在群聊发过言并且自己说过两句话
就会结束话题并且进5分钟冷却")
-------------------------------------------------------------------------------
The existing `botBanterMaxTurns` only covers ONE path: `if (isCoBot(config, event))`,
i.e. the message was sent BY the other bot. A message sent by a **human** has
`isCoBot === false`, so that whole branch is skipped and the cap never applies.

Measured fallout (two instances merged by timestamp): the two bots answer the SAME
human message at the same time -- shortest gap between two bot lines **0.07 s** --
which is physically impossible for a reply chain. 28 stretches carried >=2 bot lines;
the longest was 14 lines in 76 s.

What this patch adds -- a **presence-aware quota**, no cross-process channel needed:
  1. Whenever the other bot speaks in this group, remember `lastCoBotAt`.
     (Its line arrives here as an ordinary group message, so each process can tell
     on its own. No IPC.)
  2. While `now - lastCoBotAt < coBotActiveMs` (default 5 min) we are in the
     "both bots on stage" state.
  3. In that state this instance may add at most `coBotMyMaxLines` (default 2) lines.
  4. Quota spent -> stay silent and enter `coBotCooldownMs` (default 5 min) cooldown.
  5. Being @-mentioned still goes through (explicit summons).

Config keys written (defaults shown; `coBotYieldEnabled !== false` means on):
    chat.coBotYieldEnabled = true
    chat.coBotActiveMs     = 300000   # "the other bot spoke within 5 minutes"
    chat.coBotMyMaxLines   = 2        # "I have said two lines"
    chat.coBotCooldownMs   = 300000   # "5-minute cooldown"

Usage:
    python patch_cobot_yield.py --dry-run      # anchors + planned edits, no write
    python patch_cobot_yield.py                # apply (backs up first)
    python patch_cobot_yield.py --revert
"""
import argparse
import json
import pathlib
import shutil
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding='utf-8')

STAMP = time.strftime('%Y%m%d-%H%M%S')
MARKER = 'cobot-yield patch'
INSTANCES = ['MimirLink', 'MimirLink-soyo']
ROOTS = [pathlib.Path(r'C:\Users\20633') / n for n in INSTANCES]

BLOCK = '''// >>> cobot-yield patch (managed by patch_cobot_yield.py) >>>
// 用户 2026-10-11：「在另一个 bot 在 5 分钟内在群聊发过言并且自己说过两句话
// 就会结束话题并且进 5 分钟冷却」
//
// 为什么需要它：上面的 `botBanterMaxTurns` 只覆盖「发言者 ∈ coBotIds」这一条路径。
// **群友发的消息 isCoBot=false ⇒ 整个分支被跳过** ⇒ 群友一说话，两个 bot 都能回，
// 配额完全不参与。实测两个 bot 抢答同一条群消息，最短间隔 0.07 秒。
//
// 本块加的是**在场感知配额**（不需要跨进程通信）：
//   ① 对方 bot 每在本群发一句 → 记 lastCoBotAt
//      （它的发言会作为普通群消息到达本实例，所以两个进程各记各的即可）
//   ② now - lastCoBotAt < coBotActiveMs（默认 5min）⇒ 处于「两个 bot 都在场」局面
//   ③ 这个局面下，本实例在本群最多再说 coBotMyMaxLines（默认 2）句
//   ④ 用完 → 静默 + coBotCooldownMs（默认 5min）冷却
//   ⑤ 被 @ 时不受限（那是明确指名）
const coBotYieldState = new Map();

function coBotYieldNoteCoBot(config, event) {
    if (config?.chat?.coBotYieldEnabled === false) return;
    if (event?.message_type !== 'group' || !event?.group_id) return;
    const key = String(event.group_id);
    const st = coBotYieldState.get(key) || { lastCoBotAt: 0, myLines: [], cooldownUntil: 0 };
    st.lastCoBotAt = Date.now();
    coBotYieldState.set(key, st);
}

// 'allow' / 'limit'
function coBotYieldDecision(config, event) {
    if (config?.chat?.coBotYieldEnabled === false) return 'allow';
    if (event?.message_type !== 'group' || !event?.group_id) return 'allow';
    const st = coBotYieldState.get(String(event.group_id));
    if (!st) return 'allow';
    const activeMs = Math.max(1000, Number(config?.chat?.coBotActiveMs) || 300000);
    const maxLines = Math.max(1, Number(config?.chat?.coBotMyMaxLines) || 2);
    const cooldownMs = Math.max(1000, Number(config?.chat?.coBotCooldownMs) || 300000);
    const now = Date.now();
    if (!st.lastCoBotAt || now - st.lastCoBotAt >= activeMs) return 'allow';
    if (now < st.cooldownUntil) return 'limit';
    st.myLines = (st.myLines || []).filter((t) => now - t < activeMs);
    if (st.myLines.length >= maxLines) {
        st.cooldownUntil = now + cooldownMs;
        st.myLines = [];
        coBotYieldState.set(String(event.group_id), st);
        return 'limit';
    }
    coBotYieldState.set(String(event.group_id), st);
    return 'allow';
}

// 只在**真的要回**时才记账 —— 挂在 accept() 上，所以 skip 掉的消息不占配额。
function coBotYieldMarkSpoken(config, event) {
    if (config?.chat?.coBotYieldEnabled === false) return;
    if (event?.message_type !== 'group' || !event?.group_id) return;
    if (isCoBot(config, event)) return;
    const key = String(event.group_id);
    const st = coBotYieldState.get(key);
    if (!st || !st.lastCoBotAt) return;
    const activeMs = Math.max(1000, Number(config?.chat?.coBotActiveMs) || 300000);
    const now = Date.now();
    if (now - st.lastCoBotAt >= activeMs) return;
    st.myLines = (st.myLines || []).filter((t) => now - t < activeMs);
    st.myLines.push(now);
    coBotYieldState.set(key, st);
}
// <<< cobot-yield patch <<<

'''

# ① accept() 里记账
ACCEPT_OLD = '''    const accept = (triggerReason) => ({
        shouldRespond: true,
        triggerReason,
        skipReason: '',
        checks
    });'''

ACCEPT_NEW = '''    const accept = (triggerReason) => {
        // >>> cobot-yield patch <<<
        coBotYieldMarkSpoken(config, event);
        // <<< cobot-yield patch <<<
        return {
            shouldRespond: true,
            triggerReason,
            skipReason: '',
            checks
        };
    };'''

# ② coBot 分支记「对方在场」
COBOT_OLD = '''        if (isCoBot(config, event)) {
            return botBanterDecision(config, event) === 'limit'
                ? skip('bot_banter_limit')
                : accept('co_bot');
        }'''

COBOT_NEW = '''        if (isCoBot(config, event)) {
            // >>> cobot-yield patch <<<
            coBotYieldNoteCoBot(config, event);
            // <<< cobot-yield patch <<<
            return botBanterDecision(config, event) === 'limit'
                ? skip('bot_banter_limit')
                : accept('co_bot');
        }'''

# ③ 群友消息路径上查配额
TRIGGER_OLD = '''        if (isTriggerUser(config, event)) {
            return accept('trigger_user');
        }'''

TRIGGER_NEW = '''        if (isTriggerUser(config, event)) {
            return accept('trigger_user');
        }
        // >>> cobot-yield patch <<<
        if (!isAtMe && coBotYieldDecision(config, event) === 'limit') {
            return skip('cobot_yield');
        }
        // <<< cobot-yield patch <<<'''

CFG_DEFAULTS = [
    ('coBotYieldEnabled', True),
    ('coBotActiveMs', 300000),
    ('coBotMyMaxLines', 2),
    ('coBotCooldownMs', 300000),
]


def node_check(path):
    node = r'C:\Users\20633\.workbuddy\binaries\node\versions\22.22.2-6\node.exe'
    if not pathlib.Path(node).exists():
        node = 'node'
    return subprocess.run([node, '--check', str(path)], capture_output=True, text=True)


def patch_config(root, dry_run):
    path = root / 'config.json'
    cfg = json.loads(path.read_text(encoding='utf-8'))
    chat = cfg.setdefault('chat', {})
    changed = []
    for k, v in CFG_DEFAULTS:
        if chat.get(k) != v:
            chat[k] = v
            changed.append('%s=%s' % (k, json.dumps(v)))
    if not changed:
        print('  [SKIP] config.json 已是最新')
        return 0
    if dry_run:
        print('  [dry-run] config.json: %s' % '; '.join(changed))
        return 0
    shutil.copy2(path, path.with_name('config.json.bak-%s-cobotyield' % STAMP))
    path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding='utf-8')
    back = json.loads(path.read_text(encoding='utf-8'))['chat']
    for k, v in CFG_DEFAULTS:
        assert back[k] == v, k
    print('  [OK] config.json: %s' % '; '.join(changed))
    return 0


def apply_js(root, dry_run):
    path = root / 'src/index.js'
    text = path.read_text(encoding='utf-8')
    if MARKER in text:
        print('  [SKIP] src/index.js 已经打过这个补丁')
        return 0
    edits = [(ACCEPT_OLD, ACCEPT_NEW, 'accept() 记账'),
             (COBOT_OLD, COBOT_NEW, 'coBot 分支记对方在场'),
             (TRIGGER_OLD, TRIGGER_NEW, '群友路径查配额')]
    for old, _new, label in edits:
        n = text.count(old)
        if n != 1:
            print('  [FAIL] anchor「%s」出现 %d 次（应为 1）' % (label, n))
            return 1
    # 补丁块插在 buildRoutingDecision 之前（前面就是 bot-banter-limit 块，
    # 那里已有 isCoBot 定义）—— 不能用 `<<< bot-banter-limit patch <<<` 作锚点，
    # 它出现两次（块级 + 路由内）。
    anchor = 'function buildRoutingDecision(config, event, plainText, isAtMe, messageInfo = {}) {'
    if text.count(anchor) != 1:
        print('  [FAIL] 找不到唯一的 buildRoutingDecision 声明（出现 %d 次）'
              % text.count(anchor))
        return 1
    new_text = text.replace(anchor, BLOCK + anchor, 1)
    for old, new, _label in edits:
        new_text = new_text.replace(old, new, 1)
    if dry_run:
        print('  [dry-run] src/index.js: %d 处编辑（%d -> %d 字节）'
              % (len(edits) + 1, len(text), len(new_text)))
        return 0
    backup = path.with_name('%s.bak-%s-cobotyield' % (path.name, STAMP))
    shutil.copy2(path, backup)
    path.write_text(new_text, encoding='utf-8', newline='\n')
    check = node_check(path)
    if check.returncode != 0:
        print('  [FAIL] node --check 失败，已还原')
        print(check.stderr.strip()[:400])
        shutil.copy2(backup, path)
        return 1
    print('  [OK] src/index.js: %d 处编辑，%d -> %d 字节，node --check 通过'
          % (len(edits) + 1, len(text), len(new_text)))
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--revert', action='store_true')
    args = ap.parse_args()

    if args.revert:
        n = 0
        for root in ROOTS:
            for b in sorted(root.glob('src/*.bak-*cobotyield*')):
                shutil.copy2(b, b.with_name(b.name.split('.bak-')[0]))
                n += 1
            for b in sorted(root.glob('config.json.bak-*cobotyield*')):
                shutil.copy2(b, root / 'config.json')
                n += 1
        print('reverted %d file(s)' % n)
        return 0

    print('=' * 72)
    print('patch cobot-yield   dry-run=%s' % args.dry_run)
    print('=' * 72)
    failures = 0
    for root in ROOTS:
        print('\n--- %s ---' % root.name)
        failures += patch_config(root, args.dry_run)
        failures += apply_js(root, args.dry_run)
    print('')
    if failures:
        print('%d problem(s)' % failures)
        return 1
    if not args.dry_run:
        print('两个实例都要重启才生效。')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
