/**
 * Prompt 构建模块
 * 组装轻量预设、摘要、世界书与角色信息。
 */

import { buildInputGuardrail } from './security.js';
import { buildCurrentMessageFocus, formatCurrentMessageFocus } from './current-message-focus.js';
import { createRuntimeSource, compactRuntimeSources } from './runtime/prompt-registry.js';
import { stripStructuredEnvelope } from './structured-envelope.js';
// >>> summary-identity-scrub patch >>>
// 摘要里的自我档案清洗：DB 原文不动，只在注入侧隔离（2026-10-17，见 summary-scrub.js）。
import { scrubSummaryIdentity, hasIdentityDossier } from './summary-scrub.js';
// <<< summary-identity-scrub patch <<<
// >>> profile-quote-scrub patch >>>
// 画像里的引号引语 = 台词本（2026-10-17，见 profile-scrub.js 头注释）。
import { scrubProfileQuotes, hasQuotedScript } from './profile-scrub.js';
// <<< profile-quote-scrub patch <<<
import { buildStickerHint } from './sticker-library.js';

function createNoopLogger() {
    return {
        debug() {},
        info() {},
        warn() {},
        error() {}
    };
}

/**
 * 「这段对话的形状」—— **纯计算，零 LLM 调用**。
 *
 * 起因（2026-10-13 用户）：他观察到 WorkBuddy 的 agent 能从日志里看出
 * 「这不像在测机器人」，而机器人看不出来。查证后的根因：
 * 她 prompt 里的【会话感知】只有 4 个字段（会话ID/类型/聚合数/触发原因）——
 * 🔴 **完全没有"形状"**。她只看得到"这一句"，看不到"这个人已经连着说了四十分钟、
 * 同一句话说了 5 遍、现在是凌晨三点"。
 * 而"这像不像在测试"恰恰是从**形状**里读出来的，不是从某一句话里。
 *
 * 🔑 **只喂事实，不喂结论**：给「深夜」「同一句出现 5 次」这种可核对的观察，
 * 让她自己去推"这人不对劲"。**不要**直接写"对方情绪不稳定"——
 * 那是替她下判断，她推错的代价比她没察觉更大（而且是不可核对的）。
 *
 * 数据来源：`recentMessages` 每条都带 `{role, content, timestamp}`（`session.js` 的行映射），
 * 所以这里不需要任何额外查询。
 */
export function buildConversationShape(messages = [], now = Date.now()) {
    const rows = (Array.isArray(messages) ? messages : [])
        .map((m) => ({
            role: m && m.role === 'assistant' ? 'assistant' : 'user',
            content: String((m && m.content) || ''),
            ts: Number(m && m.timestamp) || 0
        }))
        .filter((m) => m.content && m.ts > 0);
    if (rows.length < 3) {
        return [];
    }

    const out = [];

    // ① 只算**最近这一段连续对话**：往前直到出现一个超过 30 分钟的间隔就断开。
    //    否则会把昨天的事和今天的事混在一起算时长。
    const BREAK_MS = 30 * 60 * 1000;
    let start = rows.length - 1;
    for (let i = rows.length - 1; i > 0; i--) {
        if (rows[i].ts - rows[i - 1].ts > BREAK_MS) {
            break;
        }
        start = i - 1;
    }
    const seg = rows.slice(start);
    if (seg.length < 3) {
        return out;
    }

    const minutes = Math.max(1, Math.round((seg[seg.length - 1].ts - seg[0].ts) / 60000));
    const them = seg.filter((m) => m.role === 'user').length;
    const me = seg.filter((m) => m.role === 'assistant').length;
    if (minutes >= 5) {
        out.push(`最近 ${minutes} 分钟里：对方说了 ${them} 句，你说了 ${me} 句`);
    }

    // ② 同一件事反复出现（字符 bigram 重叠 ≥2 就算同一件，≥3 次才报）。
    //    ⚠ 不追求精确聚类 —— 只要"反复"这个信号够明显，就够了。
    const bigrams = (s) => {
        const set = new Set();
        for (let i = 0; i + 1 < s.length; i++) {
            set.add(s.slice(i, i + 2));
        }
        return set;
    };
    const theirs = seg
        .filter((m) => m.role === 'user')
        // 🔴 2026-10-13 修：必须先剥**结构化信封**，否则"反复出现的话"**每次都命中信封前缀**。
        //    原因：这里的 content 是带信封的 `[私聊|QQ:…|昵称:…|…|messageSegments:[{…}]] 正文`，
        //    任意两条信封的字符 bigram 必然大量重叠 ⇒ 恒定报
        //      「对方反复在说同一件事：「[私聊|QQ:2063362809|昵称:wer」（出现 12 次）」
        //    实测每轮都注入这句乱码，就压在「注意:」行前面（位置很显眼）。
        //    ⚠ 只剥信封还不够：`[图片]` 这类占位也要去掉（下面那句 replace 保留）。
        .map((m) => stripStructuredEnvelope(m.content).replace(/\[[^\]]{0,12}\]/g, '').trim())
        .filter((t) => t.length >= 4)
        // 压平换行：这条事实会被塞进提示词，带原始换行会让它变成好几行（看起来像好几条指令）
        .map((t) => ({ t: t.replace(/\s+/g, ' '), g: bigrams(t.replace(/\s+/g, ' ')) }));
    let best = null;
    for (let i = 0; i < theirs.length; i++) {
        let near = 0;
        for (let j = 0; j < theirs.length; j++) {
            if (i === j) {
                continue;
            }
            let shared = 0;
            for (const b of theirs[i].g) {
                if (theirs[j].g.has(b)) {
                    shared += 1;
                    if (shared >= 2) {
                        break;
                    }
                }
            }
            if (shared >= 2) {
                near += 1;
            }
        }
        const count = near + 1;
        if (count >= 3 && (!best || theirs[i].t.length > best.t.length)) {
            best = { t: theirs[i].t, count };
        }
    }
    if (best) {
        out.push(`对方反复在说同一件事：「${best.t.slice(0, 24)}」（出现 ${best.count} 次）`);
    }

    // ③ 时间点的人话 —— ⚠ **只在"不正常的时间"才加**（她本来就有【当前时间】，
    //    正常工作时间的重复没有信息量，白占 token）。
    const hour = new Date(now).getHours();
    const odd = hour < 5 ? '凌晨' : (hour < 8 ? '一大早' : (hour >= 23 ? '深夜' : ''));
    if (odd) {
        out.push(`现在是${odd}（${hour} 点）`);
    }
    return out;
}

export class PromptBuilder {
    constructor(characterManager, worldBookManager, config = {}, logger = null) {
        this.characterManager = characterManager;
        this.worldBookManager = worldBookManager;
        this.logger = logger || createNoopLogger();
        this.updateConfig(config);
    }

    updateConfig(config = {}, bindingPreset = null) {
        const presetConfig = PromptBuilder.normalizePreset(bindingPreset || config.preset || {});
        const contextConfig = config.context || {};
        const securityConfig = config.security || {};
        const chatConfig = config.chat || {};
        // >>> history-assistant-trim patch <<<
        this.chatConfig = chatConfig;
        // <<< history-assistant-trim patch <<<
        this.presetConfig = presetConfig;
        this.contextConfig = {
            enabled: contextConfig.enabled !== false,
            includeSessionFacts: contextConfig.includeSessionFacts !== false,
            includeParticipants: contextConfig.includeParticipants !== false,
            includeReplyReference: contextConfig.includeReplyReference !== false,
            includeRecentUserIntent: contextConfig.includeRecentUserIntent !== false
        };
        this.securityConfig = {
            inputGuardrailEnabled: securityConfig.inputGuardrailEnabled === true
        };
        this.humanChatControlConfig = {
            enabled: chatConfig.humanChatControlEnabled !== false,
            prompt: typeof chatConfig.humanChatControlPrompt === 'string'
                ? chatConfig.humanChatControlPrompt.trim()
                : ''
        };
    }

    // >>> example-dialogue patch (managed by patch_example_dialogue.py) >>>
    /**
     * 解析 SillyTavern 的示例对话（mes_example）。
     * 约定：`<START>` 分块；块内每行以 `{{user}}:` 或 `{{char}}:` 开头。
     * @returns {Array<{role:'user'|'assistant', content:string}>}
     */
    static parseExampleDialogue(text) {
        const raw = typeof text === 'string' ? text : '';
        if (!raw.trim()) return [];
        const turns = [];
        for (const block of raw.split(/<START>/i)) {
            for (const line of block.split(/\r?\n/)) {
                const s = line.trim();
                if (!s) continue;
                const m = s.match(/^\{\{\s*(user|char)\s*\}\}\s*[:：]?\s*(.+)$/i);
                if (!m) continue;
                const content = m[2].trim();
                if (!content) continue;
                turns.push({ role: m[1].toLowerCase() === 'user' ? 'user' : 'assistant', content });
            }
        }
        return turns;
    }
    // <<< example-dialogue patch <<<

    static normalizePromptBoolean(value, fallback = false) {
        if (value === undefined || value === null || value === '') {
            return fallback;
        }

        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase();
            if (['false', '0', 'off', 'no'].includes(normalized)) {
                return false;
            }
            if (['true', '1', 'on', 'yes'].includes(normalized)) {
                return true;
            }
        }

        return Boolean(value);
    }

    static normalizePromptInteger(value, fallback = 0) {
        const normalized = Number(value);
        return Number.isInteger(normalized) ? normalized : fallback;
    }

    static createPromptItem({
        identifier,
        name,
        role = 'system',
        content = '',
        enabled = true,
        injection_position = 0,
        injection_depth = 0,
        forbid_overrides = false,
        marker = false,
        system_prompt = false,
        sourceLabel = '',
        sourceKey = '',
        sourceType = '',
        sourceOrigin = '',
        sourceReadonly = false,
        sourceMeta = null
    } = {}) {
        return {
            identifier: String(identifier || '').trim(),
            name: String(name || '').trim(),
            role: String(role || 'system').trim() || 'system',
            content: typeof content === 'string' ? content : '',
            enabled: PromptBuilder.normalizePromptBoolean(enabled, true),
            injection_position: PromptBuilder.normalizePromptInteger(injection_position, 0),
            injection_depth: PromptBuilder.normalizePromptInteger(injection_depth, 0),
            forbid_overrides: PromptBuilder.normalizePromptBoolean(forbid_overrides, false),
            marker: PromptBuilder.normalizePromptBoolean(marker, false),
            system_prompt: PromptBuilder.normalizePromptBoolean(system_prompt, false),
            sourceLabel: String(sourceLabel || '').trim(),
            sourceKey: String(sourceKey || '').trim(),
            sourceType: String(sourceType || '').trim(),
            sourceOrigin: String(sourceOrigin || '').trim(),
            sourceReadonly: PromptBuilder.normalizePromptBoolean(sourceReadonly, false),
            sourceMeta: sourceMeta && typeof sourceMeta === 'object' ? { ...sourceMeta } : null
        };
    }

    static ensureBindingConfig(config = {}) {
        if (!config.bindings) {
            config.bindings = {
                global: {
                    memoryDbPath: null,
                    worldbook: null,
                    preset: null,
                    regexRules: null
                },
                characters: {}
            };
        }

        if (!config.bindings.global) {
            config.bindings.global = {
                memoryDbPath: null,
                worldbook: null,
                preset: null,
                regexRules: null
            };
        }

        if (!config.bindings.characters) {
            config.bindings.characters = {};
        }
    }

    static getCharacterBinding(config = {}, characterName) {
        PromptBuilder.ensureBindingConfig(config);
        return config.bindings.characters?.[characterName] || {
            memoryDbPath: null,
            worldbook: null,
            preset: null,
            regexRules: null,
            importedFromCard: {
                worldbook: null,
                preset: null,
                regexRules: []
            }
        };
    }

    static hasPresetContent(source = {}) {
        if (!source || typeof source !== 'object') {
            return false;
        }

        if (Array.isArray(source.prompts)) {
            return source.prompts.some((item) => typeof item?.content === 'string' && item.content.trim());
        }

        return [source.systemPrompt, source.postHistoryInstructions, source.jailbreak, source.assistantPrefill]
            .some((value) => typeof value === 'string' && value.trim());
    }

    static createPresetItemKey(item = {}, index = 0) {
        const identifier = String(item.identifier || '').trim();
        if (identifier) {
            return `identifier:${identifier}`;
        }

        return `fallback:${index}:${item.role || 'system'}:${item.name || ''}`;
    }

    static mergePresetLayers(layers = []) {
        const activeLayers = layers
            .filter((layer) => PromptBuilder.hasPresetContent(layer?.preset))
            .map((layer) => ({
                source: layer.source,
                preset: PromptBuilder.normalizePreset(layer.preset)
            }));

        if (activeLayers.length === 0) {
            return {
                preset: null,
                source: 'none',
                layers: [],
                itemSources: {},
                lockedIdentifiers: []
            };
        }

        const mergedItems = [];
        const itemSourceMap = new Map();
        const lockedIdentifiers = new Set();

        for (const layer of activeLayers) {
            for (let index = 0; index < layer.preset.prompts.length; index += 1) {
                const normalizedItem = PromptBuilder.createPromptItem(layer.preset.prompts[index]);
                if (!normalizedItem.content.trim()) {
                    continue;
                }

                const key = PromptBuilder.createPresetItemKey(normalizedItem, index);
                const existingIndex = mergedItems.findIndex((item, itemIndex) => PromptBuilder.createPresetItemKey(item, itemIndex) === key);
                const nextItem = {
                    ...normalizedItem,
                    preset_source: layer.source
                };

                if (existingIndex === -1) {
                    mergedItems.push(nextItem);
                    itemSourceMap.set(key, layer.source);
                    if (normalizedItem.forbid_overrides === true && normalizedItem.identifier) {
                        lockedIdentifiers.add(normalizedItem.identifier);
                    }
                    continue;
                }

                const existingItem = mergedItems[existingIndex];
                if (existingItem.forbid_overrides === true) {
                    if (existingItem.identifier) {
                        lockedIdentifiers.add(existingItem.identifier);
                    }
                    continue;
                }

                mergedItems[existingIndex] = nextItem;
                itemSourceMap.set(key, layer.source);
                if (normalizedItem.forbid_overrides === true && normalizedItem.identifier) {
                    lockedIdentifiers.add(normalizedItem.identifier);
                }
            }
        }

        const contributingSources = [...new Set(mergedItems.map((item) => item.preset_source).filter(Boolean))];
        const highestSource = contributingSources.at(-1) || activeLayers.at(-1)?.source || 'none';

        return {
            preset: {
                enabled: true,
                name: activeLayers.at(-1)?.preset?.name || activeLayers[0]?.preset?.name || '',
                prompts: mergedItems,
                regexRules: activeLayers.at(-1)?.preset?.regexRules || []
            },
            source: contributingSources.length === 1 ? highestSource : 'merged',
            layers: activeLayers.map((layer) => layer.source),
            itemSources: Object.fromEntries(itemSourceMap.entries()),
            lockedIdentifiers: [...lockedIdentifiers]
        };
    }

    static hasBindingValue(value) {
        if (Array.isArray(value)) {
            return value.length > 0;
        }

        if (value && typeof value === 'object') {
            return Object.keys(value).length > 0;
        }

        return value !== null && value !== undefined && value !== '';
    }

    static getPresetResolution(config = {}, characterName) {
        PromptBuilder.ensureBindingConfig(config);
        const binding = PromptBuilder.getCharacterBinding(config, characterName);
        const candidates = [
            { source: 'character_binding', preset: binding.preset },
            { source: 'imported_from_card', preset: binding.importedFromCard?.preset },
            { source: 'global', preset: config.bindings.global.preset },
            { source: 'legacy', preset: config.preset }
        ];
        const selected = candidates.find((candidate) => PromptBuilder.hasPresetContent(candidate.preset));

        if (!selected) {
            return {
                preset: null,
                source: 'none',
                layers: [],
                itemSources: {},
                lockedIdentifiers: []
            };
        }

        const normalizedPreset = PromptBuilder.normalizePreset(selected.preset);
        const itemSources = {};
        const lockedIdentifiers = [];
        const prompts = normalizedPreset.prompts
            .map((item, index) => {
                const normalizedItem = PromptBuilder.createPromptItem(item);
                if (!normalizedItem.content.trim()) {
                    return null;
                }

                const key = PromptBuilder.createPresetItemKey(normalizedItem, index);
                itemSources[key] = selected.source;
                if (normalizedItem.forbid_overrides === true && normalizedItem.identifier) {
                    lockedIdentifiers.push(normalizedItem.identifier);
                }
                return {
                    ...normalizedItem,
                    preset_source: selected.source
                };
            })
            .filter(Boolean);

        return {
            preset: {
                ...normalizedPreset,
                prompts
            },
            source: selected.source,
            layers: [selected.source],
            itemSources,
            lockedIdentifiers
        };
    }

    static getRegexResolution(config = {}, characterName) {
        PromptBuilder.ensureBindingConfig(config);
        const binding = PromptBuilder.getCharacterBinding(config, characterName);
        const presetResolution = PromptBuilder.getPresetResolution(config, characterName);
        const resolveSource = (explicitValue, importedValue, globalValue, legacyValue) => {
            if (PromptBuilder.hasBindingValue(explicitValue)) return 'character_binding';
            if (PromptBuilder.hasBindingValue(importedValue)) return 'imported_from_card';
            if (PromptBuilder.hasBindingValue(globalValue)) return 'global';
            if (PromptBuilder.hasBindingValue(legacyValue)) return 'legacy';
            return 'none';
        };

        const globalSource = resolveSource(null, null, config.bindings.global.regexRules, config.regex?.rules);
        const globalRules = config.bindings.global.regexRules || config.regex?.rules || [];
        const characterSource = resolveSource(binding.regexRules, binding.importedFromCard?.regexRules, null, null);
        const characterRules = binding.regexRules || binding.importedFromCard?.regexRules || [];
        const presetRules = presetResolution.preset?.regexRules || [];

        return {
            regexRules: {
                source: characterSource,
                count: characterRules.length,
                value: characterRules
            },
            presetRegexRules: {
                source: presetResolution.source,
                layers: presetResolution.layers,
                count: presetRules.length,
                value: presetRules
            },
            globalRegexRules: {
                source: globalSource,
                count: globalRules.length,
                value: globalRules
            }
        };
    }

    static getEffectiveBinding(config = {}, characterName) {
        PromptBuilder.ensureBindingConfig(config);
        const binding = PromptBuilder.getCharacterBinding(config, characterName);
        const presetResolution = PromptBuilder.getPresetResolution(config, characterName);
        const regexResolution = PromptBuilder.getRegexResolution(config, characterName);
        return {
            memoryDbPath: binding.memoryDbPath || config.bindings.global.memoryDbPath || config.memory?.storage?.path || null,
            worldbook: binding.worldbook || binding.importedFromCard?.worldbook || config.bindings.global.worldbook || null,
            preset: presetResolution.preset || null,
            globalRegexRules: regexResolution.globalRegexRules.value,
            presetRegexRules: regexResolution.presetRegexRules.value,
            regexRules: regexResolution.regexRules.value
        };
    }

    static createLegacyPromptItems(source = {}) {
        const items = [];

        if (typeof source.systemPrompt === 'string' && source.systemPrompt.trim()) {
            items.push(PromptBuilder.createPromptItem({
                identifier: 'main',
                name: 'Main Prompt',
                role: 'system',
                content: source.systemPrompt,
                injection_position: 0,
                system_prompt: true
            }));
        }

        if (typeof source.postHistoryInstructions === 'string' && source.postHistoryInstructions.trim()) {
            items.push(PromptBuilder.createPromptItem({
                identifier: 'post-history',
                name: 'Post-History Instructions',
                role: 'system',
                content: source.postHistoryInstructions,
                injection_position: 1,
                system_prompt: true
            }));
        }

        if (typeof source.jailbreak === 'string' && source.jailbreak.trim()) {
            items.push(PromptBuilder.createPromptItem({
                identifier: 'jailbreak',
                name: 'Jailbreak',
                role: 'system',
                content: source.jailbreak,
                injection_position: 0,
                system_prompt: true
            }));
        }

        if (typeof source.assistantPrefill === 'string' && source.assistantPrefill.trim()) {
            items.push(PromptBuilder.createPromptItem({
                identifier: 'assistant-prefill',
                name: 'Assistant Prefill',
                role: 'assistant',
                content: source.assistantPrefill,
                injection_position: 1,
                system_prompt: false
            }));
        }

        return items;
    }

    static createDefaultPromptItems() {
        return [
            PromptBuilder.createPromptItem({
                identifier: 'main',
                name: 'Main Prompt',
                role: 'system',
                content: '',
                injection_position: 0,
                system_prompt: true
            }),
            PromptBuilder.createPromptItem({
                identifier: 'jailbreak',
                name: 'Jailbreak',
                role: 'system',
                content: '',
                injection_position: 0,
                system_prompt: true
            }),
            PromptBuilder.createPromptItem({
                identifier: 'post-history',
                name: 'Post-History Instructions',
                role: 'system',
                content: '',
                injection_position: 1,
                system_prompt: true
            }),
            PromptBuilder.createPromptItem({
                identifier: 'assistant-prefill',
                name: 'Assistant Prefill',
                role: 'assistant',
                content: '',
                injection_position: 1,
                system_prompt: false
            })
        ];
    }

    static normalizePreset(source = {}) {
        const prompts = Array.isArray(source.prompts) && source.prompts.length > 0
            ? source.prompts
                .map((item) => PromptBuilder.createPromptItem(item))
            : PromptBuilder.createLegacyPromptItems(source);
        const hasPromptContent = prompts.some((item) => item.content.trim());

        return {
            enabled: source.enabled === true,
            name: typeof source.name === 'string' ? source.name : '',
            prompts: hasPromptContent ? prompts : PromptBuilder.createDefaultPromptItems(),
            regexRules: Array.isArray(source.regexRules) ? source.regexRules : []
        };
    }

    static partitionPromptItems(presetConfig = {}) {
        const items = presetConfig.enabled === true && Array.isArray(presetConfig.prompts)
            ? presetConfig.prompts.filter((item) => item.enabled !== false && item.content.trim())
            : [];
        const systemItems = items.filter((item) => item.role === 'system');

        return {
            preSystem: systemItems.filter((item) => item.injection_position !== 1 && Number(item.injection_depth || 0) <= 0),
            historyInjection: systemItems.filter((item) => item.injection_position !== 1 && Number(item.injection_depth || 0) > 0),
            postHistory: systemItems.filter((item) => item.injection_position === 1),
            assistantPrefill: items.filter((item) => item.role === 'assistant')
        };
    }

    static resolvePresetSegmentKind(item, fallbackKind) {
        return item?.marker === true ? 'preset_marker' : fallbackKind;
    }

    static resolveWorldBookPosition(value) {
        const normalized = Number(value);
        if (Number.isFinite(normalized)) {
            return normalized === 1 ? 1 : 0;
        }

        if (typeof value === 'string') {
            const compact = value.trim().toLowerCase();
            if ([
                '1',
                'after',
                'after_char',
                'after_character',
                'after_description',
                'post',
                'post_history',
                'post-history'
            ].includes(compact)) {
                return 1;
            }
        }

        return 0;
    }

    static resolveWorldBookPlacement(entry = {}) {
        const position = PromptBuilder.resolveWorldBookPosition(entry.position);
        return position === 1 ? 'post_history' : 'system';
    }

    static createRuntimeSegment({
        id,
        kind,
        label,
        content = '',
        stage = 'runtime',
        order = 0,
        meta = {}
    } = {}) {
        return {
            id: String(id || '').trim(),
            kind: String(kind || 'unknown').trim(),
            label: String(label || '').trim(),
            content: typeof content === 'string' ? content : '',
            stage: String(stage || 'runtime').trim(),
            order: Number.isFinite(order) ? order : 0,
            meta: meta && typeof meta === 'object' ? meta : {}
        };
    }

    static compactRuntimeSegments(segments = []) {
        return segments
            .filter((segment) => segment && String(segment.content || '').trim())
            .sort((left, right) => {
                const orderDelta = (left.order || 0) - (right.order || 0);
                if (orderDelta !== 0) {
                    return orderDelta;
                }

                return String(left.id || '').localeCompare(String(right.id || ''));
            });
    }

    static createMessageTrace(messages = [], runtimeSources = []) {
        const sourceMatchesMessage = (source, message) => {
            if (!source || !message) {
                return false;
            }

            const role = message.role || 'unknown';
            const placement = source.meta?.placement || 'system';

            if (role === 'system') {
                if (message.meta?.source === 'current_message_focus') {
                    return placement === 'current_message_focus' && source.id === message.meta?.sourceId;
                }

                if (message.meta?.source === 'post_history') {
                    return placement === 'post_history';
                }

                if (message.meta?.source === 'history_injection') {
                    return placement === 'history_injection' && source.id === message.meta?.sourceId;
                }

                return placement === 'system';
            }

            if (role === 'assistant') {
                if (message.meta?.source === 'first_message') {
                    return source.kind === 'character_first_message';
                }

                if (message.meta?.source === 'history') {
                    return source.kind === 'history_message' && source.id === message.meta?.sourceId;
                }

                if (message.meta?.source === 'assistant_prefill') {
                    return placement === 'assistant_prefill';
                }

                return false;
            }

            if (role === 'user') {
                if (message.meta?.source === 'history') {
                    return source.kind === 'history_message' && source.id === message.meta?.sourceId;
                }

                return source.kind === 'user_input';
            }

            if (role === 'history') {
                return source.kind === 'history_message';
            }

            return false;
        };

        return messages.map((message, index) => {
            const matchedSources = runtimeSources.filter((source) => sourceMatchesMessage(source, message));
            return {
                index,
                role: message.role,
                sourceStages: [...new Set(matchedSources.map((source) => source.stage).filter(Boolean))],
                sourceIds: [...new Set(matchedSources.map((source) => source.id).filter(Boolean))],
                sourceSlots: [...new Set(matchedSources.map((source) => source.sourceSlot).filter(Boolean))]
            };
        });
    }

    buildHumanChatControl() {
        return this.humanChatControlConfig.prompt || '';
    }

    buildRuntimeComposition({
        normalizedContext,
        runtimeContext,
        activePreset,
        character,
        worldBookEntries,
        userMessage
    }) {
        const { preSystem, historyInjection, postHistory, assistantPrefill } = PromptBuilder.partitionPromptItems(activePreset);
        const now = new Date();
        const timeStr = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        const systemSegments = [
            PromptBuilder.createRuntimeSegment({
                id: 'current-time',
                kind: 'current_time',
                label: '当前时间',
                content: `【当前时间】${timeStr}`,
                stage: 'runtime',
                order: 0,
                meta: { placement: 'system' }
            })
        ];

        if (this.contextConfig.enabled) {
            const situationalContext = this.buildSituationalContext(normalizedContext, runtimeContext);
            if (situationalContext) {
                systemSegments.push(PromptBuilder.createRuntimeSegment({
                    id: 'situational-context',
                    kind: 'situational_context',
                    label: '会话上下文',
                    content: situationalContext,
                    stage: 'runtime',
                    order: 10,
                    meta: { placement: 'system' }
                }));
            }
        }

        if (this.securityConfig.inputGuardrailEnabled) {
            systemSegments.push(PromptBuilder.createRuntimeSegment({
                id: 'input-guardrail',
                kind: 'input_guardrail',
                label: '输入护栏',
                content: buildInputGuardrail(runtimeContext.injectionRisk),
                stage: 'runtime',
                order: 15,
                meta: { placement: 'system' }
            }));
        }

        const humanChatControlPrompt = this.buildHumanChatControl();
        if (this.humanChatControlConfig.enabled && humanChatControlPrompt) {
            systemSegments.push(PromptBuilder.createRuntimeSegment({
                id: 'human-chat-control-v2',
                kind: 'human_chat_control',
                label: '人类群聊决策规则',
                content: humanChatControlPrompt,
                stage: 'runtime',
                order: 16,
                meta: { placement: 'system' }
            }));
        }

        systemSegments.push(...preSystem.map((item, index) => PromptBuilder.createRuntimeSegment({
            id: item.identifier,
            kind: PromptBuilder.resolvePresetSegmentKind(item, 'preset_pre_system'),
            label: item.name || item.identifier,
            content: item.content,
            stage: 'preset',
            order: 20 + index,
            meta: {
                placement: 'system',
                role: item.role,
                injection_position: item.injection_position,
                injection_depth: item.injection_depth,
                system_prompt: item.system_prompt === true,
                marker: item.marker === true,
                forbid_overrides: item.forbid_overrides === true
            }
        })));

        // >>> summary-identity-scrub patch >>>
        // 🔴 这里必须洗：摘要里长期写着「Bot 为…人设(…，生日…)」这类第三人称自我档案，
        // 而 index.js 的 summaryLimit=2 ⇒ 每轮都注入最近两条。不洗的话角色会照念档案
        // （实测：被问「你是谁」答「长崎素世 / 月之森二年级的」）。
        // >>> summary-episodic-framing patch >>>
        // 🔴 摘要里的**定性**会变成不可动摇的人格。实测 soyo 的摘要写着
        //    「关系：…素世底线清晰（…），对爱音仍回避…」「素世明确拒绝看」
        //    —— 无时间、无场合、无理由，而 summaryLimit=2 ⇒ 每轮注入，
        //    她把「某一次的拒绝」读成了「我是这种人」。
        //
        // 人记的是情景（那天他在上课发图，我让他好好上课），不是定性（我是拒绝派）。
        // 这里不删摘要内容（DB 原文不动，见 §52.11 的先例），只加一句框定，
        // 而且**只加在最后一条的末尾** —— 按 §5.1，最后读到的位置杠杆最高，
        // 每一条都加则会注入两遍、白占 token。
        //
        // 文案口径：肯定式、只描述"会变化"这个情境，⛔ 不写"这不是你的立场"（否定句
        // 会二次 priming），⛔ 不举反例（列举 ⇒ 收敛到第一个），⛔ 不规定她怎么回。
        // 只保留「这是什么」的定位，去掉「会变」的弱化 ——
        // 「每一条都只是当时那一次的反应」会让她觉得自己的话说出来不算数，
        // 表现就是附和、随和、没有刺（用户 2026-10-18：「私聊好像也变笨了」）。
        // 防死板已经由「删掉摘要里的定性总评」承担，这里只需要承认分量。
        const episodicFraming = '\n（以上是过去几次聊天里实际发生过的经过 —— 谁说了什么、谁怎么应的，都算数。）';
        const summaryList = Array.isArray(normalizedContext.summaries) ? normalizedContext.summaries : [];
        systemSegments.push(...summaryList.map((summary, index) => {
            const rawSummary = String(summary.content || '');
            const cleanSummary = scrubSummaryIdentity(rawSummary);
            if (cleanSummary !== rawSummary) {
                this.logger?.debug?.('[摘要清洗] 已剥离身份档案', {
                    index,
                    before: rawSummary.length,
                    after: cleanSummary.length,
                    stillHasDossier: hasIdentityDossier(cleanSummary)
                });
            }
            const framing = index === summaryList.length - 1 ? episodicFraming : '';
            return PromptBuilder.createRuntimeSegment({
                id: `summary-${index}`,
                kind: 'summary',
                label: `摘要 ${index + 1}`,
                content: `【历史摘要】\n${cleanSummary}${framing}`,
                stage: 'memory',
                order: 40 + index,
                meta: { placement: 'system' }
            });
        }));
        // <<< summary-episodic-framing patch <<<
        // <<< summary-identity-scrub patch <<<

        if (Array.isArray(runtimeContext.recalledEntries) && runtimeContext.recalledEntries.length > 0) {
            const fixedKnowledgeEntries = runtimeContext.recalledEntries.filter((entry) => entry?.sourceKind === 'knowledge_fixed');
            const dynamicKnowledgeEntries = runtimeContext.recalledEntries.filter((entry) => entry?.sourceKind === 'knowledge_dynamic');
            const otherRecallEntries = runtimeContext.recalledEntries.filter((entry) => !['knowledge_fixed', 'knowledge_dynamic'].includes(entry?.sourceKind));
            const renderRecallEntries = (entries, title) => {
                if (!entries.length) {
                    return null;
                }
                return [
                    title,
                    ...entries.map((entry) => {
                        const itemTitle = entry.title ? `${entry.title}: ` : '';
                        const reason = entry.recallReason ? ` [${entry.recallReason}]` : '';
                        return `${itemTitle}${entry.content}${reason}`;
                    })
                ].join('\n');
            };
            const recallSections = [
                renderRecallEntries(fixedKnowledgeEntries, '【固定知识】'),
                renderRecallEntries(dynamicKnowledgeEntries, '【动态知识】'),
                renderRecallEntries(otherRecallEntries, '【其他召回】')
            ].filter(Boolean);

            systemSegments.push(PromptBuilder.createRuntimeSegment({
                id: 'database-recall',
                kind: 'database_recall',
                label: '数据库召回',
                content: [
                    '【数据库召回】',
                    ...recallSections
                ].join('\n\n'),
                stage: 'memory',
                order: 50,
                meta: { placement: 'system' }
            }));
        }


        if (character.description) {
            systemSegments.push(PromptBuilder.createRuntimeSegment({
                id: 'character-description',
                kind: 'character_description',
                label: '角色描述',
                content: `【角色描述】\n${character.description}`,
                stage: 'character',
                order: 80,
                meta: { placement: 'system' }
            }));
        }

        if (character.personality) {
            systemSegments.push(PromptBuilder.createRuntimeSegment({
                id: 'character-personality',
                kind: 'character_personality',
                label: '角色性格',
                content: `【${character.name}的性格】\n${character.personality}`,
                stage: 'character',
                order: 81,
                meta: { placement: 'system' }
            }));
        }

        if (character.scenario) {
            systemSegments.push(PromptBuilder.createRuntimeSegment({
                id: 'scenario',
                kind: 'scenario',
                label: '场景',
                content: `【场景】\n${character.scenario}`,
                stage: 'character',
                order: 82,
                meta: { placement: 'system' }
            }));
        }

        if (character.system_prompt) {
            systemSegments.push(PromptBuilder.createRuntimeSegment({
                id: 'character-system-prompt',
                kind: 'character_system_prompt',
                label: '角色系统提示',
                content: character.system_prompt,
                stage: 'character',
                order: 83,
                meta: { placement: 'system' }
            }));
        }

        const historyInjectionSegments = PromptBuilder.compactRuntimeSegments(
            historyInjection.map((item, index) => PromptBuilder.createRuntimeSegment({
                id: item.identifier,
                kind: PromptBuilder.resolvePresetSegmentKind(item, 'preset_injection'),
                label: item.name || item.identifier,
                content: item.content,
                stage: 'preset',
                order: 95 + index,
                meta: {
                    placement: 'history_injection',
                    role: item.role,
                    injection_position: item.injection_position,
                    injection_depth: item.injection_depth,
                    system_prompt: item.system_prompt === true,
                    marker: item.marker === true,
                    forbid_overrides: item.forbid_overrides === true,
                    insertionIndex: Math.max(0, Math.min(normalizedContext.recentMessages.length, Number(item.injection_depth || 0)))
                }
            }))
        );

        // >>> history-assistant-trim patch (managed by patch_history_trim.py) >>>
        // 模型会照着上下文里「它自己过去的回复」的长度继续写。实测：私聊历史里
        // 17 条 assistant 消息中位 45 字 ⇒ 生成结果中位 62 字。把这 17 条压成
        // 各自的第一条分段（本来就是短句）之后，生成结果明显变短。
        // 只改喂给模型的文本，不动 sqlite 里存的内容，用户说的话一个字不改。
        const trimChatCfg = this.chatConfig || {};
        const trimOn = trimChatCfg.historyAssistantTrim !== false;
        const trimMax = Math.max(0, Number(trimChatCfg.historyAssistantMaxChars) || 24);
        // >>> hallucination-fix patch >>>
        // 🔴 原实现「只留首行 + 切到 24 字」把她的历史压成了**重复碎片**：
        //      没有那种东西 / 去吃饭        → 没有那种东西
        //      没有那种东西 / 食堂就在楼下   → 没有那种东西
        //      谁跟你说的 / 小爱音才不会…    → 谁跟你说的
        //    ⇒ 她看到的自己是一串一模一样的短语，**只能靠编来补上下文**。
        //    （reasoning 里实测出现过「不要重复'没有那种东西'」——她在跟碎片搏斗。）
        // 长度改由「注意:」行的长度锚点 + chat.humanShapeHint 管（最高杠杆位置），
        // 历史只需要**保住"她在说什么"**。⇒ 留前 N 行、总长 ≤ M 字。
        const trimLinesRaw = Number(trimChatCfg?.historyAssistantMaxLines);
        const trimLinesMax = Number.isFinite(trimLinesRaw) && trimLinesRaw > 0
            ? Math.floor(trimLinesRaw) : 2;
        const shortenHistoryAssistant = (content) => {
            const raw = String(content === undefined || content === null ? '' : content);
            if (!trimOn) return raw;
            const lines = raw.split(/\r?\n/).map((part) => part.trim()).filter(Boolean);
            if (!lines.length) return raw.trim();
            let out = '';
            for (const line of lines.slice(0, trimLinesMax)) {
                const next = out ? (out + '\n' + line) : line;
                if (next.length > trimMax) break;
                out = next;
            }
            if (!out) out = lines[0].slice(0, trimMax);
            return out;
        };
        // <<< hallucination-fix patch <<<
        // <<< history-assistant-trim patch <<<
// >>> compact-history-user patch >>>
// 把用户消息的结构化头 [私聊|QQ|昵称|…|messageSegments:[…]] 压成 [昵称 时:分:秒]。
// 头里的 messageSegments 是 JSON，把正文重复一遍；群号/群名在私聊是 N/A；
// eventType/isAtBot 对历史轮次无意义。但**昵称要留**（群聊靠它区分发言人）。
const compactHistoryUser = (content) => {
    const src = String(content === undefined || content === null ? '' : content);
    let out = src;
    for (let guard = 0; guard < 24; guard += 1) {
        const start = out.search(/\[(?:群聊|私聊)\|/);
        if (start < 0) break;
        // 括号配对找头的结尾：messageSegments:[{…}] 内部含 ']'
        let depth = 0;
        let end = -1;
        for (let i = start; i < out.length; i += 1) {
            const ch = out[i];
            if (ch === '[') depth += 1;
            else if (ch === ']') {
                depth -= 1;
                if (depth === 0) { end = i; break; }
            }
        }
        if (end < 0) break;                       // 配不上就原样留着，别吃正文
        const head = out.slice(start, end + 1);
        const name = (head.match(/昵称:([^|\]]*)/) || [])[1] || '';
        // QQ 号必须留：昵称会改，QQ 不变 —— 它是**跨群聊/跨会话识别同一个人**的唯一凭据。
        // 格式沿用 MimirLink 自己的 buildParticipants()：`昵称(QQ)`。
        const qq = (head.match(/QQ:([^|\]]*)/) || [])[1] || '';
        const time = (head.match(/时间:([^|\]]*)/) || [])[1] || '';
        let tag = '';
        if (name || qq || time) {
            const who = name && qq ? `${name}(${qq})` : (name || qq);
            const hm = time ? time.slice(-8) : '';
            tag = `[${who}${hm ? ' ' + hm : ''}] `;
        }
        out = out.slice(0, start) + tag + out.slice(end + 1);
    }
    // 引用前缀 [回复上文|…] 在历史轮次里也只是噪音。
    // 🔴 2026-10-14 修：原来写 `[^\]]*`，会在**第一个** `]` 就停 ——
    //   而信封里可能嵌套方括号（`内容:[图片:[动画表情]]]`），于是删完还剩一截 `]]`
    //   留在历史正文里（实测真的渲染出 `[白(1000000004) 10:45:24] ]]` 这种行）。
    //   改成共用 `stripStructuredEnvelope`（括号配平，且只留一份实现）。
    out = stripStructuredEnvelope(out);
    return out.replace(/[ \t]{2,}/g, ' ').replace(/\n{2,}/g, '\n').trim();
};
// <<< compact-history-user patch <<<
        const historyMessages = normalizedContext.recentMessages.map((message, index) => ({
            role: message.role,
            content: message.role === 'assistant'
                ? shortenHistoryAssistant(message.content)
                : compactHistoryUser(message.content),
            meta: {
                source: 'history',
                sourceId: `history-${index}`
            }
        }));

        const worldBookSystemSegments = [];
        const worldBookPostHistorySegments = [];
        for (let index = 0; index < worldBookEntries.length; index += 1) {
            const entry = worldBookEntries[index];
            const placement = PromptBuilder.resolveWorldBookPlacement(entry);
            const segment = PromptBuilder.createRuntimeSegment({
                id: `worldbook-${index}`,
                kind: 'worldbook_entry',
                label: entry.key || `世界书条目 ${index + 1}`,
                // 2026-10-19：「世界设定」会把她的资料读成"外部文档"——
                // 她读到了 KMP 的说明，却在思考里写「那只是世界设定，不是爱音的知识」。
                // 同一个词换成「记忆」的视角，让它成为她知道的事。
                content: `【你了解的】\n${entry.content}`,
                stage: 'worldbook',
                order: 60 + index,
                meta: {
                    placement,
                    position: PromptBuilder.resolveWorldBookPosition(entry.position),
                    sticky: entry.sticky || 0,
                    triggeredByKeyword: entry.triggeredByKeyword,
                    triggeredBySticky: entry.triggeredBySticky
                }
            });

            if (placement === 'post_history') {
                worldBookPostHistorySegments.push(segment);
                continue;
            }

            worldBookSystemSegments.push(segment);
        }

        systemSegments.push(...worldBookSystemSegments);

        const postHistorySegments = PromptBuilder.compactRuntimeSegments([
            ...worldBookPostHistorySegments,
            ...postHistory.map((item, index) => PromptBuilder.createRuntimeSegment({
                id: item.identifier,
                kind: PromptBuilder.resolvePresetSegmentKind(item, 'preset_post_history'),
                label: item.name || item.identifier,
                content: item.content,
                stage: 'preset',
                order: 100 + index,
                meta: {
                    placement: 'post_history',
                    role: item.role,
                    injection_position: item.injection_position,
                    injection_depth: item.injection_depth,
                    system_prompt: item.system_prompt === true,
                    marker: item.marker === true,
                    forbid_overrides: item.forbid_overrides === true
                }
            }))
        ]);

        const currentMessageFocusText = formatCurrentMessageFocus(buildCurrentMessageFocus({
            ...runtimeContext,
            currentUserMessage: userMessage
        }, {
            // >>> style-anchor-config patch <<<
            // 范句随角色走：anon 和 soyo 的语气是反的，不能共用一句
            styleAnchor: (this.chatConfig || {}).styleAnchor,
            // >>> human-shape patch >>>
            humanShapeHint: (this.chatConfig || {}).humanShapeHint,
            // <<< human-shape patch <<<
            // <<< style-anchor-config patch <<<
            // >>> participant-roster patch >>>
            // 对方提到的人正好在联系人名单里时，那句提示要落在「注意:」行（最后读到的位置）。
            // ⚠ 必须是**消息级**才知道的，所以从 runtimeContext 带过来，不在本文件算。
            participantRosterMention: runtimeContext.participantRosterMention || '',
            // <<< participant-roster patch <<<
            // >>> sticker-send patch >>>
            // 她能**发**表情包：告诉她标记怎么写 + 本地库里有哪些类别。
            // 类别名是由**目录里真实存在的子目录**算出来的，所以用户往 data/stickers/ 丢图后
            // 不用重启（库内部有 30s TTL 的扫描缓存）。
            stickerHint: buildStickerHint(this.chatConfig || {}),
            // <<< sticker-send patch <<<
// >>> send-status patch >>>
            sendFailureHint: runtimeContext.sendFailureHint || '',
            // >>> mood-carry patch >>>
            moodHint: runtimeContext.moodHint || ''
            // <<< mood-carry patch <<<
// <<< send-status patch <<<
        }));
        const currentMessageFocusSegment = PromptBuilder.createRuntimeSegment({
            id: 'current-message-focus',
            kind: 'current_message_focus',
            label: '当前消息决策',
            content: currentMessageFocusText,
            stage: 'runtime',
            order: 129,
            meta: { placement: 'current_message_focus' }
        });

        const assistantPrefillSegments = PromptBuilder.compactRuntimeSegments(
            assistantPrefill.map((item, index) => PromptBuilder.createRuntimeSegment({
                id: item.identifier,
                kind: PromptBuilder.resolvePresetSegmentKind(item, 'preset_assistant'),
                label: item.name || item.identifier,
                content: item.content,
                stage: 'preset',
                order: 120 + index,
                meta: {
                    placement: 'assistant_prefill',
                    role: item.role,
                    injection_position: item.injection_position,
                    injection_depth: item.injection_depth,
                    system_prompt: item.system_prompt === true,
                    marker: item.marker === true,
                    forbid_overrides: item.forbid_overrides === true
                }
            }))
        );

        const runtimeSources = compactRuntimeSources([
            ...PromptBuilder.compactRuntimeSegments(systemSegments).map((segment) => createRuntimeSource(segment)),
            ...historyMessages.map((message) => createRuntimeSource({
                id: message.meta.sourceId,
                kind: 'history_message',
                label: '历史消息',
                content: message.content,
                stage: 'history',
                order: 90,
                meta: {
                    placement: 'history',
                    role: message.role
                }
            })),
            ...historyInjectionSegments.map((segment) => createRuntimeSource(segment)),
            ...postHistorySegments.map((segment) => createRuntimeSource(segment)),
            createRuntimeSource(currentMessageFocusSegment),
            createRuntimeSource({
                id: 'user-input',
                kind: 'user_input',
                label: '当前用户输入',
                content: userMessage,
                stage: 'input',
                order: 130,
                meta: { placement: 'user_input' }
            }),
            ...assistantPrefillSegments.map((segment) => createRuntimeSource(segment)),
            ...(normalizedContext.recentMessages.length === 0 && character.first_mes
                ? [createRuntimeSource({
                    id: 'character-first-message',
                    kind: 'character_first_message',
                    label: '角色开场白',
                    content: character.first_mes,
                    stage: 'character',
                    order: 89,
                    meta: { placement: 'assistant_opening' }
                })]
                : [])
        ]);

        return {
            systemSegments: PromptBuilder.compactRuntimeSegments(systemSegments),
            historyMessages,
            historyInjectionSegments,
            postHistorySegments,
            currentMessageFocusSegment,
            assistantPrefillSegments,
            runtimeSources
        };
    }

    async build(characterName, userMessage, context = {}, stickyKeys = new Set(), runtimeContext = {}, runtimeOverrides = {}) {
        const startedAt = Date.now();
        const normalizedContext = Array.isArray(context)
            ? { recentMessages: context, summaries: [] }
            : {
                recentMessages: context.recentMessages || [],
                summaries: context.summaries || []
            };

        this.logger.debug?.('[Prompt] 开始构建', {
            characterName,
            recentMessageCount: normalizedContext.recentMessages.length,
            summaryCount: normalizedContext.summaries.length,
            stickyKeyCount: stickyKeys instanceof Set ? stickyKeys.size : 0,
            userMessage: {
                length: String(userMessage || '').trim().length,
                preview: String(userMessage || '').trim().slice(0, 120)
            },
            runtimeContext: {
                sessionId: runtimeContext?.sessionId || '',
                messageType: runtimeContext?.messageType || '',
                messageCount: runtimeContext?.messageCount || 0,
                participantCount: Array.isArray(runtimeContext?.participants) ? runtimeContext.participants.length : 0,
                hasReplyReference: !!runtimeContext?.replyReference,
                hasCurrentSpeakerProfile: !!runtimeContext?.currentSpeakerProfile?.content,
                // >>> participant-roster patch >>>
                // 每轮把名册长度打进 `[Prompt] 开始构建` 这条 DEBUG 日志。
                // 这是唯一能从日志确认"名册到底进没进这一轮的提示词"的地方 ——
                // 主提示词的 contentPreview 只留前 120 字，靠它是看不出来的。
                participantRosterLength: String(runtimeContext?.participantRoster || '').length,
                // <<< participant-roster patch <<<
                injectionRiskLevel: runtimeContext?.injectionRisk?.level || ''
            }
        });

        const character = runtimeOverrides.character || this.characterManager.readFromPng(characterName);

        let worldBook = runtimeOverrides.worldBook || this.worldBookManager.currentWorldBook;
        if (!worldBook) {
            worldBook = this.worldBookManager.readWorldBook(characterName);
        }

        const historyText = normalizedContext.recentMessages.map((message) => message.content).join(' ');
        const summaryText = normalizedContext.summaries.map((summary) => summary.content).join(' ');
        const allText = `${historyText} ${summaryText} ${userMessage}`.trim();
        // 2026-10-19：10 条在活跃群里**每轮都打满**（实测 worldBookCount=10）。
        // 原因：allText 含 historyText，角色名把 order=10 的角色条目反复命中，
        // order=5 的知识条目（音游 / OI）永远被 slice 切掉。改成可配置，默认 12。
        const worldBookLimit = Number((this.chatConfig || {}).worldBookMaxEntries) || 12;
        const worldBookEntries = this.worldBookManager.matchEntries(worldBook, allText, worldBookLimit, stickyKeys);
        const activePreset = runtimeOverrides.presetConfig
            ? PromptBuilder.normalizePreset(runtimeOverrides.presetConfig)
            : this.presetConfig;
        const composition = this.buildRuntimeComposition({
            normalizedContext,
            runtimeContext,
            activePreset,
            character,
            worldBookEntries,
            userMessage
        });

        const messages = [
            {
                role: 'system',
                content: composition.systemSegments.map((segment) => segment.content.trim()).filter(Boolean).join('\n\n'),
                meta: { source: 'runtime_composition' }
            }
        ];

        if (normalizedContext.recentMessages.length === 0 && character.first_mes) {
            messages.push({
                role: 'assistant',
                content: character.first_mes,
                meta: { source: 'first_message' }
            });
        }

        const historyInjectionBuckets = new Map();
        for (const segment of composition.historyInjectionSegments || []) {
            const insertionIndex = Number(segment.meta?.insertionIndex || 0);
            if (!historyInjectionBuckets.has(insertionIndex)) {
                historyInjectionBuckets.set(insertionIndex, []);
            }
            historyInjectionBuckets.get(insertionIndex).push(segment);
        }

        const appendHistoryInjectionSegments = (index) => {
            const bucket = historyInjectionBuckets.get(index) || [];
            for (const segment of bucket) {
                messages.push({
                    role: 'system',
                    content: segment.content,
                    meta: {
                        source: 'history_injection',
                        sourceId: segment.id,
                        insertionIndex: index
                    }
                });
            }
        };

        appendHistoryInjectionSegments(0);

        // >>> example-dialogue patch (managed by patch_example_dialogue.py) >>>
        // 示例对话按 ST 的标准位置放在历史之前：让模型在上下文里"看到"角色怎么说话。
        // 指令永远打不过示例，这是 SillyTavern 官方文档的原话。
        const exampleTurns = ((this.chatConfig || {}).exampleDialogue === false)
            ? []
            : PromptBuilder.parseExampleDialogue(character.mes_example);
        if (exampleTurns.length > 0) {
            this.logger?.debug?.(`[提示词] 注入示例对话 ${exampleTurns.length} 轮`);
            for (const turn of exampleTurns) {
                messages.push({
                    role: turn.role,
                    content: turn.content,
                    meta: { source: 'example_dialogue' }
                });
            }
        }
        // <<< example-dialogue patch <<<

        for (let index = 0; index < composition.historyMessages.length; index += 1) {
            const message = composition.historyMessages[index];
            messages.push({ role: message.role, content: message.content, meta: message.meta });
            appendHistoryInjectionSegments(index + 1);
        }

        for (const segment of composition.postHistorySegments) {
            messages.push({
                role: 'system',
                content: segment.content,
                meta: { source: 'post_history', sourceId: segment.id }
            });
        }

        if (composition.currentMessageFocusSegment?.content) {
            messages.push({
                role: 'system',
                content: composition.currentMessageFocusSegment.content,
                meta: {
                    source: 'current_message_focus',
                    sourceId: composition.currentMessageFocusSegment.id
                }
            });
        }

        messages.push({
            role: 'user',
            content: userMessage,
            meta: { source: 'user_input' }
        });

        const assistantPrefillText = composition.assistantPrefillSegments
            .map((segment) => segment.content.trim())
            .filter(Boolean)
            .join('\n\n');

        if (assistantPrefillText) {
            messages.push({
                role: 'assistant',
                content: assistantPrefillText,
                meta: {
                    source: 'assistant_prefill',
                    sourceIds: composition.assistantPrefillSegments.map((segment) => segment.id).filter(Boolean)
                }
            });
        }

        const messageTrace = PromptBuilder.createMessageTrace(messages, composition.runtimeSources);
        const result = {
            messages,
            character,
            runtimeComposition: composition,
            runtimeSources: composition.runtimeSources,
            messageTrace,
            worldBookCount: worldBookEntries.length,
            worldBookKeys: worldBookEntries.map((entry) => entry.key),
            worldBookEntries: worldBookEntries.map((entry) => ({
                key: entry.key,
                sticky: entry.sticky || 0,
                triggeredByKeyword: entry.triggeredByKeyword,
                triggeredBySticky: entry.triggeredBySticky,
                comment: entry.comment,
                content: entry.content
            }))
        };

        this.logger.info?.('[Prompt] 构建完成', {
            characterName,
            character: character?.name || characterName,
            durationMs: Date.now() - startedAt,
            recentMessageCount: normalizedContext.recentMessages.length,
            summaryCount: normalizedContext.summaries.length,
            worldBookCount: worldBookEntries.length,
            worldBookKeys: worldBookEntries.map((entry) => entry.key).slice(0, 10),
            historyInjectionCount: composition.historyInjectionSegments.length,
            postHistoryCount: composition.postHistorySegments.length,
            assistantPrefillCount: composition.assistantPrefillSegments.length,
            runtimeSourceCount: composition.runtimeSources.length,
            messageCount: messages.length,
            messageTraceCount: messageTrace.length
        });

        return result;
    }

    buildSituationalContext(context, runtimeContext) {
        const sections = [];

        if (this.contextConfig.includeSessionFacts) {
            const facts = [];
            if (runtimeContext.sessionId) {
                facts.push(`会话ID: ${runtimeContext.sessionId}`);
            }
            if (runtimeContext.messageType) {
                facts.push(`会话类型: ${runtimeContext.messageType}`);
            }
            if (runtimeContext.messageCount) {
                facts.push(`本次聚合消息数: ${runtimeContext.messageCount}`);
            }
            if (runtimeContext.triggerReason) {
                facts.push(`触发原因: ${runtimeContext.triggerReason}`);
            }
            if (facts.length > 0) {
                // 「这段对话的形状」：时长/双方句数、反复出现的话、不正常的时间点。
                // 纯计算，零 LLM 调用。加这行的起因见 buildConversationShape 的注释。
                const shape = buildConversationShape(context && context.recentMessages, Date.now());
                sections.push(`【会话感知】\n${[facts.join(' | '), ...shape].join('\n')}`);
            }
        }

        if (this.contextConfig.includeParticipants && Array.isArray(runtimeContext.participants) && runtimeContext.participants.length > 0) {
            sections.push(`【参与者】\n${runtimeContext.participants.join(' | ')}`);
        }

        // >>> participant-roster patch >>>
        // 跨会话身份名册。文本由 index.js 的 buildParticipantRosterText() 生成
        // （未启用/无联系人时是空串）。放在【参与者】旁边，因为两者都是"现场有谁"级别的
        // 身份信息；但它覆盖的是**别的会话**里的人，所以必须显式区别于【当前发言人画像】。
        //
        // ⚠ 这里必须留一行日志。原因：主提示词在日志里的 `contentPreview` 只留前 ~120 字，
        // 情境段永远看不到 ⇒ 没法从日志判断这东西到底进没进 prompt（styleAnchor 已经
        // 让这个坑浪费过一整轮排查）。和上面「注入示例对话」用同一种写法。
        if (runtimeContext.participantRoster) {
            const rosterText = String(runtimeContext.participantRoster).trim();
            this.logger?.debug?.(`[提示词] 注入身份名册 ${rosterText.length} 字`);
            sections.push(rosterText);
        }
        // <<< participant-roster patch <<<

        if (runtimeContext.currentSpeakerProfile?.content) {
            const rawProfileText = runtimeContext.currentSpeakerProfile.content.trim();
// >>> profile-quote-scrub patch >>>
            // 引号里的原话会被她当台词念（「哄不好了」「他们」都是这么来的），
            // 所以注入前先换成占位符。DB 原文不动，每次渲染现算。
            const profileText = scrubProfileQuotes(rawProfileText);
            if (profileText !== rawProfileText) {
                this.logger?.debug?.('[画像清洗] 已剥离引号引语', {
                    speaker: runtimeContext.currentSpeakerProfile.participantName || '',
                    before: rawProfileText.length,
                    after: profileText.length,
                    stillHasQuote: hasQuotedScript(profileText)
                });
            }
// <<< profile-quote-scrub patch <<<
            if (profileText) {
                sections.push(`【当前发言人画像】\n${profileText}`);
            }
        }

        if (this.contextConfig.includeReplyReference && runtimeContext.replyReference) {
            sections.push(`【引用上下文】\n${runtimeContext.replyReference}`);
        }

        if (this.contextConfig.includeRecentUserIntent) {
            const recentUserMessages = context.recentMessages
                .filter((message) => message.role === 'user')
                // >>> passive-store patch >>>
                // 群里**没触发她**的消息也会入库（给她群上下文，见 index.js 的
                // maybeStoreUntriggeredMessage），但它们不是"用户意图" ——
                // 不过滤的话，真正在跟她说话的那几句会被群里的闲话挤出这三条。
                .filter((message) => !message?.metadata?.passive)
                // <<< passive-store patch <<<
                .slice(-3)
                .map((message) => message.content);
            if (recentUserMessages.length > 0) {
                sections.push(`【最近用户意图】\n${recentUserMessages.join('\n')}`);
            }
        }

        return sections.filter(Boolean).join('\n\n');
    }

    static importPreset(payload = {}) {
        const source = payload.preset || payload.importedPreset || payload;

        if (Array.isArray(source.prompts) && source.prompts.length > 0) {
            return PromptBuilder.normalizePreset({
                enabled: source.enabled !== false,
                name: source.name || source.preset_name || source.title || '',
                prompts: source.prompts,
                regexRules: Array.isArray(source.regexRules) ? source.regexRules : []
            });
        }

        const normalizeText = (value) => typeof value === 'string' ? value.trim() : '';

        const promptItems = Array.isArray(source.prompts) ? source.prompts : [];
        const enabledPrompts = promptItems.filter((item) => item && item.enabled !== false && typeof item.content === 'string' && item.content.trim());

        const systemPromptParts = [];
        const postHistoryParts = [];
        let assistantPrefill = normalizeText(source.assistantPrefill || source.assistant_prefill || source.prefill || '');

        for (const item of enabledPrompts) {
            const content = normalizeText(item.content);
            if (!content) {
                continue;
            }

            const identifier = String(item.identifier || '').toLowerCase();
            const name = String(item.name || '').toLowerCase();
            const role = String(item.role || '').toLowerCase();
            const marker = item.marker === true;
            const systemPromptFlag = item.system_prompt === true;

            if (identifier.includes('post') || name.includes('post history')) {
                postHistoryParts.push(content);
                continue;
            }

            if (identifier.includes('assistantprefill') || name.includes('assistant prefill') || identifier.includes('jailbreak')) {
                if (!assistantPrefill) {
                    assistantPrefill = content;
                }
                continue;
            }

            if (role === 'assistant' && !systemPromptFlag) {
                if (!assistantPrefill) {
                    assistantPrefill = content;
                }
                continue;
            }

            if (role === 'system' || systemPromptFlag || marker) {
                systemPromptParts.push(content);
            }
        }

        const importedSystemPrompt = [
            normalizeText(source.systemPrompt || source.system_prompt || source.main_prompt || ''),
            ...systemPromptParts
        ].filter(Boolean).join('\n\n');

        const importedPostHistory = [
            normalizeText(source.postHistoryInstructions || source.post_history_instructions || source.post_history || ''),
            ...postHistoryParts
        ].filter(Boolean).join('\n\n');

        const importedJailbreak = normalizeText(source.jailbreak || source.jailbreak_system || source.nsfw_prompt || '');

        const importedPrompts = [];
        if (importedSystemPrompt) {
            importedPrompts.push(PromptBuilder.createPromptItem({
                identifier: 'imported-system-prompt',
                name: '导入 · 主 System 提示',
                role: 'system',
                content: importedSystemPrompt,
                enabled: true,
                injection_position: 0,
                injection_depth: 0,
                marker: true,
                system_prompt: true,
                sourceLabel: '角色描述 / 系统提示 / 主提示合并结果',
                sourceKey: 'system_prompt',
                sourceType: 'imported_runtime_prompt',
                sourceOrigin: 'preset-import',
                sourceReadonly: true,
                sourceMeta: {
                    from: ['systemPrompt', 'system_prompt', 'main_prompt', 'prompts[].content(system)'].join(' / '),
                    mappedFields: ['system_prompt / main_prompt']
                }
            }));
        }
        if (importedPostHistory) {
            importedPrompts.push(PromptBuilder.createPromptItem({
                identifier: 'imported-post-history',
                name: '导入 · 后置提示',
                role: 'system',
                content: importedPostHistory,
                enabled: true,
                injection_position: 1,
                injection_depth: 0,
                sourceLabel: '后置提示 / Post History 合并结果',
                sourceKey: 'post_history_instructions',
                sourceType: 'imported_runtime_prompt',
                sourceOrigin: 'preset-import',
                sourceReadonly: true,
                sourceMeta: {
                    from: ['postHistoryInstructions', 'post_history_instructions', 'post_history', 'prompts[].content(post-history)'].join(' / '),
                    mappedFields: ['post_history_instructions / post_history']
                }
            }));
        }
        if (assistantPrefill) {
            importedPrompts.push(PromptBuilder.createPromptItem({
                identifier: 'imported-assistant-prefill',
                name: '导入 · Assistant Prefill',
                role: 'assistant',
                content: assistantPrefill,
                enabled: true,
                injection_position: 0,
                injection_depth: 0,
                sourceLabel: '助手预填充 / 开场续写',
                sourceKey: 'assistant_prefill',
                sourceType: 'imported_runtime_prompt',
                sourceOrigin: 'preset-import',
                sourceReadonly: true,
                sourceMeta: {
                    from: ['assistantPrefill', 'assistant_prefill', 'prefill', 'prompts[].content(assistant)'].join(' / '),
                    mappedFields: ['assistant prefill']
                }
            }));
        }
        if (importedJailbreak) {
            importedPrompts.push(PromptBuilder.createPromptItem({
                identifier: 'imported-jailbreak',
                name: '导入 · Jailbreak / NSFW Prompt',
                role: 'system',
                content: importedJailbreak,
                enabled: true,
                injection_position: 1,
                injection_depth: 0,
                sourceLabel: 'Jailbreak / NSFW 提示',
                sourceKey: 'jailbreak',
                sourceType: 'imported_runtime_prompt',
                sourceOrigin: 'preset-import',
                sourceReadonly: true,
                sourceMeta: {
                    from: ['jailbreak', 'jailbreak_system', 'nsfw_prompt'].join(' / '),
                    mappedFields: ['jailbreak / nsfw_prompt']
                }
            }));
        }

        return PromptBuilder.normalizePreset({
            enabled: source.enabled !== false,
            name: source.name || source.preset_name || source.title || '',
            prompts: importedPrompts,
            regexRules: Array.isArray(source.regexRules) ? source.regexRules : []
        });
    }

    static diagnosePresetImport(payload = {}) {
        const source = payload.preset || payload.importedPreset || payload;
        const promptItems = Array.isArray(source.prompts) ? source.prompts : [];
        const enabledPrompts = promptItems.filter((item) => item && item.enabled !== false);
        const markerPrompts = enabledPrompts.filter((item) => item.marker === true);
        const assistantRolePrompts = enabledPrompts.filter((item) => String(item.role || '').toLowerCase() === 'assistant');
        const postHistoryPrompts = enabledPrompts.filter((item) => Number(item.injection_position || 0) === 1);
        const historyInjectionPrompts = enabledPrompts.filter((item) => Number(item.injection_position || 0) !== 1 && Number(item.injection_depth || 0) > 0);
        const unsupportedRoles = enabledPrompts.filter((item) => {
            const role = String(item.role || 'system').toLowerCase();
            return role !== 'system' && role !== 'assistant';
        });
        const unsupportedPlacements = enabledPrompts.filter((item) => {
            const placement = Number(item.injection_position || 0);
            return placement !== 0 && placement !== 1;
        });

        const warnings = [];
        if (unsupportedPlacements.length > 0) {
            warnings.push(`检测到 ${unsupportedPlacements.length} 条不受支持的 injection_position，当前仅精确支持主 system、history injection、post-history 与 assistant prefill 这几类落位。`);
        }
        if (unsupportedRoles.length > 0) {
            warnings.push(`检测到 ${unsupportedRoles.length} 条非 system/assistant role prompt，当前不会完整复刻这些角色的 ST 运行时语义。`);
        }

        return {
            detectedFormat: promptItems.length > 0 ? 'sillytavern-prompts' : 'basic-preset',
            totalPrompts: promptItems.length,
            enabledPrompts: enabledPrompts.length,
            postHistoryPrompts: postHistoryPrompts.length,
            historyInjectionPrompts: historyInjectionPrompts.length,
            markerPrompts: markerPrompts.length,
            assistantRolePrompts: assistantRolePrompts.length,
            unsupportedPlacements: unsupportedPlacements.length,
            unsupportedRoles: unsupportedRoles.length,
            warnings
        };
    }


    static exportPreset(presetConfig = {}, format = 'native') {
        const normalized = PromptBuilder.normalizePreset(presetConfig);

        if (format === 'sillytavern') {
            return {
                name: normalized.name || 'Imported Preset',
                prompts: normalized.prompts
            };
        }

        return {
            preset: normalized
        };
    }
}
