#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fix_anon_timeline_v6.py -- 撤掉 R1、把「演出服」从每轮都在的字段里清出去

v5 实测（18 条回复口径）:
    起名/名字   0%(v3) -> 5.6%(v4) -> 16.7%(v5)   ✅ 用户要的起名癖立住了
    演出服/缝/改衣  5.6%(v3) -> 11.1%(v4) -> 16.7%(v5)  ❌ 反弹

反弹的原因不是规则写错了，是**我把这个主题塞进了每轮都在的字段**：
  1) v5 我把 description 的职务行改成了
       「- 职务：节奏吉他手 & 乐队社交账号运营（乐队的演出服也是她做的，牌子叫 ANON TOKYO）」
     —— 职务 = 她的日常，等于又告诉她"你的日常就是演出服"，而且每轮都读一遍。
  2) v3 加的 R1 规则每轮把「演出服」说两遍（"演出服早就做完穿上了""你设计的"）。
     这条规则本来是为了修 v1 的错才加的；现在 v1 的枚举早就不在了（v1 实测 55.6%），
     规则自己在维持这个主题的显著度。
  3) first_mes「演出服也是我弄的」——**每段新对话都念一次**。

⇒ v6：R1 整条删掉；职务行里的括号删掉；first_mes 里那行删掉。
   之后「演出服」只剩两处，且都不会被反复读到：
     - description 里的外观描述行（单纯写她身上那套长什么样，中性）
     - character_book 的 ANON TOKYO 条目（关键词触发，低频）
   官方语料里演出服相关只占 1.4%（31/2190），这才是对的浓度。

用法: python fix_anon_timeline_v6.py --check | (无参) | --revert
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

DESC_OLD = "- 职务：节奏吉他手 & 乐队社交账号运营（乐队的演出服也是她做的，牌子叫 ANON TOKYO）"
DESC_NEW = "- 职务：节奏吉他手 & 乐队社交账号运营"

FM_OLD = ('我是爱音~\nMyGO!!!!! 的吉他手，演出服也是我弄的\n'
          '乐队是我拉起来的哦\n下周在RiNG有演出 来的人不多 怎么办嘛')
FM_NEW = ('我是爱音~\nMyGO!!!!! 的吉他手\n'
          '乐队是我拉起来的哦\n下周在RiNG有演出 来的人不多 怎么办嘛')

R1_LINE = ("- 有两件事**已经过去了**，永远是完成时：乐队的名字早就定好了，演出服也早就做完穿上了"
           "（你设计的，牌子叫 ANON TOKYO）。这两件你只会用过去的方式提。\n")

PH_OLD = "5）喜欢时尚美妆；乐队的演出服是她做的、账号也归她管"
PH_NEW = "5）喜欢时尚美妆，乐队的账号归她管"

# 断言：这些每轮都在的字段里不许再出现「演出服」
PER_TURN = ("description", "personality", "scenario", "system_prompt",
            "first_mes", "post_history_instructions", "mes_example")


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


def put(p, fields, stamp, tag):
    bak = str(p) + ".bak-" + stamp + "-" + tag
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
    return True, os.path.basename(bak)


def audit(f):
    out = []
    for k in PER_TURN:
        v = f.get(k) or ""
        c = v.count("演出服")
        if c:
            out.append(f"{k}={c}")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()
    stamp = time.strftime("%Y%m%d-%H%M%S")

    f = get_fields(CARD)
    sp, ex, fm, de = f["system_prompt"], f["mes_example"], f["first_mes"], f["description"]
    ph = f.get("post_history_instructions") or ""

    fwd, rev, bad = {}, {}, []
    if R1_LINE in sp:
        fwd["system_prompt"] = sp.replace(R1_LINE, "", 1)
        rev["system_prompt"] = sp
    elif R1_LINE not in sp and "永远是完成时" not in sp:
        fwd["system_prompt"] = sp
    else:
        bad.append("R1 锚点不明确")
    if ph.count(PH_OLD) == 1:
        fwd["post_history_instructions"] = ph.replace(PH_OLD, PH_NEW, 1)
        rev["post_history_instructions"] = ph
    elif ph.count(PH_NEW) == 1:
        pass
    else:
        bad.append(f"post_hist 锚点={ph.count(PH_OLD)}/{ph.count(PH_NEW)}")
    if de.count(DESC_OLD) == 1:
        fwd["description"] = de.replace(DESC_OLD, DESC_NEW, 1)
        rev["description"] = de
    elif de.count(DESC_NEW) == 1:
        pass
    else:
        bad.append(f"description 锚点={de.count(DESC_OLD)}/{de.count(DESC_NEW)}")
    if fm.count(FM_OLD) == 1:
        fwd["first_mes"] = fm.replace(FM_OLD, FM_NEW, 1)
        rev["first_mes"] = fm
    elif fm.count(FM_NEW) == 1:
        pass
    else:
        bad.append(f"first_mes 锚点={fm.count(FM_OLD)}/{fm.count(FM_NEW)}")

    print("改前每轮字段里的「演出服」计数:", audit(f) or "无")
    if bad:
        print("锚点问题: " + "; ".join(bad))
        return
    if args.check:
        print("--check：未写入")
        return
    if not fwd:
        print("-- 无需改动")
        return

    if args.revert:
        ok, info = put(CARD, rev, stamp, "tlv6rev")
        print(f"REVERTED 备份={info}" if ok else f"!! {info}")
        return

    ok, info = put(CARD, fwd, stamp, "tlv6")
    print(f"OK 备份={info}" if ok else f"!! {info}")
    if not ok:
        return

    back = get_fields(CARD)
    probs = []
    if "永远是完成时" in back["system_prompt"]:
        probs.append("R1 未删")
    if "你有个改不掉的毛病：闲下来就在琢磨名字" not in back["system_prompt"]:
        probs.append("R2 被误删")
    if "乐队的账号归她管" not in (back.get("post_history_instructions") or ""):
        probs.append("post_hist 未改")
    if "演出服" in back["first_mes"]:
        probs.append("first_mes 仍有演出服")
    for line in back["description"].split("\n"):
        if line.startswith("- 职务") and "演出服" in line:
            probs.append("职务行仍有演出服")

    print("改后每轮字段里的「演出服」计数:", audit(back) or "无")
    for k in PER_TURN:
        v = (back.get(k) or "")
        if "演出服" in v and k in ("system_prompt", "first_mes", "mes_example"):
            probs.append(f"{k} 不该再有演出服")
    print("断言:", "通过" if not probs else "!! " + "; ".join(probs))


if __name__ == "__main__":
    main()
