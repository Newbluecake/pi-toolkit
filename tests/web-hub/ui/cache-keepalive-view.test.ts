// @vitest-environment happy-dom
/**
 * `cacheKeepaliveView.ts` (cache-keepalive-web plan §4.3, P-B). The agent side (P-A) isn't
 * wired yet, so every wire is a handwritten fixture typed against the frozen P0 contract
 * (`@protocol/messages.js`, commit 95f7a6f). Covers: `cacheKeepaliveOf` narrowing (missing `v`,
 * wrong `v`, non-array `lines`, non-object slot ⇒ undefined), `markerText`'s TUI-parallel
 * assembly (modeText + ping head + locally-computed `·retry`/`·tN`, `keepalive off` when
 * disabled, elapsed `retryAt` omitted), `formatMsShort` against the SHARED vector fixture
 * (read once by the agent side's own suite — any drift on either side turns both red),
 * `markerTone` for every known `ping.state` plus arbitrary unknown values (open string ⇒
 * neutral, never throws), unknown `mode`/`kind` fallbacks, `lineRows`/`hasPendingRetry`, and
 * `lastPingAgeText` (browser-clock age, future `at` ⇒ undefined).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CacheKeepaliveWire } from "../../../src/web-hub/protocol/messages.js";
import type { AgentState } from "../../../src/web-hub/ui/src/types.js";
import {
  cacheKeepaliveOf,
  formatMsShort,
  hasPendingRetry,
  lastPingAgeText,
  lastPingView,
  lineRows,
  markerText,
  markerTone,
  modeToken,
  formatTokenCount,
  formatCacheCost,
} from "../../../src/web-hub/ui/src/components/detail/cacheKeepaliveView.js";

const NOW = 1_700_000_000_000;

const wire = (over: Record<string, unknown> = {}): CacheKeepaliveWire =>
  ({
    v: 1,
    at: NOW,
    mode: "on",
    dirty: true,
    enabled: true,
    modeText: "cache 1h*",
    ping: { text: "ping off:http 403", state: "line-off", retryAt: NOW + 25 * 60_000, tail: "·t3" },
    window: { pings: 3, max: 11 },
    session: {
      pings: 12,
      cacheReadTokens: 450_000,
      costUsd: 0.12,
      avoidedMissTokens: 1_234,
      loadBearingWindows: 2,
      unnecessaryWindows: 1,
      discardedWindows: 0,
    },
    lastPing: { at: NOW - 5 * 60_000, kind: "http", status: 403, transient: true, attempts: 3 },
    lines: [
      {
        label: "cr-anthropic/claude-opus-5-5@api.example.com",
        open: true,
        status: 403,
        trips: 3,
        retryAt: NOW + 25 * 60_000,
        current: true,
      },
    ],
    ...over,
  }) as unknown as CacheKeepaliveWire;

const agent = (w: unknown): Pick<AgentState, "status"> =>
  ({ status: { busy: false, pending: false, cacheKeepalive: w } }) as unknown as Pick<AgentState, "status">;

describe("cacheKeepaliveOf (narrowing, plan §4.1)", () => {
  it("returns the wire for a well-formed v1 frame", () => {
    const w = wire();
    expect(cacheKeepaliveOf(agent(w))).toBe(w);
  });

  it("returns undefined when the slot is absent (legacy agent / silent projection)", () => {
    expect(cacheKeepaliveOf({ status: { busy: false, pending: false } } as never)).toBeUndefined();
  });

  it("returns undefined for malformed slots: wrong v, non-array lines, non-object", () => {
    expect(cacheKeepaliveOf(agent(undefined))).toBeUndefined();
    expect(cacheKeepaliveOf(agent("nope"))).toBeUndefined();
    expect(cacheKeepaliveOf(agent({ v: 2, lines: [] }))).toBeUndefined();
    expect(cacheKeepaliveOf(agent({ v: 1, lines: "x" }))).toBeUndefined();
    expect(cacheKeepaliveOf(agent({ v: 1 }))).toBeUndefined();
    // null slot (explicit) — treated as absent, never as a renderable wire
    expect(cacheKeepaliveOf(agent(null))).toBeUndefined();
  });
});

describe("markerText (TUI-parallel assembly, plan §2/§4.2)", () => {
  it("modeText + ping head + ·retry + tail in the TUI's exact order", () => {
    expect(markerText(wire(), NOW)).toBe("cache 1h* · ping off:http 403 ·retry 25m ·t3");
  });

  it("active form: cache 5m · ping 3/11 Σ12 · 450k · ≈$0.12", () => {
    const w = wire({
      mode: "off",
      dirty: false,
      enabled: true,
      modeText: "cache 5m",
      ping: { text: "ping 3/11 Σ12 · 450k · ≈$0.12", state: "active" },
      lines: [],
    });
    expect(markerText(w, NOW)).toBe("cache 5m · ping 3/11 Σ12 · 450k · ≈$0.12");
  });

  it("session-level disabled form: `ping off:http 403 ×7` (no retry/tail)", () => {
    const w = wire({
      ping: { text: "ping off:http 403 ×7", state: "disabled" },
      session: {
        pings: 7,
        cacheReadTokens: 0,
        avoidedMissTokens: 0,
        loadBearingWindows: 0,
        unnecessaryWindows: 0,
        discardedWindows: 0,
      },
      lines: [],
    });
    expect(markerText(w, NOW)).toBe("cache 1h* · ping off:http 403 ×7");
  });

  it("window-level stopped form survives as a known state (label reads `ping miss:<reason>` since the 2026-10-16 rename — same wording as the TUI)", () => {
    const w = wire({ ping: { text: "ping miss:network", state: "paused" }, lines: [] });
    expect(markerText(w, NOW)).toBe("cache 1h* · ping miss:network");
  });

  it("elapsed retryAt ⇒ no `·retry` (the expanded rows show `eligible now` instead)", () => {
    const w = wire({ ping: { text: "ping off:http 403", state: "line-off", tail: "·t2" } });
    expect(markerText(w, NOW)).toBe("cache 1h* · ping off:http 403 ·t2");
  });

  it("counts down as the browser clock advances (retryAt is absolute, value never in the wire fingerprint)", () => {
    const w = wire();
    expect(markerText(w, NOW + 20 * 60_000)).toBe("cache 1h* · ping off:http 403 ·retry 5m ·t3");
    expect(markerText(w, NOW + 25 * 60_000)).toBe("cache 1h* · ping off:http 403 ·t3"); // exactly elapsed
  });

  it("enabled:false appends the `keepalive off` token (D6); ping absent ⇒ mode only", () => {
    const off = wire({ enabled: false, ping: undefined, lines: [] });
    expect(markerText(off, NOW)).toBe("cache 1h* · keepalive off");
    const noPing = wire({ ping: undefined, lines: [] });
    expect(markerText(noPing, NOW)).toBe("cache 1h*");
  });

  it("missing modeText (auto) falls back to ping only", () => {
    const w = wire({ modeText: undefined, ping: { text: "ping 1/11", state: "active" } });
    expect(markerText(w, NOW)).toBe("ping 1/11");
  });
});

describe("formatMsShort (shared vector fixture — the agent suite reads the same file)", () => {
  const fixture = JSON.parse(
    readFileSync(
      resolve(fileURLToPath(import.meta.url), "../../../fixtures/cache-keepalive-format-vectors.json"),
      "utf8",
    ),
  ) as { _comment: string; cases: Array<[number, string]> };

  it("the fixture exists and carries cases (glob-failure canary)", () => {
    expect(Array.isArray(fixture.cases)).toBe(true);
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  it.each(fixture.cases)("formatMsShort(%d) === %s", (ms, expected) => {
    expect(formatMsShort(ms)).toBe(expected);
  });

  it("non-finite values clamp to 0m (UI-side guard)", () => {
    expect(formatMsShort(Number.NaN)).toBe("0m");
    expect(formatMsShort(Number.POSITIVE_INFINITY)).toBe("0m");
  });
});

describe("markerTone (open `ping.state`, plan §0.5)", () => {
  it("known states: bad for line-off/disabled, warn for paused/capped, neutral for active", () => {
    expect(markerTone(wire({ ping: { text: "x", state: "line-off" } }))).toBe("bad");
    expect(markerTone(wire({ ping: { text: "x", state: "disabled" } }))).toBe("bad");
    expect(markerTone(wire({ ping: { text: "x", state: "paused" } }))).toBe("warn");
    expect(markerTone(wire({ ping: { text: "x", state: "capped" } }))).toBe("warn");
    expect(markerTone(wire({ ping: { text: "x", state: "active" } }))).toBe("neutral");
  });

  it("ANY unknown state value is neutral and never throws (a future wire must not break an old UI)", () => {
    expect(markerTone(wire({ ping: { text: "x", state: "super-off" } }))).toBe("neutral");
    expect(markerTone(wire({ ping: { text: "x", state: "" } }))).toBe("neutral");
  });

  it("no ping segment ⇒ neutral", () => {
    expect(markerTone(wire({ ping: undefined }))).toBe("neutral");
  });
});

describe("lineRows / hasPendingRetry", () => {
  it("reduces rows, clamps trips, keeps current/wildcard/open flags", () => {
    const rows = lineRows(
      wire({
        lines: [
          { label: "a@h", open: true, status: 403, trips: 3, retryAt: NOW + 60_000, current: true },
          { label: "* legacy", open: false, trips: 1, wildcard: true },
          { label: "b@h", open: true, trips: 2 },
        ],
      }),
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ label: "a@h", open: true, status: 403, trips: 3, current: true, wildcard: false });
    expect(rows[1]).toMatchObject({ open: false, wildcard: true, current: false });
    expect(rows[2]?.retryAt).toBeUndefined();
  });

  it("skips null/non-object rows (open frames never crash the UI)", () => {
    const rows = lineRows(wire({ lines: [null, "x", { label: "a@h", open: false, trips: 0 }] as never }));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("a@h");
  });

  it("hasPendingRetry: ping retryAt, line retryAt, elapsed ⇒ false", () => {
    expect(hasPendingRetry(wire(), NOW)).toBe(true); // ping + line both future
    expect(hasPendingRetry(wire({ ping: { text: "x", state: "line-off" } }), NOW)).toBe(true); // line row only
    expect(hasPendingRetry(wire({ lines: [{ label: "a", open: true, trips: 1, retryAt: NOW + 1_000 }] }), NOW)).toBe(
      true,
    );
    expect(hasPendingRetry(wire({ ping: { text: "x", state: "line-off" }, lines: [] }), NOW)).toBe(false);
    expect(hasPendingRetry(wire(), NOW + 25 * 60_000)).toBe(false); // both elapsed
  });
});

describe("lastPingView / lastPingAgeText / formatting helpers", () => {
  it("lastPingView reduces the wire's lastPing; malformed ⇒ undefined", () => {
    expect(lastPingView(wire())).toMatchObject({ kind: "http", status: 403, transient: true, attempts: 3 });
    expect(lastPingView(wire({ lastPing: { at: NOW, kind: "network" } }))).toMatchObject({
      kind: "network",
      status: undefined,
      transient: undefined,
    });
    expect(lastPingView(wire({ lastPing: undefined }))).toBeUndefined();
    expect(lastPingView(wire({ lastPing: { kind: "http" } as never }))).toBeUndefined(); // no at
    expect(lastPingView(wire({ lastPing: { at: "x", kind: "http" } as never }))).toBeUndefined();
  });

  it("lastPingAgeText: browser-clock age, future at ⇒ undefined (skew guard)", () => {
    expect(lastPingAgeText(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(lastPingAgeText(NOW - 30_000, NOW)).toBe("<1m ago");
    expect(lastPingAgeText(NOW + 60_000, NOW)).toBeUndefined();
  });

  it("unknown kinds pass through verbatim (open string)", () => {
    expect(lastPingView(wire({ lastPing: { at: NOW, kind: "quantum-flux" } }))?.kind).toBe("quantum-flux");
  });

  it("formatTokenCount / formatCacheCost mirror the TUI's 口径", () => {
    expect(formatTokenCount(450_000)).toBe("450k");
    expect(formatTokenCount(1_234_567)).toBe("1.2m");
    expect(formatTokenCount(890)).toBe("890");
    expect(formatTokenCount(-5)).toBe("0");
    expect(formatCacheCost(0.12)).toBe("≈$0.12");
    expect(formatCacheCost(undefined)).toBe("—");
  });

  it("modeToken: unknown mode falls through unchanged; dirty adds `*`", () => {
    expect(modeToken("on", true)).toBe("on*");
    expect(modeToken("auto", false)).toBe("auto");
    expect(modeToken("future-mode", false)).toBe("future-mode");
  });
});
