"""Set the search provider chain (primary + fallbacks) for both MimirLink instances.

Separate from set_search_key.py on purpose: that one owns API keys, this one owns
the ORDER of providers. Nothing here touches any key.

Why the order matters: runSearch() only returns when a provider yields at least
one result, so a primary that answers with 0 results automatically falls through
to the next provider. That makes "free engine first, paid engine as backstop"
a working strategy rather than a gamble.

Usage:
    python set_search_chain.py --show
    python set_search_chain.py --provider searxng --fallback bocha --searxng-url http://127.0.0.1:8888
    python set_search_chain.py --provider bocha --fallback searxng
    python set_search_chain.py --fallback none
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

KNOWN = ("duckduckgo", "searxng", "tavily", "brave", "serpapi", "bocha")

argv = sys.argv[1:]


def get_ws(cfg):
    return cfg.setdefault("ai", {}).setdefault("tools", {}).setdefault("webSearch", {})


if "--show" in argv:
    for t in TARGETS:
        p = pathlib.Path(t)
        ws = get_ws(json.loads(p.read_text(encoding="utf-8")))
        print(p)
        print("   enabled      = %s" % ws.get("enabled"))
        print("   provider     = %s" % ws.get("provider"))
        print("   fallbacks    = %s" % (ws.get("fallbackProviders") or []))
        print("   searxngUrl   = %s" % (ws.get("searxngBaseUrl") or "(empty)"))
        print("   searxngEng   = %s" % (ws.get("searxngEngines") or "(empty)"))
    sys.exit(0)


def take(name):
    if name in argv:
        i = argv.index(name)
        if i + 1 >= len(argv):
            sys.exit("%s needs a value" % name)
        return argv[i + 1]
    return None


provider = take("--provider")
fallback_raw = take("--fallback")
searxng_url = take("--searxng-url")

if provider is None and fallback_raw is None and searxng_url is None:
    sys.exit(__doc__)

if provider is not None and provider not in KNOWN:
    sys.exit("unknown provider %r; pick one of %s" % (provider, KNOWN))

fallback_list = None
if fallback_raw is not None:
    if fallback_raw.strip().lower() in ("none", "", "[]"):
        fallback_list = []
    else:
        fallback_list = [x.strip() for x in fallback_raw.split(",") if x.strip()]
        bad = [x for x in fallback_list if x not in KNOWN]
        if bad:
            sys.exit("unknown fallback provider(s): %s" % bad)

stamp = time.strftime("%Y%m%d-%H%M%S")

for t in TARGETS:
    p = pathlib.Path(t)
    cfg = json.loads(p.read_text(encoding="utf-8"))
    ws = get_ws(cfg)

    changes = []
    if provider is not None:
        ws["provider"] = provider
        changes.append("provider=%s" % provider)
    if fallback_list is not None:
        ws["fallbackProviders"] = fallback_list
        changes.append("fallbackProviders=%s" % (fallback_list or "[]"))
    if searxng_url is not None:
        ws["searxngBaseUrl"] = searxng_url
        changes.append("searxngBaseUrl=%s" % searxng_url)

    # a chain is only meaningful when search is switched on
    if not ws.get("enabled"):
        ws["enabled"] = True
        changes.append("enabled=true")

    shutil.copy2(p, p.with_name(p.name + ".bak-" + stamp))
    p.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("  %-14s %s" % (p.parent.name, ", ".join(changes)))

print("\nRestart MimirLink. Verify the chain with:  node verify_bocha.mjs")
