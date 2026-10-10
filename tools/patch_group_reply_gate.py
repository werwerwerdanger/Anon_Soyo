#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_group_reply_gate.py -- 群聊里让模型自己判「这一轮该不该接」，且判不准就不接

用户（2026-10-10 14:32）：
  「群聊里面能不能让ai自己判断一下这轮聊天结束没如果结束了或者说换话题了再不回
    这个回消息弄的保守一点就是感觉有点换话题就开始走平时的静默流程」

### 现状
决策层**早就写好了**，只是没开：`chat.replyDecision.enabled = false`。
`reply-decision.js` 的 `decideReply()` → `{skip, reason}`，`index.js:3454`
`if (decision.skip) { log; return; }` —— 这就是用户说的「平时的静默流程」，已经接好。
失效方向也是对的：任何异常都 `{skip:false}`（照常回复），决策层不会成为"她突然哑了"的原因。

### 但直接打开是不行的，有两个硬伤
1. 🔴 **判定时看不到历史**。`index.js:3444` 传的是
   ```js
   recentMessages: (batch.items || []).map((item) => ({ role: 'user', content: item.structuredText || item.plainText || '' }))
   ```
   只有当前这一批，**而且全标成 `role:'user'`**（机器人自己的上一条不见了）。
   「这一轮结束了没 / 换话题了没」本质是**序列判断**，没有历史就是瞎猜。
   ⇒ 改成传 `context.recentMessages`（3416 行已经取好了，含机器人自己的发言）。
2. 🔴 **`speaker` 恒为空**：`speaker: primary?.structuredText ? '' : ''` —— 三元两边都是空串，
   等于没传。群里有好几个人在说话，判定时必须知道**是谁**。
3. 🔴 **`maxTokens: 4` 会被思维链吃掉**。`overrides` 里没设 `thinking`，
   而 `ai.js:427/443` 是支持 `overrides.thinking` 的。一旦模型先想再答，
   4 个 token 用光 → 拿不到 YES/NO → `parseDecision` 返回 null → **失败放行**
   ⇒ 闸门**静默失效**，而且日志里只会看到一句 warn。
   ⇒ 钉死 `thinking: { type: 'disabled' }`。

### 本补丁
- `reply-decision.js`
  · 群聊判据换成**保守版**：默认 NO；「这轮要收尾」「话题已经换了」「别人之间的对话」
    一律 NO；明确写「觉得话题从你身上移开就立刻回 NO，不要接一句留住话头」
  · 新增 `scope`（默认 `group`）：只判群聊，私聊不碰（用户要的是群聊）
  · `buildDecisionContext` 重写：**剥掉 `[群聊|QQ:…]` 结构化头**、带上**发言人昵称**、
    历史 6 条 → 10 条、正文 200 → 160 字（够判断，且省 token）
  · `overrides.thinking = { type: 'disabled' }`（保住那 4 个 token）
- `index.js`：传真实历史 + 真实发言人
- `config.json`：`replyDecision = { enabled: true, scope: 'group', maxTokens: 4, minChars: 1 }`

### 成本
每条**已经通过路由**的群消息多一次小调用（输入约 1~2k token，输出 4 token）。
判 NO 会省掉后面两次大调用（整段提示词 2 万+ token）⇒ 群里闲话多时是净赚。

用法:
  python patch_group_reply_gate.py --check
  python patch_group_reply_gate.py
  python patch_group_reply_gate.py --revert
"""
import argparse
import json
import os
import re
import shutil
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

DIRS = [r"C:\Users\20633\MimirLink-soyo", r"C:\Users\20633\MimirLink"]

M = "// >>> group-reply-gate patch (managed by patch_group_reply_gate.py) >>>"
ME = "// <<< group-reply-gate patch <<<"

DRY = False


def _backup(path, tag):
    if DRY or not os.path.exists(path):
        return None
    dst = path + ".bak-" + time.strftime("%Y%m%d-%H%M%S") + "-" + tag
    shutil.copy2(path, dst)
    return dst


def _write(path, text):
    if DRY:
        return False
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return True


# ---------------------------------------------------------------- reply-decision.js
NEW_GROUP_PROMPT = '''export const DEFAULT_DECISION_PROMPT = `你在替一个群里的角色决定：**这一轮我该不该开口**。

只输出一个词，不要解释、不要标点：
YES = 回
NO  = 不回

默认是 NO。宁可少说一句，也不要为了刷存在感硬接一句。
只有下面这些才回 YES：
- 有人直接点了你的名字、@ 了你、或者直接问你；
- 有人在跟你说话，是接着你上一条在说；
- 话题就是你 —— 在议论你、夸你、损你、拿你开玩笑；
- 你被挑衅、被骂，或者你该替谁出面（有人被欺负了）。

出现下面任何一条就回 NO：
- **这一轮要收尾了**：对方在收（好 / 行 / 就这样 / 睡了 / 晚安 / 明天见 / 嗯 / 哦 / ？），
  或者上一句已经把话说完，或者同一件事你上一条已经回应过；
- **话题已经换了**：现在聊的事、聊的人跟刚才不是一拨，或者明显没你什么事。
  只要你感觉话题从你身上移开了，就立刻回 NO —— 不要接一句来留住这个话头；
- 是别人之间的对话，只是碰巧提到了某个词；
- 纯表情包 / 贴图 / 复读 / 刷屏 / 广告 / 系统消息 / 机器人自己的输出 / 跟你无关的技术问答；
- 极短、没有信息量、像打错字或随手试探（单个字、哦、？、aa、1）。

拿不准就回 NO。`;

'''

NEW_CONTEXT_FN = '''const DECISION_HEADER_RE = /\\[(群聊|私聊)\\|QQ:([^|\\]]*)\\|昵称:([^|\\]]*)\\|/;

/** 剥掉结构化消息头 / JSON 段。头里嵌了 messageSegments:[{...}]，所以要反复剥最内层。 */
export function stripStructuredHeader(raw) {
    let s = text(raw);
    let prev = null;
    let rounds = 0;
    while (prev !== s && rounds < 20) {
        prev = s;
        s = s.replace(/\\[[^\\[\\]]*\\]/g, ' ').replace(/\\{[^{}]*\\}/g, ' ');
        rounds += 1;
    }
    return s.replace(/\\s+/g, ' ').trim();
}

/** 从结构化头里取发言人昵称（群里有好几个人，判定时必须分得清谁在说）。 */
function decisionSpeakerName(raw) {
    const m = DECISION_HEADER_RE.exec(text(raw));
    return m ? text(m[3]) : '';
}

function decisionContentText(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
        return value.filter((p) => p?.type === 'text').map((p) => p.text).join(' ');
    }
    return '';
}

/**
 * 把最近的对话压成一段短文本。
 * 「这一轮结束了没 / 换话题了没」是**序列判断** —— 没有历史就只能瞎猜，
 * 所以这里必须带上下文，并且标出说话人。
 */
export function buildDecisionContext(recentMessages = [], plainText = '', limit = 10) {
    const lines = [];
    const list = Array.isArray(recentMessages) ? recentMessages : [];
    for (const message of list.slice(-limit)) {
        const raw = text(decisionContentText(message?.content));
        if (!raw) continue;
        const body = stripStructuredHeader(raw).slice(0, 160);
        if (!body) continue;
        if (message?.role === 'assistant') {
            lines.push(`我: ${body}`);
        } else {
            lines.push(`${decisionSpeakerName(raw) || '某人'}: ${body}`);
        }
    }
    const now = stripStructuredHeader(plainText).slice(0, 300);
    if (now) {
        lines.push(`【刚进来的这条】${decisionSpeakerName(plainText) || '某人'}: ${now}`);
    }
    return lines.join('\\n');
}

'''

SCOPE_ANCHOR = """    const cfg = config.chat?.replyDecision || {};
    if (cfg.enabled !== true) return { skip: false, reason: 'disabled', raw: '' };
"""
SCOPE_NEW = SCOPE_ANCHOR + """
    """ + M + """
    // scope: 'group'（默认）只判群聊，私聊不碰；'all' 连私聊一起判。
    const decisionScope = String(cfg.scope || 'group').toLowerCase();
    if (decisionScope !== 'all' && String(messageType) !== 'group') {
        return { skip: false, reason: 'scope:' + decisionScope, raw: '' };
    }
    """ + ME + "\n"

PROMPT_LINE_OLD = ("    const prompt = `${judgePrompt}\\n\\n【最近几条】\\n"
                   "${buildDecisionContext(recentMessages, plainText)}\\n"
                   "${speaker ? `\\n【发言人】${speaker}` : ''}`;")
PROMPT_LINE_NEW = M + """
    const prompt = `${judgePrompt}\\n\\n【前面的对话（越靠下越新）】\\n`
        + `${buildDecisionContext(recentMessages, plainText)}\\n`
        + `${speaker ? `\\n【正在说话的人】${speaker}` : ''}`;
    """ + ME

OVERRIDES_OLD = """    const overrides = {
        maxTokens: clampInt(cfg.maxTokens, 1, 64, 4),
        temperature: 0,
        allowModelFallback: false
    };"""
OVERRIDES_NEW = M + """
    const overrides = {
        maxTokens: clampInt(cfg.maxTokens, 1, 64, 4),
        temperature: 0,
        allowModelFallback: false,
        // 🔴 必须关掉思维链：4 个 token 一旦被推理吃掉就拿不到 YES/NO，
        //    parseDecision 返回 null ⇒ 走「失败放行」⇒ 闸门**静默失效**。
        thinking: { type: 'disabled' }
    };
    """ + ME


# ---------------------------------------------------------------- 决策调用自带超时
M2 = "// >>> decision-timeout patch (managed by patch_group_reply_gate.py) >>>"
M2E = "// <<< decision-timeout patch <<<"

DT_OLD = """    try {
        const result = await aiClient.chat([{ role: 'user', content: prompt }], overrides);
        const raw = text(aiClient.getVisibleResponseContent(result));"""
DT_NEW = """    try {
        """ + M2 + """
        // 决策调用在 index.js 里**没有**被 callWithTimeout 包住（实测 src/ai.js 里
        // 根本没用到 config.ai.timeout）⇒ 请求一挂就拖住整轮回复，fail-open 也来不及生效。
        // 自己加一道上限，超时抛 AI_TIMEOUT，走下面的 catch ⇒ 按「回」处理。
        const decisionTimeoutMs = clampInt(cfg.timeoutMs, 500, 60000, 8000);
        const result = await Promise.race([
            aiClient.chat([{ role: 'user', content: prompt }], overrides),
            new Promise((_, reject) => setTimeout(
                () => reject(new Error('AI_TIMEOUT')), decisionTimeoutMs))
        ]);
        """ + M2E + """
        const raw = text(aiClient.getVisibleResponseContent(result));"""


def patch_decision_timeout(path, revert=False):
    src = open(path, encoding="utf-8").read()
    info = {"path": path, "notes": [], "changed": False}
    if revert:
        if M2 not in src:
            info["notes"].append("没有超时补丁标记")
            return info
        _backup(path, "grpgate-torevert")
        _write(path, src.replace(DT_NEW, DT_OLD, 1))
        info["changed"] = True
        return info
    if M2 in src:
        info["notes"].append("超时补丁已在")
        return info
    if src.count(DT_OLD) != 1:
        info["notes"].append(f"超时锚点={src.count(DT_OLD)}")
        return info
    _backup(path, "grpgate-to")
    if not _write(path, src.replace(DT_OLD, DT_NEW, 1)):
        info["notes"].append("dry-run：未写入")
        info["changed"] = True
        return info
    back = open(path, encoding="utf-8").read()
    probs = []
    for need in (M2, M2E, "decisionTimeoutMs", "Promise.race", "clampInt(cfg.timeoutMs"):
        if need not in back:
            probs.append(f"缺失: {need}")
    info["changed"] = not probs
    info["notes"].extend(probs or ["ok"])
    return info


# ---------------------------------------------------------------- index.js
IDX_HIST_OLD = """                        recentMessages: (batch.items || []).map((item) => ({
                            role: 'user',
                            content: item.structuredText || item.plainText || ''
                        })),"""
IDX_HIST_NEW = """                        // >>> group-reply-gate patch (managed by patch_group_reply_gate.py) >>>
                        // 原来只传当前这批、且全标成 user
                        // ⇒ 判「这轮结束没/换话题没」时看不到任何历史，等于瞎猜。
                        // 改成传真实会话历史（含机器人自己上一条）。
                        recentMessages: (context?.recentMessages || []).map((item) => ({
                            role: item.role === 'assistant' ? 'assistant' : 'user',
                            content: item.content || ''
                        })),
                        // <<< group-reply-gate patch <<<"""

IDX_SPK_OLD = "                        speaker: primary?.structuredText ? '' : '',"
IDX_SPK_NEW = ("                        // group-reply-gate patch: 原来是 `primary?.structuredText ? '' : ''`\n"
               "                        // ⇒ 恒为空串，判定时不知道是谁在说话。\n"
               "                        speaker: primary?.event?.sender?.card\n"
               "                            || primary?.event?.sender?.nickname\n"
               "                            || '',\n"
               "                        // <<< group-reply-gate patch <<<")


def patch_reply_decision(path, revert=False):
    src = open(path, encoding="utf-8").read()
    info = {"path": path, "notes": [], "changed": False}

    if revert:
        if M not in src:
            info["notes"].append("没有补丁标记")
            return info
        out = src
        out = out.replace(SCOPE_NEW, SCOPE_ANCHOR, 1)
        out = out.replace(PROMPT_LINE_NEW, PROMPT_LINE_OLD, 1)
        out = out.replace(OVERRIDES_NEW, OVERRIDES_OLD, 1)
        # 提示词与上下文函数：按 span 还原（从备份取）
        baks = sorted([f for f in os.listdir(os.path.dirname(path))
                       if f.startswith(os.path.basename(path) + ".bak-") and f.endswith("-grpgate")])
        if not baks:
            info["notes"].append("找不到 grpgate 备份，提示词/上下文未还原")
        else:
            old = open(os.path.join(os.path.dirname(path), baks[-1]), encoding="utf-8").read()
            out = _span_replace_from(out, old, "export const DEFAULT_DECISION_PROMPT = ",
                                     "\nexport const DEFAULT_PRIVATE_DECISION_PROMPT")
            out = _span_replace_from(out, old, "export function buildDecisionContext(",
                                     "\nexport function parseDecision(")
        _backup(path, "grpgate-revert")
        _write(path, out)
        info["changed"] = True
        info["notes"].append("已还原")
        return info

    if M in src:
        info["notes"].append("已打过补丁")
        return info

    # 锚点检查
    if src.count(SCOPE_ANCHOR) != 1:
        info["notes"].append(f"SCOPE 锚点={src.count(SCOPE_ANCHOR)}")
    if src.count(PROMPT_LINE_OLD) != 1:
        info["notes"].append(f"PROMPT 行锚点={src.count(PROMPT_LINE_OLD)}")
    if src.count(OVERRIDES_OLD) != 1:
        info["notes"].append(f"OVERRIDES 锚点={src.count(OVERRIDES_OLD)}")
    for a, b in (("export const DEFAULT_DECISION_PROMPT = ", "\nexport const DEFAULT_PRIVATE_DECISION_PROMPT"),
                 ("export function buildDecisionContext(", "\nexport function parseDecision(")):
        if src.find(a) < 0 or src.find(b, src.find(a)) < 0:
            info["notes"].append(f"span 锚点缺失: {a[:40]}")
    if info["notes"]:
        return info

    out = src
    out = _span_replace(out, "export const DEFAULT_DECISION_PROMPT = ",
                        "\nexport const DEFAULT_PRIVATE_DECISION_PROMPT", NEW_GROUP_PROMPT)
    out = _span_replace(out, "export function buildDecisionContext(",
                        "\nexport function parseDecision(", NEW_CONTEXT_FN)
    out = out.replace(SCOPE_ANCHOR, SCOPE_NEW, 1)
    out = out.replace(PROMPT_LINE_OLD, PROMPT_LINE_NEW, 1)
    out = out.replace(OVERRIDES_OLD, OVERRIDES_NEW, 1)

    _backup(path, "grpgate")
    if not _write(path, out):
        info["notes"].append("dry-run：未写入")
        info["changed"] = True
        return info

    back = open(path, encoding="utf-8").read()
    probs = []
    for need in (M, ME, "decisionScope", "scope: 'group'", "thinking: { type: 'disabled' }",
                 "export function stripStructuredHeader", "decisionSpeakerName",
                 "【刚进来的这条】", "话题已经换了", "【前面的对话（越靠下越新）】"):
        if need not in back:
            probs.append(f"缺失: {need[:40]}")
    if "const tail = recentMessages.slice(-6);" in back:
        probs.append("旧 buildDecisionContext 未替换")
    # ⚠ 只查「群聊判据」那一段 —— 「这一条消息，值不值得回」在**私聊判据**里也有，
    #    拿整文件 includes 会误报（第一次就误报了）。
    group_span = back[back.find("export const DEFAULT_DECISION_PROMPT = "):
                      back.find("export const DEFAULT_PRIVATE_DECISION_PROMPT")]
    if "这一条消息，值不值得回" in group_span:
        probs.append("旧群聊判据未替换")
    if "拿不准就回 NO" not in group_span:
        probs.append("群聊判据缺「拿不准就回 NO」")
    info["changed"] = not probs
    info["notes"].extend(probs or ["ok"])
    return info


def _span_replace(src, start_marker, end_marker, new_text):
    i = src.find(start_marker)
    if i < 0:
        raise SystemExit(f"!! span start not found: {start_marker[:40]}")
    j = src.find(end_marker, i + len(start_marker))
    if j < 0:
        raise SystemExit(f"!! span end not found: {end_marker[:40]}")
    return src[:i] + new_text + src[j + 1:]


def _span_replace_from(dst, donor, start_marker, end_marker):
    i = dst.find(start_marker)
    j = dst.find(end_marker, i + 1)
    di = donor.find(start_marker)
    dj = donor.find(end_marker, di + 1)
    if min(i, j, di, dj) < 0:
        return dst
    return dst[:i] + donor[di:dj + 1] + dst[j + 1:]


def patch_index(path, revert=False):
    src = open(path, encoding="utf-8").read()
    info = {"path": path, "notes": [], "changed": False}
    if revert:
        if M not in src:
            info["notes"].append("没有补丁标记")
            return info
        out = src.replace(IDX_HIST_NEW, IDX_HIST_OLD, 1).replace(IDX_SPK_NEW, IDX_SPK_OLD, 1)
        _backup(path, "grpgate-revert")
        _write(path, out)
        info["changed"] = True
        return info

    if M in src:
        info["notes"].append("已打过补丁")
        return info
    if src.count(IDX_HIST_OLD) != 1:
        info["notes"].append(f"HIST 锚点={src.count(IDX_HIST_OLD)}")
    if src.count(IDX_SPK_OLD) != 1:
        info["notes"].append(f"SPEAKER 锚点={src.count(IDX_SPK_OLD)}")
    if info["notes"]:
        return info

    out = src.replace(IDX_HIST_OLD, IDX_HIST_NEW, 1).replace(IDX_SPK_OLD, IDX_SPK_NEW, 1)
    _backup(path, "grpgate")
    if not _write(path, out):
        info["notes"].append("dry-run：未写入")
        info["changed"] = True
        return info

    back = open(path, encoding="utf-8").read()
    probs = []
    if "recentMessages: (context?.recentMessages || [])" not in back:
        probs.append("历史未接上")
    if IDX_SPK_OLD in back:
        probs.append("speaker 未改")
    if "primary?.event?.sender?.card" not in back:
        probs.append("speaker 取值缺失")
    info["changed"] = not probs
    info["notes"].extend(probs or ["ok"])
    return info


def patch_config(path, revert=False):
    cfg = json.load(open(path, encoding="utf-8"))
    info = {"path": path, "notes": [], "changed": False}
    ch = cfg.setdefault("chat", {})
    cur = ch.get("replyDecision") or {}
    target = ({"enabled": False, "maxTokens": 4, "minChars": 1} if revert
              else {"enabled": True, "scope": "group", "maxTokens": 4, "minChars": 1})
    if cur == target:
        return info
    ch["replyDecision"] = target
    info["notes"].append(f"replyDecision: {json.dumps(cur, ensure_ascii=False)} -> "
                         f"{json.dumps(target, ensure_ascii=False)}")
    info["changed"] = True
    if DRY:
        return info
    _backup(path, "grpgatecfg")
    json.dump(cfg, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    return info


def main():
    global DRY
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    ap.add_argument("--skip-config", action="store_true")
    args = ap.parse_args()
    DRY = bool(args.check)      # 🔴 --check 先折成 dry，再走任何写入路径

    for d in DIRS:
        rd = os.path.join(d, "src", "reply-decision.js")
        r1 = patch_reply_decision(rd, args.revert)
        print(f"[decision] {d}  changed={r1['changed']}  {'; '.join(r1['notes']) or 'ok'}")
        r1b = patch_decision_timeout(rd, args.revert)
        print(f"[timeout ] {d}  changed={r1b['changed']}  {'; '.join(r1b['notes']) or 'ok'}")
        r2 = patch_index(os.path.join(d, "src", "index.js"), args.revert)
        print(f"[index   ] {d}  changed={r2['changed']}  {'; '.join(r2['notes']) or 'ok'}")
    if not args.skip_config:
        for d in DIRS:
            r = patch_config(os.path.join(d, "config.json"), args.revert)
            print(f"[cfg     ] {d}  changed={r['changed']}  {'; '.join(r['notes']) or 'ok'}")

    print("\n--check：以上为预演，未写入。" if args.check
          else "\n⚠ src/ 改动需要重启才生效。重启：mimir-tools/restart-mimir.ps1")


if __name__ == "__main__":
    main()
