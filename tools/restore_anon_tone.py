#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
restore_anon_tone.py -- 把爱音的「元气标点」还回去（按官方台词校准）

诊断（2026-10-10，以官方语料为基线）：
  指标        官方爱音   我们的爱音
  波浪号 ~       18%         1%
  感叹号 !       59%         1%
  元认知          0%        6~10%

三个真正的"风格教师"全都在教错的调子：
  1. first_mes 一个标点都没有 → 无历史时作为 assistant 预填，是最强样板；
  2. description 台词示例第一条写成「是又怎样。」，官方原文是「是又怎样?」；
  3. 上一轮加的警告写着"不要模仿它们的长度和标点" —— 例句里唯一的 ！和～ 来自
     原著，等于明确叫模型别学。
  4. system_prompt 里「不说你这话什么意思、说什么呢、被你这么一说」这种
     负面点名反而抬高元认知出现率（6% → 10%）—— 提到即激活。改成纯行为描述。

用法:
  python restore_anon_tone.py --check
  python restore_anon_tone.py
"""
import argparse
import base64
import json
import shutil
import struct
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

CARD = r"C:\Users\20633\MimirLink\data\characters\Anon_Chihaya.png"

NEW_FIRST_MES = "欸 等等 你！\n我是爱音~\n乐队是我拉起来的哦\n下周在RiNG有演出 来的人不多 怎么办嘛"

CAVEAT_OLD = ("（下面这些句子只是让你摸情绪的，不是给你背的。原句一个字都不要照搬，"
              "也不要模仿它们的长度和标点——你发出去的话按上面的打字口吻来。）")

CAVEAT_NEW = ("（这些句子是给你摸情绪的。注意她们的调子：爱音说话就是带感叹号、"
              "带波浪号拖音的，照这个语气来，只是别整句照搬原话。）\n"
              "\n"
              "### 日常语气（官方游戏语音，这才是她平时讲话的样子）\n"
              "「哇~好可爱的演出服呀!」\n"
              "「欸!忘带钱包了!Soyorin,就这一次能不能借我一下~~」\n"
              "「哇~~运气超好的!」\n"
              "「完蛋啦~!」\n"
              "「大危机!」\n"
              "「说不定状态绝佳哦!」\n"
              "「不行了啦...」\n"
              "「开始LIVE吧!」\n"
              "「希望下次是在MyGO的LIVE上见到你们~」\n")

SP_OLD = "- 只接内容，不要评论对方这句话本身。不说你这话什么意思、说什么呢、被你这么一说。"
SP_NEW = "- 直接接对方说的内容往下聊，不要停下来评论对方是怎么说的。"

EX_OLD = "标志性的嘴硬、不服管：「是又怎样。」"
EX_NEW = "标志性的嘴硬、不服管：「是又怎样?」"


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
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    src = read_card(CARD)
    d = src.get("description", "") or ""
    sp = src.get("system_prompt", "") or ""
    fm = src.get("first_mes", "") or ""

    if args.check:
        print(f"first_mes 含标点={any(c in fm for c in '!~！～?？')}  {fm!r}")
        print(f"警告已改={'这些句子是给你摸情绪的' in d}")
        print(f"日常语气块={'官方游戏语音' in d}")
        print(f"是又怎样改正={'「是又怎样?」' in d}")
        print(f"system_prompt 元认知规则已改={SP_NEW in sp}")
        return

    notes = []
    if NEW_FIRST_MES != fm:
        fm = NEW_FIRST_MES
        notes.append("first_mes")
    if CAVEAT_OLD in d:
        d = d.replace(CAVEAT_OLD, CAVEAT_NEW, 1)
        notes.append("caveat+日常语气")
    elif "官方游戏语音" not in d:
        print("!! 找不到警告段锚点，description 未改")
    if EX_OLD in d:
        d = d.replace(EX_OLD, EX_NEW, 1)
        notes.append("是又怎样→?")
    if SP_OLD in sp:
        sp = sp.replace(SP_OLD, SP_NEW, 1)
        notes.append("元认知规则")

    if not notes:
        print("-- 无需改动")
        return

    payload = {"first_mes": fm, "description": d, "system_prompt": sp}
    tmp = "_anon_tone_fix.json"
    json.dump(payload, open(tmp, "w", encoding="utf-8"), ensure_ascii=False)
    r = subprocess.run([sys.executable, "set_card_fields.py",
                        "--card", CARD, "--json", tmp],
                       capture_output=True, text=True)
    print((r.stdout or r.stderr).strip()[-500:])
    after = read_card(CARD)
    print(f"改动: {notes}")
    print(f"回读: first_mes 含标点={any(c in after.get('first_mes','') for c in '!~！～?？')}"
          f"  日常语气块={'官方游戏语音' in after.get('description','')}"
          f"  description={len(after.get('description',''))}字")


if __name__ == "__main__":
    main()
