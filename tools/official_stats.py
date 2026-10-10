#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
official_stats.py -- 角色语气基线（官方语料 vs 机器人实际输出）

设计要点（都是踩过的坑）：
1. **判据不能用"叹词开头率"**。小语料（39 条）时算出官方爱音 13%，
   换成官方剧情全量语料（2186 条）后是 23% —— 于是"线上 36% 太高"的结论
   有 2/3 是错的。真正区分"模板化"的是**首字集中度**：
   官方爱音首字最高频只有 8%，线上「欸」一个就占 26%。
   ⇒ 主判据 = 首字熵 + 首字最高频占比。
2. **省略号开头要单独算**。官方台词里「…」起头（犹豫/沉默）很常见
   （爽世 17%），它不是"首字选择"，混进去会把熵算歪。
3. **括号舞台指示要滤掉**（「（笑）」「（小声）」），否则「（」会跑进首字榜。
4. 全角/半角标点统一后再统计，否则 ！和 ! 分开计数。

用法:
  python official_stats.py --official            # 只看官方基线
  python official_stats.py --bot                 # 官方 vs 两个机器人的真实输出
"""
import argparse
import collections
import io
import math
import os
import re
import sqlite3
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from humanity_lab import split_reply  # noqa: E402

ROOT = os.path.dirname(os.path.abspath(__file__))
ANON_DB = r"C:\Users\20633\MimirLink\data\chats\memory-store.sqlite"
SOYO_DB = r"C:\Users\20633\MimirLink-soyo\data\chats\memory-store.sqlite"

LEAD_ELLIPSIS = re.compile(r"^[….．、,，\s]+")
PAREN_ONLY = re.compile(r"^[（(【\[].*[）)】\]]$")
INLINE_PAREN = re.compile(r"[（(][^）)]{0,12}[）)]")
INTERJ = "欸诶誒咦哎哦嗯哈哇喂噢噫嘿啊呀哟"
INTERJ_RE = re.compile("^[" + INTERJ + "]")
SELF_BRAG = re.compile(r"我可是|我明明|我还|我会|我刚|我现在|我昨天|我今天|我上午|"
                       r"我最近|我练|我买|我改|我想|我认识|我早就|我这种|我那是|我承认|我自己|我哪")
OTHERS = re.compile(r"Soyorin|そよりん|素世|爽世|Rikki|立希|灯|乐奈|乐奈|初华|にゃむ|"
                    r"MyGO|RiNG|ANON TOKYO|祥子|睦")


def norm(s):
    s = s.replace("！", "!").replace("？", "?").replace("～", "~").replace("：", ":")
    return s.strip()


def clean_line(s):
    s = norm(s).strip()
    if not s or PAREN_ONLY.match(s):
        return None
    s = INLINE_PAREN.sub("", s).strip()
    return s or None


def load_official(path, max_len=60):
    out = []
    for ln in open(path, encoding="utf-8"):
        ln = ln.strip()
        if not ln or ln.startswith("#"):
            continue
        c = clean_line(ln)
        if c and len(c) <= max_len:
            out.append(c)
    return out


def load_bot(path, like):
    if not os.path.exists(path):
        return []
    db = sqlite3.connect(path)
    cur = db.cursor()
    cur.execute("SELECT content FROM messages WHERE role='assistant' AND session_id LIKE ?", (like,))
    segs = []
    for (c,) in cur.fetchall():
        for s in split_reply(c):
            s = clean_line(s)
            if s:
                segs.append(s)
    return segs


def stats(rows, label):
    n = len(rows)
    if not n:
        return None
    ell = sum(1 for r in rows if LEAD_ELLIPSIS.match(r))
    heads = [LEAD_ELLIPSIS.sub("", r) for r in rows]
    heads = [h for h in heads if h]
    c = collections.Counter(h[0] for h in heads)
    m = sum(c.values()) or 1
    ent = -sum((v / m) * math.log2(v / m) for v in c.values())
    top1 = c.most_common(1)[0]
    return {
        "label": label, "n": n,
        "中位长度": sorted(len(r) for r in rows)[n // 2],
        "省略号开头": round(100 * ell / n),
        "叹词开头": round(100 * sum(1 for h in heads if INTERJ_RE.match(h)) / len(heads)),
        "首字熵": round(ent, 2),
        "首字最高频%": round(100 * top1[1] / m),
        "首字Top": " ".join(f"{k}{round(100*v/m)}%" for k, v in c.most_common(5)),
        "有!": round(100 * sum(1 for r in rows if "!" in r) / n),
        "有~": round(100 * sum(1 for r in rows if "~" in r) / n),
        "说自己": round(100 * sum(1 for r in rows if SELF_BRAG.search(r)) / n),
        "提他人": round(100 * sum(1 for r in rows if OTHERS.search(r)) / n),
    }


KEYS = ["中位长度", "省略号开头", "叹词开头", "首字熵", "首字最高频%",
        "有!", "有~", "说自己", "提他人"]


def rarefy(rows, n, rounds=400, seed=20261010):
    """把大语料随机稀释到 n 条再统计，得到与 n 条样本**可比**的均值。

    为什么必须这么做：熵依赖样本量。官方 n=2107 时上限 log2(2107)=11，
    而线上 n=61 的上限只有 log2(61)=5.93。直接比熵 = 必输。
    """
    import random
    rnd = random.Random(seed)
    acc = collections.defaultdict(list)
    if len(rows) < n:
        return None
    for _ in range(rounds):
        s = stats(rnd.sample(rows, n), "x")
        for k in KEYS:
            acc[k].append(s[k])
    return {k: round(statistics_mean(v), 2) for k, v in acc.items()} | {"n": n, "label": f"官方@n={n}"}


def statistics_mean(v):
    return sum(v) / len(v)


def show(rows):
    print(f"{'':<16}" + "".join(f"{k:>11}" for k in KEYS) + f"{'n':>7}   首字Top5")
    for r in rows:
        if not r:
            continue
        print(f"{r['label']:<16}"
              + "".join(f"{str(r[k])+'%':>11}" if k not in ("中位长度", "首字熵")
                        else f"{r[k]:>11}" for k in KEYS)
              + f"{r['n']:>7}   {r.get('首字Top','')}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bot", action="store_true", help="同时对比机器人真实输出")
    args = ap.parse_args()

    anon = load_official(os.path.join(ROOT, "_anon_official_lines.txt"))
    soyo = load_official(os.path.join(ROOT, "_soyo_official_lines.txt"))
    print("=" * 130)
    official_rows = [stats(anon, "★官方爱音"), stats(soyo, "★官方爽世")]
    show(official_rows)
    if not args.bot:
        return
    print("-" * 130)
    anon_bot = load_bot(ANON_DB, "private:2063362809")
    soyo_bot = load_bot(SOYO_DB, "private:2063362809")
    anon_bot_s = stats(anon_bot, "爱音(私聊)")
    soyo_bot_s = stats(soyo_bot, "爽世(私聊)")
    show([anon_bot_s, soyo_bot_s])

    print("-" * 130)
    print("★ 关键对照：把官方语料稀释到与线上相同的 n，才是公平比较")
    for name, off, b in (("爱音", anon, anon_bot_s), ("爽世", soyo, soyo_bot_s)):
        if not b:
            continue
        r = rarefy(off, b["n"])
        if r is None:
            continue
        r["首字Top"] = ""
        r["label"] = f"官方{name}@n={b['n']}"
        b = dict(b)
        b["label"] = f"线上{name}@n={b['n']}"
        show([r, b])
        print(f"    → 首字熵 {b['首字熵']} vs 稀释官方 {r['首字熵']}  差 "
              f"{b['首字熵'] - r['首字熵']:+.2f}")
        print(f"    → 首字最高频 {b['首字最高频%']}% vs {r['首字最高频%']}%  差 "
              f"{b['首字最高频%'] - r['首字最高频%']:+}pp  （正=比官方更集中=更模板化）")
        print()

    print("判读（重要）：")
    print("  · 叹词开头率**不是**好判据 —— 官方爱音 26%，线上 38% 其实同量级。")
    print("  · 主判据 = 稀释后的「首字熵」和「首字最高频%」。")
    print("  · 官方爱音最高频的字是「啊/诶」各 9%；线上是「欸」28%。")
    print("    ⇒ 问题不是「用了叹词」，是「只用一个叹词」。")


if __name__ == "__main__":
    main()
