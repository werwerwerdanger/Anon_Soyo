"""Stop the bot from passing off bad search results as fact.

THE BUG
-------
MimirLink's two-phase pipeline hands tool results to the answer phase through
buildToolPhaseResultMessage(), whose header is:

    '这些是刚刚真实执行工具得到的最新结果，回复时以它们为准；不要编造工具没有返回的信息。'

"以它们为准" is unconditional. That is fine when the search worked and the
results are on topic. It is actively harmful when they are not:

  * every provider failed and the tool returned ok:false with no results -- the
    header still tells the model to treat those (empty) results as the
    authority, which reads as "answer anyway";
  * the results came back but are off topic -- the engine work measured bing
    answering "成都理工大学 2026 年招生简章" with Japanese lacquerware, and
    "latest stable node.js version" with a dictionary entry for the word
    "latest". "以它们为准" then instructs the model to build a reply on top of
    exactly that.

WHAT THIS PATCH DOES
--------------------
Splits the header by tool status and adds a relevance self-check:

  * all calls failed -> the model is told outright that nothing usable came
    back, and that it must not invent an answer or pretend the search worked;
  * something succeeded -> the model is told to check relevance itself before
    using the results, and to say it could not find reliable information rather
    than answer from irrelevant material.

WHY THE MODEL AND NOT A CODE-LEVEL FILTER
-----------------------------------------
A deterministic relevance gate was built and measured first; it does not work.
See ../mimir-tools/relevance_scorer.mjs for the data. On four queries a clean
threshold appeared to exist; on fourteen it evaporated, and the worst case had
a GOOD result set scoring 0.25 while a BAD one scored 0.75 -- the gate would
have discarded the right answer and kept the wrong one. The failures that
matter are semantic (every keyword present, no answer contained), and only the
model can see those.

Cost of doing it this way: zero extra requests. This is prompt text on a call
the bot was already making.

IMPLEMENTATION NOTE -- a mistake worth not repeating
----------------------------------------------------
The first version of this patch placed MARK_START *inside* the block being
replaced and appended a copy of the `entries.forEach(...)` loop that already
followed it. Both errors produced a duplicated statement and a hard
SyntaxError in tools.js. The lesson: the marked region must exactly cover the
text being replaced, and nothing that already exists further down the file may
be re-emitted. This script now runs `node --check` itself after writing and
restores the backup if the result does not parse.

The edit is idempotent, following patch_bocha.py.

Usage:
    python patch_result_honesty.py --dry-run
    python patch_result_honesty.py
    python patch_result_honesty.py --revert
"""
import pathlib
import shutil
import subprocess
import sys
import time

TARGETS = [
    r"C:\Users\20633\MimirLink\src\tools.js",
    r"C:\Users\20633\MimirLink-soyo\src\tools.js",
]

NODE = r"C:\Users\20633\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"

MARK_START = "    // >>> result-honesty patch (managed by patch_result_honesty.py) >>>"
MARK_END = "    // <<< result-honesty patch <<<"

# Exactly the text that gets replaced -- nothing more.
ORIGINAL = """    const maxChars = clampInteger(options.maxChars, 200, 50000, 4000);
    const lines = [
        '【本轮工具执行结果】',
        '这些是刚刚真实执行工具得到的最新结果，回复时以它们为准；不要编造工具没有返回的信息。'
    ];
"""

PATCHED = MARK_START + """
    // 原实现无条件写「以它们为准」：检索全挂时它等于在催模型硬答，结果跑题时它
    // 等于在授权模型拿不相关内容编答案。改为按工具状态分支，并加一条相关性自检。
    const maxChars = clampInteger(options.maxChars, 200, 50000, 4000);
    const okEntries = entries.filter((entry) => entry.ok !== false).length;
    const lines = ['【本轮工具执行结果】'];
    if (okEntries === 0) {
        lines.push(
            '本次工具调用全部失败，没有取到任何可用数据。',
            '不要凭记忆编造答案，也不要假装检索成功、不要声称“网上就是这么说的”：'
            + '如实说明这次没能查到、没能取到内容。'
        );
    } else {
        lines.push(
            '这些是刚刚真实执行工具得到的最新结果，回复时优先采用；不要编造工具没有返回的信息。',
            '采用前先自行核对相关性：若这些结果与用户的问题无关、答非所问，或只是关键词'
            + '相同却回答不了问题，就不要使用它们，并如实说明没有查到可靠信息。',
            '宁可说没查到，也不要用不相关的内容硬答，也不要仅凭这些内容推断。'
        );
    }
""" + MARK_END + "\n"


def node_syntax_ok(path: pathlib.Path) -> tuple[bool, str]:
    out = subprocess.run([NODE, "--check", str(path)], capture_output=True, text=True)
    return out.returncode == 0, (out.stderr or out.stdout or '').strip()


def process(path: pathlib.Path, revert: bool, dry: bool, stamp: str) -> None:
    if not path.is_file():
        print(f"  !! missing: {path}")
        return
    src = path.read_text(encoding="utf-8")
    label = path.parent.parent.name

    if revert:
        if MARK_START not in src:
            print(f"  {label:15} already original (no marker)")
            return
        start = src.index(MARK_START)
        end = src.index(MARK_END) + len(MARK_END)
        # also swallow the newline that MARK_END's line ended with
        if src[end:end + 1] == "\n":
            end += 1
        new = src[:start] + ORIGINAL + src[end:]
        action = "restored the original header"
    else:
        if MARK_START in src:
            print(f"  {label:15} already patched - skipped (idempotent)")
            return
        if ORIGINAL not in src:
            print(f"  {label:15} !! anchor not found - upstream changed, inspect manually")
            return
        new = src.replace(ORIGINAL, PATCHED, 1)
        action = "patched the result header"

    print(f"  {label:15} {action}  ({len(src)} -> {len(new)} bytes, "
          f"{len(new) - len(src):+d})")
    if dry:
        print("        [dry-run] not written")
        return

    bak = path.with_name(path.name + f".bak-{stamp}")
    shutil.copy2(path, bak)
    path.write_text(new, encoding="utf-8")

    ok, err = node_syntax_ok(path)
    if ok:
        print(f"        backup: {bak.name}   node --check: OK")
        return
    # never leave a file that does not parse
    shutil.copy2(bak, path)
    print("        !! node --check FAILED - restored the backup, nothing changed")
    for line in err.splitlines()[:4]:
        print(f"           {line}")


DRY = "--dry-run" in sys.argv
REVERT = "--revert" in sys.argv
stamp = time.strftime("%Y%m%d-%H%M%S")

print("=" * 70)
print(f"patch buildToolPhaseResultMessage  revert={REVERT}  dry-run={DRY}")
print("=" * 70)
for target in TARGETS:
    process(pathlib.Path(target), REVERT, DRY, stamp)
print("=" * 70)
if not DRY:
    print("MimirLink must be RESTARTED for the change to load.")
