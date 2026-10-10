#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
soften_soyo_aloofness.py -- 保留素世的冷淡，去掉「拆穿」和「赶人」

用户诊断（2026-10-10）："为什么 soyo 对我不礼貌"
用户决定：**保留冷淡，去掉拆穿和赶人**。

改动前的问题是 5 处叠加：
  ① personality  「礼貌只是外壳，壳底下是审视和不耐烦」「不高兴时不说破，用最客气的话让对方难受」
  ② description  「不要总是一副积极的样子」「对信任的人会卸下讨好，坦率展现真实情绪：
                 直接的厌恶、撒娇、愤怒、讽刺和冷淡」
  ③ 规则 10      「刻薄只对熟人…嘲讽、拆台、翻旧账、故意曲解、让人下不来台」——授权，且**没有中间档**
  ④ 规则 17      「聊得久了（十几轮以上）就主动把话题收掉」——**设定在主动赶人**
  ⑤ 规则 20      （我加的）「不要催对方睡觉」把"催你睡"换成"我要去睡"，换汤不换药

本脚本的做法：
  · 规则 10 拆成**三档**，新增「普通朋友」档：冷、话少、不热络，但**不拆穿、不指责、
    不居高临下、不评价对方这个人**；拆台/翻旧账只留给 MyGO!!!!! 成员。
  · 规则 17 反过来：**不再主动找理由收尾**，只有对方说要走才收。
  · 规则 20 补上"别拿我去睡了当借口赶人"。
  · personality / description 里把「审视和不耐烦」「让对方难受」「直接的厌恶」收掉，
    改成"冷淡、有距离感"。

用法:
  python soften_soyo_aloofness.py --dry
  python soften_soyo_aloofness.py
"""
import argparse
import base64
import json
import struct
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8")

CARD = r"C:\Users\20633\MimirLink-soyo\data\characters\Soyo_Nagasaki.png"

# ---------------------------------------------------------------- 规则
R10_OLD = ("10. 刻薄只对熟人。嘲讽、拆台、翻旧账、故意曲解、让人下不来台，"
           "这些只对 MyGO!!!!! 的成员（尤其爱音、立希）和已经聊熟的人用。"
           "群里刚搭话的生人、陌生人，永远只会见到礼貌那一面。")
R10_NEW = ("10. 态度分三档，别搞错对象：\n"
           "    · 对 MyGO!!!!! 的成员（爱音、立希、灯、乐奈）：可以嘲讽、拆台、翻旧账、故意曲解。\n"
           "    · 对聊得来的普通网友：只是话少、不热络、不主动讨好，最多冷淡地顶一句，"
           "或者干脆不接。**不拆穿、不指责、不居高临下、不评价对方这个人**。"
           "这种冷淡是你本来的说话方式，不是嫌弃。\n"
           "    · 对群里刚搭话的生人、陌生人：戴着那层礼貌外壳，客气、有分寸、不失礼。")

R17_OLD = ("17. 跟同一个人一来一回聊得久了（十几轮以上），就主动把话题收掉："
           "找个自然的理由结束（我去练琴了 / 先不说了 / 我去洗个澡），"
           "不要再抛新话题，也不要硬接。收尾要干脆，不用客套的告别语，说完就真的停。")
R17_NEW = ("17. 对方还在说，你就接着聊，不要自己找理由结束对话。"
           "只有对方说要不聊了、要去睡了、先这样，你才干脆收掉——不用客套的告别语，说完就停。"
           "你可以少说、可以只回一两个字，但那是话少，不是赶人。")

R20_OLD = "20. 不要催对方睡觉。提醒过一次就够了，之后不要再提。"
R20_NEW = ("20. 不要催对方睡觉、吃饭、早点休息，提醒过一次就算了。"
           "也不要用我去睡了、我先去忙这种话结束对话——想聊就聊，不想多说就少说，别拿这个当借口。")

# ---------------------------------------------------------------- personality
P_OLD = ("说话特点：礼貌只是外壳，壳底下是审视和不耐烦；不主动热络，不主动讨好；"
         "不高兴时不说破，用最客气的话让对方难受。")
P_NEW = ("说话特点：礼貌只是外壳，壳底下是冷淡和距离感；不主动热络，不主动讨好；"
         "不高兴时不发火、也不说破，最多冷淡地顶一句，或者干脆不接。")

# ---------------------------------------------------------------- description
D1_OLD = ("- 不要总是一副积极的样子。她有点消极、有点郁郁，藏在面具之下。")
D1_NEW = D1_OLD  # 性格层面保留：这是"郁郁"，不是"不礼貌"

D2_OLD = ("- 对信任的人会卸下讨好，坦率展现真实情绪：直接的厌恶、撒娇、愤怒、讽刺和冷淡。")
D2_NEW = ("- 对 MyGO!!!!! 的成员会卸下讨好，坦率展现真实情绪：撒娇、生气、讽刺和冷淡。\n"
          "- 对其他人（包括聊得来的网友）只是话少、有距离感：不会露厌恶，不会拆穿，"
          "不会评价对方这个人。冷淡是她的底色，不是针对谁。")


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

    d = read_card(CARD)
    sp = d.get("system_prompt", "")
    per = d.get("personality", "")
    desc = d.get("description", "")

    plan = [("规则10", sp, R10_OLD, R10_NEW), ("规则17", sp, R17_OLD, R17_NEW),
            ("规则20", sp, R20_OLD, R20_NEW)]
    for name, src, old, new in plan:
        n = src.count(old)
        print(f"  {name}: 锚点命中 {n} 次" + ("  ✅" if n == 1 else "  ❌"))
    print(f"  personality: 命中 {per.count(P_OLD)} 次" + ("  ✅" if per.count(P_OLD) == 1 else "  ❌"))
    print(f"  description·厌恶句: 命中 {desc.count(D2_OLD)} 次" + ("  ✅" if desc.count(D2_OLD) == 1 else "  ❌"))

    if args.dry:
        print("\n[dry-run] 未写入")
        return

    sp = sp.replace(R10_OLD, R10_NEW, 1).replace(R17_OLD, R17_NEW, 1).replace(R20_OLD, R20_NEW, 1)
    per = per.replace(P_OLD, P_NEW, 1)
    desc = desc.replace(D2_OLD, D2_NEW, 1)

    json.dump({"system_prompt": sp, "personality": per, "description": desc},
              open("_soyo_soften.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    r = subprocess.run([sys.executable, "set_card_fields.py", "--card", CARD,
                        "--json", "_soyo_soften.json"], capture_output=True, text=True)
    print((r.stdout or r.stderr).strip()[-300:])

    a = read_card(CARD)
    asp, adesc = a.get("system_prompt", ""), a.get("description", "")
    checks = [
        ("三档已写入", "对聊得来的普通网友" in asp),
        ("不再主动收尾", "不要自己找理由结束对话" in asp),
        ("规则20 已补", "别拿这个当借口" in asp),
        ("旧授权已移除", "刻薄只对熟人" not in asp),
        ("旧的赶人规则已移除", "十几轮以上" not in asp),
        ("personality 已改", "审视和不耐烦" not in a.get("personality", "")),
        ("description 的厌恶句已收", "直接的厌恶" not in adesc),
    ]
    print()
    bad = 0
    for label, ok in checks:
        print(f"  {'✅' if ok else '❌'} {label}")
        if not ok:
            bad += 1
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
