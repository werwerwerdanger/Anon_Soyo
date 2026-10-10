#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_sticker_react.py -- 别再"描述表情"，改成"对表情做个反应"

根因（2026-10-10 用户："一直在解析我的表情包是什么"）：
current-message-focus.js 里有一行

    if (intent === 'emoji_reaction') {
        strategies.push('describe_visible_emoji_or_mood');
    }

而 detectIntent() 在 hasEmojiSegment(event) 为真时返回 'emoji_reaction'，
hasEmojiSegment 匹配的正是 QQ 的 face / mface / marketface —— **就是表情包**。

也就是说：用户每发一张表情，提示词就被追加一句**字面意思为"描述可见的表情"**的指令。
这不是角色的性格问题，是一行我从没碰过的代码在明确命令模型去描述。

改成 react_to_sticker_briefly_do_not_describe_it，
并在 `注意:` 行补一句对应的中文（那里离生成最近、效果最强）。

配套：卡的 mes_example 已加 4 组"收图只反应不报画面"的示范；
system_prompt 已加两条规则。**示例是主力，这条是拆掉反向指令。**

用法:
  python patch_sticker_react.py --check
  python patch_sticker_react.py
"""
import argparse
import os
import shutil
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

DIRS = [r"C:\Users\20633\MimirLink-soyo\src", r"C:\Users\20633\MimirLink\src"]

MARK = "// >>> sticker-react patch (managed by patch_sticker_react.py) >>>"
MARK_E = "// <<< sticker-react patch <<<"

STRAT_OLD = """    if (intent === 'emoji_reaction') {
        strategies.push('describe_visible_emoji_or_mood');
    }"""
STRAT_NEW = """    """ + MARK + """
    // 原来这里 push 的是 'describe_visible_emoji_or_mood'（字面意思：描述可见的表情），
    // 结果机器人收到表情包就逐张描述画面/念图上的字。真人收到表情只会给反应。
    if (intent === 'emoji_reaction') {
        strategies.push('react_to_sticker_briefly_do_not_describe_it');
    }
    """ + MARK_E

WARN_ANCHOR = """        + '张嘴就直接接对方说的内容，第一句别去评价对方这句话本身；不要收尾金句'
    );"""
WARN_NEW = WARN_ANCHOR + """
    """ + MARK + """
    if (intent === 'emoji_reaction') {
        warnings.push('收到表情包就笑一下或吐槽一句，不要报图里画的是什么、不要念图上的字');
    }
    """ + MARK_E


def node_check(path):
    try:
        r = subprocess.run(["node", "--check", path], capture_output=True, text=True, timeout=60)
        return r.returncode == 0, (r.stderr or "").strip()
    except Exception as e:
        return False, str(e)


def apply_file(path, dry=False):
    if not os.path.exists(path):
        return f"!! 不存在: {path}"
    src = open(path, "r", encoding="utf-8").read()
    if MARK in src:
        return f"-- 已打过补丁 ({len(src)} chars)"
    out = src
    notes = []
    for name, old, new in (("strategy", STRAT_OLD, STRAT_NEW), ("warning", WARN_ANCHOR, WARN_NEW)):
        if out.count(old) != 1:
            return f"!! [{name}] 锚点命中 {out.count(old)} 次（应为 1）"
        out = out.replace(old, new, 1)
        notes.append(name)
    if dry:
        return f"DRY ok ({','.join(notes)}) {len(src)} -> {len(out)}"
    bak = path + ".bak-" + time.strftime("%Y%m%d-%H%M%S") + "-sticker"
    shutil.copy2(path, bak)
    open(path, "w", encoding="utf-8").write(out)
    ok, err = node_check(path)
    if not ok:
        shutil.copy2(bak, path)
        return f"!! node --check 失败，已还原\n   {err[:300]}"
    after = open(path, "r", encoding="utf-8").read()
    problems = []
    # 注意：旧 token 会出现在补丁的注释里，所以断言要查 push(...) 调用本身
    if "push('describe_visible_emoji_or_mood')" in after:
        problems.append("旧的'描述表情'指令仍然存在")
    if "react_to_sticker_briefly_do_not_describe_it" not in after:
        problems.append("新策略缺失")
    if "不要报图里画的是什么" not in after:
        problems.append("中文提示缺失")
    if problems:
        shutil.copy2(bak, path)
        return "!! 断言失败，已还原: " + "; ".join(problems)
    return f"OK ({','.join(notes)}) {len(src)} -> {len(out)} chars  备份={os.path.basename(bak)}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()
    for d in DIRS:
        p = os.path.join(d, "current-message-focus.js")
        print("=" * 70)
        print(p)
        if args.check:
            src = open(p, encoding="utf-8").read() if os.path.exists(p) else ""
            ok, _ = node_check(p)
            print(f"  补丁={MARK in src}"
                  f"  旧指令调用残留={"push('describe_visible_emoji_or_mood')" in src}"
                  f"  node-check={'OK' if ok else 'FAIL'}")
        else:
            print(" ", apply_file(p, args.dry))


if __name__ == "__main__":
    main()
