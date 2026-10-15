#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_style_corpus.py -- 给稀缺的「处境桶」补语料，交给人判真伪

用户（2026-10-11）：
  「2000条会不会太少了需不需要你根据这两千条再编造一些出来让我这个爱素老吃家看看
    哪些像是他们说出来的」

### 先回答「够不够」：总量不缺，**结构**缺
实测按 (角色 × 语用标签) 交叉，日常+询问占了 **92%**（2403/2608）。
真正体现性格的那些桶薄得离谱：

    标签        爽世   爱音        标签        爽世   爱音
    日常        665   1044        敷衍           4      7
    询问        317    377        撒娇           7      3
    质问         21     33        挑衅          1      4
    被夸         19     22        被拆穿         3      2
    道歉          8     23        收尾           2      2
    关心          9     21        求助          10      4

「被拆穿」爽世只有 3 条 ⇒ 检索永远取到那 3 条 = **同一句反复出现**
（本项目实测 7 次的「列举/示例 ⇒ 收敛到第一个」）。
⇒ 目标不是把 2000 变 20000，是把稀缺桶从 3 条填到 ~50 条。

### 生成策略：**接地生成**，不是自由发挥
1. 每个桶先取**该桶真实的官方台词**当 few-shot —— 手感只能从真样本里学
2. 显式给出卡里的**形式硬约束**（不用句号 / 最多几行 / 不许描写动作 / 不引入新名词…）
3. 机械**校验**生成结果，违规项在评审表里标出来（不偷偷放过）

### 🔴 合成语料**绝不混进正库**
写进独立的 `style_synth.sqlite`，带 `source='synth'` 与 `verdict`（NULL=待判）。
只有用户判为 keep 的，才由 `promote` 子命令搬进 `style_corpus.sqlite`。
理由：检索器分不出真假，一条「不太像」的合成台词会**污染所有后续输出**。

### 用法
    python gen_style_corpus.py pilot                 # 小样（每桶 6 条 × 3 桶 × 2 角色）
    python gen_style_corpus.py run --per-bucket 50   # 全量补桶
    python gen_style_corpus.py sheet                 # 重出评审表
    python gen_style_corpus.py verdict 爽世-挑衅 1,4,6=keep 2,3=kill
    python gen_style_corpus.py promote               # 把 keep 的并进正库
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.stdout.reconfigure(encoding="utf-8")
import humanity_lab as HL
from build_style_corpus import to_texting

HERE = os.path.dirname(os.path.abspath(__file__))
CANON_DB = os.path.join(HERE, "style_corpus.sqlite")
SYNTH_DB = os.path.join(HERE, "style_synth.sqlite")
SHEET = os.path.join(HERE, "_style_synth_review.md")

CHARS = {"soyo": HL.SOYO_DIR, "anon": HL.ANON_DIR}
CN = {"soyo": "爽世", "anon": "爱音"}

# 每个处境一句话说明 —— 生成时钉死「这一轮在干什么」
SITUATION_DESC = {
    "挑衅": "对方在贬低她/骂她/阴阳怪气。她不会发火也不会装大度，通常是冷淡顶回去、反讽、或者根本不接。",
    "被拆穿": "对方识破了她没说出口的意图或刚撒的谎。她不承认也不否认，会岔开话题、反问、或用一句轻描淡写带过。",
    "收尾": "对方在收尾（要睡了/先这样/我先走了）。她也干脆收掉，不用客套告别语。",
    "撒娇": "对方在软磨硬泡求她。她嘴上嫌弃、半推半就，最后多半还是答应。",
    "敷衍": "对方问她意见而她不想表态。她用「随便/都行/看你」这类话轻轻推回去。",
    "关心": "对方状态不好或受了伤。她不会问「你还好吗」，而是用别的方式表达在意。",
    "求助": "对方来求她帮忙。她先冷淡一句，然后照样帮。",
    "道歉": "对方在道歉。她不接客套的道歉，会提前把话收掉或者嘲讽一句。",
    "被夸": "对方在夸她。她会岔开话题或者淡淡一句，不会接「谢谢」。",
    "质问": "对方在指责或追问她。她先反问把问题推回去，躲不过才说一句实话。",
}

# 形式硬约束（从两张卡里摘的最小集）
FORM = {
    "soyo": """- 手机打字：**不用句号**，要断句就换行（一行 = 一条消息）
- 大部分时候就一句，短句直给；**可以只回一两个字**
- 不写动作、神态、心理，不用星号/括号/引号
- 提到乐队的人一律加「小」：小爱音、小灯、小乐奈、小立希、小睦
- 省略号是她的标志，「……」出现在句首或句子中间（不要每句都带）
- 不直白说情绪词（我在乎你 / 我难过 / 我害怕）
- 最多 4 行""",
    "anon": """- 手机打字：**不打句号**；语气元气、外放
- 常用感叹号和波浪号（这也太可爱了吧! / 借我一下~~），但别每句都堆
- 长短要拉开：短的只有四五个字，长的可以二三十个字
- 不写动作、神态、心理，不用星号/括号/引号
- 连着几条**不要用同一个字起头**
- 得意就自夸，心虚就结巴，慌了就喊完蛋啦 —— 情绪写在字面上
- 最多 3 行""",
}

SYNTH_SCHEMA = """
CREATE TABLE IF NOT EXISTS synth (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    char        TEXT NOT NULL,
    situation   TEXT NOT NULL,
    partner     TEXT,
    partner_kind TEXT,
    stimulus    TEXT NOT NULL,
    reply       TEXT NOT NULL,
    based_on    TEXT,               -- 当 few-shot 用的 canon id
    batch       TEXT,
    model       TEXT,
    chatlike    INTEGER,
    violations  TEXT,              -- 机械校验发现的问题
    verdict     TEXT,              -- NULL=待判 / keep / kill
    stimulus_norm TEXT,            -- 手机化（注入用，与正库同一套 to_texting）
    reply_norm    TEXT
);
CREATE INDEX IF NOT EXISTS idx_synth_v ON synth(char, situation, verdict);
"""


# ---------------------------------------------------------------- 机械校验
BAD_CHARS = ["。", "「", "」", "*", "（", "(", "；", ";"]   # 「，」由 to_texting 归一化，不算违规
NOUN_HINT = re.compile(r"[「『]")      # 引号里的新名词是大忌


def check_form(char: str, stimulus: str, reply: str,
               canon_replies: list[str] | None = None) -> list[str]:
    """把卡里的硬约束变成可自动查的项。查不出的（比如"像不像她"）交给用户。"""
    v: list[str] = []
    if not reply.strip():
        v.append("回应为空")
        return v
    for ch in BAD_CHARS:
        if ch in reply:
            v.append(f"出现禁用符号 {ch!r}")
    for ch in ("。", ",", "*"):
        if ch in stimulus:
            v.append(f"对方那句出现 {ch!r}（对方也应是手机打字）")
    lines = [x for x in reply.split("\n") if x.strip()]
    limit = 4 if char == "soyo" else 3
    if len(lines) > limit:
        v.append(f"{len(lines)} 行 > 上限 {limit}")
    if len(reply.replace("\n", "")) > 40:
        v.append("回应过长")
    if char == "soyo" and re.search(r"我(很|好)?(难过|害怕|在乎|伤心)", reply):
        v.append("出现直白情绪词（她不会说）")
    if canon_replies:
        ov = max_overlap(reply, canon_replies)
        if ov >= 0.55:
            v.append(f"与官方台词高度重合({ov:.2f})，等于照抄")
    return v


# ---------------------------------------------------------------- 生成
def _shingles(text: str, n: int = 3) -> set:
    t = re.sub(r"[\s\u2026。，、！？!?~～]", "", str(text or ""))
    return {t[i:i + n] for i in range(max(0, len(t) - n + 1))} or ({t} if t else set())


def max_overlap(text: str, others: list[str]) -> float:
    """与一组文本的最大 3-gram Jaccard 相似度。"""
    a = _shingles(text)
    if not a:
        return 0.0
    best = 0.0
    for o in others:
        b = _shingles(o)
        if not b:
            continue
        best = max(best, len(a & b) / len(a | b))
    return best


def gen_call(cfg, prompt: str, temperature: float = 0.9, think: bool = False,
             max_tokens: int = 3072):
    """自己发请求，不用 humanity_lab.call_llm —— 因为要能控制 `thinking` 与 `max_tokens`。

    🔴 踩过两次的坑（2026-10-11，先是 reply-decision 的 4-token 判定，再是这里）：
    `deepseek-flash` **默认带思维链**，`max_tokens` 会被 `reasoning_tokens` 吃光。
    实测 `max_tokens=512` 时 `completion_tokens=512 / reasoning_tokens=512 / content_len=0`
    （`finish_reason=length`）—— 返回**空字符串**，看起来像"模型没答"，其实是预算被推理花完。
    ⇒ 要么给足 max_tokens（≥2048），要么 `thinking: {"type":"disabled"}`。
    """
    import urllib.request
    import urllib.error
    body = {"model": cfg["model"], "messages": [{"role": "user", "content": prompt}],
            "temperature": temperature, "max_tokens": max_tokens, "stream": False}
    if not think:
        body["thinking"] = {"type": "disabled"}
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        cfg["baseUrl"] + "/chat/completions", data=data,
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + cfg["apiKey"]}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            j = json.loads(r.read().decode("utf-8"))
        ch = j["choices"][0]
        content = ch["message"].get("content") or ""
        if not content and ch.get("finish_reason") == "length":
            return None, "预算被推理吃光（content 为空）—— 加大 max_tokens 或关 thinking"
        return content, None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:200]}"
    except Exception as e:
        return None, str(e)


def canon_examples(db, char: str, situation: str, n: int, general: int = 4) -> tuple[list, list]:
    """同类处境的样例（越薄越不够用）+ 其它处境的样例（补手感）。

    薄桶（挑衅 1 条 / 收尾 2 条）光靠本桶 few-shot 学不出东西，
    所以再抓几条**别处**的真实台词，让模型至少看到这个人的整体口气。
    """
    same = db.execute(
        "SELECT rowid, stimulus_raw, reply_raw FROM style_fts "
        "WHERE char=? AND situation=? AND chatlike=1 ORDER BY rowid LIMIT ?",
        (char, situation, n)).fetchall()
    other = db.execute(
        "SELECT rowid, stimulus_raw, reply_raw FROM style_fts "
        "WHERE char=? AND situation<>? AND chatlike=1 AND LENGTH(reply_raw) BETWEEN 4 AND 24"
        " ORDER BY (rowid*7919) % 9973 LIMIT ?", (char, situation, general)).fetchall()
    return same, other


def build_prompt(char: str, situation: str, same: list[tuple], other: list[tuple],
                 n: int) -> str:
    ex_same = "\n".join(f"对方：{s}\n她：{r}" for _i, s, r in same) or "（这一类官方台词很少，靠下面的通例）"
    ex_other = "\n".join(f"对方：{s}\n她：{r}" for _i, s, r in other)
    return f"""你在给一个 QQ 角色 bot 扩写「对话素材库」。角色：{'长崎爽世' if char == 'soyo' else '千早爱音'}（BanG Dream! MyGO!!!!!）。

【这一轮要写的处境】
{situation}：{SITUATION_DESC[situation]}

【她的说话方式（硬约束，逐条遵守）】
{FORM[char]}

【官方真实台词 · 同类处境（只学手感，**一句都不要照抄**）】
{ex_same}

【官方真实台词 · 其它处境（看整体口气用）】
{ex_other}

【任务】
再写 {n} 段「处境相同、话完全不一样」的两行对话。

要求：
- 每段处境都必须是「{situation}」，不要跑题
- 对方那句要像真人随口打的：短、口语、不带旁白
- 她的回应保持上面的手感，**长度要在样例那一档，不准比样例更短促**
- 🔴 **{n} 段之间长度必须拉开**：至少 1 段是两行（或 15 字以上），至少 1 段是四五个字。
  **不准写成一串一模一样的单字敷衍** —— 那样不像她。
- 🔴 {n} 段的**开头字互不相同**
- 🔴 **不引入新的具体名词**：新的人名、食物、地点、活动、剧情都不要。要提就用样例里出现过的
- 每段的回应文字不允许重复
- 🔴 **不许和上面样例的句子重合、也不许只改一两个字** —— 那是照抄，不是扩写

输出格式（严格照做，不要编号、不要解释、不要代码块）：
对方：<一句话>
她：<一句话>
---
对方：<一句话>
她：<一句话>
---
（共 {n} 段）"""


BLOCK_RE = re.compile(r"^\s*(?:对方|你|user|User)\s*[：:]\s*(.+?)\s*\n\s*(?:她|我|char|Char)\s*[：:]\s*([\s\S]*?)(?=\n\s*(?:---|对方\s*[：:]|$))",
                      re.M)


def parse_blocks(raw: str) -> list[tuple[str, str]]:
    out = []
    for m in BLOCK_RE.finditer(raw or ""):
        st, rp = m.group(1).strip(), m.group(2).strip()
        rp = re.sub(r"\n\s*---.*$", "", rp).strip()
        if st and rp:
            out.append((st, rp))
    return out


def generate(char: str, situation: str, per_bucket: int, per_call: int,
             db, logger=print) -> list[dict]:
    cfg = HL.load_ai_config(CHARS[char])
    same, other = canon_examples(db, char, situation, 6, 4)
    # 这一桶里最常见的对话对象（存进 partner 列，便于以后按对象筛）
    pr = db.execute("SELECT partner, COUNT(*) n FROM style_fts WHERE char=? AND situation=?"
                    " AND partner<>'' GROUP BY partner ORDER BY n DESC LIMIT 1",
                    (char, situation)).fetchone()
    partner = pr[0] if pr else ""
    rows: list[dict] = []
    seen_replies: set[str] = set()
    rounds = max(1, (per_bucket + per_call - 1) // per_call)
    for r in range(rounds):
        want = min(per_call, per_bucket - len(rows))
        if want <= 0:
            break
        prompt = build_prompt(char, situation, same, other, want)
        out, err = gen_call(cfg, prompt, temperature=0.9)
        if err or not out:
            logger(f"   !! {CN[char]}-{situation} 第{r+1}轮失败: {err}")
            continue
        got = 0
        for st, rp in parse_blocks(out):
            key = rp.replace("\n", "")
            if key in seen_replies:
                continue
            seen_replies.add(key)
            rows.append({
                "char": char, "situation": situation,
                "partner": partner,
                "partner_kind": ("mygo" if partner in ("爱音", "灯", "立希", "乐奈", "爽世") else "other"),
                "stimulus": st, "reply": rp,
                "stimulus_norm": to_texting(st), "reply_norm": to_texting(rp),
                "based_on": ",".join(str(e[0]) for e in (same + other)),
                "batch": time.strftime("%Y%m%d-%H%M%S"), "model": cfg["model"],
                "chatlike": 1,
                # ⚠ 校验跑在**归一化后**的文本上：逗号/句号是剧本标点，
                #   生成后过一遍 to_texting（与正库同一套），剩下的才是真违规。
                "violations": ";".join(check_form(
                    char, to_texting(st), to_texting(rp),
                    [to_texting(x[2]) for x in (same + other)])),
            })
            got += 1
        # 拒收「塌缩」批次：既查全是一两个字，也查长度全挤在同一档
        if len(rows) >= 4:
            lens = [len(x["reply"].replace("\n", "")) for x in rows]
            buckets = len({min(3, L // 5) for L in lens})
            if max(lens) <= 3 or (buckets <= 1 and max(lens) <= 8):
                logger(f"   × 第{r+1}轮长度全挤在 {min(lens)}~{max(lens)} 字，丢弃重试")
                rows = []
                seen_replies.clear()
                continue
        logger(f"   {CN[char]}-{situation} 第{r+1}轮 → 解析出 {got} 段（累计 {len(rows)}）")
        time.sleep(0.2)
    return rows[:per_bucket]


def save(rows: list[dict]) -> int:
    if not rows:
        return 0
    db = sqlite3.connect(SYNTH_DB)
    db.executescript(SYNTH_SCHEMA)
    db.executemany(
        "INSERT INTO synth (char, situation, partner, partner_kind, stimulus, reply,"
        " based_on, batch, model, chatlike, violations, verdict, stimulus_norm, reply_norm)"
        " VALUES (:char,:situation,:partner,:partner_kind,:stimulus,:reply,"
        " :based_on,:batch,:model,:chatlike,:violations,NULL,:stimulus_norm,:reply_norm)", rows)
    db.commit()
    db.close()
    return len(rows)


# ---------------------------------------------------------------- 评审表
def write_sheet(only_pending: bool = True) -> str:
    if not os.path.exists(SYNTH_DB):            # 一条都没生成时也要能出空表
        sqlite3.connect(SYNTH_DB).executescript(SYNTH_SCHEMA)
    sdb = sqlite3.connect(f"file:{SYNTH_DB}?mode=ro", uri=True)
    cdb = sqlite3.connect(f"file:{CANON_DB}?mode=ro", uri=True)
    where = "WHERE verdict IS NULL" if only_pending else ""
    rows = sdb.execute(
        f"SELECT id, char, situation, stimulus, reply, violations, verdict,"
        f" stimulus_norm, reply_norm FROM synth {where}"
        " ORDER BY char, situation, id").fetchall()
    lines = ["# 合成语料评审表", "",
             "每条都标了机械校验发现的问题（格式违规）。**你自己判**：像不像这两个人说的话。",
             "", "判完告诉我，比如：`爽世-挑衅 3,5,7 留；1,2,4,6 扔`", ""]
    cur = None
    for _id, char, sit, st, rp, vio, verdict, stn, rpn in rows:
        if (char, sit) != cur:
            cur = (char, sit)
            canon = cdb.execute(
                "SELECT stimulus_raw, reply_raw FROM style_fts WHERE char=? AND situation=?"
                " AND chatlike=1 LIMIT 3", (char, sit)).fetchall()
            lines += [f"\n---\n\n## {CN[char]} · {sit}", ""]
            lines.append("**官方真实台词（基准）**")
            for a, b in canon:
                lines.append(f"- 对方：{a}")
                lines.append(f"  她：{b.replace(chr(10), ' / ')}")
            lines.append("")
        tag = f"  ⚠️ {vio}" if vio else ""
        lines.append(f"**[{_id}]**{tag}")
        lines.append(f"- 对方：{st}")
        lines.append(f"- 她：{rp.replace(chr(10), ' / ')}")
        lines.append(f"- 注入用（手机化）：`{rpn.replace(chr(10), ' / ')}`")
        lines.append("")
    sdb.close()
    cdb.close()
    open(SHEET, "w", encoding="utf-8", newline="\n").write("\n".join(lines))
    return SHEET


def cmd_verdict(args):
    char, sit = args.key.split("-")
    char = "soyo" if char.startswith("爽") else "anon"
    db = sqlite3.connect(SYNTH_DB)
    n = 0
    for part in args.rules.split(";"):
        if "=" not in part:
            continue
        ids, verdict = part.split("=", 1)
        verdict = verdict.strip()
        for i in re.split(r"[,\s]+", ids.strip()):
            if not i.isdigit():
                continue
            n += db.execute("UPDATE synth SET verdict=? WHERE id=? AND char=? AND situation=?",
                            (verdict, int(i), char, sit)).rowcount
    db.commit()
    db.close()
    print(f"已记录 {n} 条判定")


def cmd_promote(args):
    sdb = sqlite3.connect(f"file:{SYNTH_DB}?mode=ro", uri=True)
    keep = sdb.execute(
        "SELECT char, situation, partner, partner_kind, stimulus, reply, violations, id,"
        " stimulus_norm, reply_norm FROM synth WHERE verdict='keep'").fetchall()
    sdb.close()
    if not keep:
        print("没有 verdict='keep' 的条目")
        return
    cdb = sqlite3.connect(CANON_DB)
    rows = []
    for char, sit, partner, pk, st, rp, vio, _id, stn, rpn in keep:
        if vio:
            print(f"  跳过 [{_id}]（有格式违规）: {vio}")
            continue
        rpn = rpn or rp
        rows.append((stn or st, rpn, char, partner or "", pk or "mygo", rp, st,
                     rpn[0] if rpn else "", len(rpn.replace("\n", "")),
                     1, sit, 1, f"synth#{_id}"))
    cdb.executemany(
        "INSERT INTO style_fts (stimulus, reply, char, partner, partner_kind, reply_raw,"
        " stimulus_raw, opener, reply_len, chatlike, situation, turns, scene)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    cdb.commit()
    cdb.execute("INSERT INTO style_fts(style_fts) VALUES('optimize')")
    cdb.commit()
    cdb.close()
    print(f"已并入 {len(rows)} 条合成语料（scene 标为 synth#<id> 可追溯）")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["pilot", "run", "sheet", "verdict", "promote"])
    ap.add_argument("--per-bucket", type=int, default=6)
    ap.add_argument("--per-call", type=int, default=6)
    ap.add_argument("--buckets", default=None,
                    help="逗号分隔；默认 pilot=挑衅,被拆穿,收尾，run=所有 count<20 的桶")
    ap.add_argument("--key", default=None, help="verdict 用，如 爽世-挑衅")
    ap.add_argument("--rules", default="", help="verdict 用，如 1,4,6=keep;2=kill")
    args = ap.parse_args()

    if args.cmd == "sheet":
        print("评审表:", write_sheet())
        return
    if args.cmd == "verdict":
        cmd_verdict(args)
        return
    if args.cmd == "promote":
        cmd_promote(args)
        return

    if args.buckets:
        buckets = [x.strip() for x in args.buckets.split(",") if x.strip()]
    elif args.cmd == "pilot":
        buckets = ["挑衅", "被拆穿", "收尾"]
    else:
        buckets = None

    cdb = sqlite3.connect(f"file:{CANON_DB}?mode=ro", uri=True)
    total = 0
    for char in CHARS:
        for sit in buckets or list(SITUATION_DESC):
            have = cdb.execute("SELECT COUNT(*) FROM style_fts WHERE char=? AND situation=?",
                               (char, sit)).fetchone()[0]
            if buckets is None and have >= 20:      # run 模式只补薄桶
                print(f"  跳过 {CN[char]}-{sit}（已有 {have} 条）")
                continue
            print(f"▶ {CN[char]}-{sit}（现有 {have} 条）→ 生成 {args.per_bucket} 条")
            total += save(generate(char, sit, args.per_bucket, args.per_call, cdb))
    cdb.close()
    print(f"\n新增 {total} 条到 style_synth.sqlite")
    print("评审表:", write_sheet())


if __name__ == "__main__":
    main()
