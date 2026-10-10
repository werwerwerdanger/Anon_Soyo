#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_soyo_examples.py -- 用**官方台词**重建素世的 mes_example（不自己编）

用户要求（2026-10-10）："素世的你也从原著抓例子语句"。
即：她说的每一句都必须是原著/官方来源，不是卡作者或我编的。

做法：
  1. 从 `_soyo_official_lines.txt` 读官方语料（维基语录剧中对白 + 米游社官方游戏语音）；
  2. 为每一条官方台词配一个**自然的用户提问**（用户那侧是场景，无需官方来源）；
  3. 🔴 写卡片前**逐条断言**：所有 {{char}} 行都能在官方语料里找到（去空格标点后比对）；
  4. 任一不符就拒绝写入。

用法:
  python build_soyo_examples.py --dry      # 只打印+断言，不写卡
  python build_soyo_examples.py
"""
import argparse
import base64
import json
import re
import struct
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8")

CARD = r"C:\Users\20633\MimirLink-soyo\data\characters\Soyo_Nagasaki.png"
OFFICIAL = "_soyo_official_lines.txt"

# (用户那句话, 素世那句 —— 必须来自官方语料)
PAIRS = [
    ("你为什么非得重组乐队", "只要是我能做的 我什么都愿意做"),
    ("你说话怎么总是绕来绕去", "为什么重要的话总是说不出口呢"),
    ("你到底想怎么样", "你是来找我吵架的吗"),
    ("这件事就到此为止吧", "就由我来将它结束掉"),
    ("你说的话能信吗", "誓言什么的 那当然是骗人的啊"),
    ("你觉得这样下去行吗", "现在的我们就像一盘散沙 这样组乐队有什么意义吗"),
    ("你还忘不了那支乐队吧", "我大概一生都忘不了CRYCHIC吧"),
    ("你就是想出风头吧", "明明一开始只是想出风头"),
    ("我们要一起上吗", "和爱音组队 也不是不行啦"),
    ("稳一点", "不要冲动哦"),
    ("现在该怎么办", "冷静一点"),
    ("别丧了", "振作起来"),
    ("你最近状态不错", "状态不错嘛"),
    ("撑住", "加油保持下去"),
    ("大家都等着你回来", "我觉得现在这样四分五裂下去 对大家不太好吧"),
    ("别说了", "不要这样"),
    ("你到底想干什么", "唉 随便你吧"),
    ("这些都你一个人扛着", "真是的 拿你没办法"),
    ("[收到一张图]", "不要这样"),
    ("[又收到一张图]", "唉 随便你吧"),
]


def norm(s):
    return re.sub(r"[\s，。、！？!?~～…——\-「」『』（）()【】]", "", str(s or ""))


def load_official():
    out = []
    for line in open(OFFICIAL, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        out.append(line)
    return out


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

    official = load_official()
    onorm = {norm(x) for x in official}
    print(f"官方语料 {len(official)} 条")

    # 🔴 逐条断言：她的每一句都必须来自官方语料
    bad = []
    for user_line, char_line in PAIRS:
        n = norm(char_line)
        if not any(n and n in o for o in onorm):
            bad.append(char_line)
    if bad:
        print("!! 以下台词不在官方语料里，拒绝写入：")
        for b in bad:
            print("   -", b)
        sys.exit(1)
    print(f"✅ 全部 {len(PAIRS)} 条她的台词都能在官方语料里找到")

    blocks = []
    for user_line, char_line in PAIRS:
        blocks.append(f"<START>\n{{{{user}}}}: {user_line}\n{{{{char}}}}: {char_line}")
    mes = "\n".join(blocks)
    chars = [c for _, c in PAIRS]
    print(f"mes_example: {len(mes)} 字 / {len(PAIRS)} 组 / 她 {len(chars)} 条"
          f" | 最长 {max(len(c) for c in chars)} 字"
          f" | 感叹号 {mes.count('!') + mes.count('！')}"
          f" | 波浪号 {mes.count('~') + mes.count('～')}"
          f" | 括号 {mes.count('（') + mes.count('(')}")
    print()
    for b in blocks:
        print(b)
    print()

    if args.dry:
        print("[dry-run] 未写入卡片")
        return

    cur = read_card(CARD)
    json.dump({"mes_example": mes}, open("_soyo_mes_official.json", "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    r = subprocess.run([sys.executable, "set_card_fields.py", "--card", CARD,
                        "--json", "_soyo_mes_official.json"], capture_output=True, text=True)
    print((r.stdout or r.stderr).strip()[-260:])
    after = read_card(CARD).get("mes_example", "")
    # 回读再断言一次
    back = re.findall(r"\{\{char\}\}:\s*(.+)", after)
    bad_back = [c for c in back if not any(norm(c) and norm(c) in o for o in onorm)]
    print(f"回读: {after.count('<START>')} 组 | 她的台词 {len(back)} 条 | 非官方来源 {len(bad_back)} 条")
    if bad_back:
        print("!! 回读发现非官方台词：", bad_back)


if __name__ == "__main__":
    main()
