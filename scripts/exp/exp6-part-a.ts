#!/usr/bin/env node
/**
 * Experiment 6 Part A — offline trim estimate (zero LLM calls).
 * docs/dev/consult/exp-trim/README.md §2.
 *
 *   npx tsx scripts/exp/exp6-part-a.ts [--out docs/dev/consult/exp-trim]
 *
 * Writes part-a.tsv, part-a-summary.json and part-a-candidates.json (every
 * subagent session considered + exclusion reason, for auditing selection).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  applyToMessages,
  calibrate,
  loadContext,
  messageChars,
  promptTokens,
  quantile,
  sumChars,
  planTrim,
  QUESTION_TOKENS,
  OPUS,
  type Rule,
  type AnyMsg,
} from "./exp6-lib.js";

const SESSIONS = join(homedir(), ".pi/agent/sessions");
const CONSULT_DIR = join(homedir(), ".pi/agent/cache/consult-sessions");
const outIdx = process.argv.indexOf("--out");
const OUT = resolve(outIdx > 0 ? process.argv[outIdx + 1]! : "docs/dev/consult/exp-trim");
const MAX_PER_TYPE = 5;
const MIN_CTX = 30_000;
const MAX_CTX = 300_000;

interface RunRec {
  sessionFile: string;
  referencedFrom: string;
  agentType: string;
  status: string;
  label?: string;
  model?: string;
  lastEventAt: number;
}

function collectRuns(): Map<string, RunRec> {
  const raw = execFileSync("grep", ["-rH", "--include=*.jsonl", '"customType":"subagent:run"', SESSIONS], {
    maxBuffer: 1 << 30,
    encoding: "utf8",
  });
  const out = new Map<string, RunRec>();
  for (const line of raw.split("\n")) {
    const cut = line.indexOf(".jsonl:");
    if (cut < 0) continue;
    const from = line.slice(0, cut + 6);
    let e: AnyMsg;
    try {
      e = JSON.parse(line.slice(cut + 7));
    } catch {
      continue;
    }
    const d = e.data;
    const sf: string | undefined = d?.diag?.sessionFile;
    if (!sf) continue;
    const rec: RunRec = {
      sessionFile: sf,
      referencedFrom: from,
      agentType: d.diag.agentType ?? "?",
      status: d.status,
      label: d.diag.label,
      model: d.diag.model ? `${d.diag.model.provider}/${d.diag.model.id}` : undefined,
      lastEventAt: d.diag.lastEventAt ?? 0,
    };
    const prev = out.get(sf);
    if (!prev || rec.lastEventAt >= prev.lastEventAt) out.set(sf, rec);
  }
  return out;
}

function ctxBin(t: number): number {
  return t < 60_000 ? 0 : t < 120_000 ? 1 : 2;
}

interface Row {
  file: string;
  agentType: string;
  model: string;
  label: string;
  ctxTokens: number;
  r: number;
  overhead: number;
  withThinking: boolean;
  mape: number;
  mapeAlt: number;
  tok: Record<string, number>;
  full: number;
  saved: Record<Rule, { tokens: number; pct: number; pctMsgs: number; usd: number; elided: number }>;
}

function analyse(file: string, rec: RunRec, messages: AnyMsg[]): Row | { error: string } {
  const cal = calibrate(messages);
  if (!cal.ok) return { error: `calibration: ${cal.reason}` };
  const r = cal.r;
  const cat = { user: 0, assistantText: 0, thinking: 0, toolCall: 0, toolResult: 0 };
  for (const m of messages) {
    const c = messageChars(m);
    for (const k of Object.keys(cat) as (keyof typeof cat)[]) cat[k] += c[k];
  }
  const tok: Record<string, number> = {};
  for (const [k, v] of Object.entries(cat))
    tok[k] = Math.round(v * r * (k === "thinking" && !cal.withThinking ? 0 : 1));
  const msgTokens = sumChars(messages, cal.withThinking) * r;
  const full = cal.overhead + msgTokens + QUESTION_TOKENS;
  const saved = {} as Row["saved"];
  for (const rule of ["T1", "T2", "T3"] as Rule[]) {
    const plan = planTrim(messages, rule, r);
    const trimmedMsgs = sumChars(applyToMessages(messages, plan), cal.withThinking) * r;
    const s = msgTokens - trimmedMsgs;
    saved[rule] = {
      tokens: Math.round(s),
      pct: s / full,
      pctMsgs: s / msgTokens,
      usd: (s / 1e6) * OPUS.cacheWrite,
      elided: plan.elidedToolResults,
    };
  }
  const model = messages.filter((m) => m.role === "assistant").at(-1);
  return {
    file,
    agentType: rec.agentType,
    model: model ? `${model.provider}/${model.model}` : (rec.model ?? "?"),
    label: rec.label ?? "",
    ctxTokens: cal.pLast,
    r,
    overhead: Math.round(cal.overhead),
    withThinking: cal.withThinking,
    mape: cal.mape,
    mapeAlt: cal.mapeAlt,
    tok,
    full: Math.round(full),
    saved,
  };
}

function main(): void {
  mkdirSync(OUT, { recursive: true });
  const runs = collectRuns();
  const referencedFiles = new Set<string>();
  for (const r of runs.values()) referencedFiles.add(r.referencedFrom);
  type Cand = { rec: RunRec; ctx: number; messages: AnyMsg[] };
  const audit: Record<string, unknown>[] = [];
  const byType = new Map<string, Cand[]>();
  for (const rec of [...runs.values()].sort((a, b) => a.sessionFile.localeCompare(b.sessionFile))) {
    const f = rec.sessionFile;
    const reason = (why: string) => audit.push({ file: f, type: rec.agentType, status: rec.status, excluded: why });
    if (rec.status !== "completed") {
      reason(`status=${rec.status}`);
      continue;
    }
    if (f.startsWith(CONSULT_DIR)) {
      reason("consult fork");
      continue;
    }
    if (rec.referencedFrom === f) {
      reason("self-referenced (main session)");
      continue;
    }
    if (!existsSync(f)) {
      reason("missing file");
      continue;
    }
    let loaded;
    try {
      loaded = loadContext(f);
    } catch (e) {
      reason(`load error ${(e as Error).message}`);
      continue;
    }
    if (loaded.entries.some((e) => e.type === "compaction")) {
      reason("has compaction");
      continue;
    }
    const last = loaded.messages.filter((m) => m.role === "assistant" && promptTokens(m) !== undefined).at(-1);
    const ctx = last ? promptTokens(last)! : 0;
    if (ctx < MIN_CTX || ctx > MAX_CTX) {
      reason(`ctx=${ctx} out of range`);
      continue;
    }
    audit.push({ file: f, type: rec.agentType, status: rec.status, ctx, excluded: null });
    const list = byType.get(rec.agentType) ?? [];
    list.push({ rec, ctx, messages: loaded.messages });
    byType.set(rec.agentType, list);
  }
  const rows: Row[] = [];
  const skipped: Record<string, unknown>[] = [];
  for (const [type, list] of [...byType.entries()].sort()) {
    const bins: Cand[][] = [[], [], []];
    for (const c of list) bins[ctxBin(c.ctx)]!.push(c);
    let taken = 0;
    const cursors = [0, 0, 0];
    while (taken < MAX_PER_TYPE && bins.some((b, i) => cursors[i]! < b.length)) {
      for (let i = 0; i < 3 && taken < MAX_PER_TYPE; i++) {
        const c = bins[i]![cursors[i]!];
        if (!c) continue;
        cursors[i]!++;
        const res = analyse(c.rec.sessionFile, c.rec, c.messages);
        if ("error" in res) {
          skipped.push({ file: c.rec.sessionFile, type, error: res.error });
          continue;
        }
        rows.push(res);
        taken++;
      }
    }
  }
  const header = [
    "session",
    "agentType",
    "model",
    "ctxTokens",
    "r_tok_per_char",
    "overheadTok",
    "thinkingResent",
    "calibMdAPE",
    "userTok",
    "assistantTextTok",
    "thinkingTok",
    "toolCallTok",
    "toolResultTok",
    "firstReqTok",
    "T1_pct",
    "T1_pctMsgs",
    "T1_usd",
    "T1_elided",
    "T2_pct",
    "T2_pctMsgs",
    "T2_usd",
    "T2_elided",
    "T3_pct",
    "T3_usd",
    "label",
  ];
  const lines = [header.join("\t")];
  for (const r of rows)
    lines.push(
      [
        basename(r.file),
        r.agentType,
        r.model,
        r.ctxTokens,
        r.r.toFixed(3),
        r.overhead,
        r.withThinking ? "yes" : "no",
        Number.isNaN(r.mape) ? "" : r.mape.toFixed(3),
        r.tok.user,
        r.tok.assistantText,
        r.tok.thinking,
        r.tok.toolCall,
        r.tok.toolResult,
        r.full,
        (r.saved.T1.pct * 100).toFixed(1),
        (r.saved.T1.pctMsgs * 100).toFixed(1),
        r.saved.T1.usd.toFixed(3),
        r.saved.T1.elided,
        (r.saved.T2.pct * 100).toFixed(1),
        (r.saved.T2.pctMsgs * 100).toFixed(1),
        r.saved.T2.usd.toFixed(3),
        r.saved.T2.elided,
        (r.saved.T3.pct * 100).toFixed(1),
        r.saved.T3.usd.toFixed(3),
        r.label.replace(/\s+/g, " ").slice(0, 60),
      ].join("\t"),
    );
  writeFileSync(join(OUT, "part-a.tsv"), lines.join("\n") + "\n");
  const agg = (rule: Rule) => {
    const p = rows.map((r) => r.saved[rule].pct);
    const u = rows.map((r) => r.saved[rule].usd);
    const pm = rows.map((r) => r.saved[rule].pctMsgs);
    return {
      medianPct: quantile(p, 0.5),
      p90Pct: quantile(p, 0.9),
      p10Pct: quantile(p, 0.1),
      medianPctMsgs: quantile(pm, 0.5),
      medianUsd: quantile(u, 0.5),
      p90Usd: quantile(u, 0.9),
      meanUsd: u.reduce((a, b) => a + b, 0) / u.length,
    };
  };
  const toolShare = rows.map((r) => r.tok.toolResult! / (r.full - QUESTION_TOKENS));
  const summary = {
    n: rows.length,
    types: [...new Set(rows.map((r) => r.agentType))],
    ctx: {
      min: Math.min(...rows.map((r) => r.ctxTokens)),
      median: quantile(
        rows.map((r) => r.ctxTokens),
        0.5,
      ),
      max: Math.max(...rows.map((r) => r.ctxTokens)),
    },
    toolResultShareMedian: quantile(toolShare, 0.5),
    calibMdAPEMedian: quantile(
      rows.map((r) => r.mape).filter((x) => !Number.isNaN(x)),
      0.5,
    ),
    T1: agg("T1"),
    T2: agg("T2"),
    T3: agg("T3"),
    byType: Object.fromEntries(
      [...new Set(rows.map((r) => r.agentType))].sort().map((t) => {
        const g = rows.filter((r) => r.agentType === t);
        return [
          t,
          {
            n: g.length,
            ctxMedian: quantile(
              g.map((r) => r.ctxTokens),
              0.5,
            ),
            T1medianPct: quantile(
              g.map((r) => r.saved.T1.pct),
              0.5,
            ),
            T2medianPct: quantile(
              g.map((r) => r.saved.T2.pct),
              0.5,
            ),
            T3medianPct: quantile(
              g.map((r) => r.saved.T3.pct),
              0.5,
            ),
          },
        ];
      }),
    ),
    byCtxBin: Object.fromEntries(
      (["30-60k", "60-120k", "120-300k"] as const).map((name, i) => {
        const g = rows.filter((r) => ctxBin(r.ctxTokens) === i);
        return [
          name,
          {
            n: g.length,
            T1medianPct: quantile(
              g.map((r) => r.saved.T1.pct),
              0.5,
            ),
            T1medianUsd: quantile(
              g.map((r) => r.saved.T1.usd),
              0.5,
            ),
          },
        ];
      }),
    ),
    candidatesConsidered: audit.length,
    eligible: audit.filter((a) => a.excluded === null).length,
    skippedCalibration: skipped,
  };
  writeFileSync(join(OUT, "part-a-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  writeFileSync("/tmp/exp6-parta-candidates.json", JSON.stringify(audit, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main();
