/** Standalone probe telemetry: construct an allowlisted numeric/code-only record.
 * Never retain/serialize upstream errors, bodies, headers, URLs or model/auth data.
 * Observations are evidence, not authorization, retries or billing guarantees. */
import type { JevUsage } from "../../src/memory/jev/contracts.js";
import type { ProbeStage } from "./p50-closure-live-probe.js";

export type ProbeFailureCode =
  | "NO_SCHEDULE"
  | "NO_R_CALL"
  | "R_FAILED"
  | "G_FAILED"
  | "C_FAILED"
  | "NO_SUGGESTION"
  | "AUDIT_MISSING"
  | "TIMEOUT"
  | "POSTCONDITION"
  | "RUNNER_FAILED";
export type ProbeErrorClass = "timeout" | "network" | "auth" | "http_4xx" | "http_5xx" | "parse";
const stages = ["R1", "R2", "G1", "C1"] as const;
const failures: readonly ProbeFailureCode[] = [
  "NO_SCHEDULE",
  "NO_R_CALL",
  "R_FAILED",
  "G_FAILED",
  "C_FAILED",
  "NO_SUGGESTION",
  "AUDIT_MISSING",
  "TIMEOUT",
  "POSTCONDITION",
  "RUNNER_FAILED",
];
const classes: readonly ProbeErrorClass[] = ["timeout", "network", "auth", "http_4xx", "http_5xx", "parse"];
const count = (n: unknown): number => (typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0);
interface StageDiagnostic {
  calls: number;
  beforeHttp: number;
  status?: number;
  error?: ProbeErrorClass;
  inputTokens: number;
  outputTokens: number;
}
export class ProbeDiagnostics {
  private readonly records: Record<ProbeStage, StageDiagnostic> = Object.fromEntries(
    stages.map((stage) => [stage, { calls: 0, beforeHttp: 0, inputTokens: 0, outputTokens: 0 }]),
  ) as Record<ProbeStage, StageDiagnostic>;
  private readonly passed: ProbeStage[] = [];
  private internal: ProbeFailureCode | undefined;
  private scheduled = 0;
  private usageCounts = { calls: 0, reservedCalls: 0, outstanding: 0, zombies: 0, queuedSync: 0, queuedBackground: 0 };
  fail(code: ProbeFailureCode): void {
    if (!this.internal) this.internal = failures.includes(code) ? code : "RUNNER_FAILED";
  }
  schedule(): void {
    this.scheduled++;
  }
  started(stage: ProbeStage): void {
    if (stages.includes(stage)) this.records[stage].calls++;
  }
  admitted(stage: ProbeStage): void {
    if (stages.includes(stage) && this.passed.length < 4) {
      this.passed.push(stage);
      this.records[stage].beforeHttp++;
    }
  }
  status(stage: ProbeStage, status: number): void {
    if (stages.includes(stage) && Number.isInteger(status) && status >= 100 && status <= 599) {
      this.records[stage].status = status;
      if (status === 401 || status === 403) this.error(stage, "auth");
      else if (status >= 500) this.error(stage, "http_5xx");
      else if (status >= 400) this.error(stage, "http_4xx");
    }
  }
  error(stage: ProbeStage, error: ProbeErrorClass): void {
    if (stages.includes(stage) && classes.includes(error)) this.records[stage].error ??= error;
  }
  result(stage: ProbeStage, failed: boolean, usage?: { input: number; output: number }): void {
    if (!stages.includes(stage)) return;
    const r = this.records[stage];
    r.inputTokens = count(usage?.input);
    r.outputTokens = count(usage?.output);
    if (failed) {
      // No parsing of SDK error text. A successful HTTP followed by SDK failure
      // indicates parsing/protocol failure; no dispatch leaves cause unknown.
      if (r.status !== undefined && r.status < 400) this.error(stage, "parse");
      this.fail(stage === "G1" ? "G_FAILED" : stage === "C1" ? "C_FAILED" : "R_FAILED");
    }
  }
  observeRevision<T extends { readonly kind: string; readonly reason?: string }>(
    stage: "G1" | "C1",
    pending: Promise<T>,
  ): Promise<T> {
    // Read fixed outcome discriminants only. Retain the exact original promise;
    // this observer never issues work, retries, changes results or handles auth.
    void pending.then(
      (result) => {
        if (result.kind !== "ok") {
          if (result.reason === "invalid-output") this.error(stage, "parse");
          this.fail(stage === "G1" ? "G_FAILED" : "C_FAILED");
        }
      },
      () => this.fail(stage === "G1" ? "G_FAILED" : "C_FAILED"),
    );
    return pending;
  }
  usage(usage: JevUsage): void {
    this.usageCounts = {
      calls: count(usage.calls),
      reservedCalls: count(usage.budget?.reservedCalls),
      outstanding: count(usage.budget?.outstanding),
      zombies: count(usage.budget?.zombies),
      queuedSync: count(usage.budget?.queued.sync),
      queuedBackground: count(usage.budget?.queued.background),
    };
  }
  noSuggestion(): ProbeFailureCode {
    return this.passed.every((s) => s !== "R1" && s !== "R2") ? "NO_R_CALL" : "NO_SUGGESTION";
  }
  timeout(): void {
    this.fail(this.scheduled ? "TIMEOUT" : "NO_SCHEDULE");
  }
  snapshot() {
    return {
      contract: "p50-redacted-diagnostic-v1" as const,
      internalCode: this.internal ?? "RUNNER_FAILED",
      scheduled: this.scheduled,
      beforeHttp: [...this.passed],
      beforeHttpCount: this.passed.length,
      stages: Object.fromEntries(stages.map((stage) => [stage, { ...this.records[stage] }])),
      usage: { ...this.usageCounts },
    };
  }
}
/** Contains only a fixed public code and a fresh allowlisted snapshot. */
export class ClosureProbeFailure extends Error {
  readonly diagnostic: ReturnType<ProbeDiagnostics["snapshot"]>;
  constructor(publicCode: string, diagnostic: ProbeDiagnostics) {
    super(publicCode);
    this.diagnostic = diagnostic.snapshot();
  }
}
/** Only inspect fixed error names, never message/stack/cause or response data. */
export function transportErrorClass(error: unknown, signal?: AbortSignal | null): ProbeErrorClass {
  if (signal?.aborted || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")))
    return "timeout";
  return "network";
}
