import { describe, expect, it } from "vitest";
import {
  MEASURE_ACTION_TABLE,
  classifyMeasureOutcome,
  resolveMeasureAction,
  wasSent,
} from "../../src/cache-ttl/measure-actions.js";
import type { PipelineDiag, PipelineOutcome } from "../../src/cache-ttl/pipeline-ping-types.js";
import type {
  MeasureAction,
  MeasureOutcomeClass,
  MeasureRequestKind,
  UsageReading,
} from "../../src/cache-ttl/measure-types.js";

const diag = (baseFetchCalls = 1): PipelineDiag => ({
  baseFetchCalls,
  onPayloadCalls: 1,
  sawMessageStart: false,
  explicitSuccess: false,
  piStopReason: undefined,
  httpStatus: undefined,
  bodyBytes: 0,
  wireHeaderNames: [],
  deadlineHit: false,
  durationMs: 0,
});

const VALID: UsageReading = {
  usage: { P: 100, C: 0 },
  cacheEvidence: { kind: "valid" },
  billing: { kind: "complete" },
};
const INVALID: UsageReading = {
  cacheEvidence: { kind: "invalid", reason: "missing-cached" },
  billing: { kind: "unknown", items: ["all"] },
};

const KINDS: MeasureRequestKind[] = ["write", "control", "probe", "renewal"];

// The plan's §4.2 table, transcribed independently of the implementation (cells: write | control | probe | renewal).
type Cell = MeasureAction;
const failed = (reason: string): Cell => ({ kind: "failed", reason: reason as never });
const EXPECTED: Record<MeasureOutcomeClass, [Cell, Cell, Cell, Cell]> = {
  "not-sent-transient": [
    { kind: "replacement", possiblyBilled: false, nonceBurned: false },
    { kind: "retry-control", possiblyBilled: false },
    { kind: "inconclusive", reason: "not-sent", possiblyBilled: false },
    { kind: "renewal-unknown", reason: "not-sent", possiblyBilled: false },
  ],
  "not-sent-late": [
    { kind: "replacement", possiblyBilled: false, nonceBurned: false },
    { kind: "retry-control", possiblyBilled: false },
    { kind: "inconclusive", reason: "late", possiblyBilled: false },
    { kind: "renewal-unknown", reason: "late", possiblyBilled: false },
  ],
  "not-sent-auth": [failed("auth"), failed("auth"), failed("auth"), failed("auth")],
  "not-sent-rejected": [failed("payload:extra-input"), failed("route"), failed("route"), failed("route")],
  "not-sent-route": [failed("route"), failed("route"), failed("route"), failed("route")],
  "http-redirect": [failed("redirect"), failed("redirect"), failed("redirect"), failed("redirect")],
  "http-auth": [failed("auth-http"), failed("auth-http"), failed("auth-http"), failed("auth-http")],
  "http-429": [
    { kind: "replacement", possiblyBilled: false, nonceBurned: false, waitMs: 5_000 },
    { kind: "retry-control", possiblyBilled: false, flagRateLimited: true },
    { kind: "inconclusive", reason: "rate-limited", possiblyBilled: false, flagRateLimited: true },
    { kind: "renewal-unknown", reason: "rate-limited", possiblyBilled: false },
  ],
  "http-4xx": [
    failed("http-418"),
    failed("http-418"),
    failed("http-418"),
    { kind: "renewal-unknown", reason: "http", possiblyBilled: false },
  ],
  "http-5xx": [
    { kind: "replacement", possiblyBilled: false, nonceBurned: false },
    { kind: "retry-control", possiblyBilled: false },
    { kind: "inconclusive", reason: "http-5xx", possiblyBilled: false },
    { kind: "renewal-unknown", reason: "http", possiblyBilled: false },
  ],
  "sent-lost": [
    { kind: "replacement", possiblyBilled: true, nonceBurned: true },
    { kind: "retry-control", possiblyBilled: true },
    { kind: "inconclusive", reason: "sent-lost", possiblyBilled: true },
    { kind: "renewal-unknown", reason: "sent-lost", possiblyBilled: true },
  ],
  "usage-invalid": [
    { kind: "replacement", possiblyBilled: true, nonceBurned: true },
    { kind: "retry-control", possiblyBilled: true },
    { kind: "inconclusive", reason: "no-usage", possiblyBilled: true },
    { kind: "renewal-unknown", reason: "no-usage", possiblyBilled: true },
  ],
  "usage-valid": [{ kind: "anchor" }, { kind: "classify" }, { kind: "classify" }, { kind: "evaluate-renewal" }],
};

describe("outcome → action table (§4.2), row by row", () => {
  for (const cls of Object.keys(EXPECTED) as MeasureOutcomeClass[]) {
    for (const [i, kind] of KINDS.entries()) {
      it(`${cls} × ${kind}`, () => {
        const got = resolveMeasureAction(cls, kind, { rejection: "extra-input", httpStatus: 418 });
        expect(got).toEqual(EXPECTED[cls][i]);
      });
    }
  }

  it("the table covers exactly the declared classes and kinds (no silent gap)", () => {
    expect(Object.keys(MEASURE_ACTION_TABLE).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const cls of Object.keys(MEASURE_ACTION_TABLE) as MeasureOutcomeClass[]) {
      expect(Object.keys(MEASURE_ACTION_TABLE[cls]).sort()).toEqual([...KINDS].sort());
    }
  });

  it("data-dependent failure reasons are filled in, never left as templates", () => {
    expect(resolveMeasureAction("not-sent-rejected", "write", { rejection: "tools" })).toEqual({
      kind: "failed",
      reason: "payload:tools",
    });
    expect(resolveMeasureAction("http-4xx", "probe", { httpStatus: 404 })).toEqual({
      kind: "failed",
      reason: "http-404",
    });
    expect(resolveMeasureAction("http-4xx", "write", { httpStatus: 413 })).toEqual({
      kind: "failed",
      reason: "http-413",
    });
  });

  it("only transient / late / 429 / 5xx / lost / invalid-usage rows are non-fatal; a `failed` row ends the run", () => {
    const fatal: MeasureOutcomeClass[] = [
      "not-sent-auth",
      "not-sent-rejected",
      "not-sent-route",
      "http-redirect",
      "http-auth",
    ];
    for (const cls of fatal) for (const k of KINDS) expect(MEASURE_ACTION_TABLE[cls][k].kind).toBe("failed");
  });

  it("a possibly-billed flag is set exactly where a request may have been processed", () => {
    const billed = (cls: MeasureOutcomeClass) => {
      const cell = MEASURE_ACTION_TABLE[cls].probe;
      return cell.kind === "inconclusive" ? cell.possiblyBilled : undefined;
    };
    expect(billed("sent-lost")).toBe(true);
    expect(billed("usage-invalid")).toBe(true);
    for (const cls of ["not-sent-transient", "not-sent-late", "http-429", "http-5xx"] as const)
      expect(billed(cls)).toBe(false);
  });
});

describe("classifyMeasureOutcome", () => {
  const ns = (reason: string, measured?: object): PipelineOutcome =>
    ({ kind: "not-sent", reason, diag: diag(0), ...(measured ? { measured } : {}) }) as PipelineOutcome;
  const http = (status: number): PipelineOutcome => ({ kind: "http", status, diag: diag() });

  it("not-sent reasons", () => {
    expect(classifyMeasureOutcome(ns("auth"), undefined)).toBe("not-sent-auth");
    expect(classifyMeasureOutcome(ns("capability", { rejection: "tools" }), undefined)).toBe("not-sent-rejected");
    expect(classifyMeasureOutcome(ns("capability", { routeMismatch: true }), undefined)).toBe("not-sent-route");
    expect(classifyMeasureOutcome(ns("capability"), undefined)).toBe("not-sent-route");
    for (const r of ["deadline", "aborted", "provider-error", "guard"]) {
      expect(classifyMeasureOutcome(ns(r), undefined)).toBe("not-sent-transient");
    }
    expect(classifyMeasureOutcome(ns("guard"), undefined, { lateRefused: true })).toBe("not-sent-late");
    // lateness only reclassifies a guard refusal
    expect(classifyMeasureOutcome(ns("deadline"), undefined, { lateRefused: true })).toBe("not-sent-transient");
  });

  it("http statuses", () => {
    for (const s of [301, 302, 307, 308, 399]) expect(classifyMeasureOutcome(http(s), undefined)).toBe("http-redirect");
    for (const s of [401, 403]) expect(classifyMeasureOutcome(http(s), undefined)).toBe("http-auth");
    expect(classifyMeasureOutcome(http(429), undefined)).toBe("http-429");
    for (const s of [400, 404, 408, 413, 422, 499]) expect(classifyMeasureOutcome(http(s), undefined)).toBe("http-4xx");
    for (const s of [500, 502, 503, 529]) expect(classifyMeasureOutcome(http(s), undefined)).toBe("http-5xx");
  });

  it("lost kinds and usage validity", () => {
    for (const kind of ["network", "accepted-then-lost", "malformed"] as const) {
      expect(classifyMeasureOutcome({ kind, diag: diag() } as PipelineOutcome, undefined)).toBe("sent-lost");
    }
    const usage = { kind: "usage", usage: undefined, diag: diag() } as PipelineOutcome;
    expect(classifyMeasureOutcome(usage, VALID)).toBe("usage-valid");
    expect(classifyMeasureOutcome(usage, INVALID)).toBe("usage-invalid");
    expect(classifyMeasureOutcome(usage, undefined)).toBe("usage-invalid");
  });

  it("wasSent follows the base-fetch counter", () => {
    expect(wasSent(ns("guard"))).toBe(false);
    expect(wasSent(http(500))).toBe(true);
    expect(wasSent({ kind: "network", diag: diag() } as PipelineOutcome)).toBe(true);
  });
});
