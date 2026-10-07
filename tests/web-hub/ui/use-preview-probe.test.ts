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

type ProbeCall = { agentKey: string; sessionId: string; paths: string[] };

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
): { handle: PreviewProbeHandle; sched: ReturnType<typeof manualSchedule> } {
  const sched = manualSchedule();
  const handle = usePreviewProbe({
    probe: (req, opts) => transport.fn(req as ProbeCall),
    scope,
    schedule: sched.schedule,
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
