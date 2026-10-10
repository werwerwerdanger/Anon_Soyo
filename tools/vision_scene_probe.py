#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
vision_scene_probe.py -- 直接问视觉模型「这张图里在发生什么」

背景：`reason_lab.py` 显示素世收到图时思考过程有 987 字（日志只留 200），
前 200 字停在「This image depicts Soyo and Anon (pink hair with glasses = Anon
Chihaya)」——**认出了人，但看不出有没有读出动作/场景**。
日志放宽到 3000 后仍需要"她再看一次"才有完整版；
这个脚本用**同一张原图**直接问模型，独立验证视觉通道能读到什么粒度。

用法:
  python vision_scene_probe.py <图片路径> [--inst soyo]
"""
import argparse
import base64
import io
import json
import os
import sys
import urllib.error
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

INSTS = {"anon": r"C:\Users\20633\MimirLink", "soyo": r"C:\Users\20633\MimirLink-soyo"}

QUESTIONS = [
    "这张图里有什么？两个人在做什么？请具体描述动作和场景。",
    "图里两个人分别是什么姿态？其中一个人手里拿着什么？",
]


def load_cfg(inst):
    c = json.load(open(os.path.join(INSTS[inst], "config.json"), encoding="utf-8"))
    ai = c.get("ai", {})
    return {
        "baseUrl": ai.get("baseUrl", "https://api.deepseek.com").rstrip("/"),
        "apiKey": ai.get("apiKey", ""),
        "model": ai.get("model", "deepseek-chat"),
    }


def ask(cfg, img_b64, mime, q):
    body = {
        "model": cfg["model"],
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": q},
                {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{img_b64}"}},
            ],
        }],
        "max_tokens": 800,
    }
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        cfg["baseUrl"] + "/chat/completions", data=data,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + cfg["apiKey"]},
        method="POST")
    with urllib.request.urlopen(req, timeout=180) as r:
        j = json.loads(r.read().decode("utf-8"))
    m = j["choices"][0]["message"]
    return m.get("content", ""), m.get("reasoning_content", "")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--inst", default="soyo", choices=list(INSTS))
    args = ap.parse_args()

    raw = open(args.image, "rb").read()
    mime = "image/jpeg" if raw[:3] == b"\xff\xd8\xff" else "image/png"
    b64 = base64.b64encode(raw).decode("ascii")
    cfg = load_cfg(args.inst)
    print(f"图片: {args.image}  {len(raw):,} bytes  {mime}")
    print(f"模型: {cfg['model']} @ {cfg['baseUrl']}")
    print(f"base64 后大小: {len(b64):,} bytes（这就是每轮塞进 payload 的量）")
    print()
    for q in QUESTIONS:
        print("=" * 76)
        print("问:", q)
        try:
            content, reasoning = ask(cfg, b64, mime, q)
        except urllib.error.HTTPError as e:
            print("  HTTP", e.code, e.read().decode("utf-8", "replace")[:300])
            continue
        except Exception as e:
            print("  失败:", e)
            continue
        if reasoning:
            print("  [思考]", reasoning[:500].replace("\n", " / "))
        print("  [回答]", content.replace("\n", " / "))
        print()


if __name__ == "__main__":
    main()
