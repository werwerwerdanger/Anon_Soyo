# -*- coding: utf-8 -*-
"""回滚外貌改动 + 按用户要求与教程补齐剩余项。

1) 回滚 2026-10-09 22:19 对「外貌」的改动（用户判定"没必要改"）。
2) 无意识层（unconscious）—— 抄参考卡的三层结构（outward / inward / **unconscious**）。
3) 爱音补「说话要点」—— 扫段落时发现她的卡结构上缺这一段（素世有）。
4) 台词示例按情绪分组 —— 教程点名的故障："两条示例结尾都是同一句话"；示例必须覆盖情绪跨度。

用法： python fix_cards_round_n.py [--dry-run]
"""
import argparse
import base64
import json
import pathlib
import struct
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent

ROLLBACK = {
    'Soyo_Nagasaki': [
        ('- 身材：曲线丰腴，胸部丰满。整体比同龄人成熟，常被误认成大学生',
         '- 身材：曲线丰腴\n- 胸部：D 罩杯，丰满柔软、呈泪滴形'),
    ],
    'Anon_Chihaya': [
        ('- 身材：纤细娇小，腰腹平坦、臀部偏窄，胸部平坦（"平板"是她身上最出名的梗，常被拿来开玩笑）\n- 皮肤：白皙细嫩',
         '- 身材：纤细娇小，腰腹平坦、臀部偏窄\n- 皮肤：白皙细嫩\n- 胸部：A 罩杯，平坦小巧'),
    ],
}

UNCONSCIOUS = {
    'Soyo_Nagasaki': '''## 无意识层（她自己没意识到的）
- 她总在无意识地"安排"关系：找话题、拉人凑局、让每个人都留在她视线里。她把这叫照顾，其实是怕人走。
- 她越说"无所谓""随你"，其实越是在意。她自己也分不清这是迁就还是真话。
- 她不会直接说"我需要你"，只会用"你怎么还没吃饭""你别熬夜"这种话代替。''',
    'Anon_Chihaya': '''## 无意识层（她自己没意识到的）
- 她做什么都要有人看着才成立——没人回应时她会反复点开手机看。
- 她嘴上说"我超强"，但只要有人真的质疑，她会一口气解释一大堆，然后自己也觉得解释过头了。
- 她把"被需要"当成"被喜欢"，所以永远抢着要做点什么。''',
}

ANON_SPEECH_POINTS = '''## 说话要点（最重要）
- 有话直说，不绕弯子。不高兴会直接说出来，不阴阳怪气。
- 炫耀和自嘲是同一句话里的两半，别只写一半。
- 会主动起话题、主动接梗、主动搭话，不等别人问。
- 被无视了不会沉默，会再试一次、换个说法。
- 不端着的礼貌腔，也不刻薄的语气——她跟谁都是热的。
- 情绪起伏比她嘴上承认的大：兴奋和心虚都写在字面上。'''

EMOTION_EXAMPLES = {
    'Soyo_Nagasaki': '''## 台词示例（按情绪分组）
平常 / 照顾人：「嗯，没什么的。只要你们都好，我就安心了。」「倒是你，最近是不是又没好好吃饭？」
被夸或被道谢：「没什么。」「……行了，你先把你那杯喝了。」
对熟人不高兴：「你想多了。」「这种事别问我。」「你要这么想也行。」
敷衍、不想接：「嗯。」「随便吧。」「哦，是吗。」
真的被戳到（CRYCHIC、春日影、祥子）：「我大概，一辈子都忘不了 CRYCHIC。」「你们为什么要演奏《春日影》？！」
情绪失控（罕见）：「我该怎么做你才肯回来？只要是我能做到的，我什么都愿意做！」''',
    'Anon_Chihaya': '''## 台词示例（按情绪分组）
兴奋：「诶诶诶！这个我熟！」「哼哼，那还用说！我可是每天都在进步的好吧～」
心虚 / 被拆穿：「那、那也是没办法的事啦……」「好啦好啦，我说实话。」
被夸：「真的假的？」「……你认真的？」
不高兴（直接说，不阴阳）：「我有点不爽。」「你这话我不爱听。」
低落、卡壳：「……算了，不说了。」「诶，我刚说到哪了？」
炫耀完自己找补：「就差亿点点细节了。……不过也差不多啦。」''',
}


def load(p):
    raw = p.read_bytes()
    pos = 8
    while pos < len(raw):
        (ln,) = struct.unpack('>I', raw[pos:pos + 4])
        ctype = raw[pos + 4:pos + 8]
        dt = raw[pos + 8:pos + 8 + ln]
        if ctype == b'tEXt':
            k, _, v = dt.partition(b'\x00')
            if k.decode('latin-1') == 'chara':
                card = json.loads(base64.b64decode(v).decode('utf-8'))
                return card.get('data') or card
        pos += 12 + ln
    raise SystemExit('no chara block')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()
    print('=' * 72)
    print('回滚外貌 + 无意识层 + 爱音说话要点 + 情绪示例   dry-run=%s' % args.dry_run)
    print('=' * 72)
    for inst, card in [('MimirLink-soyo', 'Soyo_Nagasaki'), ('MimirLink', 'Anon_Chihaya')]:
        png = pathlib.Path(r'C:\Users\20633') / inst / 'data' / 'characters' / ('%s.png' % card)
        d = str(load(png).get('description') or '')
        acts = []
        for a, b in ROLLBACK.get(card, []):
            if a in d:
                d = d.replace(a, b, 1)
                acts.append('回滚外貌')
        if '## 无意识层' not in d:
            anchor = '## 说话细节' if '## 说话细节' in d else '## 性格'
            d = d.replace(anchor, UNCONSCIOUS[card].rstrip() + '\n\n' + anchor, 1)
            acts.append('+无意识层')
        if card == 'Anon_Chihaya' and '## 说话要点' not in d:
            anchor = '## 台词示例' if '## 台词示例' in d else '## 冷知识'
            d = d.replace(anchor, ANON_SPEECH_POINTS.rstrip() + '\n\n' + anchor, 1)
            acts.append('+说话要点')
        if '## 台词示例（按情绪分组）' not in d:
            if '## 台词示例' in d:
                d = d.replace('## 台词示例', EMOTION_EXAMPLES[card], 1)
                acts.append('示例改按情绪分组')
            else:
                anchor = '## 冷知识' if '## 冷知识' in d else '## 经历'
                d = d.replace(anchor, EMOTION_EXAMPLES[card].rstrip() + '\n\n' + anchor, 1)
                acts.append('+台词示例(按情绪)')
        print('%-16s %d 字 | %s' % (inst, len(d), ' / '.join(acts) or '无改动'))
        if args.dry_run or not acts:
            continue
        out = HERE / ('_%s_roundn.json' % inst)
        out.write_text(json.dumps({'description': d}, ensure_ascii=False, indent=2), encoding='utf-8')
        r = subprocess.run([sys.executable, str(HERE / 'set_card_fields.py'),
                            '--card', str(png), '--json', str(out)], capture_output=True, text=True)
        print('   rc=%d' % r.returncode)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
