#!/usr/bin/env bash
set -euo pipefail
R=/home/bluecake/ai/pi-toolkit
rm -rf /tmp/judge5 && mkdir -p /tmp/judge5/docs
cp $R/docs/dev/fabric-v2/exp3/judge-rubric.md /tmp/judge5/rubric.md
: > /tmp/.p5x/judge5-map.tsv
add() { # arm cond src
  id=doc-$(echo -n "judge5-$1-pepper97" | sha1sum | cut -c1-6)
  sed -E -e 's#/tmp/exp5-repo#/home/bluecake/ai/pi-toolkit#g' \
         -e 's/domain-expert（前序参与者）/前序阶段/g; s/经 ?(domain-expert|upstream-expert) ?(两轮)?确认/前序阶段已定/g' \
         -e 's/(domain-expert|upstream-expert|upstream-analyst)/前序阶段/g' "$3" > /tmp/judge5/docs/$id.md
  printf "%s\t%s\t%s\n" "$id" "$1" "$2" >> /tmp/.p5x/judge5-map.tsv
}
for arm in c0-r1 c0-r2 c1-r1 c1-r2 c2-r1 c2-r2 c3-r1 c3-r2; do add "$arm" "${arm%%-*}" "$R/docs/dev/fabric-v2/exp4/$arm.md"; done
while IFS=$'\t' read -r arm cond dir; do [ "$arm" = e1-r2 ] && continue; add "$arm" e1 "$dir/out.md"; done < /tmp/.p5x/exp5-armmap.tsv
ls /tmp/judge5/docs | wc -l
grep -lE "domain-expert|upstream|exp5|/tmp/w[0-9a-f]|resume" /tmp/judge5/docs/*.md || echo "(no condition markers)"
