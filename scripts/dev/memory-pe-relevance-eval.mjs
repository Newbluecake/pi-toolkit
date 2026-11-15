#!/usr/bin/env node
/** Tier 3 / P0 baseline skeleton. No model, provider, settings, HOME or LIVE entry.
 * Historical selected outputs are not complete selection-time snapshots.
 * Only the production legacy E predicate is replayable in P0; P materialization,
 * semantic gates and frozen-answer counterfactuals await later approved packages.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GRADES = ["useful", "neutral", "irrelevant", "harmful"];
const INPUTS = [
  "samples.json",
  "labels.json",
  "items.json",
  "events.json",
  "finals.json",
  "E_context.json",
  "blocks.json",
  "memory_manifest.json",
];
const SOURCES = [
  "src/memory/jev/error-relevance.ts",
  "src/memory/jev/wire.ts",
  "src/memory/jev/decide.ts",
  "src/memory/jev/predict/select.ts",
  "src/memory/jev/predict/diagnostics.ts",
];

function digest(file) {
  return existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null;
}
function inside(path, root) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
function json(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}
function counts(rows) {
  return Object.fromEntries(GRADES.map((grade) => [grade, rows.filter((row) => row.grade === grade).length]));
}

/** Runtime validator for production ErrorRelevanceSnapshotV1; no inferred inputs. */
export function validateSnapshots(rows) {
  const out = new Map();
  for (const row of rows) {
    const strings = (value) => Array.isArray(value) && value.every((s) => typeof s === "string");
    if (
      row?.v !== 1 ||
      typeof row.id !== "string" ||
      !row.id ||
      typeof row.provenance !== "string" ||
      !row.provenance.trim() ||
      typeof row.meta?.pending !== "boolean" ||
      !strings(row.meta.tags) ||
      !(row.meta.type === undefined || typeof row.meta.type === "string") ||
      !strings(row.hitTags) ||
      !strings(row.highRiskTagIds)
    )
      throw new Error("Invalid ErrorRelevanceSnapshotV1");
    if (out.has(row.id)) throw new Error(`Duplicate snapshot: ${row.id}`);
    out.set(row.id, row);
  }
  return out;
}

/** Pure report assembly. Kernels must be imported production functions, not formulas. */
export function evaluateRetained(samples, labels, snapshots, before, after) {
  const instances = [];
  const groups = { childP: samples.childP, Eall: samples.Eall };
  for (const [group, selected] of Object.entries(groups)) {
    if (!Array.isArray(selected)) throw new Error(`Missing fixed sample group: ${group}`);
    const seen = new Set();
    for (const sample of selected) {
      const grade = labels[sample.id]?.grade;
      if (typeof sample.id !== "string" || seen.has(sample.id) || !GRADES.includes(grade))
        throw new Error("Invalid or unlabelled fixed sample");
      seen.add(sample.id);
      const snapshot = group === "Eall" ? snapshots.get(sample.id) : undefined;
      let oldAllowed = null;
      let newAllowed = null;
      if (snapshot !== undefined) {
        const hit = new Set(snapshot.hitTags);
        const risk = new Set(snapshot.highRiskTagIds);
        oldAllowed = before(snapshot.meta, hit, risk);
        newAllowed = after(snapshot.meta, hit, risk);
      }
      instances.push({
        group,
        id: sample.id,
        grade,
        session: sample.type,
        hash: sample.item?.hash ?? null,
        recordedSelected: true,
        beforeAllowed: oldAllowed,
        afterAllowed: newAllowed,
        decision: newAllowed === null ? "unknown" : newAllowed ? "retained" : "suppressed",
        reason:
          snapshot === undefined
            ? group === "childP"
              ? "P-selection-snapshot-unavailable"
              : "historical-effective-meta-and-hit-unavailable"
            : "production-legacy-E-predicate",
        provenance: snapshot?.provenance ?? "historical-selected-output-only",
        taskIdentitySource: "historical-session-and-event-not-runtime-binding",
        baselineMismatch: oldAllowed === false,
      });
    }
  }
  const tables = Object.fromEntries(
    Object.keys(groups).map((group) => {
      const rows = instances.filter((row) => row.group === group);
      const retained = rows.filter((row) => row.decision === "retained");
      const suppressed = rows.filter((row) => row.decision === "suppressed");
      const unknown = rows.filter((row) => row.decision === "unknown");
      return [
        group,
        {
          originalN: rows.length,
          knownN: rows.length - unknown.length,
          unknownN: unknown.length,
          recordedBaseline: counts(rows),
          retained: counts(retained),
          suppressed: counts(suppressed),
          unknown: counts(unknown),
          retainedN: retained.length,
          newSelected: "NOT-EVALUATED",
          neutralLossIds: suppressed.filter((row) => row.grade === "neutral").map((row) => row.id),
          usefulRetention: {
            retained: retained.filter((row) => row.grade === "useful").length,
            original: rows.filter((row) => row.grade === "useful").length,
            unknown: unknown.filter((row) => row.grade === "useful").length,
          },
          retainedIrrelevantRatio:
            retained.length === 0
              ? null
              : retained.filter((row) => row.grade === "irrelevant").length / retained.length,
          residualIrrelevantOverOriginalN:
            rows.length === 0 ? null : retained.filter((row) => row.grade === "irrelevant").length / rows.length,
          baselineMismatches: rows.filter((row) => row.baselineMismatch).length,
        },
      ];
    }),
  );
  return {
    instances,
    summary: {
      evidenceLevel: "retained-only",
      functionalVerdict: "NOT-EVALUATED",
      retainedRegressionVerdict: instances.some((row) => row.baselineMismatch || row.beforeAllowed !== row.afterAllowed)
        ? "FAIL"
        : instances.some((row) => row.decision === "unknown")
          ? "NOT-EVALUATED"
          : "PASS",
      qualityVerdict: "NOT-EVALUATED",
      tables,
      coverage: {
        originalN: instances.length,
        knownN: instances.filter((row) => row.decision !== "unknown").length,
        unknownN: instances.filter((row) => row.decision === "unknown").length,
      },
      frozenAnswerAppendix: {
        verdict: "NOT-EVALUATED",
        reason: "No complete request-bound answers; selected p is not a full answer set.",
      },
      legacyWindow: "NOT-EVALUATED",
      limits: [
        "P0 does not implement new applicability gates.",
        "No replacement selection, task binding or complete classifier request replay.",
        "Current blocks/sidecars are never substituted for historical metadata.",
        "Functional verdict requires external wire/parity/golden gates, not this script.",
      ],
    },
  };
}

export function parseArgs(args) {
  if (args.length === 1 && args[0] === "--help") return null;
  const result = {};
  const keys = new Set(["--data", "--legacy-data", "--before-root", "--after-root", "--evidence", "--entry", "--out"]);
  for (let i = 0; i < args.length; i += 2) {
    if (!keys.has(args[i]) || !args[i + 1] || args[i + 1].startsWith("--") || result[args[i]] !== undefined)
      throw new Error("Unknown, duplicate or missing argument");
    result[args[i]] = args[i + 1];
  }
  for (const key of ["--data", "--before-root", "--after-root", "--evidence", "--out"])
    if (!result[key]) throw new Error(`Required: ${key}`);
  if (result["--evidence"] !== "retained-only")
    throw new Error("P0 supports retained-only; exact/frozen-answer replay is not implemented");
  if (result["--entry"] !== undefined && !["src", "dist"].includes(result["--entry"]))
    throw new Error("--entry must be src or dist");
  return result;
}

function codeIdentity(root, entry) {
  const gitPointer = join(root, ".git");
  let head = null;
  if (existsSync(gitPointer)) {
    const gitDir = statSync(gitPointer).isDirectory()
      ? gitPointer
      : resolve(
          root,
          readFileSync(gitPointer, "utf8")
            .trim()
            .replace(/^gitdir: /, ""),
        );
    head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    if (head.startsWith("ref: ")) {
      const common = existsSync(join(gitDir, "commondir"))
        ? resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim())
        : gitDir;
      const ref = join(common, head.slice("ref: ".length));
      head = existsSync(ref) ? readFileSync(ref, "utf8").trim() : head;
    }
  }
  return {
    root,
    head,
    entry,
    sourceSha256: Object.fromEntries(SOURCES.map((p) => [p, digest(join(root, p))])),
    artifactSha256: {
      kernel: digest(join(root, "dist/memory/jev/error-relevance.js")),
      bundle: digest(join(root, "dist/bundle/index.js")),
    },
  };
}

export async function run(args) {
  const options = parseArgs(args);
  if (options === null) {
    console.log(
      "node --import tsx scripts/dev/memory-pe-relevance-eval.mjs --data DIR --before-root P0_ROOT --after-root ROOT --evidence retained-only --entry src|dist --out PRIVATE_TMP_DIR [--legacy-data DIR]",
    );
    return;
  }
  const data = realpathSync(options["--data"]);
  const beforeRoot = realpathSync(options["--before-root"]);
  const afterRoot = realpathSync(options["--after-root"]);
  const out = resolve(options["--out"]);
  // New private output directory only; no repository, user memory or session writes.
  const parent = realpathSync(dirname(out));
  const canonicalOut = join(parent, out.slice(dirname(out).length + 1));
  if (
    !inside(canonicalOut, "/tmp") ||
    [REPO, beforeRoot, afterRoot, data].some((root) => inside(canonicalOut, root)) ||
    existsSync(out)
  )
    throw new Error("--out must be a NEW private directory under /tmp, outside roots/data");
  const entry = options["--entry"] ?? "src";
  const load = async (root) => {
    const file = join(
      root,
      entry === "src" ? "src/memory/jev/error-relevance.ts" : "dist/memory/jev/error-relevance.js",
    );
    const kernel = await import(pathToFileURL(file).href);
    if (typeof kernel.legacyErrorCandidateAllowed !== "function")
      throw new Error("Root must expose the frozen P0 baseline kernel");
    return kernel.legacyErrorCandidateAllowed;
  };
  const before = await load(beforeRoot);
  const after = await load(afterRoot);
  const snapshotFile = join(data, "error-relevance-snapshots.jsonl");
  const snapshots = validateSnapshots(
    existsSync(snapshotFile)
      ? readFileSync(snapshotFile, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [],
  );
  const result = evaluateRetained(
    json(join(data, "samples.json")),
    json(join(data, "labels.json")),
    snapshots,
    before,
    after,
  );
  const manifest = {
    v: 1,
    evidenceLevel: "retained-only",
    data,
    inputSha256: Object.fromEntries(
      [...INPUTS, "error-relevance-snapshots.jsonl"].map((p) => [p, digest(join(data, p))]),
    ),
    sampleWindow: "timestamps in samples.json; preserved original IDs and labels",
    code: { before: codeIdentity(beforeRoot, entry), after: codeIdentity(afterRoot, entry) },
    legacyData: options["--legacy-data"]
      ? {
          path: resolve(options["--legacy-data"]),
          exists: existsSync(options["--legacy-data"]),
          verdict: "NOT-EVALUATED",
        }
      : null,
    gaps: result.summary.limits,
  };
  mkdirSync(out, { mode: 0o700 });
  const write = (name, text) => writeFileSync(join(out, name), text, { mode: 0o600, flag: "wx" });
  write("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  write("per-instance.jsonl", result.instances.map((row) => JSON.stringify(row)).join("\n") + "\n");
  write("summary.json", `${JSON.stringify(result.summary, null, 2)}\n`);
  const lines = [
    "# P0 retained-only baseline",
    "",
    "qualityVerdict: NOT-EVALUATED",
    `retainedRegressionVerdict: ${result.summary.retainedRegressionVerdict}`,
    "",
    "Recorded baseline is NOT reselected output. Missing snapshots stay unknown.",
    "",
    "| group | original | known | unknown | recorded U/N/I/H | retained U/N/I/H |",
    "| --- | ---: | ---: | ---: | --- | --- |",
  ];
  for (const [group, row] of Object.entries(result.summary.tables))
    lines.push(
      `| ${group} | ${row.originalN} | ${row.knownN} | ${row.unknownN} | ${Object.values(row.recordedBaseline).join("/")} | ${Object.values(row.retained).join("/")} |`,
    );
  lines.push(
    "",
    "Frozen-answer appendix: NOT-EVALUATED (no complete request-bound answers).",
    "11-05 window: NOT-EVALUATED.",
  );
  write("summary.md", lines.join("\n") + "\n");
  console.log(lines.join("\n"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
