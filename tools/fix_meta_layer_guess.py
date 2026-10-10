#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fix_meta_layer_guess.py -- 堵住「现实层」的编造口子

用户（2026-10-10 14:42）：「soyo出幻觉了」

### 现场
```
私聊 14:41:10  werwer: 你觉得高尾奏音长得怎么样
私聊 14:41:14  素世:  ……那是配小睦的人吧 / 你去问她本人啊
```
**事实（已联网核实，多来源一致）**：
    丰川祥子 → CV **高尾奏音**
    若叶睦   → CV **渡濑结月**
⇒ 「高尾奏音 = 配小睦的人」是**错**的（那是祥子的声优）；
「你去问她本人啊」更进一步，把现实里的声优当成戏里能联系到的人。

- 全库检索：「高尾 / 奏音 / 声优 / 配音」在 14:41 之前**一次都没出现过** ⇒ 没有语境误导。
- 世界书 16 条里**没有任何声优/中之人内容**。⇒ 这句纯粹是基座知识硬编。

### 🔴 根因不是「缺一条规则」，是卡里本来就有条规则**打开**了现实层
两张卡的 `system_prompt` 都写着：
    「你们经历过的事都是真的；后来有人把这段故事拍成了动画，**你们是本人出演**。
      所以拍摄这回事你是知道的，**也认识柿本监督和一起工作的人**。」
这条本意是让它们能接「拿拍摄开玩笑」的梗（是有意加的，保留）。
但它同时告诉模型：**现实里有人，而且她认识**。而卡里对声优/演员**一个字都没给**
⇒ 模型顺着这个口子用自己的世界知识补，补错了。

现有的反编造清单也只覆盖戏内东西（吃的、去哪、谁说过什么、哪部片子），
**没有一个字提到现实世界的真人**，所以挡不住。

### 修法
保留「可以聊拍摄」，但把**认人范围钉死在剧组那一圈**，并明确禁止给现实里的人安身份：
- 素世：新增第 21b 条（挂在第 21 条后面）
- 爱音：新增一条（挂在那两条「本人出演」规则后面）
核心两句：**「谁给谁配音、谁演过谁，一个都别猜别说」** +
**「对方报一个你不认识的真名，就当没听过，绝不能给对方安身份或关系」**。

⚠ 不选的做法：把正确的声优对照表写进世界书 —— 那会把戏外信息正式引入戏内，
   等于鼓励出戏，而且下次还会错（表不可能全）。要答对这类问题应该由「戏外」处理，
   不该让角色本人去背现实资料。

用法: python fix_meta_layer_guess.py --check | (无参) | --revert
"""
import argparse
import base64
import io
import json
import os
import pathlib
import shutil
import struct
import sys
import time
import zlib

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

CARDS = {
    "soyo": pathlib.Path(r"C:\Users\20633\MimirLink-soyo\data\characters\Soyo_Nagasaki.png"),
    "anon": pathlib.Path(r"C:\Users\20633\MimirLink\data\characters\Anon_Chihaya.png"),
}

# ---------------- 素世：第 21 条后面挂 21b
SOYO_ANCHOR = (
    "21. 你们经历过的事都是真的；后来有人把这段故事拍成了动画，你们是本人出演。"
    "所以拍摄这回事你是知道的，也认识柿本监督和一起工作的人。别人拿这个开玩笑，"
    "你可以接、可以淡淡吐槽一句。但不要跳出来谈设定、人设、提示词，也不要讨论自己是不是机器人。"
)
SOYO_ADD = (
    "\n21b. **现实里的真人你只认识剧组那一圈，别的都不认识。**"
    "谁给谁配音、谁演过谁、哪个声优配的是哪个角色 —— 这种一个都别猜、别说。"
    "对方报一个你不认识的真名（声优、演员、真人歌手、制作人、画师），就当没听过："
    "可以反问一句，可以说不知道，但**绝不能给对方安一个身份、关系或者过往**。"
    "名字和角色对不上、或者你自己也拿不准的时候，宁可什么都不说 —— 编一个是最差的选项。"
)

# ---------------- 爱音：那两条「本人出演」规则后面挂一条
ANON_ANCHOR = (
    "- 别人拿这个开玩笑，你可以接、可以吐槽拍摄时的事（重拍、紧张、首映之类）。"
    "但不要跳出来谈设定、人设、提示词，也不要讨论自己是不是机器人。"
)
ANON_ADD = (
    "\n- **现实里的真人你只认识剧组那一圈，别的都不认识。**"
    "谁给谁配音、谁演过谁、哪个声优配哪个角色 —— 一个都别猜、别说。"
    "对方报一个你不认识的真名（声优、演员、真人歌手、制作人、画师），就当没听过，"
    "「不知道啊」「谁?」都行，**绝对不能给对方安一个身份或关系**。"
    "拿不准就说不认识，别硬猜。"
)

PLAN = {"soyo": (SOYO_ANCHOR, SOYO_ADD, "21b."), "anon": (ANON_ANCHOR, ANON_ADD, "现实里的真人你只认识剧组那一圈")}

DRY = False


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
    chunks = read_chunks(p.read_bytes())
    for i in payload_idx(chunks):
        kw, _, v = chunks[i][1].partition(b"\x00")
        o = json.loads(base64.b64decode(v).decode("utf-8"))
        return o.get("data") if isinstance(o.get("data"), dict) else o
    raise SystemExit("!! no chunk")


def put_fields(p, fields, stamp, tag):
    bak = str(p) + ".bak-" + stamp + "-" + tag
    if not DRY:
        shutil.copy2(p, bak)
    chunks = read_chunks(p.read_bytes())
    before = [c for c, _ in chunks]
    for i in payload_idx(chunks):
        kw, _, v = chunks[i][1].partition(b"\x00")
        o = json.loads(base64.b64decode(v).decode("utf-8"))
        t = o.get("data") if isinstance(o.get("data"), dict) else o
        for k, val in fields.items():
            if k in t:
                t[k] = val
        chunks[i] = (chunks[i][0],
                     kw + b"\x00" + base64.b64encode(json.dumps(o, ensure_ascii=False).encode()))
    if before != [c for c, _ in chunks]:
        return False, "chunk 清单变了"
    if DRY:
        return True, "(dry-run 未写入)"
    p.write_bytes(write_chunks(chunks))
    back = get_fields(p)
    for k, v in fields.items():
        if back.get(k) != v:
            shutil.copy2(bak, p)
            return False, f"回读不符: {k}"
    return True, os.path.basename(bak)


def main():
    global DRY
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()
    DRY = bool(args.check)      # 🔴 --check 先折成 dry
    stamp = time.strftime("%Y%m%d-%H%M%S")

    for tag, card in CARDS.items():
        anchor, add, probe = PLAN[tag]
        f = get_fields(card)
        sp = f["system_prompt"]
        print(f"\n[{tag}] system_prompt {len(sp)} 字")
        if add.strip() in sp or probe in sp:
            print("  -- 已加过；按下面这几条复核现状")
            probs = []
            if "一个都别猜、别说" not in sp:
                probs.append("新规则缺失")
            if "能给对方安一个身份" not in sp:
                probs.append("禁止安身份那句缺失")
            if sp.count(anchor) != 1:
                probs.append(f"原锚点={sp.count(anchor)}")
            print("  断言:", "通过" if not probs else "!! " + "; ".join(probs))
            continue
        if sp.count(anchor) != 1:
            print(f"  !! 锚点={sp.count(anchor)}，跳过")
            continue

        if args.revert:
            ok, info = put_fields(card, {"system_prompt": sp.replace(add, "", 1)}, stamp, "metalayer-revert")
            print(f"  REVERTED 备份={info}" if ok else f"  !! {info}")
            continue

        nsp = sp.replace(anchor, anchor + add, 1)
        ok, info = put_fields(card, {"system_prompt": nsp}, stamp, "metalayer")
        if not ok:
            print(f"  !! {info}")
            continue
        # dry-run 时文件没写，断言就针对「将要写入的内容」
        back = nsp if DRY else get_fields(card)["system_prompt"]
        probs = []
        if "一个都别猜、别说" not in back:
            probs.append("新规则缺失")
        if "能给对方安一个身份" not in back:
            probs.append("禁止安身份那句缺失")
        if back.count(anchor) != 1:
            probs.append("原锚点被破坏")
        print(f"  备份={info}  长度 {len(sp)} -> {len(back)}")
        print("  断言:", "通过" if not probs else "!! " + "; ".join(probs))

    if args.check:
        print("\n--check：以上为预演，未写入。")
    else:
        print("\n⚠ 角色卡热加载，无需重启。")


if __name__ == "__main__":
    main()
