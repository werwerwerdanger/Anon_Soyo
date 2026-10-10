"""Make the bot sound like it is typing on a phone, not writing an essay.

THREE REQUESTS, ONE FILE
------------------------
All three are about the send path in src/reply-dispatcher.js.

1. No full stop, break the sentence instead.
   "在句号的地方直接拆成两个输出" -- the bot wrote things like
   `月之森二年级，MyGO!!!!! 的贝斯手。你是真的忘了，还是压根没在看？` as ONE bubble.
   A person on QQ would send that as two. So `。` becomes a message boundary,
   and the character itself is dropped.

2. Only quote-reply when the message is long, and only once.
   "消息没有超过5行的时候直接输出内容而不是回复" +
   "如果一段话都是回复一句话的话只回复第一句就可以了"
   -- open quoteReplyEnabled quotes EVERY reply, so even a two-word answer
   arrives wearing a quote box; and once a reply gets split into several
   messages, the old code quoted every one of them. Now:
     * a reply of fewer than 6 lines is sent as a plain message;
     * when a reply does qualify, only the FIRST message carries the quote --
       the rest are sent as ordinary messages (group ones also lose the
       repeated @, which is correct: you @ someone once).
   Group replies still get the @ when the quote is off (mentionPrefix is
   applied in the non-quote branch).

3. Say less.
   "在不影响理解的情况尽量减少回复" -- this one is prompt-side, not code-side:
   it lives in the character card's system_prompt. See
   _soyo_chat_style.json / _anon_chat_style.json.

Note on what is deliberately NOT touched: the voice path
(buildMediaPrefixSegments) still keys off the raw quoteReplyEnabled, so audio
behaviour is unchanged.

Idempotent, plain substitution pairs, same contract as patch_bocha.py.
Runs `node --check` after writing and restores the backup if the file does not parse.

Usage:
    python patch_reply_style.py --dry-run
    python patch_reply_style.py
    python patch_reply_style.py --revert
"""
import pathlib
import shutil
import subprocess
import sys
import time

TARGETS = [
    r"C:\Users\20633\MimirLink\src\reply-dispatcher.js",
    r"C:\Users\20633\MimirLink-soyo\src\reply-dispatcher.js",
]

NODE = r"C:\Users\20633\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"

HELPERS = """    // >>> reply-style patch (managed by patch_reply_style.py) >>>
    // 1) 句号即消息边界：QQ 上没人一句话全用句号收尾，断句交给换行/分段。
    // 2) 引用回复只留给长消息，而且只挂第一条：短回复直接发正文，
    //    拆成多条时后面的也普通发，别每条都顶个引用框。
    const splitOnPeriod = config.chat.splitOnPeriod !== false;
    const rawQuoteMinLines = config.chat.quoteReplyMinLines;
    const quoteReplyMinLines = (rawQuoteMinLines === undefined
        || rawQuoteMinLines === null
        || rawQuoteMinLines === '')
        ? 6
        : (Number.isFinite(Number(rawQuoteMinLines)) ? Number(rawQuoteMinLines) : 6);
    const replyLineCount = String(processedReply || '')
        .split(/\\r?\\n/)
        .filter((line) => line.trim())
        .length;
    // quoteReplyMinLines <= 0 表示「永远引用」，即本补丁之前的旧行为。
    const quoteThisReply = quoteReplyEnabled
        && (quoteReplyMinLines <= 0 || replyLineCount >= quoteReplyMinLines);
    const splitReplyIntoSegments = (text) => {
        const source = String(text === undefined || text === null ? '' : text);
        const chunks = splitOnPeriod ? source.split('。') : [source];
        return chunks
            .flatMap((chunk) => chunk.split(/\\r?\\n+/))
            .map((segment) => segment.trim())
            .filter(Boolean);
    };
    // <<< reply-style patch <<<
"""

EDITS = [
    # A: 在声明块后面插入辅助定义
    (
        "    const quoteReplyEnabled = config.chat.quoteReplyEnabled !== false;\n"
        "    const mentionSenderOnReply = config.chat.mentionSenderOnReply !== false;\n",
        "    const quoteReplyEnabled = config.chat.quoteReplyEnabled !== false;\n"
        + HELPERS
        + "    const mentionSenderOnReply = config.chat.mentionSenderOnReply !== false;\n",
    ),
    # B: 群聊分支改用按长度算出来的判断；且只让第一条挂引用回复
    (
        "            if (quoteReplyEnabled && event.message_id) {\n",
        "            if (quoteThisReply && event.message_id && !hasSentPrimary) {\n",
    ),
    # C: 私聊分支同上
    (
        "        } else if (quoteReplyEnabled && event.message_id) {\n",
        "        } else if (quoteThisReply && event.message_id && !hasSentPrimary) {\n",
    ),
    # D: 分段规则（句号 + 换行）
    (
        "                ? content.split(/\\n\\n+/).filter((segment) => segment.trim())\n",
        "                ? splitReplyIntoSegments(content)\n",
    ),
]


def node_syntax_ok(path: pathlib.Path):
    out = subprocess.run([NODE, "--check", str(path)], capture_output=True, text=True)
    return out.returncode == 0, (out.stderr or out.stdout or '').strip()


def process(path: pathlib.Path, revert: bool, dry: bool, stamp: str) -> None:
    if not path.is_file():
        print(f"  !! missing: {path}")
        return
    src = path.read_text(encoding="utf-8")
    label = path.parent.parent.name
    new = src
    applied, skipped = [], []

    for i, (orig, patched) in enumerate(EDITS):
        tag = chr(ord('A') + i)
        if revert:
            if orig in new:
                skipped.append(tag + "already original")
            elif patched in new:
                new = new.replace(patched, orig, 1)
                applied.append(tag)
            else:
                print(f"  {label:15} !! edit {tag}: neither form present - inspect manually")
                return
        else:
            if patched in new:
                skipped.append(tag + "already patched")
            elif orig in new:
                new = new.replace(orig, patched, 1)
                applied.append(tag)
            else:
                print(f"  {label:15} !! edit {tag}: anchor not found - upstream changed, inspect manually")
                return

    action = ("reverted " if revert else "patched ") + (",".join(applied) if applied else "(nothing to do)")
    if skipped:
        action += "  [skipped: " + "; ".join(skipped) + "]"
    print(f"  {label:15} {action}  ({len(src)} -> {len(new)} bytes, {len(new) - len(src):+d})")

    if dry:
        print("        [dry-run] not written")
        return
    if new == src:
        print("        unchanged")
        return

    bak = path.with_name(path.name + f".bak-{stamp}")
    shutil.copy2(path, bak)
    path.write_text(new, encoding="utf-8")

    ok, err = node_syntax_ok(path)
    if ok:
        print(f"        backup: {bak.name}   node --check: OK")
        return
    shutil.copy2(bak, path)
    print("        !! node --check FAILED - restored the backup, nothing changed")
    for line in err.splitlines()[:4]:
        print(f"           {line}")


DRY = "--dry-run" in sys.argv
REVERT = "--revert" in sys.argv
stamp = time.strftime("%Y%m%d-%H%M%S")

print("=" * 70)
print(f"patch reply style (split on period / quote only when long)  revert={REVERT}  dry-run={DRY}")
print("=" * 70)
for target in TARGETS:
    process(pathlib.Path(target), REVERT, DRY, stamp)
print("=" * 70)
if not DRY:
    print("MimirLink must be RESTARTED for the change to load.")
