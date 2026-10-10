#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_decision_private.py -- 决策层支持「私聊专用判据」

问题（2026-10-10）：reply-decision.js 的 DEFAULT_DECISION_PROMPT 是**群聊判据**
（"别人之间的闲聊没点到你""跟你无关的技术问答"）。私聊里你们是熟人，那套判据
会让它把大部分正常接话判成 NO，或者根本没处理"对方在收尾"这种私聊特有的情形。

改法：新增 DEFAULT_PRIVATE_DECISION_PROMPT，decideReply 增加 messageType 参数，
messageType === 'private' 时用私聊判据（可用 chat.replyDecision.promptPrivate 覆盖）。

⚠ 补丁只提供能力，**不打开开关**。`chat.replyDecision.enabled` 保持原值（false）。
  用户之前抱怨过"你有一堆限制根本就没跑起来"，所以默认不启用。

用法:
  python patch_decision_private.py --check
  python patch_decision_private.py
"""
import argparse
import os
import shutil
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

DIRS = [r"C:\Users\20633\MimirLink-soyo\src", r"C:\Users\20633\MimirLink\src"]

MARK_S = "// >>> decision-private patch (managed by patch_decision_private.py) >>>"
MARK_E = "// <<< decision-private patch <<<"

PRIVATE_PROMPT = """
export const DEFAULT_PRIVATE_DECISION_PROMPT = `你在私聊里替一个角色决定：这一条消息，值不值得回。

只输出一个词，不要解释，不要标点：
YES = 回
NO  = 不回

私聊里你们是熟人，大部分话都该回。只有这几种「这一轮没什么可接的」才回 NO：
- 对方只是在收尾（晚安、睡了、明天见、先这样、我走了），把话关掉；
- 对方发的是纯表情或贴图，没有文字要接；
- 对方明显在自言自语、刷屏、连发同一类东西；
- 你上一条已经说过要去睡了或要走了，对方只是随手再补一句；
- 极短、没有信息量、像打错字或随手试探（单字、哦、？、aa、1、在吗）。

其余都回 YES：对方在问你、跟你说话、补充或纠正刚才的话题、吐槽、调侃你，
或者话题跟你有关。拿不准就回 YES。`;
"""

ANCHOR_PROMPT_END = "极短、没有信息量、像打错字或随手试探的消息（aa、哦、？、单个字、只有一个表情）回 NO。拿不准就回 NO。`;\n"

SIG_OLD = "export async function decideReply({ config = {}, aiClient, logger = console, recentMessages = [], plainText = '', speaker = '' } = {}) {"
SIG_NEW = "export async function decideReply({ config = {}, aiClient, logger = console, recentMessages = [], plainText = '', speaker = '', messageType = '' } = {}) {"

PROMPT_LINE_OLD = "    const prompt = `${text(cfg.prompt) || DEFAULT_DECISION_PROMPT}\\n\\n【最近几条】\\n${buildDecisionContext(recentMessages, plainText)}\\n${speaker ? `\\n【发言人】${speaker}` : ''}`;"
PROMPT_LINE_NEW = (MARK_S + "\n"
                   "    // 私聊与群聊的判据不同：群聊要判断「这条闲话点没点到我」，\n"
                   "    // 私聊要判断「这一句还有没有可接的」。默认改判据，promptPrivate 可覆盖。\n"
                   "    const isPrivateChat = String(messageType) === 'private';\n"
                   "    const judgePrompt = isPrivateChat\n"
                   "        ? (text(cfg.promptPrivate) || DEFAULT_PRIVATE_DECISION_PROMPT)\n"
                   "        : (text(cfg.prompt) || DEFAULT_DECISION_PROMPT);\n"
                   + MARK_E + "\n"
                   "    const prompt = `${judgePrompt}\\n\\n【最近几条】\\n${buildDecisionContext(recentMessages, plainText)}\\n${speaker ? `\\n【发言人】${speaker}` : ''}`;")


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
    out = src
    notes = []

    if MARK_S in out:
        return f"-- 已打过补丁 ({len(src)} chars)"

    # 1) 新增私聊判据常量
    if out.count(ANCHOR_PROMPT_END) != 1:
        return f"!! 群聊判据结尾锚点命中 {out.count(ANCHOR_PROMPT_END)} 次（应为 1）"
    out = out.replace(ANCHOR_PROMPT_END, ANCHOR_PROMPT_END + PRIVATE_PROMPT, 1)
    notes.append("private-prompt")

    # 2) 函数签名加 messageType
    if out.count(SIG_OLD) != 1:
        return f"!! 签名锚点命中 {out.count(SIG_OLD)} 次（应为 1）"
    out = out.replace(SIG_OLD, SIG_NEW, 1)
    notes.append("sig")

    # 3) 按消息类型选判据
    if out.count(PROMPT_LINE_OLD) != 1:
        return f"!! prompt 行锚点命中 {out.count(PROMPT_LINE_OLD)} 次（应为 1）"
    out = out.replace(PROMPT_LINE_OLD, PROMPT_LINE_NEW, 1)
    notes.append("select")

    if dry:
        return f"DRY ok ({','.join(notes)}) {len(src)} -> {len(out)}"
    bak = path + ".bak-" + time.strftime("%Y%m%d-%H%M%S") + "-decisionpriv"
    shutil.copy2(path, bak)
    open(path, "w", encoding="utf-8").write(out)

    ok, err = node_check(path)
    if not ok:
        shutil.copy2(bak, path)
        return f"!! node --check 失败，已还原\n   {err[:300]}"

    after = open(path, "r", encoding="utf-8").read()
    problems = []
    if "DEFAULT_PRIVATE_DECISION_PROMPT" not in after:
        problems.append("私聊判据常量缺失")
    if "messageType = ''" not in after:
        problems.append("签名未加 messageType")
    if after.count("const judgePrompt") != 1:
        problems.append("judgePrompt 选择逻辑异常")
    # 判据选择必须发生在 prompt 拼接之前，否则等于没换
    if after.find("const judgePrompt") > after.find("${judgePrompt}") and after.find("${judgePrompt}") >= 0:
        pass  # judgePrompt 定义在前，使用在后，正常
    if after.find("const judgePrompt") > after.find("const prompt = `"):
        problems.append("judgePrompt 在 prompt 之后定义（不生效）")
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
        p = os.path.join(d, "reply-decision.js")
        print("=" * 70)
        print(p)
        if args.check:
            src = open(p, encoding="utf-8").read() if os.path.exists(p) else ""
            ok, err = node_check(p)
            print(f"  补丁={MARK_S in src}  node --check={'OK' if ok else 'FAIL'}  chars={len(src)}")
        else:
            print(" ", apply_file(p, args.dry))


if __name__ == "__main__":
    main()
