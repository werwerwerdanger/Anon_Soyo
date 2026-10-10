#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_burst_interval.py -- 同一轮回复内的连续分段按「连发」节奏下发

问题：awaitSendSlot 用模块级 lastOutboundAt，每一段都要过 chat.minSendIntervalMs
(5000ms) 闸门。一条回复被拆成 2-3 段时，段与段之间硬等 5 秒 —— 真人是在一两秒内
把两三句发完的，5 秒一段看起来像逐字蹦，是最明显的「机器人」破绽。

改法：给 awaitSendSlot 加 isBurst 开关。
  - 本轮第一段：照旧吃 minSendIntervalMs（跨轮保护，防 QQ 风控 result:120）
  - 本轮后续段：只吃 chat.burstIntervalMs（默认 1200ms）
lastOutboundAt 无论哪条路径都照常更新 ⇒ 下一轮的 5 秒闸门仍然以最后一条消息计时。

用法:
  python patch_burst_interval.py            # 应用到两个实例
  python patch_burst_interval.py --check    # 只检查当前状态
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

TARGETS = [
    r"C:\Users\20633\MimirLink-soyo\src\reply-dispatcher.js",
    r"C:\Users\20633\MimirLink\src\reply-dispatcher.js",
]

MARK_S = "// >>> burst-interval patch (managed by patch_burst_interval.py) >>>"
MARK_E = "// <<< burst-interval patch <<<"

NEW_SIG_OLD = "async function awaitSendSlot(config = {}, sleepFn, logger = console, event = null) {"
NEW_SIG_NEW = "async function awaitSendSlot(config = {}, sleepFn, logger = console, event = null, isBurst = false) {"

ANCHOR_INTERVAL_END = "    // <<< private-interval patch <<<\n"

# 整块替换：把 burst 分支插到 minIntervalMs 计算之前。
# 🔴 顺序是重点 —— minIntervalMs 必须在 rawMs 被改写之后才算，
# 否则 burst 赋值不参与计算（第一版就是这么错的，靠 verify 才抓出来）。
RAWCALC_OLD = """    const isGroup = event?.message_type === 'group';
    const rawMs = isGroup
        ? (config?.chat?.minSendIntervalMs ?? 0)
        : (config?.chat?.minSendIntervalMsPrivate ?? config?.chat?.minSendIntervalMs ?? 0);
    const minIntervalMs = Math.max(0, Number(rawMs) || 0);"""

BURST_INNER = f"""    {MARK_S}
    // 同一轮回复内的连续分段按「连发」处理：真人是在一两秒内把两三句发完的。
    // 段间再压 minSendIntervalMs 会让整轮看起来像逐字蹦；跨轮的长间隔仍然生效，
    // 因为下面 lastOutboundAt 无论走哪条路径都会照常更新。
    if (isBurst === true) {{
        rawMs = config?.chat?.burstIntervalMs ?? 1200;
    }}
    {MARK_E}"""

RAWCALC_NEW = """    const isGroup = event?.message_type === 'group';
    let rawMs = isGroup
        ? (config?.chat?.minSendIntervalMs ?? 0)
        : (config?.chat?.minSendIntervalMsPrivate ?? config?.chat?.minSendIntervalMs ?? 0);
""" + BURST_INNER + """
    const minIntervalMs = Math.max(0, Number(rawMs) || 0);"""

SENDTEXT_SIG_OLD = "    const sendText = async (content) => {"
SENDTEXT_SIG_NEW = "    const sendText = async (content, options = {}) => {"

# sendText 内的 awaitSendSlot 调用点：用后面紧跟的那行做唯一锚定
SLOT_CALL_OLD = """        await awaitSendSlot(config, sleep, logger, event);
        // <<< send-interval patch <<<
        const message = !hasSentPrimary && mentionPrefix ? `${mentionPrefix}${content}` : content;"""
SLOT_CALL_NEW = """        await awaitSendSlot(config, sleep, logger, event, options.burst === true);
        // <<< send-interval patch <<<
        const message = !hasSentPrimary && mentionPrefix ? `${mentionPrefix}${content}` : content;"""

SEG_CALL_OLD = "                await sendText(segmentContent);"
SEG_CALL_NEW = "                await sendText(segmentContent, { burst: !isPrimarySend });"


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
    out = src
    notes = []

    if MARK_S in out:
        return f"-- 已打过补丁，跳过 ({len(src)} bytes)"

    # 1) 函数签名
    n = out.count(NEW_SIG_OLD)
    if n != 1:
        return f"!! 签名锚点命中 {n} 次（应为 1）"
    out = out.replace(NEW_SIG_OLD, NEW_SIG_NEW)
    notes.append("sig")

    # 2) 整块重排：rawMs -> let，burst 分支插到 minIntervalMs 计算之前
    if out.count(RAWCALC_OLD) != 1:
        return f"!! rawMs 计算块锚点命中 {out.count(RAWCALC_OLD)} 次（应为 1）"
    out = out.replace(RAWCALC_OLD, RAWCALC_NEW, 1)
    notes.append("rawMs-let+burst")

    # 3) sendText 签名
    if out.count(SENDTEXT_SIG_OLD) != 1:
        return f"!! sendText 签名命中 {out.count(SENDTEXT_SIG_OLD)} 次（应为 1）"
    out = out.replace(SENDTEXT_SIG_OLD, SENDTEXT_SIG_NEW)
    notes.append("sendText-sig")

    # 4) sendText 内的 awaitSendSlot 调用
    if out.count(SLOT_CALL_OLD) != 1:
        return f"!! slot 调用锚点命中 {out.count(SLOT_CALL_OLD)} 次（应为 1）"
    out = out.replace(SLOT_CALL_OLD, SLOT_CALL_NEW)
    notes.append("slot-call")

    # 5) 分段发送调用点
    if out.count(SEG_CALL_OLD) != 1:
        return f"!! 分段调用锚点命中 {out.count(SEG_CALL_OLD)} 次（应为 1）"
    out = out.replace(SEG_CALL_OLD, SEG_CALL_NEW)
    notes.append("seg-call")

    if dry:
        return f"DRY ok ({','.join(notes)}) {len(src)} -> {len(out)}"

    bak = path + ".bak-" + time.strftime("%Y%m%d-%H%M%S") + "-burst"
    shutil.copy2(path, bak)
    open(path, "w", encoding="utf-8").write(out)

    ok, err = node_check(path)
    if not ok:
        shutil.copy2(bak, path)
        return f"!! node --check 失败，已还原\n   {err[:400]}"
    # node --check 只查语法，抓不到 const 重新赋值 / 语句顺序一类的运行时错误 ⇒ 额外断言
    after = open(path, "r", encoding="utf-8").read()
    i_burst = after.find("rawMs = config?.chat?.burstIntervalMs")
    i_calc = after.find("const minIntervalMs = Math.max(0, Number(rawMs) || 0);")
    if i_burst < 0 or i_calc < 0:
        shutil.copy2(bak, path)
        return "!! burst 分支或 minIntervalMs 缺失，已还原"
    if i_burst > i_calc:
        shutil.copy2(bak, path)
        return "!! burst 分支位于 minIntervalMs 计算之后（不会生效），已还原"
    if "let rawMs = isGroup" not in after:
        shutil.copy2(bak, path)
        return "!! rawMs 仍是 const（会导致 Assignment to constant variable），已还原"
    return f"OK ({','.join(notes)}) {len(src)} -> {len(out)} bytes  备份={os.path.basename(bak)}"


def check_one(path):
    if not os.path.exists(path):
        return "!! 不存在"
    src = open(path, "r", encoding="utf-8").read()
    has = MARK_S in src
    ok, err = node_check(path)
    return (f"补丁={has}  node --check={'OK' if ok else 'FAIL'}  bytes={len(src)}"
            + ("" if ok else f"\n   {err[:300]}"))


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
