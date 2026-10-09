"""Make MimirLink choose SearXNG engines by the language of the query.

Why this exists
---------------
bing is simultaneously the best English engine and the worst Chinese one that
was measured: for "成都理工大学 2026 年招生简章" it returned Japanese lacquerware
("鉴赏丨日本大漆金莳绘漆器", "漆器推荐书目 - 故宫博物院") and a gas-water-heater
brand. Lowering its SearXNG weight keeps it out of the top five, but that also
throws away the engine's real strength, because weight is a single static value
and the bot serves both languages from one config.

The fix is to stop treating the engine set as static: send the Chinese engines
for a Chinese query and bing for a Latin one.

Two things had to be established first, and both were measured rather than
assumed:

  1. SearXNG IGNORES an `engines=` URL parameter. Seven different values of it
     (one engine, another engine, two, five, and the full candidate list) all
     returned byte-identical result sets. MimirLink's existing `searxngEngines`
     config field builds exactly that parameter, so it has never done anything.

  2. Engine selection really happens in searx/query.py's BangParser, which
     reads '!token' parts out of the query TEXT. It accepts engine names as
     well as shortcuts, restores '-' and '_' to spaces (so '!sogou_wechat'
     selects the engine named "sogou wechat"), and sets specific=true, which is
     what makes the selection exclusive. Verified:
         !bing .......                   -> 10 results, all bing
         !360search !sogou_wechat ....   -> 15 results, those two only
         !bing !yandex !360search ....   -> 25 results, those three only

So this patch prepends '!engine' tokens to the outgoing query.

Why the engine lists look the way they do -- measured, not assumed
------------------------------------------------------------------
The obvious suspect for bing's poor English results was our own locale: the
config sends language=zh-cn for every query, SearXNG's bing engine turns that
into setlang=zh, and bing then serves Chinese pages. That was tested and is
WRONG: bing returns byte-identical results for language=zh-cn, en, en-US, all
and ja-JP. Its results are decided by the network's IP geolocation, not by the
parameter, so the locale cannot be used to fix bing.

Mean lexical relevance, six Latin queries:
    yandex      0.918      360search   0.804      bing   0.302
Mean lexical relevance, four Chinese queries:
    360search   0.853      sogou wechat 0.862     yandex 0.487
So yandex leads the Latin list, and yandex is kept OUT of the Chinese list.

A lexical quality gate was also tried and REJECTED -- see the module docstring
of ../mimir-tools/relevance_scorer.mjs. On four queries it looked like a clean
threshold existed; on fourteen it evaporated, and the worst case had a GOOD
result set scoring 0.25 while a BAD one scored 0.75, i.e. the gate would have
thrown away the right answer and kept the wrong one. Do not re-add one without
re-measuring on a large query set.

Config fields written to config.json (both instances):
   searxngEnginesCjk    engines for queries containing CJK characters
   searxngEnginesLatin  engines for everything else
   searxngEngines       still honoured, but only as a fallback when neither
                        list matches; it now actually works

Every edit is idempotent and wrapped in markers, following patch_bocha.py, so
re-running restores whatever a MimirLink upgrade overwrote.

Usage:
    python patch_lang_engines.py --dry-run
    python patch_lang_engines.py
    python patch_lang_engines.py --revert
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

MARK_START = "// >>> lang-engines patch (managed by patch_lang_engines.py) >>>"
MARK_END = "// <<< lang-engines patch <<<"

# --- engine lists -----------------------------------------------------------
# Chinese: the four that actually answer in Chinese. bing is excluded because
# its Chinese results are noise, and yandex because its Chinese results were
# consistently 串味 (for a 成都理工大学 query it returned Nanjing and Dalian
# universities; measured mean relevance 0.487 against 360search's 0.853 and
# sogou wechat's 0.862). sogou / quark / baidu are listed even though they are
# often suspended or crashed, because a bang naming a dead engine costs nothing
# -- SearXNG simply reports it suspended and skips it.
CJK_ENGINES = "360search,sogou,sogou wechat,quark,baidu"

# Latin: yandex leads, and that is a MEASURED decision, not a preference.
# Mean lexical relevance over six Latin queries:
#     yandex      0.918   (0% of titles Chinese)
#     360search   0.804   (91% of titles Chinese, but on topic)
#     bing        0.302   (78% of titles Chinese)
# bing is three times worse than yandex for English work, and its results are
# often not organic results for the query at all -- asked "latest stable node.js
# version" it returned "latest是什么意思_..._爱词霸", asked "kubernetes ingress vs
# gateway api" it returned the bare word "Kubernetes", asked "clash royale best
# deck 2026" it returned the network proxy tool Clash. See notes below for why
# the obvious culprit (our own zh-cn locale forcing Bing's setlang) was ruled
# out.
#
# 360search is kept because it is the one engine that works in both scripts.
# bing is kept last purely as redundancy, at weight 0.3 against yandex's 2.0,
# so that losing yandex does not leave Latin queries with a single source.
LATIN_ENGINES = "yandex,360search,bing"

# ---------------------------------------------------------------------------
# src/search/providers/searxng.js
# ---------------------------------------------------------------------------
SEARXNG_OLD = """        const engines = String(ctx.searxngEngines || '').trim();
        if (engines) {
            params.set('engines', engines);
        }
"""

SEARXNG_NEW = """        // >>> lang-engines patch (managed by patch_lang_engines.py) >>>
        // Do NOT set an 'engines' URL parameter here. SearXNG ignores it:
        // seven different values of it were tried against this instance and
        // every one returned a byte-identical result set. Engine selection is
        // read out of the query text by searx/query.py's BangParser, which
        // also restores '-' / '_' to spaces, so '!sogou_wechat' selects the
        // engine named "sogou wechat". Setting a bang also sets specific=true,
        // which is what makes the choice exclusive rather than additive.
        const engineList = pickEngines(query, ctx);
        if (engineList) {
            params.set('q', applyEngineBangs(engineList, query));
        }
        // <<< lang-engines patch <<<
"""

SEARXNG_HELPERS = """

// >>> lang-engines patch (managed by patch_lang_engines.py) >>>
// CJK ideographs, kana and halfwidth katakana. A query containing any of these
// is treated as Chinese/Japanese and routed to the Chinese engine list; the
// presence of Latin letters does not matter, because "成都理工大学 2026 年招生
// 简章" is a Chinese query that happens to contain digits.
const CJK_RE = /[\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff66-\\uff9f]/;

/**
 * Turn a comma-separated engine list into '!bang' tokens and put them in front
 * of the query. Bangs lead so that what the engines actually search for is
 * unchanged.
 */
function applyEngineBangs(engineList, query) {
    const bangs = String(engineList)
        .split(',')
        .map((name) => name.trim().replace(/\\s+/g, '_'))
        .filter(Boolean)
        .map((name) => `!${name}`)
        .join(' ');
    return bangs ? `${bangs} ${query}` : query;
}

/**
 * Pick the engine list from the query's script, falling back to the original
 * searxngEngines value. Returns '' when nothing is configured, which leaves
 * upstream behaviour untouched.
 */
function pickEngines(query, ctx) {
    const cjk = String(ctx.searxngEnginesCjk || '').trim();
    const latin = String(ctx.searxngEnginesLatin || '').trim();
    const fallback = String(ctx.searxngEngines || '').trim();
    if (CJK_RE.test(String(query || ''))) {
        return cjk || fallback;
    }
    return latin || fallback;
}
// <<< lang-engines patch <<<
"""

# ---------------------------------------------------------------------------
# src/search/index.js
# ---------------------------------------------------------------------------
INDEX_DEFAULTS_ANCHOR = "    searxngEngines: '',\n"
INDEX_DEFAULTS_ADD = """    searxngEngines: '',
    // >>> lang-engines patch (managed by patch_lang_engines.py) >>>
    // Engines for Chinese queries and for everything else. Actual engine names
    // from SearXNG's own settings.yml -- see patch_lang_engines.py for the
    // measurements behind the two lists.
    searxngEnginesCjk: '',
    searxngEnginesLatin: '',
    // <<< lang-engines patch <<<
"""

INDEX_NORM_ANCHOR = "        searxngEngines: normalizeString(source.searxngEngines),\n"
INDEX_NORM_ADD = """        searxngEngines: normalizeString(source.searxngEngines),
        // >>> lang-engines patch (managed by patch_lang_engines.py) >>>
        searxngEnginesCjk: normalizeString(source.searxngEnginesCjk),
        searxngEnginesLatin: normalizeString(source.searxngEnginesLatin),
        // <<< lang-engines patch <<<
"""

INDEX_CTX_ANCHOR = "                searxngEngines: searchConfig.searxngEngines,\n"
INDEX_CTX_ADD = """                searxngEngines: searchConfig.searxngEngines,
                // >>> lang-engines patch (managed by patch_lang_engines.py) >>>
                searxngEnginesCjk: searchConfig.searxngEnginesCjk,
                searxngEnginesLatin: searchConfig.searxngEnginesLatin,
                // <<< lang-engines patch <<<
"""


def _insert_after(text, anchor, addition, label, notes):
    """Insert `addition` right after `anchor`, once. Idempotent."""
    if addition.strip() in text:
        notes.append("%s: already present" % label)
        return text
    if anchor not in text:
        raise SystemExit("  [ERROR] anchor not found for %s:\n    %r" % (label, anchor[:80]))
    notes.append("%s: added" % label)
    return text.replace(anchor, anchor + addition, 1)


def patch_index(text):
    notes = []
    text = _insert_after(text, INDEX_DEFAULTS_ANCHOR, INDEX_DEFAULTS_ADD,
                         "WEB_SEARCH_DEFAULTS", notes)
    text = _insert_after(text, INDEX_NORM_ANCHOR, INDEX_NORM_ADD,
                         "normalizeWebSearchConfig", notes)
    text = _insert_after(text, INDEX_CTX_ANCHOR, INDEX_CTX_ADD,
                         "provider.search ctx", notes)
    return text, notes


def revert_index(text):
    pattern = re.escape(MARK_START) + r".*?" + re.escape(MARK_END) + r"\n"
    text, n = re.subn(pattern, "", text, flags=re.S)
    return text, (["removed %d marked block(s)" % n] if n else ["nothing to remove"])


def patch_searxng(text):
    notes = []
    if "applyEngineBangs" in text:
        notes.append("searxng.js: already patched")
    else:
        if SEARXNG_OLD not in text:
            raise SystemExit("  [ERROR] cannot find the engines= block in providers/searxng.js")
        text = text.replace(SEARXNG_OLD, SEARXNG_NEW, 1)
        text = text.rstrip("\n") + "\n" + SEARXNG_HELPERS
        notes.append("searxng.js: bang selection wired up")
    return text, notes


def revert_searxng(text):
    pattern = re.escape(MARK_START) + r".*?" + re.escape(MARK_END) + r"\n"
    text, n = re.subn(pattern, "", text, flags=re.S)
    # restore the original parameter-based block
    stub = """        const engines = String(ctx.searxngEngines || '').trim();
        if (engines) {
            params.set('engines', engines);
        }
"""
    if "applyEngineBangs" not in text and stub not in text:
        # the marked block left a gap where the original code was
        text = re.sub(r"(?m)^(?=\s*let response;)", stub, text, count=1)
    return text, (["removed %d marked block(s)" % n] if n else ["nothing to remove"])


def main():
    argv = sys.argv[1:]
    dry = "--dry-run" in argv
    do_revert = "--revert" in argv
    stamp = time.strftime("%Y%m%d-%H%M%S")

    for root, name in INSTANCES:
        root = pathlib.Path(root)
        searxng = root / "src" / "search" / "providers" / "searxng.js"
        index = root / "src" / "search" / "index.js"
        cfg_path = root / "config.json"

        print("=" * 66)
        print("%s   %s" % (name, root))
        if not searxng.exists() or not index.exists():
            print("  [SKIP] %s has no src/search -- not a MimirLink copy?" % root)
            continue

        if do_revert:
            for path, fn in ((searxng, revert_searxng), (index, revert_index)):
                old = path.read_text(encoding="utf-8")
                new, notes = fn(old)
                for n in notes:
                    print("  [revert] " + n)
                if not dry and new != old:
                    shutil.copy2(path, path.with_name(path.name + ".bak-" + stamp))
                    path.write_text(new, encoding="utf-8")
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
            ws = cfg.get("ai", {}).get("tools", {}).get("webSearch", {})
            for k in ("searxngEnginesCjk", "searxngEnginesLatin"):
                ws.pop(k, None)
            if not dry:
                shutil.copy2(cfg_path, cfg_path.with_name(cfg_path.name + ".bak-" + stamp))
                cfg_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n",
                                    encoding="utf-8")
            print("  [revert] config.json: removed the two engine lists")
            continue

        # --- code ----------------------------------------------------------
        old = searxng.read_text(encoding="utf-8")
        new, notes = patch_searxng(old)
        for n in notes:
            print("  [patch]  " + n)
        if not dry and new != old:
            shutil.copy2(searxng, searxng.with_name(searxng.name + ".bak-" + stamp))
            searxng.write_text(new, encoding="utf-8")

        old = index.read_text(encoding="utf-8")
        new, notes = patch_index(old)
        for n in notes:
            print("  [patch]  " + n)
        if not dry and new != old:
            shutil.copy2(index, index.with_name(index.name + ".bak-" + stamp))
            index.write_text(new, encoding="utf-8")

        # --- config --------------------------------------------------------
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        ws = cfg.setdefault("ai", {}).setdefault("tools", {}).setdefault("webSearch", {})
        ws["searxngEnginesCjk"] = CJK_ENGINES
        ws["searxngEnginesLatin"] = LATIN_ENGINES
        if not dry:
            shutil.copy2(cfg_path, cfg_path.with_name(cfg_path.name + ".bak-" + stamp))
            cfg_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n",
                                encoding="utf-8")
        print("  [config] searxngEnginesCjk   = %s" % CJK_ENGINES)
        print("  [config] searxngEnginesLatin = %s" % LATIN_ENGINES)

    if dry:
        print("\nDRY RUN - nothing written.")
    else:
        print("\nDone. MimirLink must be RESTARTED for the code change to load.")
        print("Then verify with:  node <workbuddy>/mimir-tools/verify_bot_search.mjs")


if __name__ == "__main__":
    main()
