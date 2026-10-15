#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_style_corpus.py -- 把官方剧情语料建成「模仿角色」用的检索库

用户（2026-10-11）：「有没有用一个数据结构存大量语料数据方便ai拿的来模仿角色」

### 为什么不能直接把台词堆进提示词
`mes_example`（示例对话）是**每轮都在**的字段：写进去 100 多轮，只会稀释真实对话、
而且会垄断语气（本项目实测：列举/示例里的第一项会吞掉全部多样性）。
大语料必须走**按需检索**，不能常驻。

### 正确的检索单元不是「单句」，是「情境 → 回应」
单句只能学语气词，学不到**什么时候说什么**。所以要存三元组：

    (伙伴, 别人刚说的那句话 → 她怎么回)

过滤掉「前后都是她自己在说」的，只留有别人说话在前的。实测能挖出：
    爱音 1545 对 / 爽世 1068 对（另有 672 / 544 段三行以上连续对话）

### 为什么用 SQLite + FTS5(trigram)
- SQLite 早就装在跑（`node:sqlite` / 系统 sqlite3），零新依赖
- FTS5 的 `trigram` 分词器**中文可直接用**（实测 `MATCH '表情包'` 命中），BM25 排序天然可用
- 语料只有几千条 ⇒ 不需要独立向量库；以后真要做语义，加一列 BLOB 存 embedding 即可
  （几百~几千条规模内存里暴力余弦足够）

### 手机化（归一化）
官方台词是**剧本**（带「。」「，」「」』），不是手机打字。直接用会把标点带进去。
所以每条都存两份：`*_raw`（原文，用于检索/追溯）+ `*_norm`（手机化，用于注入）。
手机化规则与 `extract_dialogue_flows.py` 的 `to_texting()` 一致。

### 用法
    python build_style_corpus.py build                 # 建库（默认写到同目录 style_corpus.sqlite）
    python build_style_corpus.py build --root <dir>
    python build_style_corpus.py stats                 # 看库里的分布
    python build_style_corpus.py query anon "你怎么又迟到了"   # 试检索
    python build_style_corpus.py query soyo "你和爱音关系好吗" --partner-kind other
"""
from __future__ import annotations

import argparse
import collections
import os
import re
import sqlite3
import sys
import unicodedata

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DB = os.path.join(HERE, "style_corpus.sqlite")
DEFAULT_ROOT = os.path.join(os.path.dirname(HERE), "_corpus_tmp", "bds", "story_cn")

# 语料里的说话人标签 → 我们的两个角色
TARGETS = {"anon": {"爱音"}, "soyo": {"爽世"}}
# 一张卡内部的人（「对熟人」那一档）
MYGO = {"灯", "爱音", "爽世", "立希", "乐奈"}

LINE_RE = re.compile(r"^\s*([^：:]{1,12})[：:]\s*(.+?)\s*$")
SIDE_RE = re.compile(r"^[（(]")
# 剧本里夹带的「行号 + 地点横幅」（例：`148：50473 【咖啡厅】`）不是台词，扔掉
BANNER_RE = re.compile(r"^\d+\s*[【\[（(]")
QUOTE_RE = re.compile(r"[「」『』“”\"]")
# 剧本里表示停顿/拖音的符号，手机打字里不该出现
DROP_CHARS = "（）()♪☆★"

SCHEMA = """
DROP TABLE IF EXISTS style_fts;
CREATE VIRTUAL TABLE style_fts USING fts5(
    stimulus,                 -- 别人说的那句（手机化）—— 主要检索列
    reply,                    -- 她的回应（手机化）
    char        UNINDEXED,
    partner     UNINDEXED,
    partner_kind UNINDEXED,
    reply_raw   UNINDEXED,
    stimulus_raw UNINDEXED,
    opener      UNINDEXED,
    reply_len   UNINDEXED,
    chatlike    UNINDEXED,
    situation   UNINDEXED,
    turns       UNINDEXED,
    scene       UNINDEXED,
    source      UNINDEXED,
    tokenize = 'trigram'
);
"""


# ---------------------------------------------------------------- 归一化
def to_texting(line: str) -> str:
    """剧本台词 → 手机打字的样子。

    「。」→ 换行（一条消息拆成两条，这是真人打字的形状）；
    「，、；」→ 空格；去掉引号/音符/舞台提示；全角转半角。
    """
    s = QUOTE_RE.sub("", line)
    s = re.sub(r"[（(][^）)]*[）)]", " ", s)          # 括号里的旁白/提示
    for ch in DROP_CHARS:
        s = s.replace(ch, "")
    s = s.replace("。", "\n").replace("！", "!").replace("？", "?")
    s = re.sub(r"[，、；;]", " ", s)
    s = re.sub(r"[~〜～]+", "~", s)
    s = unicodedata.normalize("NFKC", s)
    # 剧本里「……」「...」「。。。」混用；统一成两张卡里约定的「……」
    s = re.sub(r"[.．…]{2,}", "\u2026\u2026", s)
    s = re.sub(r"[。]{2,}", "\u2026\u2026", s)
    lines = [re.sub(r"[ \t]+", " ", x).strip() for x in s.split("\n")]
    return "\n".join(x for x in lines if x)


def is_chatlike(raw: str, norm: str) -> int:
    """像不像真人在群里打字：没有句号、长度不太长、没有舞台提示。"""
    if "。" in raw or SIDE_RE.match(raw):
        return 0
    body = norm.replace("\n", "")
    return 1 if 2 <= len(body) <= 30 else 0


# ---------------------------------------------------------------- 语用标签
# 「模仿角色」真正要检索的轴不是话题，是**这一轮在干什么**（被质问/被夸/被拆穿…）。
# 3-gram 词面匹配只能找到"说了相同的词"，找不到"处境相同"—— 实测
# 「你怎么又迟到了」会命中「你怎么在羽丘？」这种毫不相干的句子。
# 这里用零成本的规则分类器先兜一层，把 situation 变成**可筛选项**。
SITUATION_RULES = [
    # ⚠ 顺序 = 优先级：**具体在前，宽泛在后**。
    # 第一版把「质问」写成 `[?？]|为什么|…` 且排在前面 ⇒ 只要带问号就吃掉，
    # 「挑衅」永远轮不到（实测 686 条质问、0 条挑衅）。
    ("收尾", r"晚安|睡了|先这样|再见|我走了|明天见|挂了|不聊了"),
    ("道歉", r"对不起|抱歉|是我不对|我错了|原谅我"),
    ("被拆穿", r"骗人|撒谎|骗我|说谎|才不是吧|真的假的|别装了|被我说中"),
    ("挑衅", r"笨蛋|傻子|讨厌|虚伪|烦人|幼稚|闭嘴|嫌弃|没品|丢人"),
    ("被夸", r"好可爱|好厉害|真棒|好帅|谢谢你|最喜欢|夸|温柔"),
    ("关心", r"没事吧|还好吗|累不累|怎么了|不舒服|还好吧|别勉强"),
    ("求助", r"帮我|怎么办|救命|教我|陪我去|帮我一下|借我"),
    ("撒娇", r"求你了|拜托|就一次|好不好|陪陪我|嘛~"),
    ("敷衍", r"随便|都行|无所谓|你决定|看你"),
    ("质问", r"为什么|凭什么|你是不是|你到底|怎么又|怎么这么|怎么会|难道"),
    ("询问", r"[?？]|吗$|什么|哪里|谁|几点|多久"),
]


def classify_situation(text: str) -> str:
    """粗分类，只用来**筛**，不用来断言。命中多条取第一条（=优先级最高的）。"""
    s = str(text or "")
    for tag, pat in SITUATION_RULES:
        if re.search(pat, s):
            return tag
    return "日常"


def partner_kind(name: str) -> str:
    if not name:
        return "unknown"
    return "mygo" if name in MYGO else "other"


# ---------------------------------------------------------------- 构建
def build(root: str, db_path: str) -> dict:
    if not os.path.isdir(root):
        raise SystemExit(f"!! 找不到语料目录: {root}\n   （可从 GitHub ci-ke/BangDream-story 重新稀疏克隆）")
    os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
    if os.path.exists(db_path):
        os.remove(db_path)
    db = sqlite3.connect(db_path)
    db.executescript(SCHEMA)

    rows = []
    stats = collections.Counter()
    seen = set()
    files = 0
    for r, _d, fs in os.walk(root):
        for fn in fs:
            if not fn.endswith(".txt"):
                continue
            files += 1
            path = os.path.join(r, fn)
            try:
                txt = open(path, encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            rel = os.path.relpath(path, root).replace("\\", "/")
            scene = rel.split("/")[0] if "/" in rel else "root"
            turns = []
            for ln in txt.splitlines():
                m = LINE_RE.match(ln)
                if not m:
                    continue
                who, what = m.group(1).strip(), m.group(2).strip()
                if not what or who.startswith("（登场") or BANNER_RE.match(what):
                    continue
                turns.append((who, what))
            for i, (who, what) in enumerate(turns):
                tag = next((t for t, names in TARGETS.items() if who in names), None)
                if tag is None or SIDE_RE.match(what):
                    continue
                # 只留「别人说话在前」的 —— 那才是能学的「情境 → 回应」
                if i == 0 or turns[i - 1][0] in TARGETS[tag]:
                    continue
                partner, stim_raw = turns[i - 1]
                norm = to_texting(what)
                if not norm:
                    continue
                key = (tag, norm)
                if key in seen:
                    continue
                seen.add(key)
                # 连续对话还能往后延伸几轮（她说完对方又说了 → 说明这轮还没完）
                turns_ahead = 1
                j = i + 1
                while j < len(turns) and turns[j][0] not in TARGETS[tag]:
                    turns_ahead += 1
                    j += 1
                rows.append((
                    to_texting(stim_raw), norm, tag,
                    partner, partner_kind(partner),
                    what, stim_raw,
                    norm[0] if norm else "", len(norm.replace("\n", "")),
                    is_chatlike(what, norm), classify_situation(stim_raw), turns_ahead, scene, rel,
                ))
                stats[tag] += 1

    db.executemany(
        "INSERT INTO style_fts (stimulus, reply, char, partner, partner_kind, reply_raw,"
        " stimulus_raw, opener, reply_len, chatlike, situation, turns, scene, source)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    db.commit()
    db.execute("INSERT INTO style_fts(style_fts) VALUES('optimize')")
    db.commit()
    db.close()
    return {"files": files, "rows": len(rows), "by_char": dict(stats), "db": db_path}


# ---------------------------------------------------------------- 检索
STOP = {"什么", "怎么", "为什么", "这个", "那个", "可以", "但是", "因为", "所以",
        "然后", "还是", "就是", "没有", "不是", "一个", "现在", "时候", "感觉",
        "觉得", "知道", "我们", "你们", "他们", "自己", "已经", "应该", "可能"}


def keywords(text: str, limit: int = 14, n: int = 3) -> list[str]:
    """检索用关键词：剥掉结构化头（复用 MimirLink 那套），中文切 **3-gram**。

    ⚠ 必须是 3-gram，不能是 2-gram。实测（`tokenize='trigram'`）：
        MATCH '迟到'   -> 0 行      ← 2 字词永远匹配不到
        MATCH '又迟到' -> 2 行
    因为 trigram 分词器按 3 字符切片，2 字符的词产生不了任何 token。
    另一条路 `unicode61` 更糟：它把一整串中文当一个 token（'你怎么又迟到了' 是 1 个 token），
    只能整句精确匹配。⇒ 保留 trigram，查询侧改用 3-gram 切片。
    代价：纯 2 字查询（如「迟到」）检索不到，对话话术通常够长，可接受。
    """
    s = str(text or "")
    prev = None
    rounds = 0
    while prev != s and rounds < 20:            # 反复剥最内层，头里嵌了 [..] / {..}
        prev = s
        s = re.sub(r"\[[^\[\]]*\]", " ", s)
        s = re.sub(r"\{[^{}]*\}", " ", s)
        rounds += 1
    s = s.lower()
    out: list[str] = []
    for run in re.findall(r"[\u4e00-\u9fa5]{3,}", s):
        if run not in STOP:
            out += [run[i:i + n] for i in range(len(run) - n + 1)]
    for w in re.findall(r"[a-z][a-z0-9]{2,}", s):
        out.append(w)
    keep: list[str] = []
    for w in out:
        if w in STOP or w in keep:
            continue
        keep.append(w)
        if len(keep) >= limit:
            break
    return keep


def _table_exists(db, name: str) -> bool:
    """语用标签表是后加的（classify_style_corpus.py 产出）—— 没有它也要能跑。"""
    return bool(db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                           (name,)).fetchone())


def query(db_path: str, char: str, text: str = "", partner_kind: str | None = None,
          limit: int = 6, only_chatlike: bool = False,
          situation: str | None = None, seed: int = 0,
          act: str | None = None, situation2: str | None = None,
          preference: str | None = None, partner: str | None = None) -> list[dict]:
    """两段式检索：**词面优先，标签补齐**。

    为什么不能只靠词面：3-gram BM25 只找得到「说了相同的词」。
    实测查询「你怎么又迟到了 每次都这样」会命中「诶？爽世同学？ 你怎么在羽丘？」——
    共享了「你怎么」三个字，处境毫不相干。
    而「模仿角色」真正要的是**处境相同**（对方在质问 / 在夸她 / 拆穿她），
    那是语用维度，不是词面维度。

    所以：先按词面 + 标签查；不够 limit 条时，**直接从标签桶里取样补齐**
    （此时不再要求词面命中 —— 那正是标签存在的意义）。
    seed 用来让同一标签每次取到不同的样例（避免又变成"永远那几条"）。

    `preference` = "preferred" / "dispreferred"（会话分析的偏好组织，Levinson 1983）：
    bot 的默认毛病是**永远给 preferred**（有问必答），要它学会角色的回避/顶撞，
    就得能专门捞 `dispreferred` 那一桶。

    `partner` = 只看「上一句是**这个人**说的」——也就是「她**对谁**说的话」。
    这对模仿很关键，依据是 **recipient design**（Sacks & Schegloff 1979）：
    **同一个人对不同的听话人会换说法**。实测本语料：
      爱音对爽世说时 **20%** 直接叫「Soyorin」，对别人说只有 4%（**5 倍**）；
      爽世对爱音说时 9% 带称呼，对别人 3%（**3 倍**）。
    而对别人说话时出现的「Soyorin」几乎全是**指称**（提到她），不是**称呼**。
    ⇒ 「对彼此说」的语料是**绑对话者**的，混用到别人身上会立刻显怪。
    """
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    picked: list[dict] = []
    seen: set[int] = set()

    import os as _os
    has_acts = _os.path.exists(db_path) and _table_exists(db, "style_acts")

    def run(match_sql: str | None, extra: list, order: str) -> list:
        where = []
        params: list = []
        if match_sql is not None:
            where.append("style_fts MATCH ?")
            params.append(match_sql)
        where.append("f.char = ?")
        params.append(char)
        if partner_kind:
            where.append("partner_kind = ?")
            params.append(partner_kind)
        if partner:
            # 「她对谁说的」——跟谁说，决定她怎么说（recipient design）
            where.append("partner = ?")
            params.append(partner)
        if only_chatlike:
            where.append("f.chatlike = 1")
        if situation:
            where.append("f.situation = ?")
            params.append(situation)
        if act and has_acts:
            where.append("a.reply_act = ?")
            params.append(act)
        if situation2 and has_acts:
            where.append("a.situation_llm = ?")
            params.append(situation2)
        if preference and has_acts:
            where.append("a.preference = ?")
            params.append(preference)
        if has_acts:
            # 253 条 stimulus 是纯省略号，真人打字永远匹配不到 ⇒ 默认不参与检索
            where.append("COALESCE(a.unmatchable, 0) = 0")
        params += extra
        join = " LEFT JOIN style_acts a ON a.rowid_ref = f.rowid" if has_acts else ""
        cols = ("f.rowid, f.stimulus, f.reply, f.partner, f.partner_kind, f.reply_raw,"
                " f.stimulus_raw, f.chatlike, f.situation, f.turns, f.scene,"
                + (" a.reply_act, a.situation_llm, a.preference,"
                   if has_acts else " NULL, NULL, NULL,")
                + " bm25(style_fts, 1.0, 0.4) AS score")
        sql = (f"SELECT {cols} FROM style_fts f{join}"
               f" WHERE {' AND '.join(where)} ORDER BY {order} LIMIT ?")
        params.append(max(limit * 8, 40))
        return db.execute(sql, params).fetchall()

    def take(cand, score_of):
        per_opener = collections.Counter((p["reply"] or " ")[0] for p in picked)
        for row in cand:
            if row[0] in seen:
                continue
            opener = (row[2] or " ")[0]
            if per_opener[opener] >= 2:      # 多样性：同一个开头字最多 2 条
                continue
            seen.add(row[0])
            per_opener[opener] += 1
            picked.append({
                "stimulus": row[1], "reply": row[2], "partner": row[3],
                "partner_kind": row[4], "reply_raw": row[5], "stimulus_raw": row[6],
                "chatlike": row[7], "situation": row[8], "turns": row[9],
                "scene": row[10], "act": row[11], "situation2": row[12],
                "preference": row[13],
                "score": score_of(row[14]),
            })
            if len(picked) >= limit:
                return

    # ① 词面 + 标签
    kws = keywords(text)
    if kws:
        match = " OR ".join('"' + k.replace('"', "") + '"' for k in kws)
        take(run(match, [], "bm25(style_fts, 1.0, 0.4) ASC, f.chatlike DESC"), lambda v: round(v, 3))

    # ② 标签补齐（不要求词面命中）；没给标签时用「像手机打字」兜底取样
    if len(picked) < limit:
        order = f"f.chatlike DESC, (f.rowid * 7919 + {int(seed)}) % 9973"
        take(run(None, [], order), lambda v: round(v, 3))

    db.close()
    return picked[:limit]


# ---------------------------------------------------------------- CLI
def cmd_build(args):
    info = build(args.root, args.db)
    print(f"语料文件 {info['files']} 个 → 写入 {info['rows']} 条情境对")
    for k, v in info["by_char"].items():
        print(f"   {k:6s} {v}")
    print(f"   库: {info['db']}  ({os.path.getsize(info['db'])/1024:.0f} KB)")


def cmd_stats(args):
    db = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    tot = db.execute("SELECT COUNT(*) FROM style_fts").fetchone()[0]
    print(f"总条目 {tot}")
    for char, n, chat, med in db.execute(
            "SELECT char, COUNT(*), SUM(chatlike), "
            "CAST(AVG(reply_len) AS INT) FROM style_fts GROUP BY char"):
        print(f"   {char:6s} {n:5d} 条   像手机打字 {chat:5d} ({100*chat/n:.0f}%)   平均 {med} 字")
    print("\n按场景分布（前 8）：")
    for scene, n in db.execute("SELECT scene, COUNT(*) FROM style_fts GROUP BY scene ORDER BY 2 DESC LIMIT 8"):
        print(f"   {scene:16s} {n}")
    print("\n按语用标签（situation）：")
    for k, n in db.execute("SELECT situation, COUNT(*) FROM style_fts GROUP BY situation ORDER BY 2 DESC"):
        print(f"   {k:8s} {n}")
    print("\n按伙伴类型：")
    for k, n in db.execute("SELECT partner_kind, COUNT(*) FROM style_fts GROUP BY partner_kind"):
        print(f"   {k:10s} {n}")
    db.close()


def cmd_query(args):
    hits = query(args.db, args.char, args.text or "", args.partner_kind, args.limit,
                 args.only_chatlike, args.situation, args.seed,
                 act=args.act, situation2=args.situation2, preference=args.preference,
                 partner=args.partner)
    print(f"查询（{args.char}）: {args.text}")
    if args.partner:
        print(f"限定对「{args.partner}」说的")
    print(f"关键词: {keywords(args.text)}\n")
    for i, h in enumerate(hits, 1):
        tag = "手机感" if h["chatlike"] else "剧本感"
        acts = (f" | 她:{h.get('act') or '-'}"
                f"({h.get('preference') or '-'}) / 对方:{h.get('situation2') or '-'}")
        print(f"[{i}] {h['situation']}{acts} | partner={h['partner']}({h['partner_kind']}) "
              f"{h['scene']} {tag} score={h['score']}")
        print(f"    对方: {h['stimulus_raw'][:60]}")
        print(f"    她回: {h['reply_raw'][:70]}")
        print(f"    手机化: {h['reply'].replace(chr(10), ' / ')}")
        print()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["build", "stats", "query"])
    ap.add_argument("text", nargs="?")
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--root", default=DEFAULT_ROOT)
    ap.add_argument("--char", default="anon", choices=["anon", "soyo"])
    ap.add_argument("--partner-kind", default=None, choices=[None, "mygo", "other"])
    ap.add_argument("--limit", type=int, default=6)
    ap.add_argument("--only-chatlike", action="store_true")
    ap.add_argument("--seed", type=int, default=0,
                    help="标签补齐取样用的随机种子（换个值就换一批样例）")
    ap.add_argument("--act", default=None,
                    help="按「她这一句在干什么」筛：岔开话题/装傻含糊/冷淡顶回/反问/拒绝/"
                         "找理由/单字沉默/直接回答/答应照做/附和/接受/感叹反应/关心提醒/"
                         "情绪外露/其他")
    ap.add_argument("--preference", default=None,
                    choices=[None, "preferred", "dispreferred", "neutral"],
                    help="按会话分析的偏好组织筛：preferred=直接答/答应/附和/接受；"
                         "dispreferred=回避/顶撞/找理由（bot 最缺的就是这一桶）")
    ap.add_argument("--partner", default=None,
                    help="只看「对**这个人**说的」语料（他说了上一句，她回应）"
                         "—— 依据 recipient design：同一人对不同听话人换说法。"
                         "例：--char anon --partner 爽世（= 爱音对爽世说）")
    ap.add_argument("--situation2", default=None,
                    help="按模型标的「对方在干什么」筛：提问/请求/邀请提议/指责抱怨/评价夸奖/"
                         "告知陈述/情绪反应/招呼道别/道歉/关心问候/沉默")
    ap.add_argument("--situation", default=None,
                    help="按规则标的粗筛标签：质问/被夸/被拆穿/挑衅/关心/收尾/求助/撒娇/道歉/敷衍/日常")
    args = ap.parse_args()
    if args.cmd == "build":
        cmd_build(args)
    elif args.cmd == "stats":
        cmd_stats(args)
    else:
        if not args.text and not args.situation and not args.act and not args.situation2:
            raise SystemExit("query 至少给个文本，或者用 --situation 按标签取样")
        cmd_query(args)


if __name__ == "__main__":
    main()
