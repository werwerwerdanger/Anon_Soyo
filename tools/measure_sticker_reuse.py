# -*- coding: utf-8 -*-
"""统计本实例收过的图片：按 MD5(file=字段) 去重，算缓存命中率。"""
import collections
import re
import sqlite3
import sys

DB = sys.argv[1] if len(sys.argv) > 1 else \
    r'C:\Users\20633\MimirLink-soyo\data\chats\memory-store.sqlite'

con = sqlite3.connect('file:%s?mode=ro' % DB.replace('\\', '/'), uri=True)
cur = con.cursor()
cur.execute("SELECT metadata_json FROM messages WHERE metadata_json LIKE '%file=%'")
rows = cur.fetchall()
print('含 file= 的消息行数:', len(rows))

pat = re.compile(r'file=([0-9A-Fa-f]{32})\.([A-Za-z0-9]+),sub_type=(\d+),url=[^,]*?,file_size=(\d+)')
hits = collections.Counter()
sizes = {}
subtypes = collections.Counter()
total = 0
for (mj,) in rows:
    for m in pat.finditer(mj or ''):
        total += 1
        h = m.group(1).lower()
        hits[h] += 1
        sizes[h] = int(m.group(4))
        subtypes[m.group(3)] += 1

print('图片出现总次数   :', total)
print('不同图片(MD5)    :', len(hits))
if total:
    print('重复率           : %.1f%%' % (100.0 * (total - len(hits)) / total))
    print('总流量           : %.1f MB (原始) / %.1f MB (base64)' % (
        sum(sizes[h] * c for h, c in hits.items()) / 1048576.0,
        sum(sizes[h] * c for h, c in hits.items()) * 4 / 3 / 1048576.0))
    print('去重后仅需      : %.1f MB (原始)' % (sum(sizes.values()) / 1048576.0))
print('sub_type 分布    :', dict(subtypes))
print()
print('出现次数 top10:')
for h, c in hits.most_common(10):
    print('  %s  x%-3d %8.1f KB' % (h, c, sizes[h] / 1024.0))
