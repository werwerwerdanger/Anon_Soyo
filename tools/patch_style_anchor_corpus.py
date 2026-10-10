#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_style_anchor_corpus.py -- 把两个实例的 `chat.styleAnchor` 换成语料里的真实短句

🔴 这是"grep 自己记得的字段"踩的第 4 次：
    `fix_role_fingerprint.py` 把卡里的「欸」全清了（卡断言通过），
    但装配后的提示词里还剩 1 处「欸」——
    来自 **config.json 的 `chat.styleAnchor`**，由 `patch_style_anchor_config.py`
    注入「注意:」行。改卡 ≠ 改完，配置里还有一路。

原值问题：
  anon: 「语气照这个来——哇!好可爱呀! 完蛋啦~! 欸!忘带钱包了! 大危机!」
        · 4 项里 4 个感叹号 ⇒ 实体上是"感叹号模板"（官方爱音只有 36% 带 !）
        · 「欸」是官方语料里几乎不用的字（欸 187 次 / 诶 12299 次）
  soyo: 「语气照这个来——不要这样。唉，随便你吧。你是来找我吵架的吗。冷静一点。」
        · **4 项全是冲突/防御场景**，等于把她的语气锚死在"吵架模式"。
          官方爽世不是只有这一面。

新值全部取自官方剧情语料（`_anon_official_lines.txt` / `_soyo_official_lines.txt`）：
  anon: 诶，无视我? / 那我吃一颗哦 / 我就是想看到嘛~ / 啊，超可爱!
        （诶 与 啊 各一个开头；! 与 ~ 各一；其余不带标点）
  soyo: ……嗯。今天这样就足够了。 / 偶尔什么也不做也不错吧? /
        你还说挺想吃的呢 真可惜
        （「……」开头 + 反问 + 干燥的关心，不再是清一色冲突）

config.json 是 JSON ⇒ 按项目既有规则用**受限次数文本替换**，
不做 ConvertTo-Json 整体重写（单元素数组会被压成裸对象）。

用法: python patch_style_anchor_corpus.py --check | (无参) | --revert
"""
import argparse
import io
import json
import os
import shutil
import sys
import time

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

TARGETS = {
    "anon": (r"C:\Users\20633\MimirLink\config.json",
             "语气照这个来——哇!好可爱呀! 完蛋啦~! 欸!忘带钱包了! 大危机!",
             "语气照这个来——诶，无视我? 那我吃一颗哦 我就是想看到嘛~ 啊，超可爱!"),
    "soyo": (r"C:\Users\20633\MimirLink-soyo\config.json",
             "语气照这个来——不要这样。唉，随便你吧。你是来找我吵架的吗。冷静一点。",
             "语气照这个来——……嗯。今天这样就足够了。 偶尔什么也不做也不错吧? 你还说挺想吃的呢 真可惜"),
}


def apply(path, old, new, dry=False, revert=False):
    raw = open(path, "r", encoding="utf-8").read()
    src, dst = (new, old) if revert else (old, new)
    n = raw.count(json.dumps(src, ensure_ascii=False)[1:-1])  # JSON 转义后的形态
    if n == 0:
        return f"-- 未命中（可能已改过）"
    if n != 1:
        return f"!! 命中 {n} 次（应为 1）"
    out = raw.replace(json.dumps(src, ensure_ascii=False)[1:-1],
                      json.dumps(dst, ensure_ascii=False)[1:-1], 1)
    # 必须仍是合法 JSON
    try:
        json.loads(out)
    except Exception as e:
        return f"!! 替换后 JSON 不合法: {e}"
    if dry:
        return f"DRY ok {len(raw)} -> {len(out)}"
    bak = path + ".bak-" + time.strftime("%Y%m%d-%H%M%S") + "-anchor"
    shutil.copy2(path, bak)
    open(path, "w", encoding="utf-8", newline="").write(out)
    back = json.load(open(path, encoding="utf-8"))
    got = back.get("chat", {}).get("styleAnchor")
    if got != dst:
        shutil.copy2(bak, path)
        return f"!! 回读不符，已还原（得到 {got!r}）"
    return f"OK {len(raw)} -> {len(out)}  备份={os.path.basename(bak)}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()
    for name, (path, old, new) in TARGETS.items():
        print("=" * 74)
        print(f"{name}  {path}")
        cfg = json.load(open(path, encoding="utf-8"))
        cur = cfg.get("chat", {}).get("styleAnchor")
        print(f"  当前 styleAnchor = {cur!r}")
        if args.check or args.dry:
            print("  ", apply(path, old, new, dry=True, revert=args.revert))
        else:
            print("  ", apply(path, old, new, revert=args.revert))


if __name__ == "__main__":
    main()
