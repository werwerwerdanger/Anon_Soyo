#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Probe which search engines actually WORK inside the local SearXNG container.

WHY: the JSON API returns HTTP 200 with an empty result list. The reason is
buried in the response's `unresponsive_engines` field, which looks like:

    [["baidu", "CAPTCHA"]]      <- Baidu served an anti-bot challenge
    [["bing",  "timeout"]]      <- engine took too long
    []                          <- no engine was selected at all (config bug)

So "0 results" is not one problem, it is three different problems. This script
tells them apart, and tests every engine that could plausibly answer from a
mainland-China network.

Usage:
    python probe_searxng_engines.py
    python probe_searxng_engines.py --port 8888 --query "成都理工大学"
    python probe_searxng_engines.py --no-chinese
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# Engines worth trying from mainland China. The Google/DuckDuckGo/Brave family
# is pointless here: their domains are DNS-poisoned (verified separately).
CANDIDATES = [
    "baidu",
    "bing",
    "sogou",
    "360search",
    "quark",
    "wikipedia",
    "bilibili",
    "mojeek",
]

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"


def ask(base, query, engines=None, timeout=45):
    params = {"q": query, "format": "json", "language": "zh-CN"}
    if engines:
        params["engines"] = engines
    url = base + "/search?" + urllib.parse.urlencode(params)
    t0 = time.time()
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            ctype = r.headers.get("Content-Type", "")
            status = r.status
    except urllib.error.HTTPError as e:
        return {"ms": int((time.time() - t0) * 1000), "status": e.code,
                "err": f"HTTP {e.code}", "n": 0, "unresponsive": [], "samples": []}
    except Exception as e:
        return {"ms": int((time.time() - t0) * 1000), "status": None,
                "err": type(e).__name__, "n": 0, "unresponsive": [], "samples": []}

    ms = int((time.time() - t0) * 1000)
    if "json" not in ctype.lower():
        return {"ms": ms, "status": status, "err": f"not json ({ctype})",
                "n": 0, "unresponsive": [], "samples": []}
    try:
        payload = json.loads(raw.decode("utf-8", "replace"))
    except Exception as e:
        return {"ms": ms, "status": status, "err": f"parse: {e}",
                "n": 0, "unresponsive": [], "samples": []}

    results = payload.get("results") or []
    return {
        "ms": ms,
        "status": status,
        "err": "",
        "n": len(results),
        "unresponsive": payload.get("unresponsive_engines") or [],
        "samples": [
            {"engine": x.get("engine"), "title": (x.get("title") or "")[:64],
             "url": (x.get("url") or "")[:60]}
            for x in results[:3]
        ],
    }


def show(label, r):
    if r["err"]:
        print(f"  {label:<26} FAIL  {r['ms']:>6}ms  {r['err']}")
        return False
    if r["n"] > 0:
        print(f"  {label:<26} OK    {r['ms']:>6}ms  {r['n']} results")
        for s in r["samples"]:
            print(f"        [{s['engine']}] {s['title']}")
        return True
    # zero results -- distinguish the three possible causes
    if not r["unresponsive"]:
        print(f"  {label:<26} ZERO  {r['ms']:>6}ms  no engine selected "
              f"(check keep_only / categories)")
    else:
        reasons = "; ".join(f"{e}={why}" for e, why in r["unresponsive"])
        print(f"  {label:<26} ZERO  {r['ms']:>6}ms  {reasons}")
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8888)
    ap.add_argument("--query", default="test")
    ap.add_argument("--no-chinese", action="store_true",
                    help="skip the extra Chinese-language probe")
    args = ap.parse_args()

    base = f"http://127.0.0.1:{args.port}"

    print("=" * 78)
    print(f"SearXNG engine probe   base={base}   query='{args.query}'")
    print("=" * 78)

    print("\n--- A. default query (no engines= filter) ---")
    r = ask(base, args.query)
    show("default", r)
    if not r["unresponsive"] and r["n"] == 0:
        print("        -> SearXNG chose no engine at all. That usually means the")
        print("           keep_only list in settings.yml filtered everything out, or")
        print("           the default category has no enabled engine.")

    print("\n--- B. one engine at a time ---")
    working = []
    for eng in CANDIDATES:
        r = ask(base, args.query, engines=eng)
        if show(eng, r):
            working.append(eng)

    if not args.no_chinese:
        print("\n--- C. Chinese query, engines that worked above ---")
        cn_q = "成都理工大学"
        if not working:
            print("  (skipped: no engine worked in section B)")
        for eng in working:
            r = ask(base, cn_q, engines=eng)
            show(eng, r)

    print()
    print("=" * 78)
    print("VERDICT")
    print("=" * 78)
    if working:
        print(f"  working engines: {', '.join(working)}")
        print("  -> put them in settings.yml keep_only and re-run run-local.ps1 -ForceSettings")
    else:
        print("  NO engine returned results.")
        print("  - CAPTCHA     -> the engine is blocking this IP/network.")
        print("  - zero+none   -> a settings.yml problem, not a network problem.")
        print("  Consider hosting SearXNG on the aliyun ECS instead.")
    return 0 if working else 1


if __name__ == "__main__":
    sys.exit(main())
