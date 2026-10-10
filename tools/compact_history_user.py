#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
compact_history_user.py -- 把历史里用户消息的**元数据头**压成紧凑形式

用户 2026-10-10：「爱音的那个上下文现在好像有点怪」

实测（装配后的 history 段，14 条）：
    来源          条数    总字符
    用户侧          7      2015     ← 每轮 ~290 字
    她侧            7       121     ← 每轮 ~17 字
**16.7 倍不对称**，而那 2015 字里真实内容只有约 60 字，剩下全是：

    [私聊|QQ:2063362809|昵称:werwer|群号:N/A|群名:N/A|时间:2026/10/10 12:57:23|
     eventType:message|isAtBot:false|replyToBot:true|replyQuotedText:…|
     messageSegments:[{"type":"reply","id":"1802582801"},
                      {"type":"text","text":"你就是在平均线一下"}]] [回复上文|…]
    你就是在平均线一下

问题：
  · `messageSegments` 的 JSON **把正文又重复了一遍**（纯噪音）
  · `群号:N/A 群名:N/A` 私聊里毫无信息
  · `eventType/isAtBot/replyToBot` 对**历史轮次**没有价值
  · 合并批次会把**多条**这种头拼在一起，单条能到 607 字

⇒ 压成 `[昵称 时:分:秒]`：**保留"谁说的、什么时候"**（群聊里区分发言人要靠昵称），
   丢掉其余。2015 → 约 80 字。

实现要点：
  · 用**括号配对**找头的结尾 —— `messageSegments:[{…}]` 里含 `]`，
    朴素的 `[^\]]*` 会截断在数组的 `]` 上。配对计数能正确处理 `[…[{}]]`。
  · 找不到配对就原样返回（宁可留噪音，不能把正文吃掉）。

用法: python compact_history_user.py --check | (无参) | --revert
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

MARK = "// >>> compact-history-user patch >>>"
MARK_E = "// <<< compact-history-user patch <<<"

HELPER = MARK + """
// 把用户消息的结构化头 [私聊|QQ|昵称|…|messageSegments:[…]] 压成 [昵称 时:分:秒]。
// 头里的 messageSegments 是 JSON，把正文重复一遍；群号/群名在私聊是 N/A；
// eventType/isAtBot 对历史轮次无意义。但**昵称要留**（群聊靠它区分发言人）。
const compactHistoryUser = (content) => {
    const src = String(content === undefined || content === null ? '' : content);
    let out = src;
    for (let guard = 0; guard < 24; guard += 1) {
        const start = out.search(/\\[(?:群聊|私聊)\\|/);
        if (start < 0) break;
        // 括号配对找头的结尾：messageSegments:[{…}] 内部含 ']'
        let depth = 0;
        let end = -1;
        for (let i = start; i < out.length; i += 1) {
            const ch = out[i];
            if (ch === '[') depth += 1;
            else if (ch === ']') {
                depth -= 1;
                if (depth === 0) { end = i; break; }
            }
        }
        if (end < 0) break;                       // 配不上就原样留着，别吃正文
        const head = out.slice(start, end + 1);
        const name = (head.match(/昵称:([^|\\]]*)/) || [])[1] || '';
        const time = (head.match(/时间:([^|\\]]*)/) || [])[1] || '';
        let tag = '';
        if (name || time) {
            const hm = time ? time.slice(-8) : '';
            tag = `[${name}${hm ? ' ' + hm : ''}] `;
        }
        out = out.slice(0, start) + tag + out.slice(end + 1);
    }
    // 引用前缀 [回复上文|…] 在历史轮次里也只是噪音
    out = out.replace(/\\[回复上文\\|[^\\]]*\\]\\s*/g, '');
    return out.replace(/[ \\t]{2,}/g, ' ').replace(/\\n{2,}/g, '\\n').trim();
};
""" + MARK_E

ANCHOR_NEW = """                ? shortenHistoryAssistant(message.content)
                : message.content,"""
REPL_NEW = """                ? shortenHistoryAssistant(message.content)
                : compactHistoryUser(message.content),"""

# 助手函数插在 historyMessages 之前
HELPER_ANCHOR = """        const historyMessages = normalizedContext.recentMessages.map((message, index) => ({"""


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
        if args.revert:
            if MARK not in src:
                print("  -- 没打过")
                continue
            out = src.replace(HELPER, "", 1).replace(REPL_NEW, ANCHOR_NEW, 1)
        else:
            if MARK in src:
                print("  -- 已打过")
                continue
            bad = []
            if src.count(HELPER_ANCHOR) != 1:
                bad.append(f"插入锚点={src.count(HELPER_ANCHOR)}")
            if src.count(ANCHOR_NEW) != 1:
                bad.append(f"替换锚点={src.count(ANCHOR_NEW)}")
            if bad:
                print("  !! " + "; ".join(bad))
                continue
            out = src.replace(HELPER_ANCHOR, HELPER + "\n" + HELPER_ANCHOR, 1)
            out = out.replace(ANCHOR_NEW, REPL_NEW, 1)
        if args.check:
            print(f"  DRY {len(src)} -> {len(out)}")
            continue
        bak = str(p) + ".bak-" + stamp + "-compacthist"
        shutil.copy2(p, bak)
        p.write_text(out, encoding="utf-8", newline="")
        ok, err = node_check(str(p))
        if not ok:
            shutil.copy2(bak, p)
            print(f"  !! 语法失败已还原 {err[:150]}")
            continue
        back = p.read_text(encoding="utf-8")
        want = ("compactHistoryUser(message.content)" in back) if not args.revert \
            else ("compactHistoryUser" not in back)
        print(f"  {'OK' if want else '!! 断言失败'}  {len(src)}->{len(out)}  备份={os.path.basename(bak)}")
    if args.check:
        print("(--check 只报告，未写入)")


if __name__ == "__main__":
    main()
