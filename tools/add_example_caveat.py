#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
add_example_caveat.py -- 在 description 的「台词示例」标题后加一条"别照搬"警告

背景（2026-10-10，从私聊记录里抓到）：
爱音在私聊里说出「反正我每天都在进步」，与 description「## 台词示例」里的
「哼哼，那还用说！我可是每天都在进步的好吧～」几乎是原句。
示例紧挨着诱惑点，光在 system_prompt 里说"别照搬"隔了一层，
在例句标题后面直接写一句最有效。

用法:
  python add_example_caveat.py --check
  python add_example_caveat.py
"""
import argparse
import base64
import json
import shutil
import struct
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

TARGETS = [
    r"C:\Users\20633\MimirLink\data\characters\Anon_Chihaya.png",
    r"C:\Users\20633\MimirLink-soyo\data\characters\Soyo_Nagasaki.png",
]

OLD = "## 台词示例（按情绪分组。前三条出自原著，后三条出自卡作者示例）\n"
NEW = ("## 台词示例（按情绪分组。前三条出自原著，后三条出自卡作者示例）\n"
       "（下面这些句子只是让你摸情绪的，不是给你背的。原句一个字都不要照搬，"
       "也不要模仿它们的长度和标点——你发出去的话按上面的打字口吻来。）\n")

MARK = "不是给你背的"


def read_card(path):
    raw = open(path, "rb").read()
    pos, card, key = 8, None, None
    while pos < len(raw):
        (ln,) = struct.unpack(">I", raw[pos:pos + 4])
        ct = raw[pos + 4:pos + 8]
        data = raw[pos + 8:pos + 8 + ln]
        if ct == b"tEXt":
            k, _, v = data.partition(b"\x00")
            if k.decode("latin-1") == "chara":
                card = json.loads(base64.b64decode(v).decode("utf-8"))
        pos += 12 + ln
    src = card.get("data") if isinstance(card.get("data"), dict) else card
    return src


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    for path in TARGETS:
        print("=" * 70)
        print(path)
        try:
            src = read_card(path)
        except Exception as e:
            print("  !! 读取失败:", e)
            continue
        d = src.get("description", "") or ""
        has = MARK in d
        idx = d.find("## 台词示例")
        if args.check:
            print(f"  警告已存在={has}  例句段位置={idx}  description={len(d)} 字")
            continue
        if has:
            print("  -- 已加过，跳过")
            continue
        if idx < 0:
            print("  !! 找不到「## 台词示例」段落，跳过")
            continue
        if d.count(OLD) != 1:
            print(f"  !! 锚点命中 {d.count(OLD)} 次（应为 1）")
            continue
        payload = {"description": d.replace(OLD, NEW, 1)}
        tmp = "_desc_caveat.json"
        json.dump(payload, open(tmp, "w", encoding="utf-8"), ensure_ascii=False)
        r = subprocess.run(
            [sys.executable, "set_card_fields.py", "--card", path, "--json", tmp],
            capture_output=True, text=True)
        print("  " + (r.stdout or r.stderr).strip().replace("\n", "\n  ")[-400:])
        after = read_card(path).get("description", "")
        print(f"  read-back: 警告={MARK in after}  description {len(d)} -> {len(after)} 字")


if __name__ == "__main__":
    main()
