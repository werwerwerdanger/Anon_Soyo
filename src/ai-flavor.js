/**
 * AI 腔过滤器 —— 确定性删除/替换「模型口癖」，不靠提示词。
 *
 * 为什么不做成提示词里的「不要说 总之/综上/希望对你有帮助」：
 *   本项目实测过「否定句 = 二次 priming」—— 你点名词表，反而提高这些词的出现率。
 *   而且词表写进每轮提示词还占 token、冲淡人设。
 * 所以放在**出口**：命中就删，没命中零成本，还能记日志看它到底说过什么。
 *
 * 词表来源（2026-10-31 整理）：
 *   · TWO-ICE/article-deslop `references/banned-words.md`（通用文章 AI 味禁用词表，分类最全）
 *   · pix2ai/Humanizer-zh（AI 高频词警示列表）
 *   · Xiaoyangy/novel-studio `story-deslop`（小说腔模板）
 *   ⚠ 只取**聊天里会违和**的部分。技术群里本来就常用「迭代/链路/对齐/复盘/沉淀/矩阵/生态」，
 *     这些词在这里是正常词汇，删了反而像听不懂话 —— 所以黑话那档默认关。
 *
 * 两个档位（配置 chat.aiFlavor.tiers）：
 *   boilerplate  句首书面过渡 / 总结 / 升华 / 假权威  —— 默认开
 *   jargon       互联网黑话替换（赋能→帮忙 等）—— 默认关（本群是技术群）
 */

// 句首书面过渡 / 总结 / 假权威：删掉不影响句意
// ⚠ 刻意**不收**「然后 / 最后 / 其实」—— 这几个是真人口语，删了反而假。
const BOILERPLATE_WORDS = [
    // 论文腔
    '由此可见', '不难看出', '事实证明', '毋庸置疑', '不可否认', '众所周知',
    '不言而喻', '不言自明', '显而易见', '毋庸讳言', '一言以蔽之', '毋庸多言',
    // 总结 / 过渡
    '综上所述', '总而言之', '总之', '总的来说', '总体而言', '无论如何',
    '事实上', '实际上', '本质上', '关键在于',
    '值得注意的是', '值得一提的是', '不得不说的是', '不得不说',
    '与此同时', '与此不同', '与此相反', '相比之下', '更为重要的是',
    '首先', '其次', '再次', '再者',
    // 结构宣告
    '以下是', '下面是'
];

// 句尾升华 / 展望 / 客套：整块删
const TAIL_PATTERNS = [
    /[，,、\s]*(?:希望(?:这|以上|我的回答|这些)?(?:能)?(?:对)?(?:你|您)?(?:有所|有)?帮助)[！!。.~～]*\s*$/g,
    /[，,、\s]*(?:如果(?:你|您)(?:还有|有)?(?:其他|别的|任何)?(?:问题|需要|疑问)[，,]?(?:随时|欢迎|可以)[^\n]{0,20})[！!。.~～]*\s*$/g,
    /[，,、\s]*(?:有需要(?:的话)?(?:随时|可以)?(?:告诉我|找我|说)[^\n]{0,12})[！!。.~～]*\s*$/g,
    /(?:^|[\n。；])\s*(?:这不仅是[^。！？!?\n]{0,30}更是[^。！？!?\n]{0,30})[！!。.~～]*/g,
    /[，,、\s]*(?:让我们拭目以待|未来可期|前途无量|值得我们深思|值得每一个[^\n]{0,8}深思|仍任重道远|路漫漫其修远兮)[！!。.~～]*\s*$/g,
    /(?:^|\n)\s*(?:以上|就这些|希望能帮到你)[。.！!~～]*\s*$/g
];

// 假权威开头：删掉前缀，后面照说
const FALSE_AUTHORITY_HEAD = [
    '据了解', '据相关人士透露', '有分析认为', '有专家指出', '数据显示',
    '据最新统计', '据不完全统计', '引发了广泛关注', '引发了热议'
];

// 互联网黑话 → 人话（默认关：本群是技术群，很多词是日常用语）
const JARGON_MAP = [
    ['赋能', '帮忙'], ['抓手', '办法'], ['闭环', '一整套流程'],
    ['颗粒度', '细节'], ['底层逻辑', '原因'], ['护城河', '优势'],
    ['痛点', '问题'], ['多措并举', '几招一起上'], ['全方位', '各方面'],
    ['组合拳', '一套做法'], ['顶层设计', '整体规划']
];

function headRegex(words) {
    const alt = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    // 捕获组 1 = 前置分隔符（行首 / 句末标点），替换时原样保留，别把句子粘起来
    return new RegExp(`(^|[\\n。；！？!?;])\\s*(?:${alt})[，,、:：]?\\s*`, 'g');
}

const HEAD_RE = headRegex(BOILERPLATE_WORDS);
const AUTH_RE = headRegex(FALSE_AUTHORITY_HEAD);

/** 返回命中的原文片段（诊断用，最多 5 条）。 */
export function detectAiFlavor(text, options = {}) {
    const tiers = { boilerplate: true, jargon: false, ...(options.tiers || {}) };
    const src = String(text || '');
    if (!src) return [];
    const found = [];
    for (const re of [HEAD_RE, AUTH_RE, ...TAIL_PATTERNS]) {
        re.lastIndex = 0;
        const m = re.exec(src);
        if (m && m[0]) found.push(m[0].replace(/^[\n。；！？!?;\s]+/, '').trim().slice(0, 16));
        if (found.length >= 5) break;
    }
    if (tiers.jargon) {
        for (const [word] of JARGON_MAP) {
            if (src.includes(word)) found.push(word);
            if (found.length >= 5) break;
        }
    }
    return found.filter(Boolean);
}

/** 删掉/替换命中的套话；其余字不动。 */
export function stripAiFlavor(text, options = {}) {
    const tiers = { boilerplate: true, jargon: false, ...(options.tiers || {}) };
    let out = String(text || '');
    if (!out) return out;
    if (tiers.boilerplate !== false) {
        HEAD_RE.lastIndex = 0;
        out = out.replace(HEAD_RE, '$1');     // 保留分隔符
        AUTH_RE.lastIndex = 0;
        out = out.replace(AUTH_RE, '$1');
        for (const re of TAIL_PATTERNS) {
            re.lastIndex = 0;
            out = out.replace(re, '');
        }
    }
    if (tiers.jargon) {
        for (const [from, to] of JARGON_MAP) {
            out = out.split(from).join(to);
        }
    }
    return out
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^[，,、\s；;]+/, '')
        .trim();
}
