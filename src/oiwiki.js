/**
 * OI Wiki 本地库检索
 *
 * 用户 2026-10-19：「你把整个 oiwiki 拉下来配进去」→「你配成数据库不就好了」
 *
 * 为什么不是世界书
 * ----------------
 * OI Wiki 有 465 页。世界书条目是「任一 key 命中 → 整条进 prompt」，
 * 塞进去会 ① 每次 matchEntries 遍历 465 条 ② 一命中就是几千字 ③ 一说话就撑爆上下文。
 * 做成库 + 按需查：她只在**真的被问到**时取回命中的那一段。
 *
 * 检索为什么用 LIKE 而不是 FTS5
 * ---------------------------
 * FTS5 的 `unicode61` 对中文是按单字切，短语查询要加引号；`trigram` 又要求 ≥3 字。
 * 而这里只有 465 页 / 十几 MB，`LIKE '%k%'` 全表扫描是毫秒级 —— 简单可靠，不折腾分词。
 * 排序：标题命中 > 分类命中 > 正文命中，同样命中里按长度短者优先（更可能是专页）。
 */

// 2026-10-19：原来这里硬编码了本机绝对路径（带用户名）—— 换台机器就失效，
// 推到仓库还会把个人目录带出去。改成配置优先：ai.tools.oiwiki.dbPath，
// 其次环境变量，最后落到 <工作目录>/data/oiwiki.sqlite。
const DEFAULT_DB = process.env.MIMIRLINK_OIWIKI_DB
    || path.join(process.cwd(), 'data', 'oiwiki.sqlite');

import path from 'node:path';
import { createRequire } from 'node:module';
const nodeRequire = createRequire(import.meta.url);

let _db = null;
let _dbPath = '';

/**
 * 懒加载只读连接（单例）。库不存在就返回 null —— 调用方按"没配"处理。
 */
export function getOiwikiDb(dbPath = '') {
    const want = String(dbPath || DEFAULT_DB);
    if (_db && _dbPath === want) return _db;
    try {
        if (!nodeRequire('fs').existsSync(want)) return null;
        const Database = nodeRequire('better-sqlite3');
        _db = new Database(want, { readonly: true });
        _dbPath = want;
        return _db;
    } catch {
        return null;
    }
}

/** 从正文里抠出包含关键词的一段，尽量在段落边界断开。 */
export function excerptAround(text, keywords, maxChars = 1200) {
    const body = String(text || '');
    if (!body) return '';
    let pos = -1;
    for (const k of keywords) {
        const i = body.indexOf(k);
        if (i >= 0 && (pos < 0 || i < pos)) pos = i;
    }
    if (pos < 0) return body.slice(0, maxChars);

    const half = Math.floor(maxChars / 2);
    let start = Math.max(0, pos - half);
    let end = Math.min(body.length, start + maxChars);
    if (end - start < maxChars) start = Math.max(0, end - maxChars);

    // 往前找段落边界，别从半句话开始
    if (start > 0) {
        const nl = body.indexOf('\n', start);
        if (nl >= 0 && nl < pos) start = nl + 1;
    }
    if (end < body.length) {
        const nl = body.lastIndexOf('\n', end);
        if (nl > pos) end = nl;
    }
    const head = start > 0 ? '…' : '';
    const tail = end < body.length ? '…' : '';
    return head + body.slice(start, end).trim() + tail;
}

/** 把用户那句问题切成检索词（去掉常见虚词，中文按 2-4 字片段）。 */
export function extractKeywords(query) {
    const raw = String(query || '').trim();
    if (!raw) return [];
    const cleaned = raw
        .replace(/[，。！？、；：""''（）\[\]【】《》…—\s]+/g, ' ')
        .replace(/(怎么|如何|什么|为什么|能不能|可不可以|请问|帮我|告诉我|一下|的|了|吗|呢|啊|吧)/g, ' ')
        .trim();
    const parts = cleaned.split(/\s+/).filter((s) => s.length >= 2);
    // 原句整串也放进去：专有名词（线段树、树链剖分）整串命中更准
    const list = new Set();
    for (const p of parts) {
        list.add(p);
        if (p.length > 4) list.add(p.slice(0, 4));
    }
    if (raw.length >= 2 && raw.length <= 16) list.add(raw);
    return [...list].slice(0, 6);
}

/**
 * 查库。
 * @returns {{ok:boolean, query:string, keywords:string[], hits:Array, error?:string}}
 */
export function searchOiwiki(db, query, options = {}) {
    const limit = Math.max(1, Math.min(5, Number(options.limit) || 3));
    const maxChars = Math.max(300, Math.min(3000, Number(options.maxChars) || 1200));
    const keywords = extractKeywords(query);
    if (!db || keywords.length === 0) {
        return { ok: false, query: String(query || ''), keywords, hits: [], error: '没有可检索的关键词' };
    }

    let rows = [];
    try {
        // ⚠ 不能只发一条 `where (title LIKE ? OR text LIKE ?) limit N`：
        //   「AC」这类短词在正文里出现太多，前 N 条会被无关页占满，
        //   真正的「AC 自动机」根本进不了候选（实测踩过）。
        // ⇒ 标题命中和正文命中**分开查**，标题优先，再按 slug 去重合并。
        const rowsBySlug = new Map();
        for (const k of keywords) {
            const hits = db.prepare(
                'select slug, title, category, url, text, len from pages where title LIKE ? limit 25'
            ).all(`%${k}%`);
            for (const r of hits) rowsBySlug.set(r.slug, r);
        }
        for (const k of keywords) {
            const hits = db.prepare(
                'select slug, title, category, url, text, len from pages where text LIKE ? limit 40'
            ).all(`%${k}%`);
            for (const r of hits) {
                if (!rowsBySlug.has(r.slug)) rowsBySlug.set(r.slug, r);
            }
        }
        rows = [...rowsBySlug.values()];
    } catch (e) {
        return { ok: false, query: String(query || ''), keywords, hits: [], error: String(e?.message || e) };
    }

    const scored = rows.map((r) => {
        const title = String(r.title || '');
        const text = String(r.text || '');
        const chars = Number(r.len) || 0;
        // ⚠ 极短页基本是「本页面最近更新…」的占位（实测有 128 字的空页标题就叫「平衡树套线段树」），
        //   不排掉它就会把真正的专页顶下去。
        if (chars < 300) return null;
        let score = 0;
        for (const k of keywords) {
            if (title === k) {
                // 标题就是这个词 ⇒ 几乎肯定是正主（「二分」不该输给「WQS 二分」）
                score += 200;
            } else if (title.includes(k)) {
                score += 100;
                // 标题命中的页里，内容越全越可能是主页
                score += Math.min(30, Math.floor(chars / 3000));
                // 标题越长越可能是子话题（「WQS 二分」「上下界网络流」），压一点
                score -= Math.min(40, title.length * 2);
            } else if (text.includes(k)) {
                score += 10;
            }
        }
        // 正文命中但标题没中的，短页更可能是"专门讲这个"的，小幅加分
        if (score <= 10 * keywords.length) {
            score += Math.max(0, 10 - Math.floor(chars / 3000));
        }
        return { row: r, score };
    }).filter((x) => x && x.score > 0);

    scored.sort((a, b) => b.score - a.score);
    const hits = scored.slice(0, limit).map(({ row, score }) => ({
        title: row.title,
        slug: row.slug,
        url: row.url,
        category: row.category,
        chars: row.len,
        score,
        excerpt: excerptAround(row.text, keywords, maxChars)
    }));

    return { ok: hits.length > 0, query: String(query || ''), keywords, hits };
}

/** 把检索结果压成给模型看的一段文字。 */
export function formatOiwikiResult(result, maxTotalChars = 3000) {
    if (!result?.ok) {
        return `本地 OI Wiki 没查到「${result?.query || ''}」。`;
    }
    const parts = [];
    let used = 0;
    for (const h of result.hits) {
        const block = `【${h.title}】（${h.category}，${h.chars} 字）\n${h.excerpt}`;
        if (used + block.length > maxTotalChars) break;
        parts.push(block);
        used += block.length;
    }
    return parts.join('\n\n---\n\n');
}

export { DEFAULT_DB };
