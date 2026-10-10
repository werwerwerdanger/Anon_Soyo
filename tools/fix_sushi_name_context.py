# -*- coding: utf-8 -*-
"""「素食」 is only Soyo when it is used AS A NAME -- fix both layers.

User: "素食只有在做人名的时候才是这个意思你记得改"

The mistake was adding '素食' to chat.triggerKeywords. Keyword matching is
`text.includes(kw)` with no notion of context, so '我不吃素食' and '素食你来说'
look identical to it. Deciding this reliably needs language understanding, which the
keyword layer simply does not have.

So split the job by layer:
  * triggerKeywords (mechanical)  -- REMOVE '素食'. Keep 'そよ' (unambiguous).
    Her messages are still recorded, so she does see them in history when something
    else brings her into the conversation.
  * personality (the model reads it) -- keep the homophone, WITH the caveat that it
    only means her when it is being used as a name.

Usage:
    python fix_sushi_name_context.py [--dry-run]
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
STAMP = time.strftime('%Y%m%d-%H%M%S')
SOYO_ROOT = pathlib.Path(r'C:\Users\20633\MimirLink-soyo')
PNG = SOYO_ROOT / 'data' / 'characters' / 'Soyo_Nagasaki.png'

OLD_SENTENCE = ('别人用这些称呼叫你，都是在叫你：素世、素世酱、长崎、そよ、Soyorin、素食（谐音）。'
                '听到谐音或错字，也别当成是在说别人。')
NEW_SENTENCE = ('别人用这些称呼叫你，都是在叫你：素世、素世酱、长崎、そよ、Soyorin。'
                '素食是同音，只有被当成人名叫的时候才是在说你，说吃的时候不是在叫你。'
                '名字写错或漏字，也照样是在叫你。')


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
    print('fix 素食 name-context   dry-run=%s' % args.dry_run)
    print('=' * 72)

    # ---- config: drop 素食 from triggerKeywords
    cfg_path = SOYO_ROOT / 'config.json'
    cfg = json.loads(cfg_path.read_text(encoding='utf-8'))
    kws = cfg['chat'].get('triggerKeywords') or []
    if '素食' in kws:
        kws = [k for k in kws if k != '素食']
        cfg['chat']['triggerKeywords'] = kws
        print('')
        print('--- config.json ---')
        print('  triggerKeywords ->', kws)
        if not args.dry_run:
            shutil.copy2(cfg_path, cfg_path.with_name('config.json.bak-%s-sushi' % STAMP))
            cfg_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding='utf-8')
            back = json.loads(cfg_path.read_text(encoding='utf-8'))['chat']['triggerKeywords']
            assert '素食' not in back
            print('  [OK] written, read-back verified (素食 removed)')
    else:
        print('')
        print('--- config.json ---')
        print('  [SKIP] 素食 not in triggerKeywords')

    # ---- card: personality caveat
    print('')
    print('--- personality ---')
    fields = read_fields(PNG)
    per = str(fields.get('personality') or '')
    if NEW_SENTENCE in per:
        print('  [SKIP] already has the name-context caveat')
        return 0
    if OLD_SENTENCE not in per:
        print('  [FAIL] expected sentence not found; refusing to guess')
        print('  looked for: %s' % OLD_SENTENCE)
        return 1
    updated = per.replace(OLD_SENTENCE, NEW_SENTENCE, 1)
    print('  %d -> %d chars' % (len(per), len(updated)))
    print('  new: %s' % NEW_SENTENCE)
    if args.dry_run:
        print('')
        print('dry run -- nothing written')
        return 0
    out = HERE / '_soyo_sushi.json'
    out.write_text(json.dumps({'personality': updated}, ensure_ascii=False, indent=2),
                   encoding='utf-8')
    r = subprocess.run([sys.executable, str(HERE / 'set_card_fields.py'),
                        '--card', str(PNG), '--json', str(out)],
                       capture_output=True, text=True)
    print('')
    print(r.stdout.strip() or r.stderr.strip())
    print('')
    print('RESTART both MimirLink instances.')
    return 0 if r.returncode == 0 else 1


if __name__ == '__main__':
    raise SystemExit(main())
