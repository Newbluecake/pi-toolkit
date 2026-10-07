// @vitest-environment node
/**
 * D2-0 golden (web-hub-session-switch plan §2.2 step 0 / §1.3 / §3.2): the K=1 three-layer
 * baseline for the main subscription paths, recorded on the PRE-D2 implementation (commit
 * 8bfd2ee, before any keep-alive code existed) and never regenerated since — the exact same
 * discipline as `tests/fixtures/compact-hint-golden.json`.
 *
 * Three layers per step, per plan §1.3's compatibility claim (which replaced v1's
 * "byte-for-byte identical"):
 *   ① transport call sequence — the delta of transport calls since the previous step;
 *   ② reducer projection — `{selected, agents: {key: {sub, history, needsResync, itemsLen,
 *      firstItemId, hasMore}}}` (the visible projection only; `abandoned` is reducer-internal
 *      and deliberately NOT recorded);
 *   ③ render branch label — derived from AgentDetail.vue's branch rules (history==="waiting" ⇒
 *      `skeleton`, history==="error" ⇒ `error-notice`, otherwise `transcript:<itemsLen>`).
 *
 * The scenarios are exactly plan §1.3's main-path list: A→B, A→null, A→B→A inside and outside
 * the resync window, hello-then-switch, switching with a live run subscription, and a session
 * replacement of the selected agent. The intentional K=1 differences (plan §1.3 items 1–6) are
 * NOT here — they are pinned one-by-one in use-hub.test.ts's "D2 keep-alive" suite.
 *
 * Replay always constructs `useHub` WITHOUT `keepAliveSessions` (library default K=1 — plan
 * D2-5), which is also the only thing the pre-D2 implementation understood, so generation and
 * replay drive the identical configuration. History frames carry a `sessionId` matching the
 * agent's current session: the pre-D2 reducer ignores the field, and the D2 reducer's
 * both-present-and-equal check passes it — identical outcome on both sides, exercising the
 * field's presence in the wire shape.
 *
 * Regeneration is intentionally awkward: `GOLDEN_WRITE=1 npx vitest run
 * tests/web-hub/ui/keepalive-golden.test.ts` — and ONLY on a checkout whose main-subscription
 * behavior you intend to become the new baseline. Never regenerate to "fix" a failure.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { useHub } from "../../../src/web-hub/ui/src/composables/useHub.js";
import type { HubTransport, TransportHooks } from "../../../src/web-hub/ui/src/transport/types.js";

const GOLDEN_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/web-hub-ui/keepalive-legacy-golden.json",
);

/** Deterministic fake timer queue (same shape as use-hub.test.ts's). */
function fakeClock() {
  // Start at a realistic-looking epoch millisecond value — real `Date.now()` is always far
  // larger than any `resyncMinIntervalMs`, so starting at 0 would make the very first subscribe
  // attempt in a test spuriously look rate-limited (same comment as use-hub.test.ts).
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
    advance(ms: number): void {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

function alwaysVisible() {
  return {
    doc: { hidden: false, addEventListener: () => {}, removeEventListener: () => {} },
    win: { addEventListener: () => {}, removeEventListener: () => {} },
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

type Call = { method: string; args: unknown[] };

/** Synchronously-resolving transport (plan §2.2 step 0: "fake transport 同步 resolve"). */
function fakeTransport() {
  const calls: Call[] = [];
  let hooksRef: TransportHooks | undefined;
  const transport: HubTransport = {
    mode: "token",
    start: async () => void calls.push({ method: "start", args: [] }),
    close: () => calls.push({ method: "close", args: [] }),
    subscribe: async (clientId, agentKey) => {
      calls.push({ method: "subscribe", args: [clientId, agentKey] });
      return { ok: true };
    },
    unsubscribe: async (clientId, agentKey) => {
      calls.push({ method: "unsubscribe", args: [clientId, agentKey] });
    },
    page: async () => ({ ok: true, data: {} }),
    runSubscribe: async (clientId, agentKey, runId) => {
      calls.push({ method: "runSubscribe", args: [clientId, agentKey, runId] });
      return { ok: true };
    },
    runUnsubscribe: async (clientId, agentKey, runId) => {
      calls.push({ method: "runUnsubscribe", args: [clientId, agentKey, runId] });
    },
    runPage: async () => ({ ok: true, data: {} }),
    command: async () => ({ ok: true }),
    dialog: async () => ({ ok: true }),
  };
  return {
    calls,
    hooks: () => hooksRef!,
    createTransport: (hooks: TransportHooks): HubTransport => {
      hooksRef = hooks;
      return transport;
    },
  };
}

const card = (agentKey: string) => ({
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
});

const entry = (id: string, ts: number) => ({
  id,
  parentId: null,
  type: "message",
  timestamp: new Date(ts).toISOString(),
  message: { role: "user", content: `m-${id}`, timestamp: ts },
});

const historyMsg = (agentKey: string, entries: Array<ReturnType<typeof entry>>, sessionId?: string, fromSeq = 10) => ({
  event: "history",
  data: {
    agentKey,
    entries,
    tailMessages: [],
    fromSeq,
    hasMore: false,
    source: "file",
    ...(sessionId === undefined ? {} : { sessionId }),
  },
});

// ---------------------------------------------------------------------------
// recording: one scenario = one fresh hub + clock + transport; steps record the three layers
// ---------------------------------------------------------------------------

interface StepRecord {
  label: string;
  calls: Call[];
  projection: Record<string, unknown>;
  render: Record<string, unknown>;
}
interface ScenarioRecord {
  name: string;
  steps: StepRecord[];
}
interface GoldenRecording {
  version: 1;
  scenarios: ScenarioRecord[];
}

type Hub = ReturnType<typeof useHub>;
type Clock = ReturnType<typeof fakeClock>;
type Step = { label: string; run: () => void };

type Ctx = { hub: Hub; clock: Clock; t: ReturnType<typeof fakeTransport> };

function project(hub: Hub): Record<string, unknown> {
  const s = hub.state.value as unknown as {
    selected: string | null;
    agents: Map<string, Record<string, unknown>>;
  };
  const agents: Record<string, unknown> = {};
  for (const [key, a] of s.agents) {
    agents[key] = {
      sub: a["sub"] ?? null,
      history: a["history"],
      needsResync: a["needsResync"],
      itemsLen: (a["items"] as unknown[]).length,
      firstItemId: (a["items"] as Array<{ id: string }>)[0]?.id ?? null,
      hasMore: a["hasMore"],
    };
  }
  return { selected: s.selected, agents };
}

function renderOf(hub: Hub): Record<string, unknown> {
  const s = hub.state.value as unknown as {
    selected: string | null;
    agents: Map<string, Record<string, unknown>>;
  };
  const out: Record<string, unknown> = { selected: s.selected };
  for (const [key, a] of s.agents) {
    const h = a["history"] as string;
    const itemsLen = (a["items"] as unknown[]).length;
    out[key] = h === "waiting" ? "skeleton" : h === "error" ? "error-notice" : `transcript:${itemsLen}`;
  }
  return out;
}

async function play(name: string, build: (ctx: Ctx) => Step[]): Promise<ScenarioRecord> {
  const clock = fakeClock();
  const t = fakeTransport();
  const hub = useHub({
    createTransport: t.createTransport,
    ...alwaysVisible(),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    resyncMinIntervalMs: 2_000,
  });
  const recorded: StepRecord[] = [];
  let prevLen = 0;
  for (const step of build({ hub, clock, t })) {
    step.run();
    await flush();
    recorded.push({
      label: step.label,
      calls: t.calls.slice(prevLen).map((c) => ({ method: c.method, args: c.args })),
      projection: project(hub),
      render: renderOf(hub),
    });
    prevLen = t.calls.length;
  }
  hub.dispose();
  return { name, steps: recorded };
}

/** conn(open) + hello(c1) + agents [A,B] + history(A) — the shared loaded-boot prefix
 * (steps close over hub; onConn mirrors the real token/password clients, which report `open`
 * when the SSE handshake lands, before the hello frame — runFleetEffects gates on it). */
const boot = (hub: Hub, t: ReturnType<typeof fakeTransport>): Step[] => [
  {
    label: "conn open + hello c1",
    run: () => {
      t.hooks().onConn("open");
      hub.dispatch({ event: "hello", data: { clientId: "c1" } });
    },
  },
  {
    label: "agents [A,B] → auto-select A, subscribe",
    run: () => hub.dispatch({ event: "agents", data: [card("A"), card("B")] }),
  },
  { label: "history A (s1)", run: () => hub.dispatch(historyMsg("A", [entry("e1", 1000)], "s1")) },
];

async function buildRecording(): Promise<GoldenRecording> {
  const scenarios: ScenarioRecord[] = [];

  // S1 — A→B: the canonical single-slot switch.
  scenarios.push(
    await play("A→B", ({ hub, t }) => [
      ...boot(hub, t),
      { label: "route B", run: () => hub.dispatch({ event: "route", data: { agentKey: "B" } }) },
      { label: "history B (s1)", run: () => hub.dispatch(historyMsg("B", [entry("f1", 2000)], "s1")) },
    ]),
  );

  // S2 — A→null (mobile back-to-list).
  scenarios.push(
    await play("A→null", ({ hub, t }) => [
      ...boot(hub, t),
      { label: "route null", run: () => hub.dispatch({ event: "route", data: { agentKey: null } }) },
    ]),
  );

  // S3 — A→B→A inside the resync window: the return subscribe waits for the rate-limit timer.
  scenarios.push(
    await play("A→B→A (in window)", ({ hub, clock, t }) => [
      ...boot(hub, t),
      { label: "route B", run: () => hub.dispatch({ event: "route", data: { agentKey: "B" } }) },
      { label: "history B (s1)", run: () => hub.dispatch(historyMsg("B", [entry("f1", 2000)], "s1")) },
      {
        label: "route A (still inside the 2s window) — resubscribe deferred",
        run: () => hub.dispatch({ event: "route", data: { agentKey: "A" } }),
      },
      { label: "advance 2000 — the deferred resubscribe fires", run: () => clock.advance(2_000) },
      { label: "history A (s1)", run: () => hub.dispatch(historyMsg("A", [entry("e1", 1000)], "s1", 11)) },
    ]),
  );

  // S4 — A→B→A after the window: the return subscribe goes out immediately.
  scenarios.push(
    await play("A→B→A (after window)", ({ hub, clock, t }) => [
      ...boot(hub, t),
      { label: "route B", run: () => hub.dispatch({ event: "route", data: { agentKey: "B" } }) },
      { label: "history B (s1)", run: () => hub.dispatch(historyMsg("B", [entry("f1", 2000)], "s1")) },
      { label: "advance 2000", run: () => clock.advance(2_000) },
      {
        label: "route A — immediate resubscribe",
        run: () => hub.dispatch({ event: "route", data: { agentKey: "A" } }),
      },
      { label: "history A (s1)", run: () => hub.dispatch(historyMsg("A", [entry("e1", 1000)], "s1", 11)) },
    ]),
  );

  // S5 — hello (reconnect) then switch: re-subscribe under the new clientId, then a switch.
  scenarios.push(
    await play("hello → switch", ({ hub, clock, t }) => [
      ...boot(hub, t),
      {
        label: "hello c2 — resubscribe deferred by the window",
        run: () => hub.dispatch({ event: "hello", data: { clientId: "c2" } }),
      },
      { label: "advance 2000", run: () => clock.advance(2_000) },
      { label: "history A (s1)", run: () => hub.dispatch(historyMsg("A", [entry("e1", 1000)], "s1")) },
      { label: "route B", run: () => hub.dispatch({ event: "route", data: { agentKey: "B" } }) },
      { label: "history B (s1)", run: () => hub.dispatch(historyMsg("B", [entry("f1", 2000)], "s1")) },
    ]),
  );

  // S6 — switching away with a live run subscription (transport order: runUnsubscribe →
  // unsubscribe → subscribe).
  scenarios.push(
    await play("switch with run", ({ hub, t }) => [
      ...boot(hub, t),
      { label: "selectRun(A, r1)", run: () => hub.selectRun("A", "r_AB12CD34") },
      {
        label: "run_history (loaded)",
        run: () =>
          hub.dispatch({
            event: "run_history",
            data: {
              agentKey: "A",
              runId: "r_AB12CD34",
              entries: [entry("re1", 3000)],
              tailMessages: [],
              tapId: "tap_1",
              fromSeq: 5,
              hasMore: false,
              source: "live",
              terminal: false,
              status: "running",
              live: true,
            },
          }),
      },
      { label: "route B", run: () => hub.dispatch({ event: "route", data: { agentKey: "B" } }) },
      { label: "history B (s1)", run: () => hub.dispatch(historyMsg("B", [entry("f1", 2000)], "s1")) },
    ]),
  );

  // S7 — session replacement of the selected agent (/new in the same pi): transcript cleared,
  // waiting, then the fresh snapshot under the new sessionId.
  scenarios.push(
    await play("session replacement (selected)", ({ hub, clock, t }) => [
      ...boot(hub, t),
      { label: "advance 2000 (clear the resubscribe window)", run: () => clock.advance(2_000) },
      {
        label: "session → s2 (replacement)",
        run: () =>
          hub.dispatch({
            event: "session",
            data: {
              agentKey: "A",
              session: {
                sessionId: "s2",
                sessionFile: "/tmp/s2.jsonl",
                cwd: "/tmp/p",
                reason: "user",
                leafId: null,
                mode: "tui",
              },
            },
          }),
      },
      { label: "history A (s2)", run: () => hub.dispatch(historyMsg("A", [entry("g1", 4000)], "s2", 3)) },
    ]),
  );

  return { version: 1, scenarios };
}

describe("keepalive golden (D2-0, plan §1.3/§3.2)", () => {
  it("K=1 main-path transport sequence / reducer projection / render branches match the pre-D2 golden", async () => {
    const recording = await buildRecording();
    if (process.env.GOLDEN_WRITE === "1") {
      writeFileSync(GOLDEN_PATH, `${JSON.stringify(recording, null, 2)}\n`);
    }
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as GoldenRecording;
    expect(recording).toEqual(golden);
  });
});
