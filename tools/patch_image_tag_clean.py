#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_image_tag_clean.py -- 把「图片标识的使用说明」从用户消息里拿掉

问题（2026-10-10 从私聊记录里发现）：
buildImageTags() 返回的是「标识 + 一整句使用说明」，而 index.js 把它直接接在
processedInput 后面 ⇒ 这句说明**变成了用户说的话**，被写进 sqlite 历史，
每次发图重复一次。实测私聊记录里出现 6 次：

    [图片私聊…] 事实
    [图片:[动画表情]]

    [图片标识 #13ec6b0a] 同一张图每次都是同一个标识；如果这个标识在本轮之前的
    对话里出现过，说明对方又发了同一张图，可以直接点出来。

后果：
  1. 模型以为**用户**在给它讲图片标识机制（出戏）；
  2. 这段文字入库，之后每一轮都随历史重放，白白占上下文；
  3. 00:31:40 爱音回「你这截的不就是我自己刚说的话嘛」——她把这句注入文当成了
     用户的话。

改法：buildImageTags 只返回标识本身 `[图片标识 #xxxx #yyyy]`；
说明改成卡里 system_prompt 的一条规则（一行，进 system 而不是 user）。

用法:
  python patch_image_tag_clean.py --check
  python patch_image_tag_clean.py
"""
import argparse
import os
import shutil
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

TARGETS = [
    r"C:\Users\20633\MimirLink-soyo\src\image-input.js",
    r"C:\Users\20633\MimirLink\src\image-input.js",
]

MARK_S = "// >>> image-tag-clean patch (managed by patch_image_tag_clean.py) >>>"
MARK_E = "// <<< image-tag-clean patch <<<"

OLD = """    if (!tags.length) return '';
    return '[图片标识 ' + tags.join(' ') + '] 同一张图每次都是同一个标识；'
        + '如果这个标识在本轮之前的对话里出现过，说明对方又发了同一张图，可以直接点出来。';
}"""

NEW = """    if (!tags.length) return '';
    // 只输出标识本身。使用说明放在卡的 system_prompt 里——塞进 user 消息会被
    // 模型当成"用户说的话"，还会写进历史每轮重放（2026-10-10 修复）。
    return '[图片标识 ' + tags.join(' ') + ']';
}"""

# 说明句不能再被别处引用
LEAK_PROBES = ["同一张图每次都是同一个标识"]


def node_check(path):
    try:
        r = subprocess.run(["node", "--check", path], capture_output=True, text=True, timeout=60)
        return r.returncode == 0, (r.stderr or "").strip()
    except Exception as e:
        return False, str(e)


def apply_one(path, dry=False):
    if not os.path.exists(path):
        return f"!! 不存在: {path}"
    src = open(path, "r", encoding="utf-8").read()
    if MARK_S in src:
        return f"-- 已打过补丁，跳过 ({len(src)} chars)"
    n = src.count(OLD)
    if n != 1:
        return f"!! 锚点命中 {n} 次（应为 1）"
    out = src.replace(OLD, MARK_S + "\n" + NEW + "\n" + MARK_E, 1)
    # 断言说明句没有被别的分支再次拼进返回值
    for probe in LEAK_PROBES:
        if probe in out.split(MARK_S)[1].split(MARK_E)[0]:
            return "!! 说明句仍留在补丁块内"
    if dry:
        return f"DRY ok  {len(src)} -> {len(out)} chars"
    bak = path + ".bak-" + time.strftime("%Y%m%d-%H%M%S") + "-imgtag"
    shutil.copy2(path, bak)
    open(path, "w", encoding="utf-8").write(out)
    ok, err = node_check(path)
    if not ok:
        shutil.copy2(bak, path)
        return f"!! node --check 失败，已还原\n   {err[:300]}"
    after = open(path, "r", encoding="utf-8").read()
    blk = after.split(MARK_S)[1].split(MARK_E)[0]
    if "同一张图每次都是同一个标识" in blk:
        shutil.copy2(bak, path)
        return "!! 说明句没被移除，已还原"
    return f"OK  {len(src)} -> {len(out)} chars  备份={os.path.basename(bak)}"


def check_one(path):
    if not os.path.exists(path):
        return "!! 不存在"
    src = open(path, "r", encoding="utf-8").read()
    ok, err = node_check(path)
    leak = "同一张图每次都是同一个标识" in src
    return (f"补丁={MARK_S in src}  node --check={'OK' if ok else 'FAIL'}  "
            f"说明句残留={leak}  chars={len(src)}"
            + ("" if ok else f"\n   {err[:250]}"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()
    for p in TARGETS:
        print("=" * 70)
        print(p)
        print(" ", check_one(p) if args.check else apply_one(p, args.dry))


if __name__ == "__main__":
    main()
