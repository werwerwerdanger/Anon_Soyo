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
import { worldLineToday } from './canon/index.js';

export const DEFAULT_PROACTIVE_CONFIG = {
    enabled: false,
    minIdleMs: 2 * 60 * 60 * 1000,   // 距上次互动至少 2 小时
    maxPerDay: 2,
    windowStart: 9,                   // 9 点之前不发
    windowEnd: 23,                    // 23 点之后不发
    checkIntervalMs: 30 * 60 * 1000,  // 每 30 分钟看一次
    chance: 0.3,                      // 过了闸门之后，三成概率真的发
    // 2026-10-23：主动开场分两种模式，按这个概率二选一。
    // 用户原话：「为什么爱音主动找我每次都会提一嘴上次说的东西感觉好怪啊」——
    // 旧版**每次**都把最近 4 条塞进【你们上次聊到】并要求"接着上面的话说"，
    // 而"说件小事"排在它后面，模型自然总选第一个（§4.1 列举收敛第一个）。
    // 0.35 = 大约三分之一的开场接上次，其余开场只说她这边的事。
    followupChance: 0.35,
    targetSessions: [],               // 空 = 所有私聊；填了就只发这些
    excludeIds: [],                   // 永不主动发的 QQ（通常是另一个 bot 实例的号）
    // >>> prox-allday patch >>>
    // 这几个人不受上面 windowStart/windowEnd 的限制。用途：另一个 bot 实例
    // 不是「人」，凌晨找它说话不存在打扰，而且用户想看的正是这种自然延续。
    allDayForIds: [],
    // <<< prox-allday patch <<<
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
    constructor({ db = null, aiClient = null, bot = null, characterName = '', persona = null, selfId = '', config = {}, canonCfg = {}, logger = console } = {}) {
        this.db = db;
        this.aiClient = aiClient;
        this.bot = bot;
        this.characterName = characterName;
        // 角色卡的人格段：没有它，「不要用括号写动作」这条规则进不了请求
        this.persona = persona || {};
        this.selfId = String(selfId || '');
        // canon 配置（世界事件要从这里读）。缺了就走默认目录。
        this.canonCfg = canonCfg || {};
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
    recentLines(sessionId, limit = 4, targetName = '') {
        const other = String(targetName || '').trim() || '他';
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
                out.push(`${r.role === 'assistant' ? '你' : other}：${text.slice(0, 100)}`);
            }
            return out;
        } catch (e) {
            this.logger?.warn?.('[主动] 读消息失败', e?.message || e);
            return [];
        }
    }

    /**
     * 该怎么称呼对方（只用于主动私聊的开场）。
     *
     * 取名字的顺序（2026-10-24 二改）：
     *   ① 她自己的画像里给这个人起的名字（`participant_profile` 的 participantName）
     *      —— 这是她"心里那个人"的名字，LLM 归纳过，长期稳定。
     *   ② `participant_contacts.display_name`，但要去掉括号后缀。
     *   ③ 都没有才退回"他"。
     *
     * 为什么不直接用 display_name：它是**群名片**，用户随手就能改成
     * 「世上只有妈妈好」这种玩梗名。10-24 09:12 实锤——她照字面回了句
     * 「妈妈，我今天自己起来的哦」，就是因为这里塞了当时的群名片。
     */
    contactName(userId) {
        const id = String(userId || '').trim();
        if (!id) return '';
        // ① 画像里的名字
        try {
            const row = this.db
                .prepare(
                    "select json_extract(metadata_json,'$.participantName') as name "
                    + "from memory_entries where entry_type = 'participant_profile' and id like ? "
                    + 'order by updated_at desc limit 1'
                )
                .get('participant_profile_' + id + '_%');
            const profileName = String(row?.name || '').trim();
            if (profileName) return profileName;
        } catch (e) {
            this.logger?.debug?.('[主动] 取画像名失败', e?.message || e);
        }
        // ② 联系人表的群名片，去掉「（…）」这类后缀
        try {
            const row = this.db
                .prepare('select display_name from participant_contacts where participant_id = ? limit 1')
                .get(id);
            const raw = String(row?.display_name || '');
            const cleaned = raw
                .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            if (cleaned) return cleaned;
        } catch (e) {
            this.logger?.debug?.('[主动] 取昵称失败', e?.message || e);
        }
        return '';
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

    buildMessages(contextLines, now, mode = 'followup', targetName = '') {
        const hour = new Date(now).getHours();
        const timeHint = hour < 11 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 22 ? '晚上' : '深夜';
        // ⚠ 只描述情境，不举例句、不给否定指令（§5.1）
        // 2026-10-19：原来写「说说你此刻在做什么」⇒ 她理解成"描写自己的动作"，
        // 加上这次请求没带角色卡（「不要用括号写动作」失效），输出成了（午休趴桌上…）旁白。
        // 改成"在手机上打字，屏幕上只有字"——同一个意思，用情境说。
        //
        // >>> proactive-open-mode patch >>>
        // 2026-10-23：两种开场模式，由 followupChance 掷骰子决定。
        //   followup —— 带着「上次聊到」的 4 条，接上文（旧行为，现在只是其中一种）
        //   fresh    —— **不注入**上次对话，只留"你这边正好有件小事"的情境
        // fresh 必须彻底不给上文，否则那 4 条一样会把话题拽回去。
        //
        // >>> proactive-target-name patch >>>
        // 2026-10-23 另一处：20:58 她主动开场把对方叫成「Tomorin」。
        // 原因＝这轮请求里**完全没有对方是谁**，只有"他"这个代词；而角色卡里
        // 满篇是 Tomorin / Soyorin / Rikki（爱音给乐队成员起的外号）⇒ 名字从卡里就近取。
        // 现在把对方在这个库里的显示名（participant_contacts.display_name）传进来。
        // 拿到就写昵称，拿不到才退回"他"（肯定式，不加引号例句）。
        const other = String(targetName || '').trim() || '他';
        const persona = this.buildPersonaMessage();
        // [canon] 今天外面的那件事。有就当成"随口能提的一句"，没有也不影响。
        // 注意：只给事实，不给"你可以拿它当话题"这种指令 —— 那会让她生硬地宣布天气。
        const worldLine = worldLineToday(this.canonCfg || {});
        const worldBlock = worldLine ? `【今天】${worldLine}\n` : '';
        let user;
        if (mode === 'fresh') {
            user = `现在是${timeHint}。你一个人待着，忽然想跟${other}说句话。\n\n`
                + worldBlock
                + `你这边正好有件小事，想顺口跟${other}讲一下。\n`
                + `你正在手机上给${other}发消息，屏幕上只会出现你打出来的字。一句话就够。`;
        } else {
            user = `现在是${timeHint}。你一个人待着，忽然想跟${other}说句话。\n\n`
                + `【你们上次聊到】\n${contextLines.join('\n') || '（没什么印象了）'}\n\n`
                + worldBlock
                + `你正在手机上给${other}发消息，屏幕上只会出现你打出来的字。\n`
                + '接着上面的话说，或者说说你这边正好发生的一件小事。一句话就够。';
        }
        // <<< proactive-target-name patch <<<
        // <<< proactive-open-mode patch <<<
        return persona ? [persona, { role: 'user', content: user }] : [{ role: 'user', content: user }];
    }

    async tick() {
        const now = Date.now();
        this.resetDailyIfNeeded(now);

        if (this.sentToday >= (Number(this.cfg.maxPerDay) || 0)) {
            return;
        }
        const picked = this.pickSession(now);
        if (!picked) {
            return;
        }
        // >>> prox-allday patch >>>
        // 先选出目标，再判窗口：目标是 allDayForIds 里的人（另一个 bot）就跳过作息检查。
        // 顺序必须这样——原来窗口检查在最前面，根本走不到"知道要发给谁"这一步。
        const allDayIds = Array.isArray(this.cfg.allDayForIds) ? this.cfg.allDayForIds.map(String) : [];
        if (!allDayIds.includes(String(picked.userId))
            && !isWithinWindow(now, Number(this.cfg.windowStart), Number(this.cfg.windowEnd))) {
            return;
        }
        // <<< prox-allday patch <<<
        if (Math.random() > (Number(this.cfg.chance) || 0)) {
            this.logger?.debug?.('[主动] 概率未命中', { sessionId: picked.sessionId });
            return;
        }

        // >>> proactive-open-mode patch >>>
        // 掷骰子决定这次开场是"接上次"还是"说件新事"。fresh 模式下不读上文，
        // 省一次 SQL 也避免那 4 条把话题拽回去。
        const followupChanceRaw = Number(this.cfg.followupChance);
        const followupChance = Number.isFinite(followupChanceRaw) ? Math.min(1, Math.max(0, followupChanceRaw)) : 0.35;
        const openMode = Math.random() < followupChance ? 'followup' : 'fresh';
        // <<< proactive-open-mode patch <<<
        // >>> proactive-target-name patch >>>
        const targetName = this.contactName(picked.userId);
        // <<< proactive-target-name patch <<<
        const contextLines = openMode === 'followup' ? this.recentLines(picked.sessionId, 4, targetName) : [];
        const messages = this.buildMessages(contextLines, now, openMode, targetName);
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
            targetName: targetName || '(unknown)',
            idleHours: (picked.idleMs / 3600000).toFixed(1),
            todayCount: this.sentToday,
            mode: openMode,
            preview: text.slice(0, 60)
        });
    }
}
