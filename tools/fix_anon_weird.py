#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fix_anon_weird.py -- 治爱音「有点怪」的两处（用户 2026-10-10 12:35）

线上原文（12:32-12:34）：
    我 :  你看看大家怎么说的
    爱音: 我才不搜呢! / 搜这个干嘛啊 / …… / 好吧我看了一眼 / 那都是一群坏心眼的家伙 胡说八道!
    我 :  他们说的是实话
    爱音: 真的什么啊 / 那都是角度问题! / …… / 好吧我看了一眼 / 那群人胡说八道
                                                  ↑ 逐字重复   ↑ 几乎重复

两个问题：

1) 🔴 **爱音没有"别复读自己"的规则**，素世有。
   素世 `system_prompt` 规则 19：「不要连着两轮用同一个开头…同一个意思说过一遍就别再说第二遍，
   换个说法或者不接。」
   爱音只有一条**表情包专用**的「别把上一条再说一遍」。⇒ 补一条同款的通用规则。

2) 🔴 **示例里 `……` 单独成一条消息**：
       {{user}}: 立希说你这周又没去排练
       {{char}}: ……
       {{char}}: 去了
       {{char}}: 去了一半
   这正是线上那句的形状（含糊 → 再让步）。
   而「……」独立成条本来是**素世的标记**（官方语料里她 17% 以「…」开头），
   爱音是元气型，用出来就"怪"。
   ⇒ 去掉那一行（保留行内省略号，如 `唔……`，那是自然的）。

用法: python fix_anon_weird.py --check | (无参) | --revert
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

RULE_ANCHOR = ("- 对方说的是同一件事的延续，就接着前面说，别把最后那个词当成新话题。"
               "该回指就回指，像你怎么又来了、我刚才不是说过了吗、你不是刚听完吗。")
RULE_ADD = ("\n- 同一个意思说过一遍就别再说第二遍。对方把同一件事又提一次，"
            "你要么换个说法，要么直接点出来（这个我说过了）—— "
            "**不要把你上一轮那几句话原样再发一遍**，那是复读，不是生气。")

EX_OLD = ("<START>\n{{user}}: 立希说你这周又没去排练\n"
          "{{char}}: ……\n{{char}}: 去了\n{{char}}: 去了一半")
EX_NEW = ("<START>\n{{user}}: 立希说你这周又没去排练\n"
          "{{char}}: 去了\n{{char}}: 去了一半")


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
    bak = str(p) + ".bak-" + stamp + "-anonweird"
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

    print("1) 防复读规则")
    if args.revert:
        if RULE_ADD.strip() in sp:
            ok, info = put_fields(CARD, {"system_prompt": sp.replace(RULE_ADD, "", 1)}, stamp)
            print(f"   REVERTED" if ok else f"   !! {info}")
        else:
            print("   -- 没加过")
    else:
        n = sp.count(RULE_ANCHOR)
        print(f"   锚点={n}  已加={'不要把你上一轮那几句话原样再发一遍' in sp}")
        if n == 1 and "不要把你上一轮那几句话原样再发一遍" not in sp and not args.check:
            ok, info = put_fields(CARD, {"system_prompt": sp.replace(RULE_ANCHOR, RULE_ANCHOR + RULE_ADD, 1)}, stamp)
            print(f"   OK sp {len(sp)}->{len(get_fields(CARD)['system_prompt'])}  备份={info}"
                  if ok else f"   !! {info}")

    print("2) 示例里的「……」单独成条")
    if args.revert:
        print("   -- 跳过（回退需手工恢复）" if EX_NEW not in ex else "   -- 可手工恢复")
    else:
        n = ex.count(EX_OLD)
        print(f"   锚点={n}  已改={'{{char}}: 去了\\n{{char}}: 去了一半' in ex and EX_OLD not in ex}")
        if n == 1 and not args.check:
            ok, info = put_fields(CARD, {"mes_example": ex.replace(EX_OLD, EX_NEW, 1)}, stamp)
            back = get_fields(CARD)["mes_example"]
            print(f"   OK ex {len(ex)}->{len(back)}  断言={'通过' if EX_OLD not in back and EX_NEW in back else '失败'}  备份={info}"
                  if ok else f"   !! {info}")

    if args.check:
        print("(--check 只报告，未写入)")


if __name__ == "__main__":
    main()
