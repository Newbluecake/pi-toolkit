#!/usr/bin/env node
/**
 * 实验 3 取数：每臂的 B 会话 → 请教次数/问题、成本、工具调用、泄漏检查。
 * usage: node scripts/exp/exp3-analyze.mjs <armmap.tsv>
 * armmap 每行：arm \t cond \t dir（B 写 <dir>/out.md）
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const SESS = `${process.env.HOME}/.pi/agent/sessions/--home-bluecake-ai-pi-toolkit--`;
const map = readFileSync(process.argv[2], "utf8")
  .trim()
  .split("\n")
  .map((l) => l.split("\t"))
  .sort();

const recent = readdirSync(SESS)
  .filter((f) => f.endsWith(".jsonl"))
  .map((f) => join(SESS, f))
  .filter((f) => Date.now() - statSync(f).mtimeMs < 3 * 3600_000);

const load = (file) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);

const calls = (entries) =>
  entries
    .filter((e) => e.type === "message" && e.message?.role === "assistant")
    .flatMap((e) => (e.message.content ?? []).filter((p) => p?.type === "toolCall"));

const rows = [];
const questions = {};
for (const [arm, cond, dir] of map) {
  const out = `${dir}/out.md`;
  // B = 真正写过 out.md 的会话（主进程只在 Agent 参数里"提到"它，不算）
  const hit = recent.find((f) =>
    calls(load(f)).some(
      (c) => ["write", "edit", "bash"].includes(c.name) && JSON.stringify(c.arguments ?? {}).includes(out),
    ),
  );
  if (!hit) {
    rows.push({ arm, cond, error: existsSync(out) ? "session not found" : "no out.md" });
    continue;
  }
  const entries = load(hit);
  const cs = calls(entries);
  const asks = cs.filter((c) => c.name === "Agent");
  questions[arm] = asks.map(
    (c) => `[${c.arguments?.subagent_type}] ${String(c.arguments?.prompt ?? "").slice(0, 400)}`,
  );
  const assistant = entries.filter((e) => e.type === "message" && e.message?.role === "assistant");
  const cost = assistant.reduce((s, e) => s + (e.message.usage?.cost?.total ?? 0), 0);
  // 请教的成本：Agent 工具结果 details 里若带 usage 就累加
  const askCost = entries
    .filter((e) => e.type === "message" && e.message?.role === "toolResult" && e.message?.toolName === "Agent")
    .reduce((s, e) => s + (e.message.details?.usage?.cost ?? e.message.details?.cost ?? 0), 0);
  // 泄漏：碰了 ~/.pi（类型文件/旧会话）、私有目录、别的臂的目录
  const leaks = new Set();
  for (const c of cs) {
    const a = JSON.stringify(c.arguments ?? {});
    for (const m of a.matchAll(/\/tmp\/w[0-9a-f]{10}/g)) if (m[0] !== dir) leaks.add(m[0]);
    if (/\.pi\/agent|fv2_private|exp3_in|exp3_decisions|fabric-v2/.test(a))
      leaks.add(a.match(/[^"]*(\.pi\/agent|fv2_private|exp3_in|exp3_decisions|fabric-v2)[^"]*/)?.[0]?.slice(0, 80));
  }
  const doc = existsSync(out) ? readFileSync(out, "utf8") : "";
  rows.push({
    arm,
    cond,
    asks: asks.length,
    turns: assistant.length,
    tools: cs.length,
    costB: +cost.toFixed(3),
    askCost: +askCost.toFixed(3),
    docLines: doc ? doc.split("\n").length : 0,
    leaks: [...leaks].join(" | ") || "-",
  });
}
console.table(rows);
for (const [arm, qs] of Object.entries(questions))
  if (qs.length) console.log(`\n## ${arm} 的请教\n- ${qs.join("\n- ")}`);
