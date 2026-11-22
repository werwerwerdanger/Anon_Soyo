/**
 * 昵称消毒 —— 用户能改的字符串进提示词之前必须先过一遍。
 *
 * 2026-10-31 事故：有人群昵称就叫「你 耗时 已 长」，被拼成 `你 耗时 已 长: 你个…傻逼`，
 * 决策模型把昵称里的「你」当第二人称 ⇒ 以为被骂 ⇒ 误判要回话。
 *
 * 同类风险不止人称代词：
 *   · 昵称里塞 `（机器人）`  → 伪装成已被识别为 bot，或反过来把真人标成 bot；
 *   · 昵称里塞 `|` / `｜`    → 伪造【参与者】的分隔符，凭空多出一个"人"；
 *   · 昵称里塞 `【刚进来的这条】` / `[系统]` → 伪造结构化前缀；
 *   · 换行 → 把一行拆成两条消息，伪造上下文。
 * 所以这里只留「像一个名字」的东西：去控制字符、去结构符号、截断长度。
 */

const STRUCTURAL = /[「」『』【】\[\]<>《》]/g;
const SEPARATORS = /[|｜]/g;
const FAKE_ROLE = /[（(]\s*(?:机器人|bot|Bot|BOT|系统|管理员|admin)\s*[)）]/g;
const CONTROL = /[\u0000-\u001f\u007f]/g;

/**
 * 返回一个可以安全拼进提示词的名字。空则用 fallback。
 * @param {*} name 原始昵称/群名片
 * @param {string} fallback 兜底名字
 */
export function safeName(name, fallback = '某人') {
    let s = String(name ?? '');
    s = s.replace(CONTROL, ' ');
    s = s.replace(FAKE_ROLE, '');
    s = s.replace(SEPARATORS, ' ');
    s = s.replace(STRUCTURAL, '');
    s = s.replace(/\s+/g, ' ').trim();
    s = s.slice(0, 24).trim();
    return s || fallback;
}
