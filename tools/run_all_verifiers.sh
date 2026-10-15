#!/usr/bin/env bash
# run_all_verifiers.sh —— 把所有 verify_*.mjs 跑一遍，分类出"坏的/过期的"
# 用法: bash run_all_verifiers.sh
cd "$(dirname "$0")" || exit 1
OUT="_verifier_sweep.txt"
: > "$OUT"

echo "=== 起点 $(date '+%H:%M:%S') ===" >> "$OUT"
for f in verify_*.mjs; do
  [ -f "$f" ] || continue
  start=$(date +%s)
  res=$(timeout 75 node "$f" 2>&1)
  code=$?
  took=$(( $(date +%s) - start ))
  pf=$(printf '%s' "$res" | grep -cE "^(  )?(PASS|\[OK)" )
  ff=$(printf '%s' "$res" | grep -cE "^(  )?(FAIL|\[FAIL)" )
  all=$(printf '%s' "$res" | grep -cE "ALL CHECKS PASSED|全部通过|ALL PASS")
  # 取一行最像"结论"的输出
  verdict=$(printf '%s' "$res" | grep -aE "CHECK\(S\) FAILED|ALL CHECKS PASSED|汇总|FAIL 数|Error|error:|ReferenceError|TypeError|Cannot find" | tail -1 | cut -c1-70)
  st="OK"
  if [ "$code" = "124" ]; then st="TIMEOUT"
  elif [ "$ff" != "0" ]; then st="FAIL($ff)"
  elif [ "$code" != "0" ]; then st="ERR($code)"
  fi
  printf "%-46s %-11s took=%02ds PASS=%-3s FAIL=%-3s  %s\n" "$f" "$st" "$took" "$pf" "$ff" "$verdict" >> "$OUT"
done
echo "=== 终点 $(date '+%H:%M:%S') ===" >> "$OUT"
cat "$OUT"
