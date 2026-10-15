/**
 * structured-envelope.js —— 剥掉 MimirLink 的「结构化信封」。
 *
 * 🔴 为什么单独抽一个模块（2026-10-13）：
 *   `processedInput` / 历史里存的用户消息都是**带信封**的：
 *     `[私聊|QQ:2063362809|昵称:werwer|群号:N/A|…|messageSegments:[{…}]] 要是我是素世就好了`
 *   信封里**必然**带着 **发送者自己的 QQ / 昵称 / 群号**，而这三样恰好都是"必然存在"的字符串
 *   ⇒ 任何"从当前消息文本里匹配东西"的逻辑，只要忘了剥信封，就会**恒定命中**。
 *   已经踩到两次：
 *     ① `participant-roster.js` 的「注意:」提及提示 ⇒ **每条消息都命中**，
 *        每轮都在杠杆最高处注入一句假的「对方提到的那个人就在你的联系人名单里」（2026-10-13）。
 *     ② `prompt.js` 的【会话感知】"反复在说同一件事" ⇒ 任意两条信封的字符 bigram 必然重叠，
 *        于是**每次都**报「对方反复在说同一件事：「[私聊|QQ:2063362809|昵称:wer」」（同日）。
 *   ⇒ 规则：**凡是拿消息文本做匹配/聚类/抽词的，先过这里。**
 *
 * ⚠ 与 `session.js` 的 `stripStructuredHeaders()` 的分工：
 *   那个是**通用**括号剥离（迭代删 `[...]`/`{...}`，会连正文里的括号一起删、还会压空白），
 *   适合"抽关键词"；本模块是**定向**剥信封，**正文原样保留**，适合"匹配/展示"。
 *   两者别互相替代（本项目已有过"同一规则两份实现漂移"的教训）。
 */

/**
 * 系统自己拼进消息文本里的「元数据信封」。
 *
 * ⚠ 别只写 `[私聊|`/`[群聊|` 两条 —— 实测至少还有几种形态会一起漏进来，
 *   少一种就还是有东西在污染匹配（2026-10-13 第二次踩到：补了私聊/群聊之后，
 *   `[回复上文|发送者:…]` 仍然被当成"反复出现的话"）。
 */
const ENVELOPE_PREFIXES = ['[私聊|', '[群聊|', '[回复上文|', '[合并转发聊天记录|'];

/**
 * 🔴 按**括号配平**找信封的结尾，不能只写 `[^\]]*`。
 *
 * 2026-10-14 实测踩到：信封里可能**嵌套方括号**，例如
 *   `…|replyQuotedText:[图片:[动画表情]]|messageSegments:[…]] [回复上文|…|内容:[图片:[动画表情]]]`
 * 用 `[^\]]*` 匹配会停在**第一个** `]`（也就是 `[动画表情]` 的那个），
 * 于是删完还剩一截 `]]` 留在正文里（`prompt.js` 的历史区就真的渲染出 `]]` 了）。
 * 用 `[^[\]]*` 也不行 —— 遇到嵌套直接**整个不匹配**，信封原样留在文本里。
 * ⇒ 只能数括号深度。
 */
function stripBracketedFrom(text, prefix, maxLen = 4000) {
    let out = text;
    for (let guard = 0; guard < 24; guard += 1) {
        const start = out.indexOf(prefix);
        if (start < 0) break;
        let depth = 0;
        let end = -1;
        for (let i = start; i < out.length && i - start <= maxLen; i += 1) {
            const ch = out[i];
            if (ch === '[') depth += 1;
            else if (ch === ']') {
                depth -= 1;
                if (depth === 0) { end = i; break; }
            }
        }
        // 配不上（或长到不像信封）⇒ 原样留着，别把大段正文吃掉
        if (end < 0) break;
        out = `${out.slice(0, start)} ${out.slice(end + 1)}`;
    }
    return out;
}

/**
 * 剥掉所有结构化信封 + 图片指纹，只留正文。
 * @param {string} text
 * @returns {string} 正文（可能包含多条，用换行分隔）；不是信封的文本原样返回
 */
export function stripStructuredEnvelope(text) {
    let out = String(text ?? '');
    for (const prefix of ENVELOPE_PREFIXES) out = stripBracketedFrom(out, prefix);
    out = out.replace(/\[图片标识[^\]]*\]/g, ' ');
    return out.replace(/[ \t]{2,}/g, ' ').trim();
}

/** 这条文本看起来是不是（含）结构化信封。 */
export function hasStructuredEnvelope(text) {
    const s = String(text ?? '');
    return ENVELOPE_PREFIXES.some((p) => s.includes(p)) || /\[图片标识[^\]]*\]/.test(s);
}
