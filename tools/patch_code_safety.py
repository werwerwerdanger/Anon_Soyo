# -*- coding: utf-8 -*-
"""Stop the reply pipeline from destroying code.

TWO DEFECTS (found 2026-10-09 when the bot answered a competitive-programming question
in a group and the code came out mangled; user: "返回代码的时候返回的问题好大")

1) variable-bridge.js:86 -- blanket HTML-tag strip eats C++ templates.
       result = result.replace(/<[^>]+>/g, '');
   The log shows it exactly:
       replyPreview     : ```cpp\n#include <bits/stdc++.h>\nusing namespace std;...
       processedReply   : ```cpp\n#include \nusing namespace std;...
   Everything that looks like `<...>` is a casualty: <bits/stdc++.h>, vector<int>,
   map<int,int>, pair<int,int> …  For a bot in an algorithms group this is fatal.

   Fix: hoist fenced blocks and inline code spans out of the way before the tag strip
   and put them back afterwards, so only prose is sanitised.

2) reply-dispatcher.js splitReplyIntoSegments() splits on 。 and on newlines, with no
   awareness of code fences -- so a 30-line program ships as 30 separate QQ messages
   (and with minSendIntervalMs=5000 that would take 2.5 minutes).

   Fix: a fenced block is one atomic segment; only text outside fences is split.

Usage:
    python patch_code_safety.py [--dry-run] [--revert]
"""
import argparse
import pathlib
import shutil
import subprocess
import time

STAMP = time.strftime('%Y%m%d-%H%M%S')
MARKER = 'code-safety patch'
INSTANCES = ['MimirLink', 'MimirLink-soyo']
ROOTS = [pathlib.Path(r'C:\Users\20633') / n for n in INSTANCES]

VB_ANCHOR = '''    // 4. 去掉所有残留 HTML 标签
    result = result.replace(/<[^>]+>/g, '');'''
VB_NEW = '''    // 4. 去掉所有残留 HTML 标签
    // >>> code-safety patch (managed by patch_code_safety.py) >>>
    // 一刀切删掉「像标签的东西」会连 C++ 模板一起删：<bits/stdc++.h>、vector<int>、
    // map<int,int> 全没了（2026-10-09 群里的代码题就是这样糊掉的）。
    // 先把围栏代码块和行内代码挪走，只清洗正文，再放回来。
    const codeSpans = [];
    result = result.replace(/```[\\s\\S]*?```|`[^`\\n]*`/g, (match) => {
        codeSpans.push(match);
        return `\\u0000CODE${codeSpans.length - 1}\\u0000`;
    });
    result = result.replace(/<[^>]+>/g, '');
    result = result.replace(/\\u0000CODE(\\d+)\\u0000/g, (_, i) => codeSpans[Number(i)] || '');
    // <<< code-safety patch <<<'''

RD_ANCHOR = '''    const splitReplyIntoSegments = (text) => {
        const source = String(text === undefined || text === null ? '' : text);
        const chunks = splitOnPeriod ? source.split('。') : [source];
        return chunks
            .flatMap((chunk) => chunk.split(/\\r?\\n+/))
            .map((segment) => segment.trim())
            .filter(Boolean);
    };'''
RD_NEW = '''    const splitReplyIntoSegments = (text) => {
        // >>> code-safety patch (managed by patch_code_safety.py) >>>
        // 围栏代码块整体算一段：按行拆会把一个程序拆成几十条 QQ 消息
        //（配合 minSendIntervalMs=5000 更是灾难）。只有围栏外的正文才按句号/换行切。
        const source = String(text === undefined || text === null ? '' : text);
        const splitPlain = (part) => {
            const chunks = splitOnPeriod ? part.split('。') : [part];
            return chunks.flatMap((chunk) => chunk.split(/\\r?\\n+/));
        };
        const segments = [];
        const fence = /```[\\s\\S]*?```/g;
        let cursor = 0;
        let match;
        while ((match = fence.exec(source)) !== null) {
            segments.push(...splitPlain(source.slice(cursor, match.index)));
            segments.push(match[0]);
            cursor = match.index + match[0].length;
        }
        segments.push(...splitPlain(source.slice(cursor)));
        return segments
            .map((segment) => segment.trim())
            .filter(Boolean);
        // <<< code-safety patch <<<
    };'''

EDITS = {
    'src/variable-bridge.js': [(VB_ANCHOR, VB_NEW)],
    'src/reply-dispatcher.js': [(RD_ANCHOR, RD_NEW)],
}


def node_check(path):
    node = r'C:\Users\20633\.workbuddy\binaries\node\versions\22.22.2-6\node.exe'
    if not pathlib.Path(node).exists():
        node = 'node'
    return subprocess.run([node, '--check', str(path)], capture_output=True, text=True)


def revert():
    n = 0
    for root in ROOTS:
        for b in sorted(root.glob('src/*.bak-*code*')):
            shutil.copy2(b, b.with_name(b.name.split('.bak-')[0]))
            print('restored %s' % b.with_name(b.name.split('.bak-')[0]))
            n += 1
    print('RESTART both instances to apply.' if n else 'no code-safety backups found')
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--revert', action='store_true')
    args = ap.parse_args()
    if args.revert:
        return revert()

    print('=' * 72)
    print('patch code safety   dry-run=%s' % args.dry_run)
    print('=' * 72)
    failures = 0
    for root in ROOTS:
        print('')
        print('--- %s ---' % root.name)
        for rel, edits in EDITS.items():
            path = root / rel
            text = path.read_text(encoding='utf-8')
            if MARKER in text:
                print('  [SKIP] %s already patched' % rel)
                continue
            broken = False
            for anchor, _ in edits:
                n = text.count(anchor)
                if n != 1:
                    print('  [FAIL] %s: anchor appears %d times (want 1): %r'
                          % (rel, n, anchor.splitlines()[0][:60]))
                    failures += 1
                    broken = True
                    break
            if broken:
                continue
            new_text = text
            for anchor, replacement in edits:
                new_text = new_text.replace(anchor, replacement, 1)
            if args.dry_run:
                print('  [dry-run] %s: %d edits (%d -> %d bytes)'
                      % (rel, len(edits), len(text), len(new_text)))
                continue
            backup = path.with_name('%s.bak-%s-code' % (path.name, STAMP))
            shutil.copy2(path, backup)
            path.write_text(new_text, encoding='utf-8', newline='\n')
            check = node_check(path)
            if check.returncode != 0:
                print('  [FAIL] %s: node --check failed, restoring' % rel)
                print(check.stderr.strip()[:400])
                shutil.copy2(backup, path)
                failures += 1
                continue
            print('  [OK] %s: %d edits, %d -> %d bytes, node --check passed'
                  % (rel, len(edits), len(text), len(new_text)))

    print('')
    if failures:
        print('%d problem(s)' % failures)
        return 1
    if not args.dry_run:
        print('RESTART both MimirLink instances: these are code changes.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
