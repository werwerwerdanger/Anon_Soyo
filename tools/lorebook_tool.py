# -*- coding: utf-8 -*-
"""世界书（Lorebook）管理脚本 —— 安全地增删条目。

用法：
    python lorebook_tool.py list   [--inst soyo|anon|both]
    python lorebook_tool.py add    --inst soyo --json entries.json
    python lorebook_tool.py toggle --inst soyo --id 15 --enabled false

为什么要有它：
  * `data/worlds/` 里**每个角色有两个同名世界书**（`Xxx Yyy's Lorebook.json` 空格版 /
    `Xxx_Yyy's Lorebook.json` 下划线版），内容相同、名字不同。程序究竟读哪个未验证，
    所以本工具默认**两个文件一起写**，保证生效，且保持它们一致（它们本来就是一致的）。
  * 世界书条目格式字段多（id/keys/secondary_keys/comment/content/constant/selective/
    insertion_order/enabled/position/use_regex/extensions），手改极易写坏 ⇒ 统一由本工具生成。
  * 每次写入都：先备份 → 原子写 → 重新读取解析校验 → 打印摘要。

安全约定：
  * 只新增/修改，不静默删除；要删必须显式 --delete-and-name。
  * 写入前断言文件能被 json.loads 解析（否则拒绝覆盖）。
"""
import argparse
import json
import os
import pathlib
import shutil
import sys
import time

STAMP = time.strftime('%Y%m%d-%H%M%S')
BASES = {
    'soyo': pathlib.Path(r'C:\Users\20633\MimirLink-soyo\data\worlds'),
    'anon': pathlib.Path(r'C:\Users\20633\MimirLink\data\worlds'),
}


def files_for(key):
    base = BASES[key]
    return sorted(base.glob('*Lorebook.json'))


def load(path):
    return json.loads(path.read_text(encoding='utf-8'))


def entry_template(entry_id, keys, content, comment=''):
    """对齐现有条目的字段结构（字段名与取值都照抄已有条目，避免格式漂移）。"""
    return {
        'id': entry_id,
        'keys': list(keys) + [''],
        'secondary_keys': [''],
        'comment': comment,
        'content': content,
        'constant': False,
        'selective': False,
        'insertion_order': 10 + entry_id,
        'enabled': True,
        'position': 'after_char',
        'use_regex': True,
        'extensions': {
            'depth': 4,
            'linked': False,
            'weight': 10,
            'addMemo': True,
            'embedded': True,
            'probability': 100,
            'displayIndex': entry_id,
            'selectiveLogic': 0,
            'useProbability': True,
            'characterFilter': None,
            'excludeRecursion': True,
        },
    }


def write_safely(path, data):
    text = json.dumps(data, ensure_ascii=False, indent=2)
    json.loads(text)                      # 写之前先自证能解析
    shutil.copy2(path, path.with_name('%s.bak-%s' % (path.name, STAMP)))
    tmp = path.with_suffix('.json.tmp')
    tmp.write_text(text, encoding='utf-8')
    os.replace(tmp, path)                 # 原子替换
    back = load(path)                     # 写之后回读
    assert isinstance(back.get('entries'), list)
    return len(back['entries'])


def cmd_list(inst):
    for key in (['soyo', 'anon'] if inst in ('both', None) else [inst]):
        print('=' * 70)
        print('[%s]' % key)
        for f in files_for(key):
            d = load(f)
            print('  %s  %d 条  %d 字节' % (f.name, len(d.get('entries') or []), f.stat().st_size))
            for e in d.get('entries') or []:
                keys = [k for k in (e.get('keys') or []) if k]
                print('     id=%-3s %-26s keys=%s' % (
                    e.get('id'), (e.get('comment') or '')[:26], ','.join(keys[:5])[:52]))


def cmd_add(inst, spec_path):
    spec = json.loads(pathlib.Path(spec_path).read_text(encoding='utf-8'))
    for key in (['soyo', 'anon'] if inst in ('both', None) else [inst]):
        for f in files_for(key):
            d = load(f)
            entries = d.setdefault('entries', [])
            existing = {e.get('id') for e in entries}
            names = {(e.get('comment') or '') for e in entries}
            for item in spec.get('entries', []):
                if item.get('comment') and item['comment'] in names:
                    print('  [SKIP] %s 已有条目 %r' % (f.name, item['comment']))
                    continue
                eid = item.get('id')
                if eid in existing:
                    eid = max([i for i in existing if isinstance(i, int)] or [0]) + 1
                entries.append(entry_template(eid, item['keys'], item['content'], item.get('comment', '')))
                existing.add(eid)
                names.add(item.get('comment', ''))
            n = write_safely(f, d)
            print('  [OK] %s -> 共 %d 条' % (f.name, n))


def cmd_toggle(inst, entry_id, enabled):
    for key in (['soyo', 'anon'] if inst in ('both', None) else [inst]):
        for f in files_for(key):
            d = load(f)
            hit = 0
            for e in d.get('entries') or []:
                if str(e.get('id')) == str(entry_id):
                    e['enabled'] = enabled
                    hit += 1
            n = write_safely(f, d)
            print('  [OK] %s: 改了 %d 条 (enabled=%s)，共 %d 条' % (f.name, hit, enabled, n))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['list', 'add', 'toggle'])
    ap.add_argument('--inst', default='both', choices=['soyo', 'anon', 'both'])
    ap.add_argument('--json')
    ap.add_argument('--id')
    ap.add_argument('--enabled', default='true')
    a = ap.parse_args()
    if a.cmd == 'list':
        cmd_list(a.inst)
    elif a.cmd == 'add':
        cmd_add(a.inst, a.json)
    else:
        cmd_toggle(a.inst, a.id, a.enabled.lower() in ('1', 'true', 'yes'))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
