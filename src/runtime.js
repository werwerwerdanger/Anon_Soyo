/**
 * 消息调度运行时
 * 提供去重、缓冲聚合、每会话串行化与全局并发限制。
 */

// >>> silence-gate patch (managed by patch_silence_gate.py) >>>
import { noteInbound, beginReply, endReply } from './reply-gate.js';
// <<< silence-gate patch <<<

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeRuntimeItems(items = []) {
    return {
        count: items.length,
        roles: [...new Set(items.map((item) => item?.role).filter(Boolean))],
        messageIds: items
            .map((item) => item?.messageId || item?.id || item?.metadata?.id || '')
            .filter(Boolean)
            .slice(0, 5)
    };
}

class Semaphore {
    constructor(maxConcurrent = 2) {
        this.maxConcurrent = Math.max(1, maxConcurrent);
        this.current = 0;
        this.waiters = [];
    }

    setMaxConcurrent(maxConcurrent) {
        this.maxConcurrent = Math.max(1, maxConcurrent);
        this.flush();
    }

    async acquire() {
        if (this.current < this.maxConcurrent) {
            this.current += 1;
            return;
        }

        await new Promise((resolve) => {
            this.waiters.push(resolve);
        });
        this.current += 1;
    }

    release() {
        this.current = Math.max(0, this.current - 1);
        this.flush();
    }

    flush() {
        while (this.current < this.maxConcurrent && this.waiters.length > 0) {
            const waiter = this.waiters.shift();
            waiter();
        }
    }
}

export class MessageRuntime {
    constructor(config, logger, processor) {
        this.logger = logger;
        this.processor = processor;
        this.buffers = new Map();
        this.chains = new Map();
        this.seenMessages = new Map();
        this.lastEnqueueAt = null;
        this.lastFlushAt = null;
        this.totalBatches = 0;
        this.cleanupTimer = null; // 定时清理 timer
        this.updateConfig(config);
        this.startCleanupTimer();
    }

    startCleanupTimer() {
        // 每 30 秒清理一次过期的去重记录
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
        }
        this.cleanupTimer = setInterval(() => {
            this.cleanupSeenMessages();
        }, 30000);
    }

    destroy() {
        // 清理所有 timer
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }

        for (const [sessionKey, state] of this.buffers.entries()) {
            if (state.timer) {
                clearTimeout(state.timer);
                state.timer = null;
            }
        }

        this.buffers.clear();
        this.chains.clear();
        this.seenMessages.clear();
    }

    updateConfig(config = {}) {
        this.config = config;
        const chatConfig = config.chat || {};
        this.bufferWindowMs = chatConfig.bufferWindowMs ?? 1200;
        // >>> silence-gate patch (managed by patch_silence_gate.py) >>>
        // 本轮「第一句」等更久（用户常在第一句之后接着打），后续用较短的窗口
        this.firstBufferWindowMs = chatConfig.firstBufferWindowMs ?? this.bufferWindowMs;
        // 静默到这个时刻就提前调 AI，窗口一结束即可发出
        this.bufferPrefetchMs = chatConfig.bufferPrefetchMs ?? 0;
        // <<< silence-gate patch <<<
        this.replyDelayMs = chatConfig.replyDelayMs ?? 800;
        this.dedupeWindowMs = chatConfig.dedupeWindowMs ?? 10000;
        const maxConcurrent = chatConfig.maxConcurrentSessions ?? 2;

        if (this.semaphore) {
            this.semaphore.setMaxConcurrent(maxConcurrent);
        } else {
            this.semaphore = new Semaphore(maxConcurrent);
        }
    }

    enqueue(item) {
        this.cleanupSeenMessages();
        if (item.dedupeKey && this.seenMessages.has(item.dedupeKey)) {
            this.logger.debug?.(`[调度] 重复消息已忽略: ${item.dedupeKey}`);
            return false;
        }

        if (item.dedupeKey) {
            this.seenMessages.set(item.dedupeKey, Date.now());
        }

        this.lastEnqueueAt = Date.now();

        const state = this.getBufferState(item.sessionKey);
        state.items.push(item);
        this.logger.debug?.('[调度] 消息已入缓冲', {
            sessionKey: item.sessionKey,
            dedupeKey: item.dedupeKey || '',
            bufferSize: state.items.length,
            bufferedSessions: this.buffers.size,
            item: summarizeRuntimeItems([item])
        });

        // >>> silence-gate patch (managed by patch_silence_gate.py) >>>
        const nowTs = Date.now();
        // 有新消息进来 ⇒ 若有在途回复，作废它（它生的是上一轮的内容）
        noteInbound(item.sessionKey);
        // 距上一条消息超过一个窗口 ⇒ 算新一轮的开头，给更长的静默时间
        const freshTurn = !state.lastEnqueueTs || (nowTs - state.lastEnqueueTs > this.bufferWindowMs);
        state.lastEnqueueTs = nowTs;
        const silentMs = Math.max(0, freshTurn ? this.firstBufferWindowMs : this.bufferWindowMs);
        state.holdUntil = nowTs + silentMs;
        // <<< silence-gate patch <<<
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
        // <<< silence-gate patch <<<

        return true;
    }

    getBufferState(sessionKey) {
        if (!this.buffers.has(sessionKey)) {
            this.buffers.set(sessionKey, {
                items: [],
                timer: null,
                // >>> silence-gate patch <<<
                prefetchTimer: null,
                holdUntil: 0,
                lastEnqueueTs: 0
                // <<< silence-gate patch <<<
            });
        }

        return this.buffers.get(sessionKey);
    }

    async flush(sessionKey, options = {}) {
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
        // <<< silence-gate patch <<<
        this.lastFlushAt = Date.now();
        if (state.timer) {
            clearTimeout(state.timer);
            state.timer = null;
        }

        this.logger.info?.('[调度] 开始刷新缓冲', {
            sessionKey,
            itemCount: items.length,
            activeSessions: this.chains.size,
            bufferedSessions: this.buffers.size,
            queueDepth: this.semaphore.waiters.length,
            batch: summarizeRuntimeItems(items)
        });

        const chain = (this.chains.get(sessionKey) || Promise.resolve())
            .then(() => this.runBatch(sessionKey, items))
            .catch((error) => {
                this.logger.error?.(`[调度] 会话 ${sessionKey} 批处理失败: ${error.message}`);
            });

        this.chains.set(sessionKey, chain.finally(() => {
            // >>> silence-gate patch <<<
            endReply(sessionKey);
            // <<< silence-gate patch <<<
            if (this.chains.get(sessionKey) === chain) {
                this.chains.delete(sessionKey);
            }
        }));
    }

    async runBatch(sessionKey, items) {
        const startedAt = Date.now();
        await this.semaphore.acquire();
        try {
            this.totalBatches += 1;
            this.logger.info?.('[调度] 开始批处理', {
                sessionKey,
                batchIndex: this.totalBatches,
                itemCount: items.length,
                replyDelayMs: this.replyDelayMs,
                maxConcurrentSessions: this.semaphore.maxConcurrent,
                currentConcurrency: this.semaphore.current,
                waitingSessions: this.semaphore.waiters.length,
                batch: summarizeRuntimeItems(items)
            });

            if (this.replyDelayMs > 0) {
                await sleep(this.replyDelayMs);
            }

            const batchMemoryScope = items[items.length - 1]?.memoryScope || items[0]?.memoryScope || null;

            await this.processor({
                sessionKey,
                items,
                memoryScope: batchMemoryScope,
                createdAt: Date.now()
            });

            this.logger.info?.('[调度] 批处理完成', {
                sessionKey,
                batchIndex: this.totalBatches,
                durationMs: Date.now() - startedAt,
                itemCount: items.length,
                memoryScopeType: batchMemoryScope?.scopeType || '',
                memoryScopeKey: batchMemoryScope?.scopeKey || ''
            });
        } finally {
            this.semaphore.release();
        }
    }

// >>> recall-drop patch (managed by patch_recall.py) >>>
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

// <<< recall-drop patch <<<
    cleanupSeenMessages() {
        const now = Date.now();
        for (const [key, timestamp] of this.seenMessages.entries()) {
            if (now - timestamp > this.dedupeWindowMs) {
                this.seenMessages.delete(key);
            }
        }
    }

    getStats() {
        const bufferedMessages = Array.from(this.buffers.values())
            .reduce((count, state) => count + state.items.length, 0);

        return {
            bufferedSessions: this.buffers.size,
            bufferedMessages,
            activeSessions: this.chains.size,
            queuedDedupes: this.seenMessages.size,
            maxConcurrentSessions: this.semaphore.maxConcurrent,
            replyDelayMs: this.replyDelayMs,
            bufferWindowMs: this.bufferWindowMs,
            lastEnqueueAt: this.lastEnqueueAt,
            lastFlushAt: this.lastFlushAt,
            totalBatches: this.totalBatches
        };
    }
}
