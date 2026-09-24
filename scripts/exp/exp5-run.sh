#!/usr/bin/env bash
cd /tmp/exp5-repo
mkdir -p /tmp/exp5_logs
mapfile -t LINES < /tmp/.p5x/exp5-armmap.tsv
for line in "${LINES[@]}"; do
  IFS=$'\t' read -r arm cond dir <<< "$line"
  P="Do exactly two tool calls, in order, both in the foreground (never set run_in_background).
Step 1: call the Agent tool with exactly: subagent_type=\"upstream-analyst\", model=\"zai/glm-5.3\", thinking=\"medium\", description=\"upstream-expert\", prompt=\"请阅读 /tmp/.p5x/brief-A.md，并严格按其中的要求完成任务。\".
Step 2: after step 1 has finished, call the Agent tool with exactly: subagent_type=\"architect-consult\", model=\"zai/glm-5.3\", thinking=\"medium\", description=\"exp5 ${arm}\", prompt=\"请先阅读 ${dir}/task.md，并严格按其中的要求完成任务。输出路径：${dir}/out.md\".
If any tool result says the run was moved to the background or is still running, call get_subagent_result with that run_id, wait=true, wait_ms=1200000, repeating until it is terminal, before moving on. Do nothing else. Finally print exactly one line: DONE <status of step 2>."
  ( timeout 2400 pi -p --model zai/glm-5.3 --thinking low "$P" </dev/null > /tmp/exp5_logs/${arm}.log 2>&1; echo "exit=$?" >> /tmp/exp5_logs/${arm}.log ) &
  sleep 3
done
wait
echo "ALL DONE"; for f in /tmp/exp5_logs/*.log; do echo "== $(basename $f): $(tail -2 $f | tr '\n' ' ')"; done
