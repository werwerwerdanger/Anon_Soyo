# -*- coding: utf-8 -*-
"""Rule 8, again: the remaining "roleplay" tell is that every line is a polished quip.

User: "感觉他们说话还是有点拟人不像是现实人类"

Looking at the actual output (「生分就生分，我跟你本来也没多熟」「自己地盘就回自己地盘说」),
the pattern is not length -- it is that every single line has a stance, a turn and a
button. That is dialogue writing, not typing. Real people in a group send 「啊」/「哦」/「？」/
「草」/「行吧」, answer the wrong question, or say something unrelated about themselves.

So append the missing half to rule 8: zero-information replies are normal, and do not
turn every line into a scripted beat.

Paired with ai.temperature 1.0 -> 0.8 (done separately): high temperature is what makes
the model reach for the clever phrasing in the first place.

Usage:
    python fix_typed_not_scripted.py [--dry-run]
"""
import argparse
import base64
import json
import pathlib
import re
import struct
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent

OLD = ('但也别缩成客服式的一句话交差 —— 真的被戳到、或者你确实在意的时候，'
       '就多说两句，把态度摆出来。')
NEW = ('这些没信息量、也没态度的回复是正常的，别把每句话都写成有态度、有转折、有收尾的句子 '
       '—— 那是台词，不是打字。偶尔跑题、突然说点自己的事、或者答非所问，都很正常。'
       '但也别缩成客服式的一句话交差 —— 真的被戳到、或者你确实在意的时候，'
       '就多说两句，把态度摆出来。')

TARGETS = [
    ('MimirLink-soyo', 'Soyo_Nagasaki'),
    ('MimirLink', 'Anon_Chihaya'),
]


def read_system_prompt(path):
    raw = path.read_bytes()
    pos = 8
    while pos < len(raw):
        (ln,) = struct.unpack('>I', raw[pos:pos + 4])
        ctype = raw[pos + 4:pos + 8]
        data = raw[pos + 8:pos + 8 + ln]
        if ctype == b'tEXt':
            key, _, value = data.partition(b'\x00')
            if key.decode('latin-1') == 'chara':
                card = json.loads(base64.b64decode(value).decode('utf-8'))
                fields = card.get('data') or card
                return fields.get('system_prompt') or ''
        pos += 12 + ln
    raise SystemExit('no chara block in %s' % path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()
    print('=' * 72)
    print('rule 8: typed, not scripted   dry-run=%s' % args.dry_run)
    print('=' * 72)

    for inst, card in TARGETS:
        png = pathlib.Path(r'C:\Users\20633') / inst / 'data' / 'characters' / ('%s.png' % card)
        print('')
        print('--- %s ---' % inst)
        current = read_system_prompt(png)
        if '那是台词，不是打字' in current:
            print('  [SKIP] already applied')
            continue
        if current.count(OLD) != 1:
            print('  [FAIL] anchor appears %d times (want 1)' % current.count(OLD))
            continue
        updated = current.replace(OLD, NEW, 1)
        nums = [int(m) for m in re.findall(r'(?m)^(\d+)\. ', updated)]
        if nums[:7] != [1, 2, 3, 4, 5, 6, 7] or nums[7:] != list(range(8, 8 + len(nums[7:]))):
            print('  [FAIL] numbering broken: %s' % nums)
            continue
        print('  %d -> %d chars, numbering ok' % (len(current), len(updated)))
        if args.dry_run:
            continue
        out = HERE / ('_%s_typed.json' % inst)
        out.write_text(json.dumps({'system_prompt': updated}, ensure_ascii=False, indent=2),
                       encoding='utf-8')
        r = subprocess.run([sys.executable, str(HERE / 'set_card_fields.py'),
                            '--card', str(png), '--json', str(out)],
                           capture_output=True, text=True)
        print('  ' + (r.stdout.strip().splitlines() or [''])[-1])
        if r.returncode != 0:
            return 1

    if args.dry_run:
        print('')
        print('dry run -- nothing written')
        return 0
    print('')
    print('RESTART both MimirLink instances.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
