#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
classify_style_corpus.py -- 用模型给语料打「语用标签」（两轴）

### 为什么推倒重来
第一版 `build_style_corpus.py` 里的规则分类器有两个问题（2026-10-11 审计发现）：

**① 分类轴选错了。**
我只标了「对方在干什么」（situation）。但用户要学的是「**她这一句在干什么**」。
实测漏掉的例子：
    [爱音] （这家伙是昨天那个人……绝对不想见到的家伙出现了……）
    爽世: 说起来，我们还什么都没点呢          ← 明显的「岔开话题」，却被标成「日常」
⇒ 新增第二轴 `reply_act`（她这一句的语用功能），**这才是检索模仿该用的轴**。

**② 规则分类器命中率低、且顺序敏感。**
关键词正则看不出「处境相同」。实测 soyo 的「挑衅」只有 1 条、「被拆穿」3 条，
而 band 剧情（=动画剧情）里她明显不止这么几句。规则分类的天花板就在这。

**③ 顺带清掉脏数据。**
不少 pair 的 stimulus 是 `…………` 这种**纯标点/省略号**（对方在沉默）。
检索查询是真人打的字，永远匹配不到它 ⇒ 标成 `drop`，不参与检索。

### 两轴的定义（会话分析框架，见下方常量区的文献说明）
`fpp`（第一配对部分 FPP —— 对方刚说的那句属于哪一类）：
    提问 / 请求 / 邀请提议 / 指责抱怨 / 评价夸奖 / 告知陈述 / 情绪反应
    （笑、惊呼、感叹）/ 招呼道别 / 道歉 / 关心问候 / 沉默
`reply_act`（第二配对部分 SPP —— **她这一句在干什么**，检索模仿主要看这个）：
    preferred（无标记）：直接回答 / 答应照做 / 附和 / 接受
    dispreferred（有标记）：岔开话题 / 装傻含糊 / 冷淡顶回 / 反问 / 拒绝 / 找理由 / 单字沉默
    旁支：感叹反应（Goffman 1978 应答呼喊）/ 关心提醒 / 情绪外露 / 其他
`preference`（派生轴，不单独让模型判）：preferred / dispreferred / neutral

### 产出
写到独立表 `style_acts`（rowid → situation_llm / reply_act / preference / unmatchable），
**不动** `style_fts`（FTS5 的 UNINDEXED 列不好加），查询时 JOIN 即可。

### 用法
    python classify_style_corpus.py pilot --n 60            # 小样看质量
    python classify_style_corpus.py run                     # 全量（2608 条，约 105 次调用）
    python classify_style_corpus.py stats                   # 对比新旧分布
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.stdout.reconfigure(encoding="utf-8")
import humanity_lab as HL

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, "style_corpus.sqlite")
CN = {"soyo": "爽世", "anon": "爱音"}

# 分类体系依据（会话分析 Conversation Analysis）：
#   Sacks/Schegloff/Jefferson 1974 "A simplest systematics for the organization of
#     turn-taking in conversation" —— 提出「相邻对」(adjacency pair)：
#     第一配对部分 FPP (first pair part) + 第二配对部分 SPP (second pair part)。
#   Levinson 1983《Pragmatics》§6.4 "Preference organization" —— 同一 FPP 可能有多个
#     合格的 SPP，但**地位不平等**：
#       preferred   SPP：无标记 (unmarked)、直接、简短、不迟疑 —— 例：受邀 → 接受
#       dispreferred SPP：**有标记** (marked) —— 例：受邀 → 拒绝，必须伴随
#         ① 迟疑/停顿 ② 前置 token（「呃…」「这个嘛」）③ 解释理由 ④ 转开话题
#         ⑤ 把话题推回去 ⑥ 抱歉/弱化
#   中文教材：胡壮麟《语言学教程》(1988 第12章)、索振羽《语用学教程》(2000 §5)、
#     姜望琪《当代语用学》(2003 §8) 均有转述。
#   
# **本项目为什么用这个轴**：bot 的默认倾向是**永远给 preferred**（有问必答、有求必应），
# 而原作角色的台词里有大量 dispreferred（素世的「岔开话题/装傻含糊/冷淡顶回」）。
# 要模仿得像，检索时必须能**按 preference 取向**取例子，而不是只按词面相似。
#
# `fpp`（对方刚说的那句属于哪类第一配对部分）：
FPP = ["提问", "请求", "邀请提议", "指责抱怨", "评价夸奖", "告知陈述",
       "情绪反应", "招呼道别", "道歉", "关心问候", "沉默"]
# `reply_act`（**她这一句**用了什么第二配对部分形式）—— 检索模仿主要看这个：
ACTS = ["直接回答", "答应照做", "附和", "接受",          # ← preferred（无标记）
        "岔开话题", "装傻含糊", "冷淡顶回", "反问",
        "拒绝", "找理由", "单字沉默",                    # ← dispreferred（有标记）
        "感叹反应", "关心提醒", "情绪外露", "其他"]       # ← 不直接回应 FPP 的旁支
# 「感叹反应」= Goffman 1978《Response Cries》的"应答呼喊"：对眼前情况的**即时爆发**
#   （「诶！？」「太快了吧」「哇——」）。它不是回答对方，也不是回避对方，
#   而是**把当下的身体反应说了出来** —— 所以既不是 preferred 也不是 dispreferred。

PREFERRED = ["直接回答", "答应照做", "附和", "接受"]
DISPREFERRED = ["岔开话题", "装傻含糊", "冷淡顶回", "反问", "拒绝", "找理由", "单字沉默"]


def preference_of(act: str) -> str:
    """由 SPP 形式推出偏好组织归属（Levinson 1983 的 preferred/dispreferred）。"""
    if act in PREFERRED:
        return "preferred"
    if act in DISPREFERRED:
        return "dispreferred"
    return "neutral"

PROMPT = """你在给一份「角色对话语料」做**会话分析标注**。角色是《BanG Dream!》的{name}。

按「相邻对」的框架标注：对方的发言是第一配对部分（FPP），她的回应是第二配对部分（SPP）。

**A. 对方那句是哪一类 FPP**（只能选一个）：
{sits}
（「情绪反应」= 对方只是笑/惊呼/感叹，没有要她回答的实质内容）

**B. 她这一句用了什么 SPP 形式**（只能选一个）：
{acts}

判断 B 时的要点（**重点，别只看字面**）。注意「非偏好回应」的特征是**有标记**的：
迟疑、先附和再否定、给理由、**转移话题**、把问题推回去。

- 「直接回答」= 老老实实答了对方的问题（**偏好**回应）
- 「答应照做」/「附和」/「接受」= 接受对方的请求 / 同意对方的评价 / 接下夸奖（**偏好**）
  ⚠ 「附和」= 只顺着应一声、**不引入新内容**（「是啊」「确实」「原来是这样」）。
  如果她顺着往下**又讲了新人新事**（新的人、地方、时间），那不是附和。
- 「岔开话题」= 不接对方的话，转而说别的事。⚠ 典型：对方问「你为什么要骗我」→ 她答「距离录音棚预约还有一会呢」
- 「装傻含糊」= 装作听不懂、含混过去（「有吗」「你在说什么呀」「这个嘛」）
- 「冷淡顶回」= 短句直接顶回去、不给台阶（「那你来」「那你还听」「位置又不是你给的」）
- 「反问」= 用问题把话推回去（「那你说说看」）
- 「拒绝」= 明确不答应
- 「找理由」= 拒绝/不答的同时给一个解释或借口（「因为……所以……」）
- 「单字沉默」= 嗯 / 好 / 知道了 / …… 这类没信息量的回应
- 「关心提醒」= 反过来关心对方（吃饭了吗、别熬夜、小心点）
- 「感叹反应」= 对眼前情况的**即时惊呼/吐槽/感叹**（「诶！？」「太快了吧」「哇——」
  「什么鬼」「好厉害」）。不是回答，也不是回避，就是当下反应 —— **这类归这里，别塞进「其他」**。
- 「情绪外露」= **主动说出自己真实感受**（委屈 / 不甘 / 害怕 / 寂寞 / 真心喜欢）。
  ⚠ **必须是"说自己"**，且是**有内容的一句**；只有惊呼/吐槽的归上一条「感叹反应」。
  ⚠ 这个桶要**宁少勿多**，别当情绪类台词的口袋。
- 「其他」= 实在归不进上面的（例如她自己**主动起一个新话题**）。

⚠ 如果她这句同时像「直接回答」和某个 dispreferred 形式，**优先选更具体的那个**
（宁可精确到「冷淡顶回」，也别泛泛落进「直接回答」）。
⚠ 只有真的老老实实把对方问的信息**给了出来**，才算「直接回答」。

输出格式（**只输出这些行，不要解释、不要表头**）：
编号|A的标签|B的标签

【语料】
{lines}"""


def call(cfg, prompt: str, max_tokens: int = 3072):
    body = {"model": cfg["model"], "messages": [{"role": "user", "content": prompt}],
            "temperature": 0, "max_tokens": max_tokens, "stream": False,
            "thinking": {"type": "disabled"}}
    req = urllib.request.Request(
        cfg["baseUrl"] + "/chat/completions",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + cfg["apiKey"]}, method="POST")
    with urllib.request.urlopen(req, timeout=180) as r:
        j = json.loads(r.read().decode("utf-8"))
    ch = j["choices"][0]
    txt = ch["message"].get("content") or ""
    if not txt and ch.get("finish_reason") == "length":
        raise RuntimeError("预算被推理吃光（content 为空）")
    return txt


SCHEMA = """
CREATE TABLE IF NOT EXISTS style_acts (
    rowid_ref  INTEGER PRIMARY KEY,
    char       TEXT,
    situation_llm TEXT,          -- 对方那句的 FPP 类型
    reply_act  TEXT,             -- 她这句的 SPP 形式
    preference TEXT,             -- preferred / dispreferred / neutral（由 reply_act 推出）
    unmatchable INTEGER DEFAULT 0,  -- stimulus 没内容（纯标点/省略号）⇒ 不参与检索
    -- ⚠ 不能叫 drop：SQLite 保留字
    model      TEXT
);
"""

EMPTY_STIM = re.compile(r'^[\s…。，、！？!?~～\-—－·．\.\(\)（）「」『』\[\]]*$')


def pick(rows, n: int, seed: int):
    """均匀抽样，避免全落在同一个场景/角色上。"""
    rows = sorted(rows, key=lambda r: (r[0] * 2654435761 + seed) % 100003)
    return rows[:n]


def load_pairs(limit: int = 0, seed: int = 0):
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    rows = db.execute(
        "SELECT rowid, char, stimulus_raw, reply_raw, scene FROM style_fts").fetchall()
    db.close()
    if limit:
        rows = pick(rows, limit, seed)
    return rows


def classify(rows, per_call: int = 25, logger=print, resume: bool = False):
    out = []
    cfg_cache = {}
    if resume:
        have = set()
        try:
            db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
            have = {r[0] for r in db.execute("SELECT rowid_ref FROM style_acts")}
            db.close()
        except sqlite3.OperationalError:
            pass                      # 表还没建（首次全量跑）
        before = len(rows)
        rows = [r for r in rows if r[0] not in have]
        logger(f"   续跑：跳过已标 {before - len(rows)} 条")
    # ⚠ 必须按角色分组后再切块：语料是按源文件顺序排的，同一个文件里两个角色的
    #    台词是交错的。若直接切块，PROMPT 里的「角色是{name}」对一半的行是错的。
    by_char = {}
    for r in rows:
        by_char.setdefault(r[1], []).append(r)
    chunks = []
    for char in sorted(by_char):
        rs = by_char[char]
        chunks += [rs[i:i + per_call] for i in range(0, len(rs), per_call)]
    done = 0
    for chunk in chunks:
        char = chunk[0][1]
        cfg = cfg_cache.setdefault(char, HL.load_ai_config(
            HL.SOYO_DIR if char == "soyo" else HL.ANON_DIR))
        lines = "\n".join(f"{k}|{r[2][:70]}||{r[3][:70]}"
                          for k, r in enumerate(chunk))
        txt = call(cfg, PROMPT.format(name=CN[char],
                                      sits=" / ".join(FPP),
                                      acts=" / ".join(ACTS), lines=lines))
        got = {}
        for m in re.finditer(r"^\s*(\d+)\s*\|\s*(\S+?)\s*\|\s*(\S+)", txt, re.M):
            got[int(m.group(1))] = (m.group(2), m.group(3))
        for k, r in enumerate(chunk):
            sit, act = got.get(k, ("", ""))
            if sit not in FPP:
                sit = "告知陈述" if sit else ""
            if act not in ACTS:
                act = "其他" if act else ""
            out.append({
                "rowid_ref": r[0], "char": r[1], "scene": r[4],
                "situation_llm": sit, "reply_act": act,
                "preference": preference_of(act),
                "unmatchable": 1 if EMPTY_STIM.match((r[2] or "").strip()) else 0,
                "model": cfg["model"],
            })
        done += len(chunk)
        logger(f"   [{CN[char]}] {done}/{len(rows)} 已标")
        save(out)                      # 每块落盘：中途挂了不用从头再来（INSERT OR REPLACE 幂等）
        time.sleep(0.2)
    return out


def save(rows):
    db = sqlite3.connect(DB)
    db.executescript(SCHEMA)
    db.executemany(
        "INSERT OR REPLACE INTO style_acts"
        " (rowid_ref, char, situation_llm, reply_act, preference, unmatchable, model)"
        " VALUES (:rowid_ref,:char,:situation_llm,:reply_act,:preference,"
        ":unmatchable,:model)", rows)
    db.commit()
    db.close()


def cmd_stats(args):
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    for axis in ("preference", "situation_llm", "reply_act"):
        print(f"\n=== 新轴 {axis} （按角色）===")
        cur = db.execute(f"SELECT {axis}, char, COUNT(*) FROM style_acts"
                         f" WHERE unmatchable=0 GROUP BY 1,2 ORDER BY 3 DESC")
        agg = {}
        for v, c, n in cur:
            agg.setdefault(v, {})[c] = n
        print(f"   {'标签':10s}{'爽世':>7}{'爱音':>7}{'合计':>7}")
        for v, d in sorted(agg.items(), key=lambda x: -sum(x[1].values())):
            print(f"   {v:10s}{d.get('soyo',0):>7}{d.get('anon',0):>7}{sum(d.values()):>7}")
    total = db.execute("SELECT COUNT(*), SUM(unmatchable) FROM style_acts").fetchone()
    print(f"\n已标 {total[0]} 条，其中判定为「无内容不准检索」 {total[1] or 0} 条")
    db.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["pilot", "run", "stats"])
    ap.add_argument("--n", type=int, default=60)
    ap.add_argument("--per-call", type=int, default=25)
    ap.add_argument("--resume", action="store_true", help="跳过 style_acts 里已有的行")
    args = ap.parse_args()
    if args.cmd == "stats":
        cmd_stats(args)
        return
    limit = args.n if args.cmd == "pilot" else 0
    rows = load_pairs(limit)
    print(f"待标注 {len(rows)} 条（{'小样' if limit else '全量'}）")
    out = classify(rows, args.per_call, resume=(args.resume and args.cmd == "run"))
    save(out)
    print(f"\n已写入 {len(out)} 条")
    if args.cmd == "pilot":
        print("\n--- 小样明细（看准不准）---")
        for r in out[:30]:
            got = next((x for x in rows if x[0] == r["rowid_ref"]), None)
            if not got:
                continue
            flag = "  ⨯无内容" if r["unmatchable"] else ""
            print(f"   [{r['situation_llm']}|{r['reply_act']}]{flag}")
            print(f"      {got[2][:44]}")
            print(f"   →  {got[3][:46]}")
    cmd_stats(args)


if __name__ == "__main__":
    main()
