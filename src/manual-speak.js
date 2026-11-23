/**
 * 人手发言豁免（2026-11-23）
 *
 * 问题：用户有时直接拿 bot 的 QQ 号在手机上打字。协议层看，这条消息跟
 * bot 自己发的**完全一样** —— 对方收到时 user_id 就是那个号，无法区分。
 * 于是 co-bot 限流会把它当机器人之间闲聊拦掉：
 *
 *   23:50-23:54 素世号发「晚安」→ 爱音侧 skipReason: bot_banter_limit
 *
 * 解法：**发言方自己知道**。self-echo 逻辑本来就要判断「这条是 bot 自己发的
 * 还是人手打的」（isSelfSent）—— 判定为人手打的时候就往共享目录写一个短命标记，
 * 收信方在 co-bot 判断前查一眼：对方刚刚有人手发言过，就按真人处理。
 *
 * 两边进程共用同一个目录（chat.canon.dir），所以能互相看见。
 * 标记只活 TTL 毫秒，避免 bot 自发的话被顺带放行。
 */
import fs from 'fs';
import path from 'path';

function markerFile(dir) {
    const base = String(dir || '').trim();
    if (!base) return '';
    return path.join(base, 'manual-send.json');
}

/** 人手发完一条，留个标记。失败也不能影响发消息本身。 */
export function markManualSend(dir, { fromId, preview = '' } = {}) {
    try {
        const file = markerFile(dir);
        if (!file || !fromId) return false;
        fs.writeFileSync(file, JSON.stringify({
            from: String(fromId),
            at: Date.now(),
            preview: String(preview || '').slice(0, 40)
        }), 'utf8');
        return true;
    } catch {
        return false;
    }
}

/** 这个号最近是不是有人在手机上手打过。 */
export function isManualSpeak(dir, fromId, { now = Date.now(), ttlMs = 120000 } = {}) {
    try {
        const file = markerFile(dir);
        if (!file || !fromId) return false;
        const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!obj || String(obj.from) !== String(fromId)) return false;
        const age = now - Number(obj.at || 0);
        return age >= 0 && age < Math.max(1000, Number(ttlMs) || 120000);
    } catch {
        return false;
    }
}
