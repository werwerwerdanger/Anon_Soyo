#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_official_corpus.py -- 从官方剧情文本库抽取「按角色分」的台词语料

数据源：GitHub `ci-ke/BangDream-story` 的 `story_cn/`（官方游戏剧情中文文本，
       每 1-2 天自动同步；实测 26938 文件 / 44.8MB，story_cn 下 6767 个 txt）
       克隆方式必须是 SSH（本机 github.com:443 被封，:22 通）：
         git clone --depth 1 --filter=blob:none --sparse git@github.com:ci-ke/BangDream-story.git
         git sparse-checkout set story_cn

文件格式：
    <id> <标题>
    （登场角色：千早爱音、长崎爽世）
    爱音：Soyorin好厉害！观众都嗨起来了！
    爽世：谢谢。这是勤加练习的成果吧

⚠ 官方中文译名是「**爽世**」，不是「素世」。两个都要收，但要记下这个差异。

为什么需要它：原来的 `_anon_official_lines.txt` / `_soyo_official_lines.txt` 只有
39 / 30 条，而且是「名场面选集」——样本小 + 有偏（偏夸张台词）。
拿它当语气尺子，置信区间宽到没法用。

用法:
  python build_official_corpus.py --root <story_cn 路径> [--out-dir .]
"""
import argparse
import collections
import io
import os
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

# 官方译名 → 我们的角色键
ALIAS = {
    "爱音": "anon", "千早爱音": "anon", "アノン": "anon",
    "爽世": "soyo", "素世": "soyo", "长崎爽世": "soyo", "长崎素世": "soyo",
    "そよ": "soyo", "長崎そよ": "soyo", "Soyorin": "soyo",
}
SPEAKER_RE = re.compile(r"^([^：:]{1,12})[：:]\s*(.+)$")
# 讲解/旁白行（没有角色名前缀）
NARRATION_HINT = re.compile(r"^[（(【\[]")


def clean(s):
    s = s.strip()
    s = re.sub(r"\s+", " ", s)
    return s


def iter_lines(path):
    """产出 (speaker_or_None, text)。跳过标题/角色表/空行。"""
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for raw in f:
            ln = raw.strip()
            if not ln:
                continue
            if NARRATION_HINT.match(ln):
                continue          # （登场角色：…）之类的舞台指示
            m = SPEAKER_RE.match(ln)
            if not m:
                yield None, clean(ln)
                continue
            sp, tx = m.group(1).strip(), clean(m.group(2))
            if not tx:
                continue
            yield sp, tx


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True, help="story_cn 目录")
    ap.add_argument("--out-dir", default=".")
    ap.add_argument("--min-len", type=int, default=1)
    ap.add_argument("--max-len", type=int, default=80,
                    help="超长台词多为剧情独白，与聊天语气无关，剔除")
    args = ap.parse_args()

    buckets = collections.defaultdict(list)
    speakers = collections.Counter()
    cat_count = collections.Counter()
    files = 0

    # ⚠ 必须递归：band/ card/ event/ 下面还有一层子目录
    #   （card 甚至按角色分，如 `card/01 PPP_户山香澄/`）
    #   第一版只走一层 ⇒ 漏掉 band/card/event 共 4612 个文件，只剩 2155 个。
    for dirpath, _dirnames, filenames in os.walk(args.root):
        rel = os.path.relpath(dirpath, args.root)
        cat = rel.split(os.sep)[0]
        for name in sorted(filenames):
            if not name.endswith(".txt"):
                continue
            files += 1
            cat_count[cat] += 1
            for sp, tx in iter_lines(os.path.join(dirpath, name)):
                if sp is None:
                    continue
                speakers[sp] += 1
                key = ALIAS.get(sp)
                if not key:
                    continue
                if not (args.min_len <= len(tx) <= args.max_len):
                    continue
                buckets[key].append(tx)

    print(f"扫描文件 {files} 个  分类 {dict(cat_count)}")
    print(f"语料：anon {len(buckets['anon'])} 条   soyo {len(buckets['soyo'])} 条")
    print(f"出现过的说话人 {len(speakers)} 个，前 25：")
    for k, v in speakers.most_common(25):
        tag = f" -> {ALIAS[k]}" if k in ALIAS else ""
        print(f"   {k:<14} {v:>6}{tag}")

    for key in ("anon", "soyo"):
        rows = buckets[key]
        seen, uniq = set(), []
        for r in rows:
            if r in seen:
                continue
            seen.add(r)
            uniq.append(r)
        out = os.path.join(args.out_dir, f"_{key}_official_lines.txt")
        header = (f"# 官方台词语料（自动生成，勿手改）\n"
                  f"# 源：GitHub ci-ke/BangDream-story  story_cn/（官方游戏剧情中文文本）\n"
                  f"# 抽取：speaker == {('爱音' if key=='anon' else '爽世/素世')}，"
                  f"长度 {args.min_len}-{args.max_len} 字，去重\n"
                  f"# 共 {len(uniq)} 条（原始 {len(rows)} 条）\n")
        with open(out, "w", encoding="utf-8") as f:
            f.write(header)
            f.write("\n".join(uniq) + "\n")
        print(f"  -> {out}  {len(uniq)} 条")


if __name__ == "__main__":
    main()
