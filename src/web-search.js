/**
 * DeepSeek 内置联网搜索（server tool）
 *
 * 为什么用它而不是 searxng（2026-11-18 用户告知"搜索上游免费了"）
 * -------------------------------------------------------------
 * DeepSeek 有两套搜索，别搞混：
 *   ① **Standalone Search & Fetch API**（`/v1/tools/search`）—— $0.75 / 1000 次成功请求（国内 5 元/千次）
 *   ② **Web Tools（`deepseek_web_search` server tool）** —— 在 chat 请求的 tools 里声明，
 *      由服务端执行，**不计费**。官方原文：
 *      "These server tools are not billed (text search, image search and page fetch).
 *       Only model token usage is billed."
 *
 * 我们用的是 ②。好处：不用维护 searxng 容器、结果质量更高、失败不额外花钱。
 * 代价：搜索结果会进上下文（按 token 计费），所以要**严格控制触发频率**。
 *
 * 硬性要求（官方）：
 *   - 必须用 `deepseek-flash` 模型（我们已经是）
 *   - thinking 必须 disabled 才走普通搜索；enabled 会变成"深度搜索"，最多 20 轮工具调用，很贵
 *   - 声明格式：`tools: [{ type: 'deepseek_web_search' }]`（不需要 name）
 *   - 不能用 `web_search_options`（会 400）
 *
 * 设计原则：**默认不搜**。
 *   群聊里 95% 的话不需要外部信息，乱搜有两个坏处：
 *     ① 花钱（结果进上下文）；② 她会变成"查资料的助手"，这跟"最像人"的目标冲突。
 */

export const WEB_SEARCH_TOOL = Object.freeze({ type: 'deepseek_web_search' });

/** 默认配置 */
export const WEB_SEARCH_DEFAULTS = Object.freeze({
    enabled: false,          // 默认关，用户显式打开才生效
    dailyCap: 12,            // 每会话每天最多搜几次
    minChars: 6              // 太短的话（"啊？""好的"）不搜
});

export function getWebSearchConfig(config = {}) {
    const raw = config?.chat?.webSearch || config?.webSearch || {};
    return {
        enabled: raw.enabled === true,
        dailyCap: Number.isFinite(Number(raw.dailyCap)) ? Math.max(0, Math.floor(Number(raw.dailyCap))) : WEB_SEARCH_DEFAULTS.dailyCap,
        minChars: Number.isFinite(Number(raw.minChars)) ? Math.max(0, Math.floor(Number(raw.minChars))) : WEB_SEARCH_DEFAULTS.minChars
    };
}

/**
 * 什么算"需要外部信息"。
 * 只收**明确的事实/时效/排障**信号，不收"你觉得""好不好"这种闲聊。
 */
const NEED_PATTERNS = [
    /(是什么|什么是|啥是|什么是|为什么|为啥)/,
    /(怎么(解决|弄|办|处理|修)|报错|错误|崩了|跑不起来|装不上|配置)/,
    /(最新|目前|现在|今年|今天|最近|刚刚|昨天).{0,10}(版本|价格|多少钱|新闻|情况|规定|政策|发布)/,
    /(多少钱|价格|收费|免费|贵不贵)/,
    /(什么时候|几号|哪天|截止|开始时间|赛程)/,
    /(谁是|哪个人|哪家|哪里(有|能)|推荐.{0,6}(工具|软件|网站))/,
    /(政策|规定|规则|标准|官方|文档)/
];

/** 明显不需要搜的：指令、纯符号、表情、非常短的回应 */
function looksLikeNoise(text = '') {
    const t = String(text || '').trim();
    if (!t) return true;
    if (/^[/／]/.test(t)) return true;                       // 指令
    if (/^[\s\p{P}\p{S}]+$/u.test(t)) return true;           // 纯标点符号
    if (/^(\d+|哈+|草+|6+|啊+|嗯+|哦+|？+|\?+)$/u.test(t)) return true;
    return false;
}

/**
 * 这条消息要不要开搜索？
 * @returns {{use:boolean, reason:string}}
 */
export function shouldUseWebSearch(config = {}, plainText = '', sessionKey = '', now = Date.now()) {
    const cfg = getWebSearchConfig(config);
    if (!cfg.enabled) return { use: false, reason: 'disabled' };
    const text = String(plainText || '').trim();
    if (text.length < cfg.minChars) return { use: false, reason: 'too_short' };
    if (looksLikeNoise(text)) return { use: false, reason: 'noise' };
    if (quotaLeft(sessionKey, cfg, now) <= 0) return { use: false, reason: 'daily_cap' };
    if (!NEED_PATTERNS.some((re) => re.test(text))) return { use: false, reason: 'no_need_signal' };
    return { use: true, reason: 'matched' };
}

// ---------------------------------------------------------------- 配额

/** sessionKey -> { day: 'YYYY-MM-DD', count: number } */
const quota = new Map();

function dayOf(now) {
    const d = new Date(now);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function quotaLeft(sessionKey = '', cfg = WEB_SEARCH_DEFAULTS, now = Date.now()) {
    const key = String(sessionKey || 'global');
    const rec = quota.get(key);
    const day = dayOf(now);
    if (!rec || rec.day !== day) return cfg.dailyCap;
    return Math.max(0, cfg.dailyCap - rec.count);
}

/** 真的发出了带搜索的请求才调用 */
export function noteWebSearch(sessionKey = '', now = Date.now()) {
    const key = String(sessionKey || 'global');
    const day = dayOf(now);
    const rec = quota.get(key);
    if (!rec || rec.day !== day) {
        quota.set(key, { day, count: 1 });
        return 1;
    }
    rec.count += 1;
    return rec.count;
}

export function resetWebSearchQuota() {
    quota.clear();
}

/**
 * 从 chat 响应里读出"搜了几次"（server_tool_use / server_tool_calls）。
 * 只用于日志，读不出来不影响功能。
 */
export function readSearchCount(result = {}) {
    const direct = result?.usage?.server_tool_use;
    if (direct && Number.isFinite(Number(direct.tool_search))) return Number(direct.tool_search);
    const calls = Array.isArray(result?.server_tool_calls) ? result.server_tool_calls : [];
    let n = 0;
    for (const c of calls) {
        for (const call of (c?.calls || [])) {
            if (call?.kind === 'search' || call?.type === 'deepseek_web_search') n += 1;
        }
    }
    return n;
}
