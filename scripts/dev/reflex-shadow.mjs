#!/usr/bin/env node
/** R3b Tier 3: offline, read-only shadow report. No network, settings changes or file writes. */
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

function parseArgs(args) {
  const options = { days: 14, cwd: undefined, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--days" || arg === "--cwd") {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} 缺少参数`);
      if (arg === "--cwd") options.cwd = resolve(value);
      else {
        options.days = Number(value);
        if (!Number.isFinite(options.days) || options.days <= 0 || !Number.isFinite(options.days * 86_400_000))
          throw new Error("--days 必须为可表示的正数");
      }
    } else throw new Error(`未知参数：${arg}；用法：--days 14 [--cwd <path>] [--json]`);
  }
  return options;
}

/** Follow directories, never symlinks; a missing session root means an empty report. */
async function* sessionFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sessionFiles(path);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield path;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let extractReflexRows, accumulate, countCrossSessionRepeats, msPercentiles, evaluatePromotion;
  try {
    ({ extractReflexRows } = await import("../../dist/reflex/core/shadow-scan.js"));
    ({ accumulate, countCrossSessionRepeats, msPercentiles, evaluatePromotion } =
      await import("../../dist/reflex/core/promotion.js"));
  } catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND") {
      console.log("缺少 dist：先 npm run build");
      process.exitCode = 2;
      return;
    }
    throw error;
  }
  const root = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "sessions");
  // Mirror pi's public getDefaultSessionDir encoding without importing pi (PD3/PD10).
  const scanRoot =
    options.cwd === undefined ? root : join(root, `--${options.cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
  const now = Date.now();
  const since = now - options.days * 86_400_000;
  const stats = new Map();
  const samples = new Map();
  const occurrences = [];
  const divergeSamples = new Map();
  let files = 0,
    rows = 0,
    invalidTimestamps = 0;
  for await (const file of sessionFiles(scanRoot)) {
    files++;
    const input = createReadStream(file, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    // Propagate stream errors instead of producing potentially eligible partial reports.
    let readError;
    input.on("error", (error) => {
      readError = error;
      lines.close();
    });
    try {
      for await (const line of lines) {
        const row = extractReflexRows(line);
        if (row === undefined) continue;
        const entry = JSON.parse(line);
        // AUTO details have no `at`; use the persisted session-entry timestamp.
        const at = row.kind === "answer" ? Date.parse(entry.timestamp) : row.kind === "record" ? row.rec.at : row.c.at;
        if (!Number.isFinite(at)) {
          invalidTimestamps++;
          continue;
        }
        if (at < since || at > now) continue;
        accumulate(stats, row);
        rows++;
        if (row.kind === "correction") continue;
        const data = row.kind === "record" ? row.rec : row.details;
        const key = `${data.scriptId}@${data.scriptVer}`;
        // Promotion candidates (shadow) and AUTO answers both feed the frozen repeat helper.
        // AUTO repeat records already count via accumulate.reasked; corrections are independent.
        if (row.kind === "answer" || data.kind === "shadow")
          occurrences.push({ session: file, at, key, digest: data.requestDigest });
        const ms = row.kind === "answer" ? data.ms : data.kind === "shadow" ? data.port?.ms : undefined;
        if (ms !== undefined) {
          const buffer = samples.get(key) ?? [];
          buffer.push(ms);
          samples.set(key, buffer);
        }
        if (row.kind === "record" && data.model?.agree === "diverge") {
          const refs = divergeSamples.get(key) ?? [];
          refs.push({ sessionFile: file, entryId: typeof entry.id === "string" ? entry.id : null });
          divergeSamples.set(key, refs);
        }
      }
      if (readError) throw readError;
    } finally {
      lines.close();
      input.destroy();
    }
  }
  const repeats = countCrossSessionRepeats(occurrences);
  const scripts = [...stats.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, s]) => {
      // Missing AUTO timestamps could hide repeat evidence: fail closed on promotion.
      s.crossSessionRepeats = invalidTimestamps > 0 ? undefined : repeats.get(key);
      const percentiles = msPercentiles(samples.get(key) ?? []);
      if (percentiles.p50 !== undefined) s.p50ms = percentiles.p50;
      if (percentiles.p95 !== undefined) s.p95ms = percentiles.p95;
      return {
        key,
        ...s,
        crossSessionRepeats: s.crossSessionRepeats ?? null,
        okRate: s.portRuns > 0 ? s.portOk / s.portRuns : null,
        divergeRate: s.judged > 0 ? s.diverge / s.judged : null,
        ...evaluatePromotion(s),
        divergeSamples: divergeSamples.get(key) ?? [],
      };
    });
  const report = {
    sessionRoot: root,
    scanRoot,
    days: options.days,
    since,
    until: now,
    files,
    rows,
    invalidTimestamps,
    scripts,
  };
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(
      `reflex shadow · days=${options.days} files=${files} rows=${rows} invalidTimestamps=${invalidTimestamps}`,
    );
    console.log(`sessions: ${scanRoot}`);
    if (scripts.length === 0) console.log("无 reflex 记录（空结果）；尚无晋升依据。");
    const rate = (value) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
    for (const s of scripts) {
      console.log(
        `${s.key} cand=${s.candidates} portRuns=${s.portRuns} ok=${s.portOk} okRate=${rate(s.okRate)} unavailable=${s.unavailable} judged=${s.judged} agree=${s.agree} noTool=${s.noTool} diverge=${s.diverge} unknown=${s.unknown} divergeRate=${rate(s.divergeRate)} answered=${s.answered} fallback=${s.fallback} repeat=${s.repeat} reasked=${s.reasked} crossSessionRepeats=${s.crossSessionRepeats ?? "undetermined"} corrected=${s.corrected} p50=${s.p50ms ?? "n/a"}ms p95=${s.p95ms ?? "n/a"}ms · ${s.eligible ? "eligible" : "not eligible"} · ${s.eligible ? "达到统计门槛；仍需用户人工抽查后改设置" : s.reasons.join("；")}`,
      );
      for (const ref of s.divergeSamples)
        console.log(`  diverge: ${ref.sessionFile} entry=${ref.entryId ?? "unknown"}`);
    }
    console.log("仅供离线判定，不自动晋升；eligible 仍需人工抽查 diverge，且仅由用户修改 reflex.autoResolve。");
  }
}

main().catch((error) => {
  console.log(`reflex shadow 失败：${error.message}`);
  process.exitCode = 1;
});
