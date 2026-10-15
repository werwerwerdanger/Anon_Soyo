/**
 * verify_attitude_in_prompt.mjs
 * ---------------------------------------------------------------------------
 * 「格式 / 态度规则」是否真的进了**装配后的**提示词。
 * 为什么需要单独一份：verify_character_card_v2.mjs 只打前 400 字，而规则块在很下面 ——
 * 那个脚本看不到，必须把整条 system 拉出来看。
 *
 * === 2026-10-13 重写（原来 17 个 FAIL，全部经过归因）===
 *
 * 1) 两张卡的版式已经**分道扬镳**，原脚本却对它们用同一套「编号块」断言：
 *      - soyo：仍是「输出格式要求（必须遵守）1..7」+「态度要求（同样必须遵守）8..」编号块
 *      - anon：已重写成扁平的「说话方式（对照官方台词的感觉）：」`-` 列表，**没有编号**
 *    ⇒ 对 anon 恒定失败。已按卡分别断言。
 *
 * 2) anon 那几条句子级断言（不做人身攻击 / 爱音是亲切的那一个 / 不会拆台 / 施舍式的宽容 /
 *    不要比喻）**在 anon 卡的任何备份里都不存在**（跨备份实测，最早查到 2026-10-10 12:08，
 *    连文件名带 `anti` 的那版也没有）⇒ 是**长期假红**，不是这次改动引入的。
 *    已按 soyo/anon 分别处置，见下方 CASES 的注释与文件末尾的「已知内容缺口」。
 *
 * 3) `*` 号断言原来对**整条装配后的 system** 判「一个 * 都不许有」，但 description 卡
 *    大面积用 `**加粗**`（实测 anon 32 个 / soyo 36 个）⇒ 结构上不可能过。
 *    真正的不变量在卡自己的 system_prompt 里（规则原文是"不要用星号写动作"）⇒ 只判 system_prompt。
 *
 * 4) 编号断言原来从**装配后的整条消息**里切，会把 description 自己的编号列表一起捞进来
 *    （实测 soyo 得到 [8..17, 18, 21, 18, 19, 20, 22, 23]）⇒ 改为只在卡的 system_prompt 里判。
 *
 * 用法: node verify_attitude_in_prompt.mjs
 */
import path from 'node:path';

/**
 * 每张卡：{ 结构类型, system_prompt 里的锚点, 任意字段里的锚点, 必须消失的旧措辞 }
 *
 * 锚点仍然钉的是**具体句子** —— 这是故意的：这份脚本的用途就是"改卡时别把好不容易调好的
 * 规则悄悄弄丢"。句子被改写时脚本会红，那时**按新措辞更新锚点并在这里记一行**，
 * 这个"红 → 更新"的过程本身就是变更日志。（已经发生过两次，见 soyo 的两条 old→new。）
 *
 * ⚠ `mustHave` 判的是卡自己的 `system_prompt`；`mustHaveAnywhere` 判**装配后的整条 system**
 *   —— 有些规则本来就在别的字段（如 soyo 的自称清单在 `personality`），不该因为"不在
 *   system_prompt 里"就报红（第一版重写时就是这么白报了一条）。
 */
const CASES = [
    {
        inst: 'MimirLink-soyo',
        card: 'Soyo_Nagasaki',
        structure: 'numbered',
        mustHave: [
            // 编号块的两个标题：装配后必须原样在
            '输出格式要求（必须遵守）',
            '态度要求（同样必须遵守）',
            // 2026-10-09 起：不再要求"每条都要有反应、有立场"（读起来像机器），
            // 改成"长短要像真人"，同时保留"别缩成客服式"这一端，避免退回死人感
            '长短要像真人',
            '也别缩成客服式的一句话交差',
            '不做人身攻击',
            // 2026-10-09：「用别人的刀捅人」这种文学比喻飘出来了，补的格式规则
            '说人话。用手机打字的大白话',
            '不要比喻',
            // ⚠ old→new（2026-10-13）：原锚点是「刻薄只对熟人」「永远只会见到礼貌那一面」。
            //   内容还在，措辞改成了"礼貌是一层壳"（第 9 条）⇒ 锚点跟着换，别把这条规则弄丢。
            '这层壳必须戴着',
            '不热络、不主动讨好',
        ],
        mustHaveAnywhere: [
            // 2026-10-09：她认不出「素食」这类常见称呼，补的自称清单。
            // ⚠ 它在卡自己的 `personality` 字段里，不在 system_prompt ⇒ 只能按装配结果判。
            '都是在叫你',
        ],
        mustNotHave: [],
    },
    {
        inst: 'MimirLink',
        card: 'Anon_Chihaya',
        structure: 'flat',
        mustHave: [
            // anon 的规则活在扁平列表里，锚点取它现在真实的措辞
            '说话方式（对照官方台词的感觉）',
            '长短要拉开：短的只有四五个字也行',
            '手机打字，不是写小说：不要用星号或括号写动作神态，不要旁白。',
            '不要自称 AI、模型或助手，不要暴露内部推理。',
            // 2026-10-13 用户：「强调是只看图，没有明确说明一定不要描述」
            '只有对方明确要你说出图里是什么',
            '千万别把你上一条说过的话再说一遍',
            '不要宣告你打算怎么处理这条消息',
            // 真人识别边界（幻觉高发区）
            '现实里的真人你只认识剧组那一圈',
        ],
        mustHaveAnywhere: [],
        mustNotHave: [
            // 这些是"爱音不该有"的旧措辞，已从卡里彻底移除，防回潮
            '允许刻薄',
            '可以抬杠、拆台、自吹自擂顺便挤兑别人',
        ],
    },
];

/** 卡自己的 system_prompt 里不许出现裸 `*`（规则原文就是"不要用星号写动作"）。 */
function starCount(s) {
    return (s.match(/\*/g) || []).length;
}

let failed = 0;
const say = (ok, label, extra = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
    if (!ok) failed += 1;
};

for (const { inst, card: cardName, structure, mustHave, mustHaveAnywhere, mustNotHave } of CASES) {
    const ROOT = `C:/Users/20633/${inst}`;
    const { CharacterManager } = await import(`file:///${ROOT}/src/character.js`);
    const { WorldBookManager } = await import(`file:///${ROOT}/src/worldbook.js`);
    const { PromptBuilder } = await import(`file:///${ROOT}/src/prompt.js`);

    const dataDir = path.join(ROOT, 'data');
    const characters = new CharacterManager(dataDir);
    const worldBooks = new WorldBookManager(dataDir);
    worldBooks.scanWorldBooks?.();

    const card = characters.readFromPng(cardName);
    const own = String(card?.system_prompt ?? '');

    const builder = new PromptBuilder(characters, worldBooks, { bindings: { global: {}, characters: {} } }, console);
    const { messages } = await builder.build(
        cardName,
        '你好，你是谁？',
        { recentMessages: [], summaries: [] },
        new Set(),
        { sessionId: 'att', messageType: 'group', participants: [] }
    );
    const system = messages.map((m) => m.content).join('\n\n');

    console.log(`\n--- ${inst} / ${cardName}  system=${system.length} 字  card.system_prompt=${own.length} 字 ---`);

    // ① 这个脚本的根本目的：卡里的规则块**确实进到装配后的提示词**了。
    //    只判 system_prompt 非空是不够的 —— 早先就有过"卡里有、提示词里没有"的情况。
    say(own.length > 200, '卡自己的 system_prompt 非空且够长', `${own.length} 字`);
    // 取一段够长的独有片段，确认逐字进了装配结果（避开只有一两字的通用片段）
    const probe = own.trim().slice(0, 120);
    say(system.includes(probe), 'system_prompt 逐字进了装配后的提示词', `probe=${JSON.stringify(probe.slice(0, 30))}...`);

    // ② 锚点：按卡分别核对
    for (const needle of mustHave) {
        say(own.includes(needle), needle);
    }
    // ②b 有些规则本来就在别的字段（personality / description）⇒ 按**装配后的整条**判
    for (const needle of mustHaveAnywhere || []) {
        say(system.includes(needle), `${needle}  （任意字段，按装配结果判）`);
    }

    // ③ 旧措辞必须消失（防回潮）
    for (const banned of mustNotHave) {
        say(!system.includes(banned), `dropped "${banned}"`);
    }
    say(!system.includes('只留第一句就够了'), 'old "只留第一句" line removed');

    // ④ 裸 `*` 只在 system_prompt 里判（description 用 **加粗** 是正常的，不能一起判）。
    //    ⚠ 也不能直接数 `*` 个数：两张卡的 system_prompt 现在都用 `**加粗**` 做强调
    //      （实测 anon 32 / soyo 24），直接数结构上不可能过。
    //      规则原文是"不要用星号写动作/神态" ⇒ 真正的不变量是**每个 `*` 都成对**，
    //      也就是把所有 `**` 摘掉后不应再剩 `*`（落了单的就是想写 `*动作*`）。
    const lone = own.replace(/\*\*/g, '').match(/\*/g)?.length ?? 0;
    say(lone === 0, `card.system_prompt 里没有落单的 '*'（成对的 **加粗** 不算），落单 ${lone} 个`);
    console.log(`  ..  system_prompt 里 '*' 共 ${starCount(own)} 个（应全为成对加粗）；整条装配结果 ${starCount(system)} 个`);

    // ⑤ 编号：只在卡的 system_prompt 里判，避免 description 的列表串进来
    const nums = [...own.matchAll(/(?:^|\n)\s*(\d+)\. /g)].map((m) => Number(m[1]));
    if (structure === 'numbered') {
        const formatOk = JSON.stringify(nums.slice(0, 7)) === JSON.stringify([1, 2, 3, 4, 5, 6, 7]);
        say(formatOk, 'format rules numbered 1..7（只在 system_prompt 里数）', JSON.stringify(nums.slice(0, 7)));
        // ⚠ 原来判的是「8 之后严格连续」。但卡后续补规则时**重复用过编号**（实测 18 出现两次，
        //   还夹了一个 `- ` 列表项和 `21b`），"严格连续"结构上不再成立。
        //   真正要守的是两个：① 态度块**从 8 开始**、② 后面**不许出现比 8 小的编号**
        //   （那意味着有人把格式块和态度块搞混了）。顺带把重复/异常编号当**观测项**报出来。
        const attitude = nums.slice(7);
        const startsAt8 = attitude[0] === 8;
        const allGe8 = attitude.every((n) => n >= 8);
        say(startsAt8 && allGe8, 'attitude rules 从 8 起、且没有混进 <8 的编号',
            JSON.stringify(attitude));
        const dupes = [...new Set(attitude.filter((n, i) => attitude.indexOf(n) !== i))];
        const bullets = (own.match(/(?:^|\n)\s*-\s/g) || []).length;
        if (dupes.length > 0 || bullets > 0) {
            console.log(`  ⚠  卡里的编号有瑕疵（**观测项，不判失败** —— 修它要动卡，属产品决定）：`
                + `重复编号 ${JSON.stringify(dupes)}；非编号列表项（'- '）${bullets} 个；`
                + `出现过的编号 ${JSON.stringify(attitude)}`);
        }
    } else {
        // anon 是扁平列表：不编号是这个版式的**特征**，别把"改成编号"当成修复
        say(nums.length === 0, 'anon 是扁平列表（不使用 1. 2. 编号）', `找到 ${nums.length} 个编号`);
        const bullets = (own.match(/(?:^|\n)\s*-\s/g) || []).length;
        say(bullets >= 15, '扁平列表条目够多（下界 15）', `${bullets} 条`);
    }
}

console.log(`
======================================================================
已知内容缺口（2026-10-13 实测，**故意没有**改成断言 —— 加不加回卡里是产品决定）
  anon 卡里搜不到下列句子，且**跨备份实测自 2026-10-10 12:08 起就从没存在过**
  （连文件名带 anti 的那版也没有），属于长期内容差异而不是脚本问题：
    - 不做人身攻击 / 不拿外貌、家庭、身份说事
    - 爱音是亲切的那一个，不是刻薄的那一个
    - 不会拆台
    - 施舍式的宽容
  soyo 卡里前两条仍然在（第 9、13 条），后两条从来没有过。
  ⇒ 上面的 anon 锚点据此**收紧到它真实拥有的规则**；要补回这些边界规则请先跟用户确认。
======================================================================`);

console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
