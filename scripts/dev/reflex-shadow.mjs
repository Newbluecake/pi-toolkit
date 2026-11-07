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
async function* sessionFiles(dir, allowMissing = false) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (allowMissing && error.code === "ENOENT") return;
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
  let scanReflexLine,
    accumulate,
    countCrossSessionRepeats,
    msPercentiles,
    buildLiveEvidence,
    evaluateMergedPromotion,
    createRowDeduper,
    BUILTIN_SCRIPTS,
    createPortRegistry;
  try {
    ({ scanReflexLine } = await import("../../dist/reflex/core/shadow-scan.js"));
    ({ accumulate, countCrossSessionRepeats, msPercentiles, buildLiveEvidence, evaluateMergedPromotion } =
      await import("../../dist/reflex/core/promotion.js"));
    ({ createRowDeduper } = await import("../../dist/reflex/core/shadow-dedupe.js"));
    ({ BUILTIN_SCRIPTS } = await import("../../dist/reflex/core/catalog.js"));
    ({ createPortRegistry } = await import("../../dist/reflex/ports/index.js"));
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
  const liveRows = [];
  const dedupe = createRowDeduper();
  let scanComplete = true;
  const scanErrors = [];
  const registry = createPortRegistry({
    bashJobs: () => undefined,
    fleet: () => undefined,
    quota: () => undefined,
    git: async () => {
      throw new Error("report never runs ports");
    },
  });
  const samples = new Map();
  const occurrences = [];
  const divergeSamples = new Map();
  let files = 0,
    rows = 0,
    invalidTimestamps = 0;
  try {
    for await (const file of sessionFiles(scanRoot, true)) {
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
          let entry;
          try {
            entry = JSON.parse(line);
          } catch {
            scanComplete = false;
            scanErrors.push({ file, reason: "invalid-json" });
            continue;
          }
          const { row, entryId } = scanReflexLine(line);
          if (row === undefined) {
            if (entry?.customType?.startsWith("subagent:reflex")) {
              scanComplete = false;
              scanErrors.push({ file, reason: "invalid-reflex-row" });
            }
            continue;
          }
          // AUTO details have no `at`; use the persisted session-entry timestamp.
          const at =
            row.kind === "answer" ? Date.parse(entry.timestamp) : row.kind === "record" ? row.rec.at : row.c.at;
          if (!Number.isFinite(at)) {
            invalidTimestamps++;
            scanComplete = false;
            continue;
          }
          if (at < since || at > now) continue;
          const dataKey =
            row.kind === "correction"
              ? `${row.c.targetScriptId}@${row.c.targetScriptVer}`
              : row.kind === "record"
                ? `${row.rec.scriptId}@${row.rec.scriptVer}`
                : `${row.details.scriptId}@${row.details.scriptVer}`;
          const digest =
            row.kind === "correction"
              ? row.c.correctionDigest
              : row.kind === "record"
                ? row.rec.requestDigest
                : row.details.requestDigest;
          if (!dedupe({ entryId, at, digest, scriptKey: dataKey })) continue;
          liveRows.push({ ...row, entryId, session: file, at });
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
      } catch (error) {
        scanComplete = false;
        scanErrors.push({ file, reason: error.message });
      } finally {
        lines.close();
        input.destroy();
      }
    }
  } catch (error) {
    scanComplete = false;
    scanErrors.push({ file: scanRoot, reason: error.message });
  }
  const liveEvidence = buildLiveEvidence(liveRows, BUILTIN_SCRIPTS, []);
  const verdicts = [...liveEvidence.stats.entries()].map(([key, live]) => {
    const identity = { ...live.identity, portVer: registry.get(live.identity.portId)?.version ?? 0 };
    const port = liveEvidence.ports.get(`${identity.portId}@${identity.portVer}`) ?? {
      portId: identity.portId,
      portVer: identity.portVer,
      runs: 0,
      ok: 0,
      unavailable: 0,
      missing: liveEvidence.ports.get(`${identity.portId}@0`)?.missing ?? 0,
    };
    return { key, ...evaluateMergedPromotion({ identity, live, port, scanComplete }) };
  });
  const repeats = countCrossSessionRepeats(occurrences);
  const scripts = [...stats.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, s]) => {
      // Missing AUTO timestamps could hide repeat evidence: fail closed on promotion.
      s.crossSessionRepeats = invalidTimestamps > 0 ? undefined : repeats.get(key);
      const percentiles = msPercentiles(samples.get(key) ?? []);
      if (percentiles.p50 !== undefined) s.p50ms = percentiles.p50;
      if (percentiles.p95 !== undefined) s.p95ms = percentiles.p95;
      const builtin = BUILTIN_SCRIPTS.find((b) => b.id === s.scriptId && b.version === s.scriptVer);
      const lineage =
        builtin?.lineage ??
        (builtin ? builtin.id : s.scriptId.startsWith("draft.") ? s.scriptId : `${s.scriptId}@${s.scriptVer}`);
      const matching = verdicts.filter((v) => v.identity.lineage === lineage);
      return {
        key,
        ...s,
        crossSessionRepeats: s.crossSessionRepeats ?? null,
        okRate: s.portRuns > 0 ? s.portOk / s.portRuns : null,
        divergeRate: s.judged > 0 ? s.diverge / s.judged : null,
        eligible: matching.length > 0 && matching.every((v) => v.verdict === "eligible"),
        reasons: matching.length > 0 ? matching.flatMap((v) => v.reasons) : ["identity-undetermined"],
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
    scanComplete,
    scanErrors,
    ports: [...liveEvidence.ports.values()],
    identities: verdicts,
  };
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(
      `reflex shadow · days=${options.days} files=${files} rows=${rows} invalidTimestamps=${invalidTimestamps}`,
    );
    console.log(`sessions: ${scanRoot}`);
    console.log(`scanComplete=${scanComplete}`);
    for (const p of report.ports)
      console.log(
        `port ${p.portId}@${p.portVer} runs=${p.runs} ok=${p.ok} missing=${p.missing} unavailable=${p.unavailable}`,
      );
    for (const v of verdicts)
      console.log(
        `identity ${v.key} port=${v.identity.portId}@${v.identity.portVer} · ${v.verdict} · ${v.reasons.join(";")}`,
      );
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
