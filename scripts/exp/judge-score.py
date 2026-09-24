#!/usr/bin/env python3
import json, glob, os, re, io, statistics, sys, time
# usage: judge-score.py [map.tsv] [prompt-marker]
MAP = sys.argv[1] if len(sys.argv) > 1 else "/tmp/.fv2_private/judge-map.tsv"
MARK = sys.argv[2] if len(sys.argv) > 2 else "/tmp/judge/"
SESS = os.path.expanduser("~/.pi/agent/sessions/--home-bluecake-ai-pi-toolkit--")
idmap = {l.split("\t")[0]: (l.split("\t")[1], l.split("\t")[2].strip()) for l in io.open(MAP, encoding="utf-8") if l.strip()}
def load(f):
    out=[]
    for l in io.open(f, encoding="utf-8"):
        try: out.append(json.loads(l))
        except Exception: pass
    return out
judges = {}
for f in sorted(glob.glob(SESS + "/*.jsonl"), key=os.path.getmtime)[-40:]:
    es = load(f)
    model = next((e.get("modelId") for e in es if e.get("type") == "model_change"), None)
    users = [e for e in es if e.get("type") == "message" and e["message"].get("role") == "user"]
    if not users: continue
    c = users[0]["message"]["content"]
    first = c if isinstance(c, str) else "".join(p.get("text", "") for p in c if p.get("type") == "text")
    if not first.startswith("你是一名严格的评审") or MARK not in first: continue
    texts = [p["text"] for e in es if e.get("type") == "message" and e["message"].get("role") == "assistant" for p in e["message"].get("content", []) if p.get("type") == "text"]
    blocks = re.findall(r"```json\s*(\{.*?\})\s*```", "\n".join(texts), re.S)
    if blocks: judges[model] = json.loads(blocks[-1])
print("judges:", list(judges))
D = [f"D{i}" for i in range(1, 8)]
def score(v): return 1 if str(v[0] if isinstance(v, list) else v).startswith("遵守") else 0
def verdict(v): return str(v[0] if isinstance(v, list) else v)[:2]
rows = {}
agree = total = 0
for doc, (arm, cond) in sorted(idmap.items(), key=lambda x: x[1]):
    per = {}
    for m, j in judges.items():
        per[m] = {d: j.get(doc, {}).get(d, ["未涉及"]) for d in D}
    s = [sum(score(per[m][d]) for d in D) for m in per]
    viol = [sum(verdict(per[m][d]) == "违反" for d in D) for m in per]
    if len(per) == 2:
        a, b = per.values()
        for d in D:
            total += 1; agree += verdict(a[d]) == verdict(b[d])
    detail = " ".join(d + ":" + "/".join({"遵守": "✓", "违反": "✗", "未涉": "·"}.get(verdict(per[m][d]), "?") for m in per) for d in D)
    rows[arm] = (cond, s, viol, statistics.mean(s) if s else 0, detail)
    print(f"{arm:6} {cond}  scores={s} mean={statistics.mean(s) if s else 0:.1f} violations={viol}  {detail}")
print(f"\ninter-judge agreement: {agree}/{total} = {agree/total:.0%}" if total else "")
for c in ["c0", "c1", "c2", "c3", "e1"]:
    ms = [r[3] for r in rows.values() if r[0] == c]
    vs = [statistics.mean(r[2]) for r in rows.values() if r[0] == c]
    if ms: print(f"{c}: mean score {statistics.mean(ms):.2f}  (runs {', '.join(f'{x:.1f}' for x in ms)})  mean violations {statistics.mean(vs):.1f}")
