"""Follow-up probe.

The /models endpoint listed only: deepseek-flash, deepseek-v4-pro
but the first probe called deepseek-v4-flash and still got HTTP 200.
Find out which names really work, and which of them handle images.
"""
import base64
import json
import sys

sys.path.insert(0, r"C:\Users\20633\WorkBuddy\2026-05-28-17-36-40\mimir-tools")
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from probe_ai_stack import load_cfg, make_png, post_json  # noqa: E402

cfg = load_cfg()
base = str(cfg["ai"]["baseUrl"]).rstrip("/")
key = cfg["ai"]["apiKey"]
b64 = base64.b64encode(make_png(16, (220, 30, 30))).decode("ascii")

MODELS = [
    "deepseek-flash",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "deepseek-chat",
    "deepseek-reasoner",
    "deepseek-v4-vision",
]


def summarise(body):
    ch = (body.get("choices") or [{}])[0]
    msg = ch.get("message") or {}
    usage = body.get("usage") or {}
    detail = usage.get("completion_tokens_details") or {}
    return {
        "content": (msg.get("content") or "").strip(),
        "reasoning_chars": len(msg.get("reasoning_content") or ""),
        "finish": ch.get("finish_reason"),
        "prompt_tokens": usage.get("prompt_tokens"),
        "completion_tokens": usage.get("completion_tokens"),
        "reasoning_tokens": detail.get("reasoning_tokens"),
    }


def err_of(body):
    e = body.get("error")
    if isinstance(e, dict):
        return str(e.get("message") or e)[:150]
    return str(body.get("_raw") or body.get("_error") or body)[:150]


def run(model, with_image):
    if with_image:
        content = [
            {"type": "text", "text": "这张图是什么颜色？只回答一个中文颜色词。"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64," + b64}},
        ]
    else:
        content = "用一句话回答：你是谁？"

    status, body = post_json(base + "/chat/completions", {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "max_tokens": 2000,
    }, key)
    return status, body


print("=" * 70)
print(f"{'model':22} {'image':6} {'status':7} result")
print("=" * 70)

for model in MODELS:
    for with_image in (True, False):
        status, body = run(model, with_image)
        tag = "img" if with_image else "text"
        if status != 200:
            print(f"{model:22} {tag:6} HTTP {status}  ERR: {err_of(body)}")
            continue
        info = summarise(body)
        print(f"{model:22} {tag:6} 200     content={info['content'][:34]!r}")
        print(f"{'':22} {'':6}         reasoning={info['reasoning_chars']}c "
              f"rtok={info['reasoning_tokens']} ptok={info['prompt_tokens']} "
              f"ctok={info['completion_tokens']} finish={info['finish']}")

print("=" * 70)
