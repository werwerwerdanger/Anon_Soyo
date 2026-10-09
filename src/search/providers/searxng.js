/**
 * SearXNG 搜索 Provider（自建或公开实例，需实例开启 JSON 输出）
 * 文档：https://docs.searxng.org/dev/search_api.html
 */

import { requestText, clampInteger, isAbortError } from '../http.js';
import { stripHtml } from '../html.js';

const SAFE_SEARCH_MAP = {
    off: '0',
    moderate: '1',
    strict: '2'
};

const TIME_RANGE_MAP = {
    day: 'day',
    week: 'week',
    month: 'month',
    year: 'year'
};

export function normalizeSearxngBaseUrl(rawValue) {
    const value = String(rawValue || '').trim();
    if (!value) {
        return '';
    }
    try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return '';
        }
        return url.origin + url.pathname.replace(/\/+$/, '');
    } catch {
        return '';
    }
}

export const searxngProvider = {
    id: 'searxng',
    label: 'SearXNG（自建/实例，需开启 JSON）',
    requiresApiKey: false,
    supportsNews: true,
    supportsTimeRange: true,
    supportsSite: true,
    async search(ctx) {
        const baseUrl = normalizeSearxngBaseUrl(ctx.searxngBaseUrl);
        if (!baseUrl) {
            throw new Error('未配置有效的 SearXNG 实例地址');
        }

        const limit = clampInteger(ctx.limit, 1, 10, 5);
        const topic = String(ctx.topic || 'web').toLowerCase();
        const query = ctx.site ? `site:${ctx.site} ${ctx.query}` : String(ctx.query || '');
        const params = new URLSearchParams({
            q: query,
            format: 'json',
            categories: topic === 'news' ? 'news' : 'general',
            language: ctx.locale || 'zh-CN',
            safesearch: SAFE_SEARCH_MAP[String(ctx.safeSearch || 'moderate').toLowerCase()] || '1',
            pageno: '1'
        });
        const timeRange = TIME_RANGE_MAP[String(ctx.timeRange || 'all').toLowerCase()];
        if (timeRange) {
            params.set('time_range', timeRange);
        }
        // >>> lang-engines patch (managed by patch_lang_engines.py) >>>
        // Do NOT set an 'engines' URL parameter here. SearXNG ignores it:
        // seven different values of it were tried against this instance and
        // every one returned a byte-identical result set. Engine selection is
        // read out of the query text by searx/query.py's BangParser, which
        // also restores '-' / '_' to spaces, so '!sogou_wechat' selects the
        // engine named "sogou wechat". Setting a bang also sets specific=true,
        // which is what makes the choice exclusive rather than additive.
        const engineList = pickEngines(query, ctx);
        if (engineList) {
            params.set('q', applyEngineBangs(engineList, query));
        }
        // <<< lang-engines patch <<<

        let response;
        try {
            response = await requestText(`${baseUrl}/search?${params.toString()}`, {
                headers: { Accept: 'application/json' },
                timeoutMs: ctx.timeoutMs,
                signal: ctx.signal
            });
        } catch (error) {
            if (isAbortError(error)) {
                throw error;
            }
            throw new Error(`SearXNG 请求失败: ${error.message}`);
        }

        if (!response.ok) {
            if (response.status === 403) {
                throw new Error('SearXNG 实例拒绝 JSON 输出（HTTP 403）：请在 settings.yml 的 formats 中加入 json');
            }
            throw new Error(`SearXNG 返回 HTTP ${response.status}`);
        }

        let payload;
        try {
            payload = JSON.parse(response.text);
        } catch {
            throw new Error('SearXNG 实例未返回 JSON：请在 settings.yml 的 formats 中加入 json');
        }

        const items = Array.isArray(payload?.results) ? payload.results : [];
        const results = items.slice(0, limit).map((item) => ({
            title: stripHtml(item.title || ''),
            url: String(item.url || ''),
            snippet: stripHtml(item.content || ''),
            publishedAt: item.publishedDate || ''
        })).filter((item) => item.url);

        return { source: 'searxng', results };
    }
};


// >>> lang-engines patch (managed by patch_lang_engines.py) >>>
// CJK ideographs, kana and halfwidth katakana. A query containing any of these
// is treated as Chinese/Japanese and routed to the Chinese engine list; the
// presence of Latin letters does not matter, because "成都理工大学 2026 年招生
// 简章" is a Chinese query that happens to contain digits.
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/;

/**
 * Turn a comma-separated engine list into '!bang' tokens and put them in front
 * of the query. Bangs lead so that what the engines actually search for is
 * unchanged.
 */
function applyEngineBangs(engineList, query) {
    const bangs = String(engineList)
        .split(',')
        .map((name) => name.trim().replace(/\s+/g, '_'))
        .filter(Boolean)
        .map((name) => `!${name}`)
        .join(' ');
    return bangs ? `${bangs} ${query}` : query;
}

/**
 * Pick the engine list from the query's script, falling back to the original
 * searxngEngines value. Returns '' when nothing is configured, which leaves
 * upstream behaviour untouched.
 */
function pickEngines(query, ctx) {
    const cjk = String(ctx.searxngEnginesCjk || '').trim();
    const latin = String(ctx.searxngEnginesLatin || '').trim();
    const fallback = String(ctx.searxngEngines || '').trim();
    if (CJK_RE.test(String(query || ''))) {
        return cjk || fallback;
    }
    return latin || fallback;
}
// <<< lang-engines patch <<<
