#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fix_anon_timeline_v5.py -- 把「服装设计」从现在进行时改成已完成 + 让起名癖真的出现

v4 实测（_practice_probe.py, 6 问 x 3 采样 = 41 段）：
    演出服  4.9%（v3 是 37.8%）✅
    练      7.3%             ✅
    食物/店 9.8%             ✅ 长出了新的生活细节
  两条尾巴：
    a) 「今天没出去 在家改演出服 / 那个外套下摆我缝了一下午」「新裙子快画完了」
       —— 规则里的否定词已经清掉了（实测 prompt 里没有「买布料」「正在改设计图」），
          所以源头不在规则。查出来是**卡片自己的身份描述**在把她写成"服装设计师"：
            [description]  - 职务：节奏吉他手 & 服装设计 & 社交媒体运营
            [post_history_instructions] 5）喜欢时尚美妆，负责乐队服装和社交账号
            [character_book] 乐队的演出服基本都由爱音制作，并打上这个品牌名
          三处都是**现在进行时 / 职务**口吻 ⇒ 模型读到的是"她的日常就是做衣服"。
          改写成**已完成 + 归属**（她做的、牌子是她的），并把"账号运营"保留成现在时
          —— 账号运营是有真实日常动作的（剪视频/发照片），留着反而给日常供素材。
    b) 起名癖 0/18。规则写了但示例里只有 block[3] 一块，且是"被问→答"。
       **真特征是自发冒出来的** ⇒ 在 block[17] 加一段：她听到茶名「格雷伯爵」
       就直接记下来准备以后用。反应式、零新增话题、完全是人设。

用法: python fix_anon_timeline_v5.py --check | (无参) | --revert
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

# ---- A. 身份描述：现在进行时 -> 已完成 ----
TEXTFIX = [
    ("description",
     "- 职务：节奏吉他手 & 服装设计 & 社交媒体运营",
     "- 职务：节奏吉他手 & 乐队社交账号运营（乐队的演出服也是她做的，牌子叫 ANON TOKYO）"),
    ("post_history_instructions",
     "5）喜欢时尚美妆，负责乐队服装和社交账号",
     "5）喜欢时尚美妆；乐队的演出服是她做的、账号也归她管"),
]
BOOK_OLD = "爱音自创的虚拟品牌。乐队的演出服基本都由爱音制作，并打上这个品牌名。"
BOOK_NEW = "爱音自创的虚拟品牌。乐队的演出服由她设计制作完成，打上了这个品牌名。"

# ---- B. 规则：R2 写硬一点 ----
R2_OLD = ("- 你有个改不掉的毛病：看到没名字的东西就想顺手给它起一个，起出来的还都带你自己"
          "（乐队名和那个牌子当年都是这么来的）。这是你闲下来真会干的事，"
          "随口就能冒出来，不用等别人问。")
R2_NEW = ("- 你有个改不掉的毛病：闲下来就在琢磨名字 —— 看到没名字的东西想给起一个，"
          "听到好听的名字也会记下来准备以后用，起出来的还都带你自己"
          "（乐队名和那个牌子当年都是这么来的）。这事跟别人问不问没关系，你自己就会冒出来。")

# ---- C. 示例：block[17] 加自发起名 ----
EX17_OLD = ("{{user}}: ……啧\n"
            "{{char}}: 她啧了一声!?\n"
            "{{user}}: 两杯热格雷伯爵\n"
            "{{char}}: 什么啊……!态度好差~!")
EX17_NEW = ("{{user}}: ……啧\n"
            "{{char}}: 她啧了一声!?\n"
            "{{user}}: 两杯热格雷伯爵\n"
            "{{char}}: 什么啊……!态度好差~!\n"
            "{{char}}: 不过「格雷伯爵」这名字真好听\n"
            "{{char}}: 我记下来了 以后说不定用得上")

CRAFT_WORDS = ["服装设计", "负责乐队服装", "都由爱音制作"]


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


def put(p, fields, stamp):
    bak = str(p) + ".bak-" + stamp + "-tlv5"
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


def book_replace(book, old, new):
    """在 character_book.entries[].content 里做替换，返回 (新对象, 命中数)"""
    hits = 0
    b = json.loads(json.dumps(book, ensure_ascii=False))
    for e in (b.get("entries") or []):
        c = e.get("content")
        if isinstance(c, str) and old in c:
            e["content"] = c.replace(old, new)
            hits += 1
    return b, hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()
    stamp = time.strftime("%Y%m%d-%H%M%S")

    f = get_fields(CARD)
    bad, hits, already = [], {}, {}

    for field, old, new in TEXTFIX:
        v = f.get(field) or ""
        if v.count(old) == 1:
            hits[field] = (old, new)
        elif v.count(new) == 1:
            already[field] = True
        else:
            bad.append(f"{field}: old={v.count(old)} new={v.count(new)}")

    book = f.get("character_book") or {}
    bk_new, bk_hits = book_replace(book, BOOK_OLD, BOOK_NEW)
    _, bk_rev = book_replace(book, BOOK_NEW, BOOK_OLD)
    if bk_hits == 1:
        hits["__book__"] = (BOOK_OLD, BOOK_NEW)
    elif bk_rev == 1:
        already["__book__"] = True
    else:
        bad.append(f"character_book: old={bk_hits} new={bk_rev}")

    sp, ex = f["system_prompt"], f["mes_example"]
    if sp.count(R2_OLD) == 1:
        hits["__sp__"] = (R2_OLD, R2_NEW)
    elif sp.count(R2_NEW) == 1:
        already["__sp__"] = True
    else:
        bad.append(f"R2: old={sp.count(R2_OLD)} new={sp.count(R2_NEW)}")
    if ex.count(EX17_OLD) == 1:
        hits["__ex17__"] = (EX17_OLD, EX17_NEW)
    elif ex.count(EX17_NEW) == 1:
        already["__ex17__"] = True
    else:
        bad.append(f"EX17: old={ex.count(EX17_OLD)} new={ex.count(EX17_NEW)}")

    print(f"待改 {len(hits)} 处，已是 v5 的 {len(already)} 处")
    if bad:
        print("锚点问题: " + "; ".join(bad))
        return
    if args.check:
        print("--check：未写入")
        return
    if not hits:
        print("-- 无需改动")
        return

    fields = {}
    for field, (old, new) in hits.items():
        if field == "__book__":
            fields["character_book"] = bk_new
        elif field == "__sp__":
            fields["system_prompt"] = sp.replace(old, new, 1)
        elif field == "__ex17__":
            fields["mes_example"] = ex.replace(old, new, 1)
        else:
            fields[field] = (f[field] or "").replace(old, new, 1)

    if args.revert:
        rv = {}
        for field, (old, new) in hits.items():
            if field == "__book__":
                rv["character_book"], _ = book_replace(book, BOOK_NEW, BOOK_OLD)
            elif field == "__sp__":
                rv["system_prompt"] = sp.replace(new, old, 1)
            elif field == "__ex17__":
                rv["mes_example"] = ex.replace(new, old, 1)
            else:
                rv[field] = (f[field] or "").replace(new, old, 1)
        ok, info = put(CARD, rv, stamp)
        print(f"REVERTED 备份={info}" if ok else f"!! {info}")
        return

    ok, info = put(CARD, fields, stamp)
    print(f"OK 备份={info}" if ok else f"!! {info}")
    if not ok:
        return

    back = get_fields(CARD)
    probs = []
    for field, (old, new) in hits.items():
        if field == "__book__":
            if BOOK_NEW not in json.dumps(back.get("character_book"), ensure_ascii=False):
                probs.append("book 未改")
        elif field == "__sp__":
            if R2_NEW not in back["system_prompt"]:
                probs.append("R2 未改")
        elif field == "__ex17__":
            if "格雷伯爵」这名字真好听" not in back["mes_example"]:
                probs.append("EX17 未改")
        else:
            if new not in (back.get(field) or ""):
                probs.append(f"{field} 未改")
    for w in CRAFT_WORDS:
        blob = json.dumps({k: back.get(k) for k in
                           ("description", "post_history_instructions", "character_book")},
                          ensure_ascii=False)
        if w in blob:
            probs.append(f"进行时口吻残留: {w}")
    print("断言:", "通过" if not probs else "!! " + "; ".join(probs))
    print("\n--- 改后关键行 ---")
    for line in (back.get("description") or "").split("\n"):
        if "职务" in line:
            print("  [description]", line)
    print("  [post_hist]",
          [s for s in (back.get("post_history_instructions") or "").split("；") if "时尚" in s])
    print("  [book]", [e.get("content") for e in
                       (back.get("character_book") or {}).get("entries", [])
                       if "虚拟品牌" in (e.get("content") or "")])


if __name__ == "__main__":
    main()
