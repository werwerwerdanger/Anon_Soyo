"""Set the Tavily API key for both MimirLink instances at once.

Usage:
    python set_search_key.py tvly-xxxxxxxxxxxxxxxx
    python set_search_key.py --provider serpapi <key>
    python set_search_key.py --show
    python set_search_key.py --clear

Also flips webSearch.enabled and webSearch.provider if needed, so a single
command is enough to go live. Backs up each config.json first.
"""
import json
import pathlib
import shutil
import sys
import time

TARGETS = [
    r"C:\Users\20633\MimirLink\config.json",
    r"C:\Users\20633\MimirLink-soyo\config.json",
]
VALID_PROVIDERS = ("tavily", "brave", "serpapi", "duckduckgo", "searxng", "bocha")

argv = sys.argv[1:]

if "--show" in argv:
    for t in TARGETS:
        cfg = json.loads(pathlib.Path(t).read_text(encoding="utf-8"))
        ws = cfg["ai"]["tools"]["webSearch"]
        keys = ws.get("apiKeys", {})
        print(f"{t}")
        print(f"   enabled  = {ws.get('enabled')}")
        print(f"   provider = {ws.get('provider')}")
        for name in ("bocha", "tavily", "brave", "serpapi"):
            val = keys.get(name) or ""
            print(f"   {name:8} = " + (f"SET ({len(val)} chars, {val[:6]}...{val[-4:]})" if val else "EMPTY"))
    sys.exit(0)

provider = "tavily"
if "--provider" in argv:
    i = argv.index("--provider")
    provider = argv[i + 1]
    del argv[i:i + 2]
    if provider not in VALID_PROVIDERS:
        sys.exit(f"unknown provider {provider!r}; pick one of {VALID_PROVIDERS}")

key = "" if "--clear" in argv else (argv[0] if argv else "")
if not key and "--clear" not in argv:
    sys.exit(__doc__)

stamp = time.strftime("%Y%m%d-%H%M%S")
for t in TARGETS:
    p = pathlib.Path(t)
    cfg = json.loads(p.read_text(encoding="utf-8"))
    ws = cfg.setdefault("ai", {}).setdefault("tools", {}).setdefault("webSearch", {})
    keys = ws.setdefault("apiKeys", {})
    keys[provider] = key
    ws["provider"] = provider
    ws["enabled"] = bool(key)
    shutil.copy2(p, p.with_name(p.name + f".bak-{stamp}"))
    p.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    shown = f"{key[:6]}...{key[-4:]}" if key else "(cleared)"
    print(f"  {p.parent.name:18} provider={provider} enabled={bool(key)} key={shown}")

print("\nRestart MimirLink for the change to take effect, then test with: python test_search.py")
