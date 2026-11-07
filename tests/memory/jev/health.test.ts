// jev/health.test.ts — error classification, health table, token bucket,
// status summary, notify verdicts, coverage (jev-plan J2).

import { afterEach, describe, expect, it } from "vitest";
import {
  classifyError,
  clearHealthTable,
  coverage,
  createTokenBucket,
  errorCode,
  getHealthTable,
  notifyFor,
  summarizeStatus,
} from "../../../src/memory/jev/health.js";
import type { JevIndexV1 } from "../../../src/memory/jev/contracts.js";
import type { MemEntry } from "../../../src/memory/jev/contracts.js";

afterEach(() => clearHealthTable());

describe("classifyError", () => {
  it.each([
    ["System One API error (401): nope", "unavailable"],
    ["System One API error (402): Insufficient account funds", "unavailable"],
    ["System One API error (403): forbidden", "unavailable"],
    ["System One API error (451): Endpoint is unavailable", "unavailable"],
    ["System One API error (429): rate limited", "transient"],
    ["System One API error (500): boom", "transient"],
    ["System One API error (503): boom", "transient"],
    ["timeout after 5000ms", "transient"],
    ["proxy error: CONNECT failed (407)", "transient"],
    ["FreeTierError: nope", "unavailable"],
    ["Insufficient funds for this request", "unavailable"],
    ["some random unparseable error", "transient"],
    ["hit the maximum context length", "context"],
    ["too many tokens in request", "context"],
  ] as const)("%s -> %s", (msg, expected) => {
    expect(classifyError(msg)).toBe(expected);
  });

  it("context classification takes priority even with a status code present", () => {
    expect(classifyError("System One API error (400): maximum context exceeded")).toBe("context");
    // measured opencode wording (E0 C-J8): HTTP 400 + error_type max_tokens_exceeded
    expect(classifyError('System One API error (400): {"detail":{"error_type":"max_tokens_exceeded"}}')).toBe(
      "context",
    );
  });

  it("proxy error: prefix is always transient regardless of body", () => {
    expect(classifyError("proxy error: upstream returned 402 Insufficient funds")).toBe("transient");
  });

  it("errorCode extracts the 3-digit code or empty string", () => {
    expect(errorCode("System One API error (451): x")).toBe("451");
    expect(errorCode("no code here")).toBe("");
  });
});

describe("health table (process-level, ≤32, LRU eviction)", () => {
  it("get/set/entries/clear round-trip", () => {
    const table = getHealthTable();
    table.set("a/b", { state: "ok" });
    expect(table.get("a/b")).toEqual({ state: "ok" });
    expect(table.entries()).toEqual([["a/b", { state: "ok" }]]);
    table.clear();
    expect(table.entries()).toEqual([]);
  });

  it("clearHealthTable clears the shared table across instances", () => {
    getHealthTable().set("x/y", { state: "unavailable", until: 1 });
    clearHealthTable();
    expect(getHealthTable().get("x/y")).toBeUndefined();
  });

  it("evicts the oldest entry once the 32-entry cap is exceeded", () => {
    const table = getHealthTable();
    for (let i = 0; i < 33; i++) table.set(`m${i}`, { state: "unknown" });
    const entries = table.entries();
    expect(entries.length).toBe(32);
    expect(table.get("m0")).toBeUndefined();
    expect(table.get("m32")).toEqual({ state: "unknown" });
  });

  it("re-setting an existing key counts as a fresh (most-recent) entry, not a duplicate slot", () => {
    const table = getHealthTable();
    table.set("a", { state: "unknown" });
    for (let i = 0; i < 32; i++) table.set(`n${i}`, { state: "unknown" });
    table.set("a", { state: "ok" }); // moved to most-recent — should survive
    expect(table.get("a")).toEqual({ state: "ok" });
  });
});

describe("token bucket (30/60s, process-level shared)", () => {
  // The bucket's window state is process-level (Symbol-keyed), so every test
  // uses a `now` base far enough from any other test's range to force a
  // fresh window regardless of execution order.
  it("allows up to capacity within the window, then denies", () => {
    const bucket = createTokenBucket();
    let now = 10_000_000;
    for (let i = 0; i < 30; i++) expect(bucket.tryTake(now)).toBe(true);
    expect(bucket.tryTake(now)).toBe(false);
    now += 60_000; // next window
    expect(bucket.tryTake(now)).toBe(true);
  });

  it("two createTokenBucket() handles share the same process-level window", () => {
    const a = createTokenBucket();
    const b = createTokenBucket();
    const now = 20_000_000;
    for (let i = 0; i < 30; i++) expect(a.tryTake(now)).toBe(true);
    expect(b.tryTake(now)).toBe(false);
  });
});

describe("summarizeStatus", () => {
  const classifiers = ["opencode/jev-1.13-free", "opencode/jev-1.13"];
  function input(overrides: Partial<Parameters<typeof summarizeStatus>[0]> = {}) {
    return {
      classifiers,
      availability: new Map([
        ["opencode/jev-1.13-free", "available" as const],
        ["opencode/jev-1.13", "available" as const],
      ]),
      health: getHealthTable(),
      now: 1000,
      everSucceeded: false,
      budgetExhausted: false,
      inactive: false,
      ...overrides,
    };
  }

  it("empty classifier list -> off(empty-list)", () => {
    expect(summarizeStatus(input({ classifiers: [] }))).toEqual({ kind: "off", reason: "empty-list" });
  });

  it("budget exhausted -> partial(budget) regardless of health", () => {
    expect(summarizeStatus(input({ budgetExhausted: true }))).toEqual({
      kind: "partial",
      reason: "budget",
      inactive: false,
    });
  });

  it("available but never succeeded -> probing", () => {
    expect(summarizeStatus(input())).toEqual({ kind: "probing" });
  });

  it("succeeded once -> full(model)", () => {
    expect(summarizeStatus(input({ everSucceeded: true, lastModel: "opencode/jev-1.13" }))).toEqual({
      kind: "full",
      model: "opencode/jev-1.13",
    });
  });

  it("all isolated (unavailable, still within `until`) -> partial with retryAt", () => {
    const health = getHealthTable();
    health.set("opencode/jev-1.13-free", { state: "unavailable", until: 5000, code: "451" });
    health.set("opencode/jev-1.13", { state: "unavailable", until: 6000, code: "402" });
    expect(summarizeStatus(input({ health, now: 1000 }))).toEqual({
      kind: "partial",
      reason: "451",
      inactive: false,
      retryAt: 5000,
    });
  });

  it("isolation past its `until` is treated as usable (unknown)", () => {
    const health = getHealthTable();
    health.set("opencode/jev-1.13-free", { state: "unavailable", until: 500 });
    health.set("opencode/jev-1.13", { state: "unavailable", until: 500 });
    expect(summarizeStatus(input({ health, now: 1000 }))).toEqual({ kind: "probing" });
  });

  it("all no-auth/not-found -> partial with caller-supplied `inactive`", () => {
    const availability = new Map([
      ["opencode/jev-1.13-free", "no-auth" as const],
      ["opencode/jev-1.13", "not-found" as const],
    ]);
    expect(summarizeStatus(input({ availability, inactive: true }))).toEqual({
      kind: "partial",
      reason: "no-auth",
      inactive: true,
    });
  });
});

describe("notifyFor", () => {
  const ctxBase = { firstFullNotified: false, notifiedPartialReasons: new Set<string>(), hasCredentials: true };

  it("first transition into full (no prior status this activation) -> first-full", () => {
    expect(notifyFor(undefined, { kind: "full", model: "m" }, ctxBase)).toBe("first-full");
  });

  it("probing -> full with first-full already notified -> no further notification", () => {
    expect(
      notifyFor({ kind: "probing" }, { kind: "full", model: "m" }, { ...ctxBase, firstFullNotified: true }),
    ).toBeUndefined();
  });

  it("full -> partial (new reason) -> degraded", () => {
    expect(
      notifyFor(
        { kind: "full", model: "m" },
        { kind: "partial", reason: "451", inactive: false },
        { ...ctxBase, firstFullNotified: true },
      ),
    ).toBe("degraded");
  });

  it("full -> partial (already-notified reason) -> no repeat", () => {
    expect(
      notifyFor(
        { kind: "full", model: "m" },
        { kind: "partial", reason: "451", inactive: false },
        { ...ctxBase, firstFullNotified: true, notifiedPartialReasons: new Set(["451"]) },
      ),
    ).toBeUndefined();
  });

  it("partial -> full (after first-full already fired) -> recovered", () => {
    expect(
      notifyFor(
        { kind: "partial", reason: "451", inactive: false },
        { kind: "full", model: "m" },
        { ...ctxBase, firstFullNotified: true },
      ),
    ).toBe("recovered");
  });

  it("inactive partial is never notified, even on startup", () => {
    expect(notifyFor(undefined, { kind: "partial", reason: "no-auth", inactive: true }, ctxBase)).toBeUndefined();
  });

  it("startup directly into partial with credentials -> startup-partial", () => {
    expect(notifyFor(undefined, { kind: "partial", reason: "451", inactive: false }, ctxBase)).toBe("startup-partial");
  });

  it("startup directly into partial without credentials -> no notification", () => {
    expect(
      notifyFor(
        undefined,
        { kind: "partial", reason: "no-auth", inactive: false },
        { ...ctxBase, hasCredentials: false },
      ),
    ).toBeUndefined();
  });
});

describe("coverage", () => {
  function entry(hash: string, isPrivate = false): MemEntry {
    return {
      file: "a.md",
      section: "",
      ordinal: 1,
      lineStart: 1,
      lineEnd: 1,
      raw: "x",
      body: "x",
      hash,
      guardHash: "g",
      inline: isPrivate ? { present: true, isPrivate: true } : { present: false },
      inlineErrors: [],
      authority: "agent",
      fileStatus: "active",
      secret: false,
      namedPrograms: [],
    };
  }
  function indexWith(hashes: readonly string[]): JevIndexV1 {
    return {
      v: 1,
      entries: Object.fromEntries(
        hashes.map((h) => [
          h,
          {
            file: "a.md",
            type: "fact",
            typeP: 1,
            importance: 1,
            tags: {},
            guard: 0,
            temporal: "permanent",
            userLike: 0,
            model: "m",
            at: "2026-10-30",
            taxonomyRev: "r",
          },
        ]),
      ),
    };
  }

  it("counts tagged/total/pending over non-private entries only", () => {
    const entries = [entry("h1"), entry("h2"), entry("h3", true)];
    const index = indexWith(["h1"]);
    expect(coverage(entries, index)).toEqual({ tagged: 1, total: 2, pending: 1 });
  });

  it("empty corpus -> zeros", () => {
    expect(coverage([], { v: 1, entries: {} })).toEqual({ tagged: 0, total: 0, pending: 0 });
  });
});
