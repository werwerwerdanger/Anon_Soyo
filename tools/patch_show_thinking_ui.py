#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_show_thinking_ui.py
给 WebUI（public/index.html）补上「思考显示」的勾选框 —— 面板上点一下，不用手改 JSON。

三个插入点（都在 public/index.html）：
  1) 「调试：发送思维链到 QQ」那个 form-group 后面加一个新的 form-group
  2) loadConfig 里回填 checkbox
  3) 保存 payload 里带上 showThinking.enabled

⚠ 只覆盖 `enabled`。`format/label/maxChars/position/scope` 保持 config.json 里的值不动
（面板上没有这些控件，回写时不能把用户手写的配置抹掉）。所以保存侧用的是**展开现有值 +
只改 enabled** 的写法 —— 见 THINKING_PAYLOAD。

幂等：已存在就跳过。--revert 只删本脚本加的东西。
"""
import argparse
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# ⚠ 本脚本在 <项目>/mimir-tools/ 下，但两个实例在 C:\Users\20633\ 下。
#   别的 patch_*.py 都是对"当前工作目录里的仓库"操作，这个要处理两个实例，
#   所以显式列出实例根目录。
INSTANCE_ROOT = os.path.join(os.path.expanduser('~'), 'MimirLink')

HTML_ANCHOR = '''                            <div class="form-group">
                                <label class="checkbox-label">
                                    <input type="checkbox" id="config-chat-send-reasoning-to-qq">
                                    调试：发送思维链到 QQ
                                </label>
                                <p class="hint-text">开启后回复会带上思维链，仅调试用。</p>
                            </div>'''

HTML_PATCHED = HTML_ANCHOR + '''
                            <!-- >>> show-thinking-ui patch >>> -->
                            <div class="form-group">
                                <label class="checkbox-label">
                                    <input type="checkbox" id="config-chat-show-thinking">
                                    用括号显示思考内容
                                </label>
                                <p class="hint-text">开启后自己的回复末尾会多一段「（思考：…）」。样式/长度/作用域在 config.json 的 chat.showThinking 里调，也可以直接发 /思考 开 临时打开。</p>
                            </div>
                            <!-- <<< show-thinking-ui patch <<< -->'''

LOAD_ANCHOR = """                document.getElementById('config-chat-send-reasoning-to-qq').checked = currentConfig.chat?.sendReasoningToQQ === true;"""

LOAD_PATCHED = LOAD_ANCHOR + """
                // >>> show-thinking-ui patch >>>
                document.getElementById('config-chat-show-thinking').checked = currentConfig.chat?.showThinking?.enabled === true;
                // <<< show-thinking-ui patch <<<"""

SAVE_ANCHOR = """                    sendReasoningToQQ: document.getElementById('config-chat-send-reasoning-to-qq').checked,"""

SAVE_PATCHED = SAVE_ANCHOR + """
                    // >>> show-thinking-ui patch >>>
                    // 只写 enabled：format/label/maxChars/position/scope 面板上没有控件，
                    // 必须原样带回，否则一次「保存」就会把用户手写的配置抹成默认值。
                    showThinking: {
                        ...(currentConfig.chat?.showThinking || {}),
                        enabled: document.getElementById('config-chat-show-thinking').checked
                    },
                    // <<< show-thinking-ui patch <<<"""


def read(path):
    with io.open(path, 'r', encoding='utf-8') as fh:
        return fh.read()


def write(path, text):
    with io.open(path, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(text)


def patch(text, anchor, replacement, revert):
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
    actions = []
    ok = True
    for anchor, replacement, name in (
        (HTML_ANCHOR, HTML_PATCHED, 'html'),
        (LOAD_ANCHOR, LOAD_PATCHED, 'load'),
        (SAVE_ANCHOR, SAVE_PATCHED, 'save'),
    ):
        text, act = patch(text, anchor, replacement, revert)
        actions.append('%s=%s' % (name, act))
        if act == 'anchor-miss':
            ok = False
    if any('patched' in a or 'reverted' in a for a in actions):
        write(path, text)
    print('%-58s %s' % (path, ' '.join(actions)))
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--revert', action='store_true')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    targets = [
        os.path.join(INSTANCE_ROOT, 'public', 'index.html'),
    ]
    soyo = os.path.join(os.path.dirname(INSTANCE_ROOT), 'MimirLink-soyo', 'public', 'index.html')
    if os.path.exists(soyo):
        targets.append(soyo)

    if args.dry_run:
        for p in targets:
            text = read(p)
            print('%-46s html=%s load=%s save=%s' % (
                p,
                HTML_PATCHED in text, LOAD_PATCHED in text, SAVE_PATCHED in text))
        return 0

    all_ok = True
    for p in targets:
        all_ok = process(p, args.revert) and all_ok
    return 0 if all_ok else 1


if __name__ == '__main__':
    sys.exit(main())
