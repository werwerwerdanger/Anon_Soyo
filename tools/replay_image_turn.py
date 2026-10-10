#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
replay_image_turn.py -- 把一张图接进某角色**真实的提示词**重跑一轮，看完整思考过程

为什么需要：
  · `ai.js:294` 原本只把 reasoning 存前 200 字，看不到结论；
  · 预览接口 `/api/runtime/prompt-preview` 的 userMessage 只收字符串，传不了图；
  · 图片字节 MimirLink 不入库、NapCat 也没存本地（本次是经 OneBot `get_msg`
    拿回 CDN url 才救回来的，见 `fetch_napcat_image.mjs`）。
所以：用预览接口拿到**真实拼装好的 messages**，再把图**挂到最后一轮 user 消息上**
（还原成多模态数组，和线上一致），然后自己调模型。

用法:
  python replay_image_turn.py --inst soyo --image x.jpg --upto 1791602497256_le73ny
"""
import argparse
import base64
import io
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _extract_humans  # noqa: F401
from lab_client import Client  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

INSTS = {
    "anon": (r"C:\Users\20633\MimirLink", r"C:\Users\20633\MimirLink\data\chats\memory-store.sqlite"),
    "soyo": (r"C:\Users\20633\MimirLink-soyo", r"C:\Users\20633\MimirLink-soyo\data\chats\memory-store.sqlite"),
}


def load_cfg(inst_dir):
    ai = json.load(open(os.path.join(inst_dir, "config.json"), encoding="utf-8")).get("ai", {})
    return {"baseUrl": ai.get("baseUrl", "https://api.deepseek.com").rstrip("/"),
            "apiKey": ai.get("apiKey", ""), "model": ai.get("model", "deepseek-chat"),
            "temperature": ai.get("temperature", 0.8)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--inst", default="soyo", choices=list(INSTS))
    ap.add_argument("--image", required=True)
    ap.add_argument("--upto", required=True, help="把上下文截到这条消息 id 之前（不含它）")
    ap.add_argument("--ctx", type=int, default=10, help="带多少条真实历史")
    ap.add_argument("--user-text", default="")
    args = ap.parse_args()

    inst_dir, db_path = INSTS[args.inst]
    db = sqlite3.connect(db_path)
    cur = db.cursor()
    cur.execute("SELECT role, content FROM messages WHERE session_id LIKE '%2063362809%' "
                "AND id < ? ORDER BY id DESC LIMIT ?", (args.upto, args.ctx))
    ctx = [{"role": r, "content": c} for r, c in cur.fetchall()[::-1]]
    print(f"上下文 {len(ctx)} 条（截到 {args.upto} 之前）")

    raw = open(args.image, "rb").read()
    mime = "image/jpeg" if raw[:3] == b"\xff\xd8\xff" else "image/png"
    b64 = base64.b64encode(raw).decode("ascii")

    c = Client(args.inst)
    c.login()
    st, prev = c.preview(args.user_text or "[图片]", recent_messages=ctx, message_type="private")
    msgs = prev.get("messages") or []
    print(f"预览装配出 {len(msgs)} 条消息")

    # 把图挂到最后一轮 user 消息（还原线上的多模态数组形态）
    last = None
    for m in reversed(msgs):
        if m.get("role") == "user":
            last = m
            break
    if last is None:
        print("!! 没找到 user 消息")
        return
    txt = last.get("content") if isinstance(last.get("content"), str) else ""
    last["content"] = [
        {"type": "text", "text": txt},
        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
    ]
    print(f"最后一轮 user 已改为多模态数组（文本 {len(txt)} 字 + 图 {len(raw):,}B）")

    cfg = load_cfg(inst_dir)
    body = {"model": cfg["model"], "messages": msgs,
            "temperature": cfg["temperature"], "max_tokens": 800, "stream": False}
    req = urllib.request.Request(
        cfg["baseUrl"] + "/chat/completions",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + cfg["apiKey"]},
        method="POST")
    print(f"调用 {cfg['model']}（temp={cfg['temperature']}）…")
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            j = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.read().decode("utf-8", "replace")[:400])
        return
    m = j["choices"][0]["message"]
    reason = m.get("reasoning_content", "") or ""
    print()
    print("=" * 76)
    print(f"[完整思考过程]  {len(reason)} 字")
    print(reason)
    print()
    print("=" * 76)
    print("[回复]", (m.get("content") or "").replace("\n", " / "))


if __name__ == "__main__":
    main()
