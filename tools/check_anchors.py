#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""确认两个实例的语气锚点各自生效，示例对话各自注入。"""
import sys
import os

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lab_client import Client  # noqa: E402

for which, label in (("soyo", "素世"), ("anon", "爱音")):
    c = Client(which)
    assert c.login(), f"{label} 登录失败"
    c.refresh_cards()
    st, p = c.preview("在吗", message_type="private")
    if st != 200:
        print(f"=== {label} === 预览失败 {st}")
        continue
    ex = [m for m in p["messages"] if (m.get("meta") or {}).get("source") == "example_dialogue"]
    foc = [m["content"] for m in p["messages"]
           if m["role"] == "system" and "current-message-focus" in (m.get("content") or "")]
    anchor = [l for l in (foc[0].splitlines() if foc else []) if l.startswith("注意")]
    chars = [m["content"] for m in ex if m["role"] == "assistant"]
    bang = sum(1 for s in chars if "!" in s or "！" in s)
    print(f"=== {label} ===")
    print(f"  示例对话轮数 {len(ex)}（其中她的台词 {len(chars)} 条，带感叹号 {bang} 条）")
    print(f"  注意行: {anchor[0][:130] if anchor else '（无）'}")
    if chars[:3]:
        print(f"  示例样例: {chars[:3]}")
