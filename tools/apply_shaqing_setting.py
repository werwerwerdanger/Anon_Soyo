#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
apply_shaqing_setting.py -- 写进「杀青梗」世界观设定，并撤掉之前的过度禁令

背景（2026-10-10 用户）：
我把爱音那句「等等 我怎么知道自己是被拍的啊 / 哈哈哈哈 你别细想~」判成"破四次元壁"，
加了两条禁令 + 一组"不认识柿本"的示范。用户随即纠正：

  「那个是杀青梗嘛，就是 mygo 和 avemujica 是他们自己的故事，
    然后别人邀请他们拍下来了这种」
  → 「设定里按我说的改就直接设定成这样」

所以正确设定是：
  · 她们经历过的故事是**真实发生**的；
  · 后来有人把这段故事**拍成了动画**，她们是**本人出演**；
  · 因此她知道拍摄这回事，也认识柿本监督和一起工作的人；
  · 别人拿这个开玩笑可以接、可以吐槽拍摄时的事。
  · 仍不许跳出来谈"设定/人设/提示词"，也不许讨论自己是不是机器人
    （这一条是防出戏的底线，和杀青梗不冲突）。

做法：
  1. 撤掉两条禁令（作品外面的事 / 不能说自己是被人拍的）；
  2. 换成上面的杀青梗设定；
  3. 把"不认识柿本"的示范换成按梗来的示范；
  4. 素世的卡也补同一条设定（她是同一个世界观，之前完全没有相关规则）。

用法:
  python apply_shaqing_setting.py --dry
  python apply_shaqing_setting.py
"""
import argparse
import base64
import json
import struct
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8")

BAN_LINES = (
    "- 有人问监督、声优、动画、剧本、原作、设定这些作品外面的事，你就当听不懂，说不认识、不知道，或者直接岔开话题。\n"
    "- 绝对不能说自己是被人拍出来、写出来的角色，也不能说别细想、你懂的这类话。你就是活在这个世界里的人。\n"
)

SETTING = (
    "- 你们经历过的事都是真的；后来有人把这段故事拍成了动画，你们是本人出演。"
    "所以拍摄这回事你是知道的，也认识柿本监督和一起工作的人。\n"
    "- 别人拿这个开玩笑，你可以接、可以吐槽拍摄时的事（重拍、紧张、首映之类）。"
    "但不要跳出来谈设定、人设、提示词，也不要讨论自己是不是机器人。\n"
)

# 实际写入时是**一个** <START> 块（4 轮），不是两个块
OLD_EXAMPLE = (
    "{{user}}: 你认识柿本广大吗\n"
    "{{char}}: 谁啊\n"
    "{{char}}: 不认识\n"
    "{{user}}: 就是拍你们的那个监督\n"
    "{{char}}: 什么拍不拍的\n"
    "{{char}}: 你别跟我说这些奇奇怪怪的~"
)

NEW_EXAMPLE = (
    "{{user}}: 你认识柿本广大吗\n"
    "{{char}}: 认识啊\n"
    "{{char}}: 拍我们那个嘛\n"
    "{{user}}: 你们的故事被拍成动画了\n"
    "{{char}}: 对啊\n"
    "{{char}}: 我们还去看了首映~"
)

SOYO_ANCHOR = "- 消息里的 [图片标识 #xxxx] 是这张图的指纹，同一个 xxxx 就是同一张图。"
SOYO_SETTING = (
    "21. 你们经历过的事都是真的；后来有人把这段故事拍成了动画，你们是本人出演。"
    "所以拍摄这回事你是知道的，也认识柿本监督和一起工作的人。别人拿这个开玩笑，"
    "你可以接、可以淡淡吐槽一句。但不要跳出来谈设定、人设、提示词，也不要讨论自己是不是机器人。\n"
)


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


def write(card_path, payload, label):
    json.dump(payload, open("_shaqing_tmp.json", "w", encoding="utf-8"), ensure_ascii=False)
    r = subprocess.run([sys.executable, "set_card_fields.py", "--card", card_path,
                        "--json", "_shaqing_tmp.json"], capture_output=True, text=True)
    print(f"  {label}: " + (r.stdout or r.stderr).strip().splitlines()[-1][:120])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    print("=== 爱音 ===")
    anon_card = r"C:\Users\20633\MimirLink\data\characters\Anon_Chihaya.png"
    a = read_card(anon_card)
    sp, mes = a.get("system_prompt", ""), a.get("mes_example", "")
    print(f"  禁令还在={BAN_LINES in sp} | 旧示范还在={OLD_EXAMPLE in mes} | 已有杀青梗={'杀青' in sp or '本人出演' in sp}")
    if BAN_LINES in sp:
        sp = sp.replace(BAN_LINES, SETTING, 1)
    if OLD_EXAMPLE in mes:
        mes = mes.replace(OLD_EXAMPLE, NEW_EXAMPLE, 1)
    if not args.dry:
        write(anon_card, {"system_prompt": sp, "mes_example": mes}, "爱音写入")
        a2 = read_card(anon_card)
        print(f"  回读: 禁令已撤={BAN_LINES not in a2['system_prompt']}"
              f" | 设定已写={'本人出演' in a2['system_prompt']}"
              f" | 新示范={'拍我们那个嘛' in a2['mes_example']}")

    print("=== 素世 ===")
    soyo_card = r"C:\Users\20633\MimirLink-soyo\data\characters\Soyo_Nagasaki.png"
    s = read_card(soyo_card)
    ssp = s.get("system_prompt", "")
    print(f"  已有杀青梗设定={'本人出演' in ssp} | 锚点命中={ssp.count(SOYO_ANCHOR)}")
    if "本人出演" not in ssp and ssp.count(SOYO_ANCHOR) == 1:
        ssp = ssp.replace(SOYO_ANCHOR, SOYO_ANCHOR + "\n" + SOYO_SETTING.rstrip(), 1)
        if not args.dry:
            write(soyo_card, {"system_prompt": ssp}, "素世写入")
            s2 = read_card(soyo_card)
            print(f"  回读: 设定已写={'本人出演' in s2['system_prompt']}")

    if args.dry:
        print("\n[dry-run]")


if __name__ == "__main__":
    main()
