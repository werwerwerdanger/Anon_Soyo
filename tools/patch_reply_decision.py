# -*- coding: utf-8 -*-
"""Wire the reply-decision layer into the batch pipeline.

Design: user chose B (model judges) and "决策层复用 dpsk" (reuse deepseek-flash, so no
new provider config).

Inserted right before image handling, i.e. BEFORE the two expensive calls, so a NO
verdict actually saves them:

    [routing] -> [reply decision] -> [image] -> [tool phase] -> [reply phase]

The whole block is wrapped in try/catch on purpose: if any name in scope differs from
what we assumed, we must degrade to today's behaviour (always reply), never to silence.
reply-decision.js itself also fails open.

Config (chat.replyDecision), defaults written but DISABLED so nothing changes until it
is switched on deliberately:

    "replyDecision": { "enabled": false, "maxTokens": 4, "minChars": 2 }

Usage:
    python patch_reply_decision.py [--dry-run] [--revert]
"""
import argparse
import json
import pathlib
import shutil
import subprocess
import time

STAMP = time.strftime('%Y%m%d-%H%M%S')
MARKER = 'reply-decision patch'
INSTANCES = ['MimirLink', 'MimirLink-soyo']
ROOTS = [pathlib.Path(r'C:\Users\20633') / n for n in INSTANCES]

IMPORT_ANCHOR = "import { ImageInputError, normalizeImageCaptionConfig, getOneBotMessageSegments, prepareImageInput, attachImageParts } from './image-input.js';"
IMPORT_NEW = IMPORT_ANCHOR + "\n// >>> reply-decision patch <<<\nimport { decideReply } from './reply-decision.js';\n// <<< reply-decision patch <<<"

CALL_ANCHOR = '''            let imageInput = { mode: 'none', imageCount: 0, imageParts: [], captionText: '' };
            if (shouldRunLlm) {'''
CALL_NEW = '''            // >>> reply-decision patch <<<
            // 先决定"要不要回"，再进入两次大调用。整段包 try/catch：任何意外都退化成
            // 「照常回复」，绝不能让决策层成为"她突然哑了"的原因。
            if (shouldRunLlm && config.chat?.replyDecision?.enabled === true) {
                try {
                    const decision = await decideReply({
                        config,
                        aiClient,
                        logger,
                        sessionId,
                        recentMessages: (batch.items || []).map((item) => ({
                            role: 'user',
                            content: item.structuredText || item.plainText || ''
                        })),
                        plainText: processedInput,
                        speaker: primary?.structuredText ? '' : ''
                    });
                    if (decision.skip) {
                        logger.info('[决策] 本轮不回复', {
                            sessionId,
                            reason: decision.reason,
                            raw: decision.raw
                        });
                        return;
                    }
                    logger.info('[决策] 本轮回复', { sessionId, reason: decision.reason });
                } catch (error) {
                    logger.warn(`[决策] 判定异常，按"回"处理: ${error?.message || error}`);
                }
            }
            // <<< reply-decision patch <<<

            let imageInput = { mode: 'none', imageCount: 0, imageParts: [], captionText: '' };
            if (shouldRunLlm) {'''

CFG = {'enabled': False, 'maxTokens': 4, 'minChars': 2}


def node_check(path):
    node = r'C:\Users\20633\.workbuddy\binaries\node\versions\22.22.2-6\node.exe'
    if not pathlib.Path(node).exists():
        node = 'node'
    return subprocess.run([node, '--check', str(path)], capture_output=True, text=True)


def patch_config(root, dry_run):
    path = root / 'config.json'
    cfg = json.loads(path.read_text(encoding='utf-8'))
    if cfg['chat'].get('replyDecision') is not None:
        print('  [SKIP] config.json already has replyDecision')
        return 0
    cfg['chat']['replyDecision'] = dict(CFG)
    if dry_run:
        print('  [dry-run] config.json: +replyDecision (enabled=false)')
        return 0
    shutil.copy2(path, path.with_name('config.json.bak-%s-replydec' % STAMP))
    path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding='utf-8')
    assert json.loads(path.read_text(encoding='utf-8'))['chat']['replyDecision'] == CFG
    print('  [OK] config.json: +replyDecision (enabled=false -- 先写好，默认关)')
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--revert', action='store_true')
    args = ap.parse_args()
    if args.revert:
        n = 0
        for root in ROOTS:
            for b in sorted(root.glob('src/index.js.bak-*replydec*')):
                shutil.copy2(b, b.with_name('index.js'))
                n += 1
            for b in sorted(root.glob('config.json.bak-*replydec*')):
                shutil.copy2(b, root / 'config.json')
                n += 1
        print('reverted %d file(s)' % n)
        return 0

    print('=' * 72)
    print('patch reply decision   dry-run=%s' % args.dry_run)
    print('=' * 72)
    failures = 0
    for root in ROOTS:
        print('')
        print('--- %s ---' % root.name)
        # module must exist before the import is wired in
        module = root / 'src' / 'reply-decision.js'
        if not module.exists():
            print('  [FAIL] src/reply-decision.js missing')
            failures += 1
            continue
        check_mod = node_check(module)
        print('  [%s] reply-decision.js syntax' % ('OK' if check_mod.returncode == 0 else 'FAIL'))
        if check_mod.returncode != 0:
            print(check_mod.stderr.strip()[:300])
            failures += 1
            continue

        failures += patch_config(root, args.dry_run)

        path = root / 'src' / 'index.js'
        text = path.read_text(encoding='utf-8')
        if MARKER in text:
            print('  [SKIP] src/index.js already patched')
            continue
        ok = True
        for anchor in (IMPORT_ANCHOR, CALL_ANCHOR):
            if text.count(anchor) != 1:
                print('  [FAIL] anchor appears %d times (want 1): %r'
                      % (text.count(anchor), anchor.strip().splitlines()[0][:60]))
                failures += 1
                ok = False
                break
        if not ok:
            continue
        new_text = text.replace(IMPORT_ANCHOR, IMPORT_NEW, 1).replace(CALL_ANCHOR, CALL_NEW, 1)
        if args.dry_run:
            print('  [dry-run] src/index.js: 2 edits (%d -> %d bytes)' % (len(text), len(new_text)))
            continue
        backup = path.with_name('index.js.bak-%s-replydec' % STAMP)
        shutil.copy2(path, backup)
        path.write_text(new_text, encoding='utf-8', newline='\n')
        check = node_check(path)
        if check.returncode != 0:
            print('  [FAIL] node --check failed, restoring')
            print(check.stderr.strip()[:400])
            shutil.copy2(backup, path)
            failures += 1
            continue
        print('  [OK] src/index.js: 2 edits, %d -> %d bytes, node --check passed'
              % (len(text), len(new_text)))

    print('')
    if failures:
        print('%d problem(s)' % failures)
        return 1
    if not args.dry_run:
        print('NOTE: replyDecision.enabled=false for now -- switch it on after a restart check.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
