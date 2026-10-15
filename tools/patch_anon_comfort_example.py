#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_anon_comfort_example.py
给爱音的 mes_example **追加两轮"对方低落"的示例**（用户 2026-10-13 选 (a)）。

背景
----
用户反馈私聊里"前言不搭后语"，其中一层是：对方在倾诉，她却把自己的经历接上去
（「我那时候可没人问过这句」「我初中的时候也这样」）。查卡发现**没有任何针对
"对方情绪低落"的指引**，她只能走默认（自我中心地把话题接成自己的事）。

量化后结论反转（见 MIMIRLINK-NOTES §36）：
- 爱音台词 2248 条，含安慰词 104 条，但"对方低落 → 她带安慰词回应"**只有 2 对**。
- 抽她面对他人低落的**自然反应**：**揽一半责任**（「我也有好多失误哦？」）、
  **用行动推**（「不用道歉，快收拾一下！我们去卡拉OK吧」）、偶尔只顾自己。
⇒ **官方爱音本来就不做共情式安慰。** 所以这不是"缺语料"，是"期待的那种安慰原作没有"。

用户选 **(a) 忠于原作**：接受她的方式，只把"转回自己"**挂在对方的点上**（先接一句再讲自己）。
🔑 台词来源用**官方原句**（ChatHaruhi 的做法：原作台词 + 模拟场景），不自己编说法：
- 「心情不好的时候，最好的办法就是出去玩！ 我陪你去，好了，走吧！」
- 「不用道歉，快收拾一下！ 我们去卡拉OK吧，小灯！」

为什么写进 `mes_example` 而不是规则
---------------------------------
本项目已实证「**指令永远打不过示例**」（`mes_example` 是当真实对话轮注入的，在 history 之前）。
而且规则已 32 行、72% 是否定句 —— 再加规则只会把她训得更"守规矩"（= 更理智）。
⚠ 两轮的**结局刻意不同**（一轮"拉你出去"、一轮"反将 + 我在"）：
按本项目规律「只给一种结局 ⇒ 她会收敛到那一种」，**分布才是性格**。

用法:
  python patch_anon_comfort_example.py            # 打补丁（自动备份 .bak）
  python patch_anon_comfort_example.py --dry-run
  python patch_anon_comfort_example.py --revert
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

CARD_GLOBS = [
    os.path.join(HOME, 'MimirLink', 'data', 'characters', 'Anon_Chihaya.png'),
    os.path.join(HOME, 'MimirLink-soyo', 'data', 'characters', 'Anon_Chihaya.png'),
]

# mes_example 目前的结尾（唯一锚点）
ANCHOR = '{{char}}: 呜~很有说服力……!'

ADD = """
<START>
{{user}}: 爱音 我好难受
{{char}}: 诶 怎么了
{{char}}: 谁惹你了 说
{{user}}: 也不是谁 就是大家好像都嫌弃我
{{char}}: 啊 那种啊
{{char}}: 我初中也有过一阵 一屋子人没一个理我的
{{char}}: 心情不好的时候 最好的办法就是出去玩!
{{char}}: 我陪你去 好了 走吧!
<START>
{{user}}: 反正我就是没朋友
{{char}}: 那你现在在跟谁说话啊
{{user}}: ……
{{char}}: 行了 别一个人待着
{{char}}: 我在呢
"""


def iter_chunks(data):
    off = 8
    while off + 8 <= len(data):
        ln = struct.unpack('>I', data[off:off + 4])[0]
        typ = data[off + 4:off + 8]
        yield off, ln, typ, data[off + 8:off + 8 + ln]
        off += 12 + ln


def build_text_chunk(keyword, payload):
    body = keyword + b'\x00' + payload
    crc = zlib.crc32(b'tEXt' + body) & 0xFFFFFFFF
    return struct.pack('>I', len(body)) + b'tEXt' + body + struct.pack('>I', crc)


def read_cards(path):
    data = open(path, 'rb').read()
    out = []
    for off, ln, typ, payload in iter_chunks(data):
        if typ == b'tEXt' and payload.startswith(b'chara\x00'):
            b64 = payload[len(b'chara\x00'):]
            out.append((off, ln, json.loads(base64.b64decode(b64).decode('utf-8'))))
    return data, out


def write_cards(path, data, objs):
    rep = {}
    for (off, ln, obj) in objs:
        b64 = base64.b64encode(json.dumps(obj, ensure_ascii=False).encode('utf-8'))
        rep[off] = build_text_chunk(b'chara', b64)
    out = bytearray(data[:8])
    for off, ln, typ, payload in iter_chunks(data):
        out += rep[off] if off in rep else data[off:off + 12 + ln]
    with open(path, 'wb') as fh:
        fh.write(bytes(out))


def process(path, revert, dry):
    name = os.path.relpath(path, HOME)
    if not os.path.exists(path):
        print('  %-52s 不存在，跳过' % name)
        return True
    data, cards = read_cards(path)
    if not cards:
        print('  %-52s 没有 chara 块，跳过' % name)
        return True

    def me_of(o):
        return str(o.get('data', {}).get('mes_example', ''))

    if revert:
        hits = [c for c in cards if ADD in me_of(c[2])]
    else:
        hits = [c for c in cards if ANCHOR in me_of(c[2]) and ADD not in me_of(c[2])]

    if not hits:
        done = all(ADD in me_of(c[2]) for c in cards) if not revert else all(ADD not in me_of(c[2]) for c in cards)
        print('  %-52s %s' % (name, 'already' if done else '!! 锚点没命中，没动'))
        return done

    if dry:
        print('  %-52s 待改 chara 块 %d 个（共 %d 个）' % (name, len(hits), len(cards)))
        return True

    bak = '%s.bak-%s-comfort' % (path, time.strftime('%Y%m%d-%H%M%S'))
    shutil.copy2(path, bak)

    changed = 0
    for (off, ln, obj) in cards:
        me = me_of(obj)
        if revert:
            if ADD in me:
                obj['data']['mes_example'] = me.replace(ADD, '')
                changed += 1
        else:
            if ANCHOR in me and ADD not in me:
                obj['data']['mes_example'] = me + ADD
                changed += 1
    write_cards(path, data, cards)

    try:
        _, again = read_cards(path)
        ok = all((ADD in me_of(c[2])) if not revert else (ADD not in me_of(c[2])) for c in again)
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
