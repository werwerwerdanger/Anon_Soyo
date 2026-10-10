#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_ignore_napcat.py -- 无视 NapCat 自己的命令输出

用户（2026-10-10 14:20）：「你看下log为什么两个ai莫名其妙聊起来了」
                「你能不能直接把napcat给无视了」

### 查清的现象
群 929159193 里有人发了一条 `#napcat`，**群里每个 NapCat 实例都以自己 bot 的账号
回了一段**「NapCat 信息 / 版本 / 平台 / 运行时间」——实测一次炸出 5 条：
    <群友A>       NapCat 4.15.19  linux  20天16小时
    <群友B>       NapCat 4.18.2   linux  19天16小时
    ...（每个装了 NapCat 的号都会回一条）
（日志 14:13:07 `收到消息 [group:929159193]: #napcat` 后面紧跟三行 `NapCat 信息`）

MimirLink **不识别这种系统输出**，它们以普通成员消息进来
（`[群聊|QQ:<群友A>|昵称:<昵称>|…] NapCat 信息\n版本: …`），于是走了正常回复判定。

### 为什么两个 AI 会互相聊起来
1. 上述输出被当成普通群友发言 → 触发回复；
2. 两个实例互为 `chat.coBotIds`，各自把**对方**的输出当群友发言 ⇒ 一来一回；
3. 唯一闸门 `botBanterMaxTurns:2 / botBanterWindowMs:5min` **确实生效**
   （日志 14:13:10 `skipReason: "bot_banter_limit"`），但"允许 2 次"= 允许一来一回，
   5 分钟窗口一过又能再来一轮 ⇒ 用户看到的就是"莫名其妙聊起来"。

### ⚠ 为什么不能用「忽略自己的消息」解决
`handleMessage()` 里已经有 `event.user_id === selfId → return` 的守卫，
但 NapCat 输出是**各 bot 用自己的账号发的**：对另一个实例来说发送者是别人，
selfId 守卫盖不到。⇒ 只能按**内容特征**识别，与发送者无关。

### 本补丁
- 新建 `src/napcat-output.js`：`isNapcatNoise(text)`
  · 含 `NapCat 信息` 标记 → 真
  · 同时含 `版本:` 与 `运行时间:` → 真
  · 整段只有 `#napcat` / `#napat` 命令行 → 真
- `src/index.js`：
  · 顶部加 import
  · `buildRoutingDecision()` 里 `access_denied` 之后加闸门 → `skip('napcat_output')`
    （放在这里 = 群聊/私聊两条路都吃到，且优先于 sticker / co_bot / keyword 判定）
- 开关：`chat.ignoreNapcatOutput !== false`（默认开，新键不会因 WebUI 保存而回退）

用法:
  python patch_ignore_napcat.py --check
  python patch_ignore_napcat.py
  python patch_ignore_napcat.py --revert
"""
import argparse
import json
import os
import shutil
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

DIRS = [r"C:\Users\20633\MimirLink-soyo", r"C:\Users\20633\MimirLink"]

M_JS = "// >>> napcat-output-ignore patch (managed by patch_ignore_napcat.py) >>>"
M_JS_E = "// <<< napcat-output-ignore patch <<<"

MODULE = '''/**
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

const NAPCAT_INFO_MARKER = /NapCat\\s*信息/i;
const NAPCAT_VERSION_FIELD = /版本\\s*[:：]/;
const NAPCAT_UPTIME_FIELD = /运行时间\\s*[:：]/;
// ⚠ 必须整行都是命令 —— 用 \\b 会把「#napcat 这命令怎么用」也吃掉（实测误判）
const NAPCAT_COMMAND_LINE = /^[#/](napcat|napat)\\s*$/i;

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
    const lines = src.split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length > 0 && lines.every((line) => NAPCAT_COMMAND_LINE.test(line))) {
        return true;
    }
    return false;
}

export default isNapcatNoise;
'''

IMPORT_ANCHOR = "import { chatScopeKey } from './chat-scope.js';"
IMPORT_NEW = (IMPORT_ANCHOR
              + "\n"
              + M_JS
              + "\nimport { isNapcatNoise } from './napcat-output.js';"
              + "\n"
              + M_JS_E)

GATE_ANCHOR = """    if (!allowed) {
        return skip('access_denied');
    }
"""
GATE_NEW = GATE_ANCHOR + """
    """ + M_JS + """
    // NapCat 的 `#`-命令输出会以各 bot 自己的账号刷进群，被当成普通群友发言；
    // 两个实例互为 coBot 时会互相把对方的输出当群友 ⇒ 来回聊。按内容特征挡掉。
    // 开关 chat.ignoreNapcatOutput !== false（默认开）。
    if (config?.chat?.ignoreNapcatOutput !== false && isNapcatNoise(plainText)) {
        return skip('napcat_output');
    }
    """ + M_JS_E + "\n"


DRY = False


def _backup(path, tag):
    if DRY:
        return
    shutil.copy2(path, path + ".bak-" + time.strftime("%Y%m%d-%H%M%S") + "-" + tag)


def _write(path, text):
    if DRY:
        return False
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return True


def patch_dir(d, revert=False):
    idx = os.path.join(d, "src", "index.js")
    mod = os.path.join(d, "src", "napcat-output.js")
    info = {"dir": d, "notes": [], "changed": False}

    if not os.path.exists(idx):
        info["notes"].append("没有 src/index.js")
        return info

    src = open(idx, encoding="utf-8").read()

    if revert:
        if M_JS not in src:
            info["notes"].append("没有补丁标记")
            return info
        out = src
        # 撤掉 import 块
        out = out.replace(IMPORT_NEW, IMPORT_ANCHOR, 1)
        # 撤掉闸门块
        out = out.replace(GATE_NEW, GATE_ANCHOR, 1)
        _backup(idx, "nonapcat")
        _write(idx, out)
        if os.path.exists(mod) and not DRY:
            os.remove(mod)
        info["changed"] = True
        info["notes"].append("已还原")
        return info

    if M_JS in src:
        info["notes"].append("已打过补丁")
        return info

    if src.count(GATE_ANCHOR) != 1:
        info["notes"].append(f"GATE 锚点={src.count(GATE_ANCHOR)}")
    if src.count(IMPORT_ANCHOR) != 1:
        info["notes"].append(f"IMPORT 锚点={src.count(IMPORT_ANCHOR)}")
    if info["notes"]:
        return info

    out = src.replace(IMPORT_ANCHOR, IMPORT_NEW, 1)
    out = out.replace(GATE_ANCHOR, GATE_NEW, 1)

    _backup(idx, "nonapcat")
    if os.path.exists(mod):
        _backup(mod, "nonapcat")
    _write(mod, MODULE)
    if not _write(idx, out):
        info["notes"].append("dry-run：未写入")
        info["changed"] = True
        return info

    back = open(idx, encoding="utf-8").read()
    probs = []
    for need in (M_JS, M_JS_E, "import { isNapcatNoise } from './napcat-output.js';",
                 "isNapcatNoise(plainText)", "skip('napcat_output')",
                 "config?.chat?.ignoreNapcatOutput !== false"):
        if need not in back:
            probs.append(f"index.js 缺失: {need[:44]}")
    if not os.path.exists(mod):
        probs.append("napcat-output.js 未生成")
    else:
        m = open(mod, encoding="utf-8").read()
        for need in ("export function isNapcatNoise", "NAPCAT_INFO_MARKER",
                     "NAPCAT_VERSION_FIELD", "NAPCAT_UPTIME_FIELD"):
            if need not in m:
                probs.append(f"模块缺失: {need}")
    info["changed"] = not probs
    info["notes"].extend(probs or ["ok"])
    return info


def patch_config(path, revert=False):
    cfg = json.load(open(path, encoding="utf-8"))
    info = {"path": path, "notes": [], "changed": False}
    ch = cfg.setdefault("chat", {})
    cur = ch.get("ignoreNapcatOutput")
    target = None if revert else True
    if cur == target:
        return info
    if target is None:
        ch.pop("ignoreNapcatOutput", None)
    else:
        ch["ignoreNapcatOutput"] = target
    info["notes"].append(f"chat.ignoreNapcatOutput: {cur} -> {target}")
    info["changed"] = True
    if DRY:
        return info
    _backup(path, "nonapcatcfg")
    json.dump(cfg, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    return info


def main():
    global DRY
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    ap.add_argument("--skip-config", action="store_true")
    ap.add_argument("--force-module", action="store_true",
                    help="只重写 src/napcat-output.js（模板改了以后用它同步）")
    args = ap.parse_args()
    DRY = bool(args.check)          # 🔴 必须先折成 dry，再走任何写入路径

    if args.force_module:
        for d in DIRS:
            mod = os.path.join(d, "src", "napcat-output.js")
            _backup(mod, "nonapcat")
            _write(mod, MODULE)
            print(f"[mod ] {mod}  已按模板重写")
        print("\n⚠ 需要重启才生效。")
        return

    for d in DIRS:
        r = patch_dir(d, args.revert)
        print(f"[src ] {d}  changed={r['changed']}  {'; '.join(r['notes']) or 'ok'}")
    if not args.skip_config:
        for d in DIRS:
            p = os.path.join(d, "config.json")
            r = patch_config(p, args.revert)
            print(f"[cfg ] {p}  changed={r['changed']}  {'; '.join(r['notes']) or 'ok'}")

    if args.check:
        print("\n--check：以上为预演，未写入。")
    else:
        print("\n⚠ src/ 改动需要重启才生效。重启：mimir-tools/restart-mimir.ps1")


if __name__ == "__main__":
    main()
