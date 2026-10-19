/**
 * 主动找话题（proactive chatter）
 *
 * 用户 2026-10-18：「她现在永远是被动响应。加一个很低的概率（比如几小时一次）
 * 在私聊里主动问一句，但必须带作息判断（半夜不能主动找）。」
 *
 * 设计要点
 * --------
 * 1. **默认关闭**（`enabled: false`）—— 主动发消息是会打扰人的功能，
 *    必须先被显式打开，不能靠"默认值顺手开"。
 * 2. **四道闸门**，全过才发：
 *    ① 在作息窗口内（`windowStart` ~ `windowEnd`，按本机时间）
 *    ② 该会话距上次互动 ≥ `minIdleMs`（默认 2 小时）—— 刚聊完不追
 *    ③ 今天还没发够 `maxPerDay` 次（按日期计数，重启清零）
 *    ④ 概率命中 `chance`
 * 3. **不猜她在想什么**：生成时给她「上次聊到哪」＋「现在几点」，让她自己接。
 *    提示词只描述情境，不举例句（§5.1：引号例句会被逐字搬用）。
 * 4. 只发**私聊**。群里主动开口风险太高（会被当刷屏），不做。
 */

// 2026-10-19：剥信封只留一份实现（§5.2）。原来这里自己写了
// /\]\s*([\s\S]+)$/ —— 命中**第一个** `]`（信封里 messageSegments 的数组括号），
// 于是她读到的是「他：] 那kmp呢」这种残渣。
import { stripStructuredEnvelope } from './structured-envelope.js';

export const DEFAULT_PROACTIVE_CONFIG = {
    enabled: false,
    minIdleMs: 2 * 60 * 60 * 1000,   // 距上次互动至少 2 小时
    maxPerDay: 2,
    windowStart: 9,                   // 9 点之前不发
    windowEnd: 23,                    // 23 点之后不发
    checkIntervalMs: 30 * 60 * 1000,  // 每 30 分钟看一次
    chance: 0.3,                      // 过了闸门之后，三成概率真的发
    targetSessions: [],               // 空 = 所有私聊；填了就只发这些
    excludeIds: []                    // 永不主动发的 QQ（通常是另一个 bot 实例的号）
};

/** 按本地时间判断是否在允许的作息窗口内。 */
export function isWithinWindow(now, start, end) {
    const hour = new Date(now).getHours();
    if (start <= end) {
        return hour >= start && hour < end;
    }
    // 跨午夜（例如 22 点到 2 点）
    return hour >= start || hour < end;
}

/** 从 `private:123` 里取 QQ 号。 */
export function parsePrivateSessionId(sessionId) {
    const m = /^private:(\d+)$/.exec(String(sessionId || ''));
    return m ? m[1] : '';
}

export class ProactiveChatter {
    constructor({ db = null, aiClient = null, bot = null, characterName = '', persona = null, selfId = '', config = {}, logger = console } = {}) {
        this.db = db;
        this.aiClient = aiClient;
        this.bot = bot;
        this.characterName = characterName;
        // 角色卡的人格段：没有它，「不要用括号写动作」这条规则进不了请求
        this.persona = persona || {};
        this.selfId = String(selfId || '');
        this.logger = logger;
        this.cfg = { ...DEFAULT_PROACTIVE_CONFIG, ...(config || {}) };
        this.timer = null;
        this.sentToday = 0;
        this.countDate = '';
        this.lastSentAt = 0;
    }

    start() {
        if (!this.cfg.enabled) {
            this.logger?.info?.('[主动] 未启用');
            return;
        }
        if (!this.db || !this.aiClient || !this.bot) {
            this.logger?.warn?.('[主动] 依赖不全，跳过启用', {
                db: Boolean(this.db), ai: Boolean(this.aiClient), bot: Boolean(this.bot)
            });
            return;
        }
        const interval = Math.max(60000, Number(this.cfg.checkIntervalMs) || DEFAULT_PROACTIVE_CONFIG.checkIntervalMs);
        this.timer = setInterval(() => {
            this.tick().catch((e) => this.logger?.warn?.('[主动] tick 异常', e?.message || e));
        }, interval);
        if (typeof this.timer.unref === 'function') {
            this.timer.unref();   // 别拖住进程退出
        }
        this.logger?.info?.('[主动] 已启用', {
            window: `${this.cfg.windowStart}-${this.cfg.windowEnd}`,
            minIdleHours: (Number(this.cfg.minIdleMs) || 0) / 3600000,
            maxPerDay: this.cfg.maxPerDay,
            chance: this.cfg.chance
        });
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /** 每天重置计数。 */
    resetDailyIfNeeded(now) {
        const day = new Date(now).toISOString().slice(0, 10);
        if (day !== this.countDate) {
            this.countDate = day;
            this.sentToday = 0;
        }
    }

    /** 挑一个"该说话了"的私聊会话。返回 { sessionId, userId, idleMs } 或 null。 */
    pickSession(now) {
        let rows = [];
        try {
            rows = this.db.prepare(
                "select id, last_active from sessions where id like 'private:%' order by last_active desc"
            ).all();
        } catch (e) {
            this.logger?.warn?.('[主动] 读会话失败', e?.message || e);
            return null;
        }
        const allow = Array.isArray(this.cfg.targetSessions) ? this.cfg.targetSessions : [];
        const minIdle = Number(this.cfg.minIdleMs) || DEFAULT_PROACTIVE_CONFIG.minIdleMs;
        for (const row of rows) {
            const sessionId = String(row?.id || '');
            const userId = parsePrivateSessionId(sessionId);
            if (!userId) continue;
            // 别给自己（另一个实例的号）发
            if (this.selfId && userId === this.selfId) continue;
            const excludes = Array.isArray(this.cfg.excludeIds) ? this.cfg.excludeIds.map(String) : [];
            if (excludes.includes(userId)) continue;
            if (allow.length > 0 && !allow.includes(sessionId) && !allow.includes(userId)) continue;
            const lastActive = Number(row?.last_active) || 0;
            const idleMs = now - lastActive;
            if (idleMs < minIdle) continue;
            // 刚主动发过就别连着发
            if (this.lastSentAt && now - this.lastSentAt < minIdle) continue;
            return { sessionId, userId, idleMs };
        }
        return null;
    }

    /** 取这个会话最近几条，给她当"上次聊到哪"。 */
    recentLines(sessionId, limit = 4) {
        try {
            const rows = this.db.prepare(
                'select role, content from messages where session_id = ? order by rowid desc limit ?'
            ).all(sessionId, limit);
            const out = [];
            for (const r of rows.reverse()) {
                // 剥结构化信封：唯一实现（structured-envelope.js），别在这再写一份正则
                let text = String(stripStructuredEnvelope(r?.content ?? '') ?? '');
                // 图片转述是给模型看的视觉描述，不是他说过的话 —— 混进来她会当成正文
                if (/图片转述|<image_caption>|外形接近/.test(text)) continue;
                text = text.replace(/\[图片[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
                if (!text) continue;
                out.push(`${r.role === 'assistant' ? '你' : '他'}：${text.slice(0, 100)}`);
            }
            return out;
        } catch (e) {
            this.logger?.warn?.('[主动] 读消息失败', e?.message || e);
            return [];
        }
    }

    /** 人格段：卡里 personality 开头那句「你正在扮演X」是旁白视角，去掉再用。 */
    buildPersonaMessage() {
        const p = this.persona || {};
        const parts = [];
        const personality = String(p.personality || '').replace(/^你正在扮演[^。]*。\s*/, '').trim();
        if (personality) parts.push(personality);
        if (p.postHistory) parts.push(String(p.postHistory).trim());
        const text = parts.filter(Boolean).join('\n\n');
        return text ? { role: 'system', content: text } : null;
    }

    buildMessages(contextLines, now) {
        const hour = new Date(now).getHours();
        const timeHint = hour < 11 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 22 ? '晚上' : '深夜';
        // ⚠ 只描述情境，不举例句、不给否定指令（§5.1）
        // 2026-10-19：原来写「说说你此刻在做什么」⇒ 她理解成"描写自己的动作"，
        // 加上这次请求没带角色卡（「不要用括号写动作」失效），输出成了（午休趴桌上…）旁白。
        // 改成"在手机上打字，屏幕上只有字"——同一个意思，用情境说。
        const user = `现在是${timeHint}。你一个人待着，忽然想跟他说句话。\n\n`
            + `【你们上次聊到】\n${contextLines.join('\n') || '（没什么印象了）'}\n\n`
            + '你正在手机上给他发消息，屏幕上只会出现你打出来的字。\n'
            + '接着上面的话说，或者说说你这边正好发生的一件小事。一句话就够。';
        const persona = this.buildPersonaMessage();
        return persona ? [persona, { role: 'user', content: user }] : [{ role: 'user', content: user }];
    }

    async tick() {
        const now = Date.now();
        this.resetDailyIfNeeded(now);

        if (!isWithinWindow(now, Number(this.cfg.windowStart), Number(this.cfg.windowEnd))) {
            return;
        }
        if (this.sentToday >= (Number(this.cfg.maxPerDay) || 0)) {
            return;
        }
        const picked = this.pickSession(now);
        if (!picked) {
            return;
        }
        if (Math.random() > (Number(this.cfg.chance) || 0)) {
            this.logger?.debug?.('[主动] 概率未命中', { sessionId: picked.sessionId });
            return;
        }

        const contextLines = this.recentLines(picked.sessionId);
        const messages = this.buildMessages(contextLines, now);
        let text = '';
        try {
            const result = await this.aiClient.chat(
                messages,
                { maxTokens: 120, temperature: 0.9, thinking: { type: 'disabled' } }
            );
            text = String(this.aiClient.getVisibleResponseContent?.(result) ?? result?.content ?? '').trim();
        } catch (e) {
            this.logger?.warn?.('[主动] 生成失败', e?.message || e);
            return;
        }
        // 去掉可能的引号包裹
        text = text.replace(/^["“'「]+|["”'」]+$/g, '').trim();
        if (!text || text.length > 200) {
            this.logger?.warn?.('[主动] 生成内容不可用，放弃', { length: text.length });
            return;
        }

        try {
            await this.bot.sendPrivateMessage(picked.userId, text);
        } catch (e) {
            this.logger?.warn?.('[主动] 发送失败', e?.message || e);
            return;
        }

        this.sentToday += 1;
        this.lastSentAt = now;
        this.logger?.info?.('[主动] 已主动开口', {
            sessionId: picked.sessionId,
            idleHours: (picked.idleMs / 3600000).toFixed(1),
            todayCount: this.sentToday,
            preview: text.slice(0, 60)
        });
    }
}
