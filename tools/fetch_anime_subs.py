#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch_anime_subs.py -- 从 GitHub 字幕库抓动画字幕，抽出中文台词

### 为什么走这条路
用户（2026-10-11）：「git或者论坛上多半是有的罢」

查清的事实：
- 官方**游戏**剧情我们已经拉全了（card/band/event/area/after_live，
  爱音 2248 行 / 爽世 1724 行），Bestdori 是**同源**，只能补新卡。
- **动画完全没有**：MyGO!!!!! 13 集 + Ave Mujica 13 集 + 剧场版 = 官方剧本对白，
  语域比游戏自然（游戏受 Live2D 演出限制，句子短促、信息量低）。

### 来源（已核实可访问）
GitHub `foxofice/sub_share`（**字幕共享计划**，1607★）：
    subs_list/animation/2023/(2023.6.29)BanG Dream! It's MyGO!!!!!/BD/喵萌字幕组/sc/
      [Nekomoe kissaten] BanG Dream! It’s MyGO!!!!! [01..13][Web].JPSC.ass
- 喵萌字幕组（Nekomoe kissaten）**全 13 集简体中文**，另有 `tc` 繁体
- ⚠ 多数集文件 12.6 MB —— 不是台词多，是**特效字幕**（卡拉OK/矢量绘图）撑大的。
  只保留 `[Script Info]` / `[V4+ Styles]` / `[Events]` 里的 Dialogue 行就能瘦下来。
- ⚠ **Ave Mujica 不在这个库里**（2025 目录只有 6 部，没有它）⇒ 需要另找来源。

### 字幕里的轨道
`JPSC` = 日语 + 简体中文双语，样式名可以区分：
    Dial_JP / Dial_CH   ← 正片对白（中日各一份）
    ED_JP / ED_CH       ← 片尾曲
    Screen / Title / Staff / Cmt_CH  ← 画面字、标题、staff、注释
⇒ **只要 `Dial_CH`**，其余全是噪音。

### ⚠ 最大的坑：字幕**没有说话人标注**
`.ass` 只有样式，没有"这句是谁说的"。所以抽出来的只是**台词流**，
要变成 `(对手 → 回应)` 二元组必须**先做说话人归属**（下一步）。
本脚本只负责把干净的台词流取下来，属归属的输入。

### 用法
    python fetch_anime_subs.py fetch            # 下载并瘦身（默认 MyGO 13 集）
    python fetch_anime_subs.py fetch --limit 2  # 只下前两集试
    python fetch_anime_subs.py parse            # 统计抽取量 + 打印样本
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(os.path.dirname(HERE), "_corpus_tmp", "subs")
REPO = "foxofice/sub_share"
MYGO_DIR = ("subs_list/animation/2023/(2023.6.29)BanG Dream! It's MyGO!!!!!"
            "/BD/喵萌字幕组/sc")

# 要保留的段落（其余整段丢掉：特效脚本、字体、图形都是体积大户）
KEEP_SECTIONS = ("[Script Info]", "[V4+ Styles]", "[V4+ Styles+]", "[Events]")
# 只要正片中文对白
DIALOGUE_STYLES = ("Dial_CH", "Dial_CH2")


def fetch_file_bytes(sha: str, path: str, retries: int = 4) -> bytes:
    """取字幕文件原始字节。

    🔴 `contents` API 对 **>1 MB 的文件会返回空 `content`**
    （`encoding: "none"`），第一版就是这么静默丢了 11 集（那些 12.6 MB 的特效字幕）。
    ⇒ 走 Git Blobs API（按 sha，支持到 100 MB），拿 base64 再解。
    """
    for i in range(retries):
        pr = subprocess.run(["gh", "api", f"repos/{REPO}/git/blobs/{sha}"],
                            capture_output=True, text=True, encoding="utf-8")
        if pr.returncode == 0 and pr.stdout.strip():
            j = json.loads(pr.stdout)
            if j.get("content"):
                return base64.b64decode(j["content"])
        time.sleep(1.5 * (i + 1))
    # 兜底：raw.githubusercontent（不需要 token）
    import urllib.parse
    import urllib.request
    url = ("https://raw.githubusercontent.com/" + REPO + "/HEAD/"
           + urllib.parse.quote(path))
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def gh_api(path: str, retries: int = 4):
    for i in range(retries):
        p = subprocess.run(["gh", "api", f"repos/{REPO}/contents/{path}"],
                           capture_output=True, text=True, encoding="utf-8")
        if p.returncode == 0 and p.stdout.strip():
            return json.loads(p.stdout)
        time.sleep(1.2 * (i + 1))
    raise SystemExit(f"!! gh api 拉取失败: {path}")


def slim_ass(text: str) -> str:
    """只留 Script Info / Styles / Events，丢掉特效与字体段。"""
    out, keep = [], False
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("[") and s.endswith("]"):
            keep = s in KEEP_SECTIONS
        if keep:
            out.append(line)
    return "\n".join(out)


def parse_chinese(text: str) -> list[str]:
    """抽正片中文对白（去特效标签、去画面字）。"""
    rows = []
    for line in text.splitlines():
        if not line.startswith("Dialogue:"):
            continue
        b = line.split(",", 9)
        if len(b) < 10:
            continue
        if b[3].strip() not in DIALOGUE_STYLES:
            continue
        txt = re.sub(r"\{[^}]*\}", "", b[9])
        txt = txt.replace("\\N", " ").replace("\\n", " ").strip()
        txt = re.sub(r"\s+", " ", txt)
        if txt:
            rows.append(txt)
    return rows


def cmd_fetch(args):
    os.makedirs(CACHE, exist_ok=True)
    listing = gh_api(MYGO_DIR)
    files = sorted((f for f in listing if f["name"].endswith(".ass")),
                   key=lambda f: f["name"])
    if args.limit:
        files = files[:args.limit]
    print(f"待下 {len(files)} 集 → {CACHE}")
    total_raw = total_slim = 0
    for f in files:
        ep = re.search(r"\[(\d+)\]", f["name"])
        ep = ep.group(1) if ep else f["name"][:8]
        dst = os.path.join(CACHE, f"mygo_{ep}_chs.ass")
        if os.path.exists(dst) and not args.force:
            print(f"   [{ep}] 已存在，跳过")
            continue
        raw = fetch_file_bytes(f["sha"], f"{MYGO_DIR}/{f['name']}")
        text = raw.decode("utf-8-sig", "replace")
        slim = slim_ass(text)
        with open(dst, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(slim)
        lines = parse_chinese(slim)
        total_raw += len(raw)
        total_slim += len(slim.encode("utf-8"))
        print(f"   [{ep}] {len(raw)/1048576:.1f}MB → {len(slim.encode('utf-8'))/1024:.0f}KB  "
              f"中文台词 {len(lines)} 行")
    print(f"\n合计：原始 {total_raw/1048576:.1f} MB → 瘦身 {total_slim/1048576:.2f} MB")


def cmd_parse(args):
    files = sorted(f for f in os.listdir(CACHE) if f.endswith(".ass")) if os.path.isdir(CACHE) else []
    if not files:
        raise SystemExit("!! 还没有字幕，先跑 fetch")
    grand = 0
    for fn in files:
        text = open(os.path.join(CACHE, fn), encoding="utf-8").read()
        lines = parse_chinese(text)
        grand += len(lines)
        print(f"   {fn:24s} {len(lines):5d} 行")
    print(f"\n合计中文台词 {grand} 行")
    # 样本
    text = open(os.path.join(CACHE, files[len(files) // 2]), encoding="utf-8").read()
    lines = parse_chinese(text)
    print(f"\n--- {files[len(files)//2]} 样本（第 40~64 行）---")
    for x in lines[40:64]:
        print("   ", x[:70])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["fetch", "parse"])
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    cmd_fetch(args) if args.cmd == "fetch" else cmd_parse(args)


if __name__ == "__main__":
    main()
