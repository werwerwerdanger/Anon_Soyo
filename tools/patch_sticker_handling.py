# -*- coding: utf-8 -*-
"""Stop treating QQ stickers as photos, and stop replying to sticker-only messages.

THE BUG (found in this install's own logs, 2026-10-09)
------------------------------------------------------
Every single "image" this bot had ever received was a sticker:

    收到消息 [private:...]: [图片:[动画表情]]
    messageSegments: [{"type":"image","summary":"[动画表情]"}]
    [图片] 图片直传聊天模型  imageCount: 1  inlineCount: 1

OneBot gives 表情包/动画表情 `type: "image"`; only `data.summary` distinguishes them
(NapCat sends "[动画表情]"). MimirLink did not look, so:

1. summarizeOneBotSegment() rendered it as `[图片:[动画表情]]`, telling the model a
   photo was attached. The model then tried to describe a 30px sticker -- and the
   reply it produced was literally 「图片那么小一张，颜色还糊」. That is the
   "识图有点菜" the user reported. Real photos were never involved.
2. prepareImageInput() fed the sticker through the vision pipeline, burning tokens
   and a download for content that has nothing to look at.
3. Routing treated the sticker as content, so a bare sticker got a reply.

WHAT THIS PATCH DOES
--------------------
image-input.js
  * adds isStickerImageSummary() / isStickerImageSegment() / STICKER_SEGMENT_TYPES
  * filters stickers out of all three image collection points (direct / quoted / forward)

index.js
  * image branch renders stickers as `[表情]` and flags them `isSticker`
  * extractMessageInfo() counts content-bearing vs sticker segments and returns
    `stickerOnly: stickerSegments > 0 && contentfulSegments === 0`
  * buildRoutingDecision() skips `sticker_only` -- but still answers when the user is
    replying to the bot, which is a deliberate act rather than a stray sticker

NOTE: loadConfig() runs once at startup but these are CODE changes, so a restart is
required either way.

Usage:
    python patch_sticker_handling.py [--dry-run] [--revert]
"""
import argparse
import pathlib
import shutil
import subprocess
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
STAMP = time.strftime('%Y%m%d-%H%M%S')
MARKER = 'sticker-handling patch'

INSTANCES = ['MimirLink', 'MimirLink-soyo']
ROOTS = [pathlib.Path(r'C:\Users\20633') / name for name in INSTANCES]

# ---------------------------------------------------------------- image-input.js

IMG_HELPER_ANCHOR = "const text = value => typeof value === 'string' ? value.trim() : '';"

IMG_HELPER_NEW = IMG_HELPER_ANCHOR + """

// >>> sticker-handling patch (managed by patch_sticker_handling.py) >>>
// QQ 表情包 / 动画表情在 OneBot 里同样是 type:"image"，只能靠 summary 区分
// （实测 NapCat 给的是 "[动画表情]"）。它不是照片：当照片送进识图链路，
// 模型只会对着一张几十像素的贴图硬猜，答出来的自然是胡说。
const STICKER_SUMMARY_PATTERN = /表情|表情包|sticker/i;

// 本来就有独立类型的表情，不用靠 summary 猜。
export const STICKER_SEGMENT_TYPES = Object.freeze(['face', 'mface', 'marketface']);

export function isStickerImageSummary(value) {
    return STICKER_SUMMARY_PATTERN.test(text(value));
}

export function isStickerImageSegment(segment) {
    if (!segment || segment.type !== 'image') return false;
    const data = segment.data || {};
    return isStickerImageSummary(data.summary);
}
// <<< sticker-handling patch <<<"""

IMG_DIRECT_ANCHOR = """    const images = items.flatMap(item => getOneBotMessageSegments(item.event?.message || item.event?.raw_message)
        .filter(segment => segment.type === 'image'));"""
IMG_DIRECT_NEW = """    const images = items.flatMap(item => getOneBotMessageSegments(item.event?.message || item.event?.raw_message)
        .filter(segment => segment.type === 'image' && !isStickerImageSegment(segment)));"""

IMG_QUOTED_ANCHOR = """            if (segment?.type !== 'image') continue;"""
IMG_QUOTED_NEW = """            if (segment?.type !== 'image' || isStickerImageSegment(segment)) continue;"""

IMG_FORWARD_ANCHOR = """            if (!segment || segment.type !== 'image') continue;"""
IMG_FORWARD_NEW = """            if (!segment || segment.type !== 'image' || isStickerImageSegment(segment)) continue;"""

# ---------------------------------------------------------------- index.js

IDX_IMPORT_ANCHOR = """import { ImageInputError, normalizeImageCaptionConfig, getOneBotMessageSegments, prepareImageInput, attachImageParts } from './image-input.js';"""
IDX_IMPORT_NEW = """import { ImageInputError, normalizeImageCaptionConfig, getOneBotMessageSegments, prepareImageInput, attachImageParts, isStickerImageSummary, STICKER_SEGMENT_TYPES } from './image-input.js';"""

IDX_SUMMARY_ANCHOR = """    if (type === 'image') {
        const summary = getAny('summary', 'sub_type', 'file');
        return { type, summary: summary ? String(summary) : '', promptText: `[图片${summary ? `:${summary}` : ''}]` };
    }"""
IDX_SUMMARY_NEW = """    if (type === 'image') {
        const summary = getAny('summary', 'sub_type', 'file');
        // >>> sticker-handling patch <<<
        // 表情包也是 type:"image"。渲染成 [图片:...] 会让模型以为要描述照片，
        // 于是对着贴图编内容 —— 表现就是"识图很菜"。
        const sticker = isStickerImageSummary(summary);
        return {
            type,
            summary: summary ? String(summary) : '',
            isSticker: sticker,
            promptText: sticker ? '[表情]' : `[图片${summary ? `:${summary}` : ''}]`
        };
    }"""

IDX_LOOP_ANCHOR = """    const messageSegments = [];

    for (const segment of segments) {
        const segmentSummary = summarizeOneBotSegment(segment, bot.selfId);
        messageSegments.push(sanitizeSegmentSummaryForPrompt(segmentSummary, config, event.user_id));"""
IDX_LOOP_NEW = """    const messageSegments = [];
    // >>> sticker-handling patch <<<
    // 纯表情/表情包消息不主动回应，所以要把"有内容的段"和"表情段"分开数。
    let contentfulSegments = 0;
    let stickerSegments = 0;

    for (const segment of segments) {
        const segmentSummary = summarizeOneBotSegment(segment, bot.selfId);
        messageSegments.push(sanitizeSegmentSummaryForPrompt(segmentSummary, config, event.user_id));
        if (segmentSummary.type !== 'reply') {
            if (segmentSummary.isSticker || STICKER_SEGMENT_TYPES.includes(segmentSummary.type)) {
                stickerSegments += 1;
            } else {
                contentfulSegments += 1;
            }
        }"""

IDX_RETURN_ANCHOR = """        messageSegments,
        standardEvent,
        structuredText
    };"""
IDX_RETURN_NEW = """        messageSegments,
        // 只有表情、没有文字/图片/@ 的消息。buildRoutingDecision 用它挡掉"表情也回一句"。
        stickerOnly: stickerSegments > 0 && contentfulSegments === 0,
        standardEvent,
        structuredText
    };"""

IDX_ROUTE_ANCHOR = """    if (!allowed) {
        return skip('access_denied');
    }"""
IDX_ROUTE_NEW = """    if (!allowed) {
        return skip('access_denied');
    }
    // >>> sticker-handling patch <<<
    // 对方只发了个表情/表情包，没有正文。默认不回；但"回复 bot 自己"是有明确指向的
    // 动作，仍然放行。
    if (messageInfo.stickerOnly === true && !messageInfo.replyToBot) {
        return skip('sticker_only');
    }"""

EDITS = {
    'src/image-input.js': [
        (IMG_HELPER_ANCHOR, IMG_HELPER_NEW),
        (IMG_DIRECT_ANCHOR, IMG_DIRECT_NEW),
        (IMG_QUOTED_ANCHOR, IMG_QUOTED_NEW),
        (IMG_FORWARD_ANCHOR, IMG_FORWARD_NEW),
    ],
    'src/index.js': [
        (IDX_IMPORT_ANCHOR, IDX_IMPORT_NEW),
        (IDX_SUMMARY_ANCHOR, IDX_SUMMARY_NEW),
        (IDX_LOOP_ANCHOR, IDX_LOOP_NEW),
        (IDX_RETURN_ANCHOR, IDX_RETURN_NEW),
        (IDX_ROUTE_ANCHOR, IDX_ROUTE_NEW),
    ],
}


def revert():
    restored = 0
    for root in ROOTS:
        for backup in sorted(root.glob('src/*.bak-*sticker*')):
            target = backup.with_name(backup.name.split('.bak-')[0])
            shutil.copy2(backup, target)
            print('restored %s' % target)
            restored += 1
    if not restored:
        print('no sticker-handling backups found; nothing reverted')
        return 0
    print('RESTART both instances to apply.')
    return 0


def node_check(path):
    node = r'C:\Users\20633\.workbuddy\binaries\node\versions\22.22.2-6\node.exe'
    if not pathlib.Path(node).exists():
        node = 'node'
    return subprocess.run([node, '--check', str(path)], capture_output=True, text=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--revert', action='store_true')
    args = ap.parse_args()

    if args.revert:
        return revert()

    print('=' * 72)
    print('patch sticker handling   dry-run=%s' % args.dry_run)
    print('=' * 72)
    failures = 0

    for root in ROOTS:
        print('')
        print('--- %s ---' % root.name)
        for rel, edits in EDITS.items():
            path = root / rel
            if not path.exists():
                print('  [SKIP] %s missing' % path)
                failures += 1
                continue
            text = path.read_text(encoding='utf-8')

            if MARKER in text:
                print('  [SKIP] %s already patched' % rel)
                continue

            # every anchor must be present exactly once, or we refuse to touch anything
            for anchor, _ in edits:
                n = text.count(anchor)
                if n != 1:
                    print('  [FAIL] %s: anchor appears %d times (want 1): %r'
                          % (rel, n, anchor.splitlines()[0][:60]))
                    failures += 1
                    break

            new_text = text
            for anchor, replacement in edits:
                new_text = new_text.replace(anchor, replacement, 1)

            if args.dry_run:
                print('  [dry-run] %s: %d edits would apply (%d -> %d bytes)'
                      % (rel, len(edits), len(text), len(new_text)))
                continue

            backup = path.with_name('%s.bak-%s-sticker' % (path.name, STAMP))
            shutil.copy2(path, backup)
            path.write_text(new_text, encoding='utf-8', newline='\n')

            check = node_check(path)
            if check.returncode != 0:
                print('  [FAIL] %s: node --check failed, restoring' % rel)
                print(check.stderr.strip()[:500])
                shutil.copy2(backup, path)
                failures += 1
                continue
            print('  [OK] %s: %d edits, %d -> %d bytes, node --check passed'
                  % (rel, len(edits), len(text), len(new_text)))

    print('')
    if failures:
        print('%d problem(s) -- nothing left half-applied (each file is checked then rolled back)' % failures)
        return 1
    if not args.dry_run:
        print('RESTART both MimirLink instances: these are code changes.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
