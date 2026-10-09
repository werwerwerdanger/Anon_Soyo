"""Install the Bocha (bochaai.com) search provider into both MimirLink copies.

Bocha is the mainland-China equivalent of Tavily: an AI-agent search API that
returns extracted, LLM-ready snippets instead of a page of blue links. MimirLink
ships only duckduckgo / searxng / tavily / brave / serpapi, so this script adds
the missing adapter and registers it.

What it does, per instance:
  1. writes  src/search/providers/bocha.js
  2. patches src/search/index.js - import + SEARCH_PROVIDERS + apiKeys defaults
  3. (with --keys) writes the API key into config.json and switches the provider

Every edit is idempotent and wrapped in markers, so re-running after a MimirLink
upgrade simply restores what the upgrade overwrote.

Usage:
    python patch_bocha.py --dry-run
    python patch_bocha.py
    python patch_bocha.py --keys sk-aaa,sk-bbb     # anon,soyo
    python patch_bocha.py --revert
"""
import json
import pathlib
import re
import shutil
import sys
import time

INSTANCES = [
    (r"C:\Users\20633\MimirLink", "anon"),
    (r"C:\Users\20633\MimirLink-soyo", "soyo"),
]

MARK_START = "// >>> bocha patch (managed by patch_bocha.py) >>>"
MARK_END = "// <<< bocha patch <<<"

PROVIDER_JS = r'''/**
 * 博查 Bocha 搜索 Provider（需 API Key）
 * 文档：https://open.bochaai.com
 *
 * 返回结构与 Tavily 不同：结果在 data.webPages.value[]，字段是
 * name / url / snippet / summary / datePublished / dateLastCrawled。
 * 已实测：site: 与 include 两种站点过滤都生效，这里用 include（不污染 query）；
 * freshness 支持 oneDay / oneWeek / oneMonth / oneYear / noLimit。
 */

import { requestText, clampInteger, isAbortError } from '../http.js';

const ENDPOINT = 'https://api.bochaai.com/v1/web-search';

const FRESHNESS_MAP = {
    day: 'oneDay',
    week: 'oneWeek',
    month: 'oneMonth',
    year: 'oneYear'
};

export const bochaProvider = {
    id: 'bocha',
    label: '博查 Bocha（需 API Key）',
    requiresApiKey: true,
    supportsNews: true,
    supportsTimeRange: true,
    supportsSite: true,
    async search(ctx) {
        if (!ctx.apiKey) {
            throw new Error('未配置博查 API Key');
        }

        const limit = clampInteger(ctx.limit, 1, 10, 5);
        const topic = String(ctx.topic || 'web').toLowerCase() === 'news' ? 'news' : 'web';
        const timeRange = String(ctx.timeRange || 'all').toLowerCase();

        // 博查没有独立的 news 频道，用 freshness 表达时效；news 且未指定范围时
        // 退化成「最近一天」，贴近新闻语义。
        let freshness = FRESHNESS_MAP[timeRange] || 'noLimit';
        if (topic === 'news' && !FRESHNESS_MAP[timeRange]) {
            freshness = 'oneDay';
        }

        const body = {
            query: String(ctx.query || ''),
            freshness,
            // summary 返回大模型可直接阅读的摘要，比裸 snippet 更完整
            summary: true,
            count: limit
        };
        if (ctx.site) {
            body.include = String(ctx.site);
        }

        let response;
        try {
            response = await requestText(ENDPOINT, {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${ctx.apiKey}`
                },
                body: JSON.stringify(body),
                timeoutMs: ctx.timeoutMs,
                signal: ctx.signal
            });
        } catch (error) {
            if (isAbortError(error)) {
                throw error;
            }
            throw new Error(`博查请求失败: ${error.message}`);
        }

        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                throw new Error('博查 API Key 无效或已过期');
            }
            if (response.status === 429) {
                throw new Error('博查触发限流（HTTP 429），请稍后再试');
            }
            throw new Error(`博查返回 HTTP ${response.status}`);
        }

        let payload;
        try {
            payload = JSON.parse(response.text);
        } catch {
            throw new Error('博查返回内容不是合法 JSON');
        }

        // 业务错误码藏在 body.code 里，HTTP 200 也可能是失败
        const code = Number(payload?.code);
        if (Number.isFinite(code) && code !== 200) {
            throw new Error(`博查返回业务错误 code=${code} msg=${payload?.msg || ''}`);
        }

        const items = payload?.data?.webPages?.value;
        const results = (Array.isArray(items) ? items : []).slice(0, limit).map((item) => ({
            title: String(item.name || ''),
            url: String(item.url || ''),
            snippet: String(item.summary || item.snippet || ''),
            publishedAt: item.datePublished || item.dateLastCrawled || ''
        })).filter((item) => item.url);

        return { source: 'bocha', results };
    }
};
'''


def patch_index(text):
    """Return (new_text, notes). Idempotent."""
    notes = []

    # --- 1. import ---------------------------------------------------------
    if "bochaProvider" in text and MARK_START in text:
        notes.append("import: already present")
    else:
        anchor = "import { serpapiProvider } from './providers/serpapi.js';\n"
        if anchor not in text:
            raise SystemExit("  [ERROR] cannot find the serpapi import anchor in index.js")
        block = f"{anchor}{MARK_START}\nimport {{ bochaProvider }} from './providers/bocha.js';\n{MARK_END}\n"
        text = text.replace(anchor, block, 1)
        notes.append("import: added")

    # --- 2. provider registry ---------------------------------------------
    m = re.search(r"(?m)^export const SEARCH_PROVIDERS = \[(.*?)\];\s*$", text)
    if not m:
        raise SystemExit("  [ERROR] cannot find SEARCH_PROVIDERS in index.js")
    members = [x.strip() for x in m.group(1).split(",") if x.strip()]
    if "bochaProvider" in members:
        notes.append("registry: already present")
    else:
        members.append("bochaProvider")
        new_line = "export const SEARCH_PROVIDERS = [" + ", ".join(members) + "];"
        text = text[:m.start()] + new_line + text[m.end():]
        notes.append("registry: added (%d -> %d providers)" % (len(members) - 1, len(members)))

    # --- 3. apiKeys defaults ----------------------------------------------
    m = re.search(r"apiKeys:\s*\{[^}]*\}", text)
    if not m:
        raise SystemExit("  [ERROR] cannot find the apiKeys defaults in index.js")
    if "bocha" in m.group(0):
        notes.append("apiKeys: already present")
    else:
        new = "apiKeys: { tavily: '', brave: '', serpapi: '', bocha: '' }"
        text = text[:m.start()] + new + text[m.end():]
        notes.append("apiKeys: added bocha")

    return text, notes


def revert_index(text):
    notes = []
    # drop the marked import block
    pattern = re.escape(MARK_START) + r".*?" + re.escape(MARK_END) + r"\s*\n"
    text, n = re.subn(pattern, "", text, flags=re.S)
    if n:
        notes.append("import: removed")

    m = re.search(r"(?m)^export const SEARCH_PROVIDERS = \[(.*?)\];\s*$", text)
    if m and "bochaProvider" in m.group(1):
        members = [x.strip() for x in m.group(1).split(",") if x.strip() and x.strip() != "bochaProvider"]
        new_line = "export const SEARCH_PROVIDERS = [" + ", ".join(members) + "];"
        text = text[:m.start()] + new_line + text[m.end():]
        notes.append("registry: removed")

    m = re.search(r"apiKeys:\s*\{[^}]*bocha[^}]*\}", text)
    if m:
        text = text[:m.start()] + "apiKeys: { tavily: '', brave: '', serpapi: '' }" + text[m.end():]
        notes.append("apiKeys: removed")

    return text, notes


def main():
    argv = sys.argv[1:]
    dry = "--dry-run" in argv
    do_revert = "--revert" in argv
    keys = None
    if "--keys" in argv:
        i = argv.index("--keys")
        raw = argv[i + 1] if i + 1 < len(argv) else ""
        keys = [k.strip() for k in raw.split(",") if k.strip()]
        if len(keys) != len(INSTANCES):
            raise SystemExit("--keys needs exactly %d comma-separated keys" % len(INSTANCES))

    stamp = time.strftime("%Y%m%d-%H%M%S")

    for idx, (root, name) in enumerate(INSTANCES):
        root = pathlib.Path(root)
        provider = root / "src" / "search" / "providers" / "bocha.js"
        index = root / "src" / "search" / "index.js"

        print("=" * 62)
        print("%s   %s" % (name, root))
        if not index.exists():
            print("  [SKIP] no %s" % index)
            continue

        text = index.read_text(encoding="utf-8")

        if do_revert:
            new_text, notes = revert_index(text)
            for n in notes:
                print("  [revert] " + n)
            if not dry and new_text != text:
                shutil.copy2(index, index.with_name(index.name + ".bak-" + stamp))
                index.write_text(new_text, encoding="utf-8")
            if not dry and provider.exists():
                provider.unlink()
                print("  [revert] deleted providers/bocha.js")
            continue

        new_text, notes = patch_index(text)
        for n in notes:
            print("  [patch]  " + n)

        if not dry:
            if new_text != text:
                shutil.copy2(index, index.with_name(index.name + ".bak-" + stamp))
                index.write_text(new_text, encoding="utf-8")
                print("  [write]  index.js (backup: index.js.bak-%s)" % stamp)
            provider.write_text(PROVIDER_JS, encoding="utf-8")
            print("  [write]  providers/bocha.js (%d bytes)" % len(PROVIDER_JS.encode("utf-8")))

        if keys is not None:
            cfg_path = root / "config.json"
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
            ws = cfg.setdefault("ai", {}).setdefault("tools", {}).setdefault("webSearch", {})
            ws.setdefault("apiKeys", {})["bocha"] = keys[idx]
            ws["provider"] = "bocha"
            ws["enabled"] = True
            shown = "%s...%s" % (keys[idx][:6], keys[idx][-4:])
            if not dry:
                shutil.copy2(cfg_path, cfg_path.with_name(cfg_path.name + ".bak-" + stamp))
                cfg_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print("  [config] provider=bocha enabled=true key=%s" % shown)

    if dry:
        print("\nDRY RUN - nothing written.")
    else:
        print("\nDone. Restart MimirLink, then verify with:")
        print("  node verify_bocha.mjs")


if __name__ == "__main__":
    main()
