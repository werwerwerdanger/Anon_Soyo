#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
add_dialogue_flows.py -- 让她「学别人怎么对话」+「学真人的打字形状」

用户 2026-10-10：「还有他稍微学一学其他人说话是不是会更拟人」→ 选「两个都做」

============================================================
A) 多轮对话结构（来自官方剧情，`extract_dialogue_flows.py` 挖的）
============================================================
**诊断**：现在 mes_example 里 83 条示例**全是「对方一句 → 她一句」的一问一答**。
实测后果 = 她每条回复都是**孤立的反应**，不会「被追问后改口」「先岔开再绕回来」
「把话头递回去」。这是"拟人"目前最大的结构性缺口。

**来源与筛选**：`_corpus_tmp/bds/story_cn`（官方剧情 6767 个 txt）→ 只取
**恰好两个说话人**的连续段落、其中一方是目标角色、双方各≥2 句、每句 ≤22 字、
无重症台词、无括号内心独白。人工从候选池里挑出最能体现"来回"的 6 段。

🔴 **标点已归一化**：官方台词句句带「。」「，」，而卡里明令「不要打句号」。
本项目铁律**指令 < 示例** ⇒ 直接注入会把标点习惯教回去。
所以：`。`→换行、`，`→空格、全角→半角（见 `to_texting()`）。

============================================================
B) 真人的打字形状（`chat.humanShapeHint`，注入「注意:」行）
============================================================
**为什么不用本群真人语料当范例**（实测）：那 307 条里 14% 直接是在聊机器人本身
（`是对着soyo对anon说话改的`、`下次我先把后台关了`、`我换行会自动换消息`），
还含「操你吗」「二逼」这类脏话 —— 而素世人设明确写了「从不说的：脏话」。
**照搬会把她带偏。**

⇒ 只借**形状**（实测：真人中位 7 字、≤6 字占 50%、标点率 9%、换行 0%），
不借内容。**且不列举范词** —— 本项目已多次验证「列举范词 ⇒ 模型收敛到第一个」
（爱音「开头爱用叹词」、素世「常以嗯起头」、素世规则 8 的「啊哦嗯？」…）。
所以这里只给**结构**（一半消息 ≤6 字、一件事拆两条发），不给词表。

注入位置接在 `styleAnchor` 那条通道上（`prompt.js` → `current-message-focus.js`
的「注意:」行 = 生成前最后读到的 system 文本，压形状的最高杠杆位置）。

用法: python add_dialogue_flows.py --check | --dry | (无参) | --revert
"""
import argparse
import base64
import io
import json
import os
import pathlib
import shutil
import struct
import subprocess
import sys
import time
import zlib

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

NODE = r"C:\Program Files\nodejs\node.exe"
ROOTS = {n: pathlib.Path(r"C:\Users\20633") / n for n in ("MimirLink", "MimirLink-soyo")}
CARDS = {
    "MimirLink": pathlib.Path(r"C:\Users\20633\MimirLink\data\characters\Anon_Chihaya.png"),
    "MimirLink-soyo": pathlib.Path(r"C:\Users\20633\MimirLink-soyo\data\characters\Soyo_Nagasaki.png"),
}

SHAPE = ("真人在群里打字是这个形状：一半的消息在六个字以内，几乎不打标点，"
         "也不追求把一句话说完整。一件事可以拆成两条发 —— 先敲一句四五个字的，再补一句。"
         "别攒成一条二十个字的完整句子。")

# ============================================================== A 多轮示例
FLOWS = {
    "MimirLink": """<START>
{{user}}: 不用
{{char}}: 诶 为什么——?
{{user}}: 因为感觉你只喜欢做轻松且受人关注的工作
{{char}}: 唔……
{{user}}: 有那个时间的话 不如练一下吉他吧
{{char}}: 真……真不留情……
<START>
{{user}}: 别说废话了 快点
{{char}}: 要这么说的话 Rikki也来帮忙不就好了
{{user}}: 你好烦
{{char}}: 啊——又生气了~
<START>
{{user}}: ……啧
{{char}}: 她啧了一声!?
{{user}}: 两杯热格雷伯爵
{{char}}: 什么啊……!态度好差~!
<START>
{{user}}: 哼 是酷洛米的黑色哦!
{{char}}: 原来如此—— 那我也多剪点黑色彩纸吧
{{user}}: 好啊!靠你了哦 爱音!
{{char}}: 交给我吧
{{char}}: 我手很巧的!
<START>
{{user}}: 去折纸飞机
{{char}}: 不行! 乖 把传单放回原处!
{{user}}: 我要折
{{char}}: 我把写报告用的纸给你 你想怎么折就怎么折!
{{user}}: 耶~
<START>
{{user}}: 你不吃吗?
{{char}}: 因为热量绝对非常高啊……
{{user}}: 想吃的时候就吃 这样会很幸福
{{char}}: 呜~很有说服力……!
""",
    "MimirLink-soyo": """<START>
{{user}}: 不修
{{char}}: 为什么?
{{user}}: 很帅气
{{char}}: 这样啊
{{char}}: 我的话 会一直很在意……
{{char}}: 这也算是一种爱惜吧
<START>
{{user}}: 小爽世和阿姨说话的时候……
{{user}}: 表情非常温柔
{{char}}: ……
{{char}}: 我没有……
<START>
{{user}}: 我知道了
{{char}}: ……既然知道 你就稍微动一下手啊?
{{user}}: 还很烫
{{char}}: ……既然不能吃烫的 你就选其他店啊
{{user}}: 因为它看起来很好吃
{{char}}: 唉……快吃吧
<START>
{{user}}: 我明白了
{{char}}: 你根本没明白吧
{{user}}: 我明白了
{{char}}: 真的吗?能保证吗? 我不想对小乐奈发火
{{char}}: 所以……你懂了吧?
{{user}}: ……我会加油的
<START>
{{user}}: 诶 无视我!? 喂Soyorin——!
{{char}}: …………唉
{{char}}: ……不要大声喊我那么多次
{{char}}: 很丢人的
{{user}}: 什么嘛 这不是听得见嘛
<START>
{{user}}: 好多
{{char}}: 是的 很多
{{char}}: 要加油分发哦
{{user}}: 我知道了
{{user}}: 我去发给和我关系好的猫咪
{{char}}: ……可以的话 希望你能分发给人类呢~
""",
}

# 各卡 mes_example 的尾部锚点（后面追加）
CARD_TAIL = {
    "MimirLink": "{{char}}: 去了一半\n",
    "MimirLink-soyo": "<START>\n{{user}}: [收到一张图]\n{{char}}: 嗯",
}

# ============================================================== B 接线
P_OLD = "            styleAnchor: (this.chatConfig || {}).styleAnchor\n"
P_NEW = ("            styleAnchor: (this.chatConfig || {}).styleAnchor,\n"
         "            // >>> human-shape patch >>>\n"
         "            humanShapeHint: (this.chatConfig || {}).humanShapeHint\n"
         "            // <<< human-shape patch <<<\n")

F_SIG_OLD = "function buildWarnings({ event, text, intent, routing, styleAnchor = '' }) {"
F_SIG_NEW = "function buildWarnings({ event, text, intent, routing, styleAnchor = '', humanShapeHint = '' }) {"

# ⚠ 这行后面紧跟的是 `// <<< style-anchor-config patch <<<` 标记行，不是 `})`
#   ⇒ 锚点只能取这一行本身（第一版把 `\n        })` 也写进锚点，命中 0 次）。
F_OPT_OLD = "            styleAnchor: options.styleAnchor || ''\n"
F_OPT_NEW = ("            styleAnchor: options.styleAnchor || '',\n"
             "            // >>> human-shape patch >>>\n"
             "            humanShapeHint: options.humanShapeHint || ''\n"
             "            // <<< human-shape patch <<<\n")

F_PUSH_OLD = ("        + '张嘴就直接接对方说的内容，第一句别去评价对方这句话本身；不要收尾金句'\n"
              "    );")
F_PUSH_NEW = ("        + '张嘴就直接接对方说的内容，第一句别去评价对方这句话本身；不要收尾金句'\n"
              "    );\n"
              "    // >>> human-shape patch >>>\n"
              "    // 用户 2026-10-10：「稍微学一学其他人说话」。只借**形状**不借内容（见脚本头注释）。\n"
              "    const shapeText = typeof humanShapeHint === 'string' ? humanShapeHint.trim() : '';\n"
              "    if (shapeText) warnings.push(shapeText);\n"
              "    // <<< human-shape patch <<<")


def node_check(p):
    try:
        r = subprocess.run([NODE, "--check", p], capture_output=True, text=True, timeout=60)
        return r.returncode == 0, (r.stderr or "").strip()
    except Exception as e:
        return False, str(e)


# ---- PNG 读写
def read_chunks(raw):
    out, pos = [], 8
    while pos < len(raw):
        (ln,) = struct.unpack(">I", raw[pos:pos + 4])
        out.append((raw[pos + 4:pos + 8], raw[pos + 8:pos + 8 + ln]))
        pos += 12 + ln
    return out


def write_chunks(chunks):
    out = [b"\x89PNG\r\n\x1a\n"]
    for ct, d in chunks:
        out += [struct.pack(">I", len(d)), ct, d,
                struct.pack(">I", zlib.crc32(ct + d) & 0xFFFFFFFF)]
    return b"".join(out)


def payload_idx(chunks):
    r = []
    for i, (ct, d) in enumerate(chunks):
        if ct in (b"tEXt", b"iTXt"):
            if d.split(b"\x00", 1)[0].decode("latin-1") in ("chara", "ccv3"):
                r.append(i)
    return r


def get_fields(p):
    chunks = read_chunks(pathlib.Path(p).read_bytes())
    for i in payload_idx(chunks):
        kw, _, v = chunks[i][1].partition(b"\x00")
        o = json.loads(base64.b64decode(v).decode("utf-8"))
        return o.get("data") if isinstance(o.get("data"), dict) else o
    raise SystemExit("!! no chunk")


def put_fields(p, fields, stamp, tag):
    bak = str(p) + ".bak-" + stamp + "-" + tag
    shutil.copy2(p, bak)
    chunks = read_chunks(pathlib.Path(p).read_bytes())
    before = [c for c, _ in chunks]
    for i in payload_idx(chunks):
        kw, _, v = chunks[i][1].partition(b"\x00")
        o = json.loads(base64.b64decode(v).decode("utf-8"))
        t = o.get("data") if isinstance(o.get("data"), dict) else o
        for k, val in fields.items():
            if k in t:
                t[k] = val
        chunks[i] = (chunks[i][0], kw + b"\x00" + base64.b64encode(json.dumps(o, ensure_ascii=False).encode()))
    if before != [c for c, _ in chunks]:
        return False, "chunk 清单变了"
    pathlib.Path(p).write_bytes(write_chunks(chunks))
    back = get_fields(p)
    for k, v in fields.items():
        if back.get(k) != v:
            shutil.copy2(bak, p)
            return False, f"回读不符: {k}"
    return True, os.path.basename(bak)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()
    dry = args.dry or args.check          # ⚠ --check 先折进 dry
    rev = args.revert
    stamp = time.strftime("%Y%m%d-%H%M%S")

    for name, root in ROOTS.items():
        print("=" * 78)
        print(name)

        # ---------- B1 prompt.js
        for fname, pairs in (("prompt.js", [(P_OLD, P_NEW)]),
                             ("current-message-focus.js",
                              [(F_SIG_OLD, F_SIG_NEW), (F_OPT_OLD, F_OPT_NEW), (F_PUSH_OLD, F_PUSH_NEW)])):
            p = root / "src" / fname
            src = p.read_text(encoding="utf-8")
            out = src
            notes = []
            for old, new in pairs:
                # a=替换成什么, b=找什么（正向 patch: old→new）。这个三元式我写反过三次。
                a, b = (new, old) if not rev else (old, new)
                if MARKED := ("human-shape patch" in b):
                    pass
                if b not in out:
                    notes.append("SKIP")
                    continue
                if out.count(b) != 1:
                    notes.append(f"锚点{out.count(b)}次")
                    continue
                out = out.replace(b, a, 1)
                notes.append("ok")
            if out == src:
                print(f"  {fname}  -- 无改动 ({','.join(notes)})")
                continue
            if dry:
                print(f"  {fname}  DRY {len(src)} -> {len(out)} ({','.join(notes)})")
                continue
            bak = str(p) + ".bak-" + stamp + "-shape"
            shutil.copy2(p, bak)
            p.write_text(out, encoding="utf-8", newline="")
            ok, err = node_check(str(p))
            if not ok:
                shutil.copy2(bak, p)
                print(f"  {fname}  !! 语法失败已还原: {err[:140]}")
            else:
                print(f"  {fname}  OK {len(src)}->{len(out)} ({','.join(notes)})")

        # ---------- B2 config humanShapeHint
        cp = root / "config.json"
        obj = json.loads(cp.read_text(encoding="utf-8"))
        chat = obj.setdefault("chat", {})
        if rev:
            if chat.get("humanShapeHint"):
                chat.pop("humanShapeHint", None)
                bak = str(cp) + ".bak-" + stamp + "-shape"
                shutil.copy2(cp, bak)
                cp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
                print(f"  config    REVERTED humanShapeHint")
            else:
                print("  config    -- 本来就没有")
        elif chat.get("humanShapeHint") == SHAPE:
            print("  config    -- 已是目标值")
        elif dry:
            print(f"  config    DRY humanShapeHint = {SHAPE[:34]}…")
        else:
            chat["humanShapeHint"] = SHAPE
            bak = str(cp) + ".bak-" + stamp + "-shape"
            shutil.copy2(cp, bak)
            cp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
            back = json.loads(cp.read_text(encoding="utf-8"))["chat"].get("humanShapeHint")
            print(f"  config    {'OK' if back == SHAPE else '!! 回读不符'}  备份={os.path.basename(bak)}")

        # ---------- A 多轮示例
        card = CARDS[name]
        f = get_fields(card)
        ex = f["mes_example"]
        flow = FLOWS[name]
        tail = CARD_TAIL[name]
        n_blk = flow.count("<START>")
        if rev:
            if flow in ex:
                nex = ex.replace(flow, "", 1).rstrip() + ""
                ok, info = put_fields(card, {"mes_example": nex}, stamp, "flows")
                print(f"  {card.name}  {'REVERTED' if ok else '!! ' + info}")
            else:
                print(f"  {card.name}  -- 没找到多轮块")
            continue
        if flow in ex:
            print(f"  {card.name}  -- 多轮块已在（{n_blk} 段）")
            continue
        if ex.count(tail) != 1:
            print(f"  {card.name}  !! 尾部锚点 {ex.count(tail)} 次，跳过")
            continue
        nex = ex + "\n" + flow if not ex.endswith("\n") else ex + flow
        if dry:
            print(f"  {card.name}  DRY ex {len(ex)} -> {len(nex)}  追加 {n_blk} 段多轮")
            continue
        ok, info = put_fields(card, {"mes_example": nex}, stamp, "flows")
        if not ok:
            print(f"  {card.name}  !! {info}")
        else:
            back = get_fields(card)["mes_example"]
            hit = sum(1 for k in ("真……真不留情", "希望你能分发给人类", "小爽世和阿姨")
                      if k in back)
            print(f"  {card.name}  OK ex {len(ex)}->{len(back)}  块数={back.count('<START>')}  "
                  f"抽样命中={hit}  备份={info}")

    if args.check:
        print("\n(--check 只报告，未写入)")


if __name__ == "__main__":
    main()
