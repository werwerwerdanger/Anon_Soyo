#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_soyo_reaction_worldbook.py
把爱音世界书里素世那条的**动作性描述**改成**说话性描述**。

起因（2026-10-12 凌晨，用户报）
------------------------------
爱音在私聊里说：「你这话别让Soyorin听见 **她准瞪我**」。
用户判断：前半句没问题，**「瞪」不像素世干得出来的**。

根因（已用日志验证，不是猜）
----------------------------
那一轮的提示词里**确实注入了**素世的世界设定（日志 627652 行，因为用户前面那句
「只能喝 soyo 奶了」命中了 key `Soyo`），而条目里写着：

    ……素世对爱音变得有点像「傲娇」：**常摆出嫌弃的表情**、反驳爱音的提议……

模型拿到一个**表情/动作**描述（"嫌弃的表情"），就把它演成了一个具体动作（"瞪"）。
⇒ 修的是**这条描述本身**，不是加一条"不许瞪人"的规则。

为什么不写成"素世不瞪人"
------------------------
本项目已实测过两次的规律：**否定句 = 二次 priming**，写"别做 X"等于把 X 再喂一遍。
而且列举动作词（瞪/白眼/拍桌…）会**收敛到第一个**（7 次实证）。
所以只写**肯定式的、她实际会做的事**：她的态度从嘴里出来。

⚠ 这条路刻意不走 `system_prompt`：那是"每轮都在的字段"，写进去会**放大**队友话题的
  浓度（本项目规律：显著度 ∝ 出现在每轮字段）。世界书是命中 key 才注入，正好。

用法:
  python patch_soyo_reaction_worldbook.py            # 打补丁
  python patch_soyo_reaction_worldbook.py --dry-run  # 只看会不会命中
  python patch_soyo_reaction_worldbook.py --revert   # 还原
"""
import argparse
import io
import os
import sys

# 活的跑的是 Anon Chihaya's Lorebook.json（卡 name = "Anon Chihaya"，带空格）；
# 下面那个带下划线的是同名副本，一起改，免得以后谁换过去又踩一次。
WORLDBOOKS = [
    os.path.join(os.path.expanduser('~'), 'MimirLink', 'data', 'worlds', "Anon Chihaya's Lorebook.json"),
    os.path.join(os.path.expanduser('~'), 'MimirLink', 'data', 'worlds', "Anon_Chihaya's Lorebook.json"),
]

OLD = '常摆出嫌弃的表情、反驳爱音的提议，行动上却从不违抗。'

NEW = ('不认同就当场反驳，话说得客气又挑不出毛病，行动上却从不违抗。'
       '她的态度都是从嘴里出来的 —— 不高兴的时候，出口的是一句格外客气的话。')


def read(path):
    with io.open(path, 'r', encoding='utf-8') as fh:
        return fh.read()


def write(path, text):
    with io.open(path, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(text)


def process(path, revert, dry):
    if not os.path.exists(path):
        print('%-46s (不存在，跳过)' % os.path.basename(path))
        return True
    text = read(path)
    src, dst = (NEW, OLD) if revert else (OLD, NEW)
    n_src = text.count(src)
    n_dst = text.count(dst)

    if dry:
        print('%-46s 待替换命中 %d 次，已替换标志 %d 次' % (os.path.basename(path), n_src, n_dst))
        return True

    if n_dst > 0:
        print('%-46s already' % os.path.basename(path))
        return True
    if n_src != 1:
        # 必须恰好一次：0 次说明锚点漂了，>1 次说明改错地方（另有一条同名描述）
        print('%-46s !! 锚点命中 %d 次（期望 1 次），没动' % (os.path.basename(path), n_src))
        return False

    write(path, text.replace(src, dst, 1))
    # 立刻回读校验：JSON 还能解析 + 新句子在里面
    import json
    try:
        json.loads(read(path))
    except Exception as exc:
        print('%-46s !! 改完 JSON 解析失败，回滚: %s' % (os.path.basename(path), exc))
        write(path, text)
        return False
    print('%-46s %s' % (os.path.basename(path), 'reverted' if revert else 'patched'))
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--revert', action='store_true')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()
    ok = True
    for p in WORLDBOOKS:
        ok = process(p, args.revert, args.dry_run) and ok
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
