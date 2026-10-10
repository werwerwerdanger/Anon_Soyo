#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fix_meta_refusal.py -- 「我当没看见」这类"宣告处理方式"的话

用户 2026-10-10 指出素世说了很诡异的一句：
    你：我射你照片上了
    素世：这种话我当没看见

为什么诡异：
  · **说"我当没看见"就等于承认看见了**。真人想忽略一句话，是直接不理或者骂回去，
    不会专门发一条消息公告"我忽略它"。
  · 她在**评论自己怎么处理这条消息**，而不是对内容作出情绪反应 ——
    和之前抓到的"元认知"是同一类。
  · 素世被冒犯时该是冷下来 / 生气 / 直接不回，不是一个"处理声明"。

根因：
  规则 12 说"被挑衅时…用冷淡回敬，或者干脆不接"，但**她必须输出文本**，
  于是"不接"被执行成了"宣告我不接"。规则 14「不要发表态式的话」也没拦住 ——
  因为它只说了不要什么，**没给能说什么**。按已验证的结论：示例 > 规则。

做法：
  1. 两张卡都加一条规则：不要宣告你打算怎么处理这条消息；
  2. 素世 `mes_example` 补示范（台词取自官方语料）：
     被说难听话时的正确反应是**短促的冷拒或直接换话题**，不是公告。
     ⚠ 这个场景原著里没有，所以只能给"情境"，台词仍用官方原句。

用法:
  python fix_meta_refusal.py --dry
  python fix_meta_refusal.py
"""
import argparse
import base64
import json
import struct
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8")

CARD_SOYO = r"C:\Users\20633\MimirLink-soyo\data\characters\Soyo_Nagasaki.png"
CARD_ANON = r"C:\Users\20633\MimirLink\data\characters\Anon_Chihaya.png"

RULE = {
    CARD_SOYO: (
        "22. 不要宣告你打算怎么处理这条消息。不说我当没看见、我不接这个话题、"
        "我不评论、这个我不回、我们换个话题吧。想忽略就真的忽略——回一个冷字、"
        "冷冷顶一句、或者直接说别的，但绝不专门发一条消息去说明你要忽略它。\n"
    ),
    CARD_ANON: (
        "- 不要宣告你打算怎么处理这条消息。不说我当没看见、我不接这个话题、"
        "我不评论、这个我不回。不想接就换个说法，或者干脆说点别的，"
        "但别专门发一条去说明你要忽略它。\n"
    ),
}

# 爱音示范里原有一句「但我当没看见啊~」——正是用户觉得诡异的那类话，
# 不改掉的话它会直接教模型说这句话（示例 > 指令），和新规则自相矛盾。
ANON_EX_OLD = ("{{user}}: [收到一张带字的图]\n"
               "{{char}}: 哈哈这图做得还挺用心\n"
               "{{char}}: 但我当没看见啊~")
ANON_EX_NEW = ("{{user}}: [收到一张带字的图]\n"
               "{{char}}: 哈哈这图做得还挺用心\n"
               "{{char}}: 我先存了~")

# 素世：情境是新的，台词全部取自官方语料
SOYO_BLOCKS = [
    ("[对方说了一句很难听的话]", "不要这样"),
    ("[对方继续说下去]", "你是来找我吵架的吗"),
    ("[对方还在说]", "唉 随便你吧"),
]


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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    for card, label in ((CARD_SOYO, "素世"), (CARD_ANON, "爱音")):
        d = read_card(card)
        sp = d.get("system_prompt", "")
        mes = d.get("mes_example", "")
        rule = RULE[card]
        key = "不要宣告你打算怎么处理这条消息"
        print(f"=== {label} ===")
        print(f"  规则已存在={key in sp} | 示范已存在={'我当没看见' in mes or '很难听的话' in mes}")

        new_sp = sp
        if key not in sp:
            new_sp = sp.rstrip() + "\n" + rule

        new_mes = mes
        if label == "爱音" and ANON_EX_OLD in mes:
            new_mes = mes.replace(ANON_EX_OLD, ANON_EX_NEW, 1)
            print("  已改写『我当没看见』那句示范")
        if label == "素世" and "很难听的话" not in mes:
            blocks = "\n".join(
                f"<START>\n{{{{user}}}}: {u}\n{{{{char}}}}: {c}" for u, c in SOYO_BLOCKS
            )
            new_mes = mes.rstrip() + "\n" + blocks

        if args.dry:
            print("  [dry-run] 不写入")
            continue
        if new_sp == sp and new_mes == mes:
            print("  无需改动")
            continue

        json.dump({"system_prompt": new_sp, "mes_example": new_mes},
                  open("_meta_refusal.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        r = subprocess.run([sys.executable, "set_card_fields.py", "--card", card,
                            "--json", "_meta_refusal.json"], capture_output=True, text=True)
        print("  " + (r.stdout or r.stderr).strip().splitlines()[-1][:110])
        a = read_card(card)
        print(f"  回读: 规则={key in a['system_prompt']}"
              f" | 示范组数={a['mes_example'].count('<START>')}")


if __name__ == "__main__":
    main()
