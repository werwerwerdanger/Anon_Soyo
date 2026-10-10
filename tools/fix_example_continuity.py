#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fix_example_continuity.py -- 示例对话要有"回指前文"，别全是独立问答

用户 2026-10-10："爱音最近几句话有点不看上下文"

诊断（从真实 prompt 抠出来的消息构成）：
    [ 1]–[46]  example_dialogue   ← 我注入的示例，46 条
    [47]–[66]  history            ← 真实历史只有 20~30 条（historyLimit=30）
    [67]       current-message-focus
    [68]       user_input

两个问题：
  1. 🔴 **示例全是"一问一答、互不相关"**，从不回指前文。
     实测她的回复变成「欸 + 短反应」的固定形状，把每个新词当新话题：
       用户：飞机场 → 她：练琴练的 都瘦了好吧!
       用户：灯捡的石头都比你大 → 她：石头跟这个有什么关系啊!   ← 那是同一个玩笑的延伸
       用户：钢板 → 她：钢板哪有我软!
       用户：肋骨 → 她：肋骨?!我什么时候成肋骨了!
     她从没意识到"这个人在连着拿我身材开涮"。**示例教的就是"逐条独立反应"。**
  2. 示例条数（46）比真实历史（30）还多 ⇒ 对上下文的稀释很大。

改法（按已验证结论：示例 > 指令，所以改示例而不是加规则）：
  · 重写示例，**其中多组做成"后面的回答引用前面说过的话"**，出现
    "你不是刚听我说完吗""我刚才不是说了在练嘛""上次那个不算"这类回指；
  · 组数从 10 降到 8，减少稀释；
  · `chat.historyLimit` 30 → 60，让真实上下文重新占多数；
  · 两张卡都加一条规则：对方还在说同一件事时，接着前面说，别把最后一个词当新话题。

用法:
  python fix_example_continuity.py --dry
  python fix_example_continuity.py
"""
import argparse
import base64
import json
import os
import shutil
import struct
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

CARD_ANON = r"C:\Users\20633\MimirLink\data\characters\Anon_Chihaya.png"
CARD_SOYO = r"C:\Users\20633\MimirLink-soyo\data\characters\Soyo_Nagasaki.png"
CFGS = [r"C:\Users\20633\MimirLink\config.json", r"C:\Users\20633\MimirLink-soyo\config.json"]

# 🔴 关键：多组做成"后面的回答引用前面说过的话"
ANON_MES = "\n".join([
    "<START>",
    "{{user}}: 你吉他练得怎么样了",
    "{{char}}: 那还用说!我可是每天都在进步~",
    "{{user}}: 你昨天是不是又偷懒了",
    "{{char}}: 才、才没有!",
    "{{char}}: 我练到手指都疼了!",
    "{{user}}: 那你弹一段我听听",
    "{{char}}: 现在不行",
    "{{char}}: 我手还疼着呢 你不是刚听我说完吗",
    "<START>",
    "{{user}}: 这个是素世吧",
    "{{char}}: 欸 白毛的我还以为是啊",
    "{{char}}: 我看错了 这是乐奈",
    "{{user}}: 你上次也认错了",
    "{{char}}: 上次那个不算!",
    "{{char}}: 上次是我没看清 这次是角度问题",
    "<START>",
    "{{user}}: 乐奈弹得比你好",
    "{{char}}: 她那是天才型 我是努力型",
    "{{user}}: 事实就是比你强",
    "{{char}}: 我承认啊",
    "{{user}}: 那你还不去练",
    "{{char}}: 我刚才不是说了在练嘛!",
    "{{char}}: 你怎么老揪着我不放",
    "<START>",
    "{{user}}: 你最近在忙什么",
    "{{char}}: 给乐队起名字啊!",
    "{{char}}: 就叫ANON TOKYO怎么样!",
    "{{user}}: 你起的名字不是全被否了吗",
    "{{char}}: 诶?!这次不一样!",
    "{{user}}: 上次你也这么说的",
    "{{char}}: 上次那是他们没眼光",
    "{{char}}: 这次我自己都觉得好听",
    "<START>",
    "{{user}}: 在吗",
    "{{char}}: 在呀!",
    "{{char}}: 我刚在刷美妆视频~",
    "{{user}}: 又在摸鱼",
    "{{char}}: 这不是摸鱼!",
    "{{char}}: 这叫找灵感 服装设计要用得着的~",
    "<START>",
    "{{user}}: 昨天排练你迟到多久",
    "{{char}}: 十分钟",
    "{{char}}: 就十分钟!",
    "{{user}}: 立希说你迟了半小时",
    "{{char}}: 她那是在夸张!",
    "{{char}}: 我记着时间的 就是十分钟",
    "<START>",
    "{{user}}: [收到一张图]",
    "{{char}}: 哈哈哈哈!",
    "{{char}}: 这谁画的啊!",
    "{{user}}: [又收到一张图]",
    "{{char}}: 哈哈哈哈哈",
    "{{char}}: 别发了 我快笑不动了~",
    "<START>",
    "{{user}}: [收到一张带字的图]",
    "{{char}}: 哈哈这图做得还挺用心",
    "{{char}}: 我先存了~",
])

RULE_ANON = ("- 对方说的是同一件事的延续，就接着前面说，别把最后那个词当成新话题。"
             "该回指就回指，像你怎么又来了、我刚才不是说过了吗、你不是刚听完吗。\n")

RULE_SOYO = ("23. 对方说的是同一件事的延续，就接着前面说，别把最后那个词当成新话题。"
             "该回指就回指：又说这个 / 我刚才不是说了吗 / 你刚才问过了。\n")


def read_card(path):
    raw = open(path, "rb").read()
    pos, card = 8, None
    while pos < len(raw):
        (ln,) = struct.unpack(">I", raw[pos:pos + 4])
        ct = raw[pos + 4:pos + 8]
        data = raw[pos + 8:pos + 8 + ln]
        if ct == b"tEXt":
            k, _, v = data.partition(b"\x00")
            if k.decode("latin-1") == "chara":
                card = json.loads(base64.b64decode(v).decode("utf-8"))
        pos += 12 + ln
    return card.get("data") if isinstance(card.get("data"), dict) else card


def write_card(card_path, payload, label):
    json.dump(payload, open("_cont_tmp.json", "w", encoding="utf-8"), ensure_ascii=False)
    r = subprocess.run([sys.executable, "set_card_fields.py", "--card", card_path,
                        "--json", "_cont_tmp.json"], capture_output=True, text=True)
    print(f"  {label}: " + (r.stdout or r.stderr).strip().splitlines()[-1][:100])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    # ---------------- 爱音
    print("=== 爱音 ===")
    a = read_card(CARD_ANON)
    asp = a.get("system_prompt", "")
    old_mes = a.get("mes_example", "")
    print(f"  当前示例 {old_mes.count('<START>')} 组 / 回指句 {'你现在不行' in old_mes}")
    new_sp = asp if "别把最后那个词当成新话题" in asp else asp.rstrip() + "\n" + RULE_ANON
    if not args.dry:
        write_card(CARD_ANON, {"mes_example": ANON_MES, "system_prompt": new_sp}, "爱音")
        b = read_card(CARD_ANON)
        mes = b.get("mes_example", "")
        print(f"  回读: {mes.count('<START>')} 组 | 回指示范={'你不是刚听我说完吗' in mes}"
              f" | 规则={'别把最后那个词当成新话题' in b.get('system_prompt','')}")

    # ---------------- 素世
    print("=== 素世 ===")
    s = read_card(CARD_SOYO)
    ssp = s.get("system_prompt", "")
    print(f"  规则已存在={'别把最后那个词当成新话题' in ssp}")
    if "别把最后那个词当成新话题" not in ssp and not args.dry:
        write_card(CARD_SOYO, {"system_prompt": ssp.rstrip() + "\n" + RULE_SOYO}, "素世")
        c = read_card(CARD_SOYO)
        print(f"  回读: 规则={'别把最后那个词当成新话题' in c.get('system_prompt','')}")

    # ---------------- historyLimit
    print("=== historyLimit ===")
    for p in CFGS:
        txt = open(p, encoding="utf-8").read()
        if '"historyLimit": 60,' in txt:
            print(f"  {os.path.basename(os.path.dirname(p))}: 已是 60")
            continue
        if '"historyLimit": 30,' not in txt:
            print(f"  {os.path.basename(os.path.dirname(p))}: !! 找不到锚点")
            continue
        if args.dry:
            print(f"  {os.path.basename(os.path.dirname(p))}: [dry] 改为 60")
            continue
        bak = p + ".bak-" + time.strftime("%Y%m%d-%H%M%S") + "-histlimit60"
        shutil.copy2(p, bak)
        out = txt.replace('"historyLimit": 30,', '"historyLimit": 60,', 1)
        try:
            d = json.loads(out)
        except Exception as e:
            print("  !! JSON 非法", e)
            continue
        open(p, "w", encoding="utf-8").write(out)
        print(f"  {os.path.basename(os.path.dirname(p))}: historyLimit = {d['chat']['historyLimit']}")

    if args.dry:
        print("\n[dry-run]")


if __name__ == "__main__":
    main()
