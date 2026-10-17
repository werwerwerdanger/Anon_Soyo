/**
 * 画像引文清洗（participant-profile 的「引号引语」）
 *
 * 起因（2026-10-17）：群 group:2153082940，她把 werwer 的一句「哭了」回成
 * 「谁哭了呀 / 好嘛 我数落你干嘛」，那一轮的 reasoning 写着
 * `werwer is playing pitiful "哭了 哄不好了"` —— 可「哄不好了」并不在那条
 * 消息里，它逐字来自注入的【当前发言人画像】条目：
 *   `会用"是他们在欺负"…这类带撒娇/玩笑性质的委屈语气吐槽，并配合"哭了""哄不好了"等夸张表达。`
 * 同一段回复里「还以为你要加入他们呢」的「他们」，也正是画像引文
 * 「是他们在欺负」里的那个「他们」。
 *
 * 结论：画像里的引号引语 = **台词本**。她会照着念，甚至念出她自己没听到的那半句。
 * 这与 §52.11 的摘要 / 角色卡是同一种机制，这里是第三个来源。
 * 实测两个实例 44 份画像里，带引号的原话占 31%（werwer 私聊那份占 42%）。
 *
 * 原则：**宁可漏洗，不可误删**。
 * 只把引号里的原话换成省略号占位，句子骨架和括注里的信息全部保留；
 * 替换后汉字不足 MIN_CJK 个的条目整行丢弃（那种条目基本只剩一句台词）。
 * 不写库、不改存量：每次渲染前现算，DB 原文不动。
 */

const QUOTE_RE = /["\u201c]([^"\u201d\n]{1,60})["\u201d]/g;
const QUOTE_TEST = /["\u201c][^"\u201d\n]{1,60}["\u201d]/;
const CJK_RE = /[\u4e00-\u9fff]/g;
const MIN_CJK = 6;

/** 这段画像里有没有"会被当台词念"的引号引语。 */
export function hasQuotedScript(text) {
    return QUOTE_TEST.test(String(text || ''));
}

/**
 * 把引号里的原话换成 `…`。
 * @param {string} text 画像原文
 * @returns {string} 清洗后的画像；没有引文时原样返回（=== 传入值）
 */
export function scrubProfileQuotes(text) {
    const src = String(text || '');
    if (!src || !QUOTE_TEST.test(src)) {
        return src;
    }
    const out = [];
    for (const rawLine of src.split(/\r?\n/)) {
        if (!QUOTE_TEST.test(rawLine)) {
            out.push(rawLine);
            continue;
        }
        let line = rawLine
            .replace(QUOTE_RE, '\u2026')
            .replace(/\u2026{2,}/g, '\u2026')
            // 「（如"…"）」这种纯列举被抽空后就成了空括号，整段去掉
            .replace(/[\uff08(]\s*\u5982\s*\u2026\s*[\uff09)]/g, '')
            .replace(/\u5982\s*\u2026/g, '')
            // 删掉占位符后可能留下孤零零的标点
            .replace(/[\uff0c\u3001,]\s*([\u3002\uff1b])/g, '$1')
            .replace(/[\uff0c\u3001,]\s*([\uff09)])/g, '$1')
            .replace(/[\uff08(]\s*[\uff0c\u3001]/g, '\uff08')
            .replace(/[\uff0c\u3001,]{2,}/g, '\uff0c')
            .replace(/\u3002{2,}/g, '\u3002');
        const body = line.replace(/^[\s\-*\u2022\u00b7]+/, '');
        const cjkCount = (body.match(CJK_RE) || []).length;
        if (cjkCount < MIN_CJK) {
            continue;
        }
        out.push(line);
    }
    return out.join('\n');
}
