#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
reason_lab.py -- 从 MimirLink 日志里把「模型的思考过程」拉出来看

为什么需要它：`src/ai.js:294` 是 `reasoningContent.slice(0, 200)`，
   日志里只有前 200 字；完整思考过程不落盘。
   直接读日志也能看，但日志夹着大段 JSON，手撸容易错（我自己撸错过两次）。

用法:
  python reason_lab.py --inst soyo                 # 最近 8 轮的思考过程
  python reason_lab.py --inst soyo --n 20          # 最近 20 轮
  python reason_lab.py --inst soyo --trace         # 附带该轮的 messageTrace（看图片有没有进请求）
  python reason_lab.py --inst soyo --date 2026-10-10
"""
import argparse
import io
import json
import os
import re
import sys

# ⚠ 不要在模块顶层替换 sys.stdout —— 否则 `from reason_lab import split_log`
#   会把调用方的 stdout 也换掉，对方再 print 就 "I/O operation on closed file"。
#   （本次踩到）。包装放进 main()。

INSTS = {
    "anon": r"C:\Users\20633\MimirLink\logs",
    "soyo": r"C:\Users\20633\MimirLink-soyo\logs",
}

REASON_HEAD = "[AI执行] reasoning_content 提取成功"
CHAT_HEAD = "[AI执行] 开始执行 chat"


def split_log(lines):
    """把日志切成 [(时间戳, 头部行, 后面的 JSON 或 None)]，用 raw_decode 稳妥解析。"""
    recs = []
    i = 0
    while i < len(lines):
        ln = lines[i]
        m = re.match(r"\[([\d/]+ [\d:]+)\] \[(\w+)\] (.*)$", ln)
        if not m:
            i += 1
            continue
        ts, lvl, msg = m.group(1), m.group(2), m.group(3)
        payload = None
        j = i + 1
        if j < len(lines) and lines[j].lstrip().startswith("{"):
            blob = "\n".join(lines[j:j + 4000])
            try:
                payload, _ = json.JSONDecoder().raw_decode(blob.lstrip())
            except Exception:
                payload = None
        recs.append((ts, msg, payload))
        i += 1
    return recs


def main():
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("--inst", default="soyo", choices=list(INSTS))
    ap.add_argument("--date", default="")
    ap.add_argument("--n", type=int, default=8)
    ap.add_argument("--trace", action="store_true", help="附上 messageTrace 摘要")
    ap.add_argument("--full", action="store_true", help="不截断（日志里本来就只有 200 字）")
    args = ap.parse_args()

    d = INSTS[args.inst]
    if args.date:
        f = os.path.join(d, f"mimirlink-{args.date}.log")
    else:
        cands = sorted((x for x in os.listdir(d) if x.startswith("mimirlink-") and x.endswith(".log")),
                       key=lambda x: os.path.getmtime(os.path.join(d, x)))
        f = os.path.join(d, cands[-1])
    print("日志:", f)
    lines = open(f, encoding="utf-8", errors="replace").read().splitlines()
    recs = split_log(lines)

    reasons = [(ts, p) for ts, msg, p in recs if REASON_HEAD in msg]
    chats = [(ts, p) for ts, msg, p in recs if CHAT_HEAD in msg and p]
    print(f"共 {len(recs)} 条日志；reasoning 记录 {len(reasons)} 条；chat 请求 {len(chats)} 条")
    print()

    for ts, p in reasons[-args.n:]:
        ln = p.get("rawReasoningLength") or p.get("contentLength")
        body = p.get("contentPreview") or ""
        if not args.full:
            body = body.replace("\n", " / ")
        print("=" * 76)
        print(f"[{ts}]  完整长度={ln}  日志只存前 200 字")
        print(body)
    print()

    if args.trace and chats:
        ts, p = chats[-1]
        mt = p.get("messageTrace") or []
        print("=" * 76)
        print(f"最后一轮请求 [{ts}]  model={p.get('model')} 消息数={p.get('messageCount')}")
        print("  最后 6 条：")
        for e in mt[-6:]:
            print(f"    #{e.get('index'):<4} {e.get('role'):<10} len={e.get('contentLength'):<7} "
                  f"src={e.get('source'):<18} {str(e.get('contentPreview'))[:90]}")
        big = [e for e in mt if (e.get("contentLength") or 0) > 3000]
        print(f"  长度 >3000 的消息（内联图片 base64 会在这里现形）：{len(big)} 条")
        for e in big:
            print(f"    #{e.get('index'):<4} {e.get('role'):<10} len={e.get('contentLength')} "
                  f"src={e.get('source')} | {str(e.get('contentPreview'))[:60]}")
        # 按来源统计
        cnt = {}
        for e in mt:
            cnt[e.get("source")] = cnt.get(e.get("source"), 0) + 1
        print("  消息来源分布:", cnt)


if __name__ == "__main__":
    main()
