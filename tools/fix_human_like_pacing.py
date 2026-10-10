# -*- coding: utf-8 -*-
"""Rebalance rule 8: let her be LAZY most of the time, instead of performing every turn.

WHY (user: "现在还是有点像伪人怎么办")
------------------------------------
"死人感" and "伪人" are the SAME axis, opposite ends:
    死人感 = too short, no emotion      (the earlier over-correction)
    伪人   = too complete, performing every single turn   (now)
Turning the dial back would just recreate 死人感. The fix is to stop treating every
message as a turn that must be taken.

The current rule 8 is byte-identical in both cards and literally mandates content:

    8. 每条回复都要有反应、有立场。不要只做信息回复，不要像客服一样客气地把话说完就走。
       可以有情绪、有反问，也可以不想理人。

"每条回复都要有反应、有立场" is the uncanny part: a real person in a group says nothing
most of the time, and when they do it is often 「？」/「啊」/「哦」. Forcing a stance on
every line is what reads as machine. But the second half (don't sound like customer
service) must stay, or we are straight back to 死人感.

So: keep both ends, put the default in the middle -- mostly one short line, occasionally
a real answer.

Usage:
    python fix_human_like_pacing.py [--dry-run]
"""
import argparse
import base64
import json
import pathlib
import shutil
import struct
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent

OLD = ('8. 每条回复都要有反应、有立场。不要只做信息回复，不要像客服一样客气地把话说完就走。'
       '可以有情绪、有反问，也可以不想理人。')
NEW = ('8. 长短要像真人：大部分时候就回一句，甚至可以只回「啊」「哦」「嗯」「？」「随你」这类，'
       '不想接就不接，话题掉在地上也没关系。不要每条都当成必须接住的话题，也不要每次都给出'
       '漂亮的收尾或反问。但也别缩成客服式的一句话交差 —— 真的被戳到、或者你确实在意的时候，'
       '就多说两句，把态度摆出来。')

TARGETS = [
    ('MimirLink-soyo', 'Soyo_Nagasaki', '_soyo_aggro.json'),
    ('MimirLink', 'Anon_Chihaya', '_anon_aggro.json'),
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
    print('fix human-like pacing (rule 8)   dry-run=%s' % args.dry_run)
    print('=' * 72)

    for inst, card, record in TARGETS:
        png = pathlib.Path(r'C:\Users\20633') / inst / 'data' / 'characters' / ('%s.png' % card)
        print('')
        print('--- %s / %s ---' % (inst, card))
        current = read_system_prompt(png)
        if NEW in current:
            print('  [SKIP] already applied')
            continue
        if current.count(OLD) != 1:
            print('  [FAIL] old rule 8 appears %d times (want 1)' % current.count(OLD))
            continue
        updated = current.replace(OLD, NEW, 1)
        # numbering must stay intact
        import re
        nums = [int(m) for m in re.findall(r'(?m)^(\d+)\. ', updated)]
        if nums[:7] != [1, 2, 3, 4, 5, 6, 7] or nums[7:] != list(range(8, 8 + len(nums[7:]))):
            print('  [FAIL] numbering broken: %s' % nums)
            continue
        print('  %d -> %d chars (numbering %s ok)' % (len(current), len(updated), nums[:13]))
        if args.dry_run:
            continue
        out = HERE / ('_%s_pacing.json' % inst)
        out.write_text(json.dumps({'system_prompt': updated}, ensure_ascii=False, indent=2),
                       encoding='utf-8')
        r = subprocess.run([sys.executable, str(HERE / 'set_card_fields.py'),
                            '--card', str(png), '--json', str(out)],
                           capture_output=True, text=True)
        print((r.stdout.strip() or r.stderr.strip()).splitlines()[-1])
        if r.returncode != 0:
            return 1
        rec = HERE / record
        if rec.exists():
            data = json.loads(rec.read_text(encoding='utf-8'))
            data['system_prompt'] = updated
            rec.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')

    if args.dry_run:
        print('')
        print('dry run -- nothing written')
        return 0
    print('')
    print('RESTART both MimirLink instances: card change.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
