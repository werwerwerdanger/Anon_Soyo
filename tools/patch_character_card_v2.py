"""Make character cards actually reach the model.

THE BUG
-------
SillyTavern character cards come in two shapes:

    v1  ->  { name, description, personality, scenario, first_mes, ... }
    v2  ->  { spec: "chara_card_v2", spec_version: "2.0",
              data: { name, description, personality, scenario, first_mes, ... } }

v2 is the current standard, and both cards in use here (Soyo_Nagasaki.png,
Anon_Chihaya.png) are v2: the PNG's `chara` tEXt chunk holds a v2 payload.

CharacterManager.readFromPng() returns the parsed JSON verbatim -- it never
unwraps `data`. Every consumer in the codebase reads the top level:

    src/prompt.js:758   if (character.description)  -> 【角色描述】
    src/prompt.js:770   if (character.personality)  -> 【<name>的性格】
    src/prompt.js:783   if (character.scenario)     -> 【场景】
    src/prompt.js:949   if (character.first_mes)    -> opening greeting

so on a v2 card all four are undefined, none of those segments are emitted,
and the model is asked to roleplay with no role. Observed symptom: asked
"@Nagasaki_soyo 你是谁" in a group, the bot replied as a generic assistant
("我是群里的 AI 助手，可以陪大家聊天…") instead of as 长崎素世.

Measured on the live cards, before this patch:

    readFromPng('Soyo_Nagasaki') -> name=undefined, description len=0
    readFromPng('Anon_Chihaya')  -> name=undefined, description len=0
    (the real content is right there: data.description len=3711,
     data.personality len=177, data.first_mes len=460, ...)

Note src/character.js:173 already does `if (updated.data) Object.assign(...)`
on the write path -- the nesting is known to the codebase, it just was never
handled on the read path.

WHAT THIS PATCH DOES
--------------------
Right after the card is parsed and before the override layer is merged, flatten
the v2/v3 payload onto the top level:

    character = { ...cardData, ...character, data: cardData }

`spec` / `spec_version` / `data` are deliberately preserved, and `data` still
points at the original nested object, so updateCharacter()'s round-trip --
`{ ...currentChar, ...stUpdates }` plus `Object.assign(updated.data, stUpdates)`
-- keeps producing a valid v2 card. A v1 card has no `.data` and is untouched.

Idempotent, marker-based, same contract as patch_bocha.py / patch_result_honesty.py.
Runs `node --check` after writing and restores the backup if the file does not parse.

Usage:
    python patch_character_card_v2.py --dry-run
    python patch_character_card_v2.py
    python patch_character_card_v2.py --revert
"""
import pathlib
import shutil
import subprocess
import sys
import time

TARGETS = [
    r"C:\Users\20633\MimirLink\src\character.js",
    r"C:\Users\20633\MimirLink-soyo\src\character.js",
]

NODE = r"C:\Users\20633\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"

MARK_START = "        // >>> card-v2-flatten patch (managed by patch_character_card_v2.py) >>>"
MARK_END = "        // <<< card-v2-flatten patch <<<"

HEAD = """        if (!character) {
            throw new Error('无法从 PNG 文件中读取角色数据');
        }

"""

TAIL = """        // 检查是否有覆盖层文件
"""

ORIGINAL = HEAD + TAIL

BODY = """        // SillyTavern V2/V3 卡把所有字段放在 data 下，而 MimirLink 的读取方
        // (prompt.js 读 character.description / personality / scenario / first_mes)
        // 全在顶层取。不展开就会拿到空人设：角色描述/性格/场景三段都不生成，
        // 模型只能以通用助手身份作答。这里展开，但保留 spec/spec_version/data，
        // 让 updateCharacter() 仍能原样把卡写回 PNG。
        if (character.data && typeof character.data === 'object' && !Array.isArray(character.data)) {
            const cardData = character.data;
            character = { ...cardData, ...character, data: cardData };
        }
"""

PATCHED = HEAD + MARK_START + "\n" + BODY + MARK_END + "\n" + TAIL


def node_syntax_ok(path: pathlib.Path):
    out = subprocess.run([NODE, "--check", str(path)], capture_output=True, text=True)
    return out.returncode == 0, (out.stderr or out.stdout or '').strip()


def process(path: pathlib.Path, revert: bool, dry: bool, stamp: str) -> None:
    if not path.is_file():
        print(f"  !! missing: {path}")
        return
    src = path.read_text(encoding="utf-8")
    label = path.parent.parent.name

    if revert:
        if MARK_START not in src:
            print(f"  {label:15} already original (no marker)")
            return
        start = src.index(MARK_START)
        end = src.index(MARK_END) + len(MARK_END)
        if src[end:end + 1] == "\n":
            end += 1
        new = src[:start] + src[end:]
        action = "removed the flatten block"
    else:
        if MARK_START in src:
            print(f"  {label:15} already patched - skipped (idempotent)")
            return
        if ORIGINAL not in src:
            print(f"  {label:15} !! anchor not found - upstream changed, inspect manually")
            return
        new = src.replace(ORIGINAL, PATCHED, 1)
        action = "flatten V2/V3 card data"

    print(f"  {label:15} {action}  ({len(src)} -> {len(new)} bytes, {len(new) - len(src):+d})")
    if dry:
        print("        [dry-run] not written")
        return

    bak = path.with_name(path.name + f".bak-{stamp}")
    shutil.copy2(path, bak)
    path.write_text(new, encoding="utf-8")

    ok, err = node_syntax_ok(path)
    if ok:
        print(f"        backup: {bak.name}   node --check: OK")
        return
    shutil.copy2(bak, path)
    print("        !! node --check FAILED - restored the backup, nothing changed")
    for line in err.splitlines()[:4]:
        print(f"           {line}")


DRY = "--dry-run" in sys.argv
REVERT = "--revert" in sys.argv
stamp = time.strftime("%Y%m%d-%H%M%S")

print("=" * 70)
print(f"patch CharacterManager.readFromPng  revert={REVERT}  dry-run={DRY}")
print("=" * 70)
for target in TARGETS:
    process(pathlib.Path(target), REVERT, DRY, stamp)
print("=" * 70)
if not DRY:
    print("MimirLink must be RESTARTED for the change to load.")
