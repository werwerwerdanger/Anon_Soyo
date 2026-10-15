/**
 * verify_sticker_policy.mjs —— 表情 / 图片口径的**唯一**权威回归网
 *
 * 为什么会有这个文件（2026-10-13 合并）：
 * 这一条策略线前后摇摆过三四个版本，于是沉淀出三个**互相矛盾**的脚本，谁也不可能同时通过：
 *
 *   verify_sticker_react.mjs            要求 face/mface/marketface **都**"对表情做反应"
 *                                       （策略名 react_to_sticker_briefly_do_not_describe_it）
 *   verify_sticker_strategy_ignore.mjs  要求 face **也**"忽略"
 *                                       （2026-10-10 用户：「默认当没发过一样」）
 *   verify_image_as_sticker.mjs         断言旧措辞「不要报图里画的是什么」「不要描述画面细节」
 *
 * 现行口径（2026-10-11 用户：「把内置表情从『默认无视表情包』里摘出来」）是**拆开**的：
 *   - **真·表情包**（`image` / `mface` / `marketface`）⇒ 忽略，接着聊文字，不描述画面
 *   - **QQ 自带表情**（`face`，爱心/赞/心碎…）⇒ 它是有确定语义的一小句，**在角色里接话**
 * 三个旧脚本各自记录的是这个拆分**之前**的某一个版本，留着只会制造噪音 ⇒ 删掉，
 * 由本文件承载它们**各自的独家覆盖**（别在合并时丢掉）：
 *   - react  ：策略名逐段类型核对 + "纯文字不受影响" + 长度锚点仍在
 *   - ignore ：两个实例都跑 + 策略与「注意:」行**口径一致**（不许自相矛盾）
 *   - image_as_sticker：**从库里抓真实段结构**（不是凭空构造）+ hasEmojiSegment 必须含 image
 *
 * 另加一条 memory 里记过的坑：`STICKER_SEG_TYPES` 在**两个文件里各有一份**
 * （`current-message-focus.js` 一份数组、`index.js` 一份 Set）⇒ 改一处必须改另一处，
 * 这里加一致性闸门。
 *
 * 用法: node verify_sticker_policy.mjs
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const INSTANCES = [
    ['anon', 'C:/Users/20633/MimirLink'],
    ['soyo', 'C:/Users/20633/MimirLink-soyo'],
];

let failures = 0;
const assert = (c, m) => {
    console.log((c ? '  PASS  ' : '  FAIL  ') + m);
    if (!c) failures += 1;
};

// 真·表情包：自制图 / 大表情 / 动画表情
const STICKERS = [
    ['image + summary[动画表情]', [{ type: 'image', summary: '[动画表情]' }]],
    ['image 无 summary（上传的图也走这条）', [{ type: 'image' }]],
    ['mface', [{ type: 'mface' }]],
    ['marketface', [{ type: 'marketface' }]],
];
const STICKER_STRATEGY = 'ignore_sticker_keep_talking_about_text';
const FACE_STRATEGY = 'respond_to_builtin_face_in_character';
// 已经被否决的历史策略名：再出现就是倒退
const DEAD_STRATEGIES = [
    'describe_visible_emoji_or_mood',
    'react_to_sticker_briefly_do_not_describe_it',
];

for (const [name, ROOT] of INSTANCES) {
    console.log(`\n############ ${name} (${ROOT}) ############`);
    const SRC = `${ROOT}/src`;
    const { buildCurrentMessageFocus, formatCurrentMessageFocus } =
        await import(`file:///${SRC}/current-message-focus.js`);

    const focusOf = (segments, text = '') => formatCurrentMessageFocus(buildCurrentMessageFocus({
        primaryStandardEvent: {
            eventType: 'message', messageType: 'private', segments, contentText: text,
            sender: { id: '2063362809', name: 'werwer' },
        },
        currentUserMessage: text,
    }));
    const field = (focus, key) => (focus.match(new RegExp(`${key}: (.*)`)) || [])[1] || '';
    const intentOf = (f) => field(f, '意图');
    const stratOf = (f) => field(f, '策略');
    const warnOf = (f) => field(f, '注意');

    // ------------------------------------------------------------------ ①
    console.log('\n=== ① 意图分类矩阵 ===');
    for (const [label, segs] of STICKERS) {
        const f = focusOf(segs);
        assert(intentOf(f) === 'emoji_reaction', `${label} ⇒ emoji_reaction（实际 ${intentOf(f)}）`);
    }
    {
        const f = focusOf([{ type: 'face', id: '66', name: '' }]);
        assert(intentOf(f) === 'builtin_face', `纯 face（无文字）⇒ builtin_face（实际 ${intentOf(f)}）`);
    }
    {
        // ⚠ builtin_face 要求「整条没有文字」：文字里夹个爱心就是普通消息，不该走这条
        const f = focusOf([{ type: 'face', id: '66' }, { type: 'text', text: '今天好累啊' }], '今天好累啊');
        assert(intentOf(f) !== 'builtin_face',
            `face + 文字 ⇒ 不算 builtin_face（实际 ${intentOf(f)}）`);
    }
    {
        const f = focusOf([{ type: 'text', text: '你吉他练得怎么样' }], '你吉他练得怎么样');
        assert(intentOf(f) === 'chat', `纯文字 ⇒ chat（实际 ${intentOf(f)}）`);
    }

    // ------------------------------------------------------------------ ②
    console.log('\n=== ② 策略 / 警告口径（逐意图）===');
    for (const [label, segs] of STICKERS) {
        const f = focusOf(segs);
        const st = stratOf(f);
        const wn = warnOf(f);
        assert(st.includes(STICKER_STRATEGY), `${label}: 策略 = ${STICKER_STRATEGY}`);
        for (const dead of DEAD_STRATEGIES) {
            assert(!st.includes(dead), `${label}: 不含已否决的策略名 ${dead}`);
        }
        // 策略名是**原样喂给模型**的 ⇒ 写了 "react" 就等于命令她对表情做反应（与警告自相矛盾）
        assert(!/react|describe|描述/.test(st), `${label}: 策略里没有任何"反应/描述"字样`);
        assert(wn.includes('不要描述画面'), `${label}: 警告明确"不要描述画面"`);
        assert(wn.includes('不要念图上的字'), `${label}: 警告明确"不要念图上的字"`);
        assert(wn.includes('只有对方明确让你看图'), `${label}: 保留"只在被明确要求时才看图"的口子`);
        // 用户 2026-10-10 的原话：「就当对方没发过一样」在**空图**时会让她复读上一条
        assert(wn.includes('不要重复你上一条说过的话'), `${label}: 空图时禁复读`);
    }
    {
        const f = focusOf([{ type: 'face', id: '66', name: '' }]);
        const st = stratOf(f);
        const wn = warnOf(f);
        assert(st.includes(FACE_STRATEGY), `纯 face: 策略 = ${FACE_STRATEGY}`);
        assert(!st.includes('ignore'), '纯 face: 不许被当成"忽略"（那是真表情包的规则）');
        assert(wn.includes('QQ 自带表情是有意思的'), '纯 face: 警告点明"它是有意思的"');
        assert(wn.includes('按它的意思接话'), '纯 face: 警告要求按意思接话');
        assert(wn.includes('不用描述它长什么样'), '纯 face: 不描述外观');
        // ⚠ 必须把 id 翻成中文名（face 段的 name 常常是空串）—— 否则模型不知道是哪个表情
        assert(wn.includes('爱心'), `纯 face: 带出中文表情名（id 66 ⇒ 爱心，实际 ${wn.match(/「[^」]*」/)?.[0] || '无'}）`);
    }
    {
        // 图 + 爱心混发 ⇒ 图的规则优先（检测顺序：hasEmojiSegment 在 builtin_face 之前）
        const f = focusOf([{ type: 'image', summary: '[动画表情]' }, { type: 'face', id: '66' }]);
        assert(intentOf(f) === 'emoji_reaction', '图 + 爱心混发 ⇒ 图的规则优先');
        assert(stratOf(f).includes(STICKER_STRATEGY), '图 + 爱心混发 ⇒ 走表情包策略');
    }
    {
        // 长度锚点不能被动掉（这是压长度的最高杠杆位置）
        const f = focusOf([{ type: 'text', text: '你吉他练得怎么样' }], '你吉他练得怎么样');
        assert(stratOf(f).includes('keep_lines_short_like_typing_on_a_phone'), '纯文字：长度锚点仍在');
        assert(!/表情/.test(warnOf(f)), '纯文字：不带任何表情相关警告');
    }

    // ------------------------------------------------------------------ ③
    console.log('\n=== ③ 策略与「注意:」行口径一致（不许自相矛盾）===');
    for (const [label, segs] of STICKERS) {
        const st = stratOf(focusOf(segs));
        const wn = warnOf(focusOf(segs));
        // 策略说 ignore，警告里就不许出现"做反应"这类对立指令
        assert(!/给(个|点)?反应|回个反应|对.{0,4}表情.{0,4}反应/.test(wn),
            `${label}: 警告里没有与"忽略"对立的"做反应"指令`);
        assert(st.split(', ').filter(Boolean).length === new Set(st.split(', ')).size,
            `${label}: 策略无重复项`);
    }

    // ------------------------------------------------------------------ ④
    console.log('\n=== ④ 真实段结构（从库里抓，不凭空构造）===');
    {
        let realSegs = null;
        const dbPath = `${ROOT}/data/chats/memory-store.sqlite`;
        try {
            const db = new DatabaseSync(dbPath, { readOnly: true });
            const rows = db.prepare(
                "SELECT metadata_json FROM messages WHERE role='user' AND content LIKE '%image%' "
                + 'ORDER BY timestamp DESC LIMIT 20'
            ).all();
            for (const r of rows) {
                const meta = JSON.parse(r.metadata_json || '{}');
                for (const ev of meta.standardEvents || []) {
                    const segs = ev.segments || [];
                    if (segs.some((s) => s.type === 'image')) { realSegs = segs; break; }
                }
                if (realSegs) break;
            }
            db.close();
        } catch (e) {
            console.log(`  (读库失败，改用等价构造: ${e.message})`);
        }
        assert(!!realSegs, '从库里抓到一条真实的 image 段');
        if (realSegs) {
            console.log(`  ..  真实段: ${JSON.stringify(realSegs).slice(0, 160)}`);
            const f = focusOf(realSegs);
            assert(intentOf(f) === 'emoji_reaction', '真实 image 段 ⇒ emoji_reaction');
            assert(stratOf(f).includes(STICKER_STRATEGY), '真实 image 段 ⇒ 走表情包策略');
        }
    }

    // ------------------------------------------------------------------ ⑤
    console.log('\n=== ⑤ 源码级闸门 ===');
    const cmf = fs.readFileSync(`${SRC}/current-message-focus.js`, 'utf8');
    const idx = fs.readFileSync(`${SRC}/index.js`, 'utf8');

    // 🔴 STICKER_SEG_TYPES 在两个文件里各有一份 ⇒ 必须同步（memory §5.3 记过的坑）
    const readSet = (src, label) => {
        const m = src.match(/STICKER_SEG_TYPES\s*=\s*(?:new Set\()?\[([^\]]*)\]/);
        if (!m) { assert(false, `${label} 里找到 STICKER_SEG_TYPES 定义`); return null; }
        return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).sort();
    };
    const a = readSet(cmf, 'current-message-focus.js');
    const b = readSet(idx, 'index.js');
    assert(!!a && !!b && a.join(',') === b.join(','),
        `🔴 两个文件里的 STICKER_SEG_TYPES 一致（cmf=[${a}] index=[${b}]）`);
    assert(a && a.includes('image'),
        '🔴 STICKER_SEG_TYPES 含 image（QQ 动画表情在 OneBot 里是 image 段，漏了这条路整段失效）');

    // 历史包袱不许回潮
    assert(!cmf.includes("['face', 'mface', 'marketface'].includes(type)"),
        '旧的漏判写法（不含 image）已移除');
    for (const dead of DEAD_STRATEGIES) {
        // ⚠ 不能只判 `!cmf.includes(name)` —— 历史策略名常被留在**注释**里说明"原来是什么"
        //   （`describe_visible_emoji_or_mood` 就只出现在注释第 151 行）。要判的是
        //   **它没有被真的 push 进策略列表**，否则一改注释就假报。
        const pushed = new RegExp(`push\\(\\s*['"]${dead}['"]`).test(cmf);
        assert(!pushed, `源码里没有再把 ${dead} push 进策略`);
    }
    assert(cmf.includes('respond_to_builtin_face_in_character'), '内置表情的在角色里回应策略在位');
    assert(cmf.includes('resolveQqFaceName'), '用 resolveQqFaceName 把 face id 翻成中文名');
    // 顺序：图优先于内置表情
    const iEmoji = cmf.indexOf("return 'emoji_reaction'");
    const iFace = cmf.indexOf("return 'builtin_face'");
    assert(iEmoji > 0 && iFace > 0 && iEmoji < iFace,
        '🔴 hasEmojiSegment 判定排在 builtin_face 之前（图 + 爱心混发时图优先）');
}

console.log('\n' + '='.repeat(74));
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
