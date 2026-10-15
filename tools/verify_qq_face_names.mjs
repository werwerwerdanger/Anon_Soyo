/**
 * verify_qq_face_names.mjs
 * ---------------------------------------------------------------------------
 * 验证「QQ 内置表情 id → 中文名」这条链路，以及它在两个渲染点的接入。
 *
 * 起因（2026-10-11）：用户连发两个爱心表情，爱音只回「来了来了」「怎么了~」。
 * 查日志发现她收到的字面是 `[QQ表情|id=66]` —— 收进来的 face 段 `name` 是空串，
 * 而代码只拼 segment 自带的 name，没有任何 id→名字 的反查。**模型不可能从一个
 * 数字知道 66 是爱心**，所以这不是"她不想理"，是"字面上真的不认识"。
 *
 * 这一层最值钱的断言是 **①「表 == 权威来源」**：它重新解析 NapCat 自带的
 * `static/assets/qface-Cp_sIXAp.js`（`QSid`/`QDes`），和仓库里的 `QQ_FACE_NAMES`
 * 逐条比对。有人手改这张表、或者 NapCat 升级后编号变了，都会立刻报出来 ——
 * 光断言"66 是爱心"是防不住静默漂移的。
 *
 * 用法:  node verify_qq_face_names.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SRC = 'C:/Users/20633/MimirLink/src';
const NAPCAT_FACE_JS = 'C:/Users/20633/NapCat/static/assets/qface-Cp_sIXAp.js';

const qq = await import(pathToFileURL(`${SRC}/qq-interactions.js`).href);
const se = await import(pathToFileURL(`${SRC}/standard-event.js`).href);

let pass = 0;
const failures = [];
function check(label, condition, extra = '') {
    if (condition) { pass += 1; console.log(`  [OK  ] ${label}`); }
    else { failures.push(label); console.log(`  [FAIL] ${label}${extra ? '  ' + extra : ''}`); }
}

// ---------------------------------------------------------------------------
console.log('=== Part 1  表 vs 权威来源（防静默漂移）===');

let authoritative = null;
let sourceNote = '';
try {
    const raw = fs.readFileSync(NAPCAT_FACE_JS, 'utf8');
    const m = raw.match(/JSON\.parse\('(\[.*?\])'\)/s);
    if (!m) throw new Error('在 NapCat 的表里没找到 JSON.parse([...])');
    const arr = JSON.parse(m[1]);
    authoritative = Object.fromEntries(
        arr.map((e) => [String(e.QSid), String(e.QDes || '').replace(/^\//, '')]));
    sourceNote = `NapCat qface (${Object.keys(authoritative).length} 条)`;
} catch (error) {
    check('能读到 NapCat 的权威表情表', false, String(error && error.message));
}
check('能读到 NapCat 的权威表情表', !!authoritative, sourceNote);

if (authoritative) {
    const ours = qq.QQ_FACE_NAMES || {};
    const missing = Object.keys(authoritative).filter((k) => !(k in ours));
    const extra = Object.keys(ours).filter((k) => !(k in authoritative));
    const wrong = Object.keys(ours).filter((k) => k in authoritative && ours[k] !== authoritative[k]);
    check('表里没有缺条目', missing.length === 0, `缺 ${missing.length} 个: ${missing.slice(0, 8)}`);
    check('表里没有多出来的条目', extra.length === 0, `多 ${extra.length} 个: ${extra.slice(0, 8)}`);
    check('🔴 每条名字都与权威来源一致（手改/升级漂移会被抓到）',
        wrong.length === 0,
        wrong.slice(0, 5).map((k) => `${k}: 表里=${ours[k]} 源=${authoritative[k]}`).join('; '));
}

// ---------------------------------------------------------------------------
console.log('\n=== Part 2  resolveQqFaceName 的边界 ===');

const spot = { 0: '惊讶', 14: '微笑', 63: '玫瑰', 66: '爱心', 67: '心碎', 76: '赞', 77: '踩', 79: '胜利' };
for (const [id, expect] of Object.entries(spot)) {
    check(`${id} = ${expect}`, qq.resolveQqFaceName(id) === expect,
        String(qq.resolveQqFaceName(id)));
}
check('数字 id 也能查（不是只有字符串）', qq.resolveQqFaceName(66) === '爱心');
check('表外的 id 返回空串（宁可没名字，也不要错名字）', qq.resolveQqFaceName('999999') === '');
check('非数字返回空串', qq.resolveQqFaceName('abc') === '');
check('空 / null / undefined 返回空串',
    qq.resolveQqFaceName('') === '' && qq.resolveQqFaceName(null) === ''
    && qq.resolveQqFaceName(undefined) === '');
check('带空格的数字也认', qq.resolveQqFaceName('  66  ') === '爱心');

// ---------------------------------------------------------------------------
console.log('\n=== Part 3  standard-event 真渲染 ===');

function renderHeader(id, name) {
    const built = se.buildStandardEvent({
        event: { message_type: 'private', user_id: 2063362809, self_id: 999, message_id: 1, time: 1 },
        contentText: `[QQ表情|id=${id}]`,
        rawText: '',
        messageSegments: [{ type: 'face', id, name }],
    });
    const header = se.formatStandardEventHeader(built);
    return (header.match(/segments:[^\]]*/) || [''])[0];
}

check('🔴 用户那天发的 {id:66,name:""} 渲染成「QQ表情:爱心」',
    renderHeader('66', '').includes('QQ表情:爱心|id=66'), renderHeader('66', ''));
check('表外的 id 仍然只留 id（不瞎猜）',
    renderHeader('9999', '').includes('QQ表情|id=9999'), renderHeader('9999', ''));
check('segment 自带 name 时优先用它（不被表覆盖）',
    renderHeader('66', '我自己起的名').includes('QQ表情:我自己起的名|id=66'),
    renderHeader('66', '我自己起的名'));

// ---------------------------------------------------------------------------
console.log('\n=== Part 4  源码级断言（两个渲染点都要接上）===');

const IDX = fs.readFileSync(`${SRC}/index.js`, 'utf8');
const SE = fs.readFileSync(`${SRC}/standard-event.js`, 'utf8');
const QQ = fs.readFileSync(`${SRC}/qq-interactions.js`, 'utf8');

check('index.js 导入了 resolveQqFaceName', /resolveQqFaceName/.test(IDX.split('\n').find((l) => l.includes("from './qq-interactions.js'")) || ''));
check('🔴 index.js 的 face 分支用了 id→名字 兜底',
    /const name = getAny\('name', 'text', 'summary'\) \|\| resolveQqFaceName\(id\)/.test(IDX));
check('standard-event.js 导入了 resolveQqFaceName', /import \{ resolveQqFaceName \}/.test(SE));
check('🔴 standard-event.js 的 face 分支用了 id→名字 兜底',
    /compactText\(segment\.name \|\| segment\.summary \|\| segment\.text, 40\)\s*\n?\s*\|\| resolveQqFaceName\(id\)/.test(SE));
check('qq-interactions.js 没有引入依赖（不会成环）', !/^import /m.test(QQ));
check('表用 Object.freeze 冻结（运行时改不动）', /QQ_FACE_NAMES = Object\.freeze\(/.test(QQ));
check('表名长度上限在位（防止把长描述当名字）', /QQ_FACE_NAME_MAX/.test(QQ));

// ---------------------------------------------------------------------------
// Part 5  🔴 「内置表情」已从「默认无视表情包」里摘出来（2026-10-11 用户要求）
// 分两类：真·表情包（image/mface/marketface）保持无视 + 低意愿；
//         QQ 自带表情（face）当成"有语义的一小句"。
console.log('\n=== Part 5  内置表情 vs 自制表情包的分流 ===');
{
    const { buildCurrentMessageFocus, formatCurrentMessageFocus } = await import(
        pathToFileURL(`${SRC}/current-message-focus.js`).href);
    const F = (id, name = '') => ({ type: 'face', id, name });
    const T = (text) => ({ type: 'text', text });
    const IMG = () => ({ type: 'image', summary: '[动画表情]' });
    const focusOf = (segments) => buildCurrentMessageFocus(
        { primaryStandardEvent: { messageType: 'private', segments, contentText: '' },
          routingDecisions: [] }, {});

    const heart = focusOf([F('66')]);
    check('🔴 单独一个爱心 ⇒ 意图 builtin_face（不再是 emoji_reaction）',
        heart.intent === 'builtin_face', heart.intent);
    check('🔴 策略是"回应"而不是"无视"',
        heart.strategies.includes('respond_to_builtin_face_in_character')
        && !heart.strategies.includes('ignore_sticker_keep_talking_about_text'),
        heart.strategies.join(','));
    check('🔴 不再出现「默认不用管表情包」那条',
        !heart.warnings.some((w) => w.includes('默认不用管表情包')));
    check('🔴 警告里点名了「爱心」（靠 id→名字 反查）',
        heart.warnings.some((w) => w.includes('「爱心」')), heart.warnings.join(' | '));
    check('警告是肯定式（不出现"别忽略它"这类否定式）',
        !heart.warnings.some((w) => /别忽略|不要忽略|别无视/.test(w)));

    const two = focusOf([F('66'), F('76')]);
    check('多个表情都点名（爱心、赞）',
        two.warnings.some((w) => w.includes('「爱心、赞」')), two.warnings.join(' | '));

    const withText = focusOf([T('在吗'), F('66')]);
    check('文字里夹表情 **不走** builtin_face（那就是普通消息）',
        withText.intent !== 'builtin_face', withText.intent);
    check('但名字照样要点出来（她知道那个表情是爱心）',
        withText.warnings.some((w) => w.includes('「爱心」')));

    const img = focusOf([IMG()]);
    check('自制表情包行为**没变**：还是 emoji_reaction', img.intent === 'emoji_reaction', img.intent);
    check('自制表情包仍然"默认无视"',
        img.strategies.includes('ignore_sticker_keep_talking_about_text')
        && img.warnings.some((w) => w.includes('默认不用管表情包')));

    const mixed = focusOf([IMG(), F('66')]);
    check('图+表情混着 ⇒ 图的规则优先（emoji_reaction）', mixed.intent === 'emoji_reaction', mixed.intent);

    const unknown = focusOf([F('999999')]);
    check('表外的 id 不进名字、不瞎猜',
        unknown.intent === 'builtin_face'
        && unknown.warnings.some((w) => w.includes('QQ 自带表情是有意思的')
            && !w.includes('「')), unknown.warnings.join(' | '));

    const named = focusOf([F('66', '我心心')]);
    check('segment 自带名字时优先用它', named.warnings.some((w) => w.includes('「我心心」')));
}

// ---------------------------------------------------------------------------
// Part 5b 意愿闸门：爱心不再受 chat.stickerReplyChance 管
// ⚠ `isStickerOnlyMessage` 没 export，按本项目惯例**从 index.js 本身切出函数体**求值
//   （不抄一份，否则验的是副本）。
console.log('\n=== Part 5b  isStickerOnlyMessage（切真函数）===');
{
    const start = IDX.indexOf('const STICKER_SEG_TYPES = new Set([');
    const end = IDX.indexOf('// <<< sticker-assertion patch <<<');
    check('能从 index.js 切出函数体（标记还在）', start > 0 && end > start, `start=${start} end=${end}`);
    if (start > 0 && end > start) {
        const tmp = path.join(os.tmpdir(), `sticker-extract-${Date.now()}.mjs`);
        fs.writeFileSync(tmp, IDX.slice(start, end) + '\nexport { isStickerOnlyMessage };\n', 'utf8');
        const { isStickerOnlyMessage } = await import(pathToFileURL(tmp).href);
        const msg = (segs) => isStickerOnlyMessage({ messageSegments: segs });
        check('🔴 只有爱心 ⇒ **不是** stickerOnly（不再被 20% 意愿闸门挡）',
            msg([{ type: 'face', id: '66', name: '' }]) === false);
        check('只有自制表情包 ⇒ 仍然是 stickerOnly', msg([{ type: 'image', summary: '[动画表情]' }]) === true);
        check('有真文字 ⇒ 不是 stickerOnly', msg([{ type: 'face', id: '66' }, { type: 'text', text: '在吗' }]) === false);

        // 🔴 「舞萌成绩」那件事：上传的图/截图**不是**表情包，不该被低意愿闸门丢
        //    （那条被 skip('sticker_low_willingness') 丢掉后**连库都没入**）
        check('🔴 上传的图（summary 空）⇒ 不是 stickerOnly（会被正常处理并入库）',
            msg([{ type: 'image', summary: '' }]) === false);
        check('🔴 连 summary 字段都没有的图 ⇒ 也不是 stickerOnly',
            msg([{ type: 'image' }]) === false);
        check('subType=0 的上传图 ⇒ 不是 stickerOnly', msg([{ type: 'image', subType: 0 }]) === false);
        check('subType=1 的老式表情包 ⇒ 仍是 stickerOnly', msg([{ type: 'image', subType: 1 }]) === true);
        check('上传图 + 真文字 ⇒ 不是 stickerOnly',
            msg([{ type: 'image', summary: '' }, { type: 'text', text: '这是我的成绩' }]) === false);
        check('mface / marketface 仍按表情包算（没被误伤）',
            msg([{ type: 'mface', summary: '[动画表情]' }]) === true
            && msg([{ type: 'marketface', summary: '[动画表情]' }]) === true);
        fs.rmSync(tmp, { force: true });
    }
}

// ---------------------------------------------------------------------------
// Part 5c 源码闸门：**两个 STICKER_SEG_TYPES 必须一致**（改一处漏一处是这类改动最容易犯的）
console.log('\n=== Part 5c  两处表情名单必须一致 ===');
{
    // ⚠ 两个文件写法不同（一个 `= [...]`，一个 `= new Set([...])`）。第一版正则把
    //   数组那侧的 `[` 吞进了第一个元素，白报 2 个 FAIL —— 解析器要同时吃两种写法。
    const pick = (src) => {
        const m = src.match(/const STICKER_SEG_TYPES = (?:new Set\()?\[([^\]]*)\]/);
        return m ? m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : null;
    };
    const CMF = fs.readFileSync(`${SRC}/current-message-focus.js`, 'utf8');
    const a = pick(CMF);
    const b = pick(IDX);
    check('两处都解析到了名单', !!a && !!b, `cmf=${JSON.stringify(a)} idx=${JSON.stringify(b)}`);
    check('🔴 两处名单一致（index.js 的意愿闸门 vs focus 的意图判定）',
        JSON.stringify(a) === JSON.stringify(b));
    check('🔴 名单里**不含** face（内置表情已摘出）',
        !!a && !a.includes('face'), JSON.stringify(a));
    check('名单里仍有 image / mface / marketface',
        !!a && ['image', 'mface', 'marketface'].every((x) => a.includes(x)), JSON.stringify(a));
    check('新增了 builtin_face 意图与对应策略',
        /return 'builtin_face'/.test(CMF) && /respond_to_builtin_face_in_character/.test(CMF));
    check('focus 里也有"自带表情是有意思的"那句警告',
        /QQ 自带表情是有意思的/.test(CMF));
}

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(62));
console.log(`结果: ${pass} 通过 / ${failures.length} 失败`);
if (failures.length) { failures.forEach((f) => console.log('  失败: ' + f)); process.exit(1); }
console.log('全部通过');
