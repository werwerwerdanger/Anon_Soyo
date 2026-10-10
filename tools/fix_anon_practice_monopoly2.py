#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fix_anon_practice_monopoly2.py -- 修掉 v1 自己造的坑（用户 2026-10-10：「她为什么一直执着于练琴」）

v1 做了什么、结果怎样（实测 _practice_probe.py，6 问 x 3 采样 = 37 段回复）：
    「练/吉他/谱」 12%  ->  2.7%      ✅ 目的达到
    「演出服/布料/设计图」 0%  ->  37.8%  ❌ 话题只是搬了个家，而且更集中

根因（**不是示例的问题，是规则的枚举**）：
    v1 在 system_prompt 里写了一条列举式规则
        「…换着来：改演出服的图、剪账号的视频、挑布料、刷美妆、买衣服、写作业、乐队杂事都行」
    模型收敛到列表**第一项**（演出服），并且 block[10] 的示例恰好就是
    「在干嘛 -> 我刚把演出服的图改完了」，规则与示例**同向叠加**，于是 37.8%。
    —— 这是本项目第 7 次踩「列举范词 ⇒ 模型收敛到第一个」。
    对比：官方语料 2190 条爱音台词里，演出服相关只有 ~1.4%（31 条）。

    ⚠ 顺带核查：演出服设计**不是编的**，是她的真设定 ——
      官方语料「我来做演出服！今晚就想设计图」「其实是我在运营这个账号~ 还有，演出的服装也是我负责的」
      「还有，演出服也是我设计的。品牌名是『ANON TOKYO』！」。社交账号运营同样为真。
      所以 v1 的示例内容没错，错的是**浓度**。
      但 v1 列表里的「写作业」在官方语料里**查无实据**（打工/补习/作业类台词几乎为 0）⇒ 本版删掉。

本版修法：
  1) 规则：**删掉枚举**，只留策略 + 反幻觉约束（不给任何具体事项，材料交给示例）
  2) 示例：把 block[10]「在干嘛」的答案从「演出服」换成「化妆」（同样是官方语料里的真事
     ——「我昨天看了化妆教学视频，就试着给自己化了一下」），让三个「你今天/最近在干嘛」型示例
     各自覆盖**互不相干**的一块：账号起名(3) / 化妆(10) / 逛街买衣服(12)
  3) 断言：sp 里不再有枚举式清单；示例里任一话题不超过 3 块

用法: python fix_anon_practice_monopoly2.py --check | (无参) | --revert
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

# ---- 1) 规则：枚举 -> 策略 ----
SP_OLD = (
    "- 你的日常不只是练琴。被问在干嘛、或者想说点自己的事的时候换着来："
    "改演出服的图、剪账号的视频、挑布料、刷美妆、买衣服、写作业、乐队杂事都行。"
    "练琴是你会在意的，但**每次都拿它出来就显得假了**。"
)
SP_NEW = (
    "- 别人问你在干嘛、最近忙什么、周末有没有空的时候，你答的是**那一刻手上那件**，"
    "不要每回都答同一件：同一件连着被问两次，就换个说法或者换一件。"
    "你手头永远同时有好几件没做完的事，只干一件事的人一眼就看出是假的。"
    "说的必须是本来就在你手上的事，别临时编一个具体的地点或人名出来。"
)

# ---- 2) 示例 block[10]：「在干嘛 -> 演出服」换成化妆 ----
EX10_OLD = (
    "{{user}}: 在干嘛\n"
    "{{char}}: 我刚把演出服的图改完了\n"
    "{{char}}: 这次肯定好看\n"
    "{{char}}: 我还给新曲子想好了名字"
)
EX10_NEW = (
    "{{user}}: 在干嘛\n"
    "{{char}}: 刚在试新买的眼影\n"
    "{{char}}: 好像下手重了点\n"
    "{{char}}: 不过看久了还挺好看的"
)

# 断言用：v1 的枚举串不许再出现
FORBIDDEN = ["换着来：改演出服的图", "写作业、乐队杂事都行"]

TOPICS = {
    "演出服": r"演出服",
    "账号/视频/起名": r"账号|视频|起名字|起名字",
    "衣服/商场/裙子": r"衣服|商场|裙子|外套",
    "化妆/眼影/美妆": r"化妆|眼影|美妆|色号",
    "练/吉他/谱/排练": r"练|吉他|谱|排练",
}

# 真正需要防的**只有**「日常提问型」示例：block 首行是「在干嘛 / 最近在忙什么 / 今天干嘛了…」
# 这类块才是「被问日常 -> 答某件事」的模板，单一话题在这个桶里超过 1 块就会变成万能答案。
# 其余块是剧情重头戏（乐奈天才型/努力型、排练迟到、立希那场戏…），话题重复是正常的，
# 实测也不会外溢：v1 卡片下实测「练」只占 2.7%。
DAILY_Q = re.compile(r"在干嘛|最近在忙|今天干嘛|最近怎么样|随便聊|忙什么呢")
DAILY_MAX_PER_TOPIC = 1


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
    bak = str(p) + ".bak-" + stamp + "-practmono2"
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


def topic_report(ex):
    """返回 (块数, 全量话题分布, 日常提问型块里的话题分布)"""
    blocks = [b.strip() for b in re.split(r"<START>", ex) if b.strip()]
    rep = {}
    for k, rx in TOPICS.items():
        rep[k] = sum(1 for b in blocks if re.search(rx, b))
    daily = [b for b in blocks if DAILY_Q.search(b.split("\n")[0])]
    drep = {}
    for k, rx in TOPICS.items():
        drep[k] = sum(1 for b in daily if re.search(rx, b))
    return len(blocks), rep, len(daily), drep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()
    stamp = time.strftime("%Y%m%d-%H%M%S")

    f = get_fields(CARD)
    sp, ex = f["system_prompt"], f["mes_example"]

    if args.revert:
        nsp = sp.replace(SP_NEW, SP_OLD, 1)
        nex = ex.replace(EX10_NEW, EX10_OLD, 1)
        ok, info = put_fields(CARD, {"system_prompt": nsp, "mes_example": nex}, stamp)
        print(f"REVERTED  备份={info}" if ok else f"!! {info}")
        return

    bad = []
    sp_done = sp.count(SP_NEW) == 1
    ex_done = ex.count(EX10_NEW) == 1
    if sp.count(SP_OLD) == 1:
        pass
    elif sp_done:
        print("-- 规则已是 v2 文案")
    else:
        bad.append(f"SP 锚点 old={sp.count(SP_OLD)} new={sp.count(SP_NEW)}")
    if ex.count(EX10_OLD) == 1:
        pass
    elif ex_done:
        print("-- EX10 已是 v2 文案")
    else:
        bad.append(f"EX10 锚点 old={ex.count(EX10_OLD)} new={ex.count(EX10_NEW)}")

    n0, rep0, nd0, drep0 = topic_report(ex)
    print(f"改前示例 {n0} 块（其中日常提问型 {nd0} 块），全量分布: "
          + ", ".join(f"{k}={v}" for k, v in rep0.items()))
    print(f"    日常提问型分布: " + (", ".join(f"{k}={v}" for k, v in drep0.items() if v) or "无"))
    print("锚点: " + ("; ".join(bad) if bad else "全部唯一"))
    if bad or args.check:
        return
    if sp_done and ex_done:
        print("-- 无需改动，跳过写入")
        return

    nsp = sp.replace(SP_OLD, SP_NEW, 1) if sp.count(SP_OLD) else sp
    nex = ex.replace(EX10_OLD, EX10_NEW, 1) if ex.count(EX10_OLD) else ex
    ok, info = put_fields(CARD, {"system_prompt": nsp, "mes_example": nex}, stamp)
    if not ok:
        print("!!", info)
        return

    back = get_fields(CARD)
    probs = []
    if "换着来：改演出服的图" in back["system_prompt"]:
        probs.append("v1 枚举仍在 sp")
    if "不要每回都答同一件" not in back["system_prompt"]:
        probs.append("v2 规则缺失")
    for w in FORBIDDEN:
        if w in back["system_prompt"]:
            probs.append(f"禁用串仍在: {w}")
    if "试新买的眼影" not in back["mes_example"]:
        probs.append("EX10 未改")
    if "我刚把演出服的图改完了" in back["mes_example"]:
        probs.append("EX10 旧文案残留")

    n1, rep1, nd1, drep1 = topic_report(back["mes_example"])
    print(f"改后示例 {n1} 块（其中日常提问型 {nd1} 块），全量分布: "
          + ", ".join(f"{k}={v}" for k, v in rep1.items()))
    print(f"    日常提问型分布: " + (", ".join(f"{k}={v}" for k, v in drep1.items() if v) or "无"))
    over = [k for k, v in drep1.items() if v > DAILY_MAX_PER_TOPIC]
    if over:
        probs.append("日常提问型单一话题 >%d 块: %s"
                     % (DAILY_MAX_PER_TOPIC, ", ".join(f"{k}={drep1[k]}" for k in over)))
    if nd1 == 0:
        probs.append("日常提问型示例为 0，无法校验")

    print(f"OK sp {len(sp)}->{len(back['system_prompt'])}  ex {len(ex)}->{len(back['mes_example'])}")
    print("断言:", "通过" if not probs else "!! " + "; ".join(probs))


if __name__ == "__main__":
    main()
