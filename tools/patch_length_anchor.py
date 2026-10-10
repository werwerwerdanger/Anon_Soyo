#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_length_anchor.py -- 在「生成前最后读到的 system 段」加长度锚点

背景（2026-10-10）：
`<current-message-focus>` 是模型生成回复前最后看到的一段 system 文本，
而它结尾固定是：
    策略: ..., keep_one_to_three_short_sentences
模型把它读成「1~3 条」并**取满 3 条**，实测私聊 28 轮里 22 轮正好 3 段。

更麻烦的是：上下文里爱音**自己过去的回复**（私聊中位 16 字）就是现成的长度范例，
指令打不过 in-context 示例 —— 所以长度必须锚在**离生成最近**的位置。

改法：
  1. 策略 token 去掉误导性的 "one_to_three" 计数；
  2. buildWarnings 末尾加一条带具体数字的中文硬指标（走 `注意:` 行渲染）。

用法:
  python patch_length_anchor.py --check
  python patch_length_anchor.py
"""
import argparse
import os
import shutil
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

DIRS = [r"C:\Users\20633\MimirLink-soyo\src", r"C:\Users\20633\MimirLink\src"]

MARK_S = "// >>> length-anchor patch (managed by patch_length_anchor.py) >>>"
MARK_E = "// <<< length-anchor patch <<<"

STRAT_OLD = "    strategies.push('keep_one_to_three_short_sentences');"
STRAT_NEW = "    strategies.push('keep_lines_short_like_typing_on_a_phone');"

WARN_ANCHOR = """        warnings.push(`当前路由未触发回复: ${routing.skipReason}`);
    }
    return warnings;"""

WARN_NEW = """        warnings.push(`当前路由未触发回复: ${routing.skipReason}`);
    }
    """ + MARK_S + """
    // 这一行是模型产出回复前最后读到的 system 文本，压长度的最高杠杆位置。
    // 数字来自实测（本群真人 296 条）：中位 7 字、≤6 字占 49%、换行 0%。
    warnings.push(
        '每行只要五到十五个字，一条就是一行；大多数情况回一条就够，'
        + '最多三条，不要每次都凑满；不要写成完整句子，不要收尾金句'
    );
    """ + MARK_E + """
    return warnings;"""


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
    if MARK_S in src:
        return f"-- 已打过补丁 ({len(src)} chars)"
    out = src
    notes = []

    if out.count(STRAT_OLD) != 1:
        return f"!! 策略 token 锚点命中 {out.count(STRAT_OLD)} 次（应为 1）"
    out = out.replace(STRAT_OLD, STRAT_NEW, 1)
    notes.append("strat")

    if out.count(WARN_ANCHOR) != 1:
        return f"!! warnings 锚点命中 {out.count(WARN_ANCHOR)} 次（应为 1）"
    out = out.replace(WARN_ANCHOR, WARN_NEW, 1)
    notes.append("warn")

    if dry:
        return f"DRY ok ({','.join(notes)}) {len(src)} -> {len(out)}"
    bak = path + ".bak-" + time.strftime("%Y%m%d-%H%M%S") + "-lenanchor"
    shutil.copy2(path, bak)
    open(path, "w", encoding="utf-8").write(out)

    ok, err = node_check(path)
    if not ok:
        shutil.copy2(bak, path)
        return f"!! node --check 失败，已还原\n   {err[:300]}"

    after = open(path, "r", encoding="utf-8").read()
    problems = []
    if "keep_one_to_three_short_sentences" in after:
        problems.append("旧策略 token 仍在")
    if "每行只要五到十五个字" not in after:
        problems.append("长度锚点缺失")
    # 锚点必须放在 return warnings 之前，否则加进不去
    if after.find("每行只要五到十五个字") > after.find("return warnings;"):
        problems.append("锚点在 return warnings 之后（不生效）")
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
            print(f"  补丁={MARK_S in src}  node --check={'OK' if ok else 'FAIL'}  chars={len(src)}")
        else:
            print(" ", apply_file(p, args.dry))


if __name__ == "__main__":
    main()
