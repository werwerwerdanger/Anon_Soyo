#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fix_anon_practice_monopoly.py -- 打破「练琴」的垄断（用户 2026-10-10：「她为什么一直执着于练琴」）

诊断：
  **不是 bug。** 「练琴」是爱音的**核心矛盾**本身 —— 卡里写着她被立希批评后
  「开始认真练琴」，冷知识里写着「认真练能练到很出色，却始终赢不过专精某一项的人」；
  官方语料也是「她那是天才型 **我是努力型**」「我可是每天都在进步」。
  努力型 vs 天才型就是她的定义，练琴是它的载体。**不能删。**

  **但"执着"的真因是另一件事**：她**手上只有这一件具体的日常**。
  需要说点具体的事时只剩练琴可选，于是成了万能挡箭牌：
      原神牛逼   → 不过我平时都在练琴啊 哪有空打这些
      喵梦亲怎么办 → 练琴的时候放着当BGM 两不耽误的~
  实测：65 条回复里 18% 提乐队相关、12% 提"练"；
  21 个示例里 **9 个（43%）**跟练/排练/谱/弹有关。

修法（练琴保留为核心，只打破垄断）：
  1) 换掉两条「练琴当万能答案」的示例
     [10] `周六不行 有排练`      → `周六不行 我要去挑布料`（服装设计也是她的职务）
     [13] `我上午练完琴去买了条裙子` → `在商场试了一下午衣服`
  2) 补一条明确规则：日常换着来，别每次都答练琴
     （⚠ 不列范词清单过度 —— 但这里必须给出**她的其他职务**作为替代项，
       否则模型没有别的素材可用。这是"给素材"而不是"给模板"。）

用法: python fix_anon_practice_monopoly.py --check | (无参) | --revert
"""
import argparse
import base64
import io
import json
import os
import pathlib
import shutil
import struct
import sys
import time
import zlib

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

CARD = pathlib.Path(r"C:\Users\20633\MimirLink\data\characters\Anon_Chihaya.png")

EX10_OLD = "<START>\n{{user}}: 我们出去玩吧\n{{char}}: 去哪\n{{char}}: 周六不行 有排练"
EX10_NEW = "<START>\n{{user}}: 我们出去玩吧\n{{char}}: 去哪\n{{char}}: 周六不行 那天要去挑布料"

EX13_OLD = ("<START>\n{{user}}: 你今天干嘛了\n{{char}}: 我上午练完琴去买了条裙子\n"
            "{{char}}: 试的时候店员说我这个身高穿什么都好看~")
EX13_NEW = ("<START>\n{{user}}: 你今天干嘛了\n{{char}}: 在商场试了一下午衣服\n"
            "{{char}}: 店员说我这个身高穿什么都好看~")

RULE_ANCHOR = "- 同一段对话里，连着几条别用同一个字起头。"
RULE_ADD = ("- 你的日常不只是练琴。被问在干嘛、或者想说点自己的事的时候换着来："
            "改演出服的图、剪账号的视频、挑布料、刷美妆、买衣服、写作业、乐队杂事都行。"
            "练琴是你会在意的，但**每次都拿它出来就显得假了**。\n")


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
    bak = str(p) + ".bak-" + stamp + "-practmono"
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
        chunks[i] = (chunks[i][0], kw + b"\x00" + base64.b64encode(json.dumps(o, ensure_ascii=False).encode()))
    if before != [c for c, _ in chunks]:
        return False, "chunk 清单变了"
    p.write_bytes(write_chunks(chunks))
    back = get_fields(p)
    for k, v in fields.items():
        if back.get(k) != v:
            shutil.copy2(bak, p)
            return False, f"回读不符: {k}"
    return True, os.path.basename(bak)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()
    stamp = time.strftime("%Y%m%d-%H%M%S")
    f = get_fields(CARD)
    sp, ex = f["system_prompt"], f["mes_example"]
    print(f"现在示例里含练/排练/谱/弹的块数（人工数过的基线是 9/21）")

    if args.revert:
        nsp = sp.replace(RULE_ADD, "", 1)
        nex = ex.replace(EX10_NEW, EX10_OLD, 1).replace(EX13_NEW, EX13_OLD, 1)
        ok, info = put_fields(CARD, {"system_prompt": nsp, "mes_example": nex}, stamp)
        print(f"REVERTED  备份={info}" if ok else f"!! {info}")
        return

    bad = []
    for nm, src, cnt in (("EX10", EX10_OLD, ex.count(EX10_OLD)),
                         ("EX13", EX13_OLD, ex.count(EX13_OLD))):
        if cnt != 1:
            bad.append(f"{nm} 锚点={cnt}")
    if sp.count(RULE_ANCHOR) != 1:
        bad.append(f"RULE 锚点={sp.count(RULE_ANCHOR)}")
    if "你的日常不只是练琴" in sp:
        print("-- 规则已加过")
    print("锚点: " + ("; ".join(bad) if bad else "全部唯一"))
    if bad or args.check:
        return
    nsp = sp.replace(RULE_ANCHOR, RULE_ADD + RULE_ANCHOR, 1)
    nex = ex.replace(EX10_OLD, EX10_NEW, 1).replace(EX13_OLD, EX13_NEW, 1)
    ok, info = put_fields(CARD, {"system_prompt": nsp, "mes_example": nex}, stamp)
    if not ok:
        print("!!", info)
        return
    back = get_fields(CARD)
    probs = []
    if "你的日常不只是练琴" not in back["system_prompt"]:
        probs.append("规则缺失")
    if "去挑布料" not in back["mes_example"]:
        probs.append("EX10 未改")
    if "练完琴去买了条裙子" in back["mes_example"]:
        probs.append("EX13 未改")
    print(f"OK sp {len(sp)}->{len(back['system_prompt'])}  ex {len(ex)}->{len(back['mes_example'])}")
    print("断言:", "通过" if not probs else "!! " + "; ".join(probs))


if __name__ == "__main__":
    main()
