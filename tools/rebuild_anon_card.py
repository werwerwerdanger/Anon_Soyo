# -*- coding: utf-8 -*-
"""Rebuild Anon's card FROM THE ORIGINAL, instead of stacking edits on my own edits.

WHY (user: "爱音要不你对着原卡重新改一下 我怕你复原的不好")
-------------------------------------------------------------
Field-level diff (mimir-tools/_diff_card_fields.py) against the pristine card
(Anon_Chihaya.png.bak-20261009-191441) showed exactly four edited fields:

    personality                137 -> 198
    system_prompt                0 -> 671   (originally EMPTY)
    first_mes                  413 ->  68
    post_history_instructions  220 -> 233   (dead field -- never reaches the prompt)

...and all twelve other fields byte-identical. So the plan is: restore the file
from the original backup, then write back exactly those four, each derived from the
original rather than from my previous edit.

🔴 WHERE THE 涨粉 CAME FROM: the ORIGINAL first_mes already said
   「我试了各种办法想涨粉，什么可爱自拍、搞笑视频…我的个人账号就是…卡住不动了！」
   The fan who made the card conflated Anon with 祐天寺若麦 (喵梦, the beauty
   streamer). I compressed that 413-char novel-style scene into chat style and kept
   the premise. The premise is the original card's defect, not mine -- but it is
   still wrong, so the rebuild keeps the original's *shape* (Anon bounces up to you
   with a favour to ask) and swaps in an Anon-accurate ask.

Usage:
    python rebuild_anon_card.py [--dry-run]
"""
import argparse
import base64
import json
import pathlib
import shutil
import struct
import subprocess
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
LIVE = pathlib.Path(r'C:\Users\20633\MimirLink\data\characters\Anon_Chihaya.png')
ORIG = LIVE.with_name('Anon_Chihaya.png.bak-20261009-191441')
STAMP = time.strftime('%Y%m%d-%H%M%S')

ORIG_PERSONALITY_TAIL = '不要用括号演动作，直接以爱音的身份自然说话。'
PERSONALITY_ADDITION = (
    '说话特点：话多、爱炫耀、爱抬杠；不认同的当场就说不认同；'
    '被怼了会嘴硬顶回去，顶不过就换个话题找台阶下，绝不装大方。'
    '直接以爱音的身份自然说话，不要用任何符号（括号、星号等）演动作、神态或心理。'
)

# The original's shape -- 自来熟地凑上来 + 有事求你 + 心里其实没底 -- minus the
# 喵梦-style "grow MY follower count" premise, which is not Anon's.
NEW_FIRST_MES = (
    '诶，等等，你\n'
    '\n'
    '我是千早爱音，MyGO!!!!! 的节奏吉他手\n'
    '这个乐队是我拉起来的，演出服也是我做的\n'
    '\n'
    '我们下周在 RiNG 有场演出\n'
    '我到处拉人，来的人不多\n'
    '\n'
    '你看着像懂行的，给我想个办法'
)


def load_chara(path):
    raw = path.read_bytes()
    pos, out = 8, []
    while pos < len(raw):
        (ln,) = struct.unpack('>I', raw[pos:pos + 4])
        ctype = raw[pos + 4:pos + 8]
        data = raw[pos + 8:pos + 8 + ln]
        if ctype == b'tEXt':
            key, _, value = data.partition(b'\x00')
            if key.decode('latin-1') == 'chara':
                out.append(json.loads(base64.b64decode(value).decode('utf-8')))
        pos += 12 + ln
    return out


def flatten(card):
    d = card.get('data') if isinstance(card.get('data'), dict) else None
    return d or card


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    if not ORIG.exists():
        print('original backup missing: %s' % ORIG)
        return 1

    orig_cards = load_chara(ORIG)
    live_cards = load_chara(LIVE)
    print('original blocks=%d  live blocks=%d' % (len(orig_cards), len(live_cards)))

    orig_fields = flatten(orig_cards[0])
    old_personality = str(orig_fields.get('personality') or '')
    if not old_personality.endswith(ORIG_PERSONALITY_TAIL):
        print('personality does not end with the expected tail; aborting')
        return 1
    new_personality = (old_personality[:-len(ORIG_PERSONALITY_TAIL)] + PERSONALITY_ADDITION)

    # system_prompt: original is EMPTY, so the rule block is purely additive.
    rule_block = flatten(live_cards[0]).get('system_prompt') or ''
    if '说人话。用手机打字的大白话' not in rule_block:
        print('live system_prompt looks wrong (plain-speech rule missing); aborting')
        return 1

    payload = {
        'personality': new_personality,
        'system_prompt': rule_block,
        'first_mes': NEW_FIRST_MES,
        # dead field (never reaches the prompt) -- put the ORIGINAL value back
        'post_history_instructions': orig_fields.get('post_history_instructions'),
    }

    print('')
    print('personality     %d -> %d' % (len(old_personality), len(new_personality)))
    print('system_prompt   %d -> %d (original was empty)' % (len(str(orig_fields.get('system_prompt') or '')), len(rule_block)))
    print('first_mes       %d -> %d' % (len(str(orig_fields.get('first_mes') or '')), len(NEW_FIRST_MES)))
    print('post_history    restored to original (%d chars)' % len(str(orig_fields.get('post_history_instructions') or '')))
    print('')
    print('preserved verbatim from the original personality:')
    print('  %s' % old_personality[:-len(ORIG_PERSONALITY_TAIL)])
    print('new first_mes:')
    for line in NEW_FIRST_MES.split('\n'):
        print('  | %s' % line)

    if args.dry_run:
        print('')
        print('dry run -- nothing written')
        return 0

    # 1) restore the pristine file, 2) write back exactly the four fields
    keep = LIVE.with_name('Anon_Chihaya.png.bak-%s-prerebuild' % STAMP)
    shutil.copy2(LIVE, keep)
    shutil.copy2(ORIG, LIVE)
    print('')
    print('restored %s from the original backup (previous state kept at %s)'
          % (LIVE.name, keep.name))

    payload_path = HERE / '_anon_rebuild.json'
    payload_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
    r = subprocess.run([sys.executable, str(HERE / 'set_card_fields.py'),
                        '--card', str(LIVE), '--json', str(payload_path)],
                       capture_output=True, text=True)
    print(r.stdout.strip() or r.stderr.strip())
    if r.returncode != 0:
        print('set_card_fields failed -- file is currently the PRISTINE original')
        return 1

    after = flatten(load_chara(LIVE)[0])
    ok = True
    for field, want in payload.items():
        got = after.get(field)
        if got != want:
            print('  [FAIL] %s did not round-trip' % field)
            ok = False
    print('  [%s] all four fields verified present after write'
          % ('OK' if ok else 'FAIL'))
    print('')
    print('now run: _diff_card_fields.py  (expect exactly these 4 fields to differ)')
    return 0 if ok else 1


if __name__ == '__main__':
    raise SystemExit(main())
