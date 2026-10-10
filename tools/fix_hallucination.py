#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fix_hallucination.py -- 治「开始编一些没有的东西」（用户 2026-10-10）

三个结构性原因，两个是我自己埋的：

============================================================
1) 🔴🔴 `historyAssistantTrim` 把她的历史压成**重复碎片**
============================================================
实测（装配后的提示词 vs DB 原文）：

    她实际说的                                裁进提示词的
    没有那种东西 / 去吃饭                     没有那种东西
    没有那种东西 / 食堂就在楼下 自己下去        没有那种东西
    谁跟你说的 / 小爱音才不会说这种话 / 睦就更不会了   谁跟你说的

⇒ 她看到的「自己」是**三条一模一样的「没有那种东西」**，语义全丢。
  她不知道自己刚才在说什么，只能**靠编来补上下文**。
  而且重复碎片还会加固模板（她的 reasoning 里出现「不要重复'没有那种东西'」——
  她在跟这个碎片历史搏斗）。

原实现是「只留首行、再切到 24 字」，本意是压「历史自我强化」（她看自己写长的就跟着写长）。
但**长度**现在由「注意:」行的长度锚点 + `humanShapeHint` 管着（那是最杠杆的位置），
不需要再用毁掉语义的方式去压。

⇒ 改成**留前 2 行、总长 ≤40 字**：既保住"她在说什么"，又仍然比原来短得多。
   仍然做成 config 可调（`historyAssistantMaxLines` / `historyAssistantMaxChars`）。

============================================================
2) 🔴 素世卡**完全没有防编造规则**
============================================================
`anon` 卡里有一句「不确定就直说，别编」，素世卡里**一条都没有**。

============================================================
3) 🔴 我加的「拧巴」规则在鼓励编造，却没给边界
============================================================
规则 18 说「先收掉 → 紧接着漏一句真心话（……你们几点结束、……明天记得吃饭、
……本来还想着你能来）」——**「漏一句真心」= 邀请模型新造一个具体细节**。
线上实测到的 `有这工夫不如先把火锅吃了` 正是这个形状（会话里从没出现过火锅）。

⇒ 给规则 18 加**边界**：漏真心 = 说态度和情绪，**不是编外部事实**。
   想表达在意，只能用「手上真有的事」（对方刚说的、现在几点、刚才那句）。

用法: python fix_hallucination.py --check | --dry | (无参) | --revert
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

# ---------------------------------------------------------------- 1 历史裁剪
TRIM_OLD = """        const shortenHistoryAssistant = (content) => {
            const raw = String(content === undefined || content === null ? '' : content);
            if (!trimOn) return raw;
            const firstLine = raw.split(/\\r?\\n/)
                .map((part) => part.trim())
                .filter(Boolean)[0] || raw.trim();
            return firstLine.length > trimMax ? firstLine.slice(0, trimMax) : firstLine;
        };"""
TRIM_NEW = """        // >>> hallucination-fix patch >>>
        // 🔴 原实现「只留首行 + 切到 24 字」把她的历史压成了**重复碎片**：
        //      没有那种东西 / 去吃饭        → 没有那种东西
        //      没有那种东西 / 食堂就在楼下   → 没有那种东西
        //      谁跟你说的 / 小爱音才不会…    → 谁跟你说的
        //    ⇒ 她看到的自己是一串一模一样的短语，**只能靠编来补上下文**。
        //    （reasoning 里实测出现过「不要重复'没有那种东西'」——她在跟碎片搏斗。）
        // 长度改由「注意:」行的长度锚点 + chat.humanShapeHint 管（最高杠杆位置），
        // 历史只需要**保住"她在说什么"**。⇒ 留前 N 行、总长 ≤ M 字。
        const trimLinesRaw = Number(trimChatCfg?.historyAssistantMaxLines);
        const trimLinesMax = Number.isFinite(trimLinesRaw) && trimLinesRaw > 0
            ? Math.floor(trimLinesRaw) : 2;
        const shortenHistoryAssistant = (content) => {
            const raw = String(content === undefined || content === null ? '' : content);
            if (!trimOn) return raw;
            const lines = raw.split(/\\r?\\n/).map((part) => part.trim()).filter(Boolean);
            if (!lines.length) return raw.trim();
            let out = '';
            for (const line of lines.slice(0, trimLinesMax)) {
                const next = out ? (out + '\\n' + line) : line;
                if (next.length > trimMax) break;
                out = next;
            }
            if (!out) out = lines[0].slice(0, trimMax);
            return out;
        };
        // <<< hallucination-fix patch <<<"""

# ---------------------------------------------------------------- 2/3 卡片
SOYO_TAIL_OLD = ("    大概三四条里有一条这样就行，不用每条都补；但一整段对话里一句都不漏，就不像你了。")
SOYO_TAIL_NEW = ("    大概三四条里有一条这样就行，不用每条都补；但一整段对话里一句都不漏，就不像你了。\n"
                 "    🔴 **边界：「漏真心」说的是态度和情绪（其实在意、舍不得、早就知道），"
                 "不是编事实。**\n"
                 "    不能凭空说出对话里没有的东西 —— 没聊过火锅就别提火锅，没约过的事别当发生过。\n"
                 "    想表达在意，只用你手上真有的事（对方刚说的、现在几点、刚才那一句），"
                 "不要新造一个。不确定的就别说，或者直接问。")

ANON_OLD = "- 不确定就直说，别编。不要自称 AI、模型或助手，不要暴露内部推理。"
ANON_NEW = ("- 不确定就直说，别编。**对话里没出现过的具体东西（吃的、去哪、谁说过什么、"
            "什么时候的事、哪部片子）不要说成真的** —— 那是编，不是随口聊。"
            "想接话就用对方刚说的、或者你手上真有的事。不确定就说不确定，或者直接问。\n"
            "- 不要自称 AI、模型或助手，不要暴露内部推理。")


def node_check(p):
    try:
        r = subprocess.run([NODE, "--check", p], capture_output=True, text=True, timeout=60)
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
    dry = args.dry or args.check
    rev = args.revert
    stamp = time.strftime("%Y%m%d-%H%M%S")

    for name, root in ROOTS.items():
        print("=" * 78)
        print(name)

        # ---- 1 prompt.js 历史裁剪
        p = root / "src" / "prompt.js"
        src = p.read_text(encoding="utf-8")
        a, b = (TRIM_NEW, TRIM_OLD) if not rev else (TRIM_OLD, TRIM_NEW)
        if b not in src:
            print("  1) 历史裁剪  -- 锚点未命中" + ("（可能已改）" if "hallucination-fix" in src else ""))
        else:
            out = src.replace(b, a, 1)
            if dry:
                print(f"  1) 历史裁剪  DRY {len(src)} -> {len(out)}")
            else:
                bak = str(p) + ".bak-" + stamp + "-histfix"
                shutil.copy2(p, bak)
                p.write_text(out, encoding="utf-8", newline="")
                ok, err = node_check(str(p))
                if not ok:
                    shutil.copy2(bak, p)
                    print(f"  1) !! 语法失败已还原 {err[:140]}")
                else:
                    print(f"  1) OK {len(src)}->{len(out)}")

        # ---- 1b config 行数上限
        cp = root / "config.json"
        obj = json.loads(cp.read_text(encoding="utf-8"))
        chat = obj.setdefault("chat", {})
        if rev:
            chat["historyAssistantMaxChars"] = 24
            chat.pop("historyAssistantMaxLines", None)
        else:
            chat["historyAssistantMaxLines"] = 2
            chat["historyAssistantMaxChars"] = 40
        if not dry:
            bak = str(cp) + ".bak-" + stamp + "-histfix"
            shutil.copy2(cp, bak)
            cp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
            back = json.loads(cp.read_text(encoding="utf-8"))["chat"]
            print(f"  1b config  historyAssistantMaxLines={back.get('historyAssistantMaxLines')} "
                  f"MaxChars={back.get('historyAssistantMaxChars')}")
        else:
            print(f"  1b config  DRY MaxLines=2 MaxChars=40")

        # ---- 2/3 卡片
        card = CARDS[name]
        f = get_fields(card)
        sp = f["system_prompt"]
        old, nw = (ANON_OLD, ANON_NEW) if name == "MimirLink" else (SOYO_TAIL_OLD, SOYO_TAIL_NEW)
        a2, b2 = (nw, old) if not rev else (old, nw)
        if b2 not in sp:
            print("  2/3 卡片    -- 锚点未命中" + ("（可能已改）" if a2 in sp else ""))
        elif dry:
            print(f"  2/3 卡片    DRY sp {len(sp)} -> {len(sp.replace(b2, a2, 1))}")
        else:
            ns = sp.replace(b2, a2, 1)
            ok, info = put_fields(card, {"system_prompt": ns}, stamp, "anti")
            if ok:
                back = get_fields(card)["system_prompt"]
                key = "边界" if name != "MimirLink" else "对话里没出现过的具体东西"
                print(f"  2/3 卡片    OK sp {len(sp)}->{len(back)}  断言={'通过' if key in back else '失败'}  备份={info}")
            else:
                print(f"  2/3 卡片    !! {info}")

    if args.check:
        print("\n(--check 只报告，未写入)")


if __name__ == "__main__":
    main()
