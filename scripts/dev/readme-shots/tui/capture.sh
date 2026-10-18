#!/bin/bash
# TUI capture: regenerate the synthetic session, launch pi in tmux, answer the trust prompt, dump + scrub ANSI.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
export REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
OUT="${README_SHOTS_DIR:-$HOME/readme-shots}"; S="$OUT/tui"
mkdir -p "$S"; "$HERE/setup.sh" "$S"
tmux kill-session -t pidemo 2>/dev/null || true; sleep 2
CWD="$S/home/projects/acme-api" OUT_FILE="$S/session.jsonl" node "$HERE/make-session.mjs"
tmux new-session -d -s pidemo -x 140 -y 36 \
  "cd $S/home/projects/acme-api && HOME=$S/home PI_CODING_AGENT_DIR=$S/agent COLORTERM=truecolor TERM=xterm-256color pi --session $S/session.jsonl -e $HERE/demo-ext.ts --offline --no-skills --no-prompt-templates; read"
for i in $(seq 1 40); do tmux capture-pane -p -t pidemo | grep -q "Trust project folder" && break; sleep 1; done
sleep 1; tmux send-keys -t pidemo Down Down Enter
sleep 10
tmux capture-pane -ep -t pidemo > "$S/shot.ansi"
tmux kill-session -t pidemo
python3 - "$S/shot.ansi" <<'PY'
import re, sys
p = sys.argv[1]; L = open(p).read().split("\n"); out = []; skip = False
for l in L:
    if "[pi-subagent]" in l: skip = True; continue          # quota-credential warnings from the sandbox
    if skip and l.strip() == "": skip = False; continue
    skip = False
    # freeze the toolkit chip: drop commit hash / dirty marker / real commit time
    if "toolkit " in l:
        l = re.sub(r"(v0\.6\.0)@[0-9a-f]{7,}\*?", r"\1", l)
        l = re.sub(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}", "2026-10-18 10:30", l)
    out.append(l)
while out and out[0].strip() == "": out.pop(0)
open(p, "w").write("\n".join(out))
PY
grep -aq "2026-10-18 10:30" "$S/shot.ansi" || { echo "WARN: toolkit chip not frozen — check HUD format" >&2; }
