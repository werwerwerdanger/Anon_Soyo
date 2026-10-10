#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fix_anchor_caveat.py -- 给 styleAnchor 加「别原句照搬」的免责

用户 2026-10-10 加的「真人打字形状」实测时发现：
输入「算了 不想聊了」，素世回的是 ——
    嗯 / 今天这样就够了 / 偶尔什么也不做也不错吧 / 你还说挺想吃的呢 真可惜
**逐字就是 config 里 `chat.styleAnchor` 的内容。**

原因：那句 anchor 是「……嗯。今天这样就足够了。 偶尔什么也不做也不错吧? 你还说挺想吃的呢 真可惜」，
输入语义（收尾/不聊了）和它高度重合 ⇒ 模型直接把范句当答案抄了。
这也把她的中位长度压到 4 字（真人基线 7）。

修法：在「注意:」行里给 anchor 加一句前缀，把它定性成**参照**而不是**模板**。
（本项目铁律仍是「指令 < 示例」，所以不是删范例，而是给范例加边界。）

用法: python fix_anchor_caveat.py --check | (无参) | --revert
"""
import argparse
import io
import os
import pathlib
import shutil
import subprocess
import sys
import time

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

NODE = r"C:\Program Files\nodejs\node.exe"
ROOTS = [pathlib.Path(r"C:\Users\20633") / n for n in ("MimirLink", "MimirLink-soyo")]

OLD = "        (anchorText ? anchorText + '；' : '')"
PREFIX = "（下面是语气参照，别原句照搬）"
NEW = (
    "        // 2026-10-10 实测：范句被**逐字照抄**过（输入「算了 不想聊了」时\n"
    "        // 素世把 styleAnchor 原样背了一遍）。加免责，让它当语气而不是模板。\n"
    "        (anchorText ? '" + PREFIX + "' + anchorText + '；' : '')"
)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()
    stamp = time.strftime("%Y%m%d-%H%M%S")

    for root in ROOTS:
        p = root / "src" / "current-message-focus.js"
        src = p.read_text(encoding="utf-8")
        if args.revert:
            if PREFIX not in src:
                print(f"  {root.name}: 没打过，跳过")
                continue
            out = src.replace(NEW, OLD, 1)
        else:
            if PREFIX in src:
                print(f"  {root.name}: 已打过")
                continue
            n = src.count(OLD)
            if n != 1:
                print(f"  {root.name}: !! 锚点 {n} 次（应为 1）")
                continue
            out = src.replace(OLD, NEW, 1)
        if args.check:
            print(f"  {root.name}: DRY {len(src)} -> {len(out)}")
            continue
        bak = str(p) + ".bak-" + stamp + "-anchorcaveat"
        shutil.copy2(p, bak)
        p.write_text(out, encoding="utf-8", newline="")
        r = subprocess.run([NODE, "--check", str(p)], capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            shutil.copy2(bak, p)
            print(f"  {root.name}: !! 语法失败已还原 {r.stderr[:140]}")
            continue
        back = p.read_text(encoding="utf-8")
        good = (PREFIX in back) if not args.revert else (PREFIX not in back)
        print(f"  {root.name}: {'OK' if good else '!! 断言失败'}  {len(src)}->{len(out)}  "
              f"备份={os.path.basename(bak)}")
    if args.check:
        print("(--check 只报告，未写入)")


if __name__ == "__main__":
    main()
