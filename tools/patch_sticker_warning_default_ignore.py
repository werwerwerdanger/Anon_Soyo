#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_sticker_warning_default_ignore.py -- 把「注意:」行的表情包口径也改成"默认不管"

`patch_image_as_sticker.py` 把 image 段纳入 emoji_reaction 之后，
`注意:` 行会追加：
    '收到表情包或者图，笑一下、吐槽一句就行，不要报图里画的是什么、...'
但这**还在鼓励对图做反应**（用户要的是"默认当没发过"）。
这一行是模型产出回复前最后读到的文本，口径必须一致。

改成：
    '默认不用管表情包，不要提它、不要描述画面、不要念图上的字，
     就当没发过一样接着聊文字；只有对方明确让你看图时才看图'

用法:
  python patch_sticker_warning_default_ignore.py --check
  python patch_sticker_warning_default_ignore.py
"""
import argparse
import os
import shutil
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

DIRS = [r"C:\Users\20633\MimirLink-soyo\src", r"C:\Users\20633\MimirLink\src"]

MARK = "// >>> sticker-default-ignore patch >>>"
MARK_E = "// <<< sticker-default-ignore patch <<<"

OLD = ("        warnings.push('收到表情包或者图，笑一下、吐槽一句就行，'\n"
       "            + '不要报图里画的是什么、不要描述画面细节、不要念图上的字');")
NEW = ("        " + MARK + "\n"
       "        // 用户 2026-10-10：表情包一般没特别含义，默认根本不用管，只在被明确问时才解析。\n"
       "        warnings.push('默认不用管表情包，不要提它、不要描述画面、不要念图上的字，'\n"
       "            + '就当对方没发过一样接着聊文字；只有对方明确让你看图、或问你图里是什么时才看图');\n"
       "        " + MARK_E)


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
    if src.count(OLD) != 1:
        return f"!! 锚点命中 {src.count(OLD)} 次（应为 1）"
    out = src.replace(OLD, NEW, 1)
    if dry:
        return f"DRY ok {len(src)} -> {len(out)}"
    bak = path + ".bak-" + time.strftime("%Y%m%d-%H%M%S") + "-stickerignore"
    shutil.copy2(path, bak)
    open(path, "w", encoding="utf-8").write(out)
    ok, err = node_check(path)
    if not ok:
        shutil.copy2(bak, path)
        return f"!! node --check 失败，已还原\n   {err[:300]}"
    after = open(path, "r", encoding="utf-8").read()
    problems = []
    if "默认不用管表情包" not in after:
        problems.append("新文案缺失")
    if "笑一下、吐槽一句" in after:
        problems.append("旧文案仍在")
    if problems:
        shutil.copy2(bak, path)
        return "!! 断言失败，已还原: " + "; ".join(problems)
    return f"OK {len(src)} -> {len(out)} chars  备份={os.path.basename(bak)}"


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
            print(f"  补丁={MARK in src} node-check={'OK' if ok else 'FAIL'}")
        else:
            print(" ", apply_file(p, args.dry))


if __name__ == "__main__":
    main()
