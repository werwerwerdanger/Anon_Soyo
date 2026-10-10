#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
compact_history_user_qq.py -- 紧凑头里补回 QQ 号（用户 2026-10-10 13:34）

用户：「还要保留 QQ 号这样有跨群聊记忆」

第一版把用户消息头压成 `[昵称 时:分:秒]`，**丢掉了 QQ 号**。
但**昵称会变、QQ 号不变** —— 它是跨群聊/跨会话识别「同一个人」的唯一凭据。
（MimirLink 自己的 `buildParticipants()` 就是 `${userName}(${userId})` 这个格式，
 这里沿用同一约定。）

改成 `[昵称(QQ) 时:分:秒]`，例：`[werwer(2063362809) 12:57:23]`。
相比原始的 ~300 字头仍然是量级压缩。

用法: python compact_history_user_qq.py --check | (无参) | --revert
"""
import argparse
import io
import os
import pathlib
import shutil
import subprocess
import sys
import time

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

NODE = r"C:\Program Files\nodejs\node.exe"
ROOTS = [pathlib.Path(r"C:\Users\20633") / n for n in ("MimirLink", "MimirLink-soyo")]

OLD = """        const name = (head.match(/昵称:([^|\\]]*)/) || [])[1] || '';
        const time = (head.match(/时间:([^|\\]]*)/) || [])[1] || '';
        let tag = '';
        if (name || time) {
            const hm = time ? time.slice(-8) : '';
            tag = `[${name}${hm ? ' ' + hm : ''}] `;
        }"""

NEW = """        const name = (head.match(/昵称:([^|\\]]*)/) || [])[1] || '';
        // QQ 号必须留：昵称会改，QQ 不变 —— 它是**跨群聊/跨会话识别同一个人**的唯一凭据。
        // 格式沿用 MimirLink 自己的 buildParticipants()：`昵称(QQ)`。
        const qq = (head.match(/QQ:([^|\\]]*)/) || [])[1] || '';
        const time = (head.match(/时间:([^|\\]]*)/) || [])[1] || '';
        let tag = '';
        if (name || qq || time) {
            const who = name && qq ? `${name}(${qq})` : (name || qq);
            const hm = time ? time.slice(-8) : '';
            tag = `[${who}${hm ? ' ' + hm : ''}] `;
        }"""


def node_check(p):
    try:
        r = subprocess.run([NODE, "--check", p], capture_output=True, text=True, timeout=60)
        return r.returncode == 0, (r.stderr or "").strip()
    except Exception as e:
        return False, str(e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()
    stamp = time.strftime("%Y%m%d-%H%M%S")

    for root in ROOTS:
        p = root / "src" / "prompt.js"
        src = p.read_text(encoding="utf-8")
        print("=" * 74)
        print(root.name)
        a, b = (NEW, OLD) if not args.revert else (OLD, NEW)
        n = src.count(b)
        if n != 1:
            print(f"  !! 锚点命中 {n} 次（应为 1）  已含QQ={'const qq = (head.match' in src}")
            continue
        out = src.replace(b, a, 1)
        if args.check:
            print(f"  DRY {len(src)} -> {len(out)}")
            continue
        bak = str(p) + ".bak-" + stamp + "-histqq"
        shutil.copy2(p, bak)
        p.write_text(out, encoding="utf-8", newline="")
        ok, err = node_check(str(p))
        if not ok:
            shutil.copy2(bak, p)
            print(f"  !! 语法失败已还原 {err[:150]}")
            continue
        back = p.read_text(encoding="utf-8")
        want = ("const qq = (head.match" in back) if not args.revert else ("const qq = (head.match" not in back)
        print(f"  {'OK' if want else '!! 断言失败'}  {len(src)}->{len(out)}  备份={os.path.basename(bak)}")
    if args.check:
        print("(--check 只报告，未写入)")


if __name__ == "__main__":
    main()
