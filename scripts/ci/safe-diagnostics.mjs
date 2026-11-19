/** Closed-schema, failure-only diagnostic extraction. Raw logs/reports stay private;
 * never publish arbitrary messages, expected/actual values, names, paths or env. */
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export const SAFE_LIMIT = 8192;
const stages = new Set([
  "starting",
  "sdk-profile",
  "sdk-import",
  "settings",
  "loader-create",
  "loader-reload",
  "extensions",
  "receipt",
]);
const reasons = new Set(["deadline", "child-failed", "spawn-error", "receipt", "output-limit"]);
const steps = new Set(["provision", "binding", "checkpoint", "vitest", "report", "evidence"]);
const names = new Set(["provision", "npm-restart", "npm-rollback", "zip-restart", "zip-rollback"]);
export function probeDiagnostics(text) {
  const result = [];
  const pattern = /T51_LOAD_PROBE stage=([a-z-]+) elapsedMs=(\d{1,5}) childMs=(\d{1,5}) reason=([a-z-]+)(?=[^a-z-]|$)/g;
  for (const match of String(text)
    .slice(0, 16 * 1024 * 1024)
    .matchAll(pattern)) {
    const [, stage, elapsed, child, reason] = match;
    if (stages.has(stage) && reasons.has(reason) && Number(elapsed) <= 30000 && Number(child) <= 30000)
      result.push({ stage, elapsedMs: Number(elapsed), childMs: Number(child), reason });
    if (result.length === 8) break;
  }
  return result;
}
export function formatProbeDiagnostics(records) {
  return records
    .map((r) => `T51_LOAD_PROBE stage=${r.stage} elapsedMs=${r.elapsedMs} childMs=${r.childMs} reason=${r.reason}`)
    .join("; ");
}
export function failureSummary(name, step, raw = "", exit = {}) {
  if (!names.has(name) || !steps.has(step)) throw new Error("unknown diagnostic cell/stage");
  const text = String(raw).slice(0, 16 * 1024 * 1024);
  const codes = [
    ...new Set(
      text.match(
        /\b(?:E_RETAINED_LOAD_PROBE_(?:DEADLINE|FAILED|RECEIPT)|EACCES|EPERM|ENOENT|ETIMEDOUT|ERR_ASSERTION)\b/g,
      ) ?? [],
    ),
  ];
  const locations = [
    ...new Set(
      text.match(
        /(?:terminal-v2-retained-stock-restart\.test|terminal-retained-stock-(?:setup|process)|load-probe|terminal-retained-cli)\.ts:\d{1,4}(?::\d{1,4})?/g,
      ) ?? [],
    ),
  ].slice(0, 12);
  return {
    v: 1,
    cell: name,
    result: "failed",
    step,
    exit: {
      status: Number.isInteger(exit.status) && Math.abs(exit.status) < 256 ? exit.status : null,
      signal: ["SIGKILL", "SIGTERM", "SIGABRT"].includes(exit.signal) ? exit.signal : null,
      outerTimeout: exit.error?.code === "ETIMEDOUT",
    },
    categories: {
      assertion: /AssertionError|ERR_ASSERTION/.test(text),
      missingCheckpoint: step === "checkpoint" && /ENOENT/.test(text),
    },
    codes,
    locations,
    probe: probeDiagnostics(text),
  };
}
export function writeSafeSummary(env, name, value) {
  if (!names.has(name)) throw new Error("unknown diagnostic filename");
  const root = join(env.PI_TOOLKIT_TEST_PRIVATE_ROOT, "safe");
  if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
  const st = lstatSync(root);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || st.mode & 0o077)
    throw new Error("unsafe diagnostic directory");
  const bytes = JSON.stringify(value, null, 2) + "\n";
  if (Buffer.byteLength(bytes) > SAFE_LIMIT) throw new Error("diagnostic size cap");
  const keys = Object.keys(value).sort().join(",");
  const allowed =
    value.result === "passed"
      ? name === "provision"
        ? "cell,result,v"
        : "cell,passed,result,v"
      : "categories,cell,codes,exit,locations,probe,result,step,v";
  if (value.v !== 1 || value.cell !== name || keys !== allowed) throw new Error("unexpected diagnostic schema");
  if (value.result === "passed") {
    if (name !== "provision" && value.passed !== 1) throw new Error("unexpected diagnostic count");
  } else {
    if (
      value.result !== "failed" ||
      !steps.has(value.step) ||
      Object.keys(value.exit).sort().join(",") !== "outerTimeout,signal,status" ||
      !(value.exit.status === null || (Number.isInteger(value.exit.status) && Math.abs(value.exit.status) < 256)) ||
      ![null, "SIGKILL", "SIGTERM", "SIGABRT"].includes(value.exit.signal) ||
      typeof value.exit.outerTimeout !== "boolean" ||
      Object.keys(value.categories).sort().join(",") !== "assertion,missingCheckpoint" ||
      Object.values(value.categories).some((v) => typeof v !== "boolean") ||
      !Array.isArray(value.codes) ||
      !value.codes.every((v) =>
        /^(?:E_RETAINED_LOAD_PROBE_(?:DEADLINE|FAILED|RECEIPT)|EACCES|EPERM|ENOENT|ETIMEDOUT|ERR_ASSERTION)$/.test(v),
      ) ||
      !Array.isArray(value.locations) ||
      !value.locations.every((v) =>
        /^(?:terminal-v2-retained-stock-restart\.test|terminal-retained-stock-(?:setup|process)|load-probe|terminal-retained-cli)\.ts:\d{1,4}(?::\d{1,4})?$/.test(
          v,
        ),
      ) ||
      !Array.isArray(value.probe) ||
      JSON.stringify(probeDiagnostics(formatProbeDiagnostics(value.probe))) !== JSON.stringify(value.probe)
    )
      throw new Error("unexpected diagnostic schema");
  }
  const target = join(root, `${name}.safe.json`);
  if (existsSync(target)) {
    const current = lstatSync(target);
    if (!current.isFile() || current.isSymbolicLink() || current.uid !== process.getuid() || current.mode & 0o077)
      throw new Error("unsafe diagnostic file");
  }
  writeFileSync(target, bytes, { mode: 0o600, flag: "w" });
  return bytes;
}
export function privateReportText(path) {
  if (!existsSync(path)) return "";
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 16 * 1024 * 1024) return "";
  return readFileSync(path, "utf8");
}
