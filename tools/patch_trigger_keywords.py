#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_trigger_keywords.py -- 群聊关键词：收紧成「自己 + 自己的别称」，并修掉误命中

用户 2026-10-10：「群聊关键字只设置成自己和自己的别称」

审计现状（`chat.triggerKeywords`）：
  anon: 爱音 / 千早爱音 / 爱音酱 / Anon / **anon** / Ano-chan
  soyo: 素世 / 长崎素世 / 素世酱 / Soyorin / Soyo / **soyo** / そよ
两个列表其实**已经全是自称**，但有两个真问题：

1. 🔴 **`matchesKeywords` 是朴素子串匹配**（大小写敏感）：
       keywords.some((k) => k && text.includes(k))
   小写 `anon` 会在 `canon`（卡农）、`anonymous` 里命中；`soyo` 同理。
   ⇒ 修成「ASCII 关键词按词边界匹配，CJK 保持子串」——
     这样小写形式能保留，又不会误命中。

2. 🔴 **缺官方译名**：官方游戏中文把 長崎そよ 译作「**爽世**」，
   不是「素世」（见 `_soyo_official_lines.txt` 的来源，6767 个官方剧情文件）。
   群里有人写「爽世」她现在**不会回**。
   ⇒ 补 爽世 / 长崎爽世。
   同理给 anon 补片假名「アノン」。

顺带删掉真·非自称项（如果有）。**列表项只保留：本名 / 全名 / 昵称。**

用法: python patch_trigger_keywords.py --check | --dry | (无参) | --revert
"""
import argparse
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import time

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

NODE = r"C:\Program Files\nodejs\node.exe"
ROOTS = [pathlib.Path(r"C:\Users\20633") / n for n in ("MimirLink", "MimirLink-soyo")]

MARK = "// >>> keyword-boundary patch >>>"
MARK_E = "// <<< keyword-boundary patch <<<"

MK_OLD = """function matchesKeywords(text, keywords = []) {
    if (!text) {
        return false;
    }

    return keywords.some((keyword) => keyword && text.includes(keyword));
}"""

MK_NEW = """function matchesKeywords(text, keywords = []) {
    if (!text) {
        return false;
    }

    // >>> keyword-boundary patch >>>
    // 用户 2026-10-10：「群聊关键字只设置成自己和自己的别称」。
    // 原文是朴素 `text.includes(keyword)`（大小写敏感）⇒ 小写 `anon` 会在
    // `canon` / `anonymous` 里命中，`soyo` 同理。
    // 规则：**纯 ASCII 关键词按词边界匹配**（大小写不敏感），CJK 保持子串
    //（中文没有词边界，且「素世」出现在「长崎素世」里本来就该命中）。
    return keywords.some((keyword) => {
        if (!keyword) {
            return false;
        }
        const kw = String(keyword);
        if (/^[\\x20-\\x7E]+$/.test(kw)) {
            const esc = kw.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');
            return new RegExp(`(^|[^A-Za-z0-9_])${esc}($|[^A-Za-z0-9_])`, 'i').test(text);
        }
        return text.includes(kw);
    });
    // <<< keyword-boundary patch <<<
}"""

# 关键词表：只放「本名 / 全名 / 昵称」
KEYWORDS = {
    "MimirLink": ["爱音", "千早爱音", "爱音酱", "Anon", "anon", "Ano-chan", "アノン"],
    "MimirLink-soyo": ["素世", "爽世", "长崎素世", "长崎爽世", "素世酱", "Soyorin", "Soyo", "soyo", "そよ"],
}


def node_check(p):
    try:
        r = subprocess.run([NODE, "--check", p], capture_output=True, text=True, timeout=60)
        return r.returncode == 0, (r.stderr or "").strip()
    except Exception as e:
        return False, str(e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()
    dry = args.dry or args.check          # ⚠ --check 必须先折进 dry
    rev = args.revert
    stamp = time.strftime("%Y%m%d-%H%M%S")

    for root in ROOTS:
        name = root.name
        print("=" * 76)
        print(name)

        # ---- 1) matchesKeywords
        p = root / "src" / "index.js"
        src = p.read_text(encoding="utf-8")
        # a = 替换成什么，b = 找什么。⚠ 这个三元式我已经写反过三次：
        #   正向 patch 要 `replace(old, new)` ⇒ 非 revert 时 a=new, b=old。
        a, b = (MK_NEW, MK_OLD) if not rev else (MK_OLD, MK_NEW)
        if MARK in src and not rev:
            print("  1) matchesKeywords  -- 已打过")
        elif b not in src:
            print("  1) matchesKeywords  -- 锚点未命中")
        else:
            out = src.replace(b, a, 1)
            if dry:
                print(f"  1) matchesKeywords  DRY {len(src)} -> {len(out)}")
            else:
                bak = str(p) + ".bak-" + stamp + "-kwbound"
                shutil.copy2(p, bak)
                p.write_text(out, encoding="utf-8", newline="")
                ok, err = node_check(str(p))
                if not ok:
                    shutil.copy2(bak, p)
                    print(f"  1) !! 语法失败已还原: {err[:150]}")
                else:
                    after = p.read_text(encoding="utf-8")
                    want = "keyword-boundary patch" if not rev else None
                    print(f"  1) OK {len(src)}->{len(out)}  断言={'通过' if (want is None or want in after) else '失败'}"
                          f"  备份={os.path.basename(bak)}")

        # ---- 2) 关键词表
        cp = root / "config.json"
        raw = cp.read_text(encoding="utf-8")
        obj = json.loads(raw)
        chat = obj.setdefault("chat", {})
        old_kw = list(chat.get("triggerKeywords") or [])
        want_kw = KEYWORDS[name]
        if rev:
            print(f"  2) 关键词  -- 跳过（回退需手工指定旧表，旧值：{old_kw}）")
            continue
        if old_kw == want_kw:
            print(f"  2) 关键词  -- 已是目标值 {want_kw}")
            continue
        if dry:
            print(f"  2) 关键词  DRY {old_kw} -> {want_kw}")
            continue
        chat["triggerKeywords"] = want_kw
        bak = str(cp) + ".bak-" + stamp + "-kw"
        shutil.copy2(cp, bak)
        cp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
        back = json.loads(cp.read_text(encoding="utf-8"))["chat"]["triggerKeywords"]
        if back != want_kw:
            shutil.copy2(bak, cp)
            print("  2) !! 回读不符已还原")
        else:
            removed = [k for k in old_kw if k not in want_kw]
            added = [k for k in want_kw if k not in old_kw]
            print(f"  2) OK 删除={removed}  新增={added}  备份={os.path.basename(bak)}")

    if args.check:
        print("\n(--check 只报告，未写入)")


if __name__ == "__main__":
    main()
