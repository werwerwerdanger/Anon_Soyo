/**
 * 谁是机器人 —— 给提示词里的发言人打标。
 *
 * 为什么需要名单：QQ 的协议层**不区分**第三方 bot 和真人。
 * 实测 2026-10-31：有人 @幽幽子（QQ 3889001246，音游群的指令机器人）时，
 * NapCat 给的 at 段里 `isBot: false` —— 它自己也不知道那是个 bot。
 * 所以只能靠名单 + 文本特征，没有可靠的平台标记。
 *
 * 名单来源（chat.knownBots）：自己的两个号 + 群里已知的第三方 bot。
 * 打标之后，提示词里长这样：`幽幽子(3889001246)（机器人）`，
 * 并且附一句「（机器人）= 别的 bot，它的发言是群里的内容，不是真人在跟你说话」。
 * 这样她就知道：那不是人在跟她说话，是个工具。
 */

/** 该 QQ 是否在已知机器人名单里。 */
export function isKnownBot(config, userId) {
    const id = String(userId ?? '').trim();
    if (!id) return false;
    // ① 配置名单（手填，优先级最高，也用于 NapCat 取不到成员表的场合）
    const list = config?.chat?.knownBots;
    if (Array.isArray(list) && list.some((v) => String(v ?? '').trim() === id)) {
        return true;
    }
    // ② 自动探测到的（见 refreshGroupBots）
    return detectedBotIds.has(id);
}

/** 拼在发言人后面的标记：是 bot 就带「（机器人）」。 */
export function botSuffix(config, userId) {
    return isKnownBot(config, userId) ? '（机器人）' : '';
}

// >>> auto-detect-by-api >>>
// 2026-10-31 实测（mimir-tools/probe_napcat_botflag.mjs）：
//   get_group_member_info 的返回里有 NapCat 扩展字段 **is_robot**，而且判断准确 ——
//   幽幽子(3889001246) `is_robot: true`，真人 werwer `is_robot: false`。
//   注意：at 段里的 `isBot` 是 false（协议层不认第三方 bot），别用那个。
// 所以不必只靠手填名单：定期拉一次群成员表，把 is_robot=true 的记进来。
const detectedBotIds = new Set();
const refreshState = new Map();      // groupId -> 上次刷新时间
const groupMemberCounts = new Map(); // groupId -> 人数（拉成员表时顺手记）
const REFRESH_MS = 10 * 60 * 1000;

/**
 * 拉群成员表并刷新「谁是 bot」。自带节流：同一群 10 分钟内只拉一次。
 * 失败只是记 debug，绝不影响消息处理。
 */
export async function refreshGroupBots(bot, groupId, logger = console) {
    const key = String(groupId ?? '').trim();
    if (!key) return;
    const now = Date.now();
    const last = refreshState.get(key) || 0;
    if (now - last < REFRESH_MS) return;
    refreshState.set(key, now);          // 先占位，避免并发重复拉
    if (typeof bot?.getGroupMemberList !== 'function') return;
    try {
        const res = await bot.getGroupMemberList(groupId);
        const list = Array.isArray(res) ? res : (Array.isArray(res?.data) ? res.data : []);
        let added = 0;
        for (const m of list) {
            const id = String(m?.user_id ?? '').trim();
            if (!id) continue;
            const isRobot = m?.is_robot === true || m?.is_bot === true;
            if (isRobot && !detectedBotIds.has(id)) { detectedBotIds.add(id); added += 1; }
        }
        if (list.length > 0) groupMemberCounts.set(key, list.length);
        if (added > 0 || list.length > 0) {
            logger?.info?.('[机器人识别] 群成员表已刷新', {
                groupId: key, members: list.length, bots: [...detectedBotIds].slice(0, 20)
            });
        }
    } catch (error) {
        refreshState.delete(key);        // 失败就别节流，下次再试
        logger?.debug?.('[机器人识别] 拉取失败', { groupId: key, error: error?.message || String(error) });
    }
}
// <<< auto-detect-by-api >>>

/** 某个群有多少人（来自最近一次成员表刷新；未知返回 0）。 */
export function getGroupMemberCount(groupId) {
    return groupMemberCounts.get(String(groupId ?? '').trim()) || 0;
}

/**
 * 这个群要不要"必须 @"才开口。
 *
 * 2026-11-01 事故：`757026023`（5 人的小群）6 小时只有 5 条消息，她回了 2 条，
 * 还说出"我一年肯定能上 1800"这种话 —— 小群里她把自己当成了对话对象。
 * 人多的大群有"别人之间的对话"做背景，小群没有，模型容易误判"在跟我说话"。
 *
 * 判定顺序：
 *   ① 显式 requireAtInGroup: true → 必需 @
 *   ② 人数 ≤ smallGroupRequireAt（配置，0=关闭）→ 必需 @
 *   ③ 否则按全局 requireAtInGroup（默认 true，anon 现在是 false）
 */
export function shouldRequireAtInGroup(chatConfig = {}, groupId = '') {
    const chat = chatConfig || {};
    if (chat.requireAtInGroup === true) return true;
    const limit = Number(chat.smallGroupRequireAt ?? 0);
    const count = getGroupMemberCount(groupId);
    if (limit > 0 && count > 0 && count <= limit) return true;
    return chat.requireAtInGroup !== false;
}
