#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fix_soyo_twist.py -- 让素世「拧」起来（用户：「感觉这样拉你素世姐姐不够拧巴」）

拧巴 = 嘴上推开的东西多半是想要的，而且**对方能听出来**。

诊断（先读真实对话，再读卡）：
实际输出长这样 —— 「我不接这种话」「随你怎么闹」「这种事我当没看见」「行了 我去睡了」×5
⇒ 全是**干净利落的切断**。这不是 bug，是**卡在正常工作**：

    system_prompt 11. 不要为了显得周到而补一句解释。**话说完就停。**
    system_prompt 17. …你才干脆收掉——不用客套的告别语，**说完就停**。
    description   - 口癖：句子短，一两句**说完就停**
    description   - 想到一句说一句，不铺垫、不总结，**说完就停**。

「说完就停」出现 4 次，本来是为了压掉客服味/AI 味的，但它顺手把
**「泄底的那半句」也一起禁掉了** —— 而拧巴恰恰是**切不断**：
    先收掉（不去 / 随你 / 算了）→ 紧接着漏一句真心（……你们几点结束）
    ❌ 补「解释」= 给自己找台阶，客服味 → 要继续禁
    ✅ 补「泄底」= 把真话说漏 → 要留着。两件事，原来被同一条规则误杀。

另有两处规则互相打架（都是"省略号"）：
    system_prompt 4. 标点克制：**少用省略号和破折号**
    description   - **不要用省略号表示沉默、犹豫或"说不出口"** —— 真人不会那样打。
    description   - 省略号偶尔出现一次是正常的，但…不能放在句首当"沉默"用。
而**上一轮我刚加的**是「每五六句有一句以「……」开头」⇒ 三对一，被压死。
⚠ 但注意口径：官方语料里**爱音也是 38% 带省略号**（爽世 41%），
  说明省略号主要是**游戏对白的语域特征（「……」= 说话停顿）**，不是爽世独有。
  ⇒ 不照搬 40%，折中到「每三四句一次」，形状保留（开头 & 句中咽回去）。

🔴 最要命的一处：`mes_example` 结尾三个 block **本身就是三条"平切断"示范**
    [对方说了一句很难听的话] → 不要这样
    [对方继续说下去]       → 你是来找我吵架的吗
    [对方还在说]           → 唉 随便你吧
   「指令 < 示例」⇒ 这三条直接教出了线上那个行为。**换成拧巴版才是真正的杠杆。**

用法: python fix_soyo_twist.py --check | --dry | (无参) | --revert
"""
import argparse
import base64
import io
import json
import pathlib
import shutil
import struct
import sys
import time
import zlib

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

CARD = r"C:\Users\20633\MimirLink-soyo\data\characters\Soyo_Nagasaki.png"

# ------------------------------------------------------------------ 1 规则 4
SP4_OLD = '4. 标点克制：少用省略号和破折号，不要连用感叹号。除乐队名"MyGO!!!!!"外，不要堆叠标点。'
SP4_NEW = ('4. 不要连用感叹号，除乐队名"MyGO!!!!!"外不要堆叠标点。'
           '省略号是你的常用标记，可以用，但别每句都带。')

# ------------------------------------------------------------------ 2 规则 11
SP11_OLD = "11. 不要为了显得周到而补一句解释。话说完就停。"
SP11_NEW = ("11. 不要为了显得周到而补一句解释 —— 解释是给自己找台阶，这个不要。"
            "但「漏一句真心话」是另一回事，那要留着（见第 18 条）。")

# ------------------------------------------------------------------ 3 新增规则 18
SP17_OLD = ("17. 对方还在说，你就接着聊，不要自己找理由结束对话。只有对方说要不聊了、要去睡了、"
            "先这样，你才干脆收掉——不用客套的告别语，说完就停。你可以少说、可以只回一两个字，"
            "但那是话少，不是赶人。")
SP17_NEW = SP17_OLD + "\n" + (
    "18. 你拧 —— 这一条最重要：**嘴上推开的东西，多半是想要的。**\n"
    "    常见的形状是两段：先把话收掉（不去、随你、算了、睡了），"
    "紧接着又漏一句真心话（……你们几点结束、……明天记得吃饭、……我早就知道了、"
    "……本来还想着你能来）。前半句是给别人看的，后半句才是真的。\n"
    "    大概三四条里有一条这样就行，不用每条都补；但一整段对话里一句都不漏，就不像你了。")

# ------------------------------------------------------------------ 4 省略号口径
DE_EL1_OLD = '- 这是手机打字，不是写小说。不要用省略号表示沉默、犹豫或"说不出口" —— 真人不会那样打。'
DE_EL2_OLD = '- 省略号偶尔出现一次是正常的，但不能每句都带，更不能放在句首当"沉默"用。'
DE_EL_NEW = ("- 省略号是你最好认的标记：大约每三四句里有一句带，位置多在**句子中间或开头**，"
             "表示话说到一半咽回去了。不要每句都带，但完全不出现就不像你。")

# ------------------------------------------------------------------ 5 示例换成拧巴版
EX_OLD = """<START>
{{user}}: [对方说了一句很难听的话]
{{char}}: 不要这样
<START>
{{user}}: [对方继续说下去]
{{char}}: 你是来找我吵架的吗
<START>
{{user}}: [对方还在说]
{{char}}: 唉 随便你吧"""

EX_NEW = """<START>
{{user}}: [对方说了一句很难听的话]
{{char}}: 不要这样
{{char}}: ……我本来没打算说这个的
<START>
{{user}}: [对方继续说下去]
{{char}}: 你是来找我吵架的吗
{{char}}: ……我今晚本来是想跟你说点别的
<START>
{{user}}: [对方还在说]
{{char}}: 唉 随便你吧
{{char}}: ……两点半了
{{char}}: 明天再说
<START>
{{user}}: 今晚出来吗
{{char}}: 不去
{{char}}: ……你们几点结束
<START>
{{user}}: 那算了 我不去了
{{char}}: 随你
{{char}}: ……
{{char}}: 本来还想着你能来一趟
<START>
{{user}}: 我睡了
{{char}}: 睡吧
{{char}}: ……明天记得吃饭
<START>
{{user}}: 我今天没去排练
{{char}}: 我知道
{{char}}: ……小立希跟我说了
{{char}}: 你自己去跟她解释"""


def read_chunks(raw):
    chunks, pos = [], 8
    while pos < len(raw):
        (ln,) = struct.unpack(">I", raw[pos:pos + 4])
        chunks.append((raw[pos + 4:pos + 8], raw[pos + 8:pos + 8 + ln]))
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
    out = []
    for i, (ctype, data) in enumerate(chunks):
        if ctype in (b"tEXt", b"iTXt"):
            kw = data.split(b"\x00", 1)[0].decode("latin-1")
            if kw in ("chara", "ccv3"):
                out.append(i)
    return out


def get_fields(path):
    chunks = read_chunks(pathlib.Path(path).read_bytes())
    for i in payload_idx(chunks):
        kw, _, val = chunks[i][1].partition(b"\x00")
        obj = json.loads(base64.b64decode(val).decode("utf-8"))
        return obj.get("data") if isinstance(obj.get("data"), dict) else obj
    raise SystemExit("!! no chara/ccv3 chunk")


def put_fields(path, fields, stamp):
    p = pathlib.Path(path)
    bak = p.with_suffix(p.suffix + ".bak-" + stamp + "-twist")
    shutil.copy2(p, bak)
    chunks = read_chunks(p.read_bytes())
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
    if before != [c for c, _ in chunks]:
        return False, "chunk 清单变了，拒绝写入"
    p.write_bytes(write_chunks(chunks))
    back = get_fields(path)
    for k, v in fields.items():
        if back.get(k) != v:
            shutil.copy2(bak, path)
            return False, f"回读不符: {k}"
    return True, bak.name


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()
    stamp = time.strftime("%Y%m%d-%H%M%S")

    f = get_fields(CARD)
    sp, de, ex = f["system_prompt"], f["description"], f["mes_example"]
    print("=" * 74)
    print("soyo 拧巴修复")
    print(f"  sp {len(sp)}字  de {len(de)}字  ex {len(ex)}字（{ex.count('<START>')} 块）")
    print(f"  现状：规则18={'18. 你拧' in sp}  省略号禁令已清={'不要用省略号表示沉默' not in de}  "
          f"示例已换={'本来还想着你能来一趟' in ex}")

    if args.revert:
        if "18. 你拧" not in sp or EX_NEW not in ex:
            print("  !! 找不到新内容，放弃")
            return
        nsp = (sp.replace(SP4_NEW, SP4_OLD, 1).replace(SP11_NEW, SP11_OLD, 1)
                 .replace(SP17_NEW, SP17_OLD, 1))
        nde = de.replace(DE_EL_NEW, DE_EL1_OLD + "\n" + DE_EL2_OLD, 1)
        nex = ex.replace(EX_NEW, EX_OLD, 1)
        ok, info = put_fields(CARD, {"system_prompt": nsp, "description": nde, "mes_example": nex}, stamp)
        print(f"  {'REVERTED' if ok else '!! ' + info}")
        return

    checks = [("规则4", sp.count(SP4_OLD), 1), ("规则11", sp.count(SP11_OLD), 1),
              ("规则17", sp.count(SP17_OLD), 1),
              ("省略号禁1", de.count(DE_EL1_OLD), 1), ("省略号禁2", de.count(DE_EL2_OLD), 1),
              ("示例尾块", ex.count(EX_OLD), 1)]
    bad = [f"{n}={c}(应{d})" for n, c, d in checks if c != d]
    if bad:
        print("  !! 锚点异常: " + "; ".join(bad))
        return
    print("  锚点: " + " | ".join(f"{n}={c}" for n, c, _ in checks))
    if args.check:
        # ⚠ 第一版漏了这个分支 ⇒ `--check` 也会真的写卡。
        # 项目里所有 patch_*.py 的约定是 --check = 只读报告。
        print("  (--check 只报告，未写入)")
        return

    nsp = (sp.replace(SP4_OLD, SP4_NEW, 1).replace(SP11_OLD, SP11_NEW, 1)
             .replace(SP17_OLD, SP17_NEW, 1))
    nde = de.replace(DE_EL1_OLD + "\n" + DE_EL2_OLD, DE_EL_NEW, 1)
    if nde == de:
        nde = de.replace(DE_EL1_OLD, DE_EL_NEW, 1).replace(DE_EL2_OLD, "", 1)
    nex = ex.replace(EX_OLD, EX_NEW, 1)
    if args.dry:
        print(f"  DRY ok  sp {len(sp)}->{len(nsp)}  de {len(de)}->{len(nde)}  ex {len(ex)}->{len(nex)}")
        return

    ok, info = put_fields(CARD, {"system_prompt": nsp, "description": nde, "mes_example": nex}, stamp)
    if not ok:
        print("  !!", info)
        return
    back = get_fields(CARD)
    probs = []
    if "18. 你拧" not in back["system_prompt"]:
        probs.append("规则18缺失")
    if "不要用省略号表示沉默" in back["description"]:
        probs.append("省略号禁令仍在")
    if "少用省略号和破折号" in back["system_prompt"]:
        probs.append("规则4未放宽")
    if "本来还想着你能来一趟" not in back["mes_example"]:
        probs.append("新示例缺失")
    if "你是来找我吵架的吗\n{{char}}: ……我今晚本来是想跟你说点别的" not in back["mes_example"]:
        probs.append("旧平切断示例未被替换")
    print(f"  OK  sp {len(sp)}->{len(nsp)}  de {len(de)}->{len(nde)}  ex {len(ex)}->{len(nex)}")
    print(f"  备份={info}")
    print("  断言:", "全部通过" if not probs else "!! " + "; ".join(probs))


if __name__ == "__main__":
    main()
