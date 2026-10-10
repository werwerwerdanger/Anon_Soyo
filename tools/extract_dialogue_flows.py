#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
extract_dialogue_flows.py -- 从官方剧情语料里挖「两人多轮对话」，生成 mes_example

为什么要这个：
  现在的 `mes_example` 83 条**全是「对方一句 → 她一句」的一问一答**，
  实测的后果是——她每条回复都是**孤立的反应**，不会「被追问后改口」「先说别的再绕回来」
  「把话头递回去」。这是"拟人"目前最大的结构性缺口。
  官方剧情里有大量**多轮**（对方追问、她躲、再被逼、最后吐半句），
  这些结构才是要学的。

筛选口径（都在代码里可调）：
  · 只取**恰好两个说话人**的连续段落（三人以上无法映射成 1v1）
  · 其中一方必须是目标角色
  · 轮数 3~6（太短学不到结构，太长像剧本）
  · 每句长度 <= max_len（默认 26）—— 手机打字的语域，滤掉大段独白
  · 剔除舞台指示/括号行

⚠ 语域提醒：官方剧情是**游戏对白**（完整句子、有标点），线上目标是**手机打字**。
  所以这里只借**互动结构**（谁先躲、谁追问、怎么收），
  句子的长短标点由各卡自己的 `## 手机打字习惯` 管。

用法:
  python extract_dialogue_flows.py --root <story_cn> --who soyo --n 8
"""
import argparse
import collections
import io
import os
import random
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ALIAS = {
    "爱音": "anon", "千早爱音": "anon",
    "爽世": "soyo", "素世": "soyo", "长崎爽世": "soyo", "长崎素世": "soyo", "そよ": "soyo",
}
SPEAKER_RE = re.compile(r"^([^：:]{1,12})[：:]\s*(.+)$")
NARRATION_HINT = re.compile(r"^[（(【\[]")
# 台词里夹的括号内容（内心独白 / 舞台指示）——卡里明令「不要用括号写动作神态」，
# 抽进来会反向教坏。整句含括号的直接剔。
PAREN_INNER = re.compile(r"[（(][^）)]{1,40}[）)]")
# 剧情化/沉重的线，跟日常闲聊不是一回事，剔掉
HEAVY = re.compile(r"解散|退团|CRYCHIC|春日影|一辈子|誓言|背叛|哭|对不起|为什么是我|"
                   r"结束|消失|离开|讨厌你|拆伙|崩溃")


def clean(s):
    return re.sub(r"\s+", " ", s.strip())


def parse_file(path):
    """产出 [(speaker_key_or_raw, text)]，跳过标题/角色表/空行。"""
    out = []
    for raw in open(path, encoding="utf-8", errors="replace"):
        ln = raw.strip()
        if not ln or NARRATION_HINT.match(ln):
            continue
        m = SPEAKER_RE.match(ln)
        if not m:
            continue
        sp, tx = m.group(1).strip(), clean(m.group(2))
        if tx:
            out.append((ALIAS.get(sp, sp), tx))
    return out


def iter_runs(turns):
    """把连续同两个人的段落切出来：产量 [(who_a, who_b, [(who, text), ...])]"""
    i = 0
    while i < len(turns):
        j = i
        speakers = set()
        run = []
        while j < len(turns):
            sp = turns[j][0]
            if len(speakers | {sp}) > 2:
                break
            speakers.add(sp)
            run.append(turns[j])
            j += 1
        if len(speakers) == 2 and len(run) >= 3:
            yield run
        i = max(j, i + 1)


def to_texting(s):
    """把游戏对白的标点归一到**手机打字**语域。

    🔴 为什么必须做：卡里明令「不要打句号、不要写书面腔」，而官方台词句句带「。」。
       本项目铁律是**指令 < 示例** —— 直接注入带句号的范例，
       会把之前专门清掉的标点习惯整个教回来。
    """
    s = s.replace("。", "\n")          # 句号 → 换行（真人用换行断句）
    s = s.replace("，", " ").replace("、", " ")   # 逗号 → 空格
    s = s.replace("！", "!").replace("？", "?")   # 全角 → 半角
    s = s.replace("～", "~").replace("　", " ")
    s = re.sub(r"[ \t]{2,}", " ", s)
    s = re.sub(r"\n{2,}", "\n", s)
    return "\n".join(x.strip() for x in s.split("\n") if x.strip())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--who", default="soyo", choices=["anon", "soyo"])
    ap.add_argument("--n", type=int, default=8, help="要几条")
    ap.add_argument("--max-len", type=int, default=26)
    ap.add_argument("--min-turns", type=int, default=4)
    ap.add_argument("--max-turns", type=int, default=6)
    ap.add_argument("--seed", type=int, default=20261010)
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    cands = []
    files = 0
    for dirpath, _dns, fns in os.walk(args.root):
        for fn in fns:
            if not fn.endswith(".txt"):
                continue
            files += 1
            turns = parse_file(os.path.join(dirpath, fn))
            for run in iter_runs(turns):
                size = len(run)
                if not (args.min_turns <= size <= args.max_turns):
                    continue
                if args.who not in [w for w, _ in run]:
                    continue
                texts = [t for _w, t in run]
                if any(len(t) > args.max_len for t in texts):
                    continue
                if any(HEAVY.search(t) for t in texts):
                    continue
                # 括号内心独白 / 舞台指示：剃掉（卡里禁止用括号写动作）
                if any(PAREN_INNER.search(t) for t in texts):
                    continue
                # 双方都要有回应：目标角色至少说 2 句、对方至少 2 句
                mine = [t for w, t in run if w == args.who]
                theirs = [t for w, t in run if w != args.who]
                if len(mine) < 2 or len(theirs) < 2:
                    continue
                # 结构得分：交替越多越像"来回"
                switches = sum(1 for k in range(1, size) if run[k][0] != run[k - 1][0])
                cands.append((switches, size, run))

    print(f"扫描 {files} 文件；候选段落 {len(cands)} 个（双方各≥2句、≤{args.max_len}字、无重症台词）")
    if not cands:
        return
    cands.sort(key=lambda x: (-x[0], x[1]))
    pool = cands[:max(args.n * 6, 40)]
    rnd = random.Random(args.seed)
    picked = rnd.sample(pool, min(args.n, len(pool)))

    blocks = []
    for switches, size, run in picked:
        # 归一化标点；顺便丢掉开头的 {{char}} 行，让每段都以 {{user}} 起（mes_example 惯例）
        seq = [(w, to_texting(t)) for w, t in run]
        while seq and seq[0][0] == args.who:
            seq.pop(0)
        if len(seq) < 3:
            continue
        lines = []
        for w, t in seq:
            role = "{{char}}" if w == args.who else "{{user}}"
            # 一句里的多行拆成多条消息（和实际发送一致）
            for part in t.split("\n"):
                lines.append(f"{role}: {part}")
        blocks.append("<START>\n" + "\n".join(lines))
    body = "\n".join(blocks) + "\n"

    print(f"选出 {len(picked)} 段（按交替次数排序，取自前 {len(pool)} 名）\n")
    for b in blocks:
        print(b.replace("\n", "\n    ")[:300])
        print()
    if args.out:
        open(args.out, "w", encoding="utf-8").write(body)
        print("已写入:", args.out, len(body), "字符")
    # 结构分布
    c = collections.Counter(s for s, _sz, _r in picked)
    print("交替次数分布:", dict(sorted(c.items())))


if __name__ == "__main__":
    main()
