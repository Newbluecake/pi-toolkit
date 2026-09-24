#!/usr/bin/env python3
"""实验 5 取数：B 会话 ↔ 专家（resume）会话配对，统计请教、越界、成本，并导出请教问答。

usage: exp5-analyze.py <armmap.tsv> <sessions-dir> <qa-out.md>
"""
import glob
import io
import json
import os
import re
import sys

armmap, sess_dir, qa_out = sys.argv[1:4]
SNAP = "/tmp/exp5-repo"


def load(f):
    out = []
    for line in io.open(f, encoding="utf-8"):
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


def text_of(content):
    if isinstance(content, str):
        return content
    return "".join(p.get("text", "") for p in content or [] if p.get("type") == "text")


def msgs(es, role):
    return [e for e in es if e.get("type") == "message" and e["message"].get("role") == role]


def cost(entries):
    return sum((e["message"].get("usage") or {}).get("cost", {}).get("total", 0) for e in entries)


sessions = {f: load(f) for f in glob.glob(os.path.join(sess_dir, "*.jsonl"))}
first_user = {f: text_of(msgs(es, "user")[0]["message"]["content"]) if msgs(es, "user") else "" for f, es in sessions.items()}
experts = [f for f, u in first_user.items() if u.startswith("请阅读 /tmp/.p5x/brief-A.md")]

rows, qa = [], []
for line in io.open(armmap, encoding="utf-8"):
    if not line.strip():
        continue
    arm, cond, d = line.rstrip("\n").split("\t")
    b = next((f for f, u in first_user.items() if u.startswith(f"请先阅读 {d}/task.md")), None)
    if not b:
        rows.append((arm, "no B session"))
        continue
    es = sessions[b]
    calls = [p for e in msgs(es, "assistant") for p in e["message"].get("content", []) if p.get("type") == "toolCall"]
    asks = [c for c in calls if c.get("name") == "Agent"]
    first_ask = next((i + 1 for i, c in enumerate(calls) if c.get("name") == "Agent"), None)
    used_resume = sum(1 for c in asks if (c.get("arguments") or {}).get("resume"))
    # 越界：任何绝对路径既不在快照内、也不在本臂任务目录内
    leaks = []
    for c in calls:
        a = json.dumps(c.get("arguments") or {}, ensure_ascii=False)
        for m in re.findall(r"(?:/tmp/[\w.\-/]+|/home/bluecake/[\w.\-/]+|~/\.pi[\w.\-/]*)", a):
            if not (m.startswith(SNAP) or m.startswith(d)):
                leaks.append(m[:70])
    # 配对专家：其会话里出现了 B 的第一个请教问题
    q0 = (asks[0].get("arguments") or {}).get("prompt", "") if asks else ""
    ex = next((f for f in experts if q0 and any(text_of(u["message"]["content"]).strip() == q0.strip() for u in msgs(sessions[f], "user"))), None)
    task_cost = consult_cost = 0.0
    consult_tools = 0
    if ex:
        ees = sessions[ex]
        users = [i for i, e in enumerate(ees) if e.get("type") == "message" and e["message"].get("role") == "user"]
        cut = users[1] if len(users) > 1 else len(ees)
        task_cost = cost([e for e in ees[:cut] if e.get("type") == "message" and e["message"].get("role") == "assistant"])
        after = [e for e in ees[cut:] if e.get("type") == "message" and e["message"].get("role") == "assistant"]
        consult_cost = cost(after)
        consult_tools = sum(1 for e in after for p in e["message"].get("content", []) if p.get("type") == "toolCall")
    # 导出问答（B 的问题 + 专家经工具结果返回的回答）
    results = {e["message"].get("toolCallId"): text_of(e["message"].get("content")) for e in msgs(es, "toolResult")}
    for c in asks:
        qa.append(f"## {arm} — Q\n\n{(c.get('arguments') or {}).get('prompt', '')}\n\n## {arm} — A\n\n{results.get(c.get('id'), '(no result)')}\n")
    out = os.path.join(d, "out.md")
    rows.append(
        (
            arm,
            f"tools={len(calls)} asks={len(asks)} (resume={used_resume}) firstAsk@{first_ask or '-'} "
            f"leaks={len(leaks)} costB={cost(msgs(es, 'assistant')):.3f} expertTask={task_cost:.3f} "
            f"consult={consult_cost:.3f} (expertToolsDuringConsult={consult_tools}) out={'✓' if os.path.exists(out) else '✗'}"
            + (f"\n        leaks: {sorted(set(leaks))[:6]}" if leaks else ""),
        )
    )

for arm, r in rows:
    print(f"{arm:6} {r}")
io.open(qa_out, "w", encoding="utf-8").write("\n".join(qa))
print(f"\nQ&A exported: {qa_out} ({len(qa)} exchanges)")
