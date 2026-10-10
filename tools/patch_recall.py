#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_recall.py -- 撤回的消息不再进模型

用户需求（2026-10-10）："不要看我输撤回的话"，且要求**本轮剔除 + 历史里也删掉**。
MimirLink 原本完全不处理撤回（代码里的 recall 全是"记忆召回"，无关）。

三条路径：
1. runtime.js   dropBufferedMessage()  —— 还没 flush 的，直接从缓冲里摘掉（精确）；
2. session.js   deleteRecalledMessage() —— 已经入库的：
      · 该行只有这一条消息 ⇒ 整行删除；
      · 一行里合并了多条（20s 窗口下会常见）⇒ 只摘掉撤回那条的正文并更新 id 列表，
        绝不误删同一批里的其他消息；
3. index.js     handleRecallEvent() + notice 分支接线。

开关：chat.recallHandling !== false。

用法:
  python patch_recall.py --check
  python patch_recall.py
"""
import argparse
import os
import shutil
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

DIRS = [r"C:\Users\20633\MimirLink-soyo\src", r"C:\Users\20633\MimirLink\src"]

M_RT = "// >>> recall-drop patch (managed by patch_recall.py) >>>"
M_RT_E = "// <<< recall-drop patch <<<"
M_SS = "// >>> recall-delete patch (managed by patch_recall.py) >>>"
M_SS_E = "// <<< recall-delete patch <<<"
M_IX = "// >>> recall-handling patch (managed by patch_recall.py) >>>"
M_IX_E = "// <<< recall-handling patch <<<"

# ---------------------------------------------------------------- runtime.js
RT_ANCHOR = """    cleanupSeenMessages() {"""
RT_NEW = M_RT + """
    /**
     * 撤回：把还没送进模型的缓冲项摘掉。
     * 20s 静默窗口下，大多数撤回都发生在 flush 之前，这是主路径。
     * @returns {number} 摘掉的条数
     */
    dropBufferedMessage(sessionKey, messageId) {
        const state = this.buffers.get(sessionKey);
        if (!state || !Array.isArray(state.items) || state.items.length === 0) {
            return 0;
        }
        const target = String(messageId === undefined || messageId === null ? '' : messageId).trim();
        if (!target) return 0;
        const before = state.items.length;
        state.items = state.items.filter((item) => {
            const ids = [
                item && item.event ? item.event.message_id : null,
                item && item.standardEvent ? item.standardEvent.messageId : null
            ];
            if (Array.isArray(item && item.standardEvents)) {
                for (const ev of item.standardEvents) {
                    ids.push(ev && ev.messageId);
                }
            }
            return !ids.map((v) => String(v === undefined || v === null ? '' : v)).includes(target);
        });
        const dropped = before - state.items.length;
        if (dropped > 0) {
            this.logger.info?.('[撤回] 已从本轮缓冲中移除', { sessionKey, messageId: target, dropped });
        }
        return dropped;
    }

""" + M_RT_E + """
""" + RT_ANCHOR

# ---------------------------------------------------------------- session.js
SS_ANCHOR = """    deleteSession(sessionId) {
        this.clearSession(sessionId);
    }"""
SS_NEW = """    deleteSession(sessionId) {
        this.clearSession(sessionId);
    }

    """ + M_SS + """
    /**
     * 撤回的消息从历史里清掉。
     * messages.metadata_json 里存了 inboundMessageIds / standardEvents[].messageId，
     * 用 messageId 精确定位；命中多条的合并行只摘撤回那条的正文，不误伤同批其他消息。
     * @returns {{removed:number, stripped:number, error?:string}}
     */
    deleteRecalledMessage(sessionId, inboundMessageId) {
        const target = String(inboundMessageId === undefined || inboundMessageId === null
            ? '' : inboundMessageId).trim();
        if (!sessionId || !target) return { removed: 0, stripped: 0 };
        let rows = [];
        try {
            rows = this.db.prepare(
                'SELECT id, content, metadata_json FROM messages '
                + 'WHERE session_id = ? AND metadata_json LIKE ?'
            ).all(sessionId, '%' + target + '%');
        } catch (error) {
            this.logger?.warn?.(`[撤回] 查询历史失败: ${error.message}`);
            return { removed: 0, stripped: 0, error: error.message };
        }
        const updateStmt = this.db.prepare(
            'UPDATE messages SET content = ?, metadata_json = ? WHERE session_id = ? AND id = ?'
        );
        let removed = 0;
        let stripped = 0;
        for (const row of rows) {
            let meta = null;
            try {
                meta = JSON.parse(row.metadata_json || '{}');
            } catch {
                meta = null;
            }
            if (!meta || typeof meta !== 'object') continue;
            const ids = Array.isArray(meta.inboundMessageIds)
                ? meta.inboundMessageIds.map((v) => String(v)) : [];
            const events = Array.isArray(meta.standardEvents) ? meta.standardEvents : [];
            const evIds = events.map((e) => String(e && e.messageId ? e.messageId : '')).filter(Boolean);
            if (!ids.includes(target) && !evIds.includes(target)) continue;

            if (ids.length <= 1) {
                this.statements.deleteMessagesByIds.run(sessionId, row.id);
                removed += 1;
                continue;
            }

            const recalledTexts = events
                .filter((e) => String(e && e.messageId ? e.messageId : '') === target)
                .map((e) => String((e && (e.rawText || e.contentText)) || '').trim())
                .filter(Boolean);
            let content = String(row.content || '');
            for (const t of recalledTexts) {
                content = content.split(t).join('');
            }
            const leftIds = ids.filter((x) => x !== target);
            const leftEvents = events.filter((e) => String(e && e.messageId ? e.messageId : '') !== target);
            updateStmt.run(
                content.trim(),
                JSON.stringify({ ...meta, inboundMessageIds: leftIds, standardEvents: leftEvents, mergedCount: leftIds.length }),
                sessionId,
                row.id
            );
            stripped += 1;
        }
        return { removed, stripped };
    }
    """ + M_SS_E

# ---------------------------------------------------------------- index.js
IX_ANCHOR = """bot.on('message', (event) => {
    // 戳一戳通知单独处理
    if (event && event.post_type === 'notice' && event.notice_type === 'notify' && event.sub_type === 'poke') {
        handlePokeEvent(event);
        return;
    }
    handleMessage(event);
});"""

IX_NEW = M_IX + """
/**
 * 撤回处理：用户明确要求"不要看我输撤回的话"。
 * 两条路都走 —— 没 flush 的从缓冲摘掉，已入库的从历史删掉。
 */
async function handleRecallEvent(event) {
    try {
        if (config.chat?.recallHandling === false) return;
        const messageId = String(event?.message_id ?? '').trim();
        if (!messageId) return;
        const sessionKey = event.group_id ? `group:${event.group_id}` : `private:${event.user_id}`;
        const dropped = runtime.dropBufferedMessage(sessionKey, messageId);
        let deleted = null;
        if (managers.sessionManager?.deleteRecalledMessage) {
            deleted = managers.sessionManager.deleteRecalledMessage(sessionKey, messageId);
        }
        logger.info('[撤回] 已处理', {
            sessionKey,
            messageId,
            bufferedDropped: dropped,
            historyRemoved: deleted?.removed ?? 0,
            historyStripped: deleted?.stripped ?? 0,
            error: deleted?.error || ''
        });
    } catch (error) {
        // 撤回处理失败绝不能影响正常消息流
        logger.warn(`[撤回] 处理失败: ${error.message}`);
    }
}
""" + M_IX_E + """

bot.on('message', (event) => {
    // 戳一戳通知单独处理
    if (event && event.post_type === 'notice' && event.notice_type === 'notify' && event.sub_type === 'poke') {
        handlePokeEvent(event);
        return;
    }
    // 撤回通知：撤回的消息不再进模型，也不留在历史里
    if (event && event.post_type === 'notice'
        && (event.notice_type === 'group_recall' || event.notice_type === 'friend_recall')) {
        handleRecallEvent(event);
        return;
    }
    handleMessage(event);
});"""


def node_check(path):
    try:
        r = subprocess.run(["node", "--check", path], capture_output=True, text=True, timeout=60)
        return r.returncode == 0, (r.stderr or "").strip()
    except Exception as e:
        return False, str(e)


def apply(path, old, new, marker, label, dry=False):
    if not os.path.exists(path):
        return f"{label}: !! 不存在"
    src = open(path, "r", encoding="utf-8").read()
    if marker in src:
        return f"{label}: -- 已打过补丁"
    if src.count(old) != 1:
        return f"{label}: !! 锚点命中 {src.count(old)} 次（应为 1）"
    out = src.replace(old, new, 1)
    if dry:
        return f"{label}: DRY ok {len(src)} -> {len(out)}"
    bak = path + ".bak-" + time.strftime("%Y%m%d-%H%M%S") + "-recall"
    shutil.copy2(path, bak)
    open(path, "w", encoding="utf-8").write(out)
    ok, err = node_check(path)
    if not ok:
        shutil.copy2(bak, path)
        return f"{label}: !! node --check 失败，已还原\n     {err[:300]}"
    return f"{label}: OK {len(src)} -> {len(out)} 备份={os.path.basename(bak)}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()
    for d in DIRS:
        print("=" * 70)
        print(d)
        if args.check:
            for f, mk in (("runtime.js", M_RT), ("session.js", M_SS), ("index.js", M_IX)):
                p = os.path.join(d, f)
                s = open(p, encoding="utf-8").read() if os.path.exists(p) else ""
                ok, _ = node_check(p)
                print(f"  {f:<14} 补丁={mk in s} node-check={'OK' if ok else 'FAIL'}")
            continue
        print(" ", apply(os.path.join(d, "runtime.js"), RT_ANCHOR, RT_NEW, M_RT, "runtime.js", args.dry))
        print(" ", apply(os.path.join(d, "session.js"), SS_ANCHOR, SS_NEW, M_SS, "session.js", args.dry))
        print(" ", apply(os.path.join(d, "index.js"), IX_ANCHOR, IX_NEW, M_IX, "index.js", args.dry))


if __name__ == "__main__":
    main()
