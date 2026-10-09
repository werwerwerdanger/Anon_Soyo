#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Probe public SearXNG instances for real JSON-API usability.

Key point: an HTTP 200 is NOT enough. Public instances frequently
(a) disable the json format -> HTML page returned with 200, or
(b) serve an anti-bot interstitial with 200.

So for every instance we check:
  1. TCP/TLS reachability + HTTP status
  2. response Content-Type must be application/json
  3. body must parse as JSON
  4. JSON must contain a "results" list
  5. record how many results and how long it took

Usage:
    python probe_public_searxng.py
    python probe_public_searxng.py --query "今天成都天气"
"""
import argparse
import json
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

INSTANCES = [
    "https://searx.be",
    "https://searx.party",
    "https://search.sapti.me",
    "https://searx.tiekoetter.com",
    "https://searx.work",
    "https://searx.ninja",
    "https://searx.fmac.xyz",
    "https://search.bus-hit.me",
    "https://searx.catfluori.de",
    "https://search.ononoki.org",
    "https://baresearch.org",
    "https://priv.au",
    "https://searxng.site",
    "https://search.inetol.net",
    "https://opnxng.com",
    "https://searx.tuxcloud.net",
    "https://paulgo.io",
    "https://search.rhscz.eu",
]

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE


def probe(base, query, timeout):
    url = base.rstrip("/") + "/search?" + urllib.parse.urlencode({
        "q": query,
        "format": "json",
        "language": "zh-CN",
    })
    t0 = time.time()
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": UA,
            "Accept": "application/json,text/html;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        })
        with urllib.request.urlopen(req, timeout=timeout, context=CTX) as resp:
            status = resp.status
            ctype = (resp.headers.get("Content-Type") or "").lower()
            raw = resp.read()
    except urllib.error.HTTPError as e:
        return {"ok": False, "status": e.code, "reason": f"HTTP {e.code}",
                "ms": int((time.time() - t0) * 1000)}
    except Exception as e:
        return {"ok": False, "status": None, "reason": type(e).__name__,
                "detail": str(e)[:80], "ms": int((time.time() - t0) * 1000)}

    ms = int((time.time() - t0) * 1000)

    if "json" not in ctype:
        return {"ok": False, "status": status, "ctype": ctype,
                "reason": "not-json-content-type",
                "ms": ms, "bytes": len(raw)}

    try:
        payload = json.loads(raw.decode("utf-8", "replace"))
    except Exception as e:
        return {"ok": False, "status": status, "ctype": ctype,
                "reason": "json-parse-fail", "detail": str(e)[:80], "ms": ms}

    if not isinstance(payload, dict) or "results" not in payload:
        return {"ok": False, "status": status, "ctype": ctype,
                "reason": "no-results-key", "keys": list(payload)[:8] if isinstance(payload, dict) else None,
                "ms": ms}

    results = payload.get("results") or []
    sample = [r.get("title", "")[:60] for r in results[:3]]
    return {"ok": True, "status": status, "ctype": ctype,
            "reason": "ok", "n": len(results), "ms": ms,
            "engines": payload.get("number_of_results"),
            "sample": sample}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--query", default="成都理工大学")
    ap.add_argument("--timeout", type=int, default=15)
    ap.add_argument("--only", default="", help="comma separated substrings to filter instances")
    args = ap.parse_args()

    targets = INSTANCES
    if args.only:
        parts = [p.strip() for p in args.only.split(",") if p.strip()]
        targets = [u for u in INSTANCES if any(p in u for p in parts)]

    print(f"query    : {args.query}")
    print(f"timeout  : {args.timeout}s")
    print(f"targets  : {len(targets)}")
    print("-" * 78)

    good = []
    for base in targets:
        r = probe(base, args.query, args.timeout)
        host = urllib.parse.urlparse(base).netloc
        if r["ok"]:
            good.append((base, r["n"], r["ms"]))
            print(f"  PASS  {host:<28} n={r['n']:<3} {r['ms']:>5}ms  {r.get('sample', [''])[0][:40]}")
        else:
            extra = r.get("detail") or r.get("ctype") or r.get("keys") or ""
            print(f"  FAIL  {host:<28} {r['reason']:<22} {str(extra)[:34]}")

    print("-" * 78)
    print(f"usable: {len(good)}/{len(targets)}")
    for base, n, ms in sorted(good, key=lambda x: -x[1]):
        print(f"  {base:<32} n={n:<3} {ms}ms")

    if not good:
        print()
        print("VERDICT: no public instance returned usable JSON from this machine.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
