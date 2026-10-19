/**
 * 情绪余温（mood carry-over）
 *
 * 用户 2026-10-18：「上一轮她不高兴，下一轮还该带着。现在每轮都从零开始，
 * 每次都是"刚刚见到你"。」
 *
 * 设计取舍
 * --------
 * **不猜情绪，也不告诉她"你该是什么情绪"** —— 那只会在每轮演一遍，更假。
 * 这里只提供两个**真实事实**：
 *   1. 距她上一次开口过了多久
 *   2. 她上一次说的原话
 * 剩下的交给她自己：那句话本来带的语气，她读到就接得上。
 *
 * 为什么需要它（明明历史里也有她的话）：
 *   - `historyAssistantMaxLines` 只留 2 行，且被当成"对话记录"读
 *   - 一旦隔了几小时、中间又聊了别的，她那句话就从上下文里滑出去了
 *   - 这条提示挂在「注意:」行末尾，位置杠杆最高（§5.1）
 *
 * 为什么读库而不是存内存：重启不丢，而且天然就是"她真的说过的那句"。
 * ⚠ `messages.timestamp` 是**入库时间**，对她自己的回复来说约等于发送时间，够用。
 */

const TTL_MS = 6 * 60 * 60 * 1000;      // 超过 6 小时就不提了
const MIN_GAP_MS = 2 * 60 * 1000;       // 2 分钟内刚说过，不用提醒
const MAX_REPLY_CHARS = 120;

/** 剥掉结构化信封，只留她说的正文。 */
function plainOf(text) {
    let s = String(text || '');
    if (s.startsWith('[')) {
        const m = /\]\s*([\s\S]+)$/.exec(s);
        if (m) s = m[1];
    }
    return s
        .replace(/\[图片[^\]]*\]/g, '[图片]')
        // 发送时才用的标记，念出来很怪（「[表情:无语]」这种）
        .replace(/\[(?:QQ)?(?:动态|大)?表情[^\]]*\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * 生成「注意:」行末尾那一句。没有可说的就返回空串（调用方直接跳过）。
 * @param {object} db  better-sqlite3 / node:sqlite 的库句柄（有 prepare/ get 即可）
 * @param {string} sessionId  例如 `private:2063362809`
 */
export function buildMoodHint(db, sessionId, now = Date.now()) {
    const sid = String(sessionId || '');
    if (!db || !sid) return '';
    let row = null;
    try {
        row = db.prepare(
            "select content, timestamp from messages where session_id = ? and role = 'assistant' order by rowid desc limit 1"
        ).get(sid);
    } catch {
        return '';
    }
    if (!row) return '';

    const at = Number(row.timestamp) || 0;
    if (!at) return '';
    const gap = now - at;
    if (gap > TTL_MS || gap < MIN_GAP_MS) return '';

    const reply = plainOf(row.content);
    if (!reply) return '';

    const minutes = Math.round(gap / 60000);
    const when = minutes < 60
        ? `${minutes} 分钟前`
        : `${(minutes / 60).toFixed(1).replace(/\.0$/, '')} 小时前`;

    const quoted = reply.length > MAX_REPLY_CHARS ? reply.slice(0, MAX_REPLY_CHARS) + '…' : reply;
    return `你上一次跟他说话是在 ${when}，你当时说的是「${quoted}」。`;
}
