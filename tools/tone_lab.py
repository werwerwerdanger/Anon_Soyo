#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tone_lab.py -- 「语气」的可量化拆解

把"语气"拆成几个能在文本上数出来的指标，对比三方：
  真人语料 / 爱音私聊 / 爱音群聊

指标（都是"像不像真人在手机上随口说"的代理）：
  A 语气词结尾率   —— 啊/呀/诶/唔/哈/嗯/哦/咦/哎/嘛/啦/吧/呢
  B 极短消息率     —— ≤2 字（「嗯」「行」「草」「1」）
  C 情绪外显率     —— 叠字(哈哈/呜呜/啊啊)、重复标点、草/牛/绝/离谱/笑死 这类
  D 反问质疑率     —— 含 吗/吧/呢/么 或 ？
  E 举证句式率     —— 「我可是…」「我明明…」「我又不…」「你才…」
  F 元认知率       —— 评论对话本身：语气/这么说/你这话/什么意思/在说什么
  G 管束句式率     —— 「赶紧…」「别…了」「快去…」「该…了」（催人睡觉/说教）
"""
import collections
import os
import re
import sqlite3
import statistics
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from humanity_lab import split_reply  # noqa: E402
import _extract_humans as corpus_mod  # noqa: E402

TONE_TAIL = "啊呀诶唔哈嗯哦咦哎嘛啦吧呢哟咯嘞嚯噢噫嘿喂"
TONE_TAIL_RE = re.compile(f"[{TONE_TAIL}]$")
SHORT_RE = re.compile(r"^.{0,2}$")
EMO_RE = re.compile(r"(.)\1|哈哈哈|呜呜|啊啊|草|牛逼|牛啊|绝了|离谱|笑死|服了|我超|我去|"
                    r"太.{0,3}了|[?？!！]{2,}")
ASK_RE = re.compile(r"[吗吧呢么]|[?？]")
PROVE_RE = re.compile(r"我可是|我明明|我又不|我哪|你才|你是|你懂|你懂不懂|好吧|"
                      r"我什么时候|我哪里|凭什么|怎么就不能")
META_RE = re.compile(r"你这话|你这句话|什么意思|在说什么|说什么呢|这么说|"
                     r"什么叫|你说啥|你说什么|被你这么一说|这话|语气")
NAG_RE = re.compile(r"赶紧|快去|该睡|该去|别熬|早点睡|睡吧|睡觉去|去睡|别聊|别说了|"
                    r"说真的|行了|行了吧|好了吧")
# 官方爱音的三个最显眼特征，上一轮被「不要打标点」一起 ban 掉了
TILDE_RE = re.compile(r"[~～]")
BANG_RE = re.compile(r"[!！]")
INTERJ_HEAD_RE = re.compile(r"^(哇|欸|誒|诶|咦|哎|哦|啊|唔|嗯|哈|喂)")

OFFICIAL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             "_anon_official_lines.txt")


def load_official(path=OFFICIAL_PATH):
    if not os.path.exists(path):
        return []
    out = []
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        out.append(line)
    return out

DB_PRIV = r"C:\Users\20633\MimirLink\data\chats\memory-store.sqlite"
DB_GROUP = r"C:\Users\20633\MimirLink-soyo\data\chats\memory-store.sqlite"


def load_bot(path, session_like):
    if not os.path.exists(path):
        return []
    db = sqlite3.connect(path)
    cur = db.cursor()
    cur.execute("SELECT content FROM messages WHERE role='assistant' AND session_id LIKE ?",
                (session_like,))
    segs = []
    for (c,) in cur.fetchall():
        segs.extend(split_reply(c))
    return segs


def stats(segs, label):
    if not segs:
        return {}
    n = len(segs)
    out = {
        "label": label, "n": n,
        "中位长度": int(statistics.median([len(s) for s in segs])),
        "A语气词结尾": round(100 * sum(1 for s in segs if TONE_TAIL_RE.search(s)) / n),
        "B极短≤2字": round(100 * sum(1 for s in segs if SHORT_RE.match(s)) / n),
        "C情绪外显": round(100 * sum(1 for s in segs if EMO_RE.search(s)) / n),
        "D反问质疑": round(100 * sum(1 for s in segs if ASK_RE.search(s)) / n),
        "E举证句式": round(100 * sum(1 for s in segs if PROVE_RE.search(s)) / n),
        "F元认知": round(100 * sum(1 for s in segs if META_RE.search(s)) / n),
        "G管束句式": round(100 * sum(1 for s in segs if NAG_RE.search(s)) / n),
        "H波浪号": round(100 * sum(1 for s in segs if TILDE_RE.search(s)) / n),
        "I感叹号": round(100 * sum(1 for s in segs if BANG_RE.search(s)) / n),
        "J叹词开头": round(100 * sum(1 for s in segs if INTERJ_HEAD_RE.match(s)) / n),
    }
    return out


KEYS = ["中位长度", "A语气词结尾", "B极短≤2字", "C情绪外显",
        "D反问质疑", "E举证句式", "F元认知", "G管束句式",
        "H波浪号", "I感叹号", "J叹词开头"]


def show(rows):
    print(f"{'':<14}" + "".join(f"{k:>12}" for k in KEYS) + f"{'n':>7}")
    for r in rows:
        if not r:
            continue
        line = f"{r['label']:<14}"
        for k in KEYS:
            line += f"{str(r[k]) + '%':>12}" if k != "中位长度" else f"{r[k]:>12}"
        line += f"{r['n']:>7}"
        print(line)


def main():
    humans = [t for _q, t in corpus_mod.dedupe(corpus_mod.from_log() + corpus_mod.from_db())]
    official = load_official()
    priv = load_bot(DB_PRIV, "private:2063362809")
    grp = load_bot(DB_GROUP, "group:929159193")
    print("=" * 150)
    show([stats(humans, "本群真人"),
          stats(official, "★官方爱音"),
          stats(priv, "爱音(私聊)"),
          stats(grp, "爱音(群聊)")])
    print()
    print("=== ★官方爱音 H/I/J 命中样例（这三项是上一轮被误 ban 的）===")
    for tag, rex in (("H 波浪号", TILDE_RE), ("I 感叹号", BANG_RE), ("J 叹词开头", INTERJ_HEAD_RE)):
        hits = [s for s in official if rex.search(s) if True]
        print(f"  [{tag}] {len([s for s in official if rex.search(s)])}/{len(official)}")
        for s in [s for s in official if rex.search(s)][:5]:
            print(f"      {s}")
    print()
    print("=== 爱音(私聊) 同样三项 ===")
    for tag, rex in (("H 波浪号", TILDE_RE), ("I 感叹号", BANG_RE), ("J 叹词开头", INTERJ_HEAD_RE)):
        hits = [s for s in priv if rex.search(s)]
        print(f"  [{tag}] {len(hits)}/{len(priv)}"
              + (f"   样例: {hits[0]}" if hits else "   （一条都没有）"))
    print()
    for name, rex in (("E 举证句式", PROVE_RE), ("F 元认知", META_RE), ("G 管束句式", NAG_RE)):
        print(f"=== {name} ===")
        for tag, segs in (("官方爱音", official), ("爱音(私聊+群聊)", priv + grp)):
            hits = [s for s in segs if rex.search(s)]
            print(f"  {tag}: {len(hits)}/{len(segs)}")
            for s in hits[:5]:
                print(f"      {s}")
        print()


if __name__ == "__main__":
    main()
