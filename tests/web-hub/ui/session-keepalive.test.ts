// @vitest-environment node
/**
 * Session keep-alive (web-hub-session-switch plan §1.2 D2 / §3.2, package D2):
 *
 *  - the pure preference layer (`clampKeepAlive` / `loadKeepAlive` / `setKeepAlivePref`);
 *  - the pure planner (`planKeepAlive`) — table-driven per plan §3.2;
 *  - the randomized model test (一般-12): a fixed-seed 300-step mixed event pool
 *    (route / hello / agent_removed+re-add / gap / session replacement / K change /
 *    deferred-Promise resolve+reject, hub frames delivered on resolve) driving the REAL
 *    `useHub` against a deferred transport and a fake hub model that mirrors plan §0.1's
 *    subscribe semantics (per-(clientId, agentKey) attempts; superseded attempts never
 *    deliver a snapshot). Invariants:
 *      I1  ledger entries under the current clientId never exceed the K in force at the last
 *          plan (K changes take effect on the NEXT switch — plan D2-5);
 *      I2  at quiescence the fake hub's subscription set (current clientId) equals the ledger
 *          key set;
 *      I3  a selected, live agent at quiescence is history loaded|error, and when loaded the
 *          hub's set contains it;
 *      I4  no unsubscribe POST is ever sent for a (clientId, agentKey) this client never
 *          subscribe-POSTed under that clientId;
 *      I5  nothing throws and every agent in state exists in the model's agent set;
 *      I6  per (clientId, agentKey): a subscribe POST never fires while an earlier unsubscribe
 *          POST for the SAME pair is still unsettled (D2-4's same-key serialization; across
 *          clientIds it is intentionally not enforced — an old client's unsubscribe cannot
 *          kill the new client's subscription, R2-1).
 *
 *    Unsubscribe POSTs are only ever RESOLVED (never rejected): a rejected unsubscribe is
 *    indistinguishable from a POST that never reached the hub, and the ledger discipline
 *    assumes delivery (plan R5: over-unsubscribing is idempotent, under-unsubscribing is the
 *    observed property). Subscribe POST rejections ARE exercised — useHub folds them into the
 *    `!ok` path (ledger entry dropped, `subscribe_failed` dispatched).
 */
import { describe, expect, it } from "vitest";
import {
  KEEPALIVE_DEFAULT,
  KEEPALIVE_MAX,
  KEEPALIVE_MIN,
  clampKeepAlive,
  loadKeepAlive,
  planKeepAlive,
  setKeepAlivePref,
} from "../../../src/web-hub/ui/src/logic/sessionKeepAlive.js";
import { useHub } from "../../../src/web-hub/ui/src/composables/useHub.js";
import type { HubTransport, TransportHooks } from "../../../src/web-hub/ui/src/transport/types.js";

// ---------------------------------------------------------------------------
// preference layer
// ---------------------------------------------------------------------------

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

function throwingStorage() {
  return {
    getItem: () => {
      throw new Error("disabled");
    },
    setItem: () => {
      throw new Error("disabled");
    },
  };
}

describe("clampKeepAlive / loadKeepAlive / setKeepAlivePref", () => {
  it.each([undefined, null, "abc", "", "0", "6", "2.5", "NaN", "Infinity", "-1"])(
    "invalid value %p ⇒ default 3",
    (v) => {
      expect(clampKeepAlive(v)).toBe(KEEPALIVE_DEFAULT);
    },
  );
  it.each(["1", "2", "3", "5", 1, 2, 3, 4, 5])("valid value %p ⇒ itself", (v) => {
    expect(clampKeepAlive(v)).toBe(Number(v));
  });
  it("bounds are 1..5", () => {
    expect(KEEPALIVE_MIN).toBe(1);
    expect(KEEPALIVE_MAX).toBe(5);
  });
  it("loadKeepAlive: missing ⇒ 3; stored '1'/'5' round-trip; throwing storage fails open to 3", () => {
    expect(loadKeepAlive(memoryStorage())).toBe(3);
    expect(loadKeepAlive(memoryStorage({ pwh_keepalive: "1" }))).toBe(1);
    expect(loadKeepAlive(memoryStorage({ pwh_keepalive: "5" }))).toBe(5);
    expect(loadKeepAlive(memoryStorage({ pwh_keepalive: "bogus" }))).toBe(3);
    expect(loadKeepAlive(throwingStorage())).toBe(3);
  });
  it("setKeepAlivePref persists the numeric token; a throwing storage does not propagate", () => {
    const s = memoryStorage();
    setKeepAlivePref(s, 1);
    expect(s.getItem("pwh_keepalive")).toBe("1");
    expect(() => setKeepAlivePref(throwingStorage(), 3)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// planKeepAlive (table-driven, plan §3.2)
// ---------------------------------------------------------------------------

const all = (): ((k: string) => boolean) => () => true;
const noneFailed = (): ((k: string) => boolean) => () => false;

describe("planKeepAlive", () => {
  it("K=1: A→B evicts A; A→null evicts A", () => {
    expect(planKeepAlive({ lru: ["A"], selected: "B", old: "A", cap: 1, exists: all(), failed: noneFailed() })).toEqual(
      {
        lru: ["B"],
        evict: ["A"],
      },
    );
    expect(
      planKeepAlive({ lru: ["A"], selected: null, old: "A", cap: 1, exists: all(), failed: noneFailed() }),
    ).toEqual({
      lru: [],
      evict: ["A"],
    });
  });

  it("K=3: two background sessions survive; the LRU head goes first on overflow", () => {
    expect(
      planKeepAlive({ lru: ["A", "B"], selected: "C", old: "B", cap: 3, exists: all(), failed: noneFailed() }),
    ).toEqual({
      lru: ["A", "B", "C"],
      evict: [],
    });
    expect(
      planKeepAlive({ lru: ["A", "B", "C"], selected: "D", old: "C", cap: 3, exists: all(), failed: noneFailed() }),
    ).toEqual({
      lru: ["B", "C", "D"],
      evict: ["A"],
    });
  });

  it("the selected session is never evicted", () => {
    expect(
      planKeepAlive({ lru: ["A", "B", "C"], selected: "C", old: "B", cap: 1, exists: all(), failed: noneFailed() }),
    ).toEqual({
      lru: ["C"],
      evict: ["A", "B"],
    });
  });

  it("a failed old session is evicted regardless of quota (D2-8)", () => {
    const failedA = (k: string) => k === "A";
    expect(planKeepAlive({ lru: ["A", "B"], selected: "B", old: "A", cap: 3, exists: all(), failed: failedA })).toEqual(
      {
        lru: ["B"],
        evict: ["A"],
      },
    );
    // …but a failed SELECTED session is not (it is the current view; needsSubscribe owns it)
    expect(planKeepAlive({ lru: ["A", "B"], selected: "A", old: "B", cap: 3, exists: all(), failed: failedA })).toEqual(
      {
        lru: ["B", "A"],
        evict: [],
      },
    );
  });

  it("keys that no longer exist are silently dropped and never evicted (D2-11/一般-10)", () => {
    expect(
      planKeepAlive({
        lru: ["X", "A"],
        selected: "B",
        old: "A",
        cap: 3,
        exists: (k) => k !== "X",
        failed: noneFailed(),
      }),
    ).toEqual({ lru: ["A", "B"], evict: [] });
  });

  it("shrinking the cap evicts the surplus on the next plan", () => {
    expect(
      planKeepAlive({
        lru: ["A", "B", "C", "D"],
        selected: "D",
        old: "C",
        cap: 2,
        exists: all(),
        failed: noneFailed(),
      }),
    ).toEqual({
      lru: ["C", "D"],
      evict: ["A", "B"],
    });
  });

  it("re-selecting an existing key moves it to the MRU tail; the input array is never mutated", () => {
    const input = ["A", "B", "C"];
    const plan = planKeepAlive({ lru: input, selected: "A", old: "C", cap: 3, exists: all(), failed: noneFailed() });
    expect(plan.lru).toEqual(["B", "C", "A"]);
    expect(input).toEqual(["A", "B", "C"]); // purity
  });

  it("selecting a brand-new key appends it; empty LRU + null selection stays empty", () => {
    expect(planKeepAlive({ lru: [], selected: "A", old: null, cap: 3, exists: all(), failed: noneFailed() })).toEqual({
      lru: ["A"],
      evict: [],
    });
    expect(planKeepAlive({ lru: [], selected: null, old: null, cap: 3, exists: all(), failed: noneFailed() })).toEqual({
      lru: [],
      evict: [],
    });
  });
});

// ---------------------------------------------------------------------------
// randomized model test (一般-12)
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32) — fixed seed, so a failure is always reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fakeClock() {
  let now = 1_700_000_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number): number => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id: number): void => void timers.delete(id),
    pending: () => timers.size,
    advance(ms: number): void {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((x, y) => x[1].at - y[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

const KEYS = ["A", "B", "C", "D", "E"] as const;

const cardFor = (key: string, sessionId: string) => ({
  agentKey: key,
  kind: "tui",
  pid: 1,
  cwd: `/tmp/${key}`,
  state: "live",
  pluginVersion: "1.0.0",
  outdated: false,
  session: {
    sessionId,
    sessionFile: `/tmp/${sessionId}.jsonl`,
    cwd: `/tmp/${key}`,
    reason: "startup",
    leafId: null,
    mode: "tui",
  },
  prompts: [],
});

interface DeferredCall {
  kind: "subscribe" | "unsubscribe";
  clientId: string;
  agentKey: string;
  resolve: (ok: boolean) => void;
  settled: boolean;
}

describe("randomized model test (一般-12, plan §3.2 invariants I1–I6)", () => {
  it("300-step mixed pool keeps the ledger, the hub model and the reducer consistent", async () => {
    const rng = mulberry32(0x2026_1007);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
    const clock = fakeClock();

    // ---- fake hub model (§0.1 semantics) ----
    let clientSeq = 0;
    let entrySeq = 0;
    const sessions = new Map<string, string>(KEYS.map((k) => [k, `s-${k}-1`]));
    const hubSubs = new Map<string, Set<string>>(); // clientId → agentKeys (settled, live)
    /** per (clientId|agentKey): the LATEST attempt object — older ones are superseded. */
    const hubPending = new Map<string, object>();
    const subscribedEver = new Set<string>(); // (clientId|agentKey) that ever saw a subscribe CALL (I4)
    const openUnsub = new Map<string, number>(); // (clientId|agentKey) → unsettled unsubscribe POSTs (I6)
    const modelAgents = new Set<string>(KEYS);
    const violations: string[] = [];
    const calls: DeferredCall[] = [];
    let hooksRef: TransportHooks | undefined;

    const emitHistory = (clientId: string, agentKey: string): void => {
      entrySeq += 1;
      const ts = 1000 + entrySeq;
      hooksRef!.onMessage({
        event: "history",
        data: {
          agentKey,
          entries: [
            {
              id: `${agentKey}-e${entrySeq}`,
              parentId: null,
              type: "message",
              timestamp: new Date(ts).toISOString(),
              message: { role: "user", content: `m${entrySeq}`, timestamp: ts },
            },
          ],
          tailMessages: [],
          fromSeq: entrySeq,
          hasMore: false,
          source: "file",
          sessionId: sessions.get(agentKey),
        },
      });
    };

    const transport: HubTransport = {
      mode: "token",
      start: async () => {},
      close: () => {},
      subscribe: (clientId, agentKey) => {
        const pair = `${clientId}|${agentKey}`;
        subscribedEver.add(pair);
        const attempt = {};
        hubPending.set(pair, attempt); // a newer attempt supersedes this one (§0.1)
        const call: DeferredCall = {
          kind: "subscribe",
          clientId,
          agentKey,
          settled: false,
          resolve: () => {},
        };
        calls.push(call);
        return new Promise<{ ok: boolean; error?: string }>((resolve) => {
          call.resolve = (ok: boolean) => {
            call.settled = true;
            resolve(ok ? { ok: true } : { ok: false, error: "E_RANDOM" });
            // hub-side processing happens in resolve order:
            if (hubPending.get(pair) !== attempt) return; // superseded ⇒ never delivers
            hubPending.delete(pair);
            if (!ok) return; // POST failed ⇒ hub registered nothing
            if (!modelAgents.has(agentKey)) return; // agent vanished mid-flight
            const set = hubSubs.get(clientId) ?? new Set<string>();
            set.add(agentKey);
            hubSubs.set(clientId, set);
            emitHistory(clientId, agentKey);
          };
        });
      },
      unsubscribe: (clientId, agentKey) => {
        const pair = `${clientId}|${agentKey}`;
        // I4: never unsubscribe a (client, agent) this client never subscribe-POSTed
        if (!subscribedEver.has(pair)) violations.push(`I4: unsubscribe without a prior subscribe POST for ${pair}`);
        hubPending.delete(pair);
        const set = hubSubs.get(clientId);
        if (set !== undefined) set.delete(agentKey);
        const call: DeferredCall = {
          kind: "unsubscribe",
          clientId,
          agentKey,
          settled: false,
          resolve: () => {},
        };
        calls.push(call);
        openUnsub.set(pair, (openUnsub.get(pair) ?? 0) + 1);
        return new Promise<void>((resolve) => {
          call.resolve = () => {
            call.settled = true;
            openUnsub.set(pair, Math.max(0, (openUnsub.get(pair) ?? 1) - 1));
            resolve();
          };
        });
      },
      page: async () => ({ ok: true, data: {} }),
      command: async () => ({ ok: true }),
      dialog: async () => ({ ok: true }),
    };

    // I6 is checked at subscribe-CALL time (the wire moment), not resolve time.
    const rawSubscribe = transport.subscribe.bind(transport);
    transport.subscribe = (clientId, agentKey) => {
      if ((openUnsub.get(`${clientId}|${agentKey}`) ?? 0) > 0)
        violations.push(`I6: subscribe(${clientId},${agentKey}) fired while its unsubscribe was unsettled`);
      return rawSubscribe(clientId, agentKey);
    };

    let k = 3;
    let plannedK = 3; // K in force at the last selection change (D2-5: shrinks apply on next switch)
    const hub = useHub({
      createTransport: (h) => {
        hooksRef = h;
        return transport;
      },
      doc: { hidden: false, addEventListener: () => {}, removeEventListener: () => {} },
      win: { addEventListener: () => {}, removeEventListener: () => {} },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
      resyncMinIntervalMs: 2_000,
      keepAliveSessions: () => k,
    });
    hooksRef!.onConn("open");
    hub.dispatch({ event: "hello", data: { clientId: "c0" } });
    hub.dispatch({ event: "agents", data: KEYS.map((key) => cardFor(key, sessions.get(key)!)) });

    const flush = async (): Promise<void> => {
      for (let i = 0; i < 12; i++) await Promise.resolve();
    };

    const checkI1 = (): void => {
      const cur = hub.state.value.clientId;
      const n = hub.mainSubLedger().filter((e) => e.clientId === cur).length;
      if (n > plannedK) violations.push(`I1: ledger holds ${n} entries under ${cur} > K=${plannedK}`);
    };
    const checkI5 = (): void => {
      const state = hub.state.value as unknown as { agents: Map<string, unknown> };
      for (const key of state.agents.keys())
        if (!modelAgents.has(key)) violations.push(`I5: unknown agent ${key} in state`);
    };

    const rngRoute = async (): Promise<void> => {
      const target = rng() < 0.15 ? null : pick(KEYS);
      hub.dispatch({ event: "route", data: { agentKey: target } });
      await flush();
      plannedK = k; // the plan ran with the CURRENT k (if selection actually changed; ≤ k either way)
      checkI1();
      checkI5();
    };

    for (let step = 0; step < 300; step++) {
      const roll = rng();
      if (roll < 0.22) {
        await rngRoute();
      } else if (roll < 0.44) {
        // resolve/reject one unsettled deferred (subscribe may reject; unsubscribe only resolves)
        const open = calls.filter((c) => !c.settled);
        if (open.length > 0) {
          const c = pick(open);
          c.resolve(c.kind === "subscribe" ? rng() > 0.12 : true);
          await flush();
        }
      } else if (roll < 0.56) {
        clientSeq += 1;
        hub.dispatch({ event: "hello", data: { clientId: `c${clientSeq}` } });
        hubSubs.clear(); // new SSE connection ⇒ hub-side subscriptions reset
        hubPending.clear();
        await flush();
        checkI1();
      } else if (roll < 0.66) {
        // remove one agent, re-add it (with a fresh session) — exercises D2-11/一般-10
        const key = pick(KEYS);
        modelAgents.delete(key);
        for (const set of hubSubs.values()) set.delete(key);
        hub.dispatch({ event: "agent_removed", data: { agentKey: key } });
        await flush();
        if (rng() < 0.8) {
          const sid = `s-${key}-${Math.floor(rng() * 1e6)}`;
          sessions.set(key, sid);
          modelAgents.add(key);
          hub.dispatch({ event: "agent_up", data: { agent: cardFor(key, sid) } });
        }
        await flush();
        checkI1();
        checkI5();
      } else if (roll < 0.76) {
        hub.dispatch({ event: "gap", data: { agentKey: pick(KEYS) } });
        await flush();
      } else if (roll < 0.86) {
        // session replacement on a random agent (new identity ⇒ reducer clears + needsResync)
        const key = pick(KEYS);
        if (modelAgents.has(key)) {
          const sid = `s-${key}-${Math.floor(rng() * 1e6)}`;
          sessions.set(key, sid);
          hub.dispatch({
            event: "session",
            data: {
              agentKey: key,
              session: {
                sessionId: sid,
                sessionFile: `/tmp/${sid}.jsonl`,
                cwd: `/tmp/${key}`,
                reason: "user",
                leafId: null,
                mode: "tui",
              },
            },
          });
          await flush();
        }
      } else if (roll < 0.94) {
        // K drifts (half the time to 1 — eviction-heavy traffic); takes effect at the next plan
        k = rng() < 0.5 ? 1 : 1 + Math.floor(rng() * 4);
      } else {
        clock.advance(2_000); // release rate-limit timers
        await flush();
      }
    }

    // ---- quiescence: settle everything, drain timers, then check I2/I3 ----
    for (let round = 0; round < 24; round++) {
      const open = calls.filter((c) => !c.settled);
      for (const c of open) c.resolve(c.kind === "subscribe" ? true : true);
      await flush();
      clock.advance(2_500);
      await flush();
      if (calls.every((c) => c.settled) && clock.pending() === 0) break;
    }
    expect(calls.every((c) => c.settled)).toBe(true);
    expect(clock.pending()).toBe(0);

    const cur = hub.state.value.clientId;
    const hubSet = hubSubs.get(cur) ?? new Set<string>();
    const ledger = new Set(hub.mainSubLedger().map((e) => e.key));
    const diff = (a: Set<string>, b: Set<string>): string[] => [...a].filter((k) => !b.has(k));
    expect(diff(hubSet, ledger), `I2: hub-only ${diff(hubSet, ledger)}; ledger-only ${diff(ledger, hubSet)}`).toEqual(
      [],
    );

    const state = hub.state.value as unknown as {
      selected: string | null;
      agents: Map<string, { down: boolean; history: string }>;
    };
    const sel = state.selected;
    if (sel !== null) {
      const a = state.agents.get(sel)!;
      if (!a.down) {
        expect(["loaded", "error"]).toContain(a.history);
        if (a.history === "loaded") expect(hubSet.has(sel)).toBe(true);
      }
    }
    checkI5();
    // Non-vacuity pin: the pool must have produced real traffic — subscribes, unsubscribes
    // (evictions), and enough total volume that the invariants were non-trivially checked.
    expect(calls.length).toBeGreaterThan(30);
    expect(calls.filter((c) => c.kind === "subscribe").length).toBeGreaterThanOrEqual(20);
    expect(calls.filter((c) => c.kind === "unsubscribe").length).toBeGreaterThanOrEqual(5);
    expect(violations, violations.join("; ")).toEqual([]);
    hub.dispose();
  });
});
