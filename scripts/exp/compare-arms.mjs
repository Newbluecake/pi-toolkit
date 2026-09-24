#!/usr/bin/env node
/**
 * baseline-experiment 批量对照表。
 *
 * 自动把每个实验臂的产出路径（如 a1-r2.md）映射回它的 session JSONL：
 * 扫最近的 session 文件，谁的工具调用里出现过该输出路径，谁就是那一臂。
 *
 * usage: node scripts/exp/compare-arms.mjs <A的session.jsonl> <arm1> <arm2> ...
 *   arm 形如 a0-r2 / a1-r3 / a1nd-r1（对应 /tmp/exp_out/<arm>.md）
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = "/home/bluecake/ai/pi-toolkit";
const SESS = `${process.env.HOME}/.pi/agent/sessions/--home-bluecake-ai-pi-toolkit--`;
const [aSession, ...arms] = process.argv.slice(2);
if (!aSession || arms.length === 0) {
  console.error("usage: compare-arms.mjs <A.jsonl> <arm> [arm...]");
  process.exit(2);
}

const recent = readdirSync(SESS)
  .filter((f) => f.endsWith(".jsonl"))
  .map((f) => ({ f: join(SESS, f), m: statSync(join(SESS, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m)
  .slice(0, 25);

const toolCalls = (file) => {
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e?.type !== "message" || e?.message?.role !== "assistant") continue;
    for (const p of e.message.content ?? []) {
      if (p?.type === "toolCall") out.push({ name: p.name, args: JSON.stringify(p.arguments ?? p.args ?? {}) });
    }
  }
  return out;
};

/**
 * 定位某一臂的 session。两道门缺一不可：
 *  ① 必须有 write/edit 类调用真正写了该输出路径（“提到”不算 —— 调度方的主会话 prompt 里
 *     也提到过每个臂的路径，只按“包含”匹配会把主会话认成每一臂，产出看似合理的垃圾表）；
 *  ② 排除任何调用过 `Agent` 工具的 session（只有主会话会派子 agent）。
 */
const findArmSession = (arm) => {
  const needle = `${process.env.EXP_OUT_DIR ?? "/tmp/exp_out"}/${arm}.md`;
  for (const r of recent) {
    const calls = toolCalls(r.f);
    if (calls.some((t) => t.name === "Agent")) continue; // 主会话
    const wrote = calls.some(
      (t) => (t.name === "write" || t.name === "edit" || t.name === "bash") && t.args.includes(needle),
    );
    if (wrote) return r;
  }
  return undefined;
};

const filesOf = (session) =>
  JSON.parse(
    execFileSync("node", [join(ROOT, "scripts/exp/extract-touched-files.mjs"), session, "--root", ROOT, "--json"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
  );

const aFiles = new Set(filesOf(aSession).files);
const rows = [];

for (const arm of arms) {
  const outDir = process.env.EXP_OUT_DIR ?? "/tmp/exp_out";
  const outPath = `${outDir}/${arm}.md`;
  const hit = findArmSession(arm);
  if (!hit) {
    rows.push({ arm, error: "session not found" });
    continue;
  }
  const ext = filesOf(hit.f);
  const calls = toolCalls(hit.f);
  const search = calls.filter((t) => t.name === "grep" || t.name === "find").length;
  const bashSearch = calls.filter((t) => t.name === "bash" && /\b(grep|rg|find)\b/.test(t.args)).length;
  const wander = ext.files.filter((f) => !aFiles.has(f));
  const overlap = ext.files.filter((f) => aFiles.has(f));
  const doc = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";
  rows.push({
    arm,
    session: hit.f.split("/").pop(),
    toolCalls: calls.length,
    "M1'_wander": wander.length,
    overlap: overlap.length,
    'M1"_search': search + bashSearch,
    "  (tool/bash)": `${search}/${bashSearch}`,
    docLines: doc ? doc.split("\n").length : 0,
    // 兼容 `path:123`、`path` 123、`path` L123 三种引用写法（首轮只认第一种，漏计为 0）
    citations: doc
      ? (doc.match(/(?:src|tests|docs)\/[a-zA-Z0-9_./-]+\.(?:ts|md)`?\s*(?::|L|\s)\s*[0-9]+/g) ?? []).length
      : 0,
    groped: ext.gropedMissing.length,
  });
}

console.log(`A(探索) 碰过文件数: ${aFiles.size}`);
console.table(rows);
