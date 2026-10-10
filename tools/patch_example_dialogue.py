#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_example_dialogue.py -- 把卡的示例对话（mes_example）当**真实对话轮次**注入

来源（2026-10-10，用户："去 git 上找一下有没有办法"）：
  SillyTavern 官方角色卡文档明确写着两件事：
    1. "The model is more likely to pick up the style and length constraints from
       the first message than anything else."  ← 已做（first_mes）
    2. 示例对话（Example dialogue）会按 {{char}}:/{{user}}: 的格式被**当成真实对话
       轮次**塞进 prompt，是社区公认最有效的风格示范手段。多个排障指南也把
       "AI 不像那个角色" 的首选对策写成"补 3~5 组具体示例对话"。

  而 MimirLink **完全不用 mes_example**（它不在 runtimeSources 里，我实测确认过）。
  所以卡片写了示例也白写。

改法：在 prompt.js 的 build() 里，按 ST 约定解析 mes_example（`<START>` 分块、
`{{user}}:`/`{{char}}:` 标记说话人），作为真实 role 消息插到历史之前。
放在历史之前是 ST 的标准位置，语义干净（不会被误当成最近聊天）。

⚠ 示例轮次是直接 push 进 messages 的，不经过 buildRuntimeComposition 的历史，
  所以**不会被 history-assistant-trim 剪短** —— 这正是我们要的（范例要保持原样）。

开关：chat.exampleDialogue（默认 true）。

用法:
  python patch_example_dialogue.py --check
  python patch_example_dialogue.py
"""
import argparse
import os
import shutil
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

DIRS = [r"C:\Users\20633\MimirLink-soyo\src", r"C:\Users\20633\MimirLink\src"]

MARK = "// >>> example-dialogue patch (managed by patch_example_dialogue.py) >>>"
MARK_E = "// <<< example-dialogue patch <<<"

PARSER_ANCHOR = """    static normalizePromptBoolean(value, fallback = false) {"""
PARSER_NEW = """    """ + MARK + """
    /**
     * 解析 SillyTavern 的示例对话（mes_example）。
     * 约定：`<START>` 分块；块内每行以 `{{user}}:` 或 `{{char}}:` 开头。
     * @returns {Array<{role:'user'|'assistant', content:string}>}
     */
    static parseExampleDialogue(text) {
        const raw = typeof text === 'string' ? text : '';
        if (!raw.trim()) return [];
        const turns = [];
        for (const block of raw.split(/<START>/i)) {
            for (const line of block.split(/\\r?\\n/)) {
                const s = line.trim();
                if (!s) continue;
                const m = s.match(/^\\{\\{\\s*(user|char)\\s*\\}\\}\\s*[:：]?\\s*(.+)$/i);
                if (!m) continue;
                const content = m[2].trim();
                if (!content) continue;
                turns.push({ role: m[1].toLowerCase() === 'user' ? 'user' : 'assistant', content });
            }
        }
        return turns;
    }
    """ + MARK_E + """

""" + PARSER_ANCHOR

INJECT_ANCHOR = """        for (let index = 0; index < composition.historyMessages.length; index += 1) {
            const message = composition.historyMessages[index];
            messages.push({ role: message.role, content: message.content, meta: message.meta });
            appendHistoryInjectionSegments(index + 1);
        }"""

INJECT_NEW = """        """ + MARK + """
        // 示例对话按 ST 的标准位置放在历史之前：让模型在上下文里"看到"角色怎么说话。
        // 指令永远打不过示例，这是 SillyTavern 官方文档的原话。
        const exampleTurns = ((this.chatConfig || {}).exampleDialogue === false)
            ? []
            : PromptBuilder.parseExampleDialogue(character.mes_example);
        if (exampleTurns.length > 0) {
            this.logger?.debug?.(`[提示词] 注入示例对话 ${exampleTurns.length} 轮`);
            for (const turn of exampleTurns) {
                messages.push({
                    role: turn.role,
                    content: turn.content,
                    meta: { source: 'example_dialogue' }
                });
            }
        }
        """ + MARK_E + """

""" + INJECT_ANCHOR


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
    if MARK in src:
        return f"-- 已打过补丁 ({len(src)} chars)"
    out = src
    notes = []
    for name, old, new in (("parser", PARSER_ANCHOR, PARSER_NEW), ("inject", INJECT_ANCHOR, INJECT_NEW)):
        if out.count(old) != 1:
            return f"!! [{name}] 锚点命中 {out.count(old)} 次（应为 1）"
        out = out.replace(old, new, 1)
        notes.append(name)
    if dry:
        return f"DRY ok ({','.join(notes)}) {len(src)} -> {len(out)}"
    bak = path + ".bak-" + time.strftime("%Y%m%d-%H%M%S") + "-exdia"
    shutil.copy2(path, bak)
    open(path, "w", encoding="utf-8").write(out)
    ok, err = node_check(path)
    if not ok:
        shutil.copy2(bak, path)
        return f"!! node --check 失败，已还原\n   {err[:300]}"
    after = open(path, "r", encoding="utf-8").read()
    problems = []
    if "parseExampleDialogue" not in after:
        problems.append("解析函数缺失")
    if "example_dialogue" not in after:
        problems.append("注入标记缺失")
    # 注入必须发生在历史循环之前
    if after.find("const exampleTurns") > after.find("for (let index = 0; index < composition.historyMessages.length"):
        problems.append("示例注入在历史循环之后（位置不对）")
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
            print(f"  补丁={MARK in src}  node --check={'OK' if ok else 'FAIL'}  chars={len(src)}")
        else:
            print(" ", apply_file(p, args.dry))


if __name__ == "__main__":
    main()
