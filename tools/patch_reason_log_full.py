#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_reason_log_full.py -- 让日志保留完整的 reasoning_content

用户 2026-10-10：「拉一下素世那边的思考过程，你看下他认不认得我刚刚发的东西」

问题：`src/ai.js` 里
    contentPreview: reasoningContent.slice(0, 200),
日志只留思考过程的**前 200 字**。那一轮实际有 987 字，关键结论全在被截掉的部分。
（爱音那边同理。）⇒ 看不清"她到底认没认出来"，只能看到开头。

做法：把 200 放宽到 3000（够覆盖实测最长的一条 2063 字）。
只动这一处；`content.slice(0,200)`（回复本身的预览）保持不变。

⚠ 代价：每轮多写 ~1-3KB 日志。可接受；用 `--revert` 随时收回。

用法: python patch_reason_log_full.py --check | --dry | (无参) | --revert
"""
import argparse
import os
import shutil
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

DIRS = [r"C:\Users\20633\MimirLink\src", r"C:\Users\20633\MimirLink-soyo\src"]

MARK = "// >>> reason-log-full patch >>>"
MARK_E = "// <<< reason-log-full patch <<<"

OLD = "                contentPreview: reasoningContent.slice(0, 200),"
NEW = ("                " + MARK + "\n"
       "                // 原先 200 字不够看（实测一条 987 字，结论都在被截掉的部分）\n"
       "                contentPreview: reasoningContent.slice(0, 3000),\n"
       "                " + MARK_E)


def node_check(p):
    try:
        r = subprocess.run(["node", "--check", p], capture_output=True, text=True, timeout=60)
        return r.returncode == 0, (r.stderr or "").strip()
    except Exception as e:
        return False, str(e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()
    # ⚠ --check 必须在任何写盘之前折进 dry（本项目已栽过两次）
    dry = args.dry or args.check
    stamp = time.strftime("%Y%m%d-%H%M%S")

    for d in DIRS:
        p = os.path.join(d, "ai.js")
        print("=" * 74)
        print(p)
        if not os.path.exists(p):
            print("  !! 不存在")
            continue
        src = open(p, encoding="utf-8").read()
        if args.revert:
            if MARK not in src:
                print("  -- 没打过")
                continue
            out = src.replace(NEW, OLD, 1)
        else:
            if MARK in src:
                print("  -- 已打过")
                continue
            n = src.count(OLD)
            if n != 1:
                print(f"  !! 锚点命中 {n} 次（应为 1）")
                continue
            out = src.replace(OLD, NEW, 1)
        if dry:
            print(f"  DRY {len(src)} -> {len(out)}")
            continue
        bak = p + ".bak-" + stamp + "-reasonlog"
        shutil.copy2(p, bak)
        open(p, "w", encoding="utf-8", newline="").write(out)
        ok, err = node_check(p)
        if not ok:
            shutil.copy2(bak, p)
            print(f"  !! node --check 失败已还原: {err[:200]}")
            continue
        after = open(p, encoding="utf-8").read()
        want = "reasoningContent.slice(0, 3000)" if not args.revert else "reasoningContent.slice(0, 200)"
        print(f"  OK {len(src)}->{len(out)}  断言={'通过' if want in after else '失败'}  "
              f"备份={os.path.basename(bak)}")

    if args.check:
        print("(--check 只报告，未写入)")


if __name__ == "__main__":
    main()
