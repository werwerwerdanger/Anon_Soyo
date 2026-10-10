#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fix_anon_timeline_naming.py -- 修爱音的「时间线错误」并把「起名癖」立起来
（用户 2026-10-10：「现在他一直在琢磨着给爱音设计裙子，但是其实裙子已经设计完了。
   现在他可以琢磨着给新东西起名字，更符合爱音的设定」）

用户指出的是**真 bug**，而且不止一处。官方语料核对（_anon_official_lines.txt, 2190 条）：

  演出服 —— **已完成**：
    「唔，前些天的演出时间虽然很紧，但还是做好了演出服，还写好了新歌——」
    「看吧？把演出服做出来是正确的吧？」
    「还有，演出服也是我设计的。品牌名是『ANON TOKYO』！」
    未来时才是对的：「如果大家喜欢之前的演出服设计，下次的服装也按照这个风格试试吧~」
    她的身份是**负责人**：「（作为演出服的负责人，这方面的动向也要及时掌握才行呢）」→
    有持续身份 ≠ 手里正在赶一件活。所以「正在改设计图 / 去挑布料」是拿早期剧情当现在，是硬伤。

  乐队名 —— **早定完了**：
    「乐队名和演出服！！还什么都没定呢！」是**早期**场景（她当时想取 ANON TOKYO 被否）。
    拿它当"最近在忙什么"的答案，等于说乐队还没名字。

  起名 —— **真的是她的设定**（用户提议的方向）：官方语料
    「也就是说，我几乎就是乐队的中心人物呢~ 顺带一提，给乐队取名的人也是——」
    「比如宣传的人、做演出服的人、给乐队取名的人——」
    卡里 description 也已有：「想乐队名时提过"UnKnown""Anone""Annouimo"等全带自己名字的点子，全被无情否决」。
    ⇒ 所以不是要删掉「起名」，而是把它从**一件任务**改成**她随口就犯的毛病**。

改法（示例侧）：
  [3]  「你最近在忙什么」：`给乐队起名字`（乐队已命名 ⇒ 时间线错）
        -> `在想名字／看到个没名字的就想给起一个`（癖好，无时间线依赖）
  [4]  `我刚在刷美妆视频` + `服装设计要用得着的`（演出服已完成 ⇒ 硬伤）
        -> `我刚在剪这周要发的视频` + `乐队账号的东西全是我在管`（canon：她运营乐队账号）
  [9]  `周六不行 那天要去挑布料` -> `周六不行诶 那天有事` + `但周日可以!`（去掉在做的活）
  [11] `一躺下就在想演出服的事` -> `一躺下就在过舞台上的走位`（canon：她重视舞台效果）
  first_mes `演出服也是我在弄` -> `演出服也是我弄的`（时态）
  [10] 保持 v2 的「试新买的眼影」（canon：看了化妆教学视频试了一下）

改法（规则侧，加两条）：
  R1 时间线锚：乐队名早定了、演出服早做完了，别再当手里正在赶的活
  R2 起名癖：看到没名字的东西就想给起一个 —— 写成**反应**不是**任务**，
     否则又会变成"在干嘛"的万能答案（本项目第 7 次踩列举/单话题收敛，见 v1 的 37.8%）

用法: python fix_anon_timeline_naming.py --check | (无参) | --revert
"""
import argparse
import base64
import io
import json
import os
import pathlib
import re
import shutil
import struct
import sys
import time
import zlib

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

CARD = pathlib.Path(r"C:\Users\20633\MimirLink\data\characters\Anon_Chihaya.png")

# ---------------------------------------------------------------- 规则
SP_ANCHOR = (
    "- 别人问你在干嘛、最近忙什么、周末有没有空的时候，你答的是**那一刻手上那件**，"
    "不要每回都答同一件：同一件连着被问两次，就换个说法或者换一件。"
    "你手头永远同时有好几件没做完的事，只干一件事的人一眼就看出是假的。"
    "说的必须是本来就在你手上的事，别临时编一个具体的地点或人名出来。"
)
RULES_NEW = (
    "- 有两件事**已经过去了**，别当成你手里正在赶的活：乐队的名字早就定好了，"
    "演出服也早就做完穿上了（你设计的，牌子叫 ANON TOKYO）。"
    "你要提就当成已经完成的事提，别再「正在改设计图」，也别再去买布料。"
    "乐队以后要做新衣服时才轮到你。\n"
    "- 你有个改不掉的毛病：看到没名字的东西就想顺手给它起一个，起出来的还都带你自己。"
    "这是你随口就会冒出来的反应，不用别人问 —— 但你不会拿它当「最近在忙什么」的正经答案。\n"
)

# ---------------------------------------------------------------- 示例
EX3_OLD = (
    "{{user}}: 你最近在忙什么\n"
    "{{char}}: 给乐队起名字啊!\n"
    "{{char}}: 就叫ANON TOKYO怎么样!\n"
    "{{user}}: 你起的名字不是全被否了吗\n"
    "{{char}}: 诶?!这次不一样!\n"
    "{{user}}: 上次你也这么说的\n"
    "{{char}}: 上次那是他们没眼光\n"
    "{{char}}: 这次我自己都觉得好听"
)
EX3_NEW = (
    "{{user}}: 你最近在忙什么\n"
    "{{char}}: 在想名字!\n"
    "{{user}}: 想什么名字\n"
    "{{char}}: 什么都想 看到个没名字的就想给起一个\n"
    "{{user}}: 你起的名字不是全被否了吗\n"
    "{{char}}: 诶?!这次不一样!\n"
    "{{user}}: 上次你也这么说的\n"
    "{{char}}: 上次那是他们没眼光\n"
    "{{char}}: 这次我自己都觉得好听"
)

EX4_OLD = (
    "{{user}}: 在吗\n"
    "{{char}}: 在呀!\n"
    "{{char}}: 我刚在刷美妆视频~\n"
    "{{user}}: 又在摸鱼\n"
    "{{char}}: 这不是摸鱼!\n"
    "{{char}}: 这叫找灵感 服装设计要用得着的~"
)
EX4_NEW = (
    "{{user}}: 在吗\n"
    "{{char}}: 在呀! 我刚在剪这周要发的视频~\n"
    "{{user}}: 又在摸鱼\n"
    "{{char}}: 这不是摸鱼!\n"
    "{{char}}: 乐队账号的东西全是我在管诶"
)

EX9_OLD = (
    "{{user}}: 我们出去玩吧\n"
    "{{char}}: 去哪\n"
    "{{char}}: 周六不行 那天要去挑布料"
)
EX9_NEW = (
    "{{user}}: 我们出去玩吧\n"
    "{{char}}: 去哪\n"
    "{{char}}: 周六不行诶 那天有事\n"
    "{{char}}: 但周日可以!"
)

EX11_OLD = (
    "{{user}}: 下周演出你紧张吗\n"
    "{{char}}: 紧张啊\n"
    "{{char}}: 这两天一直在背谱 手都酸了\n"
    "{{user}}: 那你早点睡\n"
    "{{char}}: 睡不着的 一躺下就在想演出服的事"
)
EX11_NEW = (
    "{{user}}: 下周演出你紧张吗\n"
    "{{char}}: 紧张啊\n"
    "{{char}}: 这两天一直在背谱 手都酸了\n"
    "{{user}}: 那你早点睡\n"
    "{{char}}: 睡不着的 一躺下就在过舞台上的走位"
)

FM_OLD = ('我是爱音~\nMyGO!!!!! 的吉他手，演出服也是我在弄\n'
          '乐队是我拉起来的哦\n下周在RiNG有演出 来的人不多 怎么办嘛')
FM_NEW = ('我是爱音~\nMyGO!!!!! 的吉他手，演出服也是我弄的\n'
          '乐队是我拉起来的哦\n下周在RiNG有演出 来的人不多 怎么办嘛')

# 断言：这些「正在做某件手工活」的串不许再出现在示例里（first_mes 除外，只查"在弄"）
CRAFT_FORBIDDEN = [
    "要去挑布料", "服装设计要用得着的", "在弄\n", "正在改设计图",
    "改设计图", "改演出服的图", "想演出服的事",
]
# 日常提问型块 -> 每个话题不得超过 1 块（沿用 v2 的闸门）
DAILY_Q = re.compile(r"在干嘛|最近在忙|今天干嘛|最近怎么样|随便聊|忙什么呢")
TOPICS = {
    "演出服": r"演出服",
    "账号/视频/起名": r"账号|视频|起名字|起名",
    "衣服/商场/裙子": r"衣服|商场|裙子|外套|布料",
    "化妆/眼影/美妆": r"化妆|眼影|美妆|色号",
    "练/吉他/谱/排练": r"练|吉他|谱|排练",
}
DAILY_MAX_PER_TOPIC = 1

PAIRS = [("EX3", EX3_OLD, EX3_NEW), ("EX4", EX4_OLD, EX4_NEW), ("EX9", EX9_OLD, EX9_NEW),
         ("EX11", EX11_OLD, EX11_NEW)]


def read_chunks(raw):
    out, pos = [], 8
    while pos < len(raw):
        (ln,) = struct.unpack(">I", raw[pos:pos + 4])
        out.append((raw[pos + 4:pos + 8], raw[pos + 8:pos + 8 + ln]))
        pos += 12 + ln
    return out


def write_chunks(chunks):
    out = [b"\x89PNG\r\n\x1a\n"]
    for ct, d in chunks:
        out += [struct.pack(">I", len(d)), ct, d,
                struct.pack(">I", zlib.crc32(ct + d) & 0xFFFFFFFF)]
    return b"".join(out)


def payload_idx(chunks):
    r = []
    for i, (ct, d) in enumerate(chunks):
        if ct in (b"tEXt", b"iTXt"):
            if d.split(b"\x00", 1)[0].decode("latin-1") in ("chara", "ccv3"):
                r.append(i)
    return r


def get_fields(p):
    chunks = read_chunks(p.read_bytes())
    for i in payload_idx(chunks):
        kw, _, v = chunks[i][1].partition(b"\x00")
        o = json.loads(base64.b64decode(v).decode("utf-8"))
        return o.get("data") if isinstance(o.get("data"), dict) else o
    raise SystemExit("!! no chunk")


def put_fields(p, fields, stamp):
    bak = str(p) + ".bak-" + stamp + "-timeline"
    shutil.copy2(p, bak)
    chunks = read_chunks(p.read_bytes())
    before = [c for c, _ in chunks]
    for i in payload_idx(chunks):
        kw, _, v = chunks[i][1].partition(b"\x00")
        o = json.loads(base64.b64decode(v).decode("utf-8"))
        t = o.get("data") if isinstance(o.get("data"), dict) else o
        for k, val in fields.items():
            if k in t:
                t[k] = val
        chunks[i] = (chunks[i][0],
                     kw + b"\x00" + base64.b64encode(json.dumps(o, ensure_ascii=False).encode()))
    if before != [c for c, _ in chunks]:
        return False, "chunk 清单变了"
    p.write_bytes(write_chunks(chunks))
    back = get_fields(p)
    for k, v in fields.items():
        if back.get(k) != v:
            shutil.copy2(bak, p)
            return False, f"回读不符: {k}"
    return True, os.path.basename(bak)


def report(ex):
    blocks = [b.strip() for b in re.split(r"<START>", ex) if b.strip()]
    rep = {k: sum(1 for b in blocks if re.search(rx, b)) for k, rx in TOPICS.items()}
    daily = [b for b in blocks if DAILY_Q.search(b.split("\n")[0])]
    drep = {k: sum(1 for b in daily if re.search(rx, b)) for k, rx in TOPICS.items()}
    return len(blocks), rep, len(daily), drep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()
    stamp = time.strftime("%Y%m%d-%H%M%S")

    f = get_fields(CARD)
    sp, ex, fm = f["system_prompt"], f["mes_example"], f["first_mes"]

    if args.revert:
        nsp = sp.replace(RULES_NEW, "", 1)
        nex = ex
        for _nm, old, new in PAIRS:
            nex = nex.replace(new, old, 1)
        nfm = fm.replace(FM_NEW, FM_OLD, 1)
        ok, info = put_fields(CARD, {"system_prompt": nsp, "mes_example": nex,
                                     "first_mes": nfm}, stamp)
        print(f"REVERTED  备份={info}" if ok else f"!! {info}")
        return

    bad, done = [], 0
    if sp.count(SP_ANCHOR) == 1:
        pass
    elif "别当成你手里正在赶的活" in sp:
        print("-- 规则已是 v3 文案"); done += 1
    else:
        bad.append(f"SP 锚点={sp.count(SP_ANCHOR)}")
    for nm, old, new in PAIRS:
        if ex.count(old) == 1:
            pass
        elif ex.count(new) == 1:
            print(f"-- {nm} 已是 v3 文案"); done += 1
        else:
            bad.append(f"{nm} 锚点 old={ex.count(old)} new={ex.count(new)}")
    if fm.count(FM_OLD) == 1:
        pass
    elif fm.count(FM_NEW) == 1:
        print("-- first_mes 已是 v3 文案"); done += 1
    else:
        bad.append(f"FM 锚点 old={fm.count(FM_OLD)} new={fm.count(FM_NEW)}")

    n0, rep0, nd0, drep0 = report(ex)
    print(f"改前示例 {n0} 块（日常提问型 {nd0}），全量分布: "
          + ", ".join(f"{k}={v}" for k, v in rep0.items()))
    print(f"    日常提问型分布: " + (", ".join(f"{k}={v}" for k, v in drep0.items() if v) or "无"))
    print(f"    first_mes 里的时态: " + ("旧(在弄)" if FM_OLD in fm else "新(弄的)" if FM_NEW in fm else "?"))
    print("锚点: " + ("; ".join(bad) if bad else "全部唯一"))
    if bad or args.check:
        return
    if done == len(PAIRS) + 2:
        print("-- 无需改动，跳过写入")
        return

    nsp = sp.replace(SP_ANCHOR, SP_ANCHOR + "\n" + RULES_NEW.rstrip("\n"), 1) if sp.count(SP_ANCHOR) else sp
    nex = ex
    for _nm, old, new in PAIRS:
        nex = nex.replace(old, new, 1)
    nfm = fm.replace(FM_OLD, FM_NEW, 1)

    ok, info = put_fields(CARD, {"system_prompt": nsp, "mes_example": nex, "first_mes": nfm}, stamp)
    if not ok:
        print("!!", info)
        return

    back = get_fields(CARD)
    probs = []
    if "别当成你手里正在赶的活" not in back["system_prompt"]:
        probs.append("R1 时间线规则缺失")
    if "看到没名字的东西就想顺手给它起一个" not in back["system_prompt"]:
        probs.append("R2 起名癖规则缺失")
    if "演出服也是我弄的" not in back["first_mes"]:
        probs.append("first_mes 时态未改")
    if "演出服也是我在弄" in back["first_mes"]:
        probs.append("first_mes 旧时态残留")
    for w in CRAFT_FORBIDDEN:
        if w in back["mes_example"]:
            probs.append(f"示例仍有在做的活: {w!r}")
    if "演出服" in back["mes_example"]:
        probs.append("示例仍有「演出服」")
    if "看到个没名字的就想给起一个" not in back["mes_example"]:
        probs.append("EX3 起名癖未落地")

    n1, rep1, nd1, drep1 = report(back["mes_example"])
    print(f"改后示例 {n1} 块（日常提问型 {nd1}），全量分布: "
          + ", ".join(f"{k}={v}" for k, v in rep1.items()))
    print(f"    日常提问型分布: " + (", ".join(f"{k}={v}" for k, v in drep1.items() if v) or "无"))
    over = [k for k, v in drep1.items() if v > DAILY_MAX_PER_TOPIC]
    if over:
        probs.append("日常提问型单一话题 >%d: %s" % (DAILY_MAX_PER_TOPIC,
                    ", ".join(f"{k}={drep1[k]}" for k in over)))
    if nd1 == 0:
        probs.append("日常提问型示例为 0")

    print(f"OK sp {len(sp)}->{len(back['system_prompt'])}  ex {len(ex)}->{len(back['mes_example'])}"
          f"  fm {len(fm)}->{len(back['first_mes'])}")
    print("断言:", "通过" if not probs else "!! " + "; ".join(probs))


if __name__ == "__main__":
    main()
