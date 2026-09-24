#!/usr/bin/env bash
# usage: exp-probe.sh <armmap.tsv> [mmin]
cd ~/.pi/agent/sessions/--home-bluecake-ai-pi-toolkit--/
mapfile -t FILES < <(find . -name "*.jsonl" -mmin -${2:-120})
first_user() { jq -r 'select(.type=="message" and .message.role=="user") | .message.content | if type=="string" then . else (map(select(.type=="text").text)|join("")) end' "$1" 2>/dev/null | head -1; }
cost_of() { jq -s '[.[] | select(.type=="message" and .message.role=="assistant") | .message.usage.cost.total // 0] | add // 0' "$1"; }
declare -A FIRST
for x in "${FILES[@]}"; do FIRST[$x]="$(first_user "$x")"; done
printf "arm\tcond\ttools\tasks\tfirstAsk\tleakCalls\tcostB\taskCost\tout\n"
while IFS=$'\t' read -r arm cond dir; do
  f=""; for x in "${FILES[@]}"; do case "${FIRST[$x]}" in "请先阅读 $dir/task.md"*) f=$x; break;; esac; done
  [ -z "$f" ] && { printf "%s\t%s\t(no B session)\n" "$arm" "$cond"; continue; }
  args=$(jq -r 'select(.type=="message" and .message.role=="assistant") | .message.content[]? | select(.type=="toolCall") | (.name + " " + (.arguments|tostring))' "$f")
  n=$(printf "%s\n" "$args" | grep -c .)
  na=$(printf "%s\n" "$args" | grep -c '^Agent ')
  fa=$(printf "%s\n" "$args" | grep -n '^Agent ' | head -1 | cut -d: -f1)
  lk=$(printf "%s\n" "$args" | grep -E 'fv2_private|\.pi/agent/(agents|sessions|memory)|exp[34]_' | grep -v "$dir" | grep -c . )
  lk2=$(printf "%s\n" "$args" | grep -oE '/tmp/w[0-9a-f]{10}' | grep -vc "^$dir$")
  # 请教成本：B 调用的每个专家会话（首条 user = B 的问题）
  askc=0
  while IFS= read -r q; do
    [ -z "$q" ] && continue
    for x in "${FILES[@]}"; do [ "${FIRST[$x]:0:60}" = "${q:0:60}" ] && [ "$x" != "$f" ] && { askc=$(echo "$askc + $(cost_of "$x")" | bc -l); break; }; done
  done < <(jq -r 'select(.type=="message" and .message.role=="assistant") | .message.content[]? | select(.type=="toolCall" and .name=="Agent") | .arguments.prompt | split("\n")[0]' "$f")
  printf "%s\t%s\t%s\t%s\t%s\t%s\t%.3f\t%.3f\t%s\n" "$arm" "$cond" "$n" "$na" "${fa:--}" "$((lk+lk2))" "$(cost_of "$f")" "$askc" "$([ -f "$dir/out.md" ] && echo ✓ || echo ✗)"
done < <(sort "$1")
