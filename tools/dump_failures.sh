#!/usr/bin/env bash
# dump_failures.sh —— 把失败脚本的完整输出抓到一个文件里，便于归因
cd "$(dirname "$0")" || exit 1
OUT="_verifier_failures.txt"
: > "$OUT"
for f in verify_anon_persona.mjs verify_attitude_in_prompt.mjs verify_example_dialogue.mjs \
         verify_group_willingness.mjs verify_ignore_napcat.mjs verify_image_as_sticker.mjs \
         verify_keyword_recall.mjs verify_lang_engines.mjs verify_oj_ac.mjs \
         verify_oj_feedback.mjs verify_participant_roster.mjs verify_reply_decision.mjs \
         verify_reply_window.mjs verify_send_interval.mjs verify_silence_gate.mjs \
         verify_sticker_react.mjs verify_sticker_strategy_ignore.mjs; do
  echo "" >> "$OUT"
  echo "########## $f ##########" >> "$OUT"
  timeout 75 node "$f" 2>&1 | grep -aE "FAIL|Error|error:|at |^===|汇总|实际|期望|expect|got|want" | head -60 >> "$OUT"
done
echo "done -> $OUT"
