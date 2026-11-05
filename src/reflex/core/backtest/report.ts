/** B3 export DTOs are explicitly projected, never stringify a Turn/cache/ledger. */
import { redactForJev } from "../../../memory/jev/redact.js";
import { identityKey } from "../identity.js";
import type { PromotionVerdictV2, ReplayRow } from "../types.js";
import type { GenerateResult } from "./draft-gen.js";
import { highIdentityOf } from "./evidence.js";
import type { OrchestrateOptions, ScanResult } from "./orchestrate.js";

/** Export hygiene: match/redact before clipping. No paths, filenames, argv or markdown escapes. */
export function safeText(text: string, limit = 24): string {
  return clip(redact(text), limit);
}
function redact(text: string): string {
  return (redactForJev(text, "user").split("\n")[0] ?? "")
    .replace(/\S*[\\/]\S*/g, "[PATH]")
    .replace(/\S*\.jsonl\S*/gi, "[FILE]")
    .replace(/argv/gi, "[ARGS]")
    .replace(/[\\/`|<>~\u0000-\u001f]/g, " ");
}
function clip(text: string, limit: number): string {
  return Array.from(text).slice(0, limit).join("");
}
const safeCounts = (counts: Readonly<Record<string, number>>) =>
  Object.fromEntries(Object.entries(counts).map(([k, v]) => [safeText(k, 64), v]));
export function buildReport(
  scan: ScanResult,
  rows: readonly ReplayRow[],
  opts: OrchestrateOptions,
  verdicts: readonly PromotionVerdictV2[] = [],
  details: readonly ReplayRow[] = [],
  generated?: GenerateResult,
) {
  const classes: Record<string, number> = {},
    unknownFacts: Record<string, number> = {};
  for (const row of rows) {
    classes[row.cls.k] = (classes[row.cls.k] ?? 0) + 1;
    for (const fact of row.turn.unknownFacts) unknownFacts[fact] = (unknownFacts[fact] ?? 0) + 1;
  }
  return {
    title: "reflex backtest",
    unverified: true,
    manifestHash: scan.manifest.manifestHash,
    scanComplete: scan.scanComplete,
    scanErrors: scan.errors.length,
    scannedBytes: scan.scannedBytes,
    bodyReadBytes: scan.cacheMode === "warm" ? 0 : scan.scannedBytes,
    cache: `应用缓存${scan.cacheMode === "cold" ? "冷" : "热"} (OS page cache uncontrolled)`,
    filters: safeCounts(scan.counts),
    unresolved: safeCounts(scan.unresolved),
    classes,
    confirmed: rows.filter((r) => r.acceptance === "confirmed").length,
    lenient: rows.filter((r) => r.acceptance === "lenient").length,
    unknownFacts,
    skips: generated ? safeCounts(generated.skips) : {},
    needsPort:
      generated?.needsPort.map((n) => ({
        clusterId: safeText(n.clusterId, 64),
        size: n.size,
        skeletons: n.skeletons.map((s) => safeText(s)),
        suggestedPort: n.suggestedPort,
      })) ?? [],
    identities: verdicts.map((v) => ({
      identity: {
        lineage: safeText(v.identity.lineage, 64),
        templateHash: safeText(v.identity.templateHash, 64),
        port: `${v.identity.portId}@${v.identity.portVer}`,
      },
      verdict: v.verdict,
      reasons: v.reasons.map((r) => safeText(r, 64)),
      ...(v.batchId ? { batchId: v.batchId } : {}),
      ...(v.manifestHash ? { manifestHash: v.manifestHash } : {}),
    })),
    suspects: details
      .filter((r) => r.suspect !== undefined)
      .map((r) => ({
        digest: safeText(r.turn.digest, 64),
        head: safeText(r.turn.text),
        code: r.suspect,
        identity: safeText(identityKey(highIdentityOf(r, opts.builtin, opts.drafts)!), 100),
      })),
    note: "未认证统计建议；人工认证仅在用户批准 catalog PR。草案恒 shadow，不自动晋升。",
  };
}
export type ExportReport = ReturnType<typeof buildReport>;
export function renderReport(report: ExportReport): string {
  return (
    `# reflex backtest · unverified\n\nmanifestHash: ${report.manifestHash}\nscannedBytes: ${report.scannedBytes}\n${report.cache}\nscanComplete: ${report.scanComplete}\n\n` +
    "```json\n" +
    JSON.stringify(report, null, 2) +
    "\n```\n"
  );
}
/** Local-only shape view. Never accepts an argv-bearing envelope or exports session/cwd. */
export function renderShow(row: ReplayRow): string {
  return [
    `digest=${safeText(row.turn.digest, 64)} origin=${row.turn.origin} split=${row.turn.split}`,
    `unknownFacts=${row.turn.unknownFacts.join(",") || "none"}`,
    `Q: ${redactForJev(row.turn.text, "user")}`,
    `tools: ${row.turn.shapes.map((s) => safeText(s, 80)).join(", ") || "none"}`,
  ].join("\n");
}
