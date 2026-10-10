#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fix_role_fingerprint2.py -- 收尾两处

1) 🔴 爱音：我自己造的新模板
   上一版我写的规则是「**你最常**拿『诶』和『啊』开头（诶 这样啊 / 啊 对哦）」。
   实测（temp=0.8，排除采样因素）：输入「算了 不想聊了」时
   **5/5 全部以「诶」开头**（诶 怎么突然就不聊了 ×2 / 诶 怎么突然 / 诶 这就走了?）。
   —— 与「开头爱用叹词：哇 欸 诶 誒」是**同一个错误**：把统计描述写成了频率指令。
   官方语料里「诶」「啊」各只占 8%，不是"最常"。
   ⇒ 去掉"最常"和行内例句，只留"别连着用同一个字"。

2) 爽世：指纹落地不足（示例量不够）
   实测「小X」6%（官方 20%）、「……」开头 2%（官方 17.6%）。
   原因符合本项目既有铁律 **指令 < 示例**：我只在 description 加了两条规则、
   示例只加了 3 个 block（总共 24 个）。这次再补 4 个 block，
   让「小X」和「……」在示例里的占比接近官方水平。

用法: python fix_role_fingerprint2.py --check | --dry | (无参) | --revert
"""
import argparse
import base64
import io
import json
import pathlib
import shutil
import struct
import sys
import time
import zlib

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ANON_CARD = r"C:\Users\20633\MimirLink\data\characters\Anon_Chihaya.png"
SOYO_CARD = r"C:\Users\20633\MimirLink-soyo\data\characters\Soyo_Nagasaki.png"

ANON_SP_OLD = ("- 起头别老用同一个字：你最常拿「诶」和「啊」开头（诶 这样啊 / 啊 对哦），"
               "偶尔换「唔」「咦」「嗯」；也可以什么都不带、直接接住对方说的往下聊，"
               "或者从自己的事说起（我刚才…、我昨天…）。同一段对话里连着几条都用同一个字起头会很假。")
ANON_SP_NEW = ("- 同一段对话里，连着几条别用同一个字起头。诶、啊、唔、咦、嗯 都行，"
               "也完全可以什么都不带直接接话，或者从自己的事说起（我刚才…、我昨天…）。"
               "起头老是同一个字，一眼就看出不是人在打字。")

SOYO_EX_TAIL = "{{char}}: ……你也别太往心里去"
SOYO_EX_ADD = """
<START>
{{user}}: 这周末乐队要排练吗
{{char}}: 小立希说要
{{char}}: ……不过她那脾气 说不准
<START>
{{user}}: 演出服的图你看了吗
{{char}}: 看了
{{char}}: ……小爱音这次倒是认真了
<START>
{{user}}: 灯今天没来
{{char}}: 小灯家里有事
{{char}}: ……她那个人 不用问也会自己说的
<START>
{{user}}: 睦最近怎么样
{{char}}: 还行吧
{{char}}: ……你还是别去打扰小睦了
"""


def read_chunks(raw):
    chunks, pos = [], 8
    while pos < len(raw):
        (ln,) = struct.unpack(">I", raw[pos:pos + 4])
        chunks.append((raw[pos + 4:pos + 8], raw[pos + 8:pos + 8 + ln]))
        pos += 12 + ln
    return chunks


def write_chunks(chunks):
    out = [b"\x89PNG\r\n\x1a\n"]
    for ctype, data in chunks:
        out.append(struct.pack(">I", len(data)))
        out.append(ctype)
        out.append(data)
        out.append(struct.pack(">I", zlib.crc32(ctype + data) & 0xFFFFFFFF))
    return b"".join(out)


def payload_idx(chunks):
    out = []
    for i, (ctype, data) in enumerate(chunks):
        if ctype in (b"tEXt", b"iTXt"):
            kw = data.split(b"\x00", 1)[0].decode("latin-1")
            if kw in ("chara", "ccv3"):
                out.append(i)
    return out


def get_fields(path):
    chunks = read_chunks(pathlib.Path(path).read_bytes())
    for i in payload_idx(chunks):
        kw, _, val = chunks[i][1].partition(b"\x00")
        obj = json.loads(base64.b64decode(val).decode("utf-8"))
        return obj.get("data") if isinstance(obj.get("data"), dict) else obj
    raise SystemExit("!! no chara/ccv3 chunk")


def put_fields(path, fields, stamp):
    p = pathlib.Path(path)
    bak = p.with_suffix(p.suffix + ".bak-" + stamp + "-fingerprint2")
    shutil.copy2(p, bak)
    chunks = read_chunks(p.read_bytes())
    before = [c for c, _ in chunks]
    for i in payload_idx(chunks):
        kw, _, val = chunks[i][1].partition(b"\x00")
        obj = json.loads(base64.b64decode(val).decode("utf-8"))
        target = obj.get("data") if isinstance(obj.get("data"), dict) else obj
        for k, v in fields.items():
            if k in target:
                target[k] = v
        enc = base64.b64encode(json.dumps(obj, ensure_ascii=False).encode("utf-8"))
        chunks[i] = (chunks[i][0], kw + b"\x00" + enc)
    if before != [c for c, _ in chunks]:
        return False, "chunk 清单变了，拒绝写入"
    p.write_bytes(write_chunks(chunks))
    back = get_fields(path)
    for k, v in fields.items():
        if back.get(k) != v:
            shutil.copy2(bak, path)
            return False, f"回读不符: {k}"
    return True, bak.name


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()
    stamp = time.strftime("%Y%m%d-%H%M%S")

    print("=" * 74)
    print("1) anon 去掉'最常'")
    f = get_fields(ANON_CARD)
    sp = f["system_prompt"]
    print(f"   锚点={sp.count(ANON_SP_OLD)}  现状(已改)={ANON_SP_NEW in sp}")
    if args.revert and ANON_SP_NEW in sp:
        ns = sp.replace(ANON_SP_NEW, ANON_SP_OLD, 1)
        ok, info = put_fields(ANON_CARD, {"system_prompt": ns}, stamp)
        print("   REVERTED" if ok else f"   !! {info}")
    elif not args.check and sp.count(ANON_SP_OLD) == 1:
        if args.dry:
            print(f"   DRY ok {len(sp)}->{len(sp.replace(ANON_SP_OLD, ANON_SP_NEW, 1))}")
        else:
            ns = sp.replace(ANON_SP_OLD, ANON_SP_NEW, 1)
            ok, info = put_fields(ANON_CARD, {"system_prompt": ns}, stamp)
            print(f"   OK {len(sp)}->{len(ns)}  备份={info}" if ok else f"   !! {info}")

    print("=" * 74)
    print("2) soyo 补 4 个'小X + ……'示例")
    g = get_fields(SOYO_CARD)
    ex = g["mes_example"]
    print(f"   尾部锚点={ex.count(SOYO_EX_TAIL)}  '小X'block={ex.count('小爱音')}  现状(已改)={'小立希说要' in ex}")
    if args.revert and SOYO_EX_ADD.strip() in ex:
        nex = ex.replace(SOYO_EX_ADD, "", 1)
        ok, info = put_fields(SOYO_CARD, {"mes_example": nex}, stamp)
        print("   REVERTED" if ok else f"   !! {info}")
    elif not args.check and ex.count(SOYO_EX_TAIL) == 1:
        nex = ex.replace(SOYO_EX_TAIL, SOYO_EX_TAIL + SOYO_EX_ADD, 1)
        if args.dry:
            print(f"   DRY ok {len(ex)}->{len(nex)}")
        else:
            ok, info = put_fields(SOYO_CARD, {"mes_example": nex}, stamp)
            if ok:
                back = get_fields(SOYO_CARD)
                hit = sum(1 for k in ("小立希说要", "小爱音这次", "小灯家里", "小睦") if k in back["mes_example"])
                print(f"   OK {len(ex)}->{len(nex)}  备份={info}  新block命中={hit}/4")
            else:
                print(f"   !! {info}")


if __name__ == "__main__":
    main()
