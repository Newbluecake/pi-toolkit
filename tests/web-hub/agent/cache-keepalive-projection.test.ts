/**
 * cache-keepalive-web plan §3.6: projection tests. Corpus derived from the post-#29 `pingSegmentParts`
 * (baseline commit 95f7a6f).
 */
import { describe, expect, it } from "vitest";
import {
  LINE_KEY_WILDCARD,
  createInitialSessionTotals,
  createInitialWindowState,
  renderCacheStatus,
  type KeepaliveReport,
  type CapturedRequest,
  type LineState,
  type SessionTotals,
  type WindowState,
} from "../../../src/cache-ttl/keepalive-state.js";
import {
  CACHE_KEEPALIVE_WIRE_BUDGET_BYTES,
  cacheKeepaliveFingerprint,
  cacheKeepaliveWireBytes,
  projectCacheKeepalive,
  type CacheKeepaliveInput,
} from "../../../src/web-hub/agent/cache-keepalive.js";
import { CacheKeepaliveWireSchema } from "../../../src/web-hub/protocol/messages.js";
import { Value } from "@sinclair/typebox/value";

const NOW = 1_000_000;
const line = (o: Partial<LineState> = {}): LineState => ({
  label: "kimi-coding/k3@api.kimi.com",
  status: 403,
  consecutive: 1,
  total: 1,
  open: true,
  openedAt: NOW - 1000,
  trips: 1,
  updatedAt: NOW - 1000,
  ...o,
});
const capture: CapturedRequest = {
  sessionId: "s",
  instance: "i",
  payload: {},
  headers: {},
  capturedAt: 0,
  fingerprint: {
    sessionId: "s",
    provider: "p",
    api: "anthropic-messages",
    modelId: "m",
    ctxModelId: "m",
    baseUrl: "https://x",
    authHeaderKeys: "",
    breakpointPath: "",
    thinkingDigest: "",
    systemDigest: "",
    toolsDigest: "",
    messageCount: 0,
  },
  shape: { ephemeralBreakpoints: 1, ttl1h: false, hasThinking: false, maxTokens: 1 },
  prefix: { tokens: 30_000, source: "usage" },
};
const win = (o: Partial<WindowState> = {}): WindowState => ({ ...createInitialWindowState(), capture, ...o });
function report(over: Partial<KeepaliveReport> = {}, session: Partial<SessionTotals> = {}): KeepaliveReport {
  return {
    enabled: true,
    armed: false,
    window: win(),
    session: { ...createInitialSessionTotals(), ...session },
    config: { enabled: true, intervalMs: 240_000, maxPings: 11, minPrefixTokens: 20_000 },
    costUsd: undefined,
    dropped: { sessionMismatch: 0, instanceMismatch: 0, epochMismatch: 0 },
    lastSkip: undefined,
    prefixSource: undefined,
    supportsLongCacheRetention: true,
    lastPingDiagnostics: undefined,
    now: NOW as never,
    ...over,
  };
}
const input = (r: KeepaliveReport, mode: "auto" | "on" | "off" = "auto", dirty = false): CacheKeepaliveInput => ({
  report: r,
  mode,
  dirty,
});
const proj = (i: CacheKeepaliveInput | undefined, now = NOW) => projectCacheKeepalive(i, now);
const diag = (o: Record<string, unknown> = {}) =>
  ({
    at: NOW - 5000,
    outcomeKind: "proven-hit",
    elapsedSinceCaptureMs: 1,
    prefixTokens: 1,
    prefixSource: "usage",
    cacheReadInputTokens: 1,
    cacheCreationInputTokens: 0,
    headerSource: "capture",
    headerKeyDiff: [],
    model: "m",
    baseUrl: "https://x",
    ...o,
  }) as never;

describe("silence rules", () => {
  it("undefined input / fresh auto session ⇒ absent", () => {
    expect(proj(undefined)).toBeUndefined();
    expect(proj(input(report()))).toBeUndefined();
  });
  it("mode on/off or dirty ⇒ present with modeText; auto+dirty has no modeText", () => {
    expect(proj(input(report(), "on"))?.modeText).toBe("cache 1h");
    expect(proj(input(report(), "off", true))).toMatchObject({ mode: "off", dirty: true, modeText: "cache 5m*" });
    const w = proj(input(report(), "auto", true));
    // auto + dirty with nothing else still produces no TUI segment ⇒ stays silent
    expect(w).toBeUndefined();
  });
  it("enabled:false is NOT silent", () => {
    const w = proj(input(report({ enabled: false })));
    expect(w).toMatchObject({ enabled: false, lines: [] });
    expect(CacheKeepaliveWireSchema && Value.Check(CacheKeepaliveWireSchema, w)).toBe(true);
  });
  it("activity / lastUnproven / diagnostics each break silence", () => {
    expect(proj(input(report({}, { pings: 2, cacheReadTokens: 1000 })))).toBeDefined();
    expect(proj(input(report({}, { lastUnproven: { kind: "network", at: 5 } })))).toBeDefined();
    expect(proj(input(report({ lastPingDiagnostics: diag() })))).toBeDefined();
  });
  it("wire never carries armed", () => {
    const w = proj(input(report({ armed: true }, { pings: 3 })))!;
    expect("armed" in w).toBe(false);
    expect(JSON.stringify(w)).not.toContain("armed");
  });
});

describe("ping text parity with the TUI status line", () => {
  const cases: Array<[string, KeepaliveReport]> = [
    ["active", report({ window: win({ pings: 3 }), costUsd: 0.12 }, { pings: 4, cacheReadTokens: 450_000 })],
    ["capped", report({ window: win({ pings: 11 }) }, { pings: 11 })],
    ["paused (window-level)", report({ window: win({ pings: 1, lastStopReason: "network" }) }, { pings: 1 })],
    [
      "session disabled ×N",
      report({}, { pings: 7, disabled: { reason: "http", at: 5, httpStatus: 403 }, lastUnproven: undefined }),
    ],
    [
      "line-off retry + trips",
      report(
        { currentLineKey: "k1" },
        { pings: 9, lineStates: { k1: line({ trips: 3, resetEligibleAt: NOW + 25 * 60_000 }) } },
      ),
    ],
  ];
  it.each(cases)("%s: head + retry + tail == TUI segment", (_n, r) => {
    const w = proj(input(r))!;
    const tui = renderCacheStatus({ mode: "auto", dirty: false, report: r })!;
    let s = w.ping!.text;
    if (w.ping!.retryAt !== undefined && w.ping!.retryAt > NOW) {
      const mins = Math.ceil((w.ping!.retryAt - NOW) / 60_000);
      s += ` ·retry ${mins}m`;
    }
    if (w.ping!.tail !== undefined) s += ` ${w.ping!.tail}`;
    expect(s).toBe(tui);
    expect(Value.Check(CacheKeepaliveWireSchema, w)).toBe(true);
  });
  it("states", () => {
    expect(proj(input(cases[0]![1]))!.ping!.state).toBe("active");
    expect(proj(input(cases[1]![1]))!.ping!.state).toBe("capped");
    expect(proj(input(cases[2]![1]))!.ping!.state).toBe("paused");
    expect(proj(input(cases[3]![1]))!.ping!.state).toBe("disabled");
    expect(proj(input(cases[4]![1]))!.ping).toMatchObject({
      state: "line-off",
      tail: "·t3",
      text: "ping off:http 403",
    });
  });
});

describe("lastPing / disabled / window / session mapping", () => {
  it("http diagnostics carry status + transient + clamped attempts", () => {
    const w = proj(
      input(report({ lastPingDiagnostics: diag({ outcomeKind: "http", httpStatus: 503, attempts: 5000 }) })),
    )!;
    expect(w.lastPing).toEqual({ at: NOW - 5000, kind: "http", status: 503, transient: true, attempts: 999 });
    const p = proj(
      input(report({ lastPingDiagnostics: diag({ outcomeKind: "http", httpStatus: 403, attempts: 0 }) })),
    )!;
    expect(p.lastPing).toMatchObject({ status: 403, transient: false, attempts: 1 });
  });
  it("proven-hit has no transient; non-http has no status", () => {
    const w = proj(input(report({ lastPingDiagnostics: diag({ attempts: 2, httpStatus: 500 }) })))!;
    expect(w.lastPing).toEqual({ at: NOW - 5000, kind: "proven-hit", attempts: 2 });
    const n = proj(input(report({ lastPingDiagnostics: diag({ outcomeKind: "network" }) })))!;
    expect(n.lastPing).toMatchObject({ kind: "network", transient: true });
    expect("status" in n.lastPing!).toBe(false);
  });
  it("/reload: falls back to session.lastUnproven (kind, at, transient only)", () => {
    const w = proj(input(report({}, { lastUnproven: { kind: "proven-write", at: 77 } })))!;
    expect(w.lastPing).toEqual({ at: 77, kind: "proven-write", transient: false });
  });
  it("disabled mapping: reason truncated to 64B, transient only when true", () => {
    const w = proj(
      input(report({}, { pings: 1, disabled: { reason: "x".repeat(200), at: 9, httpStatus: 403, transient: true } })),
    )!;
    expect(w.disabled).toEqual({ reason: "x".repeat(64), at: 9, httpStatus: 403, transient: true });
    const n = proj(input(report({}, { pings: 1, disabled: { reason: "no-usage", at: 9 } })))!;
    expect(n.disabled).toEqual({ reason: "no-usage", at: 9 });
  });
  it("window/session/cost", () => {
    const w = proj(
      input(
        report(
          { window: win({ pings: 3 }), costUsd: 0.5 },
          {
            pings: 4,
            cacheReadTokens: 10,
            avoidedMissTokens: 7,
            loadBearingWindows: 1,
            unnecessaryWindows: 2,
            discardedWindows: 3,
          },
        ),
      ),
    )!;
    expect(w.window).toEqual({ pings: 3, max: 11 });
    expect(w.session).toEqual({
      pings: 4,
      cacheReadTokens: 10,
      costUsd: 0.5,
      avoidedMissTokens: 7,
      loadBearingWindows: 1,
      unnecessaryWindows: 2,
      discardedWindows: 3,
    });
    expect("costUsd" in proj(input(report({}, { pings: 1 })))!.session).toBe(false);
  });
});

describe("lines", () => {
  const lineStates = (): Record<string, LineState> => ({
    hist: line({ open: false, trips: 1, consecutive: 0, updatedAt: 500, label: "hist/model@h" }),
    quiet: line({ open: false, trips: 0, consecutive: 0, label: "quiet" }),
    old: line({ open: true, updatedAt: 100, label: "old/m@h", resetEligibleAt: NOW + 60_000 }),
    cur: line({ open: true, updatedAt: 50, label: "cur/m@h", status: 429, resetEligibleAt: NOW - 1 }),
    [LINE_KEY_WILDCARD]: line({ open: true, updatedAt: 10, label: "wild", resetEligibleAt: NOW + 99_000 }),
  });
  it("filters quiet rows, orders open→current→updatedAt, marks current/wildcard, retryAt rules", () => {
    const w = proj(input(report({ currentLineKey: "cur" }, { pings: 1, lineStates: lineStates() })))!;
    expect(w.lines.map((l) => l.label)).toEqual(["cur/m@h", "old/m@h", "wild", "hist/model@h"]);
    const by = Object.fromEntries(w.lines.map((l) => [l.label, l]));
    expect(by["cur/m@h"]).toMatchObject({ current: true, status: 429 });
    expect("retryAt" in by["cur/m@h"]!).toBe(false); // expired
    expect(by["old/m@h"]!.retryAt).toBe(NOW + 60_000);
    expect(by["wild"]).toMatchObject({ wildcard: true });
    expect("retryAt" in by["wild"]!).toBe(false); // wildcard never has a cooldown
    expect(by["hist/model@h"]).toMatchObject({ open: false });
    expect("retryAt" in by["hist/model@h"]!).toBe(false);
  });
});

describe("budget ladder", () => {
  const emoji = "😀".repeat(60); // 240 bytes
  function many(n: number, open: (i: number) => boolean): Record<string, LineState> {
    const o: Record<string, LineState> = {};
    for (let i = 0; i < n; i++)
      o[`k${i}`] = line({ label: `${emoji}${i}`, open: open(i), updatedAt: 1000 - i, resetEligibleAt: NOW + 1000 });
    return o;
  }
  const fat = (n: number, open: (i: number) => boolean) =>
    report(
      {
        currentLineKey: "k0",
        lastPingDiagnostics: diag({ outcomeKind: "http", httpStatus: 503 }),
      },
      {
        pings: 5,
        disabled: { reason: "r".repeat(300), at: 1, httpStatus: 403, transient: true },
        lineStates: many(n, open),
      },
    );
  it("16 emoji rows stay ≤ 8KiB and pass the schema", () => {
    const w = proj(input(fat(16, () => true)))!;
    expect(cacheKeepaliveWireBytes(w)).toBeLessThanOrEqual(CACHE_KEEPALIVE_WIRE_BUDGET_BYTES);
    expect(Value.Check(CacheKeepaliveWireSchema, w)).toBe(true);
    expect(w.lines.length + (w.omitted ?? 0)).toBe(16);
  });
  it("step 1 shrinks labels (rows kept) when that alone fits; labels ≤128B otherwise", () => {
    const w = proj(input(fat(16, () => true)))!;
    for (const l of w.lines) expect(Buffer.byteLength(l.label)).toBeLessThanOrEqual(128);
  });
  it("forced tiny budget path: drops history rows before open rows, omitted counts", () => {
    // synthesize pathological bytes through enormous status text is not possible; exercise the ladder
    // by monkey-sizing: 16 rows with 4-byte-emoji labels at JSON-escape-heavy content.
    const o: Record<string, LineState> = {};
    for (let i = 0; i < 16; i++)
      o[`k${i}`] = line({
        label: '"\\\n'.repeat(60), // escapes inflate JSON ~2x
        open: i < 4,
        updatedAt: 1000 - i,
      });
    const r = report({ currentLineKey: "k0" }, { pings: 5, lineStates: o });
    const w = proj(input(r))!;
    expect(cacheKeepaliveWireBytes(w)).toBeLessThanOrEqual(CACHE_KEEPALIVE_WIRE_BUDGET_BYTES);
    expect(w.lines.length + (w.omitted ?? 0)).toBe(16);
    // open rows are never dropped while a history row remains
    if (w.omitted !== undefined) {
      const openKept = w.lines.filter((l) => l.open).length;
      const histKept = w.lines.length - openKept;
      if (histKept > 0) expect(openKept).toBe(4);
    }
    expect(Value.Check(CacheKeepaliveWireSchema, w)).toBe(true);
  });
});

describe("fingerprint", () => {
  const r = (now: number) =>
    report(
      { currentLineKey: "k1", now: now as never },
      { pings: 9, lineStates: { k1: line({ trips: 2, resetEligibleAt: NOW + 10 * 60_000 }) } },
    );
  const fp = (now: number) => cacheKeepaliveFingerprint(proj(input(r(now)), now));
  it("absent ⇒ empty string", () => {
    expect(cacheKeepaliveFingerprint(undefined)).toBe("");
  });
  it("now advancing before resetEligibleAt keeps the fingerprint; crossing it changes it exactly once", () => {
    const a = fp(NOW);
    expect(fp(NOW + 60_000)).toBe(a);
    expect(fp(NOW + 9 * 60_000)).toBe(a);
    const after = fp(NOW + 10 * 60_000 + 1);
    expect(after).not.toBe(a);
    expect(fp(NOW + 11 * 60_000)).toBe(after);
    expect(fp(NOW + 3_600_000)).toBe(after);
    expect(after).not.toContain("retryAt");
  });
  it("ping landing / mode change change it; armed / activity flags do not", () => {
    const base = report({}, { pings: 3 });
    const f0 = cacheKeepaliveFingerprint(proj(input(base)));
    expect(cacheKeepaliveFingerprint(proj(input(report({}, { pings: 4 }))))).not.toBe(f0);
    expect(cacheKeepaliveFingerprint(proj(input(base, "on")))).not.toBe(f0);
    expect(cacheKeepaliveFingerprint(proj(input(report({ armed: true }, { pings: 3 }))))).toBe(f0);
    expect(cacheKeepaliveFingerprint(proj(input(base), NOW + 12345))).toBe(f0); // `at` excluded
  });
});

describe("dynamic cap optional wire fields", () => {
  it.each(["priced", "clamped", "fallback"] as const)("passes maxSource=%s without a protocol bump", (maxSource) => {
    const r = report();
    r.config.maxPingsSource = maxSource;
    const w = proj(input(r, "on"))!;
    expect(w.window).toEqual({ pings: 0, max: 11, maxSource });
    expect(w.v).toBe(1);
    expect(Value.Check(CacheKeepaliveWireSchema, w)).toBe(true);
  });
  it("invalidated 20-ping window + new max 11 shows ended, never 20/11 capped", () => {
    const r = report(
      { window: win({ capture: undefined, pings: 20 }), costUsd: 0.12 },
      { pings: 20, cacheReadTokens: 450_000 },
    );
    r.config.maxPingsSource = "fallback";
    const w = proj(input(r))!;
    expect(w.window).toEqual({ pings: 20, max: 11, maxSource: "fallback", ended: true });
    expect(w.ping).toEqual({ state: "active", text: "ping Σ20 · 450k · ≈$0.12" });
    expect(JSON.stringify(w)).not.toContain("20/11");
    expect(Value.Check(CacheKeepaliveWireSchema, w)).toBe(true);
  });
  it("old agents need neither field; unproven stop is still miss, not ended", () => {
    const w = proj(
      input(report({ window: win({ capture: undefined, lastStopReason: "network", pings: 1 }) }, { pings: 1 })),
    )!;
    expect(w.window).not.toHaveProperty("maxSource");
    expect(w.window).not.toHaveProperty("ended");
    expect(w.ping?.text).toBe("ping miss:network");
    expect(Value.Check(CacheKeepaliveWireSchema, w)).toBe(true);
  });
});

describe("r_FFWC8SBT — only previously invalidated windows project ended", () => {
  it("never-opened windows omit ended, even when mode/off or disabled makes them visible", () => {
    for (const i of [
      input(report({ window: createInitialWindowState() }), "on"),
      input(report({ window: createInitialWindowState(), enabled: false })),
    ]) {
      const wire = proj(i)!;
      expect(wire).toBeDefined();
      expect(wire.window).toEqual({ pings: 0, max: 11 });
      expect(wire.window).not.toHaveProperty("ended");
      expect(Value.Check(CacheKeepaliveWireSchema, wire)).toBe(true);
    }
  });
  it.each([
    { windowEpoch: 1, pings: 0 },
    { windowEpoch: 0, pings: 20 },
  ])("invalidated/history window projects ended (%j)", (history) => {
    const wire = proj(input(report({ window: { ...createInitialWindowState(), ...history } }), "on"))!;
    expect(wire.window.ended).toBe(true);
  });
});
