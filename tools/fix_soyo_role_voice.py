#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fix_soyo_role_voice.py -- 素世卡里的「模板词表」——与爱音同型，只是藏在 description

用户 2026-10-10：「还是不太像角色」

实测（humanity_lab 30 条采样，全新会话）：
  素世首字分布：嗯 25% / 你 12% / 我 12% / 在 8%   叹词开头 27%
  ★官方素世（30 条）：叹词开头 **0%**，首字第一是「我」10% / 「不」10%
  另外「你问这个做什么」在某条输入上 **5/5 全部命中**（同一条被复读）

两个根因，都在卡里：

S1. description 的「## 说话细节」里有一条**直接命令她用「嗯」起头**：
      "- 口癖：常以「嗯」起头；反问用「是吗」「你觉得呢」；…"
   这与爱音卡的「开头爱用叹词：哇 欸 诶 誒」是**完全同一个 bug**，
   只是换了个字段藏。官方语料里 0%，所以这句陈述本身也是错的。

S2. 同段里把「你问这个做什么」写成了**固定第一步**：
      "- 被追问到不想回答时，顺序是：先反问（你问这个做什么）→ 再沉默或转移…"
   ⇒ 模型照抄这个固定句式（5/5）。策略可以留，**台词不能写死**。

S3. system_prompt 规则 8 里列了一串范词：
      "甚至可以只回「啊」「哦」「嗯」「？」「随你」这类"
   与 S1 同类：**列举出来的词会被当模板用**。意图（短回复/可以不接）要留，
   词表要去掉。

用法:
  python fix_soyo_role_voice.py --check
  python fix_soyo_role_voice.py --dry
  python fix_soyo_role_voice.py
  python fix_soyo_role_voice.py --revert
"""
import argparse
import json
import os
import pathlib
import shutil
import struct
import sys
import time
import zlib
import base64

sys.stdout.reconfigure(encoding="utf-8")

CARD = r"C:\Users\20633\MimirLink-soyo\data\characters\Soyo_Nagasaki.png"

# ------------------------------------------------------------------ S1+S2
D_OLD_1 = "- 口癖：常以「嗯」起头；反问用「是吗」「你觉得呢」；不认同时不直接反驳，而是「这样啊」然后说别的。"
D_NEW_1 = ("- 口癖：句子短，一两句说完就停；爱用反问把话推回去（是吗、你觉得呢）；"
           "不认同时不直接反驳，先应一声然后说别的。**别固定用同一个词起头。**")

D_OLD_2 = ("- 被追问到不想回答时，顺序是：先反问（你问这个做什么）→ 再沉默或转移（先不说这个）"
           "→ 实在躲不过才说实话，而且只说一句。")
D_NEW_2 = ("- 被追问到不想回答时：先反问一句把问题推回去 → 再沉默或转移话题 → "
           "实在躲不过才说实话，而且只说一句。**每一步都换自己的说法，不要套同一句现成台词。**")

# ------------------------------------------------------------------ S3
SP_OLD = "甚至可以只回「啊」「哦」「嗯」「？」「随你」这类，不想接就不接，话题掉在地上也没关系。"
SP_NEW = "甚至可以只回一两个字，或者干脆不回，不想接就不接，话题掉在地上也没关系。"


# ------------------------------------------------------------------ PNG 读写
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
    idx = []
    for i, (ctype, data) in enumerate(chunks):
        if ctype in (b"tEXt", b"iTXt"):
            kw = data.split(b"\x00", 1)[0].decode("latin-1")
            if kw in ("chara", "ccv3"):
                idx.append(i)
    return idx


def get_fields(path):
    for i in payload_idx(read_chunks(pathlib.Path(path).read_bytes())):
        pass
    chunks = read_chunks(pathlib.Path(path).read_bytes())
    for i in payload_idx(chunks):
        kw, _, val = chunks[i][1].partition(b"\x00")
        obj = json.loads(base64.b64decode(val).decode("utf-8"))
        return obj.get("data") if isinstance(obj.get("data"), dict) else obj
    raise SystemExit("!! no chara/ccv3 chunk")


def put_fields(path, fields, stamp):
    p = pathlib.Path(path)
    bak = p.with_suffix(p.suffix + ".bak-" + stamp + "-soyovoice")
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


def build(desc, sp):
    for tag, text, old in (("S1 口癖", desc, D_OLD_1), ("S2 固定台词", desc, D_OLD_2),
                           ("S3 规则8词表", sp, SP_OLD)):
        n = text.count(old)
        if n != 1:
            return None, None, f"{tag} 锚点命中 {n} 次（应为 1）"
    return (desc.replace(D_OLD_1, D_NEW_1, 1).replace(D_OLD_2, D_NEW_2, 1),
            sp.replace(SP_OLD, SP_NEW, 1), "锚点各 1 次")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()

    f = get_fields(CARD)
    desc, sp = f.get("description", ""), f.get("system_prompt", "")
    print("=" * 74)
    print("soyo 卡模板词表修复")
    print(f"  description {len(desc)}字 | system_prompt {len(sp)}字")
    print(f"  现状：S1={'常以「嗯」起头' not in desc} S2={'固定用同一个词起头' in desc} "
          f"S3={'「啊」「哦」「嗯」' not in sp}")

    if args.revert:
        if D_NEW_1 not in desc or D_NEW_2 not in desc or SP_NEW not in sp:
            print("  !! 找不到新文案，放弃")
            return
        nd = desc.replace(D_NEW_1, D_OLD_1, 1).replace(D_NEW_2, D_OLD_2, 1)
        ns = sp.replace(SP_NEW, SP_OLD, 1)
        ok, info = put_fields(CARD, {"description": nd, "system_prompt": ns},
                              time.strftime("%Y%m%d-%H%M%S"))
        print(f"  {'REVERTED' if ok else '!! ' + info}  {info if ok else ''}")
        return

    nd, ns, rep = build(desc, sp)
    if nd is None:
        print("  !!", rep)
        return
    print(f"  {rep}")
    if args.check:
        return
    if args.dry:
        print(f"  DRY ok  desc {len(desc)}->{len(nd)}  sp {len(sp)}->{len(ns)}")
        return
    ok, info = put_fields(CARD, {"description": nd, "system_prompt": ns},
                          time.strftime("%Y%m%d-%H%M%S"))
    if not ok:
        print("  !!", info)
        return
    print(f"  OK  desc {len(desc)}->{len(nd)}  sp {len(sp)}->{len(ns)}  备份={info}")
    back = get_fields(CARD)
    probs = []
    if "常以「嗯」起头" in back["description"]:
        probs.append("S1 旧句仍在")
    if "你问这个做什么" in back["description"]:
        probs.append("S2 固定台词仍在")
    if "「啊」「哦」「嗯」「？」「随你」" in back["system_prompt"]:
        probs.append("S3 词表仍在")
    print("  断言:", "全部通过" if not probs else "!! " + "; ".join(probs))


if __name__ == "__main__":
    main()
