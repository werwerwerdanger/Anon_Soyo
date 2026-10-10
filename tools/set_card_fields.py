"""Edit SillyTavern character-card fields inside a PNG, in place.

WHY NOT updateCharacter()
-------------------------
MimirLink's CharacterManager.updateCharacter() can write ST fields back, but it
rebuilds every chunk from a hand-rolled loop and drops anything it does not
recognise. Character cards are 1-5 MB of IDAT; there is no reason to touch them.
This tool rewrites only the base64 payload of the chara/ccv3 tEXt chunks and
leaves every other byte -- IHDR, all IDAT, IEND -- exactly as it was.

CARD LAYOUT NOTES (measured on the two cards in this project)
-------------------------------------------------------------
* Both cards carry TWO tEXt chunks with keyword `chara`. The first is a proper
  `{spec:"chara_card_v2", spec_version:"2.0", data:{...}}`; the second is a
  `{data:{...}}` variant with no spec. readFromPng() takes the FIRST one (its
  guard is `if (keyword === 'ccv3' || !character)`), so the second is dead
  weight -- but it is updated too, so the file does not end up self-
  contradictory for other tools.
* Fields live under `data`, never at the top level (see patch_character_card_v2.py
  for why the reader has to flatten that).
* If a field already exists at the top level as well, it is updated in both
  places, matching updateCharacter()'s behaviour.

Usage:
    python set_card_fields.py --card <png> [--card <png> ...] --json fields.json [--dry-run]

fields.json is a flat object of ST field name -> new string value, e.g.
    {"first_mes": "...", "personality": "...", "system_prompt": "..."}
"""
import argparse
import base64
import json
import pathlib
import shutil
import struct
import sys
import time
import zlib

PNG_SIG = b'\x89PNG\r\n\x1a\n'


def read_chunks(raw: bytes):
    """Return [(type, data)] preserving order, plus the trailing IEND."""
    if raw[:8] != PNG_SIG:
        raise ValueError('not a PNG (bad signature)')
    chunks = []
    off = 8
    while off < len(raw):
        (length,) = struct.unpack('>I', raw[off:off + 4])
        ctype = raw[off + 4:off + 8]
        data = raw[off + 8:off + 8 + length]
        chunks.append((ctype, data))
        off += 12 + length
    return chunks


def write_chunks(chunks) -> bytes:
    out = [PNG_SIG]
    for ctype, data in chunks:
        out.append(struct.pack('>I', len(data)))
        out.append(ctype)
        out.append(data)
        out.append(struct.pack('>I', zlib.crc32(ctype + data) & 0xFFFFFFFF))
    return b''.join(out)


def card_payloads(chunks):
    """Indices of tEXt chunks whose keyword is chara/ccv3."""
    hits = []
    for i, (ctype, data) in enumerate(chunks):
        if ctype not in (b'tEXt', b'iTXt'):
            continue
        kw, sep, payload = data.partition(b'\x00')
        if sep and kw in (b'chara', b'ccv3'):
            hits.append((i, kw, payload))
    return hits


def apply_fields(obj: dict, fields: dict) -> dict:
    target = obj.get('data') if isinstance(obj.get('data'), dict) else obj
    for key, value in fields.items():
        target[key] = value
        if key in obj and obj is not target:
            obj[key] = value
    return obj


def process(card: pathlib.Path, fields: dict, dry: bool, stamp: str) -> bool:
    raw = card.read_bytes()
    chunks = read_chunks(raw)
    payloads = card_payloads(chunks)

    if not payloads:
        print(f"  !! {card.name}: no chara/ccv3 tEXt chunk found")
        return False

    before = {ctype: sum(1 for c, _ in chunks if c == ctype) for ctype, _ in chunks}

    for idx, kw, payload in payloads:
        obj = json.loads(base64.b64decode(payload).decode('utf-8'))
        apply_fields(obj, fields)
        encoded = base64.b64encode(
            json.dumps(obj, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        )
        chunks[idx] = (chunks[idx][0], kw + b'\x00' + encoded)

    after = {ctype: sum(1 for c, _ in chunks if c == ctype) for ctype, _ in chunks}
    if before != after:
        print(f"  !! {card.name}: chunk inventory changed - refusing to write")
        return False

    new_raw = write_chunks(chunks)
    print(f"  {card.name}: {len(payloads)} chara block(s) updated, "
          f"{len(raw)} -> {len(new_raw)} bytes ({len(new_raw) - len(raw):+d}), "
          f"IDAT untouched ({after.get(b'IDAT', 0)} chunks)")

    if dry:
        print("        [dry-run] not written")
        return True

    bak = card.with_name(card.name + f'.bak-{stamp}')
    shutil.copy2(card, bak)
    card.write_bytes(new_raw)

    # read back and assert
    re_chunks = read_chunks(card.read_bytes())
    for _, _, payload in card_payloads(re_chunks):
        obj = json.loads(base64.b64decode(payload).decode('utf-8'))
        target = obj.get('data') if isinstance(obj.get('data'), dict) else obj
        for key, value in fields.items():
            if target.get(key) != value:
                shutil.copy2(bak, card)
                print(f"        !! read-back mismatch on '{key}' - backup restored")
                return False
    print(f"        backup: {bak.name}   read-back verified: OK")
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--card', action='append', required=True)
    ap.add_argument('--json', required=True)
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    fields = json.loads(pathlib.Path(args.json).read_text(encoding='utf-8'))
    stamp = time.strftime('%Y%m%d-%H%M%S')

    print('=' * 70)
    print(f"set card fields: {', '.join(fields)}   dry-run={args.dry_run}")
    print('=' * 70)
    ok = True
    for c in args.card:
        p = pathlib.Path(c)
        if not p.is_file():
            print(f"  !! missing: {p}")
            ok = False
            continue
        ok = process(p, fields, args.dry_run, stamp) and ok
    print('=' * 70)
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
