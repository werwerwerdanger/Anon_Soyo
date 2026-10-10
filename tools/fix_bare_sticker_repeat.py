#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fix_bare_sticker_repeat.py -- 修「光一张表情包 → 把上一条复读一遍」

用户 2026-10-10：「为什么爱音一句话发了两遍」

现象（DB 实证）：
    10:50:11  爱音: 舞萌?那个圆圆的屏幕要转圈打的那个吗 / 玩过几次 手忙脚乱的 老按错
    10:50:42  用户: [图片:[动画表情]]
    10:51:02  爱音: 玩过几次 手忙脚乱的 老按错        <-- 把上一条的后半句又发了一遍

排查结论（都不是"重复下发"）：
  · 日志显示两轮各只调用一次模型、各只下发一次 ⇒ 不是发送层重复；
  · 卡/世界书里没有这句话（不是抄示例）；
  · 重建提示词：`historyAssistantTrim` 生效，被裁成首行
    「舞萌?那个圆圆的屏幕要转圈打的那个吗」⇒ 模型**没看到**那半句。

🔴 根因：模型自己的 reasoning 招供了 ——
    "The user sent an animated emoji (sticker). **The guidance says default to
     ignoring stickers and continue talking about text.** The last text was
     "你会打舞萌吗" and my reply was already about 舞萌. …"
  它在**引用我们写的规则**：
    「默认不用管表情包…**就当对方没发过一样，接着聊文字**」

  这条规则**在图 + 文字时是对的**；但**整条消息只有一张图**时，
  "就当对方没发过" = 把它当成空消息 ⇒ 模型手上只剩「上一条话题」这个素材
  ⇒ 唯一合理的产出就是**把上一条接着说一遍**（短句时几近逐字重复）。

修复口径：把「就当没发过」拆成两种情况，并明确禁止复读。
  · 图 + 文字  → 只答文字（保持原意图：不解析表情包）
  · 只有一张图 → 回一两个字的反应（嗯/哈/哦/？），也可以不回，**但绝不重复上一条**
  · 被明确问图 → 才看图回答

⚠ 顺带发现：`default_ignore_stickers.py` 把素世的图片示例**全删了**（爱音留了
  「[收到一张图]→哈」），所以素世连"空图该怎么回"的示例都没有 ⇒ 一起补。

用法: python fix_bare_sticker_repeat.py --check | --dry | (无参) | --revert
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

SRC_DIRS = [r"C:\Users\20633\MimirLink\src", r"C:\Users\20633\MimirLink-soyo\src"]
ANON_CARD = r"C:\Users\20633\MimirLink\data\characters\Anon_Chihaya.png"
SOYO_CARD = r"C:\Users\20633\MimirLink-soyo\data\characters\Soyo_Nagasaki.png"

MARK = "// >>> bare-sticker patch >>>"
MARK_E = "// <<< bare-sticker patch <<<"

JS_OLD = ("        warnings.push('默认不用管表情包，不要提它、不要描述画面、不要念图上的字，'\n"
          "            + '就当对方没发过一样接着聊文字；只有对方明确让你看图、或问你图里是什么时才看图');")
JS_NEW = ("        " + MARK + "\n"
          "        // 用户 2026-10-10：'就当对方没发过一样' 在**空图**时会让她复读上一条\n"
          "        // （模型 reasoning 原话就引用了这句规则）。拆成两种情况 + 明令禁止复读。\n"
          "        warnings.push('默认不用管表情包，不要提它、不要描述画面、不要念图上的字。'\n"
          "            + '图里还带了文字就只答那些文字；整条消息只有一张图、没有文字的时候，'\n"
          "            + '不要重复你上一条说过的话 —— 回一两个字的反应就行（嗯、哈、哦、？），'\n"
          "            + '也可以干脆不回。只有对方明确让你看图、或问你图里是什么时才看图');\n"
          "        " + MARK_E)

ANON_RULE_OLD = ('- 默认不用管表情包。表情包一般没什么特别意思——不要提它、不要描述它、'
                 '也不要猜它是什么、不要念图上的字，就当对方没发过一样，接着聊文字。')
ANON_RULE_NEW = ('- 默认不用管表情包。表情包一般没什么特别意思——不要提它、不要描述它、'
                 '也不要猜它是什么、不要念图上的字。图里带了文字就只答那些文字。'
                 '整条消息只有一张图、没有文字的时候：回一两个字的反应就行（嗯、哈、哦、？），'
                 '也可以什么都不说，但**千万别把你上一条说过的话再说一遍**。')

SOYO_RULE_OLD = ('18. 默认不用管表情包。表情包一般没什么特别意思——不要提它、不要描述它、'
                 '也不要猜它是什么、不要念图上的字，就当对方没发过一样，接着聊文字。'
                 '只有对方明确让你看图、或者问你图里是什么的时候，才去看图的内容并回答。')
SOYO_RULE_NEW = ('18. 默认不用管表情包。表情包一般没什么特别意思——不要提它、不要描述它、'
                 '也不要猜它是什么、不要念图上的字。图里带了文字就只答那些文字。'
                 '整条消息只有一张图、没有文字的时候：回一两个字就行（嗯、？），'
                 '也可以不回，但不要把你上一条说过的话再说一遍。'
                 '只有对方明确让你看图、或者问你图里是什么的时候，才去看图的内容并回答。')

# 素世缺"空图"示例（爱音有「[收到一张图]→哈」），补一个，放在示例末尾
SOYO_EX_TAIL = "{{char}}: 你自己去跟她解释"
SOYO_EX_ADD = """
<START>
{{user}}: [收到一张图]
{{char}}: 嗯"""


def node_check(p):
    try:
        r = subprocess.run(["node", "--check", p], capture_output=True, text=True, timeout=60)
        return r.returncode == 0, (r.stderr or "").strip()
    except Exception as e:
        return False, str(e)


def read_chunks(raw):
    out, pos = [], 8
    while pos < len(raw):
        (ln,) = struct.unpack(">I", raw[pos:pos + 4])
        out.append((raw[pos + 4:pos + 8], raw[pos + 8:pos + 8 + ln]))
        pos += 12 + ln
    return out


def write_chunks(chunks):
    out = [b"\x89PNG\r\n\x1a\n"]
    for ctype, data in chunks:
        out.append(struct.pack(">I", len(data)))
        out.append(ctype)
        out.append(data)
        out.append(struct.pack(">I", zlib.crc32(ctype + data) & 0xFFFFFFFF))
    return b"".join(out)


def payload_idx(chunks):
    r = []
    for i, (ctype, data) in enumerate(chunks):
        if ctype in (b"tEXt", b"iTXt"):
            kw = data.split(b"\x00", 1)[0].decode("latin-1")
            if kw in ("chara", "ccv3"):
                r.append(i)
    return r


def get_fields(path):
    chunks = read_chunks(pathlib.Path(path).read_bytes())
    for i in payload_idx(chunks):
        kw, _, val = chunks[i][1].partition(b"\x00")
        obj = json.loads(base64.b64decode(val).decode("utf-8"))
        return obj.get("data") if isinstance(obj.get("data"), dict) else obj
    raise SystemExit("!! no chunk")


def put_fields(path, fields, stamp):
    p = pathlib.Path(path)
    bak = p.with_suffix(p.suffix + ".bak-" + stamp + "-baresticker")
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
        return False, "chunk 清单变了"
    p.write_bytes(write_chunks(chunks))
    back = get_fields(path)
    for k, v in fields.items():
        if back.get(k) != v:
            shutil.copy2(bak, path)
            return False, f"回读不符: {k}"
    return True, bak.name


def do_js(dry, revert, stamp):
    for d in SRC_DIRS:
        p = os.path.join(d, "current-message-focus.js")
        src = open(p, encoding="utf-8").read()
        if revert:
            if MARK not in src:
                print(f"  {p}\n    -- 没打过，跳过")
                continue
            out = src.replace(JS_NEW, JS_OLD, 1)
        else:
            if MARK in src:
                print(f"  {p}\n    -- 已打过")
                continue
            if src.count(JS_OLD) != 1:
                print(f"  {p}\n    !! 锚点命中 {src.count(JS_OLD)} 次")
                continue
            out = src.replace(JS_OLD, JS_NEW, 1)
        if dry:
            print(f"  {p}\n    DRY {len(src)} -> {len(out)}")
            continue
        bak = p + ".bak-" + stamp + "-baresticker"
        shutil.copy2(p, bak)
        open(p, "w", encoding="utf-8", newline="").write(out)
        ok, err = node_check(p)
        if not ok:
            shutil.copy2(bak, p)
            print(f"  {p}\n    !! node --check 失败，已还原\n       {err[:200]}")
            continue
        after = open(p, encoding="utf-8").read()
        good = ("不要重复你上一条说过的话" in after) if not revert else ("就当对方没发过一样" in after)
        print(f"  {p}\n    OK {len(src)}->{len(out)}  断言={'通过' if good else '失败'}  备份={os.path.basename(bak)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()
    stamp = time.strftime("%Y%m%d-%H%M%S")

    print("=" * 74)
    print("1) JS：注意行（两实例，改完需重启 node）")
    # ⚠ `--check` 必须**在进入任何写入路径之前**处理掉：
    #    这里把 check 折进 dry（dry = 不写盘），否则 do_js 会真的改文件。
    #    fix_soyo_twist.py 栽过一次，本脚本第一版又栽了一次（见 NOTES §9）。
    do_js(args.dry or args.check, args.revert, stamp)
    if args.check:
        print("  (--check 只报告，未写入)")
        return

    print("=" * 74)
    print("2) anon 卡规则")
    f = get_fields(ANON_CARD)
    if args.revert:
        if ANON_RULE_NEW in f["system_prompt"]:
            ok, i = put_fields(ANON_CARD, {"system_prompt": f["system_prompt"].replace(ANON_RULE_NEW, ANON_RULE_OLD, 1)}, stamp)
            print("    REVERTED" if ok else f"    !! {i}")
    elif args.check or f["system_prompt"].count(ANON_RULE_OLD) != 1:
        print(f"    锚点={f['system_prompt'].count(ANON_RULE_OLD)}  已改={ANON_RULE_NEW in f['system_prompt']}")
    else:
        ns = f["system_prompt"].replace(ANON_RULE_OLD, ANON_RULE_NEW, 1)
        if args.dry:
            print(f"    DRY {len(f['system_prompt'])} -> {len(ns)}")
        else:
            ok, i = put_fields(ANON_CARD, {"system_prompt": ns}, stamp)
            print(f"    OK {len(f['system_prompt'])}->{len(ns)}  备份={i}" if ok else f"    !! {i}")

    print("=" * 74)
    print("3) soyo 卡规则 + 补空图示例")
    g = get_fields(SOYO_CARD)
    sp, ex = g["system_prompt"], g["mes_example"]
    if args.revert:
        nsp = sp.replace(SOYO_RULE_NEW, SOYO_RULE_OLD, 1)
        nex = ex.replace(SOYO_EX_ADD, "", 1)
        ok, i = put_fields(SOYO_CARD, {"system_prompt": nsp, "mes_example": nex}, stamp)
        print("    REVERTED" if ok else f"    !! {i}")
        return
    bad = []
    if sp.count(SOYO_RULE_OLD) != 1:
        bad.append(f"规则锚点={sp.count(SOYO_RULE_OLD)}")
    if ex.count(SOYO_EX_TAIL) < 1:
        bad.append(f"示例尾锚点={ex.count(SOYO_EX_TAIL)}")
    if bad:
        print("    !! " + "; ".join(bad))
        return
    nsp = sp.replace(SOYO_RULE_OLD, SOYO_RULE_NEW, 1)
    nex = ex if SOYO_EX_ADD.strip() in ex else ex.replace(SOYO_EX_TAIL, SOYO_EX_TAIL + SOYO_EX_ADD, 1)
    if args.dry:
        print(f"    DRY sp {len(sp)}->{len(nsp)}  ex {len(ex)}->{len(nex)}")
        return
    ok, i = put_fields(SOYO_CARD, {"system_prompt": nsp, "mes_example": nex}, stamp)
    if not ok:
        print("    !!", i)
        return
    back = get_fields(SOYO_CARD)
    probs = []
    if "不要把你上一条说过的话再说一遍" not in back["system_prompt"]:
        probs.append("新规则缺失")
    if "[收到一张图]\n{{char}}: 嗯" not in back["mes_example"]:
        probs.append("空图示例缺失")
    print(f"    OK sp {len(sp)}->{len(nsp)}  ex {len(ex)}->{len(nex)}  备份={i}")
    print("    断言:", "通过" if not probs else "!! " + "; ".join(probs))


if __name__ == "__main__":
    main()
