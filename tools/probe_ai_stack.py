"""Probe the AI stack used by MimirLink.

Checks, in order:
  1. which models api.deepseek.com actually exposes
  2. whether deepseek-v4-* accepts image input (true multimodal?) 
  3. whether deepseek-chat accepts image input (expected: no)
  4. reasoning-token behaviour of deepseek-v4-flash with a sane token budget
  5. DuckDuckGo reachability, direct vs. through the system proxy

The API key is read from MimirLink's config.json - never hard-coded here.
Run:  python probe_ai_stack.py
"""
import base64
import json
import os
import struct
import sys
import urllib.error
import urllib.request
import zlib

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

CFG = r"C:\Users\20633\MimirLink\config.json"


def load_cfg():
    with open(CFG, encoding="utf-8") as fh:
        return json.load(fh)


def make_png(size, rgb):
    """Minimal solid-colour 8-bit RGB PNG, so we can test vision without assets."""
    raw = b"".join(b"\x00" + bytes(rgb) * size for _ in range(size))

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


def system_proxy():
    found = {}
    for key in ("http_proxy", "https_proxy", "all_proxy",
                "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
        if os.environ.get(key):
            found[key] = os.environ[key]
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                            r"Software\Microsoft\Windows\CurrentVersion\Internet Settings") as k:
            enable, _ = winreg.QueryValueEx(k, "ProxyEnable")
            server, _ = winreg.QueryValueEx(k, "ProxyServer")
        found["registry"] = f"{server} (ProxyEnable={enable})"
    except Exception as exc:
        found["registry"] = f"<unreadable: {exc}>"
    return found


def build_opener(use_proxy):
    if use_proxy:
        return urllib.request.build_opener()
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def post_json(url, payload, key, timeout=60, use_proxy=False):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", "Bearer " + key)
    opener = build_opener(use_proxy)
    try:
        with opener.open(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(body)
        except Exception:
            return exc.code, {"_raw": body[:600]}
    except Exception as exc:
        return None, {"_error": f"{type(exc).__name__}: {exc}"}


def main():
    cfg = load_cfg()
    ai = cfg.get("ai", {})
    base = str(ai.get("baseUrl") or "").rstrip("/")
    key = str(ai.get("apiKey") or "")
    if not key:
        print("!! no apiKey in config.json, aborting")
        return

    print("=" * 66)
    print("baseUrl :", base)
    print("key     :", key[:8] + "..." + key[-4:], f"({len(key)} chars)")
    print("current :", ai.get("model"), "/", cfg.get("chat", {}).get("model"))
    print("=" * 66)

    print("\n--- 1. model list ---")
    req = urllib.request.Request(base + "/models")
    req.add_header("Authorization", "Bearer " + key)
    try:
        with build_opener(False).open(req, timeout=30) as resp:
            listing = json.loads(resp.read().decode("utf-8"))
        ids = sorted(m.get("id", "") for m in listing.get("data", []))
        for i in ids:
            print("   ", i)
        if not ids:
            print("    (empty)", json.dumps(listing)[:300])
    except Exception as exc:
        print("    FAILED:", type(exc).__name__, exc)

    png = make_png(16, (220, 30, 30))
    b64 = base64.b64encode(png).decode("ascii")
    print(f"\n   probe image: 16x16 solid red PNG, {len(png)} bytes")

    def vision_test(model):
        payload = {
            "model": model,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": "这张图是什么颜色？只回答一个中文颜色词。"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64," + b64}},
                ],
            }],
            "max_tokens": 800,
        }
        status, body = post_json(base + "/chat/completions", payload, key)
        if status is None:
            print(f"    {model:22} NETWORK FAIL: {body.get('_error')}")
            return
        if status != 200:
            msg = body.get("error", {}).get("message") if isinstance(body.get("error"), dict) else body.get("_raw")
            print(f"    {model:22} HTTP {status} -> REJECTS IMAGE: {str(msg)[:160]}")
            return
        choice = (body.get("choices") or [{}])[0]
        msg = choice.get("message") or {}
        content = (msg.get("content") or "").strip()
        reasoning = msg.get("reasoning_content") or ""
        usage = body.get("usage") or {}
        print(f"    {model:22} HTTP 200 -> VISION OK")
        print(f"        reply     : {content[:120]!r}")
        print(f"        reasoning : {len(reasoning)} chars")
        print(f"        usage     : {json.dumps(usage, ensure_ascii=False)}")

    print("\n--- 2. vision test: deepseek-v4-flash ---")
    vision_test("deepseek-v4-flash")

    print("\n--- 3. vision test: deepseek-chat (expected to fail) ---")
    vision_test("deepseek-chat")

    print("\n--- 4. text-only sanity, budget 2000 ---")
    for model in ("deepseek-v4-flash", "deepseek-chat"):
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": "用一句话回答：你是谁？"}],
            "max_tokens": 2000,
        }
        status, body = post_json(base + "/chat/completions", payload, key)
        if status != 200:
            print(f"    {model:22} HTTP {status} {json.dumps(body, ensure_ascii=False)[:150]}")
            continue
        msg = ((body.get("choices") or [{}])[0].get("message") or {})
        content = (msg.get("content") or "").strip()
        reasoning = msg.get("reasoning_content") or ""
        print(f"    {model:22} content={len(content)}c reasoning={len(reasoning)}c "
              f"finish={(body.get('choices') or [{}])[0].get('finish_reason')}")
        print(f"        {content[:110]!r}")

    print("\n--- 5. DuckDuckGo reachability ---")
    print("    proxy env/registry:")
    for k, v in system_proxy().items():
        print(f"      {k:12} = {v}")

    ddg = "https://html.duckduckgo.com/html/?q=hello&l=cn-zh"
    for label, use_proxy in (("direct", False), ("via proxy", True)):
        try:
            req = urllib.request.Request(ddg, headers={
                "Accept": "text/html,application/xhtml+xml",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            })
            with build_opener(use_proxy).open(req, timeout=15) as resp:
                html = resp.read().decode("utf-8", "replace")
            has = "result__a" in html or "result-link" in html
            print(f"    {label:10} HTTP {resp.status}  {len(html)} bytes  results_marker={has}")
        except Exception as exc:
            print(f"    {label:10} FAILED: {type(exc).__name__}: {str(exc)[:120]}")

    print("\n" + "=" * 66)


if __name__ == "__main__":
    main()
