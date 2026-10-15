# 修正版抽取：排除"爱音→爱音"、排除旁白、按情绪分层
import os, re, io, random, collections

ROOT = r'C:\Users\20633\WorkBuddy\2026-05-28-17-36-40\_corpus_tmp\bds\story_cn'
PAIR_RE = re.compile(r'^([^：:]{1,10})[：:]\s*(.+)$')

# 情绪/态度标记：她"有反应"的样子
MARK = ('诶', '啊', '才', '不是', '哪有', '哼', '喂', '呜', '诶嘿', '哈哈', '不要',
        '怎么可能', '！', '？', '~', '啦', '嘛', '呢')
# 明显是旁白/系统句，不要
BAD = ('——', '（', '【', 'BGM', 'SE:')

buckets = collections.defaultdict(list)
stat = collections.Counter()

for dirpath, _d, files in os.walk(ROOT):
    for name in files:
        if not name.endswith('.txt'):
            continue
        try:
            lines = [l.strip() for l in io.open(os.path.join(dirpath, name), encoding='utf-8', errors='ignore').read().split('\n')]
        except Exception:
            continue
        for i in range(1, len(lines)):
            a, b = PAIR_RE.match(lines[i - 1]), PAIR_RE.match(lines[i])
            if not a or not b:
                continue
            other, said = a.group(1).strip(), a.group(2).strip()
            who, reply = b.group(1).strip(), b.group(2).strip()
            if who != '爱音':
                continue
            stat['all'] += 1
            if other == '爱音':
                stat['self_talk'] += 1
                continue
            if any(x in said for x in BAD) or any(x in reply for x in BAD):
                stat['narration'] += 1
                continue
            if not (2 <= len(said) <= 40) or not (2 <= len(reply) <= 60):
                stat['length'] += 1
                continue
            stat['ok'] += 1
            # 分层：对面在"逗她/怼她/问她" vs 普通配合
            poke = any(x in said for x in ('？', '?', '不是', '才', '你怎么', '为什么', '啊', '吧', '呢')) and len(said) <= 22
            # 位置信息（文件名可当来源）
            rec = (other, said, reply, os.path.basename(name))
            buckets['poke' if poke else 'plain'].append(rec)
            if len(reply.split('。')) >= 2 or reply.count('！') >= 2:
                buckets['lively'].append(rec)

out = ['=== 统计 ===']
for k, v in stat.items():
    out.append('  %-12s %d' % (k, v))
out.append('  poke(对面像在逗/问) %d | plain %d | lively(她反应大) %d'
           % (len(buckets['poke']), len(buckets['plain']), len(buckets['lively'])))

random.seed(7)
def dump(title, key, n):
    out.append('')
    out.append('=== %s（%d 条里随机 %d）===' % (title, len(buckets[key]), n))
    for other, said, reply, src in random.sample(buckets[key], min(n, len(buckets[key]))):
        out.append('  %s：%s' % (other, said))
        out.append('  爱音：%s' % reply)

dump('A. 对面像在逗她/问她', 'poke', 14)
dump('B. 她反应特别大的', 'lively', 14)

io.open(r'C:\Users\20633\WorkBuddy\2026-05-28-17-36-40\_corpus_pairs2.txt', 'w', encoding='utf-8').write('\n'.join(out))
print('\n'.join(out[:8]))
