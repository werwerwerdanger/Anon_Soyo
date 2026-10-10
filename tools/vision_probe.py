#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
vision_probe.py -- 判定 deepseek-flash 到底有没有视觉通道

做法：纯 Python 生成一张「已知内容」的小 PNG（不需要 PIL），
以 OpenAI 兼容格式的 image_url(data:) 发给 MimirLink 配置里那个模型，
看它能否说出图中的真实内容。

判据：
  * 说对了颜色/形状  -> 真的能看图（爱音对表情包的描述可信）
  * 说看不到/拒答    -> 无视觉通道（她的描述是编的，必须关掉 direct 模式）
  * 编了一个错答案   -> 更危险：它假装看得见
"""
import base64
import json
import struct
import sys
import urllib.error
import urllib.request
import zlib

sys.stdout.reconfigure(encoding="utf-8")

CFG = r"C:\Users\20633\MimirLink\config.json"


def png_solid(width, height, rgb):
    """极简真彩 PNG 编码器：纯色填充。"""
    r, g, b = rgb
    raw = b""
    row = bytes([r, g, b]) * width
    for _ in range(height):
        raw += b"\x00" + row  # filter type 0

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # 8bit truecolor
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


def main():
    cfg = json.load(open(CFG, encoding="utf-8"))["ai"]
    base = cfg["baseUrl"].rstrip("/")
    key = cfg["apiKey"]
    model = cfg["model"]
    print(f"model={model}  base={base}")

    # 测试图：纯洋红色（magenta）。模型若真能看图必须说出"洋红/紫红/品红"，
    # 而不是"红/粉/看不到"。
    img = png_solid(96, 96, (255, 0, 255))
    b64 = base64.b64encode(img).decode()
    print(f"测试图 {len(img)} bytes -> base64 {len(b64)} chars，颜色应为洋红/品红(magenta)")

    body = {
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": "这张图里是什么颜色？只回答颜色，不要解释。"},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
            ],
        }],
        "max_tokens": 300,
        "temperature": 0,
    }
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        base + "/chat/completions", data=data,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            j = json.loads(r.read().decode("utf-8"))
        print("RESPONSE:", json.dumps(j, ensure_ascii=False)[:600])
        msg = j["choices"][0]["message"]
        print("content:", repr(msg.get("content")))
        print("reasoning:", repr(msg.get("reasoning_content"))[:200] if msg.get("reasoning_content") else None)
    except urllib.error.HTTPError as e:
        print("HTTP", e.code)
        print(e.read().decode("utf-8", "replace")[:900])
    except Exception as e:
        print("ERR", type(e).__name__, e)


if __name__ == "__main__":
    main()
