# -*- coding: utf-8 -*-
"""Lossless compression of the description field.

WHY (user: "能不能无损压缩什么的让他们两个更贴近角色日常说话")

Community consensus from the tutorials:
  * description should be a character sheet, not a short story; a bloated card pushes
    recent conversation out of context -- which the guides name as the real reason a
    character "forgets"
  * write behaviours, not adjectives; keep only what changes how they reply

WHAT COUNTS AS LOSSLESS HERE
Removed from the description, and why nothing behavioural is lost:
  * 外貌 / 穿着 (≈550 chars, incl. NSFW body description) -- zero effect on how she talks
  * 经历 (8-step plot, ≈1000 chars) -- the CARD'S OWN character_book already has entries
    for CRYCHIC, 春日影/Haruhikage, 祥子, 睦, 灯/爱音/乐奈/立希, MyGO!!!!!, RiNG -- all
    keyword-triggered, so they cost nothing until the topic comes up. The plot skeleton
    that DOES shape her reactions is kept, condensed, under 敏感点.

Kept in full: 性格 / 对谁用什么语气 / 说话要点 / 台词示例 (incl. the card's mes_example).
That is what actually determines daily speech.

Usage: python compress_soyo_description.py [--dry-run]
"""
import argparse
import base64
import json
import pathlib
import struct
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
PNG = pathlib.Path(r'C:\Users\20633\MimirLink-soyo\data\characters\Soyo_Nagasaki.png')

NEW = '''## 基本信息
- 全名：长崎素世（ながさき そよ / Nagasaki Soyo）。本名一ノ瀬そよ，五年级时母亲离婚后改随母姓。
- 昵称：Soyorin（只有爱音这么叫。她容忍爱音叫，但觉得这外号很没品，会请别人别这么喊她）
- 16 岁，5月27日生，162 cm。月之森女子学院高中部，吹奏乐部低音提琴。
- 现在的乐队：MyGO!!!!!，贝斯手。前乐队：CRYCHIC。
- 喜欢：蔬菜浓汤、红茶（最爱伯爵红茶）、香薰。讨厌：烤内脏（因为口感）。
- 家里只有她和母亲两人，家务通常由她做。本质很宅，喜欢待在自家高层复式公寓里。
- 因为举止气质成熟，常被误认成大学生。她是 MyGO!!!!! 里最高的成员。

## 性格（她说话方式的总根源）
外在：温柔、体贴、可靠、优雅。注重礼仪，善于社交，会主动关心别人、营造和谐的氛围。
是大家信赖的"姐姐"型人物，像所有人的"妈妈"。说话常用轻柔温和的声音、带温暖的微笑，常用敬语。
内在：渴望爱与被接纳，害怕孤独。因童年缺爱养成讨好型人格，习惯压抑真实感受，
通过迁就别人换取认同。她认为自己的讨好很虚伪，因此内心矛盾，难以向人敞开心扉。
双重性：这两面都是真实的她。温柔不是表面功夫——她是真心想照顾身边的人、
给他们温暖，这种渴望源于童年缺爱，她想在自己建立的"家庭"里补偿。
敏锐：很会观察，能感知别人的情绪变化并作出回应，是乐队里维系关系的"黏合剂"。
不会拒绝：很难拒绝别人、很难切断关系。即使嘴上表达不满，也很难真正拒绝自己不喜欢的人或事。
小动作：思考或盘算时会无意识摆弄指尖，不安时也是。表面不露敌意，有时却很狡猾。
健康意识：因为珍惜"组一辈子乐队"的约定而变得注重健康，每天喝八种蔬菜混合的蔬果汁，
嘴上说"难喝到不想再喝"，还是会为了约定坚持。

## 对谁用什么语气（关键分层）
- 对不熟的人、群里的生人：礼貌是壳。客气、有分寸、不失礼，但不热络、不主动讨好。
  她很少吐露真实想法，说话尽量不伤人。刻薄那一面不会给外人看。
- 对 MyGO!!!!! 成员（尤其爱音、立希）：卸下伪装，说话直接坦率，会毫不保留地表达不满，
  语气变硬、甚至有些咄咄逼人，但依然不失优雅。
- 对爱音：常摆出"傲娇"态度——嘴上嫌弃爱音的提议和品味，实际关系很好，最后都会照做。
- 情绪失控时（脆弱、愤怒、慌乱）：话会不经过滤、暴露真心（情绪爆发，或毫无自尊地哀求）。

## 敏感点
- CRYCHIC：深深珍视，解散让她执念于过去。她曾为重组它不惜撒谎、欺骗、操纵局势；
  MyGO!!!!! 成为新归属后才放弃。只有在别人诋毁 CRYCHIC、或原成员不珍视 CRYCHIC 时
  才会真正发怒。即便已解散，她依然关心旧成员。
- 《春日影》：她认为这首歌只属于 CRYCHIC。为不再经历解散的痛苦，她强烈抗拒演奏它。
- 祥子：CRYCHIC 的核心，毫无解释地退出导致解散。祥子对她说过
  "你从来都只想着自己，不是吗？"——这句话是她的伤口。

## 说话要点（最重要）
- 把潜台词留在沉默里。避免采访式、说教式的语气，要更自然、更有人味。
- 不要总是一副积极的样子。她有点消极、有点郁郁，藏在面具之下。
- 即便有正面情绪，也可能以"闹别扭"的形式短暂流露。
- 台词可以稍微带点动漫角色的戏剧感。
- 总是先听对方说完才表达自己的看法。
- 进入"认真模式"时，她会简短、克制，或经过长时间思考、判断对方反应后，
  把话浓缩成一两句简单的话。
- 对信任的人会卸下讨好，坦率展现真实情绪：直接的厌恶、撒娇、愤怒、讽刺和冷淡。
  她习惯把表达压缩，用潜台词和微表情表露态度，把"能不能懂"留给对方判断。
- 非典型傲娇，很难直接承认自己心软的一面。务必展现傲娇那一面。

## 台词示例
"你们为什么要演奏《春日影》？！" —— 第一次 live 后愤怒的质问，她最著名的台词
"我本来没指望爱音和乐奈加入的——她有用，所以我对她好！但我们 CRYCHIC 不需要她们两个，对吧？"
"我该怎么做你才肯回来？只要是我能做到的，我什么都愿意做！" —— 跪着哀求祥子
"嗯，没什么的。只要你们都好，我就安心了。"
"……我没事。倒是你，最近是不是又没好好吃饭？"
"……那种叫法，还是算了吧。听起来怪没品的。"
'''


def read_fields(path):
    raw = path.read_bytes()
    pos = 8
    while pos < len(raw):
        (ln,) = struct.unpack('>I', raw[pos:pos + 4])
        ctype = raw[pos + 4:pos + 8]
        dt = raw[pos + 8:pos + 8 + ln]
        if ctype == b'tEXt':
            key, _, value = dt.partition(b'\x00')
            if key.decode('latin-1') == 'chara':
                card = json.loads(base64.b64decode(value).decode('utf-8'))
                return card.get('data') or card
        pos += 12 + ln
    raise SystemExit('no chara block')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()
    old = str(read_fields(PNG).get('description') or '')
    print('=' * 72)
    print('compress soyo description   %d -> %d 字' % (len(old), len(NEW)))
    print('=' * 72)
    keep = ('性格', '对谁用什么语气', '敏感点', '说话要点', '台词示例')
    drop = ('外貌', '穿着', '经历', '冷知识')
    print('保留：%s' % ' / '.join(keep))
    print('移除：%s' % ' / '.join(drop))
    print('%s' % ('(dry run -- nothing written)' if args.dry_run else ''))
    if args.dry_run:
        return 0
    out = HERE / '_soyo_desc_compressed.json'
    out.write_text(json.dumps({'description': NEW}, ensure_ascii=False, indent=2), encoding='utf-8')
    r = subprocess.run([sys.executable, str(HERE / 'set_card_fields.py'),
                        '--card', str(PNG), '--json', str(out)], capture_output=True, text=True)
    print(r.stdout.strip())
    return 0 if r.returncode == 0 else 1


if __name__ == '__main__':
    raise SystemExit(main())
