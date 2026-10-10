#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fix_anon_role_voice.py -- 修爱音的「角色感」：一条错误规则 + 缺两组加法 + 示例结构单一

用户 2026-10-10：「现在稍微拟人一点点了但是还是不太像角色」

实测诊断（官方台词 vs 现在爱音，私聊 58 条，按 split_reply 切成可见消息）
  指标            官方爱音   现在爱音
  叹词开头          5%       36%   <-- 首字「欸」占 26%，官方首字第一是「我」15%
  首字分布          我15%    欸26%
  提到自己的事       5%        5%
  n                39        58

四个根因，全在卡里，不在代码：

A. 🔴 system_prompt 有一条**在命令她说叹词开头**：
      「- 开头爱用叹词：哇 欸 诶 誒。」
   这是从官方台词里**过度归纳**的错特征（官方实际只有 5%）。
   性质与 `describe_visible_emoji_or_mood` 完全同类：
   **规则在命令用户抱怨的那个行为。**
   同时「常用感叹号，像哇!好可爱呀!」又把「哇」开头当一个模板来教。

B. 缺「加法」规则。素世的卡有两组爱音完全没有的规则：
      规则 8「偶尔跑题、突然说点自己的事、或者答非所问，都很正常」
      规则 15「你也可以主动：主动问、主动张罗、主动提起一件事…不用等对方把话说完」
   爱音的卡里**一条加法都没有，全是减法**（别这样、别那样）。
   ⇒ 这是「素世像、爱音不像」的结构性原因。

C. mes_example 结构单一：9 个 block 里 6 个是「被质疑 → 辩解」，
   没有一个是「主动分享 / 炫耀 / 跑题」。示例教的是对话**结构**，
   所以她现在几乎每条都是反驳型。

D. first_mes（SillyTavern 文档明确说是最强的风格模板）首行是残缺碎句
      「欸 等等 你！」
   既语法不通，又刚好是把「欸」当模板教给模型。素世的 first_mes
   （我是长崎素世 / 我的贝斯手 / 有什么话直说 / 我讨厌绕圈子的人）质量高得多。

用法:
  python fix_anon_role_voice.py --check
  python fix_anon_role_voice.py --dry
  python fix_anon_role_voice.py
  python fix_anon_role_voice.py --revert
"""
import argparse
import base64
import json
import os
import pathlib
import shutil
import struct
import sys
import time
import zlib

sys.stdout.reconfigure(encoding="utf-8")

CARD = r"C:\Users\20633\MimirLink\data\characters\Anon_Chihaya.png"

# ---------------------------------------------------------------- A 规则改错
SP_OLD_1 = "- 常用感叹号，像哇!好可爱呀!；拖长音用波浪号，像借我一下~~、超好的~。不要打句号。"
# ⚠ 第一版这里把「哇!好可爱呀!」整个删了 —— 连**感叹号的示范**一起删掉了，
# 实测 A/B：有 `!` 从 23% 掉到 17%（官方 59%）。范例要换，不能删。
# 换成不以叹词开头的例句：既保住感叹号强度，又不教「哇」开头。
SP_NEW_1 = ("- 常用感叹号，像这也太可爱了吧!、我早就想好啦!、是真的!；"
            "拖长音用波浪号，像借我一下~~、超好的~。不要打句号。")

SP_OLD_2 = "- 开头爱用叹词：哇 欸 诶 誒。"
SP_NEW_2 = ("- 怎么起头不固定，这一点很关键：最常见的是**不带任何开场词**，直接接住对方说的内容往下聊；"
            "有时从自己的事说起（我刚才在做…、我昨天看到…）；有时先反问；想不起说什么就一个字（嗯、哈、?）。"
            "哇、欸这类只是偶尔才出现，不要每条都拿它当开头。")

# ---------------------------------------------------------------- B 补加法
SP_OLD_3 = "- 情绪写在字面上：得意就自夸，心虚就结巴，慌了就喊完蛋啦。"
SP_NEW_3 = ("- 情绪写在字面上：得意就自夸，心虚就结巴，慌了就喊完蛋啦。\n"
            "- 你可以主动开口，不用等对方问。想到什么说什么：吐槽今天遇到的事、说自己在干嘛、"
            "纠结选哪个、炫耀刚干成的事、拿认识的人开玩笑。对方没问也可以说。\n"
            "- 偶尔跑题、说点跟当前话题无关的事、或者答非所问，都很正常。不用每句都紧扣对方那句话。")

# ---------------------------------------------------------------- D first_mes
FM_OLD = "欸 等等 你！\n我是爱音~\n乐队是我拉起来的哦\n下周在RiNG有演出 来的人不多 怎么办嘛"
FM_NEW = ("我是爱音~\n"
          "MyGO!!!!! 的吉他手，演出服也是我在弄\n"
          "乐队是我拉起来的哦\n"
          "下周在RiNG有演出 来的人不多 怎么办嘛")

# ---------------------------------------------------------------- C 示例补结构
# ⚠ mes_example 结尾**没有**换行符，锚点末尾不能带 \n（实测踩过）
EX_TAIL = "<START>\n{{user}}: 这张图里是谁\n{{char}}: 我看像乐奈\n{{char}}: 白毛异色瞳那个"

EX_NEW_BLOCKS = """
<START>
{{user}}: 我们出去玩吧
{{char}}: 去哪
{{char}}: 周六不行 有排练
<START>
{{user}}: 在干嘛
{{char}}: 我刚把演出服的图改完了
{{char}}: 这次肯定好看
{{char}}: 我还给新曲子想好了名字
<START>
{{user}}: 下周演出你紧张吗
{{char}}: 紧张啊
{{char}}: 这两天一直在背谱 手都酸了
{{user}}: 那你早点睡
{{char}}: 睡不着的 一躺下就在想演出服的事
<START>
{{user}}: 你今天干嘛了
{{char}}: 我上午练完琴去买了条裙子
{{char}}: 试的时候店员说我这个身高穿什么都好看~
{{user}}: 谁说的
{{char}}: 我自己也这么觉得啊!
"""


# ------------------------------------------------------------------ PNG 读写
def read_chunks(raw):
    chunks, pos = [], 8
    while pos < len(raw):
        (ln,) = struct.unpack(">I", raw[pos:pos + 4])
        ctype = raw[pos + 4:pos + 8]
        data = raw[pos + 8:pos + 8 + ln]
        chunks.append((ctype, data))
        pos += 12 + ln
    return chunks


def write_chunks(chunks):
    out = [b"\x89PNG\r\n\x1a\n"]
    for ctype, data in chunks:
        out.append(struct.pack(">I", len(data)))
        out.append(ctype)
        out.append(data)
        out.append(struct.pack(">I", zlib.crc32(ctype + data) & 0xFFFFFFFF))
    return b"".join(out)


def payload_idx(chunks):
    idx = []
    for i, (ctype, data) in enumerate(chunks):
        if ctype not in (b"tEXt", b"iTXt"):
            continue
        kw = data.split(b"\x00", 1)[0].decode("latin-1")
        if kw in ("chara", "ccv3"):
            idx.append(i)
    return idx


def get_fields(path):
    chunks = read_chunks(pathlib.Path(path).read_bytes())
    for i in payload_idx(chunks):
        kw, _, val = chunks[i][1].partition(b"\x00")
        obj = json.loads(base64.b64decode(val).decode("utf-8"))
        return obj.get("data") if isinstance(obj.get("data"), dict) else obj
    raise SystemExit("!! no chara/ccv3 chunk")


def put_fields(path, fields, stamp):
    """只改 tEXt payload，IDAT/IHDR 一个字节都不动；写完回读断言。"""
    p = pathlib.Path(path)
    bak = p.with_suffix(p.suffix + ".bak-" + stamp + "-rolevoice")
    shutil.copy2(p, bak)
    raw = p.read_bytes()
    chunks = read_chunks(raw)
    before = [c for c, _ in chunks]
    for i in payload_idx(chunks):
        kw, _, val = chunks[i][1].partition(b"\x00")
        obj = json.loads(base64.b64decode(val).decode("utf-8"))
        target = obj.get("data") if isinstance(obj.get("data"), dict) else obj
        for k, v in fields.items():
            if k in target:
                target[k] = v
        enc = base64.b64encode(json.dumps(obj, ensure_ascii=False).encode("utf-8"))
        chunks[i] = (chunks[i][0], kw + b"\x00" + enc)
    after = [c for c, _ in chunks]
    if before != after:
        return False, "chunk 清单变了，拒绝写入"
    p.write_bytes(write_chunks(chunks))
    back = get_fields(path)
    for k, v in fields.items():
        if back.get(k) != v:
            shutil.copy2(bak, path)
            return False, f"回读不符: {k}"
    return True, bak.name


# ------------------------------------------------------------------ 主流程
def build(sp):
    """返回 (新 system_prompt, 命中报告) 或 (None, 错误)"""
    hits = []
    for tag, old in (("A1 感叹号模板", SP_OLD_1), ("A2 叹词开头规则", SP_OLD_2),
                     ("B 加法锚点", SP_OLD_3)):
        n = sp.count(old)
        hits.append(f"{tag}={n}")
        if n != 1:
            return None, f"{tag} 锚点命中 {n} 次（应为 1）"
    return (sp.replace(SP_OLD_1, SP_NEW_1, 1)
              .replace(SP_OLD_2, SP_NEW_2, 1)
              .replace(SP_OLD_3, SP_NEW_3, 1)), " | ".join(hits)


def revert(sp):
    pairs = ((SP_NEW_1, SP_OLD_1), (SP_NEW_2, SP_OLD_2), (SP_NEW_3, SP_OLD_3))
    for new, old in pairs:
        if sp.count(new) != 1:
            return None, f"找不到新文案（{new[:24]}…）"
        sp = sp.replace(new, old, 1)
    return sp, "已还原"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()

    f = get_fields(CARD)
    sp, ex, fm = f.get("system_prompt", ""), f.get("mes_example", ""), f.get("first_mes", "")
    print("=" * 74)
    print("anon 卡角色感修复")
    print(f"  system_prompt {len(sp)}字 | mes_example {len(ex)}字 | first_mes {len(fm)}字")
    print(f"  现状：已修 A2={'怎么起头不固定' in sp} | 已修 B={'你可以主动开口' in sp} "
          f"| 已修 C={'去哪' in ex and '睡不着的' in ex} | 已修 D={fm.startswith('我是爱音')}")

    if args.check:
        new_sp, rep = build(sp)
        print(f"  锚点: {rep if new_sp else rep}")
        print(f"  mes_example 尾部锚点={ex.count(EX_TAIL)}  first_mes 锚点={int(fm == FM_OLD)}")
        return

    if args.revert:
        new_sp, rep = revert(sp)
        if new_sp is None:
            print("  !!", rep)
            return
        new_ex = ex.replace(EX_NEW_BLOCKS, "", 1)
        new_fm = FM_OLD
        ok, info = put_fields(CARD, {"system_prompt": new_sp, "mes_example": new_ex,
                                     "first_mes": new_fm}, time.strftime("%Y%m%d-%H%M%S"))
        print(f"  {'REVERTED' if ok else '!! ' + info}  备份={info if ok else '-'}")
        return

    new_sp, rep = build(sp)
    if new_sp is None:
        print("  !!", rep)
        return
    print(f"  锚点: {rep}")

    if ex.count(EX_TAIL) != 1:
        print(f"  !! mes_example 尾部锚点命中 {ex.count(EX_TAIL)} 次（应为 1），中止")
        return
    if fm != FM_OLD:
        print("  !! first_mes 锚点不符，中止（可能已改过）")
        return

    new_ex = ex.replace(EX_TAIL, EX_TAIL + EX_NEW_BLOCKS, 1)
    if args.dry:
        print(f"  DRY ok  sp {len(sp)}->{len(new_sp)}  ex {len(ex)}->{len(new_ex)}  fm {len(fm)}->{len(FM_NEW)}")
        return

    ok, info = put_fields(CARD, {"system_prompt": new_sp, "mes_example": new_ex,
                                 "first_mes": FM_NEW}, time.strftime("%Y%m%d-%H%M%S"))
    if not ok:
        print("  !!", info)
        return
    print(f"  OK  sp {len(sp)}->{len(new_sp)}  ex {len(ex)}->{len(new_ex)}  fm {len(fm)}->{len(FM_NEW)}")
    print(f"  备份={info}")

    # 断言：错的没了、对的在
    back = get_fields(CARD)
    probs = []
    if "开头爱用叹词" in back["system_prompt"]:
        probs.append("旧规则仍在")
    if "怎么起头不固定" not in back["system_prompt"]:
        probs.append("新开场规则缺失")
    if "你可以主动开口" not in back["system_prompt"]:
        probs.append("加法规则缺失")
    if back["first_mes"].startswith("欸"):
        probs.append("first_mes 仍以叹词开头")
    if "去哪" not in back["mes_example"]:
        probs.append("新示例缺失")
    print("  断言:", "全部通过" if not probs else "!! " + "; ".join(probs))


if __name__ == "__main__":
    main()
