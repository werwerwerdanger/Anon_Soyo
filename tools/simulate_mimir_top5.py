"""What will the model ACTUALLY see?

Per-engine probes tell you which engines are alive. They do not tell you what
survives the merge. MimirLink asks for FIVE results and ranks everything by the
configured engine weight, so a chatty-but-off-topic engine can push the good
results straight out of the window.

This replays the exact request src/search/providers/searxng.js sends after the
lang-engines patch: language-routed !bangs in front of the query, maxResults=5.

Usage:
    python simulate_mimir_top5.py
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

BASE = "http://127.0.0.1:8888"

# Must match config.json -> ai.tools.webSearch.searxngEnginesCjk / ...Latin
CJK_ENGINES = "360search,sogou,sogou wechat,quark,baidu"
LATIN_ENGINES = "yandex,360search,bing"

CJK_QUERIES = [
    "成都理工大学 2026 年招生简章",
    "蓝桥杯 2026 报名时间",
]
LATIN_QUERIES = [
    "rust borrow checker explained",
    "kubernetes ingress vs gateway api",
]

MAX_RESULTS = 5


def bangs(engine_list: str) -> str:
    return " ".join(
        "!" + name.strip().replace(" ", "_")
        for name in engine_list.split(",")
        if name.strip()
    )


def search(query: str, engine_list: str) -> dict:
    q = f"{bangs(engine_list)} {query}"
    params = {
        "q": q,
        "format": "json",
        "categories": "general",
        "safesearch": "1",
        "pageno": "1",
    }
    url = f"{BASE}/search?" + urllib.parse.urlencode(params)
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with op.open(url, timeout=45) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return {"_err": f"HTTP {exc.code}", "results": []}
    except Exception as exc:  # noqa: BLE001
        return {"_err": repr(exc), "results": []}


def main() -> None:
    cases = [("CJK", q, CJK_ENGINES) for q in CJK_QUERIES]
    cases += [("LATIN", q, LATIN_ENGINES) for q in LATIN_QUERIES]

    for kind, query, engines in cases:
        data = search(query, engines)
        results = data.get("results") or []
        print("=" * 78)
        print(f"[{kind}] {query}")
        print(f"       engines = {engines}")
        print(f"       q       = {bangs(engines)} {query}")
        if data.get("_err"):
            print(f"       !! {data['_err']}")
        print(f"       总返回 = {len(results)} 条，模型只取前 {MAX_RESULTS} 条")
        print("-" * 78)
        for i, r in enumerate(results[:MAX_RESULTS], 1):
            title = (r.get("title") or "").strip()
            eng = ",".join(r.get("engines") or [])
            host = urllib.parse.urlparse(r.get("url") or "").netloc
            print(f"  {i}. [{eng:14}] {title[:66]}")
            print(f"      {host}")
        rest = [r for r in results[MAX_RESULTS:]]
        if rest:
            hosts = {}
            for r in rest:
                e = ",".join(r.get("engines") or [])
                hosts[e] = hosts.get(e, 0) + 1
            print(f"   ...被挤掉的 {len(rest)} 条来自: {hosts}")
        print()


if __name__ == "__main__":
    main()
