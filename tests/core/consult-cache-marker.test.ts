import { describe, expect, it } from "vitest";
import type {
  ConsultAnchorStatus,
  ConsultCacheDiagnostics,
  ConsultThreadRef,
  RunDiagnostics,
} from "../../src/core/types.js";
import {
  consultCacheMarker,
  consultCacheMarkerOfDiag,
  formatConsultCacheLine,
} from "../../src/core/consult-cache-marker.js";

/**
 * cache-thread plan §5.3 / §11 (U): golden table for the compact marker —
 * `warm·hit 96%`, `cold·miss`, `?·partial 24%`, pre-first `warm·…`,
 * `·degraded`, `?·n/a`, thread prefix `t#2` — plus the absence rule (render
 * nothing new; consumers stay byte-identical) and the `get_subagent_result`
 * detail line.
 */

function cache(
  predicted: ConsultCacheDiagnostics["predicted"]["state"],
  first?: ConsultCacheDiagnostics["first"],
): ConsultCacheDiagnostics {
  return { v: 1, predicted: { state: predicted }, ...(first === undefined ? {} : { first }) };
}

function first(
  label: "hit" | "partial" | "miss" | "n/a",
  readShare: number | null,
  extra: { anchor?: ConsultAnchorStatus; degraded?: true } = {},
): NonNullable<ConsultCacheDiagnostics["first"]> {
  return { v: 1, readShare, label, anchor: extra.anchor ?? "n/a", ...(extra.degraded ? { degraded: true } : {}) };
}

describe("consultCacheMarker golden table (plan §5.3)", () => {
  it.each([
    [cache("warm", first("hit", 0.962)), "warm·hit 96%"],
    [cache("cold", first("miss", 0.031)), "cold·miss 3%"],
    [cache("unknown", first("partial", 0.41)), "?·partial 41%"],
    [cache("unknown", first("partial", 0.235)), "?·partial 24%"], // plan's F0 example
    [cache("warm"), "warm·…"], // first response pending
    [cache("cold"), "cold·…"],
    [cache("unknown", first("n/a", null)), "?·n/a"],
    [cache("warm", first("hit", 1)), "warm·hit 100%"],
    [cache("warm", first("hit", 0)), "warm·hit 0%"],
    // degraded rides both a measured and a pending marker
    [cache("unknown", first("partial", 0.41, { degraded: true })), "?·partial 41%·degraded"],
    [cache("warm", first("hit", 0.99, { anchor: "relocated", degraded: true })), "warm·hit 99%·degraded"],
  ] as const)("renders %o as %s", (diag, expected) => {
    expect(consultCacheMarkerOfDiag({ consultCache: diag })).toBe(expected);
  });

  it("threads prefix the marker with `t#n` (plan: `t#2 warm·hit 96%`)", () => {
    const thread: ConsultThreadRef = { threadId: "c7k9q2mx", seq: 2 };
    expect(consultCacheMarkerOfDiag({ consultCache: cache("warm", first("hit", 0.96)), consultThread: thread })).toBe(
      "t#2 warm·hit 96%",
    );
    expect(consultCacheMarkerOfDiag({ consultCache: cache("unknown"), consultThread: { threadId: "x", seq: 1 } })).toBe(
      "t#1 ?·…",
    );
    // bare thread association still displays
    expect(consultCacheMarkerOfDiag({ consultThread: thread })).toBe("t#2");
  });

  it("returns undefined when nothing is displayable (byte-identical absence rule)", () => {
    expect(consultCacheMarker({})).toBeUndefined();
    expect(consultCacheMarkerOfDiag(undefined)).toBeUndefined();
    expect(consultCacheMarkerOfDiag({})).toBeUndefined();
    const plain: RunDiagnostics = {
      createdAt: 0,
      phase: "model_turn",
      phaseEnteredAt: 0,
      pendingTools: 0,
      turns: 1,
      escalation: [],
      orphaned: false,
      generation: 1,
      degraded: [],
      staleInputs: 0,
      unkillable: [],
    };
    expect(consultCacheMarkerOfDiag(plain)).toBeUndefined();
  });

  it("degrades malformed persisted values instead of throwing", () => {
    // unknown prediction state → `?`; unknown label → `…`; non-finite share → no percent
    expect(consultCacheMarker({ predicted: { state: "lukewarm" } })).toBe("?·…");
    expect(consultCacheMarker({ predicted: { state: "warm" }, first: { label: "smoke" } })).toBe("warm·…");
    expect(consultCacheMarker({ predicted: { state: "warm" }, first: { label: "hit", readShare: Number.NaN } })).toBe(
      "warm·hit",
    );
    expect(consultCacheMarker({ thread: { seq: 0 } })).toBeUndefined();
    expect(consultCacheMarker({ thread: { seq: 1.5 } })).toBeUndefined();
  });
});

describe("formatConsultCacheLine (get_subagent_result consult section)", () => {
  it("carries prediction, measurement, anchor and thread on one English line", () => {
    expect(
      formatConsultCacheLine({
        consultCache: cache("warm", first("hit", 0.962, { anchor: "added" })),
        consultThread: { threadId: "c7k9q2mx", seq: 2 },
      }),
    ).toBe("Consult cache: predicted warm; first request hit 96% read share; anchor added; thread c7k9q2mx #2");
  });

  it("shows pending state, n/a metric, reason and degraded facts", () => {
    expect(formatConsultCacheLine({ consultCache: cache("cold") })).toBe(
      "Consult cache: predicted cold; first response pending",
    );
    expect(formatConsultCacheLine({ consultCache: cache("unknown", first("n/a", null)) })).toBe(
      "Consult cache: predicted unknown; first request n/a",
    );
    // an `n/a` anchor (non-Anthropic route / no cache_control) adds no clause —
    // only real placements and skips are named.
    expect(formatConsultCacheLine({ consultCache: cache("warm", first("hit", 0.9, { anchor: "n/a" })) })).not.toContain(
      "anchor",
    );
    expect(
      formatConsultCacheLine({ consultCache: { v: 1, predicted: { state: "unknown", reason: "oauth-limit" } } }),
    ).toBe("Consult cache: predicted unknown (oauth-limit); first response pending");
    expect(
      formatConsultCacheLine({
        consultCache: cache("unknown", first("partial", 0.41, { anchor: "skipped:limit", degraded: true })),
      }),
    ).toBe("Consult cache: predicted unknown; first request partial 41% read share; anchor skipped:limit, degraded");
  });

  it("clips long thread ids and reasons, folds whitespace", () => {
    expect(formatConsultCacheLine({ consultThread: { threadId: "t".repeat(40), seq: 3 } })).toBe(
      `Consult cache: thread ${"t".repeat(23)}… #3`,
    );
    expect(formatConsultCacheLine({ consultCache: { v: 1, predicted: { state: "warm", reason: "a\nb  c" } } })).toBe(
      "Consult cache: predicted warm (a b c); first response pending",
    );
    expect(
      formatConsultCacheLine({ consultCache: { v: 1, predicted: { state: "warm", reason: "r".repeat(50) } } }),
    ).toBe(`Consult cache: predicted warm (${"r".repeat(31)}…); first response pending`);
  });

  it("returns undefined without the fields (byte-identical result text)", () => {
    expect(formatConsultCacheLine(undefined)).toBeUndefined();
    expect(formatConsultCacheLine({})).toBeUndefined();
  });
});
