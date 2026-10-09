/**
 * 博查 Bocha 搜索 Provider（需 API Key）
 * 文档：https://open.bochaai.com
 *
 * 返回结构与 Tavily 不同：结果在 data.webPages.value[]，字段是
 * name / url / snippet / summary / datePublished / dateLastCrawled。
 * 已实测：site: 与 include 两种站点过滤都生效，这里用 include（不污染 query）；
 * freshness 支持 oneDay / oneWeek / oneMonth / oneYear / noLimit。
 */

import { requestText, clampInteger, isAbortError } from '../http.js';

const ENDPOINT = 'https://api.bochaai.com/v1/web-search';

const FRESHNESS_MAP = {
    day: 'oneDay',
    week: 'oneWeek',
    month: 'oneMonth',
    year: 'oneYear'
};

export const bochaProvider = {
    id: 'bocha',
    label: '博查 Bocha（需 API Key）',
    requiresApiKey: true,
    supportsNews: true,
    supportsTimeRange: true,
    supportsSite: true,
    async search(ctx) {
        if (!ctx.apiKey) {
            throw new Error('未配置博查 API Key');
        }

        const limit = clampInteger(ctx.limit, 1, 10, 5);
        const topic = String(ctx.topic || 'web').toLowerCase() === 'news' ? 'news' : 'web';
        const timeRange = String(ctx.timeRange || 'all').toLowerCase();

        // 博查没有独立的 news 频道，用 freshness 表达时效；news 且未指定范围时
        // 退化成「最近一天」，贴近新闻语义。
        let freshness = FRESHNESS_MAP[timeRange] || 'noLimit';
        if (topic === 'news' && !FRESHNESS_MAP[timeRange]) {
            freshness = 'oneDay';
        }

        const body = {
            query: String(ctx.query || ''),
            freshness,
            // summary 返回大模型可直接阅读的摘要，比裸 snippet 更完整
            summary: true,
            count: limit
        };
        if (ctx.site) {
            body.include = String(ctx.site);
        }

        let response;
        try {
            response = await requestText(ENDPOINT, {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${ctx.apiKey}`
                },
                body: JSON.stringify(body),
                timeoutMs: ctx.timeoutMs,
                signal: ctx.signal
            });
        } catch (error) {
            if (isAbortError(error)) {
                throw error;
            }
            throw new Error(`博查请求失败: ${error.message}`);
        }

        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                throw new Error('博查 API Key 无效或已过期');
            }
            if (response.status === 429) {
                throw new Error('博查触发限流（HTTP 429），请稍后再试');
            }
            throw new Error(`博查返回 HTTP ${response.status}`);
        }

        let payload;
        try {
            payload = JSON.parse(response.text);
        } catch {
            throw new Error('博查返回内容不是合法 JSON');
        }

        // 业务错误码藏在 body.code 里，HTTP 200 也可能是失败
        const code = Number(payload?.code);
        if (Number.isFinite(code) && code !== 200) {
            throw new Error(`博查返回业务错误 code=${code} msg=${payload?.msg || ''}`);
        }

        const items = payload?.data?.webPages?.value;
        const results = (Array.isArray(items) ? items : []).slice(0, limit).map((item) => ({
            title: String(item.name || ''),
            url: String(item.url || ''),
            snippet: String(item.summary || item.snippet || ''),
            publishedAt: item.datePublished || item.dateLastCrawled || ''
        })).filter((item) => item.url);

        return { source: 'bocha', results };
    }
};
