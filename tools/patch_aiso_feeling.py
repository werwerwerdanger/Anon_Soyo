#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_aiso_feeling.py
给爱音的世界书补上「爱素」的核心口径。用户口径（2026-10-12）：

    爱音很聪明 → 看得出来素世在闹 → 故意去逗她
    素世这套挑毛病只对爱音用 → 爱音乐意被这样对待

要替换掉的那句是**我上一轮写坏的**：
    「不认同就当场反驳，话说得客气又挑不出毛病，行动上却从不违抗。
      她的态度都是从嘴里出来的 —— 不高兴的时候，出口的是一句格外客气的话。」
    ⇒ "情绪 + 客气" 被写实了 ⇒ 模型把它锁死成"冷淡"（实测她说了「我发十条才回一个嗯」）

覆盖两个实例、两个文件名变体（带空格 / 带下划线），幂等，带 --revert。
"""
import argparse
import glob
import io
import json
import os
import sys

HOME = os.path.expanduser('~')

# 两个实例各有一份（实测内容不同），都得改
BASES = [
    os.path.join(HOME, 'MimirLink', 'data', 'worlds'),
    os.path.join(HOME, 'MimirLink-soyo', 'data', 'worlds'),
]

# 爱音世界书里素世那条的定位锚（只要含这个就是那条）
ENTRY_MARK = '长崎素世（ながさき そよ / Nagasaki Soyo）是乐队的贝斯手'

# 我方新写法
PREFIX = '乐队重组后，素世对爱音'
NEW = (
    '有点像「傲娇」：爱音的提议她当场就反驳，话里挑得出毛病，人却每次都到了。'
    '她答应事的句式是从反面来的 —— 「我没说不去」那种，说完人已经跟上。'
    '这套只对爱音用，对别人她客气得很。爱音早就看出来了，所以常故意去逗她：'
    '明知道她会说什么还要问一遍，就等着看她怎么接。'
    '被这么对付，爱音是乐意的 —— 这是只给她一份的待遇。'
)

# 两种"待替换"的旧收尾：① 原始卡里的；② 我上一轮写坏的
OLD_TAILS = [
    '变得有点像「傲娇」：常摆出嫌弃的表情、反驳爱音的提议，行动上却从不违抗。',
    '变得有点像「傲娇」：不认同就当场反驳，话说得客气又挑不出毛病，行动上却从不违抗。'
    '她的态度都是从嘴里出来的 —— 不高兴的时候，出口的是一句格外客气的话。',
]

NEW_FULL = PREFIX + NEW
OLD_FULLS = [PREFIX + t for t in OLD_TAILS]


def read(p):
    with io.open(p, 'r', encoding='utf-8') as fh:
        return fh.read()


def write(p, t):
    with io.open(p, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(t)


def process(path, revert):
    name = os.path.relpath(path, HOME)
    text = read(path)
    if ENTRY_MARK not in text:
        print('  %-58s 没有素世条目，跳过' % name)
        return True

    if revert:
        if NEW_FULL not in text:
            print('  %-58s 没有新文本，跳过' % name)
            return True
        write(path, text.replace(NEW_FULL, OLD_FULLS[1], 1))
        print('  %-58s reverted' % name)
        return True

    if NEW_FULL in text:
        print('  %-58s already' % name)
        return True

    # 找到旧版本（两种都可能），要求**恰好命中一种、且只一次**
    hits = [(t, text.count(t)) for t in OLD_FULLS if text.count(t) > 0]
    if not hits:
        print('  %-58s !! 找不到可替换的旧文本（锚点漂了？），没动' % name)
        return False
    tail, n = hits[0]
    if n != 1:
        print('  %-58s !! 旧文本命中 %d 次，没动' % (name, n))
        return False

    write(path, text.replace(tail, NEW_FULL, 1))
    # 回读校验：JSON 还能解析 + 新句在里面 + 旧句没了
    try:
        json.loads(read(path))
    except Exception as exc:
        print('  %-58s !! 改完 JSON 解析失败，回滚: %s' % (name, exc))
        write(path, text)
        return False
    ok = NEW_FULL in read(path) and tail not in read(path)
    print('  %-58s %s' % (name, 'patched ✓' if ok else '!! 校验不过'))
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--revert', action='store_true')
    args = ap.parse_args()

    files = []
    for b in BASES:
        files += sorted(glob.glob(os.path.join(b, "Anon*Chihaya's Lorebook.json")))
    if not files:
        print('一个都没找到，检查路径')
        return 1

    print('=== 目标文件 %d 个 ===' % len(files))
    ok = True
    for f in files:
        ok = process(f, args.revert) and ok
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
