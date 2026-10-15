#!/usr/bin/env bash
# 给每套 GIF 的第一帧拼联络图（按文件名序号，6 列，行优先）
# 用途：让用户（或我）能一次看到所有表情，按编号决定怎么分类。
#
# 为什么拆多张：169 张拼一张会变成 1200×7000 的长条，没法看。
# 为什么不用 drawtext 烧编号：需要字体且要逐格画，成本高收益低 ——
#   网格是行优先的，只要告诉看图的人"第 1 格 = 001"，对应关系就是确定的。
set -u

O="C:/Users/20633/MimirLink/data/sticker-inbox/anon-gif"
OUT="C:/Users/20633/MimirLink/data/sticker-inbox/anon-sheets"
FF="/c/msys64/mingw64/bin/ffmpeg"
CELL=200          # 每格边长
COLS=6
PER_SHEET=60      # 每张联络图最多几格

mkdir -p "$OUT"
rm -f "$OUT"/*.png "$OUT"/*.txt

sheet() {                        # sheet <prefix> <批号> <文件列表...>
    local prefix="$1" idx="$2"; shift 2
    local tmp="$OUT/_tmp_$prefix"
    rm -rf "$tmp"; mkdir -p "$tmp"
    local i=0
    for f in "$@"; do
        i=$((i + 1))
        # 取第一帧 → 统一格子尺寸（contain：留白而不是拉伸变形）
        "$FF" -v error -y -i "$f" -frames:v 1 \
            -vf "scale=$CELL:$CELL:force_original_aspect_ratio=decrease,pad=$CELL:$CELL:(ow-iw)/2:(oh-ih)/2:color=0x2a2a2a" \
            "$(printf '%s/%03d.png' "$tmp" "$i")" 2>/dev/null
    done
    local files=("$tmp"/*.png)
    local n=${#files[@]}
    [ "$n" -eq 0 ] && { echo "  $prefix 批$idx: 无图"; return; }
    local rows=$(( (n + COLS - 1) / COLS ))
    # 用 concat 列表喂给 tile（⚠ 进程替换不行，必须真文件）
    : > "$tmp/list.txt"
    for f in "${files[@]}"; do echo "file '$f'" >> "$tmp/list.txt"; done
    "$FF" -v error -y -f concat -safe 0 -i "$tmp/list.txt" \
        -vf "tile=${COLS}x${rows}:padding=4:color=0x2a2a2a" -frames:v 1 \
        "$OUT/${prefix}_${idx}.png" 2>/dev/null
    rm -rf "$tmp"
    echo "  ${prefix}_${idx}.png  ${n} 格（${COLS}列×${rows}行）"
}

for prefix in putong hongc yzy fengyi; do
    mapfile -t all < <(ls "$O"/${prefix}_*.gif 2>/dev/null | sort)
    [ "${#all[@]}" -eq 0 ] && continue
    idx=1
    for ((start = 0; start < ${#all[@]}; start += PER_SHEET)); do
        sheet "$prefix" "$idx" "${all[@]:start:PER_SHEET}"
        idx=$((idx + 1))
    done
done
echo "输出目录: $OUT"
