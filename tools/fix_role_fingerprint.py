#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fix_role_fingerprint.py -- 按**官方剧情全量语料**修两个角色的指纹

背景（2026-10-10 用户：「原作番剧加上漫画光叫 soyorin 都不止 31 句」）：
原来的基线是维基语录+米游社语音凑的 39 / 30 条"名场面选集"，
样本小 + 有偏 ⇒ 之前基于它做的判断**有一大半是错的**。

新基线：GitHub `ci-ke/BangDream-story` 的 `story_cn/`（官方游戏剧情中文文本，
6767 个 txt），抽取出 **爱音 2248 条 / 爽世 1724 条**。

⚠ 方法论修正（用旧基线犯的错）：
  · 熵依赖样本量：官方 n=2107 时上限 log2(2107)=11，线上 n=61 只有 5.93。
    直接比 = 必输。必须**稀释（rarefaction）**到同一个 n 再比。
  · 「叹词开头率」不是好判据：官方爱音 **26%**，线上 38% —— 同量级。

稀释到同 n 后的真实差距：
  爱音(各 n=61)  官方 / 线上
    首字最高频    11.4% / 28%   ← 「欸」一个人占了 28%
    首字熵         4.84 / 4.23
    有 !           36% / 52%
    有 ~          22.8% / 11%
  爽世(各 n=35)
    省略号开头    18.1% / 0%    ← 完全缺失
    「小X」称呼     21% / 0%（卡里也是 0 次）  ← 完全缺失
    中位长度       14.9 / 8

全语料用字统计（6767 文件）：诶 12299 / 咦 3442 / 唔 3330 / **欸 187** / 誒 0
  ⇒ **「欸」比「诶」罕见 66 倍**。我们一直在教她用官方几乎不用的字。

⚠ 语料语域的局限：官方剧情是**游戏对白**（完整句子），线上目标是**手机打字**。
  所以只借「用哪个字 / 怎么称呼人 / 开场怎么变」这类**角色标记**，
  不借长度与标点率这类**语域特征**。

用法:
  python fix_role_fingerprint.py --check | --dry | (无参) | --revert
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

ANON_CARD = r"C:\Users\20633\MimirLink\data\characters\Anon_Chihaya.png"
SOYO_CARD = r"C:\Users\20633\MimirLink-soyo\data\characters\Soyo_Nagasaki.png"

# ================================================================= 爱音
# A1 起头规则：v1（我上一轮写的）理由就是错的 —— 它说"叹词只是偶尔出现"，
#    而官方 26% 用叹词开头。真正的问题是**只用同一个字**（欸 28%）。
ANON_SP_OLD = ("- 怎么起头不固定，这一点很关键：最常见的是**不带任何开场词**，直接接住对方说的内容往下聊；"
               "有时从自己的事说起（我刚才在做…、我昨天看到…）；有时先反问；想不起说什么就一个字（嗯、哈、?）。"
               "哇、欸这类只是偶尔才出现，不要每条都拿它当开头。")
ANON_SP_NEW = ("- 起头别老用同一个字：你最常拿「诶」和「啊」开头（诶 这样啊 / 啊 对哦），"
               "偶尔换「唔」「咦」「嗯」；也可以什么都不带、直接接住对方说的往下聊，"
               "或者从自己的事说起（我刚才…、我昨天…）。同一段对话里连着几条都用同一个字起头会很假。")

# A2 示例里的「欸」→「诶」（官方语料里欸 187 次 / 诶 12299 次）
ANON_EX_OLD = "{{char}}: 欸 白毛的我还以为是啊"
ANON_EX_NEW = "{{char}}: 诶 白毛的我还以为是啊"

# A3 description 里引用的语音也统一成「诶」（欸/诶 只是转写用字差异）
ANON_DESC_OLD = "「欸!忘带钱包了!Soyorin,就这一次能不能借我一下~~」"
ANON_DESC_NEW = "「诶!忘带钱包了!Soyorin,就这一次能不能借我一下~~」"

# A4 补一个"开场变化"的示例（指令 < 示例）
ANON_EX_TAIL = "{{char}}: 我自己也这么觉得啊!"
ANON_EX_ADD = """
<START>
{{user}}: 昨天那场live你看了吗
{{char}}: 看了看了
{{char}}: 诶 你也去了?
{{char}}: 怎么不来找我
<START>
{{user}}: 立希说你这周又没去排练
{{char}}: ……
{{char}}: 去了
{{char}}: 去了一半
"""

# ================================================================= 爽世
# S1 description「## 说话细节」补两条官方指纹
SOYO_DESC_OLD = "- 句子偏短。想到一句说一句，不铺垫、不总结，说完就停。"
SOYO_DESC_NEW = ("- 句子偏短。想到一句说一句，不铺垫、不总结，说完就停。\n"
                 "- 提到乐队里的人一律加「小」：小爱音、小灯、小乐奈、小立希、小睦。"
                 "这是她的固定叫法，几乎不直呼名字。\n"
                 "- 大约每五六句里有一句以「……」开头 —— 先顿一下，再开口。"
                 "不要每句都这样，但完全不用就不像她了。")

# S2 示例补「小X」+「……」两种指纹
SOYO_EX_TAIL = "{{char}}: 唉 随便你吧"
SOYO_EX_ADD = """
<START>
{{user}}: 你觉得灯写的词怎么样
{{char}}: ……小灯写的词 有时候我看不太懂
{{char}}: 但那首歌是真的好听
<START>
{{user}}: 乐奈今天弹得怎么样
{{char}}: 小乐奈啊
{{char}}: ……她那种弹法 我学不来
<START>
{{user}}: 立希又骂我了
{{char}}: 小立希就那样
{{char}}: ……你也别太往心里去
"""


# ---------------------------------------------------------------- PNG 读写
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
    bak = p.with_suffix(p.suffix + ".bak-" + stamp + "-fingerprint")
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


def do_anon(dry=False, revert=False):
    f = get_fields(ANON_CARD)
    sp, ex, de = f["system_prompt"], f["mes_example"], f["description"]
    if revert:
        if ANON_SP_NEW not in sp or ANON_EX_ADD.strip() not in ex:
            return "!! 找不到新内容，放弃"
        ns = sp.replace(ANON_SP_NEW, ANON_SP_OLD, 1)
        ne = ex.replace(ANON_EX_ADD, "", 1).replace(ANON_EX_NEW, ANON_EX_OLD, 1)
        nde = de.replace(ANON_DESC_NEW, ANON_DESC_OLD, 1)
        ok, info = put_fields(ANON_CARD, {"system_prompt": ns, "mes_example": ne,
                                          "description": nde}, time.strftime("%Y%m%d-%H%M%S"))
        return f"REVERTED {info}" if ok else f"!! {info}"
    checks = [("A1 起头规则", sp.count(ANON_SP_OLD), 1), ("A2 示例欸", ex.count(ANON_EX_OLD), 1),
              ("A3 desc欸", de.count(ANON_DESC_OLD), 1), ("A4 示例尾", ex.count(ANON_EX_TAIL), 1)]
    bad = [f"{n}={c}(应{d})" for n, c, d in checks if c != d]
    if bad:
        return "!! 锚点异常: " + "; ".join(bad)
    ns = sp.replace(ANON_SP_OLD, ANON_SP_NEW, 1)
    ne = ex.replace(ANON_EX_OLD, ANON_EX_NEW, 1).replace(ANON_EX_TAIL, ANON_EX_TAIL + ANON_EX_ADD, 1)
    nde = de.replace(ANON_DESC_OLD, ANON_DESC_NEW, 1)
    if dry:
        return (f"DRY ok  sp {len(sp)}->{len(ns)}  ex {len(ex)}->{len(ne)}  de {len(de)}->{len(nde)}")
    ok, info = put_fields(ANON_CARD, {"system_prompt": ns, "mes_example": ne,
                                      "description": nde}, time.strftime("%Y%m%d-%H%M%S"))
    if not ok:
        return f"!! {info}"
    back = get_fields(ANON_CARD)
    blob = back["system_prompt"] + back["mes_example"] + back["description"]
    probs = []
    if "欸" in blob:
        probs.append(f"卡里仍有「欸」x{blob.count('欸')}")
    if "起头别老用同一个字" not in back["system_prompt"]:
        probs.append("新起头规则缺失")
    return (f"OK  sp {len(sp)}->{len(ns)}  ex {len(ex)}->{len(ne)}  备份={info}"
            + ("  断言: 通过" if not probs else "  !! " + "; ".join(probs)))


def do_soyo(dry=False, revert=False):
    f = get_fields(SOYO_CARD)
    de, ex = f["description"], f["mes_example"]
    if revert:
        if "小爱音、小灯、小乐奈" not in de or SOYO_EX_ADD.strip() not in ex:
            return "!! 找不到新内容，放弃"
        nde = de.replace(SOYO_DESC_NEW, SOYO_DESC_OLD, 1)
        nex = ex.replace(SOYO_EX_ADD, "", 1)
        ok, info = put_fields(SOYO_CARD, {"description": nde, "mes_example": nex},
                              time.strftime("%Y%m%d-%H%M%S"))
        return f"REVERTED {info}" if ok else f"!! {info}"
    checks = [("S1 说话细节锚点", de.count(SOYO_DESC_OLD), 1), ("S2 示例尾锚点", ex.count(SOYO_EX_TAIL), 2)]
    bad = [f"{n}={c}(应{d})" for n, c, d in checks if c != d]
    if bad:
        return "!! 锚点异常: " + "; ".join(bad)
    nde = de.replace(SOYO_DESC_OLD, SOYO_DESC_NEW, 1)
    nex = ex.replace(SOYO_EX_TAIL, SOYO_EX_TAIL + SOYO_EX_ADD, 1)   # 只替最后那一处
    if dry:
        return f"DRY ok  de {len(de)}->{len(nde)}  ex {len(ex)}->{len(nex)}"
    ok, info = put_fields(SOYO_CARD, {"description": nde, "mes_example": nex},
                          time.strftime("%Y%m%d-%H%M%S"))
    if not ok:
        return f"!! {info}"
    back = get_fields(SOYO_CARD)
    probs = []
    if "小爱音、小灯、小乐奈" not in back["description"]:
        probs.append("小X 规则缺失")
    if "每五六句" not in back["description"]:
        probs.append("省略号规则缺失")
    if "小灯写的词" not in back["mes_example"]:
        probs.append("示例缺失")
    return (f"OK  de {len(de)}->{len(nde)}  ex {len(ex)}->{len(nex)}  备份={info}"
            + ("  断言: 通过" if not probs else "  !! " + "; ".join(probs)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()
    for name, card, fn in (("anon", ANON_CARD, do_anon), ("soyo", SOYO_CARD, do_soyo)):
        print("=" * 74)
        print(f"{name}  {card}")
        if args.check:
            f = get_fields(card)
            blob = "\n".join(str(f.get(k, "")) for k in
                             ("description", "mes_example", "system_prompt", "first_mes"))
            print(f"  欸={blob.count('欸')} 诶={blob.count('诶')} 小X={blob.count('小灯')+blob.count('小乐奈')}"
                  f" 「……」={blob.count('……')}")
            print("  dry:", fn(dry=True))
            continue
        print(" ", fn(dry=args.dry, revert=args.revert))


if __name__ == "__main__":
    main()
