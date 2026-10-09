"""Make the bot search the web on its own initiative, not only when told to.

WHY THIS FILE AND NOT config.json
  MimirLink runs a two-phase prompt pipeline. The phase that decides whether to
  call a tool builds its message list in buildToolPhaseMessages(), which does:

      if (!message || message.role === 'system') continue;

  i.e. it DROPS every system message. Presets, character cards and world books
  therefore never reach the decision phase - putting "search proactively" into
  preset.prompts is silently ignored. The ONLY text that reaches that phase is
  buildWebToolHint() in this file, so the behaviour has to change here.

  This deliberately does NOT touch any character card.

The edit is idempotent: it is wrapped in marker comments, so re-running replaces
nothing (it detects the patch and skips). --revert restores the original block.

Usage:
    python patch_web_hint.py --dry-run
    python patch_web_hint.py
    python patch_web_hint.py --revert
"""
import pathlib
import shutil
import sys
import time

TARGETS = [
    r"C:\Users\20633\MimirLink\src\tools.js",
    r"C:\Users\20633\MimirLink-soyo\src\tools.js",
]

MARK_START = "    // >>> proactive-search patch"
MARK_END = "    // <<< proactive-search patch <<<"

ORIGINAL = """    const lines = [
        '【功能：联网检索】',
        `可用组件：${available.join('、')}。`
    ];"""

PATCHED = """    // >>> proactive-search patch (managed by patch_web_hint.py) >>>
    const lines = [
        '【功能：联网检索】',
        `可用组件：${available.join('、')}。`,
        '【主动检索要求（重要）】',
        '- 默认先查证再回答：「帮我搜一下 / 查一下 / 查证一下」只是最低要求，不要等用户开口才动手。',
        '- 出现下列任一情形，直接调用 web_search，不需要用户提出：',
        '  · 答案具有时效性：新闻、价格、股价、政策、赛事、排名、天气、汇率、版本号、更新日志、产品发布、人物近况；',
        '  · 涉及你无法确证的具体事实：精确数字、日期、职务、作品或剧集信息、事件经过、官方链接与出处；',
        '  · 你对答案没有把握，或该信息可能在过去几个月内发生过变化。',
        '- 自检口径：只要「可能已过期」或「我不太确定」，就是必须检索的信号；宁可多查一次，也不要凭印象作答。',
        '- 不必检索的情形：纯闲聊与情绪回应、角色扮演台词与互动、对前文的追问、稳定不变的常识、用户明确表示不需要联网。',
        '- 检索是内部动作：用角色一贯的语气把结论自然说出来，不要提「搜索 / 联网 / 查资料」，不要罗列链接列表，除非用户就是要来源。'
    ];
    // <<< proactive-search patch <<<"""

DRY = "--dry-run" in sys.argv
REVERT = "--revert" in sys.argv
stamp = time.strftime("%Y%m%d-%H%M%S")


def process(path):
    p = pathlib.Path(path)
    if not p.is_file():
        print(f"  !! missing: {p}")
        return
    src = p.read_text(encoding="utf-8")

    if REVERT:
        if MARK_START not in src:
            print(f"  {p.parent.parent.name:14} already original (no patch marker)")
            return
        start = src.index(MARK_START)
        end = src.index(MARK_END) + len(MARK_END)
        new = src[:start] + ORIGINAL + src[end:]
        action = "restored original hint"
    else:
        if MARK_START in src:
            print(f"  {p.parent.parent.name:14} already patched - skipped (idempotent)")
            return
        if ORIGINAL not in src:
            print(f"  {p.parent.parent.name:14} !! anchor block not found - file changed upstream?")
            return
        new = src.replace(ORIGINAL, PATCHED, 1)
        action = "patched hint"

    delta = len(new) - len(src)
    print(f"  {p.parent.parent.name:14} {action}  ({len(src)} -> {len(new)} bytes, {delta:+d})")

    if DRY:
        print("        [dry-run] not written")
        return

    bak = p.with_name(p.name + f".bak-{stamp}")
    shutil.copy2(p, bak)
    p.write_text(new, encoding="utf-8")
    print(f"        backup: {bak.name}")


print("=" * 66)
print(f"patch buildWebToolHint   revert={REVERT}  dry-run={DRY}  stamp={stamp}")
print("=" * 66)
for t in TARGETS:
    process(t)
print("=" * 66)
if not DRY:
    print("Verify syntax with:  node --check <path-to-tools.js>")
