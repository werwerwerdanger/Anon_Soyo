#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
default_ignore_stickers.py -- 默认不解析表情包，只在被明确问时才看

用户 2026-10-10：
  "表情包可以不解析啊 一般表情包也没特殊含义 只有在专门说的时候才用解析
   还有我们的限制没生效"

⇒ 口径改成：**默认当没发过一样，接着聊文字**；只有对方明确让你看图 / 问图里是什么，
  才去看图的内容。
（之前我写的是"笑一下、吐槽一句就行" —— 那还是在解析，方向不对。）

为什么之前的补丁看着没用：
  一是判断条件漏了 `image` 段（已修，`patch_image_as_sticker.py`）；
  二是即便命中了，`注意:` 行写的也是"笑一下吐槽一句"，**还在鼓励对图做反应**。

改动：
  1. 两张卡的规则换成"默认不管"；
  2. 爱音的 mes_example 里两组"对图做反应"的示范换成三组新示范：
     ① 只收到图 → 给个最淡的回应；② 图+文字 → 只接文字，不提图；
     ③ **被明确问** → 这时候才看图并回答（示范"什么时候才该解析"）；
  3. 素世的 mes_example 里两组收图示范删掉（她那两组是官方台词挪用的，
     留着会教"对图做反应"；改为只靠规则）。

⚠ 图片仍然直传给视觉模型（她"看得见"），只是被要求不提。这样被问的时候才答得出来。

用法:
  python default_ignore_stickers.py --dry
  python default_ignore_stickers.py
"""
import argparse
import base64
import json
import struct
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8")

CARD_ANON = r"C:\Users\20633\MimirLink\data\characters\Anon_Chihaya.png"
CARD_SOYO = r"C:\Users\20633\MimirLink-soyo\data\characters\Soyo_Nagasaki.png"

# ---------------- 爱音
ANON_RULE_OLD = ("- 收到表情包或者图，笑一下、吐槽一句就行，像哈哈哈哈!、这谁画的啊!、存了存了。\n"
                 "- 不要报图里画的是什么，不要念图上的字，也不要把图上的字当成对方在说话。"
                 "除非对方问你图里是什么。")
ANON_RULE_NEW = ("- 默认不用管表情包。表情包一般没什么特别意思——不要提它、不要描述它、"
                 "也不要猜它是什么、不要念图上的字，就当对方没发过一样，接着聊文字。\n"
                 "- 只有对方明确让你看图、或者问你图里是什么的时候，才去看图的内容并回答。")

ANON_EX_OLD = (
    "<START>\n"
    "{{user}}: [收到一张图]\n"
    "{{char}}: 哈哈哈哈!\n"
    "{{char}}: 这谁画的啊!\n"
    "{{user}}: [又收到一张图]\n"
    "{{char}}: 哈哈哈哈哈\n"
    "{{char}}: 别发了 我快笑不动了~\n"
    "<START>\n"
    "{{user}}: [收到一张带字的图]\n"
    "{{char}}: 哈哈这图做得还挺用心\n"
    "{{char}}: 我先存了~"
)
ANON_EX_NEW = "\n".join([
    "<START>",
    "{{user}}: [收到一张图]",
    "{{char}}: 哈",
    "<START>",
    "{{user}}: 昨天立希又骂我了",
    "{{char}}: 她那人本来就那样",
    "{{user}}: [收到一张图]",
    "{{char}}: 你别打岔 后来呢",
    "<START>",
    "{{user}}: 这张图里是谁",
    "{{char}}: 我看像乐奈",
    "{{char}}: 白毛异色瞳那个",
])

# ---------------- 素世
SOYO_RULE_OLD = ("18. 收到表情包或者图，点一下头、或者吐槽一句就行，像「嗯」「收到」「你发这些干嘛」「别再发了」。"
                 "不要报图里画的是什么，不要念图上的字，也不要把图上的字当成对方在说话。除非对方问你图里是什么。")
SOYO_RULE_NEW = ("18. 默认不用管表情包。表情包一般没什么特别意思——不要提它、不要描述它、"
                 "也不要猜它是什么、不要念图上的字，就当对方没发过一样，接着聊文字。"
                 "只有对方明确让你看图、或者问你图里是什么的时候，才去看图的内容并回答。")

SOYO_BLOCKS = [
    "<START>\n{{user}}: [收到一张图]\n{{char}}: 不要这样",
    "<START>\n{{user}}: [又收到一张图]\n{{char}}: 唉 随便你吧",
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


def write_card(card_path, payload, label):
    json.dump(payload, open("_sticker_tmp.json", "w", encoding="utf-8"), ensure_ascii=False)
    r = subprocess.run([sys.executable, "set_card_fields.py", "--card", card_path,
                        "--json", "_sticker_tmp.json"], capture_output=True, text=True)
    print(f"  {label}: " + (r.stdout or r.stderr).strip().splitlines()[-1][:100])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    print("=== 爱音 ===")
    a = read_card(CARD_ANON)
    sp, mes = a.get("system_prompt", ""), a.get("mes_example", "")
    print(f"  规则锚点={sp.count(ANON_RULE_OLD)} | 示例锚点={mes.count(ANON_EX_OLD)}")
    if not args.dry and sp.count(ANON_RULE_OLD) == 1 and mes.count(ANON_EX_OLD) == 1:
        write_card(CARD_ANON, {"system_prompt": sp.replace(ANON_RULE_OLD, ANON_RULE_NEW, 1),
                               "mes_example": mes.replace(ANON_EX_OLD, ANON_EX_NEW, 1)}, "爱音")
        b = read_card(CARD_ANON)
        print(f"  回读: 默认不管={'默认不用管表情包' in b['system_prompt']}"
              f" | 只在被问时才看={'只有对方明确让你看图' in b['system_prompt']}"
              f" | 示例组数={b['mes_example'].count('<START>')}")

    print("=== 素世 ===")
    s = read_card(CARD_SOYO)
    ssp, smes = s.get("system_prompt", ""), s.get("mes_example", "")
    print(f"  规则锚点={ssp.count(SOYO_RULE_OLD)}")
    if not args.dry and ssp.count(SOYO_RULE_OLD) == 1:
        new_mes = smes
        removed = 0
        for blk in SOYO_BLOCKS:
            if blk in new_mes:
                new_mes = new_mes.replace(blk + "\n", "").replace(blk, "")
                removed += 1
        write_card(CARD_SOYO, {"system_prompt": ssp.replace(SOYO_RULE_OLD, SOYO_RULE_NEW, 1),
                               "mes_example": new_mes}, "素世")
        c = read_card(CARD_SOYO)
        print(f"  回读: 默认不管={'默认不用管表情包' in c['system_prompt']}"
              f" | 删掉收图示范 {removed} 组 | 示例组数={c['mes_example'].count('<START>')}")

    if args.dry:
        print("\n[dry-run]")


if __name__ == "__main__":
    main()
