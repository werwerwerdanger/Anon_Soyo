#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_history_trim.py -- 把上下文里「她自己过去的回复」压短

诊断（2026-10-10，用户："怎么还是雷霆大段回复"）：
测试台用 2 条上下文时中位 19 字，看着还行；但线上是 58~84 字、3~4 段。
根因是 chat.historyLimit = 100 —— 真实上下文里塞了 **17 条她自己过去的回复，
中位 45 字**。模型照着"自己刚才怎么说话"继续写，长度自我强化，
system_prompt / first_mes / 台词示例 全被压过去。

实测（真实长上下文回放）：原始中位 62 字、每轮 3.2 段、标点 0%。

改法：在 buildRuntimeComposition 拼装历史时，**只保留她自己回复的第一条分段**
（splitReplyIntoSegments 本来就是按换行拆的，所以第一条分段天然是短句），
再按 historyAssistantMaxChars 兜底截断。
- 只影响喂给模型的文本，**不动 sqlite 里存的内容**；
- 用户说的话一个字不改；
- 开关 `chat.historyAssistantTrim`（默认开），长度 `chat.historyAssistantMaxChars`（默认 24）。

用法:
  python patch_history_trim.py --check
  python patch_history_trim.py
"""
import argparse
import os
import shutil
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

DIRS = [r"C:\Users\20633\MimirLink-soyo\src", r"C:\Users\20633\MimirLink\src"]

MARK_S = "// >>> history-assistant-trim patch (managed by patch_history_trim.py) >>>"
MARK_E = "// <<< history-assistant-trim patch <<<"

CFG_OLD = """        const chatConfig = config.chat || {};
        this.presetConfig = presetConfig;"""
CFG_NEW = """        const chatConfig = config.chat || {};
        // >>> history-assistant-trim patch <<<
        this.chatConfig = chatConfig;
        // <<< history-assistant-trim patch <<<
        this.presetConfig = presetConfig;"""

HIST_OLD = """        const historyMessages = normalizedContext.recentMessages.map((message, index) => ({
            role: message.role,
            content: message.content,
            meta: {
                source: 'history',
                sourceId: `history-${index}`
            }
        }));"""

HIST_NEW = """        """ + MARK_S + """
        // 模型会照着上下文里「它自己过去的回复」的长度继续写。实测：私聊历史里
        // 17 条 assistant 消息中位 45 字 ⇒ 生成结果中位 62 字。把这 17 条压成
        // 各自的第一条分段（本来就是短句）之后，生成结果明显变短。
        // 只改喂给模型的文本，不动 sqlite 里存的内容，用户说的话一个字不改。
        const trimChatCfg = this.chatConfig || {};
        const trimOn = trimChatCfg.historyAssistantTrim !== false;
        const trimMax = Math.max(0, Number(trimChatCfg.historyAssistantMaxChars) || 24);
        const shortenHistoryAssistant = (content) => {
            const raw = String(content === undefined || content === null ? '' : content);
            if (!trimOn) return raw;
            const firstLine = raw.split(/\\r?\\n/)
                .map((part) => part.trim())
                .filter(Boolean)[0] || raw.trim();
            return firstLine.length > trimMax ? firstLine.slice(0, trimMax) : firstLine;
        };
        """ + MARK_E + """
        const historyMessages = normalizedContext.recentMessages.map((message, index) => ({
            role: message.role,
            content: message.role === 'assistant'
                ? shortenHistoryAssistant(message.content)
                : message.content,
            meta: {
                source: 'history',
                sourceId: `history-${index}`
            }
        }));"""


def node_check(path):
    try:
        r = subprocess.run(["node", "--check", path], capture_output=True, text=True, timeout=60)
        return r.returncode == 0, (r.stderr or "").strip()
    except Exception as e:
        return False, str(e)


def apply_file(path, dry=False):
    if not os.path.exists(path):
        return f"!! 不存在: {path}"
    src = open(path, "r", encoding="utf-8").read()
    if MARK_S in src:
        return f"-- 已打过补丁 ({len(src)} chars)"
    out = src
    notes = []

    if out.count(CFG_OLD) != 1:
        return f"!! updateConfig 锚点命中 {out.count(CFG_OLD)} 次（应为 1）"
    out = out.replace(CFG_OLD, CFG_NEW, 1)
    notes.append("store-chatconfig")

    if out.count(HIST_OLD) != 1:
        return f"!! historyMessages 锚点命中 {out.count(HIST_OLD)} 次（应为 1）"
    out = out.replace(HIST_OLD, HIST_NEW, 1)
    notes.append("trim-history")

    if dry:
        return f"DRY ok ({','.join(notes)}) {len(src)} -> {len(out)}"
    bak = path + ".bak-" + time.strftime("%Y%m%d-%H%M%S") + "-histtrim"
    shutil.copy2(path, bak)
    open(path, "w", encoding="utf-8").write(out)

    ok, err = node_check(path)
    if not ok:
        shutil.copy2(bak, path)
        return f"!! node --check 失败，已还原\n   {err[:300]}"

    after = open(path, "r", encoding="utf-8").read()
    problems = []
    if "this.chatConfig = chatConfig;" not in after:
        problems.append("chatConfig 未保存")
    if "shortenHistoryAssistant" not in after:
        problems.append("剪短函数缺失")
    # 剪短必须真的用在 content 上，而不是定义了没用
    if "message.role === 'assistant'\n                ? shortenHistoryAssistant(message.content)" not in after:
        problems.append("剪短未作用到 content")
    if problems:
        shutil.copy2(bak, path)
        return "!! 断言失败，已还原: " + "; ".join(problems)
    return f"OK ({','.join(notes)}) {len(src)} -> {len(out)} chars  备份={os.path.basename(bak)}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()
    for d in DIRS:
        p = os.path.join(d, "prompt.js")
        print("=" * 70)
        print(p)
        if args.check:
            src = open(p, encoding="utf-8").read() if os.path.exists(p) else ""
            ok, _ = node_check(p)
            print(f"  补丁={MARK_S in src}  node --check={'OK' if ok else 'FAIL'}  chars={len(src)}")
        else:
            print(" ", apply_file(p, args.dry))


if __name__ == "__main__":
    main()
