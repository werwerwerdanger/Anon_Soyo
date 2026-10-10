"""What are the search engines doing RIGHT NOW?

Every failure mode looks identical from the outside -- you just get fewer
results. This probe separates them by cross-referencing the container log,
which is the only place that tells the truth:

    crash    -> log has  ErrorContext(...'AttributeError'...)
    captcha  -> log has  SearxEngineCaptchaException(suspended_time=N)
    silent   -> no log line at all, the engine just returns less
    ok       -> results, and no log line

Usage:
    python probe_engines_now.py
"""

from __future__ import annotations

import json
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

BASE = "http://127.0.0.1:8888"
CONTAINER = "searxng"

CJK_ENGINES = ["360search", "sogou", "sogou_wechat", "quark", "baidu"]
LATIN_ENGINES = ["yandex", "360search", "bing"]

CJK_QUERIES = ["成都理工大学 2026 年招生简章", "蓝桥杯 2026 报名时间"]
LATIN_QUERIES = ["rust borrow checker explained"]


def opener():
    # The sandbox forces HTTP_PROXY on us; SearXNG is on loopback.
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def search(opener_, query, engines):
    """Ask exactly the way src/search/providers/searxng.js does."""
    bangs = " ".join(
        "!" + e.replace(" ", "_") for e in engines
    )
    q = f"{bangs} {query}" if bangs else query
    params = {
        "q": q,
        "format": "json",
        "categories": "general",
        "safesearch": "1",
        "pageno": "1",
    }
    url = f"{BASE}/search?" + urllib.parse.urlencode(params)
    try:
        with opener_.open(url, timeout=40) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return {"_http_error": f"{exc.code} {exc.reason}", "results": []}
    except Exception as exc:  # noqa: BLE001
        return {"_error": repr(exc), "results": []}


def docker_logs_since(ts):
    try:
        out = subprocess.run(
            ["docker", "logs", "--since", ts, CONTAINER],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
        )
        return out.stdout or ""
    except Exception as exc:  # noqa: BLE001
        return f"<<log read failed: {exc}>>"


def classify(log_text, engine):
    """Which failure signature did this engine leave in the log?"""
    needle = engine.replace(" ", ".")
    hits = [
        ln
        for ln in log_text.splitlines()
        if f"engines.{needle}" in ln or f"engines/{needle}" in ln
    ]
    if not hits:
        return "no log line", ""
    joined = "\n".join(hits)
    if "CaptchaException" in joined:
        tag = "CAPTCHA"
        for ln in hits:
            if "suspended_time" in ln:
                tag += f" ({ln.split('suspended_time=')[1].split(')')[0]}s)"
                break
        return tag, hits[-1].strip()[:110]
    if "AttributeError" in joined:
        return "CRASH (AttributeError)", hits[-1].strip()[:110]
    return "other warning", hits[-1].strip()[:110]


def main() -> None:
    op = opener()
    started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    print(f"probe start (UTC) = {started}\n")

    plan = []
    for q in CJK_QUERIES:
        for e in CJK_ENGINES:
            plan.append(("CJK", q, e))
    for q in LATIN_QUERIES:
        for e in LATIN_ENGINES:
            plan.append(("LATIN", q, e))

    rows = []
    for kind, q, engine in plan:
        data = search(op, q, [engine])
        results = data.get("results") or []
        unresponsive = data.get("unresponsive_engines") or []
        rows.append((kind, q, engine, data, results, unresponsive))
        n = len(results)
        flag = data.get("_http_error") or data.get("_error") or ""
        print(f"  {kind:5} !{engine:15} n={n:3}  {flag}")

    log_text = docker_logs_since(started)

    print("\n" + "=" * 78)
    print("逐引擎判定（结果数 + 容器日志交叉验证）")
    print("=" * 78)
    for kind, q, engine, data, results, unresponsive in rows:
        verdict, evidence = classify(log_text, engine)
        print(f"\n[{kind}] !{engine}   query={q}")
        print(f"       结果数 = {len(results)}   unresponsive = {unresponsive or '无'}")
        print(f"       日志判定 = {verdict}")
        if evidence and verdict != "no log line":
            print(f"       日志原文 = {evidence}")
        for r in results[:3]:
            title = (r.get("title") or "")[:78]
            eng = ",".join(r.get("engines") or [])
            print(f"         - {title}" + (f"   [{eng}]" if eng else ""))

    print("\n" + "=" * 78)
    print("汇总")
    print("=" * 78)
    summary = {}
    for kind, q, engine, data, results, unresponsive in rows:
        verdict, _ = classify(log_text, engine)
        key = (engine, verdict)
        summary.setdefault(key, []).append(len(results))
    for (engine, verdict), counts in sorted(summary.items()):
        avg = sum(counts) / len(counts)
        print(f"  {engine:15} 判定={verdict:22} 平均结果数={avg:.1f}  ({counts})")


if __name__ == "__main__":
    main()
