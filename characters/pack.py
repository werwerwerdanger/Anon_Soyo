# -*- coding: utf-8 -*-
"""把调教后的角色卡数据重新打包成标准 SillyTavern V2 PNG。"""
import struct, base64, json, zlib, os, sys

sys.stdout.reconfigure(encoding='utf-8')

def png_chunks(data):
    assert data[:8] == b'\x89PNG\r\n\x1a\n', 'not a png'
    pos = 8
    chunks = []
    while pos + 8 <= len(data):
        ln = struct.unpack('>I', data[pos:pos+4])[0]
        ctype = data[pos+4:pos+8]
        cdata = data[pos+8:pos+8+ln]
        chunks.append((ctype, cdata))
        pos += 12 + ln
        if ctype == b'IEND':
            break
    return chunks

def make_chunk(ctype, cdata):
    return struct.pack('>I', len(cdata)) + ctype + cdata + \
           struct.pack('>I', zlib.crc32(ctype + cdata) & 0xffffffff)

def pack_card(src_png, new_data, out_png):
    with open(src_png, 'rb') as f:
        src = f.read()
    chunks = png_chunks(src)

    v2 = {"spec": "chara_card_v2", "spec_version": "2.0", "data": new_data}
    b64 = base64.b64encode(json.dumps(v2, ensure_ascii=False).encode('utf-8'))
    v1 = {"data": new_data}
    b64_v1 = base64.b64encode(json.dumps(v1, ensure_ascii=False).encode('utf-8'))

    out = b'\x89PNG\r\n\x1a\n'
    # IHDR 原样
    out += make_chunk(b'IHDR', chunks[0][1])
    # 新 chara 两个 chunk（V2 + V1 兼容）
    out += make_chunk(b'tEXt', b'chara\x00' + b64)
    out += make_chunk(b'tEXt', b'chara\x00' + b64_v1)
    # 其余 chunk：跳过旧的 chara tEXt
    for ctype, cdata in chunks[1:]:
        if ctype == b'tEXt' and cdata.startswith(b'chara\x00'):
            continue
        out += make_chunk(ctype, cdata)
    with open(out_png, 'wb') as f:
        f.write(out)
    return out_png
