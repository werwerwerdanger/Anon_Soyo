#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_roster_commands.py
把「人物类指令 + 思考显示」的配置键写进 config.json / configs/*.json / config.example.json。

两个插入点：
  1) chat.commands 里补 roster / forget / thinking
  2) chat.sendReasoningToQQ 后面补 showThinking 块

幂等：已存在就跳过（整体重跑不会写两遍）。
--revert 只删本脚本加的东西。
"""
import argparse
import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

COMMANDS_ANCHOR = '''      "participantProfileManual": {
        "enabled": true,
        "command": "/人物档案"
      }
    },'''

COMMANDS_PATCHED = '''      "participantProfileManual": {
        "enabled": true,
        "command": "/人物档案"
      },
      "roster": {
        "enabled": true,
        "command": "/名册",
        "maxEntries": 100,
        "maxAliases": 8
      },
      "forget": {
        "enabled": true,
        "command": "/忘记"
      },
      "thinking": {
        "enabled": true,
        "command": "/思考"
      }
    },'''

SHOW_THINKING_ANCHOR = '''    "sendReasoningToQQ": false,'''

SHOW_THINKING_PATCHED = '''    "sendReasoningToQQ": false,
    "showThinking": {
      "enabled": false,
      "format": "paren",
      "label": "思考",
      "maxChars": 1200,
      "position": "after",
      "scope": "all"
    },'''


def read(path):
    with io.open(path, 'r', encoding='utf-8') as fh:
        return fh.read()


def write(path, text):
    with io.open(path, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(text)


def patch_text(text, anchor, replacement, label, revert, target):
    """返回 (新文本, 动作)。已有则不动；revert 时把 replacement 还原成 anchor。"""
    if revert:
        if replacement in text:
            return text.replace(replacement, anchor, 1), 'reverted'
        return text, 'absent'
    if replacement in text:
        return text, 'already'
    if anchor not in text:
        return text, 'anchor-miss'
    return text.replace(anchor, replacement, 1), 'patched'


def process(path, revert):
    text = read(path)
    changed = []
    ok = True

    text, act = patch_text(text, SHOW_THINKING_ANCHOR, SHOW_THINKING_PATCHED, 'showThinking', revert, path)
    changed.append(('showThinking', act))
    if act == 'anchor-miss':
        ok = False

    text, act = patch_text(text, COMMANDS_ANCHOR, COMMANDS_PATCHED, 'commands', revert, path)
    changed.append(('commands', act))
    if act == 'anchor-miss':
        ok = False

    if any(a in ('patched', 'reverted') for _, a in changed):
        write(path, text)

    # JSON 必须仍然可解析
    try:
        json.loads(read(path))
        parse_ok = True
    except Exception as exc:  # pragma: no cover
        parse_ok = False
        print('  !! JSON 解析失败: %s' % exc)

    flags = ' '.join('%s=%s' % (k, v) for k, v in changed)
    print('%-28s %s%s' % (os.path.relpath(path, ROOT), flags, '' if parse_ok else '  <<< BAD JSON'))
    return ok and parse_ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--revert', action='store_true')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    targets = [
        os.path.join(ROOT, 'config.json'),
        os.path.join(ROOT, 'config.example.json'),
        os.path.join(ROOT, 'configs', 'anon.json'),
        os.path.join(ROOT, 'configs', 'soyo.json'),
    ]

    if args.dry_run:
        for p in targets:
            text = read(p)
            print('%-28s showThinking=%s commands=%s' % (
                os.path.relpath(p, ROOT),
                SHOW_THINKING_PATCHED in text,
                COMMANDS_PATCHED in text))
        return 0

    all_ok = True
    for p in targets:
        if not os.path.exists(p):
            print('%-28s (不存在，跳过)' % os.path.relpath(p, ROOT))
            continue
        all_ok = process(p, args.revert) and all_ok
    return 0 if all_ok else 1


if __name__ == '__main__':
    sys.exit(main())
