#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_ignore_group.py -- 开关：不再处理群消息

用户要求（2026-10-10 确认版）："让机器人不再处理群消息"。

行为：群里来的消息**直接早退** —— 不进缓冲、不调 LLM、不写记忆、不回复。
拦截点放在 `handleMessage` 最前面（自己发的过滤之后），
这样连 `extractMessageInfo`（含图片抓取，比较贵）都省掉。

开关：`chat.ignoreGroupMessages`（true = 跳过群消息）
⚠ 副作用：群里发 `/llm` 这类管理员指令也会被跳过（早退在指令处理之前）。
  要切换 LLM 开关就私聊发，或改 config。

用法:
  python patch_ignore_group.py --check
  python patch_ignore_group.py
"""
import argparse
import os
import shutil
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

DIRS = [r"C:\Users\20633\MimirLink-soyo\src", r"C:\Users\20633\MimirLink\src"]

MARK = "// >>> ignore-group patch (managed by patch_ignore_group.py) >>>"
MARK_E = "// <<< ignore-group patch <<<"

ANCHOR = """    const eventSelfId = event.self_id || bot.selfId;
    if (eventSelfId && String(event.user_id) === String(eventSelfId)) {
        return;
    }
"""

NEW = ANCHOR + """
    """ + MARK + """
    // 用户要求：先不要在群里处理任何消息。
    // 放在 extractMessageInfo 之前 —— 连消息解析和图片抓取都不做。
    if (event.message_type === 'group' && config.chat?.ignoreGroupMessages === true) {
        logger.debug?.('[群聊] 已按要求跳过群消息', {
            groupId: event.group_id,
            userId: event.user_id
        });
        return;
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
    if src.count(ANCHOR) != 1:
        return f"!! 锚点命中 {src.count(ANCHOR)} 次（应为 1）"
    out = src.replace(ANCHOR, NEW, 1)
    if dry:
        return f"DRY ok {len(src)} -> {len(out)}"
    bak = path + ".bak-" + time.strftime("%Y%m%d-%H%M%S") + "-ignoregroup"
    shutil.copy2(path, bak)
    open(path, "w", encoding="utf-8").write(out)
    ok, err = node_check(path)
    if not ok:
        shutil.copy2(bak, path)
        return f"!! node --check 失败，已还原\n   {err[:300]}"
    after = open(path, "r", encoding="utf-8").read()
    problems = []
    if "ignoreGroupMessages" not in after:
        problems.append("开关读取缺失")
    # 早退必须发生在 extractMessageInfo 之前
    if after.find("config.chat?.ignoreGroupMessages") > after.find("await extractMessageInfo(config, event, bot)"):
        problems.append("早退在 extractMessageInfo 之后（省不掉解析开销）")
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
        p = os.path.join(d, "index.js")
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
