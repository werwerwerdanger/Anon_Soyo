/**
 * 会话与记忆存储模块
 * 使用 SQLite 持久化会话、消息、摘要和粘性条目状态。
 */

import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

import { getParticipantProfileConfig } from './participant-profile-config.js';
import { chatScopePullLimit, filterMessagesForChat } from './chat-scope.js';
// >>> participant-roster patch >>>
// 身份名册的解析规则只有一份（`昵称(QQ)` 的切法、通知文本过滤、曾用名合并），
// 写库（本文件）和渲染（participant-roster.js）必须用同一套，所以从那里 import。
// participant-roster.js 不 import 任何东西，不存在循环依赖。
import {
    parseContactToken,
    parseSessionKey,
    mergeNameHistory,
    isPlausibleName,
    normalizeParticipantRosterConfig,
    PARTICIPANT_ROSTER_DEFAULTS
} from './participant-roster.js';
// <<< participant-roster patch <<<

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function truncate(text, maxLength = 240) {
    if (!text) {
        return '';
    }
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function summarizeText(value, maxLength = 120) {
    const normalized = String(value || '').trim();
    return {
        length: normalized.length,
        preview: truncate(normalized, maxLength)
    };
}

function summarizeNamespaceOptions(namespaceOptions = {}) {
    return {
        scopeType: namespaceOptions.scopeType || '',
        scopeKey: namespaceOptions.scopeKey || '',
        characterName: namespaceOptions.characterName || '',
        presetName: namespaceOptions.presetName || ''
    };
}

function parseJson(value, fallback) {
    if (!value) {
        return fallback;
    }

    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}


function extractParticipantNameFromMessage(row) {
    const metadata = parseJson(row?.metadata_json, {});
    const metadataName = metadata.participantName || metadata.userName || metadata.senderName || metadata.nickname || metadata.card;
    if (metadataName) {
        return String(metadataName).trim();
    }

    const content = String(row?.content || '');
    const match = content.match(new RegExp('\u6635\u79f0:([^|\\]]+)'));
    return match ? match[1].trim() : '';
}

function resolveDbPath(baseDir, configuredPath) {
    if (!configuredPath) {
        return path.join(baseDir, 'chats', 'memory-store.sqlite');
    }

    return path.isAbsolute(configuredPath)
        ? configuredPath
        : path.resolve(process.cwd(), configuredPath);
}

function normalizeSessionMode(mode) {
    switch (mode) {
        case 'scoped':
        case 'group_shared':
            return 'group_shared';
        case 'user':
        case 'group_user':
            return 'group_user';
        case 'global':
        case 'global_shared':
            return 'global_shared';
        case 'user_persistent':
        default:
            return 'user_persistent';
    }
}

function parseVariableValue(rawValue, declaredType = 'string') {
    if (rawValue === null || rawValue === undefined) {
        return null;
    }

    switch (declaredType) {
        case 'number': {
            const value = Number(rawValue);
            return Number.isFinite(value) ? value : null;
        }
        case 'boolean': {
            if (typeof rawValue === 'boolean') {
                return rawValue;
            }
            const normalized = String(rawValue).trim().toLowerCase();
            if (['true', '1', 'yes', 'on'].includes(normalized)) {
                return true;
            }
            if (['false', '0', 'no', 'off'].includes(normalized)) {
                return false;
            }
            return null;
        }
        case 'json': {
            if (typeof rawValue !== 'string') {
                return rawValue;
            }
            try {
                return JSON.parse(rawValue);
            } catch {
                return null;
            }
        }
        case 'string':
        default:
            return String(rawValue);
    }
}

function serializeVariableValue(value, declaredType = 'string') {
    if (value === null || value === undefined) {
        return '';
    }

    if (declaredType === 'json') {
        return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    }

    return String(value);
}

function normalizeVariableType(valueType) {
    return ['string', 'number', 'boolean', 'json'].includes(valueType) ? valueType : 'string';
}

function normalizeKnowledgeType(value) {
    return value === 'fixed' ? 'fixed' : 'dynamic';
}

function normalizeParticipantId(value) {
    return String(value ?? '').trim();
}

function normalizeParticipantName(value, fallback = '') {
    return String(value || fallback || '').trim();
}

function normalizeParticipantProfileIdPart(value) {
    return normalizeParticipantId(value).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96) || 'unknown';
}

function buildParticipantProfileEntryId(namespaceId, participantId) {
    const participantKey = normalizeParticipantProfileIdPart(participantId);
    const namespaceKey = Buffer.from(String(namespaceId || '')).toString('base64url').slice(0, 48) || 'global';
    return `participant_profile_${participantKey}_${namespaceKey}`;
}

function normalizeParticipantProfileNamespaceOptions(namespaceOptions = {}) {
    return {
        ...namespaceOptions,
        presetName: null
    };
}

function isAssistantRole(role) {
    return String(role || '').trim().toLowerCase() === 'assistant';
}

function isUserRole(role) {
    return String(role || '').trim().toLowerCase() === 'user';
}

function buildParticipantProfileMessageKey(message = {}) {
    return [
        message.sessionId || '',
        message.timestamp || 0,
        message.role || '',
        message.content || ''
    ].join('|');
}

function resolveParticipantProfileSpeaker(message = {}, targetParticipantId = '') {
    const targetId = normalizeParticipantId(targetParticipantId);
    const metadata = message.metadata || {};
    const userId = normalizeParticipantId(metadata.userId);
    const participantName = normalizeParticipantName(
        metadata.participantName || metadata.userName || metadata.senderName || metadata.nickname || metadata.card,
        userId
    );

    if (isAssistantRole(message.role)) {
        return {
            speakerType: 'bot',
            speakerId: 'bot',
            speakerName: 'Bot',
            isTargetSpeaker: false
        };
    }

    if (isUserRole(message.role) && targetId && userId && userId === targetId) {
        return {
            speakerType: 'target',
            speakerId: userId,
            speakerName: participantName || targetId,
            isTargetSpeaker: true
        };
    }

    if (isUserRole(message.role)) {
        return {
            speakerType: 'third_party',
            speakerId: userId || '',
            speakerName: participantName || userId || '第三者',
            isTargetSpeaker: false
        };
    }

    return {
        speakerType: 'unknown',
        speakerId: userId || '',
        speakerName: participantName || '',
        isTargetSpeaker: false
    };
}

function splitParticipantProfileQuotedContent(content = '') {
    const rawContent = String(content || '');
    let working = rawContent;
    const quotes = [];

    // [回复上文|发送者:xxx|QQ:yyy|内容:zzz]
    working = working.replace(/\[\u56de\u590d\u4e0a\u6587([^\]]*)\]/g, (_, body) => {
        const text = String(body || '');
        const speakerName = (text.match(/\u53d1\u9001\u8005:([^|\]]+)/) || [])[1]?.trim() || '';
        const speakerId = (text.match(/QQ:([^|\]]+)/) || [])[1]?.trim() || '';
        const quoteContent = (text.match(/\u5185\u5bb9:([^|\]]+)/) || [])[1]?.trim() || '';
        if (quoteContent || speakerName || speakerId) {
            quotes.push({
                speakerType: 'quoted',
                speakerId,
                speakerName,
                content: quoteContent,
                source: 'reply_snippet'
            });
        }
        return ' ';
    });

    // 结构化前缀中的 replyQuotedText:xxx
    working = working.replace(/\|?replyQuotedText:([^|\]]+)/g, (_, quoted) => {
        const quoteContent = String(quoted || '').trim();
        if (quoteContent && !quotes.some((item) => item.content === quoteContent)) {
            quotes.push({
                speakerType: 'quoted',
                speakerId: '',
                speakerName: '',
                content: quoteContent,
                source: 'replyQuotedText'
            });
        }
        return '';
    });

    // 去掉结构化元数据括号，避免把系统字段算成本人发言
    working = working.replace(/\[(?:\u7fa4\u804a|\u79c1\u804a)[^\]]*\]/g, ' ');
    working = working.replace(/\[[^\]]*(?:QQ:|isAtBot:|replyToBot:|messageSegments:)[^\]]*\]/g, ' ');

    const ownContent = working.replace(/\s+/g, ' ').trim();
    return {
        rawContent,
        ownContent,
        quote: quotes[0] || null,
        quotes
    };
}

function extractStructuredSpeakerSegments(content = '') {
    const raw = String(content || '');
    if (!raw.trim()) {
        return [];
    }

    // 匹配批处理合并后的多段结构化发言：
    // [群聊|QQ:10002|昵称:第三者群友|...] 文本
    // [私聊|QQ:xxx|昵称:yyy|...] 文本
    const segmentRegex = /\[(?:群聊|私聊)([^\]]*)\]\s*([^\[]*)/g;
    const segments = [];
    let match;
    while ((match = segmentRegex.exec(raw)) !== null) {
        const metaText = String(match[1] || '');
        const bodyText = String(match[2] || '').trim();
        const speakerId = (metaText.match(/QQ:([^|\]]+)/) || [])[1]?.trim() || '';
        const speakerName = (metaText.match(/(?:昵称|名称|card):([^|\]]+)/) || [])[1]?.trim() || '';
        if (!bodyText && !speakerId && !speakerName) {
            continue;
        }
        segments.push({
            speakerId,
            speakerName,
            content: bodyText,
            rawSegment: match[0]
        });
    }
    return segments;
}

function buildAttributedMessageFromParts(baseMessage, targetParticipantId, parts = {}) {
    const targetId = normalizeParticipantId(targetParticipantId);
    const speakerId = normalizeParticipantId(parts.speakerId || '');
    const speakerName = normalizeParticipantName(parts.speakerName || '', speakerId || targetId);
    const role = parts.role || baseMessage.role || 'user';

    let speakerType = 'unknown';
    let isTargetSpeaker = false;
    let finalSpeakerId = speakerId;
    let finalSpeakerName = speakerName;

    if (isAssistantRole(role) || parts.speakerType === 'bot') {
        speakerType = 'bot';
        finalSpeakerId = 'bot';
        finalSpeakerName = 'Bot';
        isTargetSpeaker = false;
    } else if (parts.speakerType === 'target' || (targetId && speakerId && speakerId === targetId)) {
        speakerType = 'target';
        finalSpeakerId = speakerId || targetId;
        finalSpeakerName = speakerName || targetId;
        isTargetSpeaker = true;
    } else if (
        parts.speakerType === 'third_party'
        || (speakerId && targetId && speakerId !== targetId)
        || parts.forceThirdParty
    ) {
        speakerType = 'third_party';
        finalSpeakerId = speakerId || '';
        finalSpeakerName = speakerName || speakerId || '第三者';
        isTargetSpeaker = false;
    } else if (isUserRole(role)) {
        const fallback = resolveParticipantProfileSpeaker({
            ...baseMessage,
            role
        }, targetId);
        speakerType = fallback.speakerType;
        finalSpeakerId = fallback.speakerId;
        finalSpeakerName = fallback.speakerName;
        isTargetSpeaker = fallback.isTargetSpeaker;
    }

    const split = splitParticipantProfileQuotedContent(parts.content || '');
    return {
        sessionId: baseMessage.sessionId,
        role,
        content: split.ownContent,
        rawContent: parts.rawContent || parts.content || baseMessage.content || '',
        quote: split.quote,
        quotes: split.quotes,
        hasQuote: Boolean(split.quote),
        metadata: {
            ...(baseMessage.metadata || {}),
            ...(speakerId ? { userId: speakerId } : {}),
            ...(finalSpeakerName ? { participantName: finalSpeakerName } : {}),
            expandedFromMergedBatch: parts.expandedFromMergedBatch === true
        },
        timestamp: baseMessage.timestamp,
        date: baseMessage.date,
        speakerType,
        speakerId: finalSpeakerId,
        speakerName: finalSpeakerName,
        isTargetSpeaker,
        utterances: parts.utterances || null
    };
}

function expandParticipantProfileSourceMessages(message, targetParticipantId) {
    const targetId = normalizeParticipantId(targetParticipantId);
    const content = String(message?.content || '');
    const mergedCount = Number(message?.metadata?.mergedCount || 0);
    const segments = extractStructuredSpeakerSegments(content);
    const uniqueSpeakerIds = Array.from(new Set(segments.map((item) => item.speakerId).filter(Boolean)));
    const shouldExpand = segments.length >= 2 && (uniqueSpeakerIds.length >= 2 || mergedCount > 1);

    if (!shouldExpand) {
        return [mapParticipantProfileSourceMessage(message, targetId)];
    }

    const expanded = segments.map((segment) => buildAttributedMessageFromParts(message, targetId, {
        role: 'user',
        speakerId: segment.speakerId,
        speakerName: segment.speakerName,
        content: segment.content,
        rawContent: segment.rawSegment,
        expandedFromMergedBatch: true,
        forceThirdParty: Boolean(segment.speakerId && segment.speakerId !== targetId)
    }));

    const useful = expanded.filter((item) => String(item.content || '').trim() || item.hasQuote);
    if (useful.length === 0) {
        return [mapParticipantProfileSourceMessage(message, targetId)];
    }

    const utterances = useful.map((item) => ({
        speakerType: item.speakerType,
        speakerId: item.speakerId,
        speakerName: item.speakerName,
        content: item.content,
        quote: item.quote
    }));
    useful[0] = {
        ...useful[0],
        utterances
    };
    return useful;
}

function mapParticipantProfileSourceMessage(message, targetParticipantId) {
    const speaker = resolveParticipantProfileSpeaker(message, targetParticipantId);
    const split = splitParticipantProfileQuotedContent(message.content);
    return {
        sessionId: message.sessionId,
        role: message.role,
        content: split.ownContent,
        rawContent: split.rawContent,
        quote: split.quote,
        quotes: split.quotes,
        hasQuote: Boolean(split.quote),
        metadata: message.metadata || {},
        timestamp: message.timestamp,
        date: message.date,
        speakerType: speaker.speakerType,
        speakerId: speaker.speakerId,
        speakerName: speaker.speakerName,
        isTargetSpeaker: speaker.isTargetSpeaker,
        utterances: null
    };
}

function mapVariableRow(row) {
    const metadata = parseJson(row.metadata_json, {});
    const valueType = normalizeVariableType(metadata.valueType || 'string');
    return {
        id: row.id,
        namespaceId: row.namespace_id,
        key: row.title || '',
        title: row.title || '',
        value: parseVariableValue(row.content, valueType),
        rawValue: row.content,
        valueType,
        tags: parseJson(row.tags_json, []),
        metadata,
        sourceSessionId: row.source_session_id,
        sourceMessageId: row.source_message_id,
        scopeType: row.scope_type,
        scopeKey: row.scope_key,
        characterName: row.character_name || '',
        presetName: row.preset_name || '',
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function mapParticipantProfileRow(row) {
    const metadata = parseJson(row.metadata_json, {});
    return {
        id: row.id,
        namespaceId: row.namespace_id,
        participantId: normalizeParticipantId(metadata.participantId),
        participantName: normalizeParticipantName(metadata.participantName, row.title),
        title: row.title || metadata.participantName || '',
        contentPreview: truncate(row.content, 160),
        content: row.content,
        tags: parseJson(row.tags_json, []),
        scopeType: row.scope_type,
        scopeKey: row.scope_key,
        characterName: row.character_name || '',
        presetName: row.preset_name || '',
        metadata,
        sourceSessionId: row.source_session_id,
        sourceMessageId: row.source_message_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function mapKnowledgeRow(row) {
    const metadata = parseJson(row.metadata_json, {});
    return {
        id: row.id,
        namespaceId: row.namespace_id,
        entryType: row.entry_type,
        knowledgeType: metadata.knowledgeType || (row.entry_type === 'knowledge_fixed' ? 'fixed' : 'dynamic'),
        title: row.title || '',
        contentPreview: truncate(row.content, 160),
        content: row.content,
        tags: parseJson(row.tags_json, []),
        scopeType: row.scope_type,
        scopeKey: row.scope_key,
        characterName: row.character_name || '',
        presetName: row.preset_name || '',
        metadata,
        sourceSessionId: row.source_session_id,
        sourceMessageId: row.source_message_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

export class SessionManager {
    constructor(dataDir, config = {}, logger = console) {
        this.dataDir = dataDir;
        this.logger = logger;
        this.locks = new Map();
        this.chatsDir = path.join(this.dataDir, 'chats');
        this.dbPath = this.resolveDbPath(config);
        this.openDatabase(this.dbPath);
        this.setConfig(config);

        this.logger.info?.(`[记忆] SQLite 初始化完成: ${this.dbPath}`);
    }

    openDatabase(dbPath) {
        this.dbPath = dbPath;
        ensureDir(path.dirname(this.dbPath));

        this.db = new DatabaseSync(this.dbPath);
        this.db.exec('PRAGMA journal_mode = WAL;');
        this.db.exec('PRAGMA foreign_keys = ON;');
        this.prepareSchema();
        this.prepareStatements();
        // >>> participant-roster patch >>>
        // 表为空时从历史 messages 回填一次。**必须回填**：否则升级后名册会突然空掉，
        // 看起来像功能坏了（这个坑今天已经因为别的原因踩过一次）。
        this.backfillParticipantContacts();
        // <<< participant-roster patch <<<
    }

    resolveDbPath(config = {}, overridePath = null) {
        return resolveDbPath(this.dataDir, overridePath || config.memory?.storage?.path);
    }

    setConfig(config = {}, overrides = {}) {
        this.config = config;
        const chatConfig = config.chat || {};
        const memoryConfig = config.memory || {};
        const summaryConfig = memoryConfig.summary || {};
        const nextDbPath = this.resolveDbPath(config, overrides.storagePath || null);

        if (!this.db || this.dbPath !== nextDbPath) {
            if (this.db) {
                // 清理 prepared statements 避免 "database is locked"
                this.closeStatements();
                this.db.close();
            }
            this.openDatabase(nextDbPath);
            this.logger.info?.(`[记忆] 已切换数据库: ${this.dbPath}`);
        }

        this.maxHistoryLength = chatConfig.historyLimit || 30;
        this.maxGlobalMessages = chatConfig.maxGlobalMessages || 2000;
        this.sessionMode = normalizeSessionMode(chatConfig.sessionMode || 'user_persistent');
        this.summaryConfig = {
            enabled: summaryConfig.enabled === true,
            triggerMessages: summaryConfig.triggerMessages || 80,
            keepRecent: summaryConfig.keepRecent || 30,
            maxSummaries: summaryConfig.maxSummaries || 8,
            useAI: summaryConfig.useAI !== false,
            maxSourceMessages: summaryConfig.maxSourceMessages || 50
        };
        this.storageConfig = {
            type: memoryConfig.storage?.type || 'sqlite',
            path: memoryConfig.storage?.path || './data/chats/memory-store.sqlite'
        };
        // >>> participant-roster patch >>>
        // 曾用名保留几个由配置决定（"很多个称呼"就靠它）
        this.participantContactNameLimit = normalizeParticipantRosterConfig(
            memoryConfig.participantRoster
        ).maxNameHistory || PARTICIPANT_ROSTER_DEFAULTS.maxNameHistory;
        // <<< participant-roster patch <<<
    }

    closeStatements() {
        // 关闭所有 prepared statements
        const statements = [
            'stmtGetSession', 'stmtCreateSession', 'stmtUpdateSession',
            'stmtInsertMessage', 'stmtGetMessages', 'stmtDeleteOldMessages',
            'stmtInsertSummary', 'stmtGetSummaries', 'stmtDeleteOldSummaries',
            'stmtGetStickyEntry', 'stmtUpsertStickyEntry', 'stmtDecrementSticky',
            'stmtDeleteSticky', 'stmtGetOrCreateNamespace', 'stmtInsertMemoryEntry',
            'stmtGetMemoryEntries', 'stmtUpdateMemoryEntry', 'stmtDeleteMemoryEntry'
        ];

        for (const name of statements) {
            if (this[name]) {
                try {
                    // SQLite prepared statements 没有显式 close，但清空引用即可
                    this[name] = null;
                } catch (e) {
                    this.logger.warn?.(`[记忆] 清理 statement ${name} 失败: ${e.message}`);
                }
            }
        }
    }

    close() {
        this.closeStatements();
        if (this.db) {
            try {
                this.db.close();
            } catch (e) {
                this.logger.warn?.(`[记忆] 关闭 SQLite 连接失败: ${e.message}`);
            }
            this.db = null;
        }
    }

    prepareSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL,
                last_active INTEGER NOT NULL,
                message_count INTEGER NOT NULL DEFAULT 0,
                summary_count INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                metadata_json TEXT,
                timestamp INTEGER NOT NULL,
                date_iso TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_messages_session_time
            ON messages(session_id, timestamp DESC);

            CREATE INDEX IF NOT EXISTS idx_messages_content
            ON messages(content);

            CREATE TABLE IF NOT EXISTS summaries (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                content TEXT NOT NULL,
                source_count INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                date_iso TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_summaries_session_time
            ON summaries(session_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS sticky_entries (
                session_id TEXT NOT NULL,
                entry_key TEXT NOT NULL,
                remaining INTEGER NOT NULL,
                PRIMARY KEY (session_id, entry_key),
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS memory_namespaces (
                id TEXT PRIMARY KEY,
                scope_type TEXT NOT NULL,
                scope_key TEXT NOT NULL,
                character_name TEXT,
                preset_name TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_namespaces_scope
            ON memory_namespaces(scope_type, scope_key, IFNULL(character_name, ''), IFNULL(preset_name, ''));

            CREATE TABLE IF NOT EXISTS memory_entries (
                id TEXT PRIMARY KEY,
                namespace_id TEXT NOT NULL,
                source_session_id TEXT,
                source_message_id TEXT,
                entry_type TEXT NOT NULL,
                title TEXT,
                content TEXT NOT NULL,
                tags_json TEXT,
                metadata_json TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY (namespace_id) REFERENCES memory_namespaces(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_memory_entries_namespace_time
            ON memory_entries(namespace_id, updated_at DESC);

            CREATE INDEX IF NOT EXISTS idx_memory_entries_content
            ON memory_entries(content);

            CREATE TABLE IF NOT EXISTS summary_index_entries (
                id TEXT PRIMARY KEY,
                namespace_id TEXT NOT NULL,
                source_summary_id TEXT,
                source_session_id TEXT,
                outline TEXT NOT NULL,
                keywords_json TEXT,
                metadata_json TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY (namespace_id) REFERENCES memory_namespaces(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_summary_index_namespace_time
            ON summary_index_entries(namespace_id, updated_at DESC);

            -- >>> participant-roster patch >>>
            -- 「认识谁」的**持久身份**。为什么不从 messages 现算：摘要会把 messages
            -- 删掉（实测 group:929159193 累计 560 条、现存 106），一个只在被清那段里
            -- 说过话的人就会**静默**从名单里消失 —— 而"认识他"本该是永久的。
            -- 只存身份，**不存一个字正文**（否则会串台 + 变成编造源）。
            CREATE TABLE IF NOT EXISTS participant_contacts (
                participant_id   TEXT PRIMARY KEY,          -- QQ：唯一稳定的键
                display_name     TEXT,                      -- 最近一次见到的昵称
                name_history     TEXT NOT NULL DEFAULT '[]',-- JSON 数组，最近在前（昵称会改）
                first_seen_at    INTEGER,
                last_seen_at     INTEGER,
                message_count    INTEGER NOT NULL DEFAULT 0,
                last_scope_kind  TEXT,                      -- private | group
                last_scope_key   TEXT                       -- private:<qq> / group:<gid>
            );

            CREATE INDEX IF NOT EXISTS idx_participant_contacts_last_seen
            ON participant_contacts(last_seen_at DESC);
            -- <<< participant-roster patch <<<
        `);
    }

    prepareStatements() {
        this.statements = {
            insertSession: this.db.prepare(`
                INSERT INTO sessions (id, created_at, last_active, message_count, summary_count)
                VALUES (?, ?, ?, 0, 0)
                ON CONFLICT(id) DO NOTHING
            `),
            getSession: this.db.prepare('SELECT * FROM sessions WHERE id = ?'),
            updateSessionActivity: this.db.prepare(`
                UPDATE sessions
                SET last_active = ?, message_count = message_count + ?
                WHERE id = ?
            `),
            updateSessionSummaryCount: this.db.prepare(`
                UPDATE sessions
                SET summary_count = ?, last_active = ?
                WHERE id = ?
            `),
            insertMessage: this.db.prepare(`
                INSERT INTO messages (id, session_id, role, content, metadata_json, timestamp, date_iso)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `),
            getRecentMessages: this.db.prepare(`
                SELECT id, role, content, metadata_json, timestamp, date_iso
                FROM messages
                WHERE session_id = ?
                ORDER BY timestamp DESC, rowid DESC
                LIMIT ?
            `),
            getSessionMessageCount: this.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?'),
            getMessagesForSummary: this.db.prepare(`
                SELECT id, role, content, metadata_json, timestamp, date_iso
                FROM messages
                WHERE session_id = ?
                ORDER BY timestamp ASC, rowid ASC
                LIMIT ?
            `),
            deleteMessagesByIds: this.db.prepare(`
                DELETE FROM messages
                WHERE session_id = ? AND id = ?
            `),
            getSummaries: this.db.prepare(`
                SELECT id, content, source_count, created_at, date_iso
                FROM summaries
                WHERE session_id = ?
                ORDER BY created_at ASC, rowid ASC
            `),
            insertSummary: this.db.prepare(`
                INSERT INTO summaries (id, session_id, content, source_count, created_at, date_iso)
                VALUES (?, ?, ?, ?, ?, ?)
            `),
            deleteOldSummaries: this.db.prepare(`
                DELETE FROM summaries
                WHERE session_id = ? AND id IN (
                    SELECT id FROM summaries
                    WHERE session_id = ?
                    ORDER BY created_at ASC, rowid ASC
                    LIMIT ?
                )
            `),
            getStickyEntries: this.db.prepare(`
                SELECT entry_key, remaining FROM sticky_entries WHERE session_id = ?
            `),
            upsertStickyEntry: this.db.prepare(`
                INSERT INTO sticky_entries (session_id, entry_key, remaining)
                VALUES (?, ?, ?)
                ON CONFLICT(session_id, entry_key) DO UPDATE SET remaining = excluded.remaining
            `),
            deleteStickyEntry: this.db.prepare(`
                DELETE FROM sticky_entries WHERE session_id = ? AND entry_key = ?
            `),
            deleteStickyEntriesBySession: this.db.prepare('DELETE FROM sticky_entries WHERE session_id = ?'),
            clearSessionMessages: this.db.prepare('DELETE FROM messages WHERE session_id = ?'),
            clearSessionSummaries: this.db.prepare('DELETE FROM summaries WHERE session_id = ?'),
            deleteSession: this.db.prepare('DELETE FROM sessions WHERE id = ?'),
            listSessions: this.db.prepare(`
                SELECT id, created_at, last_active, message_count, summary_count
                FROM sessions
                ORDER BY last_active DESC
            `),
            searchMessages: this.db.prepare(`
                SELECT session_id, role, content, timestamp, date_iso
                FROM messages
                WHERE content LIKE ?
                ORDER BY timestamp DESC, rowid DESC
                LIMIT ?
            `),
            globalTimeline: this.db.prepare(`
                SELECT session_id, role, content, timestamp, date_iso
                FROM messages
                ORDER BY timestamp DESC, rowid DESC
                LIMIT ?
            `),
            stats: this.db.prepare(`
                SELECT
                    (SELECT COUNT(*) FROM messages) AS total_messages,
                    (SELECT COUNT(*) FROM sessions) AS total_sessions,
                    (SELECT COUNT(*) FROM summaries) AS total_summaries,
                    (SELECT date_iso FROM messages ORDER BY timestamp ASC, rowid ASC LIMIT 1) AS oldest_message,
                    (SELECT date_iso FROM messages ORDER BY timestamp DESC, rowid DESC LIMIT 1) AS newest_message
            `),
            countAllMessages: this.db.prepare('SELECT COUNT(*) AS count FROM messages'),
            getOldestGlobalMessages: this.db.prepare(`
                SELECT id, session_id
                FROM messages
                ORDER BY timestamp ASC, rowid ASC
                LIMIT ?
            `),
            deleteGlobalMessageById: this.db.prepare('DELETE FROM messages WHERE id = ?'),
            recalcSessionMessageCount: this.db.prepare(`
                UPDATE sessions
                SET message_count = (SELECT COUNT(*) FROM messages WHERE session_id = ?),
                    last_active = ?
                WHERE id = ?
            `),
            exportMessages: this.db.prepare(`
                SELECT id, session_id, role, content, metadata_json, timestamp, date_iso
                FROM messages
                ORDER BY timestamp ASC, rowid ASC
            `),
            listSessionsByPrefix: this.db.prepare(`
                SELECT id, created_at, last_active, message_count, summary_count
                FROM sessions
                WHERE id LIKE ?
                ORDER BY last_active DESC
            `),
            upsertMemoryNamespace: this.db.prepare(`
                INSERT INTO memory_namespaces (id, scope_type, scope_key, character_name, preset_name, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    updated_at = excluded.updated_at,
                    character_name = excluded.character_name,
                    preset_name = excluded.preset_name
            `),
            findMemoryNamespace: this.db.prepare(`
                SELECT * FROM memory_namespaces
                WHERE scope_type = ? AND scope_key = ? AND IFNULL(character_name, '') = IFNULL(?, '') AND IFNULL(preset_name, '') = IFNULL(?, '')
                LIMIT 1
            `),
            insertMemoryEntry: this.db.prepare(`
                INSERT INTO memory_entries (id, namespace_id, source_session_id, source_message_id, entry_type, title, content, tags_json, metadata_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),
            recentMemoryEntries: this.db.prepare(`
                SELECT id, entry_type, title, content, tags_json, metadata_json, source_session_id, source_message_id, created_at, updated_at
                FROM memory_entries
                WHERE namespace_id = ?
                ORDER BY updated_at DESC, rowid DESC
                LIMIT ?
            `),
            searchMemoryEntries: this.db.prepare(`
                SELECT id, entry_type, title, content, tags_json, metadata_json, source_session_id, source_message_id, created_at, updated_at
                FROM memory_entries
                WHERE namespace_id = ? AND content LIKE ?
                ORDER BY updated_at DESC, rowid DESC
                LIMIT ?
            `),
            // >>> cross-scope recall patch >>>
            // 跨场景召回：捞「当前发言人**自己在别的会话里**说过的话」（含别的群、含私聊）。
            //
            // 🔴 安全全靠那两件套，缺一不可：
            //   1) `|QQ:<id>|` **作者过滤** —— 只捞这个人自己写的。别人的发言一条都进不来；
            //      也顺带保证了**别人的私聊命名空间**不可能被命中（那里面的作者不是他）。
            //      尾部的 `|` 是防前缀碰撞（2063362809 vs 20633628090）。
            //   2) `ns.scope_key != ?` **排除当前会话** —— 当前会话的内容走原来的同作用域召回，
            //      不要在这里重复捞。
            // ⚠ 限定 `entry_type='conversation'`：不要画像/知识条目。
            //
            // ⛔ 仍然**不做**的事：把「别人」的话带到他不在的场合。那会在 A 群念出 B 群某人的私事。
            //    这条不是技术限制，是别把别人的话搬给第三方看 —— 即使用户说"都是我的机器人"，
            //    群里坐着的其它成员也不是他的。
            searchCrossScopeEntriesByParticipant: this.db.prepare(`
                SELECT
                    e.id, e.entry_type, e.title, e.content, e.tags_json, e.metadata_json,
                    e.source_session_id, e.source_message_id, e.created_at, e.updated_at,
                    ns.scope_key AS origin_scope_key
                FROM memory_entries e
                JOIN memory_namespaces ns ON ns.id = e.namespace_id
                WHERE ns.scope_key <> ?
                    AND e.entry_type = 'conversation'
                    AND e.content LIKE ?
                    AND e.content LIKE ?
                ORDER BY e.updated_at DESC, e.rowid DESC
                LIMIT ?
            `),
            // 档位 B：他自己 + **所有群里任何人**说的话（跨群互通）。
            // `includeOthersInGroups: true` 时用这条。用户 2026-10-11 的论据：
            // 「我都能把机器人拉到群里说明这个群都是熟人」。
            searchCrossScopeWithGroups: this.db.prepare(`
                SELECT
                    e.id, e.entry_type, e.title, e.content, e.tags_json, e.metadata_json,
                    e.source_session_id, e.source_message_id, e.created_at, e.updated_at,
                    ns.scope_key AS origin_scope_key
                FROM memory_entries e
                JOIN memory_namespaces ns ON ns.id = e.namespace_id
                WHERE ns.scope_key <> ?
                    AND e.entry_type = 'conversation'
                    -- 🔴 括号必须只包住「作者条件」，不能包住关键词条件！
                    --    第一版写成 author AND (keyword OR group_shared) ⇒ 群条目
                    --    不需要命中关键词就能进来，等于捞回一堆无关的近期群消息
                    --    （测试里"捞军训结果 20 条全是自己的、且都不含军训"就是这么抓到的）。
                    -- ⚠ 这个注释在 JS 模板字符串里，别用反引号（会截断模板）。
                    AND (e.content LIKE ? OR ns.scope_type = 'group_shared')
                    AND e.content LIKE ?
                ORDER BY e.updated_at DESC, e.rowid DESC
                LIMIT ?
            `),
            // 档位 C：**连别人的私聊内容也公开**。`includeOthersPrivate: true` 时才用，
            // 默认关 —— 用户的论据只覆盖了"群都是熟人"，没覆盖"一对一私聊也能公开"。
            searchCrossScopeAll: this.db.prepare(`
                SELECT
                    e.id, e.entry_type, e.title, e.content, e.tags_json, e.metadata_json,
                    e.source_session_id, e.source_message_id, e.created_at, e.updated_at,
                    ns.scope_key AS origin_scope_key
                FROM memory_entries e
                JOIN memory_namespaces ns ON ns.id = e.namespace_id
                WHERE ns.scope_key <> ?
                    AND e.entry_type = 'conversation'
                    AND e.content LIKE ?
                ORDER BY e.updated_at DESC, e.rowid DESC
                LIMIT ?
            `),
            // <<< cross-scope recall patch <<<
            // >>> participant-roster patch >>>
            // 「认识谁」读的是**持久表** participant_contacts，不是 messages。
            // 理由：messages 会被摘要删掉，而"认识"应该是永久的。见 prepareSchema 里的建表注释。
            listRecentContacts: this.db.prepare(`
                SELECT
                    participant_id,
                    display_name,
                    name_history,
                    first_seen_at,
                    last_seen_at,
                    message_count,
                    last_scope_kind,
                    last_scope_key
                FROM participant_contacts
                ORDER BY last_seen_at DESC
                LIMIT ?
            `),
            getContact: this.db.prepare(`
                SELECT participant_id, display_name, name_history, first_seen_at, last_seen_at,
                       message_count, last_scope_kind, last_scope_key
                FROM participant_contacts
                WHERE participant_id = ?
            `),
            upsertContact: this.db.prepare(`
                INSERT INTO participant_contacts (
                    participant_id, display_name, name_history, first_seen_at,
                    last_seen_at, message_count, last_scope_kind, last_scope_key
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(participant_id) DO UPDATE SET
                    display_name    = excluded.display_name,
                    name_history    = excluded.name_history,
                    first_seen_at   = excluded.first_seen_at,
                    last_seen_at    = excluded.last_seen_at,
                    message_count   = excluded.message_count,
                    last_scope_kind = excluded.last_scope_kind,
                    last_scope_key  = excluded.last_scope_key
            `),
            // 一次性回填的**数据来源**（只在表为空时跑一次）。
            // ⚠ 要点（都踩过）：
            //  - 用户消息的 `metadata_json.participants` 是权威发言人名单，格式
            //    `["明末美食家(3184426518)","werwer(2063362809)"]`，实测 167/167 条非空。
            //  - ⚠ **别用 `metadata_json.userId`**：它是"触发那次的主发言人"，批量合并时
            //    和正文头对不上（实测有行 userId=werwer 但正文头是 QQ:3184426518|明末美食家）。
            //  - ⚠ **别用「每个会话取一条」**：那样一个群只会出**最后发言的那一个人**
            //    （实测 group:929159193 里出现过 17 个人，旧写法全库只给 6 行，平铺后 26 行）。
            //  - ⚠ **别用 `MAX(content)` 配 GROUP BY**：那是任取一行，不是最新那行。
            //  - `ORDER BY timestamp ASC` 是故意的：recordContact 把新名字**插到前面**，
            //    所以按时间正序喂，最后得到的历史就是"最近在前"。
            backfillContactSources: this.db.prepare(`
                SELECT
                    m.session_id,
                    TRIM(je.value) AS who,
                    MAX(m.timestamp) AS timestamp,
                    COUNT(*) AS count
                FROM messages m, json_each(json_extract(m.metadata_json, '$.participants')) je
                WHERE m.role = 'user'
                    AND IFNULL(m.metadata_json, '') <> ''
                    AND json_valid(m.metadata_json)
                    AND TRIM(je.value) <> ''
                GROUP BY m.session_id, TRIM(je.value)
                ORDER BY timestamp ASC
            `),
            countContacts: this.db.prepare(`SELECT COUNT(*) AS n FROM participant_contacts`),
            // <<< participant-roster patch <<<
            listParticipantProfiles: this.db.prepare(`
                WITH profiles AS (
                    SELECT
                        me.id,
                        me.namespace_id,
                        me.title,
                        me.content,
                        me.tags_json,
                        me.metadata_json,
                        me.source_session_id,
                        me.source_message_id,
                        me.created_at,
                        me.updated_at,
                        me.rowid AS entry_rowid,
                        ns.scope_type,
                        ns.scope_key,
                        ns.character_name,
                        ns.preset_name,
                        COALESCE(NULLIF(CAST(json_extract(me.metadata_json, '$.participantId') AS TEXT), ''), me.id) AS participant_key,
                        IFNULL(ns.character_name, '') AS character_key,
                        IFNULL(ns.preset_name, '') AS preset_key
                    FROM memory_entries me
                    INNER JOIN memory_namespaces ns ON ns.id = me.namespace_id
                    WHERE me.entry_type = 'participant_profile'
                ),
                ranked AS (
                    SELECT
                        *,
                        ROW_NUMBER() OVER (
                            PARTITION BY participant_key, scope_type, scope_key, character_key
                            ORDER BY updated_at DESC, entry_rowid DESC
                        ) AS profile_rank
                    FROM profiles
                )
                SELECT
                    id,
                    namespace_id,
                    title,
                    content,
                    tags_json,
                    metadata_json,
                    source_session_id,
                    source_message_id,
                    created_at,
                    updated_at,
                    scope_type,
                    scope_key,
                    character_name,
                    preset_name
                FROM ranked
                WHERE profile_rank = 1
                ORDER BY updated_at DESC, entry_rowid DESC
                LIMIT ?
            `),
            listParticipantProfilesFiltered: this.db.prepare(`
                WITH profiles AS (
                    SELECT
                        me.id,
                        me.namespace_id,
                        me.title,
                        me.content,
                        me.tags_json,
                        me.metadata_json,
                        me.source_session_id,
                        me.source_message_id,
                        me.created_at,
                        me.updated_at,
                        me.rowid AS entry_rowid,
                        ns.scope_type,
                        ns.scope_key,
                        ns.character_name,
                        ns.preset_name,
                        COALESCE(NULLIF(CAST(json_extract(me.metadata_json, '$.participantId') AS TEXT), ''), me.id) AS participant_key,
                        IFNULL(ns.character_name, '') AS character_key,
                        IFNULL(ns.preset_name, '') AS preset_key
                    FROM memory_entries me
                    INNER JOIN memory_namespaces ns ON ns.id = me.namespace_id
                    WHERE me.entry_type = 'participant_profile'
                ),
                ranked AS (
                    SELECT
                        *,
                        ROW_NUMBER() OVER (
                            PARTITION BY participant_key, scope_type, scope_key, character_key
                            ORDER BY updated_at DESC, entry_rowid DESC
                        ) AS profile_rank,
                        MAX(CASE WHEN (
                            IFNULL(title, '') LIKE ?
                            OR IFNULL(content, '') LIKE ?
                            OR IFNULL(participant_key, '') LIKE ?
                            OR IFNULL(CAST(json_extract(metadata_json, '$.participantName') AS TEXT), '') LIKE ?
                            OR IFNULL(scope_key, '') LIKE ?
                            OR IFNULL(character_name, '') LIKE ?
                            OR IFNULL(preset_name, '') LIKE ?
                        ) THEN 1 ELSE 0 END) OVER (
                            PARTITION BY participant_key, scope_type, scope_key, character_key
                        ) AS group_matches
                    FROM profiles
                )
                SELECT
                    id,
                    namespace_id,
                    title,
                    content,
                    tags_json,
                    metadata_json,
                    source_session_id,
                    source_message_id,
                    created_at,
                    updated_at,
                    scope_type,
                    scope_key,
                    character_name,
                    preset_name
                FROM ranked
                WHERE profile_rank = 1 AND group_matches = 1
                ORDER BY updated_at DESC, entry_rowid DESC
                LIMIT ?
            `),
            countParticipantProfiles: this.db.prepare(`
                WITH profiles AS (
                    SELECT
                        COALESCE(NULLIF(CAST(json_extract(me.metadata_json, '$.participantId') AS TEXT), ''), me.id) AS participant_key,
                        ns.scope_type,
                        ns.scope_key,
                        IFNULL(ns.character_name, '') AS character_key,
                        IFNULL(ns.preset_name, '') AS preset_key
                    FROM memory_entries me
                    INNER JOIN memory_namespaces ns ON ns.id = me.namespace_id
                    WHERE me.entry_type = 'participant_profile'
                )
                SELECT COUNT(*) AS count
                FROM (
                    SELECT 1
                    FROM profiles
                    GROUP BY participant_key, scope_type, scope_key, character_key
                )
            `),
            countParticipantProfilesFiltered: this.db.prepare(`
                WITH profiles AS (
                    SELECT
                        me.title,
                        me.content,
                        me.metadata_json,
                        ns.scope_type,
                        ns.scope_key,
                        ns.character_name,
                        ns.preset_name,
                        COALESCE(NULLIF(CAST(json_extract(me.metadata_json, '$.participantId') AS TEXT), ''), me.id) AS participant_key,
                        IFNULL(ns.character_name, '') AS character_key,
                        IFNULL(ns.preset_name, '') AS preset_key
                    FROM memory_entries me
                    INNER JOIN memory_namespaces ns ON ns.id = me.namespace_id
                    WHERE me.entry_type = 'participant_profile'
                )
                SELECT COUNT(*) AS count
                FROM (
                    SELECT 1
                    FROM profiles
                    WHERE IFNULL(title, '') LIKE ?
                       OR IFNULL(content, '') LIKE ?
                       OR IFNULL(participant_key, '') LIKE ?
                       OR IFNULL(CAST(json_extract(metadata_json, '$.participantName') AS TEXT), '') LIKE ?
                       OR IFNULL(scope_key, '') LIKE ?
                       OR IFNULL(character_name, '') LIKE ?
                       OR IFNULL(preset_name, '') LIKE ?
                    GROUP BY participant_key, scope_type, scope_key, character_key
                )
            `),
            getParticipantProfileByEntryId: this.db.prepare(`
                SELECT
                    me.id,
                    me.namespace_id,
                    me.title,
                    me.content,
                    me.tags_json,
                    me.metadata_json,
                    me.source_session_id,
                    me.source_message_id,
                    me.created_at,
                    me.updated_at,
                    ns.scope_type,
                    ns.scope_key,
                    ns.character_name,
                    ns.preset_name
                FROM memory_entries me
                INNER JOIN memory_namespaces ns ON ns.id = me.namespace_id
                WHERE me.id = ? AND me.entry_type = 'participant_profile'
                LIMIT 1
            `),
            listVariables: this.db.prepare(`
                SELECT
                    me.id,
                    me.namespace_id,
                    me.title,
                    me.content,
                    me.tags_json,
                    me.metadata_json,
                    me.source_session_id,
                    me.source_message_id,
                    me.created_at,
                    me.updated_at,
                    ns.scope_type,
                    ns.scope_key,
                    ns.character_name,
                    ns.preset_name
                FROM memory_entries me
                INNER JOIN memory_namespaces ns ON ns.id = me.namespace_id
                WHERE me.entry_type = 'variable'
                  AND (? IS NULL OR ns.scope_type = ?)
                  AND (? IS NULL OR ns.scope_key = ?)
                  AND (? IS NULL OR IFNULL(ns.character_name, '') = ?)
                  AND (? IS NULL OR IFNULL(ns.preset_name, '') = ?)
                  AND (? IS NULL OR me.title LIKE ? OR me.content LIKE ? OR IFNULL(me.tags_json, '') LIKE ? OR IFNULL(me.metadata_json, '') LIKE ? OR ns.scope_type LIKE ? OR ns.scope_key LIKE ? OR IFNULL(ns.character_name, '') LIKE ? OR IFNULL(ns.preset_name, '') LIKE ?)
                ORDER BY me.updated_at DESC, me.rowid DESC
                LIMIT ?
            `),
            getVariableByEntryId: this.db.prepare(`
                SELECT
                    me.id,
                    me.namespace_id,
                    me.title,
                    me.content,
                    me.tags_json,
                    me.metadata_json,
                    me.source_session_id,
                    me.source_message_id,
                    me.created_at,
                    me.updated_at,
                    ns.scope_type,
                    ns.scope_key,
                    ns.character_name,
                    ns.preset_name
                FROM memory_entries me
                INNER JOIN memory_namespaces ns ON ns.id = me.namespace_id
                WHERE me.id = ? AND me.entry_type = 'variable'
                LIMIT 1
            `),
            listKnowledgeEntries: this.db.prepare(`
                SELECT
                    me.id,
                    me.namespace_id,
                    me.entry_type,
                    me.title,
                    me.content,
                    me.tags_json,
                    me.metadata_json,
                    me.source_session_id,
                    me.source_message_id,
                    me.created_at,
                    me.updated_at,
                    ns.scope_type,
                    ns.scope_key,
                    ns.character_name,
                    ns.preset_name
                FROM memory_entries me
                INNER JOIN memory_namespaces ns ON ns.id = me.namespace_id
                WHERE me.entry_type IN ('knowledge_fixed', 'knowledge_dynamic')
                  AND (? IS NULL OR ns.scope_type = ?)
                  AND (? IS NULL OR ns.scope_key = ?)
                  AND (? IS NULL OR IFNULL(ns.character_name, '') = ?)
                  AND (? IS NULL OR IFNULL(ns.preset_name, '') = ?)
                  AND (? IS NULL OR me.entry_type = ?)
                  AND (? IS NULL OR me.title LIKE ? OR me.content LIKE ? OR IFNULL(me.tags_json, '') LIKE ? OR IFNULL(me.metadata_json, '') LIKE ? OR ns.scope_type LIKE ? OR ns.scope_key LIKE ? OR IFNULL(ns.character_name, '') LIKE ? OR IFNULL(ns.preset_name, '') LIKE ?)
                ORDER BY me.updated_at DESC, me.rowid DESC
                LIMIT ?
            `),
            getKnowledgeByEntryId: this.db.prepare(`
                SELECT
                    me.id,
                    me.namespace_id,
                    me.entry_type,
                    me.title,
                    me.content,
                    me.tags_json,
                    me.metadata_json,
                    me.source_session_id,
                    me.source_message_id,
                    me.created_at,
                    me.updated_at,
                    ns.scope_type,
                    ns.scope_key,
                    ns.character_name,
                    ns.preset_name
                FROM memory_entries me
                INNER JOIN memory_namespaces ns ON ns.id = me.namespace_id
                WHERE me.id = ? AND me.entry_type IN ('knowledge_fixed', 'knowledge_dynamic')
                LIMIT 1
            `),
            findVariableByName: this.db.prepare(`
                SELECT id, namespace_id, title, content, tags_json, metadata_json, source_session_id, source_message_id, created_at, updated_at
                FROM memory_entries
                WHERE namespace_id = ? AND entry_type = 'variable' AND title = ?
                ORDER BY updated_at DESC, rowid DESC
                LIMIT 1
            `),
            updateMemoryEntry: this.db.prepare(`
                UPDATE memory_entries
                SET title = ?, content = ?, tags_json = ?, metadata_json = ?, source_session_id = ?, source_message_id = ?, updated_at = ?
                WHERE id = ?
            `),
            deleteMemoryEntry: this.db.prepare('DELETE FROM memory_entries WHERE id = ?'),
            listParticipantMessages: this.db.prepare(`
                SELECT session_id, role, content, metadata_json, timestamp, date_iso
                FROM messages
                WHERE CAST(json_extract(metadata_json, '$.userId') AS TEXT) = ?
                  AND timestamp > ?
                ORDER BY timestamp ASC, rowid ASC
                LIMIT ?
            `),
            listSessionMessagesSince: this.db.prepare(`
                SELECT session_id, role, content, metadata_json, timestamp, date_iso
                FROM messages
                WHERE session_id = ?
                  AND timestamp > ?
                ORDER BY timestamp ASC, rowid ASC
                LIMIT ?
            `),
            listParticipantIdentitySources: this.db.prepare(`
                SELECT session_id, role, content, metadata_json, timestamp, date_iso
                FROM messages
                WHERE CAST(json_extract(metadata_json, '$.userId') AS TEXT) = ?
                ORDER BY timestamp DESC, rowid DESC
                LIMIT ?
            `),
            exportMemoryNamespaces: this.db.prepare(`
                SELECT id, scope_type, scope_key, character_name, preset_name, created_at, updated_at
                FROM memory_namespaces
                ORDER BY updated_at ASC, rowid ASC
            `),
            exportMemoryEntries: this.db.prepare(`
                SELECT id, namespace_id, source_session_id, source_message_id, entry_type, title, content, tags_json, metadata_json, created_at, updated_at
                FROM memory_entries
                ORDER BY updated_at ASC, rowid ASC
            `),
            exportSummaryIndexEntries: this.db.prepare(`
                SELECT id, namespace_id, source_summary_id, source_session_id, outline, keywords_json, metadata_json, created_at, updated_at
                FROM summary_index_entries
                ORDER BY updated_at ASC, rowid ASC
            `),
            insertSummaryIndexEntry: this.db.prepare(`
                INSERT INTO summary_index_entries (id, namespace_id, source_summary_id, source_session_id, outline, keywords_json, metadata_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),
            recentSummaryIndexEntries: this.db.prepare(`
                SELECT id, source_summary_id, source_session_id, outline, keywords_json, metadata_json, created_at, updated_at
                FROM summary_index_entries
                WHERE namespace_id = ?
                ORDER BY updated_at DESC, rowid DESC
                LIMIT ?
            `)
        };

    }

    async withSessionLock(sessionId, task) {
        const previous = this.locks.get(sessionId) || Promise.resolve();
        let release;
        const current = new Promise((resolve) => {
            release = resolve;
        });

        this.locks.set(sessionId, previous.then(() => current));
        await previous;

        try {
            return await task();
        } finally {
            release();
            if (this.locks.get(sessionId) === current) {
                this.locks.delete(sessionId);
            }
        }
    }

    ensureSession(sessionId) {
        const now = Date.now();
        this.statements.insertSession.run(sessionId, now, now);
        return this.statements.getSession.get(sessionId);
    }

    addMessage(sessionId, role, content, metadata = {}) {
        this.ensureSession(sessionId);

        const id = metadata.id || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const timestamp = Date.now();
        const dateIso = new Date(timestamp).toISOString();

        this.db.exec('BEGIN');
        try {
            this.statements.insertMessage.run(
                id,
                sessionId,
                role,
                content,
                JSON.stringify({ ...metadata, id }),
                timestamp,
                dateIso
            );
            this.statements.updateSessionActivity.run(timestamp, 1, sessionId);
            // >>> participant-roster patch >>>
            try {
                this.recordContactsFromMessage(sessionId, metadata, timestamp);
            } catch (error) {
                // ⚠ 名册是附加能力。它的失败绝不能把一条消息一起回滚掉。
                this.logger?.warn?.('[身份名册] 记录联系人失败', { sessionId, error: error?.message });
            }
            // <<< participant-roster patch <<<
            this.enforceGlobalMessageLimit(timestamp);
            this.db.exec('COMMIT');
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }

        this.logger.debug?.('[记忆] 已写入消息', {
            sessionId,
            messageId: id,
            role,
            content: summarizeText(content),
            metadataKeys: Object.keys(metadata || {}).slice(0, 10)
        });

        return {
            id,
            role,
            content,
            metadata,
            timestamp,
            date: dateIso
        };
    }

    enforceGlobalMessageLimit(timestamp = Date.now()) {
        const limit = Number(this.maxGlobalMessages) || 0;
        if (limit <= 0) {
            return;
        }

        const totalMessages = this.statements.countAllMessages.get()?.count || 0;
        const overflow = totalMessages - limit;
        if (overflow <= 0) {
            return;
        }

        const rows = this.statements.getOldestGlobalMessages.all(overflow);
        if (rows.length === 0) {
            return;
        }

        const affectedSessionIds = new Set();
        for (const row of rows) {
            this.statements.deleteGlobalMessageById.run(row.id);
            affectedSessionIds.add(row.session_id);
        }

        for (const affectedSessionId of affectedSessionIds) {
            this.statements.recalcSessionMessageCount.run(affectedSessionId, timestamp, affectedSessionId);
        }
    }

    getContext(sessionId, limit = null, scopeKey = '') {
        this.ensureSession(sessionId);
        const effectiveLimit = limit ?? this.maxHistoryLength;
        let recentMessages = this.getHistory(sessionId, scopeKey ? chatScopePullLimit(effectiveLimit) : effectiveLimit);
        if (scopeKey) {
            recentMessages = filterMessagesForChat(recentMessages, scopeKey).slice(-effectiveLimit);
        }
        return {
            sessionId,
            recentMessages,
            summaries: this.getSummaries(sessionId),
            stickyKeys: this.getStickyEntryKeys(sessionId)
        };
    }

    getSession(sessionId) {
        const session = this.statements.getSession.get(sessionId);
        if (!session) {
            return null;
        }

        return {
            id: session.id,
            createdAt: session.created_at,
            lastActive: session.last_active,
            messageCount: session.message_count,
            summaryCount: session.summary_count,
            messages: this.getHistory(sessionId, this.maxHistoryLength),
            summaries: this.getSummaries(sessionId),
            stickyEntries: new Map(Object.entries(this.getStickyEntriesObject(sessionId)))
        };
    }

    getHistory(sessionId, limit = null) {
        const rows = this.statements.getRecentMessages.all(sessionId, limit ?? this.maxHistoryLength);
        return rows.reverse().map((row) => ({
            role: row.role,
            content: row.content,
            timestamp: row.timestamp,
            date: row.date_iso,
            metadata: parseJson(row.metadata_json, {})
        }));
    }

    getGlobalHistory(limit = null, includeMetadata = false) {
        const rows = this.statements.globalTimeline.all(limit ?? this.maxHistoryLength).reverse();
        if (includeMetadata) {
            return rows.map((row) => ({
                sessionId: row.session_id,
                role: row.role,
                content: row.content,
                timestamp: row.timestamp,
                date: row.date_iso
            }));
        }

        return rows.map((row) => ({
            role: row.role,
            content: row.content
        }));
    }

    getSummaries(sessionId) {
        return this.statements.getSummaries.all(sessionId).map((row) => ({
            id: row.id,
            content: row.content,
            sourceCount: row.source_count,
            createdAt: row.created_at,
            date: row.date_iso
        }));
    }

    getStickyEntriesObject(sessionId) {
        const rows = this.statements.getStickyEntries.all(sessionId);
        const sticky = {};
        for (const row of rows) {
            sticky[row.entry_key] = row.remaining;
        }
        return sticky;
    }

    getStickyEntryKeys(sessionId) {
        return new Set(Object.keys(this.getStickyEntriesObject(sessionId)));
    }

    updateStickyEntries(sessionId, triggeredEntries) {
        this.ensureSession(sessionId);
        const currentSticky = this.getStickyEntriesObject(sessionId);

        this.db.exec('BEGIN');
        try {
            for (const [entryKey, remaining] of Object.entries(currentSticky)) {
                const nextRemaining = remaining - 1;
                if (nextRemaining <= 0) {
                    this.statements.deleteStickyEntry.run(sessionId, entryKey);
                } else {
                    this.statements.upsertStickyEntry.run(sessionId, entryKey, nextRemaining);
                }
            }

            for (const entry of triggeredEntries) {
                if (entry.sticky && entry.sticky > 0) {
                    this.statements.upsertStickyEntry.run(sessionId, entry.key, entry.sticky);
                }
            }

            this.db.exec('COMMIT');
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    async maybeSummarizeSession(sessionId, summarizer) {
        if (!this.summaryConfig.enabled) {
            return null;
        }

        this.ensureSession(sessionId);
        const totalMessages = this.statements.getSessionMessageCount.get(sessionId)?.count || 0;
        if (totalMessages <= this.summaryConfig.triggerMessages) {
            return null;
        }

        const keepRecent = Math.max(1, this.summaryConfig.keepRecent);
        const sourceLimit = Math.max(0, totalMessages - keepRecent);
        if (sourceLimit <= 0) {
            return null;
        }

        const sourceRows = this.statements.getMessagesForSummary.all(
            sessionId,
            Math.min(sourceLimit, this.summaryConfig.maxSourceMessages)
        );

        if (sourceRows.length === 0) {
            return null;
        }

        this.logger.info?.('[记忆] 开始生成摘要', {
            sessionId,
            totalMessages,
            sourceCount: sourceRows.length,
            keepRecent,
            useAI: this.summaryConfig.useAI && typeof summarizer === 'function'
        });

        const sourceMessages = sourceRows.map((row) => ({
            id: row.id,
            role: row.role,
            content: row.content,
            metadata: parseJson(row.metadata_json, {}),
            timestamp: row.timestamp,
            date: row.date_iso
        }));

        let summaryText = this.buildFallbackSummary(sessionId, sourceMessages);
        if (this.summaryConfig.useAI && typeof summarizer === 'function') {
            try {
                const generated = await summarizer(sourceMessages, sessionId, this.getSummaries(sessionId));
                const generatedText = typeof generated === 'string'
                    ? generated
                    : (generated && typeof generated.content === 'string' ? generated.content : '');
                if (generatedText && generatedText.trim()) {
                    summaryText = generatedText.trim();
                }
            } catch (error) {
                this.logger.warn?.(`[记忆] AI 摘要失败，回退到规则摘要: ${error.message}`);
            }
        }

        const summaryId = `summary_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const summaryTime = Date.now();
        const summaryDate = new Date(summaryTime).toISOString();

        this.db.exec('BEGIN');
        try {
            this.statements.insertSummary.run(
                summaryId,
                sessionId,
                summaryText,
                sourceMessages.length,
                summaryTime,
                summaryDate
            );

            for (const message of sourceMessages) {
                this.statements.deleteMessagesByIds.run(sessionId, message.id);
            }

            const summaryCount = this.statements.getSummaries.all(sessionId).length;
            if (summaryCount > this.summaryConfig.maxSummaries) {
                this.statements.deleteOldSummaries.run(
                    sessionId,
                    sessionId,
                    summaryCount - this.summaryConfig.maxSummaries
                );
            }

            this.statements.updateSessionSummaryCount.run(
                Math.min(summaryCount, this.summaryConfig.maxSummaries),
                summaryTime,
                sessionId
            );

            this.db.exec('COMMIT');
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }

        this.logger.info?.('[记忆] 摘要生成完成', {
            sessionId,
            summaryId,
            sourceCount: sourceMessages.length,
            summaryCount: this.statements.getSummaries.all(sessionId).length,
            content: summarizeText(summaryText, 160)
        });
        return {
            id: summaryId,
            content: summaryText,
            sourceCount: sourceMessages.length,
            createdAt: summaryTime,
            date: summaryDate
        };
    }

    buildFallbackSummary(sessionId, messages) {
        const userHighlights = [];
        const assistantHighlights = [];

        for (const message of messages) {
            const line = truncate(message.content, 160);
            if (message.role === 'assistant') {
                assistantHighlights.push(line);
            } else {
                userHighlights.push(line);
            }
        }

        const parts = [
            `会话 ${sessionId} 的历史摘要：`,
            userHighlights.length > 0 ? `用户侧重点：${userHighlights.slice(-4).join(' | ')}` : '',
            assistantHighlights.length > 0 ? `助手侧回应：${assistantHighlights.slice(-4).join(' | ')}` : ''
        ].filter(Boolean);

        return parts.join('\n');
    }

    clearSession(sessionId) {
        this.db.exec('BEGIN');
        try {
            this.statements.clearSessionMessages.run(sessionId);
            this.statements.clearSessionSummaries.run(sessionId);
            this.statements.deleteStickyEntriesBySession.run(sessionId);
            this.statements.deleteSession.run(sessionId);
            this.db.exec('COMMIT');
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    clearHistory(sessionId) {
        this.ensureSession(sessionId);
        this.db.exec('BEGIN');
        try {
            this.statements.clearSessionMessages.run(sessionId);
            this.statements.clearSessionSummaries.run(sessionId);
            this.statements.deleteStickyEntriesBySession.run(sessionId);
            this.statements.updateSessionSummaryCount.run(0, Date.now(), sessionId);
            this.db.exec('COMMIT');
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    deleteSession(sessionId) {
        this.clearSession(sessionId);
    }

    // >>> recall-delete patch (managed by patch_recall.py) >>>
    /**
     * 撤回的消息从历史里清掉。
     * messages.metadata_json 里存了 inboundMessageIds / standardEvents[].messageId，
     * 用 messageId 精确定位；命中多条的合并行只摘撤回那条的正文，不误伤同批其他消息。
     * @returns {{removed:number, stripped:number, error?:string}}
     */
    deleteRecalledMessage(sessionId, inboundMessageId) {
        const target = String(inboundMessageId === undefined || inboundMessageId === null
            ? '' : inboundMessageId).trim();
        if (!sessionId || !target) return { removed: 0, stripped: 0 };
        let rows = [];
        try {
            rows = this.db.prepare(
                'SELECT id, content, metadata_json FROM messages '
                + 'WHERE session_id = ? AND metadata_json LIKE ?'
            ).all(sessionId, '%' + target + '%');
        } catch (error) {
            this.logger?.warn?.(`[撤回] 查询历史失败: ${error.message}`);
            return { removed: 0, stripped: 0, error: error.message };
        }
        const updateStmt = this.db.prepare(
            'UPDATE messages SET content = ?, metadata_json = ? WHERE session_id = ? AND id = ?'
        );
        let removed = 0;
        let stripped = 0;
        for (const row of rows) {
            let meta = null;
            try {
                meta = JSON.parse(row.metadata_json || '{}');
            } catch {
                meta = null;
            }
            if (!meta || typeof meta !== 'object') continue;
            const ids = Array.isArray(meta.inboundMessageIds)
                ? meta.inboundMessageIds.map((v) => String(v)) : [];
            const events = Array.isArray(meta.standardEvents) ? meta.standardEvents : [];
            const evIds = events.map((e) => String(e && e.messageId ? e.messageId : '')).filter(Boolean);
            if (!ids.includes(target) && !evIds.includes(target)) continue;

            if (ids.length <= 1) {
                this.statements.deleteMessagesByIds.run(sessionId, row.id);
                removed += 1;
                continue;
            }

            const recalledTexts = events
                .filter((e) => String(e && e.messageId ? e.messageId : '') === target)
                .map((e) => String((e && (e.rawText || e.contentText)) || '').trim())
                .filter(Boolean);
            let content = String(row.content || '');
            for (const t of recalledTexts) {
                content = content.split(t).join('');
            }
            const leftIds = ids.filter((x) => x !== target);
            const leftEvents = events.filter((e) => String(e && e.messageId ? e.messageId : '') !== target);
            updateStmt.run(
                content.trim(),
                JSON.stringify({ ...meta, inboundMessageIds: leftIds, standardEvents: leftEvents, mergedCount: leftIds.length }),
                sessionId,
                row.id
            );
            stripped += 1;
        }
        return { removed, stripped };
    }
    // <<< recall-delete patch <<<

    listSessions() {
        return this.statements.listSessions.all().map((row) => ({
            id: row.id,
            messageCount: row.message_count,
            summaryCount: row.summary_count,
            createdAt: row.created_at,
            lastActive: row.last_active
        }));
    }

    listSessionsByPrefix(prefix) {
        return this.statements.listSessionsByPrefix.all(`${prefix}%`).map((row) => ({
            id: row.id,
            messageCount: row.message_count,
            summaryCount: row.summary_count,
            createdAt: row.created_at,
            lastActive: row.last_active
        }));
    }

    ensureMemoryNamespace({ scopeType, scopeKey, characterName = null, presetName = null }) {
        const existing = this.statements.findMemoryNamespace.get(scopeType, scopeKey, characterName, presetName);
        if (existing) {
            return existing;
        }

        const now = Date.now();
        const id = `ns_${scopeType}_${Buffer.from(`${scopeKey}|${characterName || ''}|${presetName || ''}`).toString('base64url')}`;
        this.statements.upsertMemoryNamespace.run(id, scopeType, scopeKey, characterName, presetName, now, now);
        return this.statements.findMemoryNamespace.get(scopeType, scopeKey, characterName, presetName);
    }

    addMemoryEntry(namespaceOptions, entry = {}) {
        const namespace = this.ensureMemoryNamespace(namespaceOptions);
        const now = Date.now();
        const id = entry.id || `mem_${now}_${Math.random().toString(36).slice(2, 8)}`;
        this.statements.insertMemoryEntry.run(
            id,
            namespace.id,
            entry.sourceSessionId || null,
            entry.sourceMessageId || null,
            entry.entryType || 'note',
            entry.title || null,
            entry.content || '',
            JSON.stringify(entry.tags || []),
            JSON.stringify(entry.metadata || {}),
            now,
            now
        );
        return { id, namespaceId: namespace.id };
    }

    listRecentMemoryEntries(namespaceOptions, limit = 10) {
        const namespace = this.ensureMemoryNamespace(namespaceOptions);
        return this.statements.recentMemoryEntries.all(namespace.id, limit).map((row) => ({
            id: row.id,
            entryType: row.entry_type,
            title: row.title,
            content: row.content,
            tags: parseJson(row.tags_json, []),
            metadata: parseJson(row.metadata_json, {}),
            sourceSessionId: row.source_session_id,
            sourceMessageId: row.source_message_id,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        }));
    }

    searchMemoryEntries(namespaceOptions, query, limit = 10) {
        const namespace = this.ensureMemoryNamespace(namespaceOptions);
        return this.statements.searchMemoryEntries.all(namespace.id, `%${query}%`, limit).map((row) => ({
            id: row.id,
            entryType: row.entry_type,
            title: row.title,
            content: row.content,
            tags: parseJson(row.tags_json, []),
            metadata: parseJson(row.metadata_json, {}),
            sourceSessionId: row.source_session_id,
            sourceMessageId: row.source_message_id,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        }));
    }

    // >>> cross-scope recall patch >>>
    /**
     * 跨场景召回：把**当前发言人自己在别的会话里**说过的话捞过来（2026-10-11 用户：
     * 「把跨域记忆能打通的地方都打通」「记忆都打通要做跨群的」）。
     *
     * 覆盖范围：
     *  - 私聊里 ← 他在**任何群**里说过的话 ✓
     *  - 群里 ← 他在**别的群**和他在**私聊**里说过的话 ✓
     *  - 当前会话的内容照旧走同作用域召回（这里用 `scope_key <> 当前` 排除，不重复捞）
     *
     * 🔴 唯一的硬约束：**只捞他自己写的**（SQL 里的 `|QQ:<id>|` 作者过滤）。
     *    ⇒ 别人的发言永远进不来，**别人的私聊命名空间也永远命中不了**（那里面的作者不是他）。
     * ⛔ 仍然不做：把"别人"的话搬到他不在的场合 —— 那会在 A 群念出 B 群某人的私事。
     *
     * 结果里带 `crossScope: true` + `crossScopeKey`（来源会话），而 content 本身带着
     * `[群聊|…|群名:…|时间:…]` / `[私聊|…]` 头，所以她在提示词里**看得出这是哪儿说的**，
     * 不会说成"你刚跟我说"。
     *
     * ⚠ 实测动机：werwer 21:00 在群里说「你看小睦喝的就是soyo奶」，21:24 私聊问，
     *   她只能答「soyo奶是什么啦」（7 个命名空间互不相通，私聊召回 5 条全是私聊的）。
     *
     * @param {string} participantId 当前发言人 QQ
     * @param {string[]} keywords buildRecallKeywords 剥头后的关键词
     * @param {{excludeScopeKey?: string, limit?: number}} options
     */
    searchCrossScopeEntries(participantId, keywords, options = {}) {
        const id = String(participantId || '').trim();
        const list = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
        const limit = options.limit || 3;
        const excludeScopeKey = String(options.excludeScopeKey || '');
        const cfg = this.config?.memory?.crossScope || {};
        if (!id || list.length === 0) return [];
        const authorPattern = `%|QQ:${id}|%`;
        // 打通档位（2026-10-11 用户：「我都能把机器人拉到群里说明这个群都是熟人」）：
        //   A 只他自己 / B 他自己 + 所有群里任何人（默认）/ C 连别人的私聊也公开（默认关）
        const level = cfg.includeOthersPrivate === true
            ? 'all'
            : (cfg.includeOthersInGroups !== false ? 'groups' : 'self');
        const statement = level === 'all'
            ? this.statements.searchCrossScopeAll
            : (level === 'groups'
                ? this.statements.searchCrossScopeWithGroups
                : this.statements.searchCrossScopeEntriesByParticipant);
        const merged = new Map();
        for (const keyword of list) {
            let rows = [];
            try {
                rows = level === 'all'
                    ? statement.all(excludeScopeKey, `%${keyword}%`, Math.max(limit * 3, 8))
                    : statement.all(excludeScopeKey, authorPattern, `%${keyword}%`, Math.max(limit * 3, 8));
            } catch (error) {
                this.logger?.warn?.('[记忆] 跨场景召回失败', { participantId: id, error: error.message });
                continue;
            }
            for (const row of rows) {
                const hit = merged.get(row.id);
                if (hit) hit.hits += 1;
                else merged.set(row.id, { row, hits: 1 });
            }
        }
        return Array.from(merged.values())
            .sort((a, b) => (b.hits - a.hits) || ((b.row.updated_at || 0) - (a.row.updated_at || 0)))
            .slice(0, limit)
            .map((item) => ({
                id: item.row.id,
                entryType: item.row.entry_type,
                title: item.row.title,
                content: item.row.content,
                tags: parseJson(item.row.tags_json, []),
                metadata: parseJson(item.row.metadata_json, {}),
                sourceSessionId: item.row.source_session_id,
                sourceMessageId: item.row.source_message_id,
                createdAt: item.row.created_at,
                updatedAt: item.row.updated_at,
                crossScope: true,
                crossScopeLevel: level,
                crossScopeKey: item.row.origin_scope_key || ''
            }));
    }

    /** 兼容旧名字（第一版只做了"私聊 ← 群"）。 */
    searchCrossScopeGroupEntries(participantId, keywords, limit = 3) {
        return this.searchCrossScopeEntries(participantId, keywords, { limit });
    }
    // <<< cross-scope recall patch <<<

    listParticipantMessages(userId, options = {}) {
        const since = options.since || 0;
        const limit = options.limit || 50;
        const rows = this.statements.listParticipantMessages.all(String(userId), since, limit);

        return rows.map((row) => ({
            sessionId: row.session_id,
            role: row.role,
            content: row.content,
            metadata: parseJson(row.metadata_json, {}),
            timestamp: row.timestamp,
            date: row.date_iso
        }));
    }

    listParticipantIdentitySources(participantId, limit = 10) {
        const normalizedLimit = Math.min(Math.max(Number(limit) || 10, 1), 50);
        const rows = this.statements.listParticipantIdentitySources.all(String(participantId), normalizedLimit);

        return rows.map((row) => {
            const metadata = parseJson(row.metadata_json, {});
            return {
                participantId: String(participantId),
                participantName: extractParticipantNameFromMessage(row),
                groupId: metadata.groupId ? String(metadata.groupId) : null,
                messageType: metadata.messageType || null,
                sessionId: row.session_id,
                timestamp: row.timestamp,
                source: 'message_history'
            };
        });
    }

    getParticipantProfile(namespaceOptions, participantId) {
        const row = this.db.prepare(`
            SELECT me.id, me.namespace_id, me.entry_type, me.title, me.content, me.tags_json, me.metadata_json,
                   me.source_session_id, me.source_message_id, me.created_at, me.updated_at,
                   ns.scope_type, ns.scope_key, ns.character_name, ns.preset_name
            FROM memory_entries me
            INNER JOIN memory_namespaces ns ON ns.id = me.namespace_id
            WHERE ns.scope_type = ?
              AND ns.scope_key = ?
              AND IFNULL(ns.character_name, '') = IFNULL(?, '')
              AND me.entry_type = 'participant_profile'
              AND CAST(json_extract(me.metadata_json, '$.participantId') AS TEXT) = ?
            ORDER BY me.updated_at DESC, me.rowid DESC
            LIMIT 1
        `).get(
            namespaceOptions.scopeType,
            namespaceOptions.scopeKey,
            namespaceOptions.characterName || null,
            String(participantId)
        );
        return row ? mapParticipantProfileRow(row) : null;
    }

    listParticipantProfileIdentityRows(namespaceOptions, participantId) {
        return this.db.prepare(`
            SELECT
                me.id,
                me.namespace_id,
                me.entry_type,
                me.title,
                me.content,
                me.tags_json,
                me.metadata_json,
                me.source_session_id,
                me.source_message_id,
                me.created_at,
                me.updated_at,
                me.rowid AS entry_rowid,
                ns.scope_type,
                ns.scope_key,
                ns.character_name,
                ns.preset_name
            FROM memory_entries me
            INNER JOIN memory_namespaces ns ON ns.id = me.namespace_id
            WHERE ns.scope_type = ?
              AND ns.scope_key = ?
              AND IFNULL(ns.character_name, '') = IFNULL(?, '')
              AND me.entry_type = 'participant_profile'
              AND CAST(json_extract(me.metadata_json, '$.participantId') AS TEXT) = ?
            ORDER BY me.updated_at DESC, me.rowid DESC
        `).all(
            namespaceOptions.scopeType,
            namespaceOptions.scopeKey,
            namespaceOptions.characterName || null,
            String(participantId)
        );
    }

    listParticipantProfileIdentityProfiles(namespaceOptions, participantId) {
        return this.listParticipantProfileIdentityRows(namespaceOptions, participantId).map(mapParticipantProfileRow);
    }

    getLatestParticipantIdentity(participantId) {
        return this.listParticipantIdentitySources(participantId, 1)[0] || null;
    }

    refreshParticipantProfileName(entryId, identityOverride = null) {
        const existing = this.getParticipantProfileByEntryId(entryId);
        if (!existing) {
            return null;
        }
        const identity = identityOverride || this.getLatestParticipantIdentity(existing.participantId);
        const latestName = String(identity?.participantName || '').trim();
        if (!latestName) {
            return { item: existing, changed: false, reason: 'no_latest_name' };
        }

        const now = Date.now();
        const metadata = {
            ...existing.metadata,
            participantId: existing.participantId,
            participantName: latestName,
            lastParticipantNameRefreshAt: now,
            lastParticipantNameSourceAt: identity.timestamp || null,
            lastParticipantNameSource: identity.source || 'message_history'
        };
        if (identity.groupId) {
            metadata.groupId = String(identity.groupId);
        }
        if (identity.messageType) {
            metadata.messageType = identity.messageType;
        }
        this.statements.updateMemoryEntry.run(
            latestName,
            existing.content,
            JSON.stringify(existing.tags || []),
            JSON.stringify(metadata),
            existing.sourceSessionId || null,
            existing.sourceMessageId || null,
            now,
            existing.id
        );
        return {
            item: this.getParticipantProfileByEntryId(existing.id),
            changed: latestName !== existing.participantName,
            participantName: latestName,
            source: metadata.lastParticipantNameSource
        };
    }

    listVariables(filters = {}) {
        const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
        const scopeType = filters.scopeType || null;
        const scopeKey = filters.scopeKey || null;
        const characterName = filters.characterName || null;
        const presetName = filters.presetName || null;
        const search = filters.search ? `%${String(filters.search).trim()}%` : null;

        return this.statements.listVariables.all(
            scopeType,
            scopeType,
            scopeKey,
            scopeKey,
            characterName,
            characterName,
            presetName,
            presetName,
            search,
            search,
            search,
            search,
            search,
            search,
            search,
            search,
            search,
            limit
        ).map(mapVariableRow);
    }

    getVariable(namespaceOptions, key) {
        if (!key) {
            return null;
        }

        const namespace = this.ensureMemoryNamespace(namespaceOptions);
        const row = this.statements.findVariableByName.get(namespace.id, String(key));
        if (!row) {
            return null;
        }

        return mapVariableRow({
            ...row,
            scope_type: namespace.scope_type,
            scope_key: namespace.scope_key,
            character_name: namespace.character_name,
            preset_name: namespace.preset_name
        });
    }

    getVariableByEntryId(entryId) {
        const row = this.statements.getVariableByEntryId.get(entryId);
        return row ? mapVariableRow(row) : null;
    }

    listKnowledgeEntries(filters = {}) {
        const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
        const scopeType = filters.scopeType || null;
        const scopeKey = filters.scopeKey || null;
        const characterName = filters.characterName || null;
        const presetName = filters.presetName || null;
        const knowledgeType = filters.knowledgeType === 'fixed'
            ? 'knowledge_fixed'
            : (filters.knowledgeType === 'dynamic' ? 'knowledge_dynamic' : null);
        const search = filters.search ? `%${String(filters.search).trim()}%` : null;

        return this.statements.listKnowledgeEntries.all(
            scopeType,
            scopeType,
            scopeKey,
            scopeKey,
            characterName,
            characterName,
            presetName,
            presetName,
            knowledgeType,
            knowledgeType,
            search,
            search,
            search,
            search,
            search,
            search,
            search,
            search,
            search,
            limit
        ).map(mapKnowledgeRow);
    }

    getKnowledgeByEntryId(entryId) {
        const row = this.statements.getKnowledgeByEntryId.get(entryId);
        return row ? mapKnowledgeRow(row) : null;
    }

    upsertKnowledgeEntry(namespaceOptions, knowledge = {}) {
        const title = String(knowledge.title || '').trim();
        if (!title) {
            throw new Error('知识标题不能为空');
        }

        const content = String(knowledge.content || '').trim();
        if (!content) {
            throw new Error('知识内容不能为空');
        }

        const normalizedKnowledgeType = normalizeKnowledgeType(knowledge.knowledgeType || knowledge.metadata?.knowledgeType);
        return this.addMemoryEntry(namespaceOptions, {
            entryType: normalizedKnowledgeType === 'fixed' ? 'knowledge_fixed' : 'knowledge_dynamic',
            title,
            content,
            tags: Array.isArray(knowledge.tags) ? knowledge.tags : [],
            metadata: {
                ...(knowledge.metadata || {}),
                knowledgeType: normalizedKnowledgeType,
                source: knowledge.metadata?.source || knowledge.source || 'admin',
                updatedBy: knowledge.metadata?.updatedBy || 'admin-panel'
            },
            sourceSessionId: knowledge.sourceSessionId || null,
            sourceMessageId: knowledge.sourceMessageId || null
        });
    }

    saveKnowledgeEntry(entryId, knowledge = {}) {
        const existing = this.getKnowledgeByEntryId(entryId);
        if (!existing) {
            return null;
        }

        const title = String(knowledge.title ?? existing.title ?? '').trim();
        const content = String(knowledge.content ?? existing.content ?? '').trim();
        if (!title) {
            throw new Error('知识标题不能为空');
        }
        if (!content) {
            throw new Error('知识内容不能为空');
        }

        const normalizedKnowledgeType = normalizeKnowledgeType(knowledge.knowledgeType || knowledge.metadata?.knowledgeType || existing.knowledgeType);
        const metadata = {
            ...existing.metadata,
            ...(knowledge.metadata || {}),
            knowledgeType: normalizedKnowledgeType,
            source: String((knowledge.metadata || {}).source || existing.metadata?.source || 'admin').trim() || 'admin',
            updatedBy: String((knowledge.metadata || {}).updatedBy || existing.metadata?.updatedBy || 'admin-panel').trim() || 'admin-panel'
        };
        const tags = Array.isArray(knowledge.tags) ? knowledge.tags : existing.tags;
        const now = Date.now();

        this.statements.updateMemoryEntry.run(
            title,
            content,
            JSON.stringify(tags || []),
            JSON.stringify(metadata),
            knowledge.sourceSessionId || existing.sourceSessionId || null,
            knowledge.sourceMessageId || existing.sourceMessageId || null,
            now,
            existing.id
        );

        if (existing.entryType !== (normalizedKnowledgeType === 'fixed' ? 'knowledge_fixed' : 'knowledge_dynamic')) {
            this.db.prepare(`
                UPDATE memory_entries
                SET entry_type = ?
                WHERE id = ?
            `).run(normalizedKnowledgeType === 'fixed' ? 'knowledge_fixed' : 'knowledge_dynamic', existing.id);
        }

        const saved = this.getKnowledgeByEntryId(existing.id);
        this.logger.info?.('[记忆] 知识条目已保存', {
            entryId: existing.id,
            knowledgeType: saved?.knowledgeType || normalizedKnowledgeType,
            title: saved?.title || title,
            content: summarizeText(content, 160),
            tagCount: Array.isArray(tags) ? tags.length : 0
        });
        return saved;
    }

    deleteKnowledgeEntry(entryId) {
        const existing = this.getKnowledgeByEntryId(entryId);
        if (!existing) {
            return false;
        }
        this.statements.deleteMemoryEntry.run(entryId);
        return true;
    }

    upsertVariable(namespaceOptions, variable = {}) {
        const key = String(variable.key || variable.title || '').trim();
        if (!key) {
            throw new Error('变量名不能为空');
        }

        const valueType = normalizeVariableType(variable.valueType || variable.metadata?.valueType || 'string');
        const parsedValue = Object.prototype.hasOwnProperty.call(variable, 'value')
            ? variable.value
            : parseVariableValue(variable.rawValue ?? variable.content ?? '', valueType);
        const rawValue = serializeVariableValue(parsedValue, valueType);
        const namespace = this.ensureMemoryNamespace(namespaceOptions);
        const existing = this.statements.findVariableByName.get(namespace.id, key);
        const now = Date.now();
        const metadata = {
            ...(existing ? parseJson(existing.metadata_json, {}) : {}),
            ...(variable.metadata || {}),
            valueType,
            source: variable.metadata?.source || variable.source || (existing ? parseJson(existing.metadata_json, {}).source : 'admin')
        };

        if (existing) {
            const mergedTags = [...new Set([...(variable.tags || []), ...parseJson(existing.tags_json, [])])];
            this.statements.updateMemoryEntry.run(
                key,
                rawValue,
                JSON.stringify(mergedTags),
                JSON.stringify(metadata),
                variable.sourceSessionId || existing.source_session_id || null,
                variable.sourceMessageId || existing.source_message_id || null,
                now,
                existing.id
            );
            return { id: existing.id, namespaceId: namespace.id, updated: true };
        }

        return this.addMemoryEntry(namespaceOptions, {
            entryType: 'variable',
            title: key,
            content: rawValue,
            tags: variable.tags || [],
            metadata,
            sourceSessionId: variable.sourceSessionId || null,
            sourceMessageId: variable.sourceMessageId || null
        });
    }

    deleteVariable(entryId) {
        const existing = this.getVariableByEntryId(entryId);
        if (!existing) {
            return false;
        }
        this.statements.deleteMemoryEntry.run(entryId);
        return true;
    }

    deleteVariableByName(namespaceOptions, key) {
        const existing = this.getVariable(namespaceOptions, key);
        if (!existing) return false;
        this.statements.deleteMemoryEntry.run(existing.id);
        return true;
    }

    normalizeParticipantProfileListOptions(limitOrOptions = 50) {
        const options = typeof limitOrOptions === 'object' && limitOrOptions !== null
            ? limitOrOptions
            : { limit: limitOrOptions };
        const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 500);
        const search = String(options.search || '').trim();
        const searchPattern = search ? `%${search}%` : null;
        return { limit, search, searchPattern };
    }

    // >>> participant-roster patch >>>
    /**
     * 跨会话的"认识谁"名单：每个会话一行（最近一条用户消息 + 消息数 + 最后活跃）。
     * 调用方 participant-roster.js 负责解析昵称/QQ、按人合并、按时间截断。
     * 只用于喂身份，**不返回任何可用于回放对话的东西**。
     */
    listRecentContacts(limit = 60) {
        const n = Number.isFinite(Number(limit)) && Number(limit) > 0
            ? Math.floor(Number(limit))
            : 60;
        try {
            return this.statements.listRecentContacts.all(n);
        } catch {
            return [];
        }
    }

    /**
     * 记一个联系人。QQ 是主键；昵称并进 name_history（最近在前，去重，截断）。
     * 增量写消息时 countDelta=1，回填时是那条 (会话,发言人) 的条数。
     */
    recordContact(participantId, name, timestamp, scopeKind, scopeKey, countDelta = 1) {
        const id = String(participantId || '').trim();
        if (!id) return;
        const ts = Number(timestamp) || Date.now();
        const existing = this.statements.getContact.get(id);
        const history = mergeNameHistory(
            existing?.name_history,
            name,
            this.participantContactNameLimit || PARTICIPANT_ROSTER_DEFAULTS.maxNameHistory
        );
        // 名字/位置只跟着**更近的**那次走（与渲染层同一条规则）
        const isNewer = !existing || ts >= Number(existing.last_seen_at || 0);
        const safeName = isPlausibleName(name) ? String(name).trim() : '';
        const displayName = isNewer
            ? (safeName || existing?.display_name || '')
            : (existing?.display_name || safeName);
        this.statements.upsertContact.run(
            id,
            displayName,
            JSON.stringify(history),
            existing?.first_seen_at ? Math.min(Number(existing.first_seen_at), ts) : ts,
            existing?.last_seen_at ? Math.max(Number(existing.last_seen_at), ts) : ts,
            Number(existing?.message_count || 0) + (Number(countDelta) || 0),
            (isNewer ? scopeKind : existing?.last_scope_kind) || null,
            (isNewer ? scopeKey : existing?.last_scope_key) || null
        );
    }

    /**
     * 把一条用户消息里的发言人记进 participant_contacts。
     * ⚠ 数据源是 `metadata.participants`（形如 `昵称(QQ)`），**不是** `metadata.userId`
     *   —— 后者是"触发那次的主发言人"，批量合并时和正文头对不上。
     */
    recordContactsFromMessage(sessionId, metadata = {}, timestamp = Date.now()) {
        const participants = Array.isArray(metadata?.participants) ? metadata.participants : [];
        if (participants.length === 0) return;
        const scope = parseSessionKey(sessionId) || { kind: null, id: null };
        for (const token of participants) {
            const parsed = parseContactToken(token);
            if (!parsed) continue;
            this.recordContact(parsed.participantId, parsed.name, timestamp, scope.kind, sessionId, 1);
        }
    }

    // >>> roster-commands patch >>>
    /**
     * 按昵称/曾用名找 QQ（`/忘记 <昵称>` 用）。
     * 先精确匹配 display_name，再匹配 name_history 里的曾用名。
     */
    findContactsByName(name) {
        const n = String(name || '').trim();
        if (!n) return [];
        try {
            return this.db.prepare(`
                SELECT participant_id, display_name, name_history
                FROM participant_contacts
                WHERE display_name = ?
                    OR name_history LIKE ?
                ORDER BY last_seen_at DESC
                LIMIT 5
            `).all(n, `%${n}%`).map((row) => ({
                participantId: row.participant_id,
                displayName: row.display_name || ''
            }));
        } catch {
            return [];
        }
    }

    /**
     * 把一个人从「她认识谁」里删掉（管理员指令 /忘记 用）。
     *
     * 删两处：
     *  - `participant_contacts` 那一行（通讯录 ⇒ 名册里不再出现）
     *  - `memory_entries` 里**他署名的**逐字副本（召回时不再命中）
     *
     * ⚠ **不动 `messages`**：群历史是**批量合并**存的（一条里混着好几个人的话，
     *   实测同一条里有别人的发言），按作者删会连累别人。
     * ⚠ **不动 `summaries`**：摘要里可能混着多人的事，而且它会随时间自然滚掉。
     * 所以这个指令是"让她不再认得这个人"，不是"抹掉他说过的每句话"。
     */
    forgetContact(participantId) {
        const id = String(participantId || '').trim();
        if (!id) return { participantId: '', contactDeleted: 0, memoryEntriesDeleted: 0 };
        let contactDeleted = 0;
        let memoryEntriesDeleted = 0;
        try {
            contactDeleted = Number(this.db.prepare(
                'DELETE FROM participant_contacts WHERE participant_id = ?').run(id).changes) || 0;
            memoryEntriesDeleted = Number(this.db.prepare(
                'DELETE FROM memory_entries WHERE content LIKE ?').run(`%|QQ:${id}|%`).changes) || 0;
        } catch (error) {
            this.logger?.warn?.('[名册] 删除联系人失败', { participantId: id, error: error?.message });
        }
        return { participantId: id, contactDeleted, memoryEntriesDeleted };
    }
    // <<< roster-commands patch <<<

    /**
     * 表为空时从历史消息回填一次（升级后名册不能凭空空掉）。
     * `force` 只在测试/修数据时用。
     */
    backfillParticipantContacts(force = false) {
        try {
            if (!force) {
                const n = Number(this.statements.countContacts.get()?.n || 0);
                if (n > 0) return 0;
            }
            // 按时间**正序**喂：recordContact 把新名字插到前面 ⇒ 历史自然"最近在前"
            const rows = this.statements.backfillContactSources.all();
            for (const row of rows) {
                const parsed = parseContactToken(row.who);
                if (!parsed) continue;
                const scope = parseSessionKey(row.session_id) || { kind: null, id: null };
                this.recordContact(
                    parsed.participantId, parsed.name, Number(row.timestamp),
                    scope.kind, row.session_id, Number(row.count) || 1
                );
            }
            const total = Number(this.statements.countContacts.get()?.n || 0);
            if (rows.length > 0) {
                this.logger?.info?.(`[身份名册] 已从历史消息回填联系人：${total} 人`);
            }
            return rows.length;
        } catch (error) {
            this.logger?.warn?.('[身份名册] 回填失败', { error: error?.message });
            return 0;
        }
    }
    // <<< participant-roster patch <<<
    // <<< participant-roster patch <<<

    listParticipantProfiles(limitOrOptions = 50) {
        const { limit, searchPattern } = this.normalizeParticipantProfileListOptions(limitOrOptions);
        if (!searchPattern) {
            return this.statements.listParticipantProfiles.all(limit).map(mapParticipantProfileRow);
        }

        return this.statements.listParticipantProfilesFiltered.all(
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            limit
        ).map(mapParticipantProfileRow);
    }

    countParticipantProfiles(filters = {}) {
        const { searchPattern } = this.normalizeParticipantProfileListOptions(filters);
        if (!searchPattern) {
            const row = this.statements.countParticipantProfiles.get();
            return Number(row?.count) || 0;
        }

        const row = this.statements.countParticipantProfilesFiltered.get(
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern
        );
        return Number(row?.count) || 0;
    }

    getParticipantProfileByEntryId(entryId) {
        const row = this.statements.getParticipantProfileByEntryId.get(entryId);
        return row ? mapParticipantProfileRow(row) : null;
    }

    upsertParticipantProfile(namespaceOptions, participantProfile) {
        const namespace = this.ensureMemoryNamespace(normalizeParticipantProfileNamespaceOptions(namespaceOptions));
        const participantId = normalizeParticipantId(participantProfile.participantId ?? participantProfile.metadata?.participantId);
        if (!participantId) {
            throw new Error('人物档案 QQ 不能为空');
        }

        const title = normalizeParticipantName(participantProfile.title || participantProfile.metadata?.participantName, participantId);
        const participantName = normalizeParticipantName(participantProfile.metadata?.participantName, title || participantId);
        const metadata = {
            ...(participantProfile.metadata || {}),
            participantId,
            participantName
        };
        const stableId = buildParticipantProfileEntryId(namespace.id, participantId);
        const identityRows = this.listParticipantProfileIdentityRows(namespaceOptions, participantId);
        const stableRow = identityRows.find((row) => row.id === stableId);
        const existingRow = stableRow || identityRows[0] || null;
        const now = Date.now();
        const sourceSessionId = participantProfile.sourceSessionId || existingRow?.source_session_id || null;
        const sourceMessageId = participantProfile.sourceMessageId || existingRow?.source_message_id || null;

        if (existingRow) {
            const targetId = stableRow ? stableId : (this.getParticipantProfileByEntryId(stableId) ? existingRow.id : stableId);
            this.db.prepare(`
                UPDATE memory_entries
                SET id = ?, namespace_id = ?, title = ?, content = ?, tags_json = ?, metadata_json = ?, source_session_id = ?, source_message_id = ?, updated_at = ?
                WHERE id = ?
            `).run(
                targetId,
                namespace.id,
                title,
                participantProfile.content,
                JSON.stringify(participantProfile.tags || []),
                JSON.stringify(metadata),
                sourceSessionId,
                sourceMessageId,
                now,
                existingRow.id
            );

            let mergedDuplicates = 0;
            for (const row of identityRows) {
                if (row.id === existingRow.id || row.id === targetId) {
                    continue;
                }
                this.statements.deleteMemoryEntry.run(row.id);
                mergedDuplicates += 1;
            }

            return { id: targetId, namespaceId: namespace.id, updated: true, mergedDuplicates };
        }

        return this.addMemoryEntry(normalizeParticipantProfileNamespaceOptions(namespaceOptions), {
            id: stableId,
            entryType: 'participant_profile',
            title,
            content: participantProfile.content,
            tags: participantProfile.tags || [],
            metadata,
            sourceSessionId,
            sourceMessageId
        });
    }

    saveParticipantProfile(entryId, participantProfile = {}) {
        const existing = this.getParticipantProfileByEntryId(entryId);
        if (!existing) {
            return null;
        }

        const title = String(participantProfile.title ?? existing.title ?? '').trim();
        const content = String(participantProfile.content ?? existing.content ?? '').trim();
        if (!title) {
            throw new Error('人物档案标题不能为空');
        }
        if (!content) {
            throw new Error('人物档案内容不能为空');
        }

        const metadata = {
            ...existing.metadata,
            ...(participantProfile.metadata || {}),
            participantId: String((participantProfile.metadata || {}).participantId || existing.metadata?.participantId || existing.participantId || ''),
            participantName: String((participantProfile.metadata || {}).participantName || existing.metadata?.participantName || title).trim() || title,
            editedBy: String((participantProfile.metadata || {}).editedBy || existing.metadata?.editedBy || 'admin-panel').trim() || 'admin-panel',
            updatedBy: String((participantProfile.metadata || {}).updatedBy || existing.metadata?.updatedBy || 'admin-panel').trim() || 'admin-panel',
            source: String((participantProfile.metadata || {}).source || existing.metadata?.source || 'participant_profile').trim() || 'participant_profile'
        };
        const tags = Array.isArray(participantProfile.tags) ? participantProfile.tags : existing.tags;
        const now = Date.now();

        this.statements.updateMemoryEntry.run(
            title,
            content,
            JSON.stringify(tags || []),
            JSON.stringify(metadata),
            existing.sourceSessionId || null,
            existing.sourceMessageId || null,
            now,
            existing.id
        );

        const saved = this.getParticipantProfileByEntryId(existing.id);
        this.logger.info?.('[记忆] 人物档案已保存', {
            entryId: existing.id,
            participantId: saved?.participantId || metadata.participantId || '',
            participantName: saved?.participantName || metadata.participantName || title,
            content: summarizeText(content, 160),
            tagCount: Array.isArray(tags) ? tags.length : 0
        });
        return saved;
    }

    deleteParticipantProfile(entryId) {
        const existing = this.getParticipantProfileByEntryId(entryId);
        if (!existing) {
            return false;
        }
        this.statements.deleteMemoryEntry.run(entryId);
        return true;
    }

    listSessionMessagesSince(sessionId, options = {}) {
        const since = options.since || 0;
        const limit = Math.min(Math.max(Number(options.limit) || 200, 1), 1000);
        const rows = this.statements.listSessionMessagesSince.all(String(sessionId), since, limit);
        return rows.map((row) => ({
            sessionId: row.session_id,
            role: row.role,
            content: row.content,
            metadata: parseJson(row.metadata_json, {}),
            timestamp: row.timestamp,
            date: row.date_iso
        }));
    }

    collectParticipantProfileSource(userId, namespaceOptions, options = {}) {
        const existing = this.getParticipantProfile(namespaceOptions, userId);
        const since = existing?.metadata?.lastProcessedMessageAt || 0;
        const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 500);
        const threshold = Math.max(Number(options.threshold) || 8, 1);
        const sourceFilter = options.sourceFilter || 'all';
        const contextBefore = Math.max(0, Math.floor(Number(options.contextBefore ?? 2)));
        const contextAfter = Math.max(0, Math.floor(Number(options.contextAfter ?? 2)));
        const targetId = normalizeParticipantId(userId);

        // 目标人物本人发言作为锚点；assistant 即使误写了 userId 也不能当锚点
        const anchorCandidates = this.listParticipantMessages(targetId, {
            since,
            limit: Math.max(limit * 3, 50)
        }).filter((message) => (
            isUserRole(message.role)
            && normalizeParticipantId(message.metadata?.userId) === targetId
        ));

        const sessionIds = Array.from(new Set(anchorCandidates.map((item) => item.sessionId).filter(Boolean)));
        const selected = [];
        const seen = new Set();

        for (const sessionId of sessionIds) {
            const sessionMessages = this.listSessionMessagesSince(sessionId, {
                since,
                limit: Math.max(limit * 6, 200)
            });
            if (sessionMessages.length === 0) {
                continue;
            }

            const anchorIndexes = [];
            for (let index = 0; index < sessionMessages.length; index += 1) {
                const message = sessionMessages[index];
                if (
                    isUserRole(message.role)
                    && normalizeParticipantId(message.metadata?.userId) === targetId
                ) {
                    anchorIndexes.push(index);
                }
            }
            if (anchorIndexes.length === 0) {
                continue;
            }

            const sessionHasBot = sessionMessages.some((message) => isAssistantRole(message.role));
            if (sourceFilter === 'bot_only' && !sessionHasBot) {
                continue;
            }

            const includeMask = new Array(sessionMessages.length).fill(false);
            for (const anchorIndex of anchorIndexes) {
                const start = Math.max(0, anchorIndex - contextBefore);
                const end = Math.min(sessionMessages.length - 1, anchorIndex + contextAfter);
                for (let index = start; index <= end; index += 1) {
                    includeMask[index] = true;
                }
            }

            for (let index = 0; index < sessionMessages.length; index += 1) {
                if (!includeMask[index]) {
                    continue;
                }
                const attributedList = expandParticipantProfileSourceMessages(sessionMessages[index], targetId);
                for (const attributed of attributedList) {
                    const key = buildParticipantProfileMessageKey(attributed);
                    if (seen.has(key)) {
                        continue;
                    }
                    seen.add(key);
                    selected.push(attributed);
                }
            }
        }

        selected.sort((left, right) => {
            const timeDiff = Number(left.timestamp || 0) - Number(right.timestamp || 0);
            if (timeDiff !== 0) {
                return timeDiff;
            }
            return String(left.sessionId || '').localeCompare(String(right.sessionId || ''));
        });

        const messages = selected.length > limit ? selected.slice(-limit) : selected;
        const targetMessageCount = messages.filter((item) => item.speakerType === 'target' && String(item.content || '').trim()).length;
        const botMessageCount = messages.filter((item) => item.speakerType === 'bot').length;
        const thirdPartyMessageCount = messages.filter((item) => item.speakerType === 'third_party').length;

        return {
            existing,
            since,
            messages,
            hasEnoughNewInfo: targetMessageCount >= threshold,
            targetMessageCount,
            botMessageCount,
            thirdPartyMessageCount,
            contextMessageCount: messages.length - targetMessageCount
        };
    }

    addSummaryIndexEntry(namespaceOptions, entry = {}) {
        const namespace = this.ensureMemoryNamespace(namespaceOptions);
        const now = Date.now();
        const id = entry.id || `sidx_${now}_${Math.random().toString(36).slice(2, 8)}`;
        this.statements.insertSummaryIndexEntry.run(
            id,
            namespace.id,
            entry.sourceSummaryId || null,
            entry.sourceSessionId || null,
            entry.outline || '',
            JSON.stringify(entry.keywords || []),
            JSON.stringify(entry.metadata || {}),
            now,
            now
        );
        return { id, namespaceId: namespace.id };
    }

    listRecentSummaryIndexEntries(namespaceOptions, limit = 10) {
        const namespace = this.ensureMemoryNamespace(namespaceOptions);
        return this.statements.recentSummaryIndexEntries.all(namespace.id, limit).map((row) => ({
            id: row.id,
            sourceSummaryId: row.source_summary_id,
            sourceSessionId: row.source_session_id,
            outline: row.outline,
            keywords: parseJson(row.keywords_json, []),
            metadata: parseJson(row.metadata_json, {}),
            createdAt: row.created_at,
            updatedAt: row.updated_at
        }));
    }

    buildKeywordsFromText(text = '', limit = 12) {
        const source = String(text || '').toLowerCase();
        const words = source
            .replace(/[^a-z0-9一-龥]+/g, ' ')
            .split(/\s+/)
            .map((word) => word.trim())
            .filter((word) => word.length >= 2);
        return Array.from(new Set(words)).slice(0, limit);
    }

    upsertConversationMemory(namespaceOptions, { userMessage, assistantMessage = '', sourceSessionId = null, sourceMessageId = null }) {
        const entryTitle = userMessage.slice(0, 30);
        this.addMemoryEntry(namespaceOptions, {
            entryType: 'conversation',
            title: entryTitle,
            content: assistantMessage ? `用户: ${userMessage}\n助手: ${assistantMessage}` : `用户: ${userMessage}`,
            tags: this.buildKeywordsFromText(`${userMessage} ${assistantMessage}`),
            metadata: { source: 'conversation' },
            sourceSessionId,
            sourceMessageId
        });
    }

    upsertSummaryIndexFromSummary(namespaceOptions, summary, sourceSessionId) {
        if (!summary?.content) {
            return null;
        }

        return this.addSummaryIndexEntry(namespaceOptions, {
            sourceSummaryId: summary.id,
            sourceSessionId,
            outline: summary.content,
            keywords: this.buildKeywordsFromText(summary.content),
            metadata: { source: 'summary' }
        });
    }

// >>> keyword-recall patch (managed by patch_keyword_recall.py) >>>
    /** 剥掉结构化消息头 / JSON 段，只留用户真正打的字。
     *  头里嵌了 `messageSegments:[{...}]`，所以要**反复**剥最内层，不能一次正则搞定。 */
    stripStructuredHeaders(text = '') {
        let s = String(text || '');
        let prev = null;
        let rounds = 0;
        while (prev !== s && rounds < 20) {
            prev = s;
            s = s.replace(/\[[^\[\]]*\]/g, ' ').replace(/\{[^{}]*\}/g, ' ');
            rounds += 1;
        }
        return s.replace(/\s+/g, ' ').trim();
    }

    /** 召回关键词：剥头 -> 中文串(>8字补 2-gram) + 英文词(>=3字) -> 去数字/停用词。 */
    buildRecallKeywords(text = '', limit = 16) {
        const STOP = new Set([
            '私聊', '群聊', '昵称', '群号', '群名', '时间', '什么', '怎么', '为什么',
            '这个', '那个', '可以', '但是', '因为', '所以', '然后', '还是', '就是',
            '没有', '不是', '一个', '现在', '时候', '感觉', '觉得', '知道', '我们',
            '你们', '他们', '自己', '已经', '应该', '可能', '真的', '有点', '而且'
        ]);
        const cleaned = this.stripStructuredHeaders(text).toLowerCase();
        const out = [];
        const push = (word) => {
            const w = String(word || '').trim();
            if (!w || out.length >= limit || out.includes(w) || STOP.has(w)) return;
            out.push(w);
        };
        for (const run of (cleaned.match(/[\u4e00-\u9fa5]{2,}/g) || [])) {
            if (run.length <= 8) push(run);
            if (run.length > 4) {
                for (let i = 0; i + 2 <= run.length; i += 1) push(run.slice(i, i + 2));
            }
        }
        for (const word of (cleaned.match(/[a-z][a-z0-9]{2,}/g) || [])) push(word);
        return out;
    }

    /** 逐关键词检索后按命中数合并（OR 语义），替代「整段原文当 LIKE 模式」。 */
    searchMemoryEntriesByKeywords(namespaceOptions, keywords, limit = 4) {
        const list = Array.isArray(keywords) ? keywords : [];
        if (list.length === 0) return [];
        const merged = new Map();
        for (const keyword of list) {
            let rows = [];
            try {
                rows = this.searchMemoryEntries(namespaceOptions, keyword, Math.max(limit * 3, 8));
            } catch (error) {
                this.logger?.warn?.('[记忆] 关键词召回失败', { keyword, error: error.message });
                continue;
            }
            for (const entry of rows) {
                const hit = merged.get(entry.id);
                if (hit) hit.hits += 1;
                else merged.set(entry.id, { entry, hits: 1 });
            }
        }
        return Array.from(merged.values())
            .sort((a, b) => (b.hits - a.hits) || ((b.entry.createdAt || 0) - (a.entry.createdAt || 0)))
            .slice(0, limit)
            .map((item) => item.entry);
    }
// <<< keyword-recall patch <<<

    recallMemory(namespaceOptions, query, options = {}) {
        const recentLimit = options.recentLimit || 4;
        const searchLimit = options.searchLimit || 4;
        const recentEntries = this.listRecentMemoryEntries(namespaceOptions, recentLimit);
        // >>> keyword-recall patch (managed by patch_keyword_recall.py) >>>
        // 原来是把整段带结构化头的原文当 LIKE 模式 ⇒ 永远 0 命中（实测）。
        // 改成先剥头抽词，再逐关键词 OR 检索。
        const recallKeywords = this.buildRecallKeywords(query, 16);
        const matchedEntries = query
            ? (recallKeywords.length > 0
                ? this.searchMemoryEntriesByKeywords(namespaceOptions, recallKeywords, searchLimit)
                : this.searchMemoryEntries(namespaceOptions, query, searchLimit))
            : [];
        // <<< keyword-recall patch <<<
        const summaryEntries = this.listRecentSummaryIndexEntries(namespaceOptions, options.summaryLimit || 3);
        const fixedKnowledgeEntries = this.listKnowledgeEntries({
            scopeType: namespaceOptions?.scopeType,
            scopeKey: namespaceOptions?.scopeKey,
            characterName: namespaceOptions?.characterName,
            presetName: namespaceOptions?.presetName,
            knowledgeType: 'fixed',
            limit: options.fixedLimit || 6
        });
        // keyword-recall patch: 打分也用剥头后的关键词，否则全是「私聊/qq/昵称/时间」
        const queryKeywords = recallKeywords.length > 0
            ? recallKeywords
            : this.buildKeywordsFromText(query, 8);
        const participantProfileConfig = getParticipantProfileConfig(this.config);
        const blacklist = new Set(participantProfileConfig.blacklistParticipantIds);
        const currentParticipantId = options.currentParticipantId ? String(options.currentParticipantId) : '';

        // >>> cross-scope recall patch >>>
        // 私聊和群聊**都**外扩（2026-10-11 用户：「记忆都打通要做跨群的」）。
        // 安全边界不靠"限定场景"，而是靠 SQL 里的**作者过滤** —— 只捞当前发言人自己写的。
        const crossScopeConfig = this.config?.memory?.crossScope || {};
        const crossScopeEnabled = crossScopeConfig.enabled !== false;
        const crossScopeEntries = (crossScopeEnabled && currentParticipantId && recallKeywords.length > 0)
            ? this.searchCrossScopeEntries(currentParticipantId, recallKeywords, {
                excludeScopeKey: String(namespaceOptions?.scopeKey || ''),
                limit: options.crossScopeLimit || 3
            })
            : [];
        // <<< cross-scope recall patch <<<

        const shouldIncludeEntry = (entry) => {
            if (entry.entryType === 'knowledge_fixed' || entry.entryType === 'knowledge_dynamic') {
                return true;
            }
            if (entry.entryType !== 'participant_profile') {
                return true;
            }
            if (!participantProfileConfig.injectEnabled) {
                return false;
            }

            const profileParticipantId = String(entry.metadata?.participantId || '');
            if (profileParticipantId && blacklist.has(profileParticipantId)) {
                return false;
            }
            if (currentParticipantId && profileParticipantId && currentParticipantId !== profileParticipantId) {
                return false;
            }
            return true;
        };

        const dedupe = new Map();
        for (const entry of [...fixedKnowledgeEntries, ...crossScopeEntries, ...matchedEntries, ...recentEntries]) {
            if (!shouldIncludeEntry(entry) || dedupe.has(entry.id)) {
                continue;
            }

            const contentText = String(entry.content || '').toLowerCase();
            const keywordHits = queryKeywords.filter((keyword) => contentText.includes(keyword)).length;
            const isMatched = matchedEntries.some((item) => item.id === entry.id);
            // >>> cross-scope recall patch >>>
            const isCrossScope = crossScopeEntries.some((item) => item.id === entry.id);
            // <<< cross-scope recall patch <<<
            const isFixedKnowledge = entry.entryType === 'knowledge_fixed';
            const isDynamicKnowledge = entry.entryType === 'knowledge_dynamic';
            const recencyBoost = isMatched ? 50 : (isCrossScope ? 35 : 20);
            const profileBoost = entry.entryType === 'participant_profile' ? 80 : 0;
            const knowledgeBoost = isFixedKnowledge ? 120 : (isDynamicKnowledge ? 70 : 0);
            dedupe.set(entry.id, {
                ...entry,
                sourceKind: isFixedKnowledge
                    ? 'knowledge_fixed'
                    : (isDynamicKnowledge
                        ? 'knowledge_dynamic'
                        : (entry.entryType === 'participant_profile' ? 'participant_profile' : 'memory_entry')),
                recallReason: isFixedKnowledge
                    ? 'fixed_knowledge'
                    : (isDynamicKnowledge
                        ? (isMatched ? 'dynamic_knowledge_match' : 'dynamic_knowledge_recent')
                        : (entry.entryType === 'participant_profile'
                            ? 'participant_profile'
                            : (isCrossScope
                                ? 'cross_scope_group'
                                : (isMatched ? 'keyword_match' : 'recent_memory')))),
                recallScore: knowledgeBoost + profileBoost + recencyBoost + keywordHits * 8
            });
        }

        for (const summary of summaryEntries) {
            if (!dedupe.has(summary.id)) {
                const keywordHits = queryKeywords.filter((keyword) => summary.outline.toLowerCase().includes(keyword)).length;
                dedupe.set(summary.id, {
                    id: summary.id,
                    title: '摘要索引',
                    content: summary.outline,
                    keywords: summary.keywords,
                    metadata: summary.metadata,
                    sourceKind: 'summary_index',
                    recallReason: 'summary_index',
                    recallScore: 30 + keywordHits * 6
                });
            }
        }

        const results = Array.from(dedupe.values())
            .sort((a, b) => (b.recallScore || 0) - (a.recallScore || 0))
            .slice(0, options.limit || 6);

        this.logger.info?.('[记忆] 记忆召回完成', {
            namespace: summarizeNamespaceOptions(namespaceOptions),
            query: summarizeText(query),
            recentCount: recentEntries.length,
            matchedCount: matchedEntries.length,
            crossScopeCount: crossScopeEntries.length,
            crossScopeLevel: (this.config?.memory?.crossScope?.includeOthersPrivate === true
                ? 'all'
                : (this.config?.memory?.crossScope?.includeOthersInGroups !== false ? 'groups' : 'self')),
            fixedKnowledgeCount: fixedKnowledgeEntries.length,
            summaryCount: summaryEntries.length,
            resultCount: results.length,
            currentParticipantId,
            results: results.slice(0, 6).map((entry) => ({
                id: entry.id,
                sourceKind: entry.sourceKind || entry.entryType || '',
                recallReason: entry.recallReason || '',
                recallScore: entry.recallScore || 0,
                title: entry.title || ''
            }))
        });

        return results;
    }

    cleanupSessions(maxIdleTime = 24 * 60 * 60 * 1000) {
        const now = Date.now();
        for (const session of this.listSessions()) {
            if (now - session.lastActive > maxIdleTime) {
                this.deleteSession(session.id);
            }
        }
    }

    getStats() {
        const row = this.statements.stats.get();
        return {
            totalMessages: row?.total_messages || 0,
            totalSessions: row?.total_sessions || 0,
            totalSummaries: row?.total_summaries || 0,
            sessionMode: this.sessionMode,
            storage: {
                type: 'sqlite',
                path: this.dbPath
            },
            oldestMessage: row?.oldest_message || null,
            newestMessage: row?.newest_message || null,
            memoryFileSizeMB: this.getMemoryFileSize()
        };
    }

    getDashboardCompositionStats() {
        const row = this.db.prepare(`
            SELECT
                SUM(CASE WHEN entry_type = 'participant_profile' THEN 1 ELSE 0 END) AS participant_profiles,
                SUM(CASE WHEN entry_type = 'knowledge_fixed' THEN 1 ELSE 0 END) AS fixed_knowledge,
                SUM(CASE WHEN entry_type = 'knowledge_dynamic' THEN 1 ELSE 0 END) AS dynamic_knowledge
            FROM memory_entries
        `).get();
        const stats = this.getStats();
        return {
            messages: Number(stats.totalMessages) || 0,
            summaries: Number(stats.totalSummaries) || 0,
            participantProfiles: Number(row?.participant_profiles) || 0,
            fixedKnowledge: Number(row?.fixed_knowledge) || 0,
            dynamicKnowledge: Number(row?.dynamic_knowledge) || 0
        };
    }

    getMemoryFileSize() {
        try {
            if (fs.existsSync(this.dbPath)) {
                const stats = fs.statSync(this.dbPath);
                return (stats.size / 1024 / 1024).toFixed(2);
            }
        } catch (error) {
            this.logger.error?.(`[记忆] 获取数据库文件大小失败: ${error.message}`);
        }
        return 0;
    }

    clearGlobalMemory() {
        this.db.exec('BEGIN');
        try {
            this.db.exec('DELETE FROM summary_index_entries;');
            this.db.exec('DELETE FROM memory_entries;');
            this.db.exec('DELETE FROM memory_namespaces;');
            this.db.exec('DELETE FROM sticky_entries;');
            this.db.exec('DELETE FROM summaries;');
            this.db.exec('DELETE FROM messages;');
            this.db.exec('DELETE FROM sessions;');
            this.db.exec('COMMIT');
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    searchMessages(keyword, limit = 50) {
        if (!keyword) {
            return [];
        }

        const rows = this.statements.searchMessages.all(`%${keyword}%`, limit);
        return rows.map((row) => ({
            sessionId: row.session_id,
            role: row.role,
            content: row.content,
            timestamp: row.timestamp,
            date: row.date_iso
        }));
    }

    exportKnowledgeSnapshot() {
        return {
            namespaces: this.statements.exportMemoryNamespaces.all().map((row) => ({
                id: row.id,
                scopeType: row.scope_type,
                scopeKey: row.scope_key,
                characterName: row.character_name || null,
                presetName: row.preset_name || null,
                createdAt: row.created_at,
                updatedAt: row.updated_at
            })),
            entries: this.statements.exportMemoryEntries.all().map((row) => ({
                id: row.id,
                namespaceId: row.namespace_id,
                sourceSessionId: row.source_session_id,
                sourceMessageId: row.source_message_id,
                entryType: row.entry_type,
                title: row.title,
                content: row.content,
                tags: parseJson(row.tags_json, []),
                metadata: parseJson(row.metadata_json, {}),
                createdAt: row.created_at,
                updatedAt: row.updated_at
            })),
            summaryIndexEntries: this.statements.exportSummaryIndexEntries.all().map((row) => ({
                id: row.id,
                namespaceId: row.namespace_id,
                sourceSummaryId: row.source_summary_id,
                sourceSessionId: row.source_session_id,
                outline: row.outline,
                keywords: parseJson(row.keywords_json, []),
                metadata: parseJson(row.metadata_json, {}),
                createdAt: row.created_at,
                updatedAt: row.updated_at
            }))
        };
    }

    importKnowledgeSnapshot(snapshot = {}) {
        const namespaces = Array.isArray(snapshot.namespaces) ? snapshot.namespaces : [];
        const entries = Array.isArray(snapshot.entries) ? snapshot.entries : [];
        const summaryIndexEntries = Array.isArray(snapshot.summaryIndexEntries) ? snapshot.summaryIndexEntries : [];
        const now = Date.now();

        for (const namespace of namespaces) {
            this.statements.upsertMemoryNamespace.run(
                namespace.id || `ns_${namespace.scopeType}_${Buffer.from(`${namespace.scopeKey}|${namespace.characterName || ''}|${namespace.presetName || ''}`).toString('base64url')}`,
                namespace.scopeType || 'user_persistent',
                namespace.scopeKey || 'default',
                namespace.characterName || null,
                namespace.presetName || null,
                namespace.createdAt || now,
                namespace.updatedAt || now
            );
        }

        for (const entry of entries) {
            this.statements.insertMemoryEntry.run(
                entry.id || `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                entry.namespaceId,
                entry.sourceSessionId || null,
                entry.sourceMessageId || null,
                entry.entryType || 'note',
                entry.title || null,
                entry.content || '',
                JSON.stringify(entry.tags || []),
                JSON.stringify(entry.metadata || {}),
                entry.createdAt || now,
                entry.updatedAt || now
            );
        }

        for (const entry of summaryIndexEntries) {
            this.statements.insertSummaryIndexEntry.run(
                entry.id || `sumidx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                entry.namespaceId,
                entry.sourceSummaryId || null,
                entry.sourceSessionId || null,
                entry.outline || '',
                JSON.stringify(entry.keywords || []),
                JSON.stringify(entry.metadata || {}),
                entry.createdAt || now,
                entry.updatedAt || now
            );
        }

        return {
            importedNamespaces: namespaces.length,
            importedMemoryEntries: entries.length,
            importedSummaryIndexEntries: summaryIndexEntries.length
        };
    }

    exportMemory() {
        const sessions = {};
        for (const session of this.listSessions()) {
            sessions[session.id] = {
                ...session,
                messages: this.getHistory(session.id, 100000),
                summaries: this.getSummaries(session.id),
                stickyEntries: this.getStickyEntriesObject(session.id)
            };
        }

        return {
            sessions,
            knowledge: this.exportKnowledgeSnapshot(),
            globalTimeline: this.getGlobalHistory(100000, true),
            stats: this.getStats(),
            exportDate: new Date().toISOString(),
            storage: {
                type: 'sqlite',
                path: this.dbPath
            }
        };
    }

    exportMemoryByFilter(filter = {}) {
        let sessionsToExport = this.listSessions();

        if (filter.sessionIds?.length) {
            const allowed = new Set(filter.sessionIds);
            sessionsToExport = sessionsToExport.filter((session) => allowed.has(session.id));
        }

        if (filter.sessionPrefix) {
            sessionsToExport = sessionsToExport.filter((session) => session.id.startsWith(filter.sessionPrefix));
        }

        if (filter.userId) {
            const userToken = `:${filter.userId}`;
            sessionsToExport = sessionsToExport.filter((session) => session.id === `user:${filter.userId}` || session.id.endsWith(userToken));
        }

        const sessions = {};
        for (const session of sessionsToExport) {
            sessions[session.id] = {
                ...session,
                messages: this.getHistory(session.id, 100000),
                summaries: this.getSummaries(session.id),
                stickyEntries: this.getStickyEntriesObject(session.id)
            };
        }

        const knowledge = this.exportKnowledgeSnapshot();

        return {
            sessions,
            knowledge,
            stats: {
                exportedSessions: Object.keys(sessions).length,
                exportedKnowledgeEntries: Array.isArray(knowledge.entries) ? knowledge.entries.length : 0,
                storagePath: this.dbPath
            },
            exportDate: new Date().toISOString(),
            storage: {
                type: 'sqlite',
                path: this.dbPath
            }
        };
    }

    importMemorySnapshot(snapshot, options = {}) {
        if (!snapshot?.sessions && !snapshot?.knowledge) {
            return {
                importedSessions: 0,
                importedMessages: 0,
                importedSummaries: 0,
                importedNamespaces: 0,
                importedMemoryEntries: 0,
                importedSummaryIndexEntries: 0
            };
        }

        const replace = options.replace !== false;
        if (replace) {
            this.clearGlobalMemory();
        }

        let importedSessions = 0;
        let importedMessages = 0;
        let importedSummaries = 0;

        for (const [sessionId, session] of Object.entries(snapshot.sessions || {})) {
            this.ensureSession(sessionId);
            importedSessions += 1;

            for (const message of session.messages || []) {
                this.addMessage(sessionId, message.role, message.content, message.metadata || {});
                importedMessages += 1;
            }

            for (const summary of session.summaries || []) {
                const summaryId = summary.id || `summary_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                this.statements.insertSummary.run(
                    summaryId,
                    sessionId,
                    summary.content,
                    summary.sourceCount || 0,
                    summary.createdAt || Date.now(),
                    summary.date || new Date().toISOString()
                );
                importedSummaries += 1;
            }
        }

        const importedKnowledge = this.importKnowledgeSnapshot(snapshot.knowledge || {});

        return {
            importedSessions,
            importedMessages,
            importedSummaries,
            ...importedKnowledge
        };
    }

    getDbPath() {
        return this.dbPath;
    }

    // 强制 WAL checkpoint，确保所有数据写入主库文件（备份前必须调用）
    checkpoint() {
        try {
            if (this.db && this.db.open) {
                if (typeof this.db.pragma === 'function') {
                    this.db.pragma('wal_checkpoint(TRUNCATE)');
                } else {
                    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
                }
            }
        } catch {}
    }

    clearAllData() {
        const cleared = { sessions: 0, messages: 0, summaries: 0, variables: 0, namespaces: 0, profiles: 0, knowledge: 0 };
        const dbs = [this.db];
        if (this.charDb && this.charDb !== this.db) dbs.push(this.charDb);

        for (const db of dbs) {
            if (!db || !db.open) continue;
            try {
                cleared.variables += db.prepare('DELETE FROM memory_entries WHERE entry_type = ?').run('variable').changes;
                cleared.profiles += db.prepare('DELETE FROM memory_entries WHERE entry_type = ?').run('participant_profile').changes;
                cleared.knowledge += db.prepare('DELETE FROM memory_entries WHERE entry_type = ?').run('knowledge').changes;
                cleared.knowledge += db.prepare('DELETE FROM memory_entries WHERE entry_type NOT IN (?,?,?)').run('variable','participant_profile','knowledge').changes;
                cleared.messages += db.prepare('DELETE FROM messages').run().changes;
                cleared.summaries += db.prepare('DELETE FROM summaries').run().changes;
                cleared.sessions += db.prepare('DELETE FROM sessions').run().changes;
                cleared.namespaces += db.prepare('DELETE FROM memory_namespaces').run().changes;
                db.prepare('DELETE FROM sticky_entries').run();
                db.prepare('DELETE FROM summary_index_entries').run();
            } catch (e) { /* some tables may not exist in all dbs */ }
        }
        this.checkpoint();
        return cleared;
    }
}

export function getGlobalMemory(dataDir) {
    const dbPath = resolveDbPath(dataDir, null);
    if (!fs.existsSync(dbPath)) {
        return {
            sessions: {},
            globalTimeline: [],
            storage: {
                type: 'sqlite',
                path: dbPath
            }
        };
    }

    const db = new DatabaseSync(dbPath);
    const sessions = db.prepare('SELECT id FROM sessions ORDER BY last_active DESC').all();
    const globalTimeline = db.prepare(`
        SELECT session_id, role, content, timestamp, date_iso
        FROM messages
        ORDER BY timestamp ASC, rowid ASC
    `).all();

    const snapshot = {
        sessions: Object.fromEntries(sessions.map((row) => [row.id, { id: row.id }])),
        globalTimeline: globalTimeline.map((row) => ({
            sessionId: row.session_id,
            role: row.role,
            content: row.content,
            timestamp: row.timestamp,
            date: row.date_iso
        })),
        storage: {
            type: 'sqlite',
            path: dbPath
        }
    };

    db.close();
    return snapshot;
}

export function inspectMemoryDatabase(dbPath) {
    const normalizedPath = path.isAbsolute(dbPath) ? dbPath : path.resolve(process.cwd(), dbPath);
    if (!fs.existsSync(normalizedPath)) {
        return {
            path: normalizedPath,
            exists: false,
            totalSessions: 0,
            totalMessages: 0,
            totalSummaries: 0,
            newestMessage: null,
            oldestMessage: null
        };
    }

    const db = new DatabaseSync(normalizedPath);
    const row = db.prepare(`
        SELECT
            (SELECT COUNT(*) FROM sessions) AS total_sessions,
            (SELECT COUNT(*) FROM messages) AS total_messages,
            (SELECT COUNT(*) FROM summaries) AS total_summaries,
            (SELECT date_iso FROM messages ORDER BY timestamp DESC, rowid DESC LIMIT 1) AS newest_message,
            (SELECT date_iso FROM messages ORDER BY timestamp ASC, rowid ASC LIMIT 1) AS oldest_message
    `).get();
    db.close();

    return {
        path: normalizedPath,
        exists: true,
        totalSessions: row?.total_sessions || 0,
        totalMessages: row?.total_messages || 0,
        totalSummaries: row?.total_summaries || 0,
        newestMessage: row?.newest_message || null,
        oldestMessage: row?.oldest_message || null
    };
}
