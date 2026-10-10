#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_keyword_recall.py -- 让素世/爱音真的能想起私聊里说过的事

用户（2026-10-10 14:02）：「素食记不到我和她的私聊内容」

排查结论（**不是管道断了，是召回一直是死的**）：
  1. 私聊上下文本身健康：13:58 那轮 recentMessages=42、summaries=4、worldBook=4，
     提示词 167 条消息。摘要也在正常渲染。
  2. 旧原文被删是**设计如此**：`session.js:1513`
         for (const message of sourceMessages) this.statements.deleteMessagesByIds.run(...)
     每生成一条摘要就删掉被摘要的 50 条原始消息。素世私聊 4 条摘要 × 50 = 200 条
     （实测：`private:2063362809` 只剩 44 条，11:18 起；11:45:42 生成过一次 sourceCount=50）。
     覆盖没有缺口（200 + 44 = 244），丢的是**逐字细节**。
  3. 🔴 但逐字细节**其实还在库里**：`memory_entries` 有 244 条逐字副本
     （实测：其中 200 条的 source_message_id 已从 messages 表消失，但 entry 本身在）。
     这是唯一能捞回细节的通道 —— 而它坏了：

     `session.js` recallMemory:
         const matchedEntries = query ? this.searchMemoryEntries(namespaceOptions, query, ...) : [];
     而 searchMemoryEntries 是 `content LIKE '%${query}%'`，
     **query 是整段带结构化头的原文**（472 字符，含 `[私聊|QQ:...|messageSegments:[{...}]]`）
     ⇒ 实测命中 **0 条**，与生产日志 `matchedCount: 0` 完全一致。

     更糟的是 `buildKeywordsFromText(query, 8)` 只取**前 8 个词**，
     而前 8 个词全被消息头占满：
         实测 = ["私聊","qq","2063362809","昵称","werwer","群号","群名","时间"]
     ⇒ 打分用的 keywordHits 也全是噪音。

  实测对比（用生产环境真实 query，474 字符）：
     整段当 LIKE 模式           -> 0 条
     改成逐关键词搜              -> 14 条

修法：
  A) session.js 加 `stripStructuredHeaders()` + `buildRecallKeywords()` +
     `searchMemoryEntriesByKeywords()`，把 recallMemory 里的整段 LIKE 换成逐关键词 OR 检索；
     关键词抽取**先剥掉 `[...]` / `{...}` 头**（含嵌套的 messageSegments），
     中文取整串（>8 字再补 2-gram），英文词 >=3 字，丢纯数字与停用词。
  B) 配置侧把逐字窗口放大（原文比摘要可靠得多）：
       chat.historyLimit         60  -> 100
       memory.summary.triggerMessages 80  -> 100
       memory.summary.keepRecent      30  -> 50
     效果：逐字窗口 30~80 条 -> 50~100 条；摘要每条覆盖 50 条、最多 8 条。
     （getContext 拉取上限 = min(max(limit*4,50),400)，100*4=400 仍在范围内）

开关：无。改完必须重启（src/ 改动不会热加载）。

用法:
  python patch_keyword_recall.py --check
  python patch_keyword_recall.py
  python patch_keyword_recall.py --revert
"""
import argparse
import json
import os
import shutil
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

SRC_DIRS = [r"C:\Users\20633\MimirLink-soyo\src", r"C:\Users\20633\MimirLink\src"]
CFG_FILES = [r"C:\Users\20633\MimirLink-soyo\config.json", r"C:\Users\20633\MimirLink\config.json"]

M_S = "// >>> keyword-recall patch (managed by patch_keyword_recall.py) >>>"
M_E = "// <<< keyword-recall patch <<<"

# 🔴 硬规则：--check 必须先折成 dry，在任何写入之前生效（本项目踩过 3 次）
DRY = False


def _write(path, text):
    if DRY:
        return False
    open(path, "w", encoding="utf-8", newline="\n").write(text)
    return True


def _backup(path, tag):
    if DRY:
        return None
    dst = path + ".bak-" + time.strftime("%Y%m%d-%H%M%S") + "-" + tag
    shutil.copy2(path, dst)
    return dst

# ---------------------------------------------------------------- 锚点
A1_ANCHOR = "    recallMemory(namespaceOptions, query, options = {}) {"

A2_OLD = """        const recentEntries = this.listRecentMemoryEntries(namespaceOptions, recentLimit);
        const matchedEntries = query ? this.searchMemoryEntries(namespaceOptions, query, searchLimit) : [];"""
A2_NEW = """        const recentEntries = this.listRecentMemoryEntries(namespaceOptions, recentLimit);
        // >>> keyword-recall patch (managed by patch_keyword_recall.py) >>>
        // 原来是把整段带结构化头的原文当 LIKE 模式 ⇒ 永远 0 命中（实测）。
        // 改成先剥头抽词，再逐关键词 OR 检索。
        const recallKeywords = this.buildRecallKeywords(query, 16);
        const matchedEntries = query
            ? (recallKeywords.length > 0
                ? this.searchMemoryEntriesByKeywords(namespaceOptions, recallKeywords, searchLimit)
                : this.searchMemoryEntries(namespaceOptions, query, searchLimit))
            : [];
        // <<< keyword-recall patch <<<"""

A3_OLD = "        const queryKeywords = this.buildKeywordsFromText(query, 8);"
A3_NEW = ("        // keyword-recall patch: 打分也用剥头后的关键词，否则全是「私聊/qq/昵称/时间」\n"
          "        const queryKeywords = recallKeywords.length > 0\n"
          "            ? recallKeywords\n"
          "            : this.buildKeywordsFromText(query, 8);")

# 插到 recallMemory 前面的两个新方法
METHODS = M_S + """
    /** 剥掉结构化消息头 / JSON 段，只留用户真正打的字。
     *  头里嵌了 `messageSegments:[{...}]`，所以要**反复**剥最内层，不能一次正则搞定。 */
    stripStructuredHeaders(text = '') {
        let s = String(text || '');
        let prev = null;
        let rounds = 0;
        while (prev !== s && rounds < 20) {
            prev = s;
            s = s.replace(/\\[[^\\[\\]]*\\]/g, ' ').replace(/\\{[^{}]*\\}/g, ' ');
            rounds += 1;
        }
        return s.replace(/\\s+/g, ' ').trim();
    }

    /** 召回关键词：剥头 -> 中文串(>8字补 2-gram) + 英文词(>=3字) -> 去数字/停用词。 */
    buildRecallKeywords(text = '', limit = 16) {
        const STOP = new Set([
            '私聊', '群聊', '昵称', '群号', '群名', '时间', '什么', '怎么', '为什么',
            '这个', '那个', '可以', '但是', '因为', '所以', '然后', '还是', '就是',
            '没有', '不是', '一个', '现在', '时候', '感觉', '觉得', '知道', '我们',
            '你们', '他们', '自己', '已经', '应该', '可能', '真的', '有点', '而且'
        ]);
        const cleaned = this.stripStructuredHeaders(text).toLowerCase();
        const out = [];
        const push = (word) => {
            const w = String(word || '').trim();
            if (!w || out.length >= limit || out.includes(w) || STOP.has(w)) return;
            out.push(w);
        };
        for (const run of (cleaned.match(/[\\u4e00-\\u9fa5]{2,}/g) || [])) {
            if (run.length <= 8) push(run);
            if (run.length > 4) {
                for (let i = 0; i + 2 <= run.length; i += 1) push(run.slice(i, i + 2));
            }
        }
        for (const word of (cleaned.match(/[a-z][a-z0-9]{2,}/g) || [])) push(word);
        return out;
    }

    /** 逐关键词检索后按命中数合并（OR 语义），替代「整段原文当 LIKE 模式」。 */
    searchMemoryEntriesByKeywords(namespaceOptions, keywords, limit = 4) {
        const list = Array.isArray(keywords) ? keywords : [];
        if (list.length === 0) return [];
        const merged = new Map();
        for (const keyword of list) {
            let rows = [];
            try {
                rows = this.searchMemoryEntries(namespaceOptions, keyword, Math.max(limit * 3, 8));
            } catch (error) {
                this.logger?.warn?.('[记忆] 关键词召回失败', { keyword, error: error.message });
                continue;
            }
            for (const entry of rows) {
                const hit = merged.get(entry.id);
                if (hit) hit.hits += 1;
                else merged.set(entry.id, { entry, hits: 1 });
            }
        }
        return Array.from(merged.values())
            .sort((a, b) => (b.hits - a.hits) || ((b.entry.createdAt || 0) - (a.entry.createdAt || 0)))
            .slice(0, limit)
            .map((item) => item.entry);
    }
""" + M_E + "\n\n"

# ---------------------------------------------------------------- 配置
CFG_PLAN = [
    (["chat", "historyLimit"], 100, 60),
    (["memory", "summary", "triggerMessages"], 100, 80),
    (["memory", "summary", "keepRecent"], 50, 30),
]


def patch_file(path, revert=False):
    src = open(path, encoding="utf-8").read()
    info = {"path": path, "changed": False, "notes": []}

    if revert:
        if M_S not in src:
            info["notes"].append("没有补丁标记，跳过")
            return info
        out = src
        i = out.find(M_S)
        j = out.find(M_E)
        out = out[:i] + out[j + len(M_E) + 2:]
        # 只还原 A2（A3 的注释行跟着一起回退）
        out = out.replace(A2_NEW, A2_OLD, 1)
        out = out.replace(A3_NEW, A3_OLD, 1)
        _backup(path, "kwrecall-revert")
        _write(path, out)
        info["changed"] = True
        return info

    if M_S in src:
        info["notes"].append("已打过补丁")
        return info

    for name, anchor, want in (("A1", A1_ANCHOR, 1), ("A2", A2_OLD, 1), ("A3", A3_OLD, 1)):
        got = src.count(anchor)
        if got != want:
            info["notes"].append(f"{name} 锚点={got}(期望{want})")
    if info["notes"]:
        return info

    out = src.replace(A1_ANCHOR, METHODS + A1_ANCHOR, 1)
    out = out.replace(A2_OLD, A2_NEW, 1)
    out = out.replace(A3_OLD, A3_NEW, 1)
    _backup(path, "kwrecall")
    if not _write(path, out):
        info["notes"].append("dry-run：未写入")
        info["changed"] = True
        return info

    back = open(path, encoding="utf-8").read()
    probs = []
    for need in (M_S, M_E, "stripStructuredHeaders(text = '')",
                 "buildRecallKeywords(text = '', limit = 16)", "searchMemoryEntriesByKeywords",
                 A2_NEW, A3_NEW):
        if need not in back:
            probs.append(f"缺失: {need[:40]}")
    if "searchMemoryEntries(namespaceOptions, query, searchLimit) : [];" in back:
        probs.append("A2 未替换")
    info["changed"] = not probs
    info["notes"].extend(probs)
    return info


def patch_config(path, revert=False):
    cfg = json.load(open(path, encoding="utf-8"))
    info = {"path": path, "changed": False, "notes": []}
    for keys, new_val, old_val in CFG_PLAN:
        node = cfg
        for k in keys[:-1]:
            node = node.setdefault(k, {})
        cur = node.get(keys[-1])
        target = old_val if revert else new_val
        if cur == target:
            continue
        node[keys[-1]] = target
        info["notes"].append(f"{'.'.join(keys)}: {cur} -> {target}")
        info["changed"] = True
    if info["changed"]:
        _backup(path, "recalldb")
        if DRY:
            return info
        json.dump(cfg, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    return info


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    ap.add_argument("--skip-config", action="store_true")
    args = ap.parse_args()
    global DRY
    DRY = bool(args.check)

    for d in SRC_DIRS:
        p = os.path.join(d, "session.js")
        r = patch_file(p, args.revert)
        print(f"[src ] {p}  changed={r['changed']}  {'; '.join(r['notes']) or 'ok'}")

    if not args.skip_config:
        for p in CFG_FILES:
            r = patch_config(p, args.revert)
            print(f"[cfg ] {p}  changed={r['changed']}  {'; '.join(r['notes']) or 'ok'}")

    if args.check:
        print("\n--check：以上为预演，未写入。")
    else:
        print("\n⚠ src/ 改动需要重启实例才生效（不会热加载）。重启脚本：mimir-tools/restart-mimir.ps1")


if __name__ == "__main__":
    main()
