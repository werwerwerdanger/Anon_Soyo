#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_oj_feedback.py
把「OJ 反馈轮询」的配置写进四个配置文件，但**真凭据只写进 config.json**。

为什么要分文件写
----------------
单实例上实际生效的是 `config.json`，它是 **gitignored**；
而 `config.example.json` / `configs/*.json` 是**进版本库**的（发布管线还会另跑
`assert_no_secrets()` 扫 `configs/`）。所以：

  config.json               enabled=true,  真 username/password, 真 notifyGroups
  configs/anon.json         enabled=false, password=""
  configs/soyo.json         enabled=false, password=""   （soyo 要开就自己填自己的账号）
  config.example.json       enabled=false, password=""

`chat.adminUsers` 同理：只在 config.json 里填真实 QQ，其余给空数组。

插入点
------
1) 顶层 `ojFeedback` 块         —— 锚点是顶层 `  "memory": {`
2) `chat.commands.ojFeedback`   —— 锚点是 commands 里 participantProfileManual 那一段
3) `chat.adminUsers`            —— 锚点是 `    "allowedGroups": [],`

幂等：已存在就跳过。--revert 只删本脚本加的东西。
"""
import argparse
import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INSTANCE_ROOT = os.path.join(os.path.expanduser('~'), 'MimirLink')
SOYO_ROOT = os.path.join(os.path.dirname(INSTANCE_ROOT), 'MimirLink-soyo')

# 用户口径：私聊和群都发 → 群这里是 2026程序设计协会
DEFAULT_GROUPS = ["929159193"]
# 用户自己的 QQ（config.json 里的 chat.adminUsers）
DEFAULT_ADMIN_QQ = "2063362809"

# ── 插入点 1：顶层 ojFeedback ───────────────────────────────────────────────
TOP_ANCHOR = '''  "memory": {'''


def top_patched(username, password, enabled, groups):
    groups_json = json.dumps(groups, ensure_ascii=False)
    return '''  "ojFeedback": {
    "enabled": %s,
    "baseUrl": "https://47.109.76.66:3002",
    "username": "%s",
    "password": "%s",
    "intervalMs": 60000,
    "timeoutMs": 15000,
    "notifyPrivate": true,
    "notifyGroups": %s,
    "aiComment": true,
    "maxPerPoll": 5,
    "maxContentChars": 1200,
    "stateFile": "data/oj-feedback-state.json"
  },
  "memory": {''' % ('true' if enabled else 'false', username, password, groups_json)


# ── 插入点 2：chat.commands.ojFeedback ─────────────────────────────────────
# ⚠ 锚点必须按文件**真实排版**写：commands 块现在最后一项是 roster-commands patch
#   加进去的 "thinking"，不是 participantProfileManual（那是我第一次写错的地方）。
CMD_ANCHOR = '''      "thinking": {
        "enabled": true,
        "command": "/思考"
      }
    },'''

CMD_PATCHED = '''      "thinking": {
        "enabled": true,
        "command": "/思考"
      },
      "ojFeedback": {
        "enabled": true,
        "command": "/反馈"
      }
    },'''

# ── 插入点 3：chat.adminUsers ──────────────────────────────────────────────
ADMIN_ANCHOR = '''    "allowedGroups": [],'''

ADMIN_PATCHED_PATTERN = '''    "adminUsers": %s,
    "allowedGroups": [],'''


def read(path):
    with io.open(path, 'r', encoding='utf-8') as fh:
        return fh.read()


def write(path, text):
    with io.open(path, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(text)


def patch_once(text, anchor, replacement, revert):
    if revert:
        if replacement in text:
            return text.replace(replacement, anchor, 1), 'reverted'
        return text, 'absent'
    if replacement in text:
        return text, 'already'
    if anchor not in text:
        return text, 'anchor-miss'
    return text.replace(anchor, replacement, 1), 'patched'


def process(path, *, username, password, enabled, groups, admin_qq, revert):
    text = read(path)
    actions = []
    ok = True

    text, act = patch_once(text, CMD_ANCHOR, CMD_PATCHED, revert)
    actions.append('commands=%s' % act)
    if act == 'anchor-miss':
        ok = False

    admin_new = ADMIN_PATCHED_PATTERN % json.dumps(
        [admin_qq] if admin_qq else [], ensure_ascii=False)
    text, act = patch_once(text, ADMIN_ANCHOR, admin_new, revert)
    actions.append('adminUsers=%s' % act)
    if act == 'anchor-miss':
        ok = False

    text, act = patch_once(text, TOP_ANCHOR,
                           top_patched(username, password, enabled, groups), revert)
    actions.append('ojFeedback=%s' % act)
    if act == 'anchor-miss':
        ok = False

    if any('patched' in a or 'reverted' in a for a in actions):
        write(path, text)

    try:
        cfg = json.loads(read(path))
        block = cfg.get('ojFeedback', {})
        detail = 'enabled=%s user=%r pwd_len=%d groups=%s' % (
            block.get('enabled'), block.get('username'),
            len(block.get('password') or ''), block.get('notifyGroups'))
    except Exception as exc:
        detail = '!! JSON 解析失败: %s' % exc
        ok = False

    print('%-46s %s' % (os.path.relpath(path, os.path.dirname(INSTANCE_ROOT)),
                        ' '.join(actions)))
    print('%-46s   -> %s' % ('', detail))
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--password-file', default=None,
                    help='真密码所在文件（只写进 config.json）。不给则用空密码。')
    ap.add_argument('--username', default='Chihaya_Anon')
    ap.add_argument('--admin-qq', default=DEFAULT_ADMIN_QQ)
    ap.add_argument('--groups', default=','.join(DEFAULT_GROUPS))
    ap.add_argument('--revert', action='store_true')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    password = ''
    if args.password_file and os.path.exists(args.password_file):
        password = read(args.password_file).strip()
    groups = [g.strip() for g in args.groups.split(',') if g.strip()]

    real = os.path.join(INSTANCE_ROOT, 'config.json')
    targets = [
        # (路径, 真凭据?, 启用?)
        (real, True, True),
        (os.path.join(INSTANCE_ROOT, 'configs', 'anon.json'), False, False),
        (os.path.join(INSTANCE_ROOT, 'config.example.json'), False, False),
        (os.path.join(SOYO_ROOT, 'configs', 'soyo.json'), False, False),
        # soyo 是另一个角色，别继承 anon 的 OJ 账号：留空 + 关闭，要用自己填
        (os.path.join(SOYO_ROOT, 'config.json'), False, False),
        (os.path.join(SOYO_ROOT, 'config.example.json'), False, False),
    ]

    if args.dry_run:
        for path, is_real, enabled in targets:
            if not os.path.exists(path):
                continue
            text = read(path)
            print('%-46s ojFeedback=%s commands=%s' % (
                os.path.relpath(path, os.path.dirname(INSTANCE_ROOT)),
                top_patched('', '', enabled, groups) in text,
                CMD_PATCHED in text))
        return 0

    all_ok = True
    for path, is_real, enabled in targets:
        if not os.path.exists(path):
            print('%-46s (不存在，跳过)' % os.path.relpath(path, os.path.dirname(INSTANCE_ROOT)))
            continue
        all_ok = process(
            path,
            username=args.username if is_real else '',
            password=password if is_real else '',
            enabled=enabled,
            groups=groups if is_real else [],
            admin_qq=args.admin_qq if is_real else '',
            revert=args.revert
        ) and all_ok
    return 0 if all_ok else 1


if __name__ == '__main__':
    sys.exit(main())
