#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
humanity_lab.py -- MimirLink 拟人度测试台

思路：不走手工复刻 prompt，而是调用 MimirLink 自己的
POST /api/runtime/prompt-preview 拿到「真实拼装结果」，
再把这份 messages 原样发给同一家 LLM，量出回复的
长度分布 / 标点率 / 换行率，与群里真人语料基线对比。

用法:
  python humanity_lab.py --instance anon --n 6 --samples 2
  python humanity_lab.py --instance anon --dry          # 只打印 prompt 不调模型
  python humanity_lab.py --baseline-only                # 只看真人基线
"""
import argparse
import json
import os
import re
import sqlite3
import statistics
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lab_client import Client  # noqa: E402
import _extract_humans as corpus_mod  # noqa: E402

ROOT = os.path.dirname(os.path.abspath(__file__))
SOYO_DIR = r"C:\Users\20633\MimirLink-soyo"
ANON_DIR = r"C:\Users\20633\MimirLink"

PUNCT = "。？！…~～!?、，,；;：:"
PUNCT_RE = re.compile("[" + re.escape(PUNCT) + "]")

FENCE_RE = re.compile(r"```[\s\S]*?```")


def split_reply(text, split_on_period=True):
    """忠实复刻 reply-dispatcher.js 的 splitReplyIntoSegments。
    用户实际看到的是拆段后的每条消息，必须按这个口径度量。"""
    source = "" if text is None else str(text)

    def split_plain(part):
        chunks = part.split("。") if split_on_period else [part]
        out = []
        for c in chunks:
            out.extend(re.split(r"\r?\n+", c))
        return out

    segs = []
    cursor = 0
    for m in FENCE_RE.finditer(source):
        segs.extend(split_plain(source[cursor:m.start()]))
        segs.append(m.group(0))
        cursor = m.end()
    segs.extend(split_plain(source[cursor:]))
    return [s.strip() for s in segs if s.strip()]

# 从群里截取的真实测试输入（都是 short、不带标点、像真人的）
DEFAULT_INPUTS = [
    "你认识这个吗",
    "没读上下文",
    "都是机器人",
    "可惜了爱音被禁言了",
    "你是废物吗这个都不知道",
    "在吗",
]


# ---------------------------------------------------------------- 语料基线

BOT_QQ = {"3628056487", "2458713318"}


def extract_human_corpus(log_path, max_items=0):
    """从 MimirLink 日志 + sqlite 抽真人发言（走统一抽取器）。"""
    try:
        items = corpus_mod.dedupe(corpus_mod.from_log() + corpus_mod.from_db())
    except Exception as e:
        print("  语料抽取失败:", e)
        return []
    texts = [t for _qq, t in items]
    return texts[:max_items] if max_items else texts


def measure(texts, label):
    lens = [len(t) for t in texts]
    if not lens:
        return {"label": label, "n": 0}
    pun = sum(1 for t in texts if PUNCT_RE.search(t))
    nl = sum(1 for t in texts if "\n" in t)
    return {
        "label": label,
        "n": len(texts),
        "median": int(statistics.median(lens)),
        "mean": round(statistics.mean(lens), 1),
        "p90": sorted(lens)[max(0, int(len(lens) * 0.9) - 1)],
        "max": max(lens),
        "le3": round(100 * sum(1 for x in lens if x <= 3) / len(lens)),
        "le6": round(100 * sum(1 for x in lens if x <= 6) / len(lens)),
        "le10": round(100 * sum(1 for x in lens if x <= 10) / len(lens)),
        "ge30": round(100 * sum(1 for x in lens if x >= 30) / len(lens)),
        "punct_pct": round(100 * pun / len(texts)),
        "newline_pct": round(100 * nl / len(texts)),
    }


def fmt_row(m):
    if not m.get("n"):
        return f"{m['label']:<14} (no data)"
    return (f"{m['label']:<14} n={m['n']:<3} 中位{m['median']:<3} 均值{m['mean']:<5} "
            f"p90 {m['p90']:<3} 最长{m['max']:<3} "
            f"<=3 {m['le3']:>3}% <=6 {m['le6']:>3}% <=10 {m['le10']:>3}% "
            f">=30 {m['ge30']:>3}% 标点{m['punct_pct']:>3}% 换行{m['newline_pct']:>3}%")


# ---------------------------------------------------------------- 回放用例

HEAD_RE = re.compile(r"\[(?:群聊|私聊)\|QQ:(\d+)\|昵称:([^|\]]*)\|群号:([^|\]]*)\|[^|]*\|")
SEG_RE = re.compile(r"^\[[^\]]*\]\s*")


def _unwrap(content):
    """把 [群聊|QQ:...|...]] 正文 拆成 (qq, 昵称, 正文)"""
    m = HEAD_RE.search(content or "")
    if not m:
        return None, None, None
    rest = content[m.end():]
    if "]]" in rest:
        rest = rest.rsplit("]]", 1)[1]
    t = SEG_RE.sub("", rest.strip()).strip()
    t = re.sub(r"\[CQ:[^\]]*\]", "", t)
    t = re.sub(r"\[图片\]|\[表情\]|\[文件\]|\[语音\]", "", t)
    return m.group(1), m.group(2), t.strip()


def load_replay_cases(db_path, ctx_size=6, want=8, session_like="group:%", first_n=0):
    """从 sqlite 真实聊天记录构造回放用例: (context, input_text)

    ⚠ `first_n > 0` 时只取该会话**最早**的 N 条消息作为回放窗口。
    必须提供这个锚点：默认取"最后 want 条"会让窗口随着新消息不断漂移，
    两次跑的根本不是同一批输入，改动前后没法比较（2026-10-10 踩）。
    """
    if not os.path.exists(db_path):
        return []
    db = sqlite3.connect(db_path)
    cur = db.cursor()
    cur.execute("SELECT role, content, timestamp FROM messages "
                "WHERE session_id LIKE ? ORDER BY timestamp", (session_like,))
    source = cur.fetchall()
    if first_n > 0:
        source = source[:first_n]
    seq = []
    for role, content, ts in source:
        if role == "assistant":
            seq.append(("assistant", content.strip(), None))
        else:
            qq, nick, t = _unwrap(content)
            if qq is None:
                continue
            seq.append(("user", t, qq))
    cases = []
    for i in range(ctx_size, len(seq)):
        role, text, qq = seq[i]
        if role != "user" or qq in BOT_QQ:
            continue
        if not text or len(text) > 40:
            continue
        ctx = []
        for r, t, q in seq[max(0, i - ctx_size):i]:
            if not t:
                continue
            item = {"role": r, "content": t}
            if q:
                item["userId"] = q
            ctx.append(item)
        cases.append((ctx, text))
    # 取最后 want 条（最新语境）并尽量分散
    return cases[-want:] if want else cases


# ---------------------------------------------------------------- LLM 调用

def load_ai_config(inst_dir):
    c = json.load(open(os.path.join(inst_dir, "config.json"), encoding="utf-8"))
    ai = c.get("ai", {})
    return {
        "baseUrl": ai.get("baseUrl", "https://api.deepseek.com").rstrip("/"),
        "apiKey": ai.get("apiKey", ""),
        "model": ai.get("model", "deepseek-chat"),
        "temperature": ai.get("temperature", 0.8),
        "maxTokens": min(int(ai.get("maxTokens", 512)), 512),
    }


def call_llm(cfg, messages, temperature=None):
    body = {
        "model": cfg["model"],
        "messages": messages,
        "temperature": cfg["temperature"] if temperature is None else temperature,
        "max_tokens": cfg["maxTokens"],
        "stream": False,
    }
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        cfg["baseUrl"] + "/chat/completions", data=data,
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + cfg["apiKey"]},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            j = json.loads(r.read().decode("utf-8"))
        return j["choices"][0]["message"].get("content", ""), None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:300]}"
    except Exception as e:
        return None, str(e)


# ---------------------------------------------------------------- 主流程

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--instance", default="anon", choices=["anon", "soyo"])
    ap.add_argument("--n", type=int, default=6, help="测试输入条数")
    ap.add_argument("--samples", type=int, default=2, help="每条输入采样次数")
    ap.add_argument("--temp", type=float, default=None)
    ap.add_argument("--dry", action="store_true", help="只打印 prompt")
    ap.add_argument("--baseline-only", action="store_true")
    ap.add_argument("--no-refresh", action="store_true")
    ap.add_argument("--replay", action="store_true",
                    help="用 sqlite 真实记录做上下文（更贴近实战）")
    ap.add_argument("--session", default="group:%",
                    help="回放哪个会话：'group:%%'（默认）或 'private:2063362809'")
    ap.add_argument("--ctx", type=int, default=6, help="回放上下文条数")
    ap.add_argument("--cases", default="",
                    help="从 JSON 读固化用例 [{ctx:[...],input:...}]，最稳的口径")
    ap.add_argument("--first", type=int, default=0,
                    help="只用会话最早的 N 条做窗口（固定口径，别省；省了两次跑的不是同一批输入）")
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    inst_dir = SOYO_DIR if args.instance == "soyo" else ANON_DIR
    log_path = os.path.join(inst_dir, "logs", "mimirlink-2026-10-09.log")

    print("=" * 78)
    print("真人语料基线")
    print("=" * 78)
    humans = extract_human_corpus(log_path)
    base = measure(humans, "真人")
    print(fmt_row(base))
    if humans:
        print("样例: " + " / ".join(humans[:8]))
    if args.baseline_only:
        return

    print()
    print("=" * 78)
    print(f"被测: {args.instance}  ({args.n} 输入 x {args.samples} 采样)")
    print("=" * 78)

    c = Client(args.instance)
    if not c.login():
        print("!! 登录失败")
        return
    if not args.no_refresh:
        st, r = c.refresh_cards()
        print("卡牌热重载:", st, json.dumps(r, ensure_ascii=False)[:200])

    ai = load_ai_config(inst_dir)
    print(f"LLM: {ai['model']} @ {ai['baseUrl']}  temp={args.temp if args.temp is not None else ai['temperature']}")

    inputs = DEFAULT_INPUTS[:args.n]
    if args.cases:
        raw = json.load(open(args.cases, encoding="utf-8"))
        jobs = [(c.get("ctx") or [], c["input"]) for c in raw]
        print(f"固化用例 {len(jobs)} 条（来自 {args.cases}）")
    # 回放模式：用真实聊天记录做上下文
    elif args.replay:
        cases = load_replay_cases(os.path.join(inst_dir, "data", "chats", "memory-store.sqlite"),
                                  ctx_size=args.ctx, want=args.n, session_like=args.session,
                                  first_n=args.first)
        print(f"回放会话 {args.session!r}: {len(cases)} 条用例"
              f"（每条带 {args.ctx} 条真实上下文，first={args.first or '不限'}）")
        jobs = [(ctx, txt) for ctx, txt in cases]
    else:
        jobs = [(None, t) for t in inputs]

    replies = []
    details = []
    dump_prompt = None

    is_private = str(args.session).startswith("private")
    msg_type = "private" if is_private else "group"

    for i, (ctx, user_msg) in enumerate(jobs):
        st, preview = c.preview(user_msg, recent_messages=ctx, message_type=msg_type)
        if st != 200:
            print(f"  preview 失败 ({user_msg!r}): {st} {preview}")
            continue
        messages = preview.get("messages") or []
        if dump_prompt is None:
            dump_prompt = preview
        if args.dry and i == 0:
            print("--- 首例 messages ---")
            for j, m in enumerate(messages):
                print(f"  [{j}] {m.get('role'):<9} len={len(m.get('content',''))} "
                      f"{m.get('content','')[:70]!r}")
            print("--- 首例 system 段 ---")
            for s in (preview.get("runtimeComposition", {}).get("systemSegments") or []):
                print(f"    {s.get('id'):<26} {len(s.get('content',''))}")
        for s in range(args.samples):
            if args.dry:
                text = "(dry)"
            else:
                text, err = call_llm(ai, messages, args.temp)
                if err:
                    print(f"  !! LLM 错误: {err}")
                    continue
            replies.append(text)
            details.append({"input": user_msg, "sample": s, "reply": text,
                            "ctx_len": len(ctx or [])})
            print(f"  [{i+1}.{s+1}] <<{user_msg}>>")
            print(f"        >> {text!r}")

    if args.dry:
        print("\n(--dry) 以上未真正调用模型。")
        return

    print()
    print("=" * 78)
    bot = measure(replies, f"{args.instance}(原始)")
    print(fmt_row(base))
    print(fmt_row(bot))

    # 关键：按发送层拆段后的真实消息口径
    segs = []
    per_reply = []
    for t in replies:
        s = split_reply(t)
        per_reply.append(len(s))
        segs.extend(s)
    segm = measure(segs, f"{args.instance}(拆段)")
    print(fmt_row(segm))
    if per_reply:
        print(f"每条回复拆成几段: 均值 {round(statistics.mean(per_reply), 2)} "
              f"最大 {max(per_reply)}")
    print()
    if segm.get("n"):
        print(f"中位长度比: {segm['median']}/{base['median']} = "
              f"{segm['median']/max(1,base['median']):.2f}x   "
              f"标点率差: {segm['punct_pct']}% vs {base['punct_pct']}%   "
              f"<=6 字: {segm['le6']}% vs {base['le6']}%")

    out = args.out or os.path.join(ROOT, f"_lab_{args.instance}.json")
    json.dump({"baseline": base, "raw": bot, "segments": segm,
               "details": details, "segment_texts": segs},
              open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("报告:", out)


if __name__ == "__main__":
    main()
