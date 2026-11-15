// Local-only, pi-free bounded selection audit. No body/prompt/model reply fields.
import type { TagScore } from "./contracts.js";
import type { FastPathTagConfig, TagRiskInfo, SelectedPEntry } from "./select.js";

export const PREDICT_DIAG_MAX_BYTES = 16_384;
export const PREDICT_DIAG_MAX_REJECTED = 32;
const MAX_ROWS = 32;
const token = (s: string): string => s.slice(0, 96);

/** Counts are sequential: a later gate is not counted when an earlier one rejects.
 * Tag risk/allow/deny membership is independent evidence, not three required gates. */
export class PredictDiagnostics {
  readonly counts: Record<string, { pass: number; reject: number }> = {};
  readonly rejected: { id: string; reason: string }[] = [];
  private truncated = false;

  gate(gate: string, pass: boolean, id?: string): boolean {
    // Closed production vocabulary, defensively bounded for future additions.
    gate = gate.replace(/[^a-z0-9-]/g, "").slice(0, 40) || "unknown";
    if (!(gate in this.counts) && Object.keys(this.counts).length >= 48) {
      gate = "other";
      this.truncated = true;
    }
    const count = (this.counts[gate] ??= { pass: 0, reject: 0 });
    count[pass ? "pass" : "reject"] += 1;
    if (!pass && id !== undefined) {
      if (this.rejected.length < PREDICT_DIAG_MAX_REJECTED) this.rejected.push({ id: token(id), reason: token(gate) });
      else this.truncated = true;
    }
    return pass;
  }

  finish(input: {
    turnSeq: number;
    isChild: boolean;
    tags: readonly TagScore[];
    taxonomy: readonly TagRiskInfo[];
    fastPath: FastPathTagConfig;
    selected: readonly SelectedPEntry[];
    committed: readonly string[];
    idOf: (hash: string) => string;
    origin: string;
    remainingBefore: number;
    remainingAfter: number;
    maxEntries: number;
    maxBytes: number;
    sSelected?: string;
  }) {
    const tags = input.tags.slice(0, MAX_ROWS).map((t) => {
      const highRisk = input.taxonomy.some((d) => d.id === t.tag && d.risk === "high");
      const allow = input.fastPath.allowTags.includes(t.tag);
      const deny = input.fastPath.denyTags.includes(t.tag);
      const score = this.gate("tag-score", t.score >= 0.85);
      this.gate("risk-member", highRisk);
      this.gate("allow-member", allow);
      this.gate("deny-clear", !deny);
      const riskAllow = this.gate("risk-allow", (highRisk || allow) && !deny);
      return {
        tag: token(t.tag),
        finalScore: t.score,
        sources: t.sources.slice(0, 8),
        highRisk,
        allow,
        deny,
        eligible: score && riskAllow,
      };
    });
    const record = {
      v: 1,
      turnSeq: input.turnSeq,
      session: input.isChild ? "child" : "main",
      origin: token(input.origin),
      tags,
      counts: this.counts,
      rejected: this.rejected,
      selected: input.selected
        .slice(0, MAX_ROWS)
        .map((p) => ({ id: token(input.idOf(p.hash)), score: p.score, bypass: p.bypass === true })),
      committed: input.committed.slice(0, MAX_ROWS).map((h) => token(input.idOf(h))),
      ...(input.sSelected === undefined ? {} : { sSelected: token(input.idOf(input.sSelected)) }),
      remainingBefore: input.remainingBefore,
      remainingAfter: input.remainingAfter,
      maxEntries: input.maxEntries,
      maxBytes: input.maxBytes,
      truncated:
        this.truncated ||
        input.tags.length > MAX_ROWS ||
        input.selected.length > MAX_ROWS ||
        input.committed.length > MAX_ROWS,
    };
    // Real serialized UTF-8 bound, including escaping/multibyte IDs. Keep counts
    // complete; drop sample tails only. Never truncate a JSON string on disk.
    while (Buffer.byteLength(JSON.stringify(record), "utf8") > PREDICT_DIAG_MAX_BYTES) {
      record.truncated = true;
      if (record.rejected.length) record.rejected.pop();
      else if (record.tags.length) record.tags.pop();
      else if (record.selected.length) record.selected.pop();
      else if (record.committed.length) record.committed.pop();
      else break; // fixed set of gate counters and scalar fields fits below the bound
    }
    return record;
  }
}
