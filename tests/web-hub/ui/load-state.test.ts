/**
 * `@logic/state.js`'s LOAD-specific reducer surface (sysload plan docs/dev/sysload/plan.md
 * §7.4/§10, package P4) — the `"load"`/`"load_top_start"`/`"load_top_ok"`/`"load_top_error"`
 * cases, the `"hello"`/`"hub"` clearing rules, and the `status.loadGate` mirror. Mirrors
 * `logic-state.test.ts`'s harness (`reduce`/`initialState`) without touching that shared file
 * (out of this package's file domain — a new file keeps the `load*.test.ts` glob happy).
 */
import { describe, expect, it } from "vitest";
import { initialState, reduce } from "../../../src/web-hub/ui/src/logic/state.js";

type Msg = { event: string; data: any; id?: number; at?: number };
const run = (msgs: Msg[], s = initialState(null)) => msgs.reduce((acc, m) => reduce(acc, m), s);

const card = (agentKey: string, extra: Record<string, unknown> = {}) => ({
  agentKey,
  kind: "tui",
  pid: 1,
  cwd: "/tmp/p",
  state: "live",
  pluginVersion: "1.0.0",
  outdated: false,
  session: {
    sessionId: "s1",
    sessionFile: "/tmp/s1.jsonl",
    cwd: "/tmp/p",
    reason: "startup",
    leafId: null,
    mode: "tui",
  },
  prompts: [],
  ...extra,
});

function loadWire(over: Record<string, unknown> = {}) {
  return {
    v: 1,
    at: 1_000,
    intervalMs: 5_000,
    scope: "host",
    level: "warn",
    thresholds: {
      cpu: { warnPercent: 85, critPercent: 95, psiWarnPercent: 40, psiCritPercent: 70 },
      mem: { warnAvailPercent: 15, critAvailPercent: 8 },
      disk: { warnFreePercent: 10, critFreePercent: 5, critFreeGiB: 5 },
    },
    ...over,
  };
}

describe('reduce — "load" SSE event', () => {
  it("accepts a well-formed frame and stamps the RECEIVE-time anchor (never load.at)", () => {
    const s = run([{ event: "load", data: loadWire(), at: 123_456 }]);
    expect(s.load).toEqual(loadWire());
    expect(s.loadReceivedAt).toBe(123_456);
  });

  it("defaults the receive stamp to Date.now() when the dispatcher omits `at` (reduce()'s own fallback)", () => {
    const before = Date.now();
    const s = run([{ event: "load", data: loadWire() }]);
    expect(s.loadReceivedAt).toBeGreaterThanOrEqual(before);
  });

  it("drops a malformed frame wholesale (isLoadWireLike gate) — state unchanged", () => {
    const s0 = run([{ event: "load", data: loadWire(), at: 1 }]);
    const s1 = reduce(s0, { event: "load", data: { ...loadWire(), v: 2 }, at: 2 });
    expect(s1).toBe(s0);
    expect(s1.load).toEqual(loadWire());
    expect(s1.loadReceivedAt).toBe(1);
  });

  it("overwrites on every valid frame (no merge, always wholesale replace)", () => {
    const s = run([
      { event: "load", data: loadWire({ level: "warn" }), at: 1 },
      { event: "load", data: loadWire({ level: "crit" }), at: 2 },
    ]);
    expect(s.load?.level).toBe("crit");
    expect(s.loadReceivedAt).toBe(2);
  });
});

describe('reduce — "hello"/"hub" clearing (§7.4 "hello 与 hub 帧 caps 无 load.v1 时清空")', () => {
  it('a fresh "hello" clears load/loadReceivedAt/loadTop', () => {
    let s = run([
      { event: "load", data: loadWire(), at: 1 },
      { event: "load_top_ok", data: { payload: { at: 1, byCpu: [], byRss: [] } } },
    ]);
    expect(s.load).toBeDefined();
    expect(s.loadTop?.data).toBeDefined();
    s = reduce(s, { event: "hello", data: { clientId: "c2" } });
    expect(s.load).toBeUndefined();
    expect(s.loadReceivedAt).toBeUndefined();
    expect(s.loadTop).toBeUndefined();
  });

  it('a "hub" frame whose caps list load.v1 keeps the slots', () => {
    let s = run([{ event: "load", data: loadWire(), at: 1 }]);
    s = reduce(s, { event: "hub", data: { caps: ["cmd.v1", "load.v1"] } });
    expect(s.load).toBeDefined();
  });

  it('a "hub" frame whose caps DROP load.v1 clears load/loadReceivedAt/loadTop', () => {
    let s = run([
      { event: "load", data: loadWire(), at: 1 },
      { event: "load_top_ok", data: { payload: { at: 1, byCpu: [], byRss: [] } } },
    ]);
    s = reduce(s, { event: "hub", data: { caps: ["cmd.v1"] } });
    expect(s.load).toBeUndefined();
    expect(s.loadReceivedAt).toBeUndefined();
    expect(s.loadTop).toBeUndefined();
  });

  it('a "hub" frame with no caps array at all also clears (defensive: treated as empty caps)', () => {
    let s = run([{ event: "load", data: loadWire(), at: 1 }]);
    s = reduce(s, { event: "hub", data: {} });
    expect(s.load).toBeUndefined();
  });
});

describe('reduce — "load_top_*" (§7.1/§10 useHub.fetchLoadTop single-flight drive)', () => {
  const top = { at: 1, byCpu: [], byRss: [] };

  it("start sets loading:true and keeps any previous data", () => {
    let s = run([{ event: "load_top_ok", data: { payload: top } }]);
    s = reduce(s, { event: "load_top_start" });
    expect(s.loadTop).toEqual({ loading: true, data: top });
  });

  it("ok clears loading and sets data", () => {
    const s = run([{ event: "load_top_start" }, { event: "load_top_ok", data: { payload: top } }]);
    expect(s.loadTop).toEqual({ loading: false, data: top });
  });

  it("error clears loading, sets error, and KEEPS the previous data (never blanks on a transient failure)", () => {
    const s = run([
      { event: "load_top_ok", data: { payload: top } },
      { event: "load_top_start" },
      { event: "load_top_error", data: { error: "E_DEADLINE" } },
    ]);
    expect(s.loadTop).toEqual({ loading: false, data: top, error: "E_DEADLINE" });
  });

  it("error with no prior data omits `data` entirely (not undefined-as-key)", () => {
    const s = run([{ event: "load_top_start" }, { event: "load_top_error", data: { error: "E_NETWORK" } }]);
    expect(s.loadTop).toEqual({ loading: false, error: "E_NETWORK" });
    expect("data" in (s.loadTop as object)).toBe(false);
  });

  it("a malformed load_top_ok payload is dropped (state unchanged)", () => {
    const s0 = run([{ event: "load_top_start" }]);
    const s1 = reduce(s0, { event: "load_top_ok", data: { payload: null } });
    expect(s1).toBe(s0);
  });
});

describe('reduce — "status" mirrors StatusInfo.loadGate onto AgentState.loadGate', () => {
  const gate = { gating: true, level: "crit", sinceAgoMs: 1_000, at: 2_000 };

  it("mirrors a well-formed loadGate and stamps the receive-time anchor", () => {
    let s = run([{ event: "agents", data: [card("A")] }]);
    s = reduce(s, { event: "status", data: { agentKey: "A", status: { loadGate: gate } }, at: 555 });
    const a = s.agents.get("A")!;
    expect(a.loadGate).toEqual(gate);
    expect(a.loadGateReceivedAt).toBe(555);
  });

  it("absent/malformed loadGate clears BOTH fields together (never a stale pairing)", () => {
    let s = run([{ event: "agents", data: [card("A")] }]);
    s = reduce(s, { event: "status", data: { agentKey: "A", status: { loadGate: gate } }, at: 555 });
    s = reduce(s, { event: "status", data: { agentKey: "A", status: {} }, at: 999 });
    const a = s.agents.get("A")!;
    expect(a.loadGate).toBeUndefined();
    expect(a.loadGateReceivedAt).toBeUndefined();
  });

  it("re-anchors to the LATEST status frame's receive time on every update (even if unchanged)", () => {
    let s = run([{ event: "agents", data: [card("A")] }]);
    s = reduce(s, { event: "status", data: { agentKey: "A", status: { loadGate: gate } }, at: 1 });
    s = reduce(s, { event: "status", data: { agentKey: "A", status: { loadGate: gate } }, at: 2 });
    expect(s.agents.get("A")!.loadGateReceivedAt).toBe(2);
  });

  it("an older agent peer's status frame (no loadGate key at all) leaves loadGate absent, byte-identical to pre-feature", () => {
    let s = run([{ event: "agents", data: [card("A")] }]);
    s = reduce(s, { event: "status", data: { agentKey: "A", status: { busy: true } }, at: 1 });
    const a = s.agents.get("A")!;
    expect(a.loadGate).toBeUndefined();
    expect(a.loadGateReceivedAt).toBeUndefined();
    expect((a.status as any).busy).toBe(true);
  });
});
