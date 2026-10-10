#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
score_lab.py -- 给 humanity_lab 生成的回复打语气分，对齐「官方爱音」基线

用法:
  python score_lab.py _lab_tone_new.json
"""
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tone_lab as T  # noqa: E402


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "_lab_tone_new.json"
    d = json.load(open(path, encoding="utf-8"))
    segs = d.get("segment_texts") or []
    humans = [t for _q, t in T.corpus_mod.dedupe(
        T.corpus_mod.from_log() + T.corpus_mod.from_db())]
    official = T.load_official()
    priv = T.load_bot(T.DB_PRIV, "private:2063362809")
    grp = T.load_bot(T.DB_GROUP, "group:929159193")

    rows = [
        T.stats(humans, "本群真人"),
        T.stats(official, "★官方爱音"),
        T.stats(priv, "旧-私聊"),
        T.stats(grp, "旧-群聊"),
        T.stats(segs, "★新生成"),
    ]
    print("=" * 150)
    T.show(rows)

    off = rows[1]
    new = rows[4]
    print()
    print("=== ★新生成 vs ★官方爱音 逐项差距（越小越像）===")
    print(f"{'指标':<14}{'官方':>8}{'新生成':>8}{'旧私聊':>8}{'差距':>8}")
    old = rows[2]
    for k in T.KEYS:
        if k == "中位长度":
            print(f"{k:<14}{off[k]:>8}{new[k]:>8}{old[k]:>8}{new[k] - off[k]:>+8}")
        else:
            print(f"{k:<14}{str(off[k]) + '%':>8}{str(new[k]) + '%':>8}"
                  f"{str(old[k]) + '%':>8}{new[k] - off[k]:>+8}")
    print()
    print("=== 新生成样例（前 20 段）===")
    for s in segs[:20]:
        print(f"  {s}")


if __name__ == "__main__":
    main()
