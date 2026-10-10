#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_sticker_strategy_ignore.py -- 把「策略:」行里的表情包指令也改成"默认忽略"

背景（2026-10-10 用户第 17 轮反馈"我们的限制没生效"）：
`patch_sticker_warning_default_ignore.py` 只改了 `warnings`（「注意:」行），
但 `buildStrategies` 里还留着

    strategies.push('react_to_sticker_briefly_do_not_describe_it');

策略名是**原样拼进提示词**的（`current-message-focus.js` 里
`lines.push(`策略: ${focus.strategies.join(', ')}`)`），
模型读到的就是一句英文指令「对表情包做个简短反应，但不要描述它」。

⇒ 同一块 focus 里同时存在：
    策略: ... react_to_sticker_briefly_do_not_describe_it ...
    注意: 默认不用管表情包，就当对方没发过一样
两条**互相打架**。更具体、位置更靠前的那条赢了 ⇒ 她继续对表情包做反应。

改成 ignore_sticker_keep_talking_about_text（正面陈述"该做什么"，不是禁令）。

用法:
  python patch_sticker_strategy_ignore.py --check
  python patch_sticker_strategy_ignore.py --dry
  python patch_sticker_strategy_ignore.py
  python patch_sticker_strategy_ignore.py --revert
"""
import argparse
import os
import shutil
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

DIRS = [r"C:\Users\20633\MimirLink-soyo\src", r"C:\Users\20633\MimirLink\src"]

MARK = "// >>> sticker-strategy-ignore patch >>>"
MARK_E = "// <<< sticker-strategy-ignore patch <<<"

OLD = "        strategies.push('react_to_sticker_briefly_do_not_describe_it');"
NEW = ("        " + MARK + "\n"
       "        // 用户 2026-10-10：默认当没发过一样。策略名是原样喂给模型的，\n"
       "        // 写 'react' 就等于在命令她对表情包做反应（与「注意:」行自相矛盾）。\n"
       "        strategies.push('ignore_sticker_keep_talking_about_text');\n"
       "        " + MARK_E)


def node_check(path):
    try:
        r = subprocess.run(["node", "--check", path], capture_output=True, text=True, timeout=60)
        return r.returncode == 0, (r.stderr or "").strip()
    except Exception as e:
        return False, str(e)


def write_card_style(path, text):
    bak = path + ".bak-" + time.strftime("%Y%m%d-%H%M%S") + "-stickerstrat"
    shutil.copy2(path, bak)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    ok, err = node_check(path)
    if not ok:
        shutil.copy2(bak, path)
        return None, bak, err
    return text, bak, None


def apply_file(path, dry=False):
    if not os.path.exists(path):
        return f"!! 不存在: {path}"
    src = open(path, "r", encoding="utf-8").read()
    if MARK in src:
        return f"-- 已打过补丁 ({len(src)} chars)"
    n = src.count(OLD)
    if n != 1:
        return f"!! 锚点命中 {n} 次（应为 1）"
    out = src.replace(OLD, NEW, 1)
    if dry:
        return f"DRY ok {len(src)} -> {len(out)}"
    written, bak, err = write_card_style(path, out)
    if written is None:
        return f"!! node --check 失败，已还原\n   {err[:300]}"
    after = open(path, "r", encoding="utf-8").read()
    problems = []
    if "ignore_sticker_keep_talking_about_text" not in after:
        problems.append("新策略名缺失")
    # 只在被替换的那一行范围内查旧名：注释里保留旧名字符串是允许的
    if "strategies.push('react_to_sticker_briefly_do_not_describe_it')" in after:
        problems.append("旧 push 仍在")
    if after.count("strategies.push('ignore_sticker_keep_talking_about_text')") != 1:
        problems.append("新 push 数量 != 1")
    if problems:
        shutil.copy2(bak, path)
        return "!! 断言失败，已还原: " + "; ".join(problems)
    return f"OK {len(src)} -> {len(out)} chars  备份={os.path.basename(bak)}"


def revert_file(path):
    if not os.path.exists(path):
        return f"!! 不存在: {path}"
    src = open(path, "r", encoding="utf-8").read()
    if MARK not in src:
        return "-- 没打过补丁，跳过"
    out = src.replace(NEW, OLD, 1)
    if out == src:
        # 标记在但整体文本被手工改过 ⇒ 退化成裸替换
        out = src.replace("strategies.push('ignore_sticker_keep_talking_about_text');", OLD, 1)
    written, bak, err = write_card_style(path, out)
    if written is None:
        return f"!! node --check 失败，已还原\n   {err[:300]}"
    return f"REVERTED {len(src)} -> {len(out)} chars  备份={os.path.basename(bak)}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()
    for d in DIRS:
        p = os.path.join(d, "current-message-focus.js")
        print("=" * 70)
        print(p)
        if args.check:
            src = open(p, encoding="utf-8").read() if os.path.exists(p) else ""
            ok, _ = node_check(p)
            print(f"  补丁={MARK in src} 新策略={src.count('ignore_sticker_keep_talking_about_text')} "
                  f"旧push={src.count(OLD)} node-check={'OK' if ok else 'FAIL'}")
        elif args.revert:
            print(" ", revert_file(p))
        else:
            print(" ", apply_file(p, args.dry))


if __name__ == "__main__":
    main()
