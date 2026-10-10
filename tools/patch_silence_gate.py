#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_silence_gate.py -- 「提前调 AI + 静默窗口到了再发」

用户需求（2026-10-10）：
  连着打几条消息时机器人 2.5s 就回，会打断。
  要的是：第一句静默 30s、后续静默 20s 才算这轮说完；
  静默到 15s 时提前调 AI，这样窗口一结束就能立刻发出去。

实现要点：
  runtime.js 用两个计时器 —— prefetch(15s) 提前 flush，flush(30s/20s) 正常结束本轮。
  但提前生成有个必须解决的问题：15s 开始生成，用户 16s 又发了一条，这条在途回复就过期了。
  所以**生成可以提前，发送必须被闸住** —— 闸门放在 reply-dispatcher.js 的 sendText 里
  （那是唯一的下发出口），按 sessionKey 查 reply-gate.js：
    - 等到 holdUntil（本轮静默窗口结束）才真正发
    - 期间每 500ms 复查，一旦被新消息作废就放弃这一轮

  「第一句 30s」的判定：距上一条消息超过 bufferWindowMs 才算新一轮的开头，
  否则用较短的 bufferWindowMs。这样提前 flush 之后再来消息不会又被当成"第一句"。

用法:
  python patch_silence_gate.py --check
  python patch_silence_gate.py
"""
import argparse
import os
import shutil
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

DIRS = [r"C:\Users\20633\MimirLink-soyo\src", r"C:\Users\20633\MimirLink\src"]

MARK = "// >>> silence-gate patch (managed by patch_silence_gate.py) >>>"
MARK_E = "// <<< silence-gate patch <<<"

IMPORT_ANCHOR = """function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}"""
IMPORT_NEW = MARK + """
import { noteInbound, beginReply, endReply } from './reply-gate.js';
""" + MARK_E + """

""" + IMPORT_ANCHOR

CFG_OLD = """        this.bufferWindowMs = chatConfig.bufferWindowMs ?? 1200;
        this.replyDelayMs = chatConfig.replyDelayMs ?? 800;"""
CFG_NEW = """        this.bufferWindowMs = chatConfig.bufferWindowMs ?? 1200;
        """ + MARK + """
        // 本轮「第一句」等更久（用户常在第一句之后接着打），后续用较短的窗口
        this.firstBufferWindowMs = chatConfig.firstBufferWindowMs ?? this.bufferWindowMs;
        // 静默到这个时刻就提前调 AI，窗口一结束即可发出
        this.bufferPrefetchMs = chatConfig.bufferPrefetchMs ?? 0;
        """ + MARK_E + """
        this.replyDelayMs = chatConfig.replyDelayMs ?? 800;"""

TIMER_OLD = """        if (state.timer) {
            clearTimeout(state.timer);
        }

        state.timer = setTimeout(() => {
            this.flush(item.sessionKey).catch((error) => {
                this.logger.error?.(`[调度] 刷新缓冲失败: ${error.message}`);
            });
        }, this.bufferWindowMs);"""

TIMER_NEW = """        """ + MARK + """
        const nowTs = Date.now();
        // 有新消息进来 ⇒ 若有在途回复，作废它（它生的是上一轮的内容）
        noteInbound(item.sessionKey);
        // 距上一条消息超过一个窗口 ⇒ 算新一轮的开头，给更长的静默时间
        const freshTurn = !state.lastEnqueueTs || (nowTs - state.lastEnqueueTs > this.bufferWindowMs);
        state.lastEnqueueTs = nowTs;
        const silentMs = Math.max(0, freshTurn ? this.firstBufferWindowMs : this.bufferWindowMs);
        state.holdUntil = nowTs + silentMs;
        """ + MARK_E + """
        if (state.timer) {
            clearTimeout(state.timer);
        }

        state.timer = setTimeout(() => {
            this.flush(item.sessionKey, { holdUntil: state.holdUntil }).catch((error) => {
                this.logger.error?.(`[调度] 刷新缓冲失败: ${error.message}`);
            });
        }, silentMs);

        // >>> silence-gate patch <<<
        // 提前 flush：先生成，发送仍被闸门压到 holdUntil
        if (state.prefetchTimer) {
            clearTimeout(state.prefetchTimer);
            state.prefetchTimer = null;
        }
        if (this.bufferPrefetchMs > 0 && this.bufferPrefetchMs < silentMs) {
            state.prefetchTimer = setTimeout(() => {
                this.flush(item.sessionKey, { holdUntil: state.holdUntil }).catch((error) => {
                    this.logger.error?.(`[调度] 预生成刷新失败: ${error.message}`);
                });
            }, this.bufferPrefetchMs);
        }
        // <<< silence-gate patch <<<"""

FLUSH_OLD = """    async flush(sessionKey) {
        const state = this.buffers.get(sessionKey);
        if (!state || state.items.length === 0) {
            return;
        }

        const items = state.items.splice(0, state.items.length);"""

FLUSH_NEW = """    async flush(sessionKey, options = {}) {
        const state = this.buffers.get(sessionKey);
        if (!state || state.items.length === 0) {
            return;
        }

        const items = state.items.splice(0, state.items.length);
        // >>> silence-gate patch <<<
        // 标记本轮开始：holdUntil 之前不许发送，被新消息作废就放弃
        beginReply(sessionKey, Number(options.holdUntil) || 0);
        if (state.prefetchTimer) {
            clearTimeout(state.prefetchTimer);
            state.prefetchTimer = null;
        }
        // <<< silence-gate patch <<<"""

CHAIN_OLD = """        this.chains.set(sessionKey, chain.finally(() => {
            if (this.chains.get(sessionKey) === chain) {
                this.chains.delete(sessionKey);
            }
        }));"""
CHAIN_NEW = """        this.chains.set(sessionKey, chain.finally(() => {
            // >>> silence-gate patch <<<
            endReply(sessionKey);
            // <<< silence-gate patch <<<
            if (this.chains.get(sessionKey) === chain) {
                this.chains.delete(sessionKey);
            }
        }));"""

BUFFER_STATE_OLD = """            this.buffers.set(sessionKey, {
                items: [],
                timer: null
            });"""
BUFFER_STATE_NEW = """            this.buffers.set(sessionKey, {
                items: [],
                timer: null,
                // >>> silence-gate patch <<<
                prefetchTimer: null,
                holdUntil: 0,
                lastEnqueueTs: 0
                // <<< silence-gate patch <<<
            });"""

# reply-dispatcher.js
DISPATCH_OLD = """    const sendText = async (content, options = {}) => {
        // >>> send-interval patch <<<
        await awaitSendSlot(config, sleep, logger, event, options.burst === true);"""
DISPATCH_NEW = """    const sendText = async (content, options = {}) => {
        // >>> silence-gate patch (managed by patch_silence_gate.py) >>>
        // 生成可以提前（runtime 的 prefetch 计时器），但发送必须等本轮静默窗口结束；
        // 期间用户又发了消息 ⇒ 本轮作废，直接不发。
        const gateKey = sessionKeyFromEvent(event);
        if (gateKey) {
            const sendable = await waitUntilSendable(gateKey, sleep, logger);
            if (!sendable) {
                return;
            }
        }
        // <<< silence-gate patch <<<
        // >>> send-interval patch <<<
        await awaitSendSlot(config, sleep, logger, event, options.burst === true);"""

DISPATCH_IMPORT_ANCHOR = """import { parseVoiceTags } from './tts.js';"""
DISPATCH_IMPORT_NEW = ("""import { sessionKeyFromEvent, waitUntilSendable } from './reply-gate.js';"""
                      + "\n" + DISPATCH_IMPORT_ANCHOR)


def node_check(path):
    try:
        r = subprocess.run(["node", "--check", path], capture_output=True, text=True, timeout=60)
        return r.returncode == 0, (r.stderr or "").strip()
    except Exception as e:
        return False, str(e)


def edit(path, pairs, label):
    src = open(path, "r", encoding="utf-8").read()
    if MARK in src:
        return f"{label}: -- 已打过补丁", None
    out = src
    for name, old, new in pairs:
        n = out.count(old)
        if n != 1:
            return f"{label}: !! [{name}] 锚点命中 {n} 次（应为 1）", None
        out = out.replace(old, new, 1)
    return f"{label}: 待写入 {len(src)} -> {len(out)}", (src, out)


def commit(path, payloads):
    src, out = payloads
    bak = path + ".bak-" + time.strftime("%Y%m%d-%H%M%S") + "-gate"
    shutil.copy2(path, bak)
    open(path, "w", encoding="utf-8").write(out)
    ok, err = node_check(path)
    if not ok:
        shutil.copy2(bak, path)
        return f"  !! node --check 失败，已还原\n     {err[:300]}"
    return f"  OK {os.path.basename(path)} 备份={os.path.basename(bak)}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    runtime_pairs = [
        ("import", IMPORT_ANCHOR, IMPORT_NEW),
        ("cfg", CFG_OLD, CFG_NEW),
        ("timer", TIMER_OLD, TIMER_NEW),
        ("flush", FLUSH_OLD, FLUSH_NEW),
        ("chain", CHAIN_OLD, CHAIN_NEW),
        ("bufstate", BUFFER_STATE_OLD, BUFFER_STATE_NEW),
    ]
    dispatch_pairs = [
        ("import", DISPATCH_IMPORT_ANCHOR, DISPATCH_IMPORT_NEW),
        ("sendgate", DISPATCH_OLD, DISPATCH_NEW),
    ]

    for d in DIRS:
        print("=" * 70)
        rt = os.path.join(d, "runtime.js")
        dp = os.path.join(d, "reply-dispatcher.js")
        if args.check:
            for f in (rt, dp):
                src = open(f, encoding="utf-8").read() if os.path.exists(f) else ""
                ok, _ = node_check(f)
                print(f"  {os.path.basename(f):<22} 补丁={MARK in src} node-check={'OK' if ok else 'FAIL'}")
            continue
        for label, pairs in (("runtime.js", runtime_pairs), ("reply-dispatcher.js", dispatch_pairs)):
            f = rt if label == "runtime.js" else dp
            msg, payload = edit(f, pairs, label)
            print(" ", msg)
            if payload is None:
                continue
            if args.dry:
                print("     [dry-run]")
                continue
            print(commit(f, payload))


if __name__ == "__main__":
    main()
