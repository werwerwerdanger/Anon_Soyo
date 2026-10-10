#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_style_anchor_config.py -- 语气范句改成**按角色配置**，不要写死在共享代码里

问题（2026-10-10）：
上一轮我把爱音的范句写死进了 current-message-focus.js：

    '语气照这个来——哇!好可爱呀! 完蛋啦~! 欸!忘带钱包了! 大危机!；'

但 `src/` 是两个实例**共用**的（MimirLink = anon，MimirLink-soyo = soyo）。
于是 soyo 实例一直在拿**爱音的口气**去掰素世。

实测两人官方语料几乎是反的：

    | 指标      | 素世      | 爱音      |
    |-----------|-----------|-----------|
    | 中位长度  |    9      |    16     |
    | 语气词结尾|   37%     |    13%    |
    | 波浪号    |    3%     |    18%    |
    | 感叹号    |    0%     |    59%    |
    | 叹词开头  |    0%     |    13%    |

⇒ 「多用感叹号/波浪号」是爱音的，素世恰恰相反。共享范句会把她掰成爱音的腔调
  （这正是笔记里记过的"两个机器人被磨成同一种腔调"）。

改法：范句移到 `chat.styleAnchor`（每个实例各自配）。
  - `buildCurrentMessageFocus(runtimeContext, options)` 增加 options.styleAnchor
  - `buildWarnings` 用传入的范句；没配就不加那一句（退化成中性的长度规则）
  - prompt.js 调用时传 `(this.chatConfig || {}).styleAnchor`

用法:
  python patch_style_anchor_config.py --check
  python patch_style_anchor_config.py
"""
import argparse
import os
import shutil
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

DIRS = [r"C:\Users\20633\MimirLink-soyo\src", r"C:\Users\20633\MimirLink\src"]

MARK = "// >>> style-anchor-config patch (managed by patch_style_anchor_config.py) >>>"
MARK_E = "// <<< style-anchor-config patch <<<"

WARN_OLD = """    warnings.push(
// length-anchor-v2
// length-anchor-v3
        '语气照这个来——哇!好可爱呀! 完蛋啦~! 欸!忘带钱包了! 大危机!；'
// length-anchor-v4
        + '长短拉开，短的四五个字也行，长的二三十个字也行；'
        + '张嘴就直接接对方说的内容，第一句别去评价对方这句话本身；不要收尾金句'
    );"""

WARN_NEW = """    """ + MARK + """
    // 范句按角色配（chat.styleAnchor）—— 爱音多用感叹号波浪号，素世几乎不用，
    // 写死在共享代码里会把两个人磨成同一种腔调。
    const anchorText = typeof styleAnchor === 'string' ? styleAnchor.trim() : '';
    warnings.push(
        (anchorText ? anchorText + '；' : '')
        + '长短拉开，短的四五个字也行，长的二三十个字也行；'
        + '张嘴就直接接对方说的内容，第一句别去评价对方这句话本身；不要收尾金句'
    );
    """ + MARK_E

SIG_OLD = "function buildWarnings({ event, text, intent, routing }) {"
SIG_NEW = "function buildWarnings({ event, text, intent, routing, styleAnchor = '' }) {"

BUILD_OLD = "export function buildCurrentMessageFocus(runtimeContext = {}) {"
BUILD_NEW = """export function buildCurrentMessageFocus(runtimeContext = {}, options = {}) {"""

CALL_OLD = """        warnings: buildWarnings({ event, text, intent, routing })"""
CALL_NEW = """        warnings: buildWarnings({
            event, text, intent, routing,
            // >>> style-anchor-config patch <<<
            styleAnchor: options.styleAnchor || ''
            // <<< style-anchor-config patch <<<
        })"""

PROMPT_OLD = """        const currentMessageFocusText = formatCurrentMessageFocus(buildCurrentMessageFocus({
            ...runtimeContext,
            currentUserMessage: userMessage
        }));"""
PROMPT_NEW = """        const currentMessageFocusText = formatCurrentMessageFocus(buildCurrentMessageFocus({
            ...runtimeContext,
            currentUserMessage: userMessage
        }, {
            // >>> style-anchor-config patch <<<
            // 范句随角色走：anon 和 soyo 的语气是反的，不能共用一句
            styleAnchor: (this.chatConfig || {}).styleAnchor
            // <<< style-anchor-config patch <<<
        }));"""


def node_check(path):
    try:
        r = subprocess.run(["node", "--check", path], capture_output=True, text=True, timeout=60)
        return r.returncode == 0, (r.stderr or "").strip()
    except Exception as e:
        return False, str(e)


def edit(path, pairs, label):
    if not os.path.exists(path):
        return f"{label}: !! 不存在", None
    src = open(path, "r", encoding="utf-8").read()
    if MARK in src:
        return f"{label}: -- 已打过补丁", None
    out = src
    for name, old, new in pairs:
        n = out.count(old)
        if n != 1:
            return f"{label}: !! [{name}] 锚点命中 {n} 次（应为 1）", None
        out = out.replace(old, new, 1)
    return f"{label}: 待写入 {len(src)} -> {len(out)}", (src, out)


def commit(path, payload, extra_checks=()):
    src, out = payload
    bak = path + ".bak-" + time.strftime("%Y%m%d-%H%M%S") + "-styleanchor"
    shutil.copy2(path, bak)
    open(path, "w", encoding="utf-8").write(out)
    ok, err = node_check(path)
    if not ok:
        shutil.copy2(bak, path)
        return f"  !! node --check 失败，已还原\n     {err[:300]}"
    after = open(path, "r", encoding="utf-8").read()
    problems = [msg for msg, cond in extra_checks if not cond(after)]
    if problems:
        shutil.copy2(bak, path)
        return "  !! 断言失败，已还原: " + "; ".join(problems)
    return f"  OK {os.path.basename(path)} 备份={os.path.basename(bak)}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    focus_pairs = [
        ("warn", WARN_OLD, WARN_NEW),
        ("sig", SIG_OLD, SIG_NEW),
        ("build", BUILD_OLD, BUILD_NEW),
        ("call", CALL_OLD, CALL_NEW),
    ]
    prompt_pairs = [("prompt", PROMPT_OLD, PROMPT_NEW)]

    for d in DIRS:
        print("=" * 70)
        print(d)
        if args.check:
            for f in ("current-message-focus.js", "prompt.js"):
                p = os.path.join(d, f)
                s = open(p, encoding="utf-8").read() if os.path.exists(p) else ""
                ok, _ = node_check(p)
                print(f"  {f:<28} 补丁={MARK in s} node-check={'OK' if ok else 'FAIL'}")
            continue
        msg, payload = edit(os.path.join(d, "current-message-focus.js"), focus_pairs, "current-message-focus.js")
        print(" ", msg)
        if payload and not args.dry:
            print(commit(os.path.join(d, "current-message-focus.js"), payload, extra_checks=(
                ("写死的爱音范句仍在", lambda a: '哇!好可爱呀!' not in a.split(MARK)[1].split(MARK_E)[0]
                 if MARK in a and MARK_E in a else True),
                ("styleAnchor 未接上", lambda a: 'styleAnchor: options.styleAnchor' in a),
                ("buildWarnings 签名未改", lambda a: 'styleAnchor = ' in a),
            )))
        elif payload:
            print("     [dry-run]")

        msg, payload = edit(os.path.join(d, "prompt.js"), prompt_pairs, "prompt.js")
        print(" ", msg)
        if payload and not args.dry:
            print(commit(os.path.join(d, "prompt.js"), payload, extra_checks=(
                ("prompt.js 未传 styleAnchor", lambda a: 'styleAnchor: (this.chatConfig || {}).styleAnchor' in a),
            )))
        elif payload:
            print("     [dry-run]")


if __name__ == "__main__":
    main()
