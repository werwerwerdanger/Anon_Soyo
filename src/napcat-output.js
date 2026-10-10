/**
 * NapCat 命令输出识别（由 mimir-tools/patch_ignore_napcat.py 部署）
 *
 * 为什么需要它：NapCat 的 `#`-命令会把结果**以 bot 自己的账号**发回群里，
 * 于是（a）本实例会看到自己的输出（已被 handleMessage 的 selfId 守卫挡掉），
 * （b）**另一个**实例会把它当成普通群友发言 —— 这条守卫盖不到，必须按内容识别。
 *
 * 实测样例（群 929159193 一条 `#napcat` 炸出 5 条）：
 *     NapCat 信息
 *     版本: 4.18.2
 *     平台: linux (64-bit)
 *     运行时间: 19天 16小时 56分钟
 */

const NAPCAT_INFO_MARKER = /NapCat\s*信息/i;
const NAPCAT_VERSION_FIELD = /版本\s*[:：]/;
const NAPCAT_UPTIME_FIELD = /运行时间\s*[:：]/;
// ⚠ 必须整行都是命令 —— 用 \b 会把「#napcat 这命令怎么用」也吃掉（实测误判）
const NAPCAT_COMMAND_LINE = /^[#/](napcat|napat)\s*$/i;

/**
 * 这段文本是不是 NapCat 的命令输出（或命令本身）？
 * @param {string} text 已经去掉结构化消息头之后的正文
 * @returns {boolean}
 */
export function isNapcatNoise(text) {
    const src = String(text == null ? '' : text);
    if (!src.trim()) {
        return false;
    }
    // 1) 标题块：最可靠的特征
    if (NAPCAT_INFO_MARKER.test(src)) {
        return true;
    }
    // 2) 没有标题时，版本 + 运行时间同时出现也算（不同版本格式略有差异）
    if (NAPCAT_VERSION_FIELD.test(src) && NAPCAT_UPTIME_FIELD.test(src)) {
        return true;
    }
    // 3) 整段只有命令本身（`#napcat`），没有别的正文
    const lines = src.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length > 0 && lines.every((line) => NAPCAT_COMMAND_LINE.test(line))) {
        return true;
    }
    return false;
}

export default isNapcatNoise;
