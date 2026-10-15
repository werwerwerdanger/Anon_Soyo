#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_anon_image_rules.py
改爱音卡里"怎么对待图片"的两条规则（用户 2026-10-12 定稿口径）。

背景（诊断链见 MIMIRLINK-NOTES §21）
------------------------------------
2026-10-12 用户发了一张翻拍的屏幕截图（CRYCHIC 五人 + 字幕「你怎么还在这？」），
爱音把它读成了"在调侃我还在熬夜"。查她的思考过程，原文写着：

    「不过用户发图是在说"你怎么还在这"，**我不需要分析图**，接着答就行。」

**她没做错 —— 那是卡里两条规则的直译**：
  A) 「默认不用管表情包…**图里带了文字就只答那些文字**。」
  B) 「**只有对方明确让你看图**、或者问你图里是什么的时候，才去看图的内容并回答。」

问题在**主语丢了**：A 想管的是"表情包"，但那句"图里带了文字就只答那些文字"没限定范围
⇒ 读成对**所有图**生效 ⇒ **任何带字的图都变成"只看字"**。
而截图/视频画面/照片的**重点恰恰在图里**，字只是个引子 ⇒ 这次的图就被整张跳过了。

改法（**不加新规则，只改这两条的适用范围**）
--------------------------------------------
把"看不看图"和"说不说出来"**拆成两件事**：
    · 看 —— 默认动作（不看就只能拿文字硬猜，这正是本次的坑）
    · 说 —— 按需动作（没被问就不提，这才是原规则真正想要的：不刷屏、不念图上的字）

用户还砍掉了我最初"表情包不用管 / 真图要看"的两级设计，理由正确：
**那需要多判一次"这是不是表情包"，等于凭空加一个会判错的环节。**
统一成一条（图都看、没问就不说）**少一个判别器，规则更短、出错面更小**。

⚠ 这是个 PNG 卡：正文在 tEXt 块的 base64(JSON) 里，本脚本会重写**所有** chara 块并重算 CRC。
   实测这张卡有两个内容相同的 chara 块，必须一起改，否则读卡的实现挑哪个是随机的。

用法:
  python patch_anon_image_rules.py            # 打补丁（自动备份）
  python patch_anon_image_rules.py --dry-run  # 只看会不会命中
  python patch_anon_image_rules.py --revert   # 还原
"""
import argparse
import base64
import glob
import json
import os
import shutil
import struct
import sys
import time
import zlib

HOME = os.path.expanduser('~')

# 两个实例各有一份，各自可能不同 ⇒ 都处理
CARD_GLOBS = [
    os.path.join(HOME, 'MimirLink', 'data', 'characters', 'Anon_Chihaya.png'),
    os.path.join(HOME, 'MimirLink-soyo', 'data', 'characters', 'Anon_Chihaya.png'),
]

OLD = (
    '- 别人发的图都看一眼，心里有数就行 —— 表情包也一样。\n'
    '- 没被问到就别主动提它、别描述它、也别念图上的字。\n'
    '- 被问到了（「这是啥」「你看这个」）就正常答出来。\n'
    '- 整条消息只有一张图、没有文字的时候：**千万别把你上一条说过的话再说一遍**，'
    '也不用硬找话题接 —— 随手应一声就行，或者什么都不说。'
)

# 2026-10-13 第二次改：用户反馈「不描述表情包失效了」。
# 🔴 起因是我自己写的**触发器示例**：上一版把「这是啥」「你看这个」当成"被问到"的例子写进规则，
#    而用户恰好发了「这是啥」⇒ 按规则她就**该**描述那张表情包。
#    （本项目的「卡里的引号例句 = 给自己下绊子」又多一例：**写成触发器的短语就真成了触发器**。）
# 用户口径：「强调是只看图，如果没有明确说明**一定不要描述**，知道图片意思就可以了」
#    ⇒ ①「看」保留（表情包也看）②「说」的门槛抬到**明确要求** ③ **不再给任何引号示例**。
NEW = (
    '- 别人发的图都看一眼，知道图里的意思就行 —— 表情包也一样。\n'
    '- **只有对方明确要你说出图里是什么**的时候，才把图里的内容说出来。\n'
    '- 其余情况不要提它、不要描述它、也不要念图上的字。\n'
    '- 整条消息只有一张图、没有文字的时候：**千万别把你上一条说过的话再说一遍**，'
    '也不用硬找话题接 —— 随手应一声就行，或者什么都不说。'
)


# ---------------------------------------------------------------------------
# PNG tEXt(chara) 读写
# ---------------------------------------------------------------------------
def iter_chunks(data):
    """产出 (offset, length, type, payload)。"""
    off = 8
    while off + 8 <= len(data):
        ln = struct.unpack('>I', data[off:off + 4])[0]
        typ = data[off + 4:off + 8]
        yield off, ln, typ, data[off + 8:off + 8 + ln]
        off += 12 + ln


def build_text_chunk(keyword: bytes, payload: bytes) -> bytes:
    body = keyword + b'\x00' + payload
    crc = zlib.crc32(b'tEXt' + body) & 0xFFFFFFFF
    return struct.pack('>I', len(body)) + b'tEXt' + body + struct.pack('>I', crc)


def read_cards(path):
    """把卡里所有 chara 块解出来：[(offset, length, json_obj)]"""
    data = open(path, 'rb').read()
    out = []
    for off, ln, typ, payload in iter_chunks(data):
        if typ == b'tEXt' and payload.startswith(b'chara\x00'):
            b64 = payload[len(b'chara\x00'):]
            out.append((off, ln, json.loads(base64.b64decode(b64).decode('utf-8'))))
    return data, out


def write_cards(path, data, new_objs):
    """按 offset 重建文件：命中的 chara 块换成新内容，其余原样。"""
    rep = {}
    for (off, ln, obj) in new_objs:
        b64 = base64.b64encode(json.dumps(obj, ensure_ascii=False).encode('utf-8'))
        rep[off] = build_text_chunk(b'chara', b64)
    out = bytearray(data[:8])
    for off, ln, typ, payload in iter_chunks(data):
        out += rep[off] if off in rep else data[off:off + 12 + ln]
    with open(path, 'wb') as fh:
        fh.write(bytes(out))


# ---------------------------------------------------------------------------
def process(path, revert, dry):
    name = os.path.relpath(path, HOME)
    if not os.path.exists(path):
        print('  %-52s 不存在，跳过' % name)
        return True

    data, cards = read_cards(path)
    if not cards:
        print('  %-52s 没有 chara 块，跳过' % name)
        return True

    src, dst = (NEW, OLD) if revert else (OLD, NEW)
    hits = [c for c in cards if src in str(c[2].get('data', {}).get('system_prompt', ''))]
    if not hits:
        already = all(dst in str(c[2].get('data', {}).get('system_prompt', '')) for c in cards)
        print('  %-52s %s' % (name, 'already' if already else '!! 锚点没命中，没动'))
        return already

    if dry:
        print('  %-52s 待改 chara 块 %d 个（共 %d 个）' % (name, len(hits), len(cards)))
        return True

    # 备份
    bak = '%s.bak-%s-imgrule' % (path, time.strftime('%Y%m%d-%H%M%S'))
    shutil.copy2(path, bak)

    changed = 0
    for (off, ln, obj) in cards:
        sp = obj.get('data', {}).get('system_prompt')
        if isinstance(sp, str) and src in sp:
            obj['data']['system_prompt'] = sp.replace(src, dst)
            changed += 1
    write_cards(path, data, cards)

    # 回读校验：块还能walk通、JSON能解析、新句在、旧句没了
    try:
        _, again = read_cards(path)
        ok = (len(again) == len(cards)
              and all(NEW in str(c[2].get('data', {}).get('system_prompt', ''))
                      if not revert else OLD in str(c[2].get('data', {}).get('system_prompt', ''))
                      for c in again))
    except Exception as exc:
        print('  %-52s !! 回读失败，回滚: %s' % (name, exc))
        shutil.copy2(bak, path)
        return False

    print('  %-52s %s (改了 %d 个 chara 块，备份 %s)'
          % (name, 'reverted' if revert else 'patched ✓', changed, os.path.basename(bak)))
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--revert', action='store_true')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    files = []
    for g in CARD_GLOBS:
        files += sorted(glob.glob(g))
    if not files:
        print('没找到爱音卡')
        return 1
    print('=== 目标卡 %d 个 ===' % len(files))
    ok = True
    for f in files:
        ok = process(f, args.revert, args.dry_run) and ok
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
