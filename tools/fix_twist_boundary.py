#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fix_twist_boundary.py -- 把「拧巴」的边界改成**机械判据**（用户报"容易编东西"）

问题（我自己造的）：
  规则 18 说「先收掉 → 紧接着漏一句真心话」，并给了范例
  「……你们几点结束 / ……明天记得吃饭 / ……我早就知道了 / ……本来还想着你能来」。
  实测她把它扩展成了**凭空捏造自己的行动**：
      「嗯 / 那我自己吃了 / ……东西都买好了」
      「嗯 不去就不去吧 / ……刚把汤热上了」
      「……本来是想煮点东西的」
  ——买过菜、热过汤、想煮东西，这些事**一件都没发生过**。
  从用户角度看这就是"编一些没有的东西"。

第一版边界写的是「只用你手上真有的事」，**不够机械**，模型照样编。
⇒ 改成可判定的判据：**补的那一句里不许出现新的名词**。

用法: python fix_twist_boundary.py --check | (无参) | --revert
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

CARD = pathlib.Path(r"C:\Users\20633\MimirLink-soyo\data\characters\Soyo_Nagasaki.png")

OLD = ("    🔴 **边界：「漏真心」说的是态度和情绪（其实在意、舍不得、早就知道），"
       "不是编事实。**\n"
       "    不能凭空说出对话里没有的东西 —— 没聊过火锅就别提火锅，没约过的事别当发生过。\n"
       "    想表达在意，只用你手上真有的事（对方刚说的、现在几点、刚才那一句），"
       "不要新造一个。不确定的就别说，或者直接问。")

NEW = ("    🔴 **边界：「漏真心」只能补态度和情绪，不能引入新东西。**\n"
       "    判据很机械：**补的那一句里，除了「你」和「我」，不应该出现新的名词** —— "
       "新的食物、新的地方、新的人、新的事、新的安排，全都是编。\n"
       "    可以：……你们几点结束 / ……明天记得吃饭 / ……我早就知道了 / ……随你吧。\n"
       "    想不出不引入新东西的话，就干脆不补这一句 —— 那也比编一个强。")


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
    bak = str(p) + ".bak-" + stamp + "-twistbound"
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
    sp = f["system_prompt"]
    src, dst = (OLD, NEW) if not args.revert else (NEW, OLD)
    n = sp.count(src)
    print(f"锚点命中 {n} 次（应为 1）；已改={'不应该出现新的名词' in sp}")
    if n != 1:
        return
    out = sp.replace(src, dst, 1)
    if args.check:
        print(f"DRY {len(sp)} -> {len(out)}")
        return
    ok, info = put_fields(CARD, {"system_prompt": out}, stamp)
    if not ok:
        print("!!", info)
        return
    back = get_fields(CARD)["system_prompt"]
    key = "不应该出现新的名词" if not args.revert else "说的是态度和情绪"
    print(f"OK {len(sp)}->{len(back)}  断言={'通过' if key in back else '失败'}  备份={info}")


if __name__ == "__main__":
    main()
