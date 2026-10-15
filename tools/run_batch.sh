#!/usr/bin/env bash
# run_batch.sh —— 分批跑 verify_*.mjs（一次 SIGTERM 只丢一个批次）
# 用法: bash run_batch.sh _verifier_sweep_2.txt verify_a.mjs verify_b.mjs ...
cd "$(dirname "$0")" || exit 1
OUT="$1"; shift
echo "=== batch start $(date '+%H:%M:%S') ===" >> "$OUT"
for f in "$@"; do
  [ -f "$f" ] || { echo "$f  MISSING" >> "$OUT"; continue; }
  start=$(date +%s)
  res=$(timeout 75 node "$f" 2>&1)
  code=$?
  took=$(( $(date +%s) - start ))
  pf=$(printf '%s' "$res" | grep -cE "^(  )?(PASS|\[OK)")
  ff=$(printf '%s' "$res" | grep -cE "^(  )?(FAIL|\[FAIL)")
  verdict=$(printf '%s' "$res" | grep -aE "CHECK\(S\) FAILED|ALL CHECKS PASSED|汇总|FAIL 数|Error|error:|ReferenceError|TypeError|Cannot find" | tail -1 | cut -c1-70)
  st="OK"
  if [ "$code" = "124" ]; then st="TIMEOUT"
  elif [ "$ff" != "0" ]; then st="FAIL($ff)"
  elif [ "$code" != "0" ]; then st="ERR($code)"
  fi
  printf "%-46s %-11s took=%02ds PASS=%-3s FAIL=%-3s  %s\n" "$f" "$st" "$took" "$pf" "$ff" "$verdict" >> "$OUT"
done
echo "=== batch end $(date '+%H:%M:%S') ===" >> "$OUT"
