// @vitest-environment node
/**
 * web-hub content preview — the App-level PROBE controller (web-hub-preview 2026-10-07 修订
 * 「先探测后标记」, `composables/usePreviewProbe.ts`): the pending→confirmed/missing/failed
 * state machine, ONE batched request per flush (a whole message's candidates merged),
 * dedup/LRU (a settled path never re-probes), the batch-wide failure degrade, scope-change
 * re-probing, and dispose.
 */
import { effectScope, ref, type Ref } from "vue";
import { describe, expect, it } from "vitest";
import { usePreviewProbe, type PreviewProbeHandle } from "../../../src/web-hub/ui/src/composables/usePreviewProbe.js";
import type { PreviewProbeOutcome } from "../../../src/web-hub/ui/src/transport/types.js";
import type { PreviewPathScope } from "../../../src/web-hub/ui/src/types.js";

type ProbeCall = { agentKey: string; sessionId: string; paths: string[]; dirs?: true };

const SCOPE: PreviewPathScope = { agentKey: "A", sessionId: "s1", cwd: "/p", uploads: true };

/** Deterministic scheduler: flushes only when the test advances the queue. */
function manualSchedule(): { schedule: (fn: () => void) => () => void; flush(): void; pending(): boolean } {
  let fn: (() => void) | null = null;
  return {
    schedule: (f: () => void) => {
      fn = f;
      return () => {
        fn = null;
      };
    },
    flush: () => {
      const f = fn;
      fn = null;
      f?.();
    },
    pending: () => fn !== null,
  };
}

function makeProbe(outcome: (call: ProbeCall) => PreviewProbeOutcome | Promise<PreviewProbeOutcome>): {
  fn: (req: ProbeCall) => Promise<PreviewProbeOutcome>;
  calls: ProbeCall[];
} {
  const calls: ProbeCall[] = [];
  return {
    calls,
    fn: async (req: ProbeCall): Promise<PreviewProbeOutcome> => {
      calls.push(req);
      return outcome(req);
    },
  };
}

function setup(
  scope: Ref<PreviewPathScope | null>,
  transport: ReturnType<typeof makeProbe>,
  now?: () => number,
): { handle: PreviewProbeHandle; sched: ReturnType<typeof manualSchedule> } {
  const sched = manualSchedule();
  const handle = usePreviewProbe({
    probe: (req, opts) => transport.fn(req as ProbeCall),
    scope,
    schedule: sched.schedule,
    ...(now !== undefined ? { now } : {}),
  });
  return { handle, sched };
}

const flushMicrotasks = async (n = 8): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

describe("usePreviewProbe — state machine (2026-10-07 修订)", () => {
  it("pending → confirmed/missing drives stateOf; unknown stays undefined", async () => {
    const scope = ref<PreviewPathScope | null>(SCOPE);
    const t = makeProbe((c) => ({
      ok: true,
      results: c.paths.map((p) => (p.endsWith("gone.ts") ? "missing" : "text")),
    }));
    const { handle, sched } = setup(scope, t);
    handle.ensure(["/p/a.ts", "/p/gone.ts"]);
    // queued-but-not-flushed: undefined (renders plain text, same as pending)
    expect(handle.stateOf("/p/a.ts")).toBeUndefined();
    sched.flush();
    // flushed, request in flight: pending (synchronously marked before the async settle)
    expect(handle.stateOf("/p/a.ts")).toBe("pending");
    await flushMicrotasks();
    expect(handle.stateOf("/p/a.ts")).toBe("confirmed");
    expect(handle.stateOf("/p/gone.ts")).toBe("missing");
    expect(handle.stateOf("/p/never.ts")).toBeUndefined();
  });

  it("ONE request per flush: candidates from many ensure() calls (one message's segments) merge", async () => {
    const scope = ref<PreviewPathScope | null>(SCOPE);
    const t = makeProbe((c) => ({ ok: true, results: c.paths.map(() => "text" as const) }));
    const { handle, sched } = setup(scope, t);
    // one settled message mounts all of its PathTexts in the same tick — three submits
    handle.ensure(["/p/a.ts"]);
    handle.ensure(["/p/b.ts", "/p/c.ts"]);
    handle.ensure(["/p/a.ts"]); // duplicate re-render submit dedupes
    sched.flush();
    await flushMicrotasks();
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.paths).toEqual(["/p/a.ts", "/p/b.ts", "/p/c.ts"]);
  });

  it("an LRU hit never re-probes: a second ensure of settled paths issues no request", async () => {
    const scope = ref<PreviewPathScope | null>(SCOPE);
    const t = makeProbe(() => ({ ok: true, results: ["text"] }));
    const { handle, sched } = setup(scope, t);
    handle.ensure(["/p/a.ts"]);
    sched.flush();
    await flushMicrotasks();
    expect(t.calls).toHaveLength(1);

    handle.ensure(["/p/a.ts"]); // re-render of the same message
    expect(sched.pending()).toBe(true);
    sched.flush();
    await flushMicrotasks();
    expect(t.calls).toHaveLength(1); // nothing new left the wire
  });

  it("probe failure (network reject / non-200 / length mismatch) fails the WHOLE batch", async () => {
    for (const outcome of [
      () => {
        throw new Error("network down");
      },
      () => ({ ok: false as const, status: 503, error: "E_BUSY" }),
      () => ({ ok: true as const, results: ["text" as const] }), // 2 paths, 1 result ⇒ mismatch
    ]) {
      const scope = ref<PreviewPathScope | null>(SCOPE);
      const t = makeProbe(() => outcome() as PreviewProbeOutcome | Promise<PreviewProbeOutcome>);
      const { handle, sched } = setup(scope, t);
      handle.ensure(["/p/a.ts", "/p/b.ts"]);
      sched.flush();
      await flushMicrotasks();
      expect(handle.stateOf("/p/a.ts")).toBe("failed");
      expect(handle.stateOf("/p/b.ts")).toBe("failed");
    }
  });

  it("scope change ⇒ new scopeKey: fresh probing, old results invisible", async () => {
    const scope = ref<PreviewPathScope | null>(SCOPE);
    const t = makeProbe((c) => ({ ok: true, results: c.paths.map(() => "missing" as const) }));
    const { handle, sched } = setup(scope, t);
    handle.ensure(["/p/a.ts"]);
    sched.flush();
    await flushMicrotasks();
    expect(handle.stateOf("/p/a.ts")).toBe("missing");
    expect(t.calls).toHaveLength(1);

    scope.value = { ...SCOPE, sessionId: "s2" }; // session switch ⇒ new scopeKey
    expect(handle.stateOf("/p/a.ts")).toBeUndefined(); // old results do not leak
    handle.ensure(["/p/a.ts"]);
    sched.flush();
    await flushMicrotasks();
    expect(t.calls).toHaveLength(2); // re-probed under the new scope
    expect(t.calls[1]!.sessionId).toBe("s2");
  });

  it("no scope ⇒ ensure is a no-op and stateOf is undefined", async () => {
    const scope = ref<PreviewPathScope | null>(null);
    const t = makeProbe(() => ({ ok: true, results: [] }));
    const { handle } = setup(scope, t);
    handle.ensure(["/p/a.ts"]);
    expect(handle.stateOf("/p/a.ts")).toBeUndefined();
    await flushMicrotasks();
    expect(t.calls).toHaveLength(0);
  });

  it("batches honour the 100-entry wire cap", async () => {
    const scope = ref<PreviewPathScope | null>(SCOPE);
    const t = makeProbe((c) => ({ ok: true, results: c.paths.map(() => "text" as const) }));
    const { handle, sched } = setup(scope, t);
    const paths = Array.from({ length: 150 }, (_, i) => `/p/${i}.ts`);
    handle.ensure(paths);
    sched.flush();
    await flushMicrotasks();
    expect(t.calls).toHaveLength(2);
    expect(t.calls[0]!.paths).toHaveLength(100);
    expect(t.calls[1]!.paths).toHaveLength(50);
  });

  it("dispose (effect-scope teardown) cancels the scheduled flush and ignores late answers", async () => {
    const scope = ref<PreviewPathScope | null>(SCOPE);
    const t = makeProbe((c) => ({ ok: true, results: c.paths.map(() => "text" as const) }));
    const sched = manualSchedule();
    const es = effectScope();
    const handle: PreviewProbeHandle = es.run(() =>
      usePreviewProbe({ probe: (req) => t.fn(req as ProbeCall), scope, schedule: sched.schedule }),
    )!;
    handle.ensure(["/p/a.ts"]);
    expect(sched.pending()).toBe(true);
    es.stop(); // onScopeDispose fires: disposed = true, scheduled flush cancelled
    expect(sched.pending()).toBe(false);
    sched.flush(); // a stray post-teardown flush may still drain the queue…
    await flushMicrotasks();
    // …but the late transport answer is dropped: the entry stays pending, never confirmed
    expect(t.calls).toHaveLength(0);
    expect(handle.stateOf("/p/a.ts")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2026-10-09 negative-result TTL — a later mention of a missing/failed path re-probes
// once its TTL has passed (the "file created by the tool call that first mentioned it"
// flow). Fake clock + manual scheduler: no real timers; one-request-per-tick preserved.
// ---------------------------------------------------------------------------

describe("usePreviewProbe — negative-result TTL (2026-10-09 fix)", () => {
  it("missing re-probes after 10 s (not before); the fresh answer flips stateOf", async () => {
    const scope = ref<PreviewPathScope | null>(SCOPE);
    const t = { v: 0 };
    const probe = makeProbe((c) => ({ ok: true, results: c.paths.map(() => "missing" as const) }));
    const { handle, sched } = setup(scope, probe, () => t.v);
    handle.ensure(["/p/a.png"]);
    sched.flush();
    await flushMicrotasks();
    expect(handle.stateOf("/p/a.png")).toBe("missing");

    t.v = 9_999; // in-window: a NEW message mentioning the path still stays plain
    handle.ensure(["/p/a.png"]);
    sched.flush();
    await flushMicrotasks();
    expect(probe.calls).toHaveLength(1);

    t.v = 10_000; // expired: the next message's ensure re-probes exactly once
    handle.ensure(["/p/a.png"]);
    expect(handle.stateOf("/p/a.png")).toBe("missing"); // old negative until the fresh settle
    sched.flush();
    expect(probe.calls).toHaveLength(2);
    await flushMicrotasks();
    expect(handle.stateOf("/p/a.png")).toBe("missing"); // still nothing there

    t.v = 20_000; // another TTL later, the next mention re-probes again
    handle.ensure(["/p/a.png"]);
    sched.flush();
    await flushMicrotasks();
    expect(probe.calls).toHaveLength(3); // re-probed again at the next TTL boundary
  });

  it("the fresh answer flips a stale missing to confirmed (clickable)", async () => {
    const scope = ref<PreviewPathScope | null>(SCOPE);
    const t = { v: 0 };
    let answer: "missing" | "image" = "missing";
    const probe = makeProbe((c) => ({ ok: true, results: c.paths.map(() => answer) }));
    const { handle, sched } = setup(scope, probe, () => t.v);
    handle.ensure(["/p/a.png"]);
    sched.flush();
    await flushMicrotasks();
    expect(handle.stateOf("/p/a.png")).toBe("missing");
    t.v = 10_000;
    answer = "image";
    handle.ensure(["/p/a.png"]); // a NEW message mentions it after the file appeared
    sched.flush();
    await flushMicrotasks();
    expect(handle.stateOf("/p/a.png")).toBe("confirmed");
    // …and confirmed is sticky: no further requests ever
    t.v = 600_000;
    handle.ensure(["/p/a.png"]);
    sched.flush();
    await flushMicrotasks();
    expect(probe.calls).toHaveLength(2);
  });

  it("failed re-probes after 30 s (anti-retry-storm floor)", async () => {
    const scope = ref<PreviewPathScope | null>(SCOPE);
    const t = { v: 0 };
    const probe = makeProbe(() => ({ ok: false as const, status: 503, error: "E_BUSY" }));
    const { handle, sched } = setup(scope, probe, () => t.v);
    handle.ensure(["/p/a.ts"]);
    sched.flush();
    await flushMicrotasks();
    expect(handle.stateOf("/p/a.ts")).toBe("failed");
    t.v = 29_999;
    handle.ensure(["/p/a.ts"]);
    sched.flush();
    await flushMicrotasks();
    expect(probe.calls).toHaveLength(1);
    t.v = 30_000;
    handle.ensure(["/p/a.ts"]);
    sched.flush();
    await flushMicrotasks();
    expect(probe.calls).toHaveLength(2);
  });

  it("no double-submit while a re-probe is pending; stateOf keeps the old negative until settle", async () => {
    const scope = ref<PreviewPathScope | null>(SCOPE);
    const t = { v: 0 };
    const waiting: Array<(o: PreviewProbeOutcome) => void> = [];
    const calls: ProbeCall[] = [];
    const probe = {
      calls,
      fn: (req: ProbeCall) =>
        new Promise<PreviewProbeOutcome>((resolve) => {
          calls.push(req);
          waiting.push(resolve);
        }),
    };
    const { handle, sched } = setup(scope, probe, () => t.v);
    handle.ensure(["/p/a.png"]);
    sched.flush();
    await flushMicrotasks();
    waiting.shift()!({ ok: true, results: ["missing"] });
    await flushMicrotasks();
    t.v = 10_000;
    handle.ensure(["/p/a.png"]); // expired — re-probe leaves on the wire…
    sched.flush();
    expect(calls).toHaveLength(2);
    expect(handle.stateOf("/p/a.png")).toBe("missing"); // …but stays visible as missing
    // a third message while that re-probe is in flight must NOT submit again
    t.v = 10_500;
    handle.ensure(["/p/a.png"]);
    sched.flush();
    await flushMicrotasks();
    expect(calls).toHaveLength(2);
    waiting.shift()!({ ok: true, results: ["image"] });
    await flushMicrotasks();
    expect(handle.stateOf("/p/a.png")).toBe("confirmed");
  });

  it("batching is preserved: expired negatives + a new path leave in ONE request", async () => {
    const scope = ref<PreviewPathScope | null>(SCOPE);
    const t = { v: 0 };
    const probe = makeProbe((c) => ({ ok: true, results: c.paths.map(() => "missing" as const) }));
    const { handle, sched } = setup(scope, probe, () => t.v);
    handle.ensure(["/p/a.ts", "/p/b.ts"]);
    sched.flush();
    await flushMicrotasks();
    expect(probe.calls).toHaveLength(1);
    t.v = 10_000;
    // one message later: both stale negatives plus one brand-new candidate
    handle.ensure(["/p/a.ts", "/p/b.ts", "/p/c.ts"]);
    sched.flush();
    await flushMicrotasks();
    expect(probe.calls).toHaveLength(2);
    expect(probe.calls[1]!.paths).toEqual(["/p/a.ts", "/p/b.ts", "/p/c.ts"]);
  });
});

// ---------------------------------------------------------------------------
// dir-plan v3.1 §5 P3 — dirs 透传 + kind 记录 (kindOf)
// ---------------------------------------------------------------------------

describe("usePreviewProbe — dirs passthrough + kindOf (dir-plan P3)", () => {
  it("a dirs scope adds dirs:true to the probe body; a plain scope stays byte-identical", async () => {
    const scope = ref<PreviewPathScope | null>({ ...SCOPE, dirs: true });
    const t = makeProbe((c) => ({ ok: true, results: c.paths.map(() => "dir" as const) }));
    const { handle, sched } = setup(scope, t);
    handle.ensure(["/p/src"]);
    sched.flush();
    await flushMicrotasks();
    expect(t.calls[0]!.dirs).toBe(true);

    const plain = ref<PreviewPathScope | null>(SCOPE);
    const t2 = makeProbe((c) => ({ ok: true, results: c.paths.map(() => "text" as const) }));
    const r2 = setup(plain, t2);
    r2.handle.ensure(["/p/a.ts"]);
    r2.sched.flush();
    await flushMicrotasks();
    expect(t2.calls[0]!.dirs).toBeUndefined(); // no dirs key at all — byte-identical body
  });

  it("kindOf returns the confirmed kind; unknown/failed paths stay undefined", async () => {
    const scope = ref<PreviewPathScope | null>({ ...SCOPE, dirs: true });
    const t = makeProbe((c) => ({
      ok: true,
      results: c.paths.map((p) => (p === "/p/src" ? "dir" : p === "/p/img.png" ? "image" : "missing")),
    }));
    const { handle, sched } = setup(scope, t);
    expect(handle.kindOf?.("/p/src")).toBeUndefined(); // nothing settled yet
    handle.ensure(["/p/src", "/p/img.png", "/p/gone.ts"]);
    sched.flush();
    await flushMicrotasks();
    expect(handle.kindOf?.("/p/src")).toBe("dir");
    expect(handle.kindOf?.("/p/img.png")).toBe("image");
    expect(handle.kindOf?.("/p/gone.ts")).toBe("missing");
    expect(handle.kindOf?.("/p/never.ts")).toBeUndefined();
  });

  it("a failed batch records no kinds (the caller falls back to the 415 path)", async () => {
    const scope = ref<PreviewPathScope | null>({ ...SCOPE, dirs: true });
    const t = makeProbe(() => ({ ok: false as const, status: 503, error: "E_BUSY" }));
    const { handle, sched } = setup(scope, t);
    handle.ensure(["/p/src"]);
    sched.flush();
    await flushMicrotasks();
    expect(handle.stateOf("/p/src")).toBe("failed");
    expect(handle.kindOf?.("/p/src")).toBeUndefined();
  });

  it("kindOf partitions by scopeKey like stateOf — a session switch reads a fresh slate", async () => {
    const scope = ref<PreviewPathScope | null>({ ...SCOPE, dirs: true });
    const t = makeProbe((c) => ({ ok: true, results: c.paths.map(() => "dir" as const) }));
    const { handle, sched } = setup(scope, t);
    handle.ensure(["/p/src"]);
    sched.flush();
    await flushMicrotasks();
    expect(handle.kindOf?.("/p/src")).toBe("dir");
    scope.value = { ...SCOPE, sessionId: "s2" };
    expect(handle.kindOf?.("/p/src")).toBeUndefined();
  });

  it("the kinds map is bounded (PROBE_LRU_CAP): the oldest entry ages out", async () => {
    const scope = ref<PreviewPathScope | null>({ ...SCOPE, dirs: true });
    const t = makeProbe((c) => ({ ok: true, results: c.paths.map(() => "dir" as const) }));
    const { handle, sched } = setup(scope, t);
    handle.ensure(["/p/first"]);
    sched.flush();
    await flushMicrotasks();
    expect(handle.kindOf?.("/p/first")).toBe("dir");
    // 300 more paths (in wire batches of ≤100) push the map past its 256 cap
    handle.ensure(Array.from({ length: 300 }, (_, i) => `/p/x${i}`));
    sched.flush();
    await flushMicrotasks();
    expect(handle.kindOf?.("/p/first")).toBeUndefined(); // aged out, FIFO
    expect(handle.kindOf?.("/p/x299")).toBe("dir");
  });
});
