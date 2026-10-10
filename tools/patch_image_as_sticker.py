#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_image_as_sticker.py -- 把 `image` 段也算作「表情/图」，补上漏判

问题（2026-10-10 用户："为什么 anon 还是乐衷于解析表情包"）：
上一轮 `patch_sticker_react.py` 把策略 `describe_visible_emoji_or_mood` 换掉了，
但那个策略只在 `intent === 'emoji_reaction'` 时生效，
而 `emoji_reaction` 由 `hasEmojiSegment()` 判定，它只认：
    ['face', 'mface', 'marketface']
**QQ 的「表情包 / 动画表情」在 OneBot 里实际是**：
    {"type": "image", "summary": "[动画表情]"}
也就是 `image` 段 —— 一次都没命中。所以补丁等于没生效。

真正在让她描述的是：图片**直传给了视觉模型**，而提示词里没有任何"别描述"的约束。

改法：把 `image` 也纳入 `hasEmojiSegment`，
这样 `emoji_reaction` 意图 + 新策略 + 中文警告才真正覆盖到表情包和图片。
（警告文案同时扩到"表情包或者图"。）

用法:
  python patch_image_as_sticker.py --check
  python patch_image_as_sticker.py
"""
import argparse
import os
import shutil
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

DIRS = [r"C:\Users\20633\MimirLink-soyo\src", r"C:\Users\20633\MimirLink\src"]

MARK = "// >>> image-as-sticker patch (managed by patch_image_as_sticker.py) >>>"
MARK_E = "// <<< image-as-sticker patch <<<"

DETECT_OLD = """function hasEmojiSegment(event = {}) {
    return getSegmentTypes(event).some((type) => ['face', 'mface', 'marketface'].includes(type));
}"""

DETECT_NEW = """function hasEmojiSegment(event = {}) {
    // >>> image-as-sticker patch (managed by patch_image_as_sticker.py) >>>
    // QQ 的表情包/动画表情在 OneBot 里是 image 段（summary: [动画表情]），
    // 不是 face/mface/marketface。只认后三个会让「收图」这条路径完全不生效：
    // emoji_reaction 意图不触发 ⇒ 对应策略和警告都不会出现（2026-10-10 实测踩到）。
    return getSegmentTypes(event).some((type) =>
        ['face', 'mface', 'marketface', 'image'].includes(type));
    // <<< image-as-sticker patch <<<
}"""

WARN_OLD = "        warnings.push('收到表情包就笑一下或吐槽一句，不要报图里画的是什么、不要念图上的字');"
WARN_NEW = ("        warnings.push('收到表情包或者图，笑一下、吐槽一句就行，'\n"
            "            + '不要报图里画的是什么、不要描述画面细节、不要念图上的字');")


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
    for name, old, new in (("detect", DETECT_OLD, DETECT_NEW), ("warn", WARN_OLD, WARN_NEW)):
        if out.count(old) != 1:
            return f"!! [{name}] 锚点命中 {out.count(old)} 次（应为 1）"
        out = out.replace(old, new, 1)
        notes.append(name)
    if dry:
        return f"DRY ok ({','.join(notes)}) {len(src)} -> {len(out)}"
    bak = path + ".bak-" + time.strftime("%Y%m%d-%H%M%S") + "-imgsticker"
    shutil.copy2(path, bak)
    open(path, "w", encoding="utf-8").write(out)
    ok, err = node_check(path)
    if not ok:
        shutil.copy2(bak, path)
        return f"!! node --check 失败，已还原\n   {err[:300]}"
    after = open(path, "r", encoding="utf-8").read()
    problems = []
    if "'marketface', 'image'" not in after:
        problems.append("image 未被纳入检测")
    if "不要描述画面细节" not in after:
        problems.append("警告文案未更新")
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
            print(f"  补丁={MARK in src}  node-check={'OK' if ok else 'FAIL'}")
        else:
            print(" ", apply_file(p, args.dry))


if __name__ == "__main__":
    main()
