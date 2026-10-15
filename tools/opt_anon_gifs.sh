#!/usr/bin/env bash
# 批量把 春也Haruya 的爱音 GIF 表情包优化成适合 QQ 发的大小，并改成可读文件名。
#
# 为什么要做：
#   * 原图 500×500、每张 1~1.8MB —— 当表情包太大（发送慢、QQ 可能二次压缩）
#   * 原文件名是 QQ 下载缓存的混淆名（NR8AVjViQ2dB...），完全看不出是什么
# 参数选择依据（实测扫描，3 个样本）：
#   320/64色/13fps  → 421KB   ← 采用（画质已肉眼确认，无色块）
#   240/64色/13fps  → 274KB
#   320/128色       → 541KB
#   320/64色/不限帧率 → 863KB  （结论：帧率是最大的体积因子）
#   🔴 dither 必须关：bayer 抖色是噪声，对 GIF 的 LZW 压缩极其致命
set -u

SRC="C:/Users/20633/Desktop/爱音gif"
OUT="C:/Users/20633/MimirLink/data/sticker-inbox/anon-gif"
FF="/c/msys64/mingw64/bin/ffmpeg"
VF="fps=15,scale=320:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=none"

mkdir -p "$OUT"

# 包名 → ASCII 前缀（用户偏好不要中文文件名）
map() {
    case "$1" in
        *普通爱音*)   echo "putong" ;;      # 爱音大合集 单主：梦月琦灵
        *红爱音C*)    echo "hongc" ;;       # 红爱音C（私人众筹）
        *幼稚园*)     echo "yzy" ;;         # 地雷幼稚园爱音 单主秋诺爱睡觉
        *风衣*)       echo "fengyi" ;;      # 风衣爱音B 单主：A.M.
        *)            echo "other" ;;
    esac
}

total_in=0 total_out=0 n=0
for dir in "$SRC"/*/*/; do
    prefix=$(map "$dir")
    i=0
    for f in "$dir"*.gif; do
        [ -e "$f" ] || continue
        i=$((i + 1))
        out=$(printf "%s/%s_%03d.gif" "$OUT" "$prefix" "$i")
        if ! "$FF" -v error -y -i "$f" -vf "$VF" "$out" 2>/dev/null; then
            echo "  [FAIL] $(basename "$f")"
            continue
        fi
        total_in=$((total_in  + $(stat -c%s "$f")))
        total_out=$((total_out + $(stat -c%s "$out")))
        n=$((n + 1))
    done
    printf "  %-10s %3d 个\n" "$prefix" "$i"
done

echo "--------------------------------------------------"
printf "优化 %d 个：%dMB → %dMB（压到 %.1f%%）\n" \
    "$n" $((total_in / 1048576)) $((total_out / 1048576)) \
    "$(echo "scale=1; $total_out * 100 / $total_in" | bc)"
echo "输出目录: $OUT"
