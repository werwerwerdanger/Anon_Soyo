/**
 * 分层配置 —— 让每个群、每个人可以有自己的一套参数。
 *
 * 层级（后面的覆盖前面的）：
 *   1. config.chat            全局默认
 *   2. chat.overrides['*']    全站兜底微调（不推荐常用）
 *   3. chat.overrides[<会话>]  「group:929159193」或「private:2063362809」
 *   4. chat.overrides[<会话>/user:<uid>]  群内单独某人（例如"某个群友可以更放飞"）
 *
 * 合并策略：**深合并对象，数组/标量整体替换**。
 *   —— 数组不能逐项合并（比如 knownBots 想整组换掉），标量覆盖最直观。
 *
 * 为什么要单独一层而不是直接读 config.chat：
 *   现在的调用点（runtime / prompt / reply-decision / 发送清洗）都各自拿 config.chat，
 *   散着改会变成"每个地方自己判断一遍"，半年后没人说得清哪个群用哪套。
 *   统一走 resolveForSession()，规则只有这一处。
 */

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, patch) {
    if (!isPlainObject(patch)) return patch;
    const out = isPlainObject(base) ? { ...base } : {};
    for (const [k, v] of Object.entries(patch)) {
        out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
    }
    return out;
}

/**
 * 算出某个会话实际生效的 chat 配置。
 * @param {object} config 完整配置
 * @param {string} sessionKey 'group:123' / 'private:456'
 * @returns {object} 合并后的 chat 配置块
 */
export function resolveChatForSession(config = {}, sessionKey = '') {
    const base = isPlainObject(config.chat) ? config.chat : {};
    const overrides = isPlainObject(base.overrides) ? base.overrides : {};
    const key = String(sessionKey || '').trim();

    let merged = base;
    if (isPlainObject(overrides['*'])) {
        merged = deepMerge(merged, overrides['*']);
    }
    // 群内个人：先把**所属群**那层合进来，再叠这个人的覆盖
    // （否则 group:X/user:Y 会跳过 group:X 的设定，只继承全局）
    if (key.includes('/user:')) {
        const groupKey = key.split('/user:')[0];
        if (isPlainObject(overrides[groupKey])) {
            merged = deepMerge(merged, overrides[groupKey]);
        }
    }
    if (key && isPlainObject(overrides[key])) {
        merged = deepMerge(merged, overrides[key]);
    }
    return merged;
}

/** 群内个人的会话键：group:123 → group:123/user:5678 */
export function userScopeKey(groupId, userId) {
    const g = String(groupId ?? '').trim();
    const u = String(userId ?? '').trim();
    if (!g || !u) return '';
    return `group:${g}/user:${u}`;
}

/** 从 OneBot 事件得到「群+人」的复合键，拿不到就退回普通会话键。 */
export function scopeKeyFromEvent(event = {}) {
    if (event?.message_type === 'group' && event.group_id) {
        const g = `group:${event.group_id}`;
        return event.user_id ? `${g}/user:${event.user_id}` : g;
    }
    if (event?.message_type === 'private' && event.user_id) {
        return `private:${event.user_id}`;
    }
    if (event?.group_id) return `group:${event.group_id}`;
    return event?.user_id ? `private:${event.user_id}` : '';
}

/**
 * 按层级依次尝试：群内个人 → 群 → 全局。
 * 返回第一个有该字段的取值；都没有则返回 undefined。
 * 用于"只需要一个值"的场合（例如"这个群的口癖概率"）。
 */
export function lookupChatValue(config = {}, sessionKey = '', dottedPath = '') {
    const parts = String(dottedPath).split('.').filter(Boolean);
    if (parts.length === 0) return undefined;
    const read = (obj) => {
        let cur = obj;
        for (const p of parts) {
            if (!isPlainObject(cur) && typeof cur !== 'object') return undefined;
            if (cur == null) return undefined;
            cur = cur[p];
        }
        return cur;
    };
    const resolved = resolveChatForSession(config, sessionKey);
    return read(resolved);
}
