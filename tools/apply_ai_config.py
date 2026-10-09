"""Apply the AI settings to both MimirLink instances.

Changes, per instance:
  * chat.model / ai.model / providers[0].model  -> deepseek-flash
      (the only officially supported name that also accepts images)
  * providers[0].models                          -> the three usable names,
                                                    with flash enabled
  * ai.tools.webSearch.enabled                   -> True
  * ai.tools.webSearch.provider                  -> tavily
  * ai.tools.webSearch.apiKeys.tavily            -> TAVILY_KEY below

Leaves chat.imageCaptionModel empty on purpose: image-input.js then returns
mode:'direct' unconditionally, so the original picture is handed straight to
the multimodal chat model instead of being captioned first.

Every config.json is backed up next to itself as config.json.bak-<stamp>.
Run:  python apply_ai_config.py [--dry-run]
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

MODEL = "deepseek-flash"
KNOWN_MODELS = ["deepseek-flash", "deepseek-v4-pro", "deepseek-chat"]
SEARCH_PROVIDER = "tavily"
TAVILY_KEY = ""
BRAVE_KEY = ""
SERPAPI_KEY = ""

DRY = "--dry-run" in sys.argv
stamp = time.strftime("%Y%m%d-%H%M%S")


def patch(path):
    p = pathlib.Path(path)
    if not p.is_file():
        print(f"  !! missing: {p}")
        return
    cfg = json.loads(p.read_text(encoding="utf-8"))

    ai = cfg.setdefault("ai", {})
    chat = cfg.setdefault("chat", {})

    old = (ai.get("model"), chat.get("model"))

    ai["model"] = MODEL
    chat["model"] = MODEL

    providers = ai.get("providers")
    if isinstance(providers, list) and providers:
        prov = providers[0]
        prov["model"] = MODEL
        prov["models"] = [
            {"id": m, "name": m, "enabled": m == MODEL} for m in KNOWN_MODELS
        ]

    tools = ai.setdefault("tools", {})
    ws = tools.setdefault("webSearch", {})
    ws["enabled"] = True
    ws["provider"] = SEARCH_PROVIDER
    keys = ws.setdefault("apiKeys", {})
    keys["tavily"] = TAVILY_KEY
    keys["brave"] = BRAVE_KEY
    keys["serpapi"] = SERPAPI_KEY
    # keep the fetch fallback on so the model can open result pages
    ws.setdefault("fetch", {})["enabled"] = True

    # keep multimodal on the direct path
    chat["imageCaptionModel"] = ""
    chat["imageCaptionModelProviderId"] = ""
    chat["imageCaptionSkipWhenModelSupportsImage"] = True

    print(f"  {p}")
    print(f"     model      : {old[0]} / {old[1]}  ->  {MODEL}")
    print(f"     models list: {[m['id'] for m in (providers[0].get('models') if providers else [])]}")
    print(f"     webSearch  : enabled={ws['enabled']} provider={ws['provider']} "
          f"tavily_key={'set' if TAVILY_KEY else 'EMPTY'}")
    print(f"     image path : direct (imageCaptionModel empty)")

    if DRY:
        print("     [dry-run] not written")
        return

    bak = p.with_name(p.name + f".bak-{stamp}")
    shutil.copy2(p, bak)
    p.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"     backup     : {bak.name}")
    print(f"     written    : OK")


print("=" * 62)
print(f"apply MimirLink AI config   dry-run={DRY}   stamp={stamp}")
print("=" * 62)
for t in TARGETS:
    patch(t)
print("=" * 62)
