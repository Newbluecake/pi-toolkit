/** P2-local body-free, bounded audit projection. Never accepts ids, bodies or hashes.
 * P6 supplies its logger; logger faults cannot change an HTTP/auth result. */
import type { AuthIdentity } from "../../auth-identity.js";
import type { TerminalOpV2 } from "../../../protocol/terminal-v2-paths.js";
import type { TerminalErrorCodeV2 } from "../../../protocol/terminal-v2.js";
import { clampSpanMs } from "./local.js";
export interface TerminalRouteAuditV2 {
  op: TerminalOpV2 | "aggregate";
  listener: AuthIdentity["listener"];
  ok: boolean;
  code?: TerminalErrorCodeV2;
  ms: number;
  n: number;
}
export type TerminalAuditV2 = (record: Readonly<TerminalRouteAuditV2>) => void;
export function terminalRouteAuditV2(now: () => number, sink?: TerminalAuditV2) {
  let failures = 0,
    emitted = 0,
    at = now();
  const aggregates = new Map<string, { at: number; record: TerminalRouteAuditV2 }>();
  function emit(record: TerminalRouteAuditV2) {
    if (now() - at >= 1000) {
      at = now();
      emitted = 0;
    }
    if (emitted >= 8 || !sink) return;
    emitted++;
    try {
      sink(Object.freeze({ ...record }));
    } catch {
      failures = Math.min(Number.MAX_SAFE_INTEGER, failures + 1);
    }
  }
  return {
    record(op: TerminalOpV2, listener: AuthIdentity["listener"], startedAt: number, code?: TerminalErrorCodeV2) {
      const record: TerminalRouteAuditV2 = {
        op,
        listener,
        ok: code === undefined,
        ...(code ? { code } : {}),
        ms: clampSpanMs(now() - startedAt),
        n: 1,
      };
      if (op !== "input" && op !== "ack" && op !== "resize") {
        emit(record);
        return;
      }
      // Finite key space (two listeners × three fixed ops × fixed code set).
      const key = `${listener}:${op}:${code ?? "ok"}`;
      const old = aggregates.get(key);
      if (old && now() - old.at < 60_000) {
        old.record.n = Math.min(Number.MAX_SAFE_INTEGER, old.record.n + 1);
        old.record.ms = clampSpanMs(old.record.ms + record.ms);
      } else {
        if (old) emit({ ...old.record, op: "aggregate" });
        aggregates.set(key, { at: now(), record });
        if (code) emit(record);
      }
    },
    failures: () => failures,
    dispose() {
      for (const { record } of aggregates.values()) emit({ ...record, op: "aggregate" });
      aggregates.clear();
    },
  };
}
