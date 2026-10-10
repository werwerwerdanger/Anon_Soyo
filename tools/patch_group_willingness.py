#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_group_willingness.py -- 群聊意愿 / 表情包断言 / 互怼截断 / 互怼不思考

用户 2026-10-10（一次提了四件事）：
  1. 给表情包加一个回复断言，把回复意愿变低
  2. 两个人在群里互相说话，一轮不能超过 2 句，直接截断
  3. 把思考也停了
  4. 把群里的回复意愿调低
  确认口径：① 群聊恢复但压到最低（只在被 @、或名字出现时才回）
            ② 表情包「基本不回，偶尔应一声」≈ 1/5

实测得到的关键事实（决定了实现方式，不是猜的）：
  · `thinking: {"type":"disabled"}` **真的有效**：思考 91字→0字、
    prompt_tokens 37→11、completion 31→1。（`enable_thinking` 无效，仍返回 65 字思考）
  · `splitReplyIntoSegments` 是 `reply-dispatcher.js` 里的**局部闭包**，没导出
    ⇒ 截断必须加在 `reply-dispatcher.js` 内部，不能在 index.js 做。
  · AI 主调用是 `aiClient.chatWithTools(msgs, toolContext, chatAIOverrides)`
    ⇒ 停思考走 `chatAIOverrides`，比新加参数干净。
  · `isTriggerUser` 只在**群聊分支**被用（index.js:1764）⇒ 清空 triggerUsers 只影响群聊。

四处改动：
  A. index.js  buildRoutingDecision：纯表情包按 chat.stickerReplyChance 概率回
     （@ 她 / 回复她 / 白名单用户 仍然照常回 —— 那是明确被叫到）
     新增 helper `isStickerOnlyMessage`
  B. index.js  群聊分支：`isCoBotTurn = 群聊 && 发言人∈coBotIds` 时
     → 给 chatAIOverrides 加 `thinking:{type:'disabled'}`
     → 给 dispatchReply 传 `isCoBotTurn:true`
  C. reply-dispatcher.js：`isCoBotTurn` 时把回复硬截到 `chat.coBotMaxSentences` 句
  D. ai.js：把 overrides.thinking 透传进 payload
  + 配置：ignoreGroupMessages=false、triggerUsers=[]、
          stickerReplyChance=0.2、coBotMaxSentences=2

用法: python patch_group_willingness.py --check | --dry | (无参) | --revert
"""
import argparse
import io
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

NODE = r"C:\Program Files\nodejs\node.exe"
INSTANCES = ["MimirLink", "MimirLink-soyo"]
ROOTS = [pathlib.Path(r"C:\Users\20633") / n for n in INSTANCES]


def node_check(p):
    try:
        r = subprocess.run([NODE, "--check", p], capture_output=True, text=True, timeout=60)
        return r.returncode == 0, (r.stderr or "").strip()
    except Exception as e:
        return False, str(e)


# ============================================================ A: 表情包断言
A_HELPER_ANCHOR = """// >>> bot-banter-limit patch (managed by patch_bot_banter_limit.py) >>>"""
A_HELPER = """// >>> sticker-assertion patch >>>
// 用户 2026-10-10：「给表情包加一个回复断言把回复意愿变低」。
// 纯表情包（有图无文字）默认低意愿：按 chat.stickerReplyChance 概率决定回不回。
// 判据用 messageSegments（extractMessageInfo 已返回），只认「图/表情 + 占位文字」。
const STICKER_SEG_TYPES = new Set(['image', 'face', 'mface', 'marketface']);

function isStickerOnlyMessage(messageInfo = {}) {
    const segs = Array.isArray(messageInfo.messageSegments) ? messageInfo.messageSegments : [];
    if (!segs.length) return false;
    let hasSticker = false;
    for (const seg of segs) {
        const type = String(seg?.type || '');
        if (STICKER_SEG_TYPES.has(type)) { hasSticker = true; continue; }
        // reply/at/forward 不产生正文，放行
        if (type === 'reply' || type === 'at' || type === 'forward' || type === 'json' || type === 'xml') continue;
        if (type === 'text') {
            const raw = String(seg?.text ?? seg?.data?.text ?? '').trim();
            // 「[图片]」「[动画表情]」这类占位文本不算真文字
            if (raw && !/^\\[[^\\]]{0,10}\\]$/.test(raw)) return false;
            continue;
        }
        return false;
    }
    return hasSticker;
}
// <<< sticker-assertion patch <<<

"""

A_GATE_ANCHOR = """    if (!allowed) {
        return skip('access_denied');
    }
"""
A_GATE = A_GATE_ANCHOR + """
    // >>> sticker-assertion patch >>>
    // 纯表情包低意愿。放在这里 = 群聊/私聊两条路都吃到；
    // 被 @ / 被回复 / 白名单用户仍然照常回（那是明确被叫到，不该被概率挡）。
    if (!isAtMe && !messageInfo.replyToBot && !isTriggerUser(config, event)
        && isStickerOnlyMessage(messageInfo)) {
        const rawChance = Number(config?.chat?.stickerReplyChance);
        const chance = Number.isFinite(rawChance) ? Math.min(1, Math.max(0, rawChance)) : 0.2;
        if (Math.random() >= chance) {
            return skip('sticker_low_willingness');
        }
    }
    // <<< sticker-assertion patch <<<
"""

# ============================================================ B: 互怼不思考 + 传标记
B_ANCHOR = "            const chatAIOverrides = buildChatAIOverrides(config);"
B_NEW = B_ANCHOR + """
            // >>> cobot-turn patch >>>
            // 用户 2026-10-10：两个机器人在群里互相说话时
            //  ① 不思考（thinking disabled —— 实测思考 91字→0字、prompt 37→11 token）
            //  ② 回复硬截断到 chat.coBotMaxSentences 句
            // 判据直接看事件：发言人 ∈ coBotIds 且是群聊。不看 routing，避免和别的分支耦合。
            const coBotTurn = event.message_type === 'group' && isCoBot(config, event);
            if (coBotTurn) {
                chatAIOverrides.thinking = { type: 'disabled' };
                logger.info('[互怼] 本轮按 bot-to-bot 处理：停思考 + 截断到 '
                    + (config.chat?.coBotMaxSentences ?? 2) + ' 句');
            }
            // <<< cobot-turn patch <<<
"""

B_DISPATCH_ANCHOR = """            await dispatchReply(event, replyToSend, { forceSingleMessage: sendReasoningToQQ && !!reasoningContent });"""
B_DISPATCH_NEW = ("""            // >>> cobot-turn patch >>>
            await dispatchReply(event, replyToSend, {
                forceSingleMessage: sendReasoningToQQ && !!reasoningContent,
                isCoBotTurn: coBotTurn === true
            });
            // <<< cobot-turn patch <<<""")

# ============================================================ C: 发送端硬截断
C_ANCHOR = """    const ttsConfig = ttsManager?.getConfig?.() || {};
    const { textParts, hasVoice } = parseVoiceTags(String(processedReply || ''));"""
C_NEW = """    // >>> cobot-truncate patch >>>
    // 用户 2026-10-10：「两个人在群里互相说话一轮不能超过 2 句，直接截断」。
    // 放在最前面（拆段/引用/语音之前），保证后面所有路径看到的都是截断后的文本。
    const coBotCapRaw = Number(config?.chat?.coBotMaxSentences);
    const coBotCap = Number.isFinite(coBotCapRaw) && coBotCapRaw > 0 ? Math.floor(coBotCapRaw) : 0;
    if (options?.isCoBotTurn === true && coBotCap > 0) {
        const rawText = String(processedReply || '');
        // 句末标点或换行都算一句的边界
        const sentences = rawText
            .split(/(?<=[。！？!?])|\\r?\\n+/)
            .map((s) => s.trim())
            .filter(Boolean);
        if (sentences.length > coBotCap) {
            processedReply = sentences.slice(0, coBotCap).join('\\n');
            logger.info(`[互怼] 回复 ${sentences.length} 句 → 截断到 ${coBotCap} 句`);
        }
    }
    // <<< cobot-truncate patch <<<
""" + C_ANCHOR

# ============================================================ D: ai.js 透传 thinking
D1_ANCHOR = """            maxTokens: overrides.maxTokens ?? this.config.maxTokens,
            temperature: overrides.temperature ?? this.config.temperature
        };"""
D1_NEW = """            maxTokens: overrides.maxTokens ?? this.config.maxTokens,
            temperature: overrides.temperature ?? this.config.temperature,
            // >>> cobot-turn patch >>>
            thinking: overrides.thinking
            // <<< cobot-turn patch <<<
        };"""

D2_ANCHOR = """    buildChatPayload(messages, overrides = {}) {
        const options = this.resolveChatOptions(overrides);
        return {
            model: options.model,
            messages,
            max_tokens: options.maxTokens,
            temperature: options.temperature,
            stream: false
        };
    }"""
D2_NEW = """    buildChatPayload(messages, overrides = {}) {
        const options = this.resolveChatOptions(overrides);
        const payload = {
            model: options.model,
            messages,
            max_tokens: options.maxTokens,
            temperature: options.temperature,
            stream: false
        };
        // >>> cobot-turn patch >>>
        // 只在显式要求时带上；实测 deepseek-flash 支持 {type:'disabled'} 关掉思考。
        if (options.thinking) payload.thinking = options.thinking;
        // <<< cobot-turn patch <<<
        return payload;
    }"""


def patch_file(path, pairs, dry, revert, stamp, tag):
    """pairs: [(old, new), ...]，逐个替换；每步都要锚点唯一。"""
    src = open(path, encoding="utf-8").read()
    out = src
    notes = []
    for old, new in pairs:
        # a = 替换成什么，b = 找什么。正向 patch: 找 old 换 new；revert 反过来。
        # ⚠ 第一版写成 `(new, old) if revert else (old, new)` —— 条件反了，
        #    结果正向 patch 变成"找 new 换 old"，锚点全部「未命中」。
        a, b = (new, old) if not revert else (old, new)
        if b not in out:
            notes.append("SKIP(未命中)")
            continue
        if out.count(b) != 1:
            notes.append(f"FAIL(锚点{out.count(b)}次)")
            continue
        out = out.replace(b, a, 1)
        notes.append("ok")
    if out == src:
        return "  " + path + "  -- 无改动 (" + ",".join(notes) + ")"
    if dry:
        return f"  {path}  DRY {len(src)} -> {len(out)}  ({','.join(notes)})"
    bak = path + ".bak-" + stamp + "-" + tag
    shutil.copy2(path, bak)
    open(path, "w", encoding="utf-8", newline="").write(out)
    ok, err = node_check(path)
    if not ok:
        shutil.copy2(bak, path)
        return f"  {path}  !! node --check 失败已还原: {err[:180]}"
    return f"  {path}  OK {len(src)}->{len(out)}  ({','.join(notes)}) 备份={os.path.basename(bak)}"


def patch_config(dry, revert, stamp):
    lines = []
    for root in ROOTS:
        p = root / "config.json"
        raw = p.read_text(encoding="utf-8")
        obj = json.loads(raw)
        chat = obj.setdefault("chat", {})
        target = {
            # 用户选的：群聊恢复但压到最低
            "ignoreGroupMessages": False,
            # 清掉"白名单用户免检"——否则你在群里随便说一句她就回，不是"最低"
            "triggerUsers": [],
            "stickerReplyChance": 0.2,
            "coBotMaxSentences": 2,
        }
        if revert:
            target = {"ignoreGroupMessages": True, "triggerUsers": [2063362809]}
        changed = {k: (chat.get(k), v) for k, v in target.items() if chat.get(k) != v}
        if not changed:
            lines.append(f"  {p}  -- 无需改动")
            continue
        if dry:
            lines.append(f"  {p}  DRY " + "; ".join(f"{k}: {a!r}->{b!r}" for k, (a, b) in changed.items()))
            continue
        for k, (_, v) in changed.items():
            chat[k] = v
        bak = str(p) + ".bak-" + stamp + "-willing"
        shutil.copy2(p, bak)
        p.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
        # 回读
        back = json.loads(p.read_text(encoding="utf-8")).get("chat", {})
        bad = [k for k, v in target.items() if back.get(k) != v]
        if bad:
            shutil.copy2(bak, p)
            lines.append(f"  {p}  !! 回读不符 {bad}，已还原")
            continue
        lines.append(f"  {p}  OK " + "; ".join(f"{k}: {a!r}->{b!r}" for k, (a, b) in changed.items())
                     + f"  备份={os.path.basename(bak)}")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()
    # ⚠ --check 必须在任何写盘之前折进 dry（本项目栽过两次）
    dry = args.dry or args.check
    rev = args.revert
    stamp = time.strftime("%Y%m%d-%H%M%S")

    for root in ROOTS:
        print("=" * 78)
        print(root.name)
        print(" A) index.js 表情包断言")
        print(patch_file(str(root / "src" / "index.js"),
                         [(A_HELPER_ANCHOR, A_HELPER), (A_GATE_ANCHOR, A_GATE)],
                         dry, rev, stamp, "sticker"))
        print(" B) index.js 互怼：停思考 + 传标记")
        print(patch_file(str(root / "src" / "index.js"),
                         [(B_ANCHOR, B_NEW), (B_DISPATCH_ANCHOR, B_DISPATCH_NEW)],
                         dry, rev, stamp, "cobotturn"))
        print(" C) reply-dispatcher.js 硬截断")
        print(patch_file(str(root / "src" / "reply-dispatcher.js"),
                         [(C_ANCHOR, C_NEW)], dry, rev, stamp, "cobottrunc"))
        print(" D) ai.js 透传 thinking")
        print(patch_file(str(root / "src" / "ai.js"),
                         [(D1_ANCHOR, D1_NEW), (D2_ANCHOR, D2_NEW)],
                         dry, rev, stamp, "cobotthink"))

    print("=" * 78)
    print(" E) config.json")
    print(patch_config(dry, rev, stamp))

    if args.check:
        print("\n(--check 只报告，未写入任何文件)")


if __name__ == "__main__":
    main()
