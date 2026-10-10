#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fix_anon_timeline_r1.py -- v3 留下的两个尾巴

v3 实测（_practice_probe.py，6 问 x 3 采样 = 41 段）：
    演出服 37.8% -> 4.9%   ✅ 时间线错误基本清掉
    练      0.0% -> 7.3%   ✅ 回到正常浓度
    食物/店               9.8%   ✅ 长出新的生活细节（水果三明治那几条很人）
  但还剩两个尾巴：

  [尾巴1] 否定式 priming。v3 的规则里我写了
      「别再「正在改设计图」，也别再去买布料。」
  结果实测 18 条回复里还有 1 条：「今天没出去 在家改演出服 / 那个外套下摆我缝了一下午」。
  这是典型的"别想大象"—— 否定句把那个词又喂了模型一次。
  ⇒ 改成纯肯定式，一次都不提那些词。

  [尾巴2] 起名癖没落地。v3 的规则写的是
      「这是你随口就会冒出来的反应，不用别人问 —— 但你不会拿它当「最近在忙什么」的正经答案。」
  既说了"不用问"又说了"别当正经答案"，自相矛盾；实测 18 条回复里**起名出现 0 次**，
  等于白写。用户要的是「他现在可以琢磨着给新东西起名字」（原话），
  所以应该把它明确**许可成一件她闲下来真会干的事**，而不是半吊子地既推又拦。

用法: python fix_anon_timeline_r1.py --check | (无参) | --revert
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

# v3 写进卡片的两行（R1 + R2，rstrip 掉尾部换行）
R1_OLD = (
    "- 有两件事**已经过去了**，别当成你手里正在赶的活：乐队的名字早就定好了，"
    "演出服也早就做完穿上了（你设计的，牌子叫 ANON TOKYO）。"
    "你要提就当成已经完成的事提，别再「正在改设计图」，也别再去买布料。"
    "乐队以后要做新衣服时才轮到你。\n"
)
R2_OLD = (
    "- 你有个改不掉的毛病：看到没名字的东西就想顺手给它起一个，起出来的还都带你自己。"
    "这是你随口就会冒出来的反应，不用别人问 —— 但你不会拿它当「最近在忙什么」的正经答案。\n"
)
BLOCK_OLD = (R1_OLD + R2_OLD).rstrip("\n")

# v4：R1 去否定 / R2 明确许可
R1_NEW = (
    "- 有两件事**已经过去了**，永远是完成时：乐队的名字早就定好了，演出服也早就做完穿上了"
    "（你设计的，牌子叫 ANON TOKYO）。这两件你只会用过去的方式提。\n"
)
R2_NEW = (
    "- 你有个改不掉的毛病：看到没名字的东西就想顺手给它起一个，起出来的还都带你自己"
    "（乐队名和那个牌子当年都是这么来的）。这是你闲下来真会干的事，"
    "随口就能冒出来，不用等别人问。\n"
)
BLOCK_NEW = (R1_NEW + R2_NEW).rstrip("\n")

# 断言：这些词不许再出现在 v4 新增的规则里（防止我又把否定句写回去）
R1_FORBIDDEN = ["买布料", "正在改设计图", "改设计图"]


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
    bak = str(p) + ".bak-" + stamp + "-tlr1"
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()
    stamp = time.strftime("%Y%m%d-%H%M%S")

    f = get_fields(CARD)
    sp = f["system_prompt"]

    if args.revert:
        ok, info = put_fields(CARD, {"system_prompt": sp.replace(BLOCK_NEW, BLOCK_OLD, 1)}, stamp)
        print(f"REVERTED  备份={info}" if ok else f"!! {info}")
        return

    if sp.count(BLOCK_OLD) == 1:
        state = "v3"
    elif sp.count(BLOCK_NEW) == 1:
        state = "v4"
    else:
        state = f"? old={sp.count(BLOCK_OLD)} new={sp.count(BLOCK_NEW)}"
    print(f"当前规则块状态: {state}")
    if state not in ("v3", "v4"):
        print("锚点不唯一，拒绝执行")
        return
    if state == "v4" or args.check:
        if state == "v4":
            print("-- 已是 v4，无需改动")
        return

    ok, info = put_fields(CARD, {"system_prompt": sp.replace(BLOCK_OLD, BLOCK_NEW, 1)}, stamp)
    if not ok:
        print("!!", info)
        return

    back = get_fields(CARD)["system_prompt"]
    probs = []
    if BLOCK_NEW not in back:
        probs.append("v4 规则块缺失")
    if "别当成你手里正在赶的活" in back:
        probs.append("v3 规则残留")
    for w in R1_FORBIDDEN:
        if w in R1_NEW:
            probs.append(f"v4 R1 又写了否定词: {w}")
    if "永远不会" in back or "别再" in back.split("你有个改不掉的毛病")[0][-200:]:
        probs.append("R1 仍是/又变成否定式")
    if "这是你闲下来真会干的事" not in back:
        probs.append("R2 许可未落地")

    print(f"OK sp {len(sp)}->{len(back)}")
    print("断言:", "通过" if not probs else "!! " + "; ".join(probs))
    print("\n当前 R1/R2 全文:")
    i = back.find("- 有两件事**已经过去了**")
    j = back.find("- 同一段对话里")
    print(back[i:j].rstrip())


if __name__ == "__main__":
    main()
