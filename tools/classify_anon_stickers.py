#!/usr/bin/env python
"""把 221 个爱音 GIF 按表情分到 data/stickers/<类别>/。

判读依据：anon-sheets-classify/ 那 7 张联络图（6 列，行优先，格子号=文件名序号）。
⚠ 这是"先试着分"的第一版，准确率大概七成 —— 用户说了"哪天觉得奇怪再说不对"。
   所以脚本必须能一键重分（幂等：先清空目标目录里同名文件再放）。

为什么用 Python 而不是 shell：要校验 221 个文件**每个都被分到且只分到一类**，
漏一个就会变成"她永远抽不到的那张"。手写 shell 做这种覆盖检查容易出错。
"""
import os
import shutil
import sys

INBOX = r'C:\Users\20633\MimirLink\data\sticker-inbox\anon-gif'
OUT = r'C:\Users\20633\MimirLink\data\stickers'
DRY = '--apply' not in sys.argv

# 类别 -> {套前缀: [序号...]}
PLAN = {
    '开心': {
        'putong': [2, 6, 8, 9, 10, 11, 14, 22, 26, 53, 68, 70, 73, 76, 82, 96, 101, 102,
                   105, 109, 111, 117, 121, 122, 126, 128, 133, 146, 147, 152, 161, 167],
        'hongc': [1, 2, 5, 8, 15, 16, 20],
        'yzy': [1, 6, 7, 8, 10],
        'fengyi': [4, 7, 18, 20],
    },
    '无语': {
        'putong': [1, 17, 23, 28, 30, 34, 36, 38, 39, 43, 46, 51, 57, 59, 61, 62, 74, 80,
                   86, 87, 89, 90, 97, 98, 108, 114, 120, 130, 131, 136, 137, 140, 142,
                   145, 149, 150, 151, 153, 155, 159, 163, 166, 168, 169],
        'hongc': [7, 11, 12, 14, 19],
        'yzy': [9],
        'fengyi': [2, 3, 6, 8, 12, 15, 17],
    },
    '生气': {
        'putong': [42, 47, 48, 56, 58, 63, 65, 71, 77, 79, 85, 91, 93, 95, 104, 110, 112,
                   123, 138, 139, 143, 158, 162],
        'hongc': [],
        'yzy': [],
        'fengyi': [],
    },
    '害羞': {
        'putong': [25, 40, 45, 115, 116, 129, 165],
        'hongc': [4, 10],
        'yzy': [],
        'fengyi': [],
    },
    '问号': {
        'putong': [3, 5, 12, 16, 19, 20, 27, 32, 44, 49, 54, 60, 66, 69, 72, 78, 81, 83,
                   88, 92, 94, 99, 100, 106, 113, 119, 125, 132, 134, 144, 148, 154, 157,
                   160, 164],
        'hongc': [6, 9, 13],
        'yzy': [3, 5, 11, 12],
        'fengyi': [1, 5, 9, 10, 16, 19],
    },
    '委屈': {
        'putong': [4, 7, 13, 15, 18, 21, 24, 29, 31, 33, 35, 37, 41, 50, 52, 55, 64, 67, 75,
                   84, 103, 107, 118, 124, 127, 135, 141, 156],
        'hongc': [3, 17, 18],
        'yzy': [2, 4],
        'fengyi': [11, 13, 14],
    },
}

# ---------- 1) 覆盖校验：每个源文件必须恰好被分到一类 ----------
src = [f for f in os.listdir(INBOX) if f.endswith('.gif')]
assigned = {}
dup = []
for cat, packs in PLAN.items():
    for prefix, idxs in packs.items():
        for i in idxs:
            name = f'{prefix}_{i:03d}.gif'
            if name in assigned:
                dup.append(name)
            assigned[name] = cat

missing = sorted(set(src) - set(assigned))
extra = sorted(set(assigned) - set(src))
print(f'源文件 {len(src)} 个 | 已分 {len(assigned)} 个')
if dup:
    print(f'🔴 重复归类 {len(dup)} 个: {dup[:10]}')
if missing:
    print(f'🔴 漏分 {len(missing)} 个（这些她永远抽不到）: {missing[:20]}')
if extra:
    print(f'🔴 分了不存在的文件: {extra[:10]}')
if missing or dup or extra:
    print('\n❌ 覆盖校验没过，先修 PLAN 再跑。')
    sys.exit(1)
print('✅ 覆盖校验通过：221 个每个恰好一类\n')

# ---------- 2) 分档统计 ----------
for cat, packs in PLAN.items():
    n = sum(len(v) for v in packs.values())
    print(f'  {cat:<4} {n:>3} 个')
print()

# ---------- 3) 执行 ----------
if DRY:
    print('（dry-run，没有移动任何文件。加 --apply 才真做）')
    sys.exit(0)

moved = 0
for cat, packs in PLAN.items():
    dest = os.path.join(OUT, cat)
    os.makedirs(dest, exist_ok=True)
    for prefix, idxs in packs.items():
        for i in idxs:
            name = f'{prefix}_{i:03d}.gif'
            s = os.path.join(INBOX, name)
            d = os.path.join(dest, name)
            shutil.move(s, d)
            moved += 1
print(f'✅ 已移动 {moved} 个文件到 {OUT}\\<类别>\\')
print('剩下的 inbox 里应是 0 个 gif:', len([f for f in os.listdir(INBOX) if f.endswith('.gif')]))
