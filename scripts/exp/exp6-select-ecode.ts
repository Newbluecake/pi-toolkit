#!/usr/bin/env node
/**
 * Experiment 6 — E-code expert selection (README §3.3), run after Part A and
 * before Part B. Reads part-a.tsv, applies the pre-registered filters and
 * prints every candidate with the reason it passed / failed.
 *
 *   npx tsx scripts/exp/exp6-select-ecode.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadContext, readJsonl } from "./exp6-lib.js";

const TYPES = new Set(["Explore", "verifier", "reviewer", "general"]);
const tsv = readFileSync("docs/dev/consult/exp-trim/part-a.tsv", "utf8").trim().split("\n");
const head = tsv[0]!.split("\t");
const rows = tsv.slice(1).map((l) => Object.fromEntries(l.split("\t").map((v, i) => [head[i]!, v])));
const models = JSON.parse(readFileSync(join(homedir(), ".pi/agent/models.json"), "utf8"));

function price(model: string): { input: number; cacheWrite: number; output: number } | undefined {
  const [prov0, ...rest] = model.split("/");
  const prov = prov0!.replace(/^cloudrouter-/, "cr-");
  const m = models.providers?.[prov]?.models?.find((x: any) => x.id === rest.join("/"));
  return m?.cost;
}

function findFile(name: string): string | undefined {
  const out = execFileSync("find", [join(homedir(), ".pi/agent/sessions"), "-name", name], { encoding: "utf8" }).trim();
  return out.split("\n")[0] || undefined;
}

const results: Record<string, unknown>[] = [];
for (const r of rows) {
  const why: string[] = [];
  if (!TYPES.has(r.agentType!)) continue;
  const ctx = Number(r.ctxTokens);
  if (ctx < 40_000 || ctx > 150_000) why.push(`ctx ${ctx}`);
  if (Number(r.T1_pctMsgs) < 40) why.push(`T1msgs ${r.T1_pctMsgs}%`);
  const file = findFile(r.session!)!;
  const entries = readJsonl(file);
  const header = entries.find((e) => e.type === "session");
  const cwd: string = header?.cwd ?? "?";
  const endIso: string = entries.at(-1)?.timestamp ?? "";
  const { messages } = loadContext(file);
  const reads = new Set<string>();
  for (const m of messages)
    if (m.role === "assistant")
      for (const b of m.content ?? [])
        if (b.type === "toolCall" && b.name === "read" && typeof b.arguments?.path === "string")
          reads.add(b.arguments.path);
  const changed: string[] = [];
  let repo: string | undefined;
  try {
    repo = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    why.push("cwd not a git repo / missing");
  }
  if (repo) {
    for (const p of reads) {
      const abs = p.startsWith("/") ? p : join(cwd, p);
      if (!abs.startsWith(repo + "/")) continue;
      if (!existsSync(abs)) {
        changed.push(`${abs} (gone)`);
        continue;
      }
      const rel = abs.slice(repo.length + 1);
      const log = execFileSync("git", ["-C", repo, "log", `--since=${endIso}`, "--format=%h", "--", rel], {
        encoding: "utf8",
      }).trim();
      const st = execFileSync("git", ["-C", repo, "status", "--porcelain", "--", rel], { encoding: "utf8" }).trim();
      if (log || st) changed.push(rel);
    }
    if (changed.length) why.push(`${changed.length}/${reads.size} read files changed`);
  }
  const pr = price(r.model!);
  const est = pr ? ((ctx * 1.6 * (pr.cacheWrite || pr.input)) / 1e6 + (3000 * pr.output) / 1e6) * 6 : NaN;
  if (!(est <= 5)) why.push(`est6=$${est.toFixed(2)}`);
  const firstUser = messages.find((m) => m.role === "user");
  const task =
    typeof firstUser?.content === "string"
      ? firstUser.content
      : (firstUser?.content ?? []).map((b: any) => b.text ?? "").join("");
  results.push({
    session: r.session,
    type: r.agentType,
    model: r.model,
    ctx,
    T1msgs: r.T1_pctMsgs,
    cwd,
    reads: reads.size,
    changed: changed.slice(0, 6),
    est6: Number(est.toFixed(2)),
    pass: why.length === 0,
    why,
    file,
    task: task.replace(/\s+/g, " ").slice(0, 200),
  });
}
results.sort((a, b) => Number(b.T1msgs) - Number(a.T1msgs));
writeFileSync("/tmp/exp6-ecode-candidates.json", JSON.stringify(results, null, 2));
for (const x of results) console.log(JSON.stringify(x));
