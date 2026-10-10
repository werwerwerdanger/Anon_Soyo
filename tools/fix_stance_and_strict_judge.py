# -*- coding: utf-8 -*-
"""Three user asks (2026-10-09):
   1. 私聊挑着回   -- private already goes through the decision layer (routing accepts it,
                       then processBatch judges), so the lever is the judge's bias, not a
                       new code path. See 2.
   2. 拿不准就回 NO -- flip the default in DEFAULT_DECISION_PROMPT.
   3. "骂人都懒得指名，那这句我不接" 还是不对
        -> the recurring tell is a DECLARATIVE STANCE ("我不接"). Real people do not
           package their attitude into a ruling. I diagnosed this earlier and never
           applied it; now the user has effectively confirmed it.

Note on wording: the new rule deliberately does NOT quote the offending phrase. Writing
a forbidden string into the prompt invites copying -- same lesson as the literal '*' that
appeared when the prompt itself said "不要用 * *".

Usage:
    python fix_stance_and_strict_judge.py [--dry-run]
"""
import argparse
import base64
import json
import pathlib
import re
import shutil
import struct
import subprocess
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
STAMP = time.strftime('%Y%m%d-%H%M%S')

PROMPT_OLD = '拿不准就回 YES。'
PROMPT_NEW = '拿不准就回 NO。'

RULE14 = ('14. 不要发表态式的话。真人聊天不会把自己的态度整理成一句声明，'
          '也不会给自己划界限。不想答的就绕开、反问、或者说点别的，'
          '不要用一句总结性的话给这件事定性。')

CARDS = [
    ('MimirLink-soyo', 'Soyo_Nagasaki'),
    ('MimirLink', 'Anon_Chihaya'),
]


def read_fields(path):
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
                return card.get('data') or card
        pos += 12 + ln
    raise SystemExit('no chara block in %s' % path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()
    print('=' * 72)
    print('stance rule + strict judge   dry-run=%s' % args.dry_run)
    print('=' * 72)

    # ---- 2) judge bias
    for inst, _card in CARDS:
        js = pathlib.Path(r'C:\Users\20633') / inst / 'src' / 'reply-decision.js'
        t = js.read_text(encoding='utf-8')
        print('')
        print('--- %s / judge prompt ---' % inst)
        if PROMPT_NEW in t and PROMPT_OLD not in t:
            print('  [SKIP] already NO-biased')
            continue
        if t.count(PROMPT_OLD) != 1:
            print('  [FAIL] anchor appears %d times' % t.count(PROMPT_OLD))
            continue
        if not args.dry_run:
            shutil.copy2(js, js.with_name('reply-decision.js.bak-%s-stance' % STAMP))
            js.write_text(t.replace(PROMPT_OLD, PROMPT_NEW, 1), encoding='utf-8')
        print('  OK  拿不准就回 YES -> NO')

    # ---- 3) rule 14
    for inst, card in CARDS:
        png = pathlib.Path(r'C:\Users\20633') / inst / 'data' / 'characters' / ('%s.png' % card)
        print('')
        print('--- %s / rule 14 ---' % inst)
        sp = str(read_fields(png).get('system_prompt') or '')
        if '14. 不要发表态式的话' in sp:
            print('  [SKIP] already present')
            continue
        if sp.count('\n13. ') != 1:
            print('  [FAIL] rule 13 anchor appears %d times' % sp.count('\n13. '))
            continue
        last_line = [l for l in sp.split('\n') if l.startswith('13. ')]
        if not last_line:
            print('  [FAIL] cannot locate rule 13')
            continue
        updated = sp.replace(last_line[0], last_line[0] + '\n' + RULE14, 1)
        nums = [int(m) for m in re.findall(r'(?m)^(\d+)\. ', updated)]
        if nums[:7] != [1, 2, 3, 4, 5, 6, 7] or nums[7:] != list(range(8, 8 + len(nums[7:]))):
            print('  [FAIL] numbering broken: %s' % nums)
            continue
        print('  %d -> %d chars, numbering %s' % (len(sp), len(updated), nums[:14]))
        if args.dry_run:
            continue
        out = HERE / ('_%s_stance.json' % inst)
        out.write_text(json.dumps({'system_prompt': updated}, ensure_ascii=False, indent=2),
                       encoding='utf-8')
        r = subprocess.run([sys.executable, str(HERE / 'set_card_fields.py'),
                            '--card', str(png), '--json', str(out)],
                           capture_output=True, text=True)
        ok = r.returncode == 0
        print('  %s' % ('OK  written' if ok else 'FAIL ' + (r.stderr or '')[:200]))
        if not ok:
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
