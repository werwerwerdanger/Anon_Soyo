#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fix_bare_sticker_repeat2.py -- 去掉上一版我自己造的新模板「嗯?」

上一版（fix_bare_sticker_repeat.py）修好了复读，但实测 9/9 里
anon 有 7 条是「嗯?」、soyo 也是清一色「嗯」。
原因：规则里我写了**范词表**「（嗯、哈、哦、？）」—— 第一个词又被当模板用。
（这已经是本项目第 N 次栽在"列举范词 ⇒ 模型收敛到第一个"上：
  爱音的「开头爱用叹词：哇 欸 诶 誒」、素世的「常以『嗯』起头」、
  素世规则 8 的「「啊」「哦」「嗯」「？」「随你」」、爱音的「你最常拿诶和啊开头」。）

修法：**删掉词表**，只留硬约束（不要复读、不要硬找话题），
让两卡各自的示例去决定语气（爱音的示例是「哈」，素世是「嗯」）。

用法: python fix_bare_sticker_repeat2.py --check | --dry | (无参) | --revert
"""
import argparse
import base64
import io
import json
import os
import pathlib
import shutil
import struct
import subprocess
import sys
import time
import zlib

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

SRC_DIRS = [r"C:\Users\20633\MimirLink\src", r"C:\Users\20633\MimirLink-soyo\src"]
ANON_CARD = r"C:\Users\20633\MimirLink\data\characters\Anon_Chihaya.png"
SOYO_CARD = r"C:\Users\20633\MimirLink-soyo\data\characters\Soyo_Nagasaki.png"

# JS
JS_OLD = ("        warnings.push('默认不用管表情包，不要提它、不要描述画面、不要念图上的字。'\n"
          "            + '图里还带了文字就只答那些文字；整条消息只有一张图、没有文字的时候，'\n"
          "            + '不要重复你上一条说过的话 —— 回一两个字的反应就行（嗯、哈、哦、？），'\n"
          "            + '也可以干脆不回。只有对方明确让你看图、或问你图里是什么时才看图');")
JS_NEW = ("        // 词表会变成模板（实测 anon 7/9 都是「嗯?」）⇒ 只留硬约束，语气交给示例。\n"
          "        warnings.push('默认不用管表情包，不要提它、不要描述画面、不要念图上的字。'\n"
          "            + '图里还带了文字就只答那些文字；整条消息只有一张图、没有文字的时候，'\n"
          "            + '不要重复你上一条说过的话，也不要硬找话题接 —— 随手应一声，或者干脆不回。'\n"
          "            + '只有对方明确让你看图、或问你图里是什么时才看图');")

# 卡片
ANON_TAIL_OLD = ("整条消息只有一张图、没有文字的时候：回一两个字的反应就行（嗯、哈、哦、？），"
                 "也可以什么都不说，但**千万别把你上一条说过的话再说一遍**。")
ANON_TAIL_NEW = ("整条消息只有一张图、没有文字的时候：**千万别把你上一条说过的话再说一遍**，"
                 "也不用硬找话题接 —— 随手应一声就行，或者什么都不说。")

SOYO_TAIL_OLD = ("整条消息只有一张图、没有文字的时候：回一两个字就行（嗯、？），"
                 "也可以不回，但不要把你上一条说过的话再说一遍。")
SOYO_TAIL_NEW = ("整条消息只有一张图、没有文字的时候：不要把你上一条说过的话再说一遍，"
                 "也不用硬找话题接 —— 随手应一声就行，或者不回。")


def node_check(p):
    try:
        r = subprocess.run(["node", "--check", p], capture_output=True, text=True, timeout=60)
        return r.returncode == 0, (r.stderr or "").strip()
    except Exception as e:
        return False, str(e)


def read_chunks(raw):
    out, pos = [], 8
    while pos < len(raw):
        (ln,) = struct.unpack(">I", raw[pos:pos + 4])
        out.append((raw[pos + 4:pos + 8], raw[pos + 8:pos + 8 + ln]))
        pos += 12 + ln
    return out


def write_chunks(chunks):
    out = [b"\x89PNG\r\n\x1a\n"]
    for ctype, data in chunks:
        out.append(struct.pack(">I", len(data)))
        out.append(ctype)
        out.append(data)
        out.append(struct.pack(">I", zlib.crc32(ctype + data) & 0xFFFFFFFF))
    return b"".join(out)


def payload_idx(chunks):
    r = []
    for i, (ctype, data) in enumerate(chunks):
        if ctype in (b"tEXt", b"iTXt"):
            kw = data.split(b"\x00", 1)[0].decode("latin-1")
            if kw in ("chara", "ccv3"):
                r.append(i)
    return r


def get_fields(path):
    chunks = read_chunks(pathlib.Path(path).read_bytes())
    for i in payload_idx(chunks):
        kw, _, val = chunks[i][1].partition(b"\x00")
        obj = json.loads(base64.b64decode(val).decode("utf-8"))
        return obj.get("data") if isinstance(obj.get("data"), dict) else obj
    raise SystemExit("!! no chunk")


def put_fields(path, fields, stamp):
    p = pathlib.Path(path)
    bak = p.with_suffix(p.suffix + ".bak-" + stamp + "-baresticker2")
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
        return False, "chunk 清单变了"
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
    # ⚠ --check 必须在这里就折进 dry，绝不能等到写盘之后再判断（栽过两次）
    dry = args.dry or args.check

    print("=" * 74)
    print("1) JS 注意行")
    for d in SRC_DIRS:
        p = os.path.join(d, "current-message-focus.js")
        src = open(p, encoding="utf-8").read()
        old, new = (JS_NEW, JS_OLD) if args.revert else (JS_OLD, JS_NEW)
        if args.revert and JS_NEW not in src:
            print(f"  {p}\n    -- 没打过 v2，跳过")
            continue
        if not args.revert and JS_OLD not in src:
            print(f"  {p}\n    -- 没找到 v1 文案（可能已改）")
            continue
        out = src.replace(old, new, 1)
        if dry:
            print(f"  {p}\n    DRY {len(src)} -> {len(out)}")
            continue
        bak = p + ".bak-" + stamp + "-baresticker2"
        shutil.copy2(p, bak)
        open(p, "w", encoding="utf-8", newline="").write(out)
        ok, err = node_check(p)
        if not ok:
            shutil.copy2(bak, p)
            print(f"  {p}\n    !! node --check 失败已还原: {err[:160]}")
            continue
        after = open(p, encoding="utf-8").read()
        want = "也不要硬找话题接" if not args.revert else "回一两个字的反应就行"
        print(f"  {p}\n    OK {len(src)}->{len(out)}  断言={'通过' if want in after else '失败'}")

    print("=" * 74)
    for name, card, o, n in (("anon", ANON_CARD, ANON_TAIL_OLD, ANON_TAIL_NEW),
                             ("soyo", SOYO_CARD, SOYO_TAIL_OLD, SOYO_TAIL_NEW)):
        f = get_fields(card)
        sp = f["system_prompt"]
        old, new = (n, o) if args.revert else (o, n)
        print(f"2) {name} 卡")
        if old not in sp:
            print("    -- 没找到锚点（可能已改）")
            continue
        ns = sp.replace(old, new, 1)
        if dry:
            print(f"    DRY {len(sp)} -> {len(ns)}")
            continue
        ok, i = put_fields(card, {"system_prompt": ns}, stamp)
        print(f"    OK {len(sp)}->{len(ns)}  备份={i}" if ok else f"    !! {i}")

    if args.check:
        print("(--check 只报告，未写入任何文件)")


if __name__ == "__main__":
    main()
