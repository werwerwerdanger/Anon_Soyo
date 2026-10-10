# -*- coding: utf-8 -*-
"""给图片/表情包加内容哈希，让模型知道"这是同一张"。

背景（2026-10-09 实测）：
  * QQ 表情包到达时是 {"type":"image","summary":"[动画表情]"}，有时能取到图、有时取不到。
  * `mode: 'direct'`（正常路径）下 `captionText` 是空串，**图片不带任何文字**给模型
    ⇒ 模型没法判断"这张和刚才那张是同一张"。

做法（刻意最小改动，避免动到 6 个 return）：
  1) image-input.js：把原 `prepareImageInput` 改名为 `prepareImageInputInner`（内部函数），
     再导出同名**包装函数**，在结果上加一个 `imageTags` 字段。
  2) tags 由 `imageParts` 里的 data URL 计算 —— 同一张图字节相同 ⇒ 数据相同 ⇒ 哈希相同。
     远端 URL（未内联）退化为取"去掉 query 的路径"，仍比整串 URL 稳定。
  3) index.js：`mode === 'direct'` 分支里把 `imageTags` 追加进 `processedInput`。

哈希用 FNV-1a（自实现，**不引入 crypto import**，够区分"同图/不同图"）。

用法： python patch_image_hash.py [--dry-run]
"""
import argparse
import pathlib
import shutil
import subprocess
import time

NODE = r'C:\Users\20633\.workbuddy\binaries\node\versions\22.22.2-6\node.exe'
STAMP = time.strftime('%Y%m%d-%H%M%S')
INSTANCES = ['MimirLink-soyo', 'MimirLink']

II_RENAME_FROM = 'export async function prepareImageInput({ items = [], config = {}, bot, aiClient, resolveHost } = {}) {'
II_RENAME_TO = 'async function prepareImageInputInner({ items = [], config = {}, bot, aiClient, resolveHost } = {}) {'
II_WRAPPER = '''

// >>> image-hash patch (managed by patch_image_hash.py) >>>
// 同一张图（字节相同）算出同一个短哈希，模型据此可判断"这张刚才发过"。
// 用 FNV-1a 自实现，不引入额外 import。
function shortImageHash(value) {
    let h = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
        h ^= value.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

function buildImageTags(result) {
    const parts = Array.isArray(result?.imageParts) ? result.imageParts : [];
    const tags = [];
    for (const part of parts) {
        const url = String(part?.image_url?.url || '');
        if (!url) continue;
        if (url.startsWith('data:')) {
            const comma = url.indexOf(',');
            tags.push('#' + shortImageHash(comma >= 0 ? url.slice(comma + 1) : url));
        } else {
            // 远端 URL 带签名参数，取路径部分更稳定
            tags.push('#' + shortImageHash(url.split('?')[0]));
        }
    }
    if (!tags.length) return '';
    return '[图片标识 ' + tags.join(' ') + '] 同一张图每次都是同一个标识；'
        + '如果这个标识在本轮之前的对话里出现过，说明对方又发了同一张图，可以直接点出来。';
}

export async function prepareImageInput(args = {}) {
    const result = await prepareImageInputInner(args);
    try {
        result.imageTags = buildImageTags(result);
    } catch {
        result.imageTags = '';
    }
    return result;
}
// <<< image-hash patch <<<
'''

IDX_ANCHOR = "logger.info('[图片] 图片直传聊天模型', { sessionId, imageCount: imageInput.imageCount, inlineCount, captionSkipped: imageInput.captionSkipped || '', mode: 'direct' });"
IDX_NEW = IDX_ANCHOR + '''
                    // >>> image-hash patch <<<
                    if (imageInput.imageTags) {
                        processedInput = `${processedInput}\\n\\n${imageInput.imageTags}`;
                    }
                    // <<< image-hash patch <<<'''


def check(path):
    return subprocess.run([NODE, '--check', str(path)], capture_output=True, text=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()
    print('=' * 72)
    print('patch image hash   dry-run=%s' % args.dry_run)
    print('=' * 72)
    for inst in INSTANCES:
        root = pathlib.Path(r'C:\Users\20633') / inst
        print('')
        print('--- %s ---' % inst)
        # 1) image-input.js
        ii = root / 'src' / 'image-input.js'
        t = ii.read_text(encoding='utf-8')
        if 'image-hash patch' in t:
            print('  [SKIP] image-input.js 已打过')
        else:
            if t.count(II_RENAME_FROM) != 1:
                print('  [FAIL] 找不到 prepareImageInput 定义')
                continue
            n_iipush = t.count('imageParts.push({ type: \'image_url\'')
            t2 = t.replace(II_RENAME_FROM, II_RENAME_TO, 1)
            t2 = t2.rstrip() + II_WRAPPER
            if args.dry_run:
                print('  [dry-run] image-input.js: 改名+加包装 (+%d 字节, imageParts.push=%d 处)'
                      % (len(t2) - len(t), n_iipush))
            else:
                bak = ii.with_name('image-input.js.bak-%s-imghash' % STAMP)
                shutil.copy2(ii, bak)
                ii.write_text(t2, encoding='utf-8', newline='\n')
                r = check(ii)
                if r.returncode != 0:
                    shutil.copy2(bak, ii)
                    print('  [FAIL] image-input.js 语法错，已还原: %s' % r.stderr.strip()[:130])
                    continue
                print('  [OK] image-input.js 改名+包装，node --check 通过')
        # 2) index.js
        idx = root / 'src' / 'index.js'
        t = idx.read_text(encoding='utf-8')
        if 'image-hash patch' in t:
            print('  [SKIP] index.js 已打过')
        elif t.count(IDX_ANCHOR) != 1:
            print('  [FAIL] index.js 锚点出现 %d 次' % t.count(IDX_ANCHOR))
        elif args.dry_run:
            print('  [dry-run] index.js: 注入 imageTags 追加')
        else:
            bak = idx.with_name('index.js.bak-%s-imghash' % STAMP)
            shutil.copy2(idx, bak)
            idx.write_text(t.replace(IDX_ANCHOR, IDX_NEW, 1), encoding='utf-8', newline='\n')
            r = check(idx)
            if r.returncode != 0:
                shutil.copy2(bak, idx)
                print('  [FAIL] index.js 语法错，已还原: %s' % r.stderr.strip()[:130])
            else:
                print('  [OK] index.js 注入 imageTags，node --check 通过')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
