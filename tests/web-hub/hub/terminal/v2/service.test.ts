import { describe, it, expect, vi } from "vitest";
import { HubTerminalServiceV2 } from "../../../../../src/web-hub/hub/terminal/v2/service.js";
import { TerminalFaultV2 } from "../../../../../src/web-hub/hub/terminal/v2/timing.js";
import type { TerminalBackend, TerminalPhysicalResult } from "../../../../../src/web-hub/hub/terminal/v2/backend.js";
import type {
  TerminalAllocationLedgerPortV2,
  TerminalContextSnapshotV2,
} from "../../../../../src/web-hub/hub/terminal-v2-ports.js";
import type { AllocationV2, LedgerV2, TerminalCreateInputV2 } from "../../../../../src/web-hub/protocol/terminal-v2.js";
import type { AuthIdentity } from "../../../../../src/web-hub/hub/auth-identity.js";
const id = (s: string) => s.repeat(24).slice(0, 24);
const boot = "11111111-1111-4111-8111-111111111111";
const scope = { agentKey: "agent", sessionId: "session", epoch: "epoch" };
const auth: AuthIdentity = {
  listener: "lan",
  principal: "u1",
  sidTag: "a".repeat(43),
  userId: 1,
  parentExpiresAt: Date.now() + 360000,
};
const limits = { maxPerSession: 2, inputIdleMs: 3600000, maxLifetimeMs: 28800000 };
const signal = () => new AbortController().signal;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const proof: TerminalPhysicalResult = {
  outcome: "reaped",
  spawnSettled: true,
  ptyClosed: true,
  helperReaped: true,
  managedGroupsGone: true,
  identitiesChecked: [],
  waited: [],
  exitCode: 0,
};
function allocation(n: string, session = "session", principal = "lan:u1"): AllocationV2 {
  return {
    allocationId: id(n),
    termId: id(n.toUpperCase()),
    hubInstance: id("o"),
    kernelBootId: boot,
    scope: { ...scope, sessionId: session },
    quotaSessionKey: session,
    principalKey: principal,
    creatorSidTag: "a".repeat(43),
  };
}
function harness(cold: AllocationV2[] = []) {
  let disk: LedgerV2 = { v: 2, storeId: id("s"), revision: 0, allocations: cold };
  let commitFailure: "none" | "unknown" | undefined, commitGate: Promise<void> | undefined;
  let current = true,
    rev = 0,
    allow = true,
    resolveCount = 0,
    spawn = 0,
    inputs = 0,
    resizes = 0,
    closes = 0;
  const reserveReached = deferred<void>();
  let snapshot: TerminalContextSnapshotV2 = { scope, cwd: "/tmp", contextGeneration: 1, linkInstance: {}, limits };
  let resolveGate: Promise<void> | undefined;
  let physical = deferred<TerminalPhysicalResult>();
  let autoProof = true;
  const ledger: TerminalAllocationLedgerPortV2 = {
    load: async () => ({ kind: "loaded", ledger: structuredClone(disk) }),
    commit: async (expected, next) => {
      reserveReached.resolve();
      if (commitGate) await commitGate;
      if (commitFailure) return { kind: "unavailable", effect: commitFailure };
      if (expected !== disk.revision) return { kind: "conflict" };
      disk = structuredClone(next);
      return { kind: "committed", revision: next.revision };
    },
  };
  const service = new HubTerminalServiceV2({
    ledger,
    hubInstance: id("h"),
    kernelBootId: boot,
    revision: () => rev,
    check: (_a, _s, r) => {
      if (!allow) throw new TerminalFaultV2("E_PRIVACY");
      if (r !== rev) throw new TerminalFaultV2("E_REVOKING");
      return limits;
    },
    context: {
      resolve: async () => {
        resolveCount++;
        if (resolveGate) await resolveGate;
        return snapshot;
      },
      current: () => current,
    },
    backend: (options) => {
      expect(disk.allocations.length).toBeGreaterThan(0);
      spawn++;
      const backend: TerminalBackend = {
        ready: Promise.resolve(),
        done: physical.promise,
        managed: [],
        spawnSettled: true,
        display: { shellName: "bash", userLabel: "fixture", hostLabel: "fixture" },
        input: async () => {
          inputs++;
        },
        resize: async () => {
          resizes++;
        },
        close: () => {
          closes++;
          if (autoProof) physical.resolve(proof);
        },
        retryReap: async () => physical.promise,
      };
      options.onData(Buffer.from("hello"));
      return backend;
    },
  });
  const create = (requestId = id("r"), mode: "new" | "ensure-empty" = "new", s = scope, a = auth) =>
    service.create(a, s, { hubInstance: id("h"), requestId, mode, cols: 80, rows: 24 }, signal());
  return {
    service,
    create,
    reserveReached,
    get physical() {
      return physical;
    },
    resetPhysical() {
      physical = deferred<TerminalPhysicalResult>();
    },
    get disk() {
      return disk;
    },
    get counts() {
      return { spawn, resolveCount, inputs, resizes, closes };
    },
    set current(v: boolean) {
      current = v;
    },
    set allow(v: boolean) {
      allow = v;
    },
    set rev(v: number) {
      rev = v;
    },
    set snapshot(v: TerminalContextSnapshotV2) {
      snapshot = v;
    },
    set commitGate(v: Promise<void> | undefined) {
      commitGate = v;
    },
    set resolveGate(v: Promise<void> | undefined) {
      resolveGate = v;
    },
    set failure(v: "none" | "unknown" | undefined) {
      commitFailure = v;
    },
    set autoProof(v: boolean) {
      autoProof = v;
    },
  };
}
describe("hub v2 sole resource owner", () => {
  it("cold unknown occupies exactly original dimensions and leaves default one slot", async () => {
    const h = harness([allocation("x")]);
    await h.service.initialize(signal());
    const list = await h.service.list(auth, scope, signal());
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.rows).toEqual([]);
      expect(list.unknownResources).toHaveLength(1);
      expect(list.quota.session).toEqual({ used: 1, unknown: 1, limit: 2 });
    }
    const first = await h.create();
    expect(first.ok).toBe(true);
    expect(h.disk.allocations).toHaveLength(2);
    expect(await h.create(id("n"))).toEqual({ ok: false, code: "E_LIMIT", effect: "none" });
    expect(h.counts.spawn).toBe(1);
    expect(
      await h.service.close(auth, { scope, hubInstance: id("h"), termId: allocation("x").termId }, signal()),
    ).toEqual({ ok: false, code: "E_CLEANUP_UNKNOWN", effect: "none" });
    expect((await h.service.dispose()).unresolved).toBe(1);
    expect(h.disk.allocations).toEqual([allocation("x")]);
  });
  it("same session across epoch/agent cannot bypass frozen session quota", async () => {
    const h = harness([allocation("x"), allocation("y")]);
    await h.service.initialize(signal());
    expect(await h.create(id("r"), "new", { ...scope, agentKey: "new-agent", epoch: "new-epoch" })).toEqual({
      ok: false,
      code: "E_SESSION_CHANGED",
      effect: "none",
    });
    // Context must also match: a new legitimate epoch is still charged the same session key.
    h.snapshot = { scope: { ...scope, epoch: "new" }, cwd: "/tmp", contextGeneration: 2, linkInstance: {}, limits };
    expect(await h.create(id("t"), "new", { ...scope, epoch: "new" })).toEqual({
      ok: false,
      code: "E_LIMIT",
      effect: "none",
    });
    expect(h.counts.spawn).toBe(0);
  });
  it("total7 admits precisely one with unrelated original scopes/principals", async () => {
    const cold = Array.from({ length: 7 }, (_, n) => allocation(String(n), `s${n}`, `lan:u${n + 10}`));
    const h = harness(cold);
    await h.service.initialize(signal());
    expect((await h.create()).ok).toBe(true);
    expect(await h.create(id("n"))).toEqual({ ok: false, code: "E_LIMIT", effect: "none" });
    expect(h.disk.allocations).toHaveLength(8);
    expect(h.counts.spawn).toBe(1);
    await h.service.dispose();
  });
  it("same request captures context once, different payload conflicts", async () => {
    const h = harness();
    await h.service.initialize(signal());
    const [a, b] = await Promise.all([h.create(), h.create()]);
    expect(a).toEqual(b);
    expect(h.counts).toMatchObject({ spawn: 1, resolveCount: 1 });
    const input: TerminalCreateInputV2 = { hubInstance: id("h"), requestId: id("r"), mode: "new", cols: 81, rows: 24 };
    expect(await h.service.create(auth, scope, input, signal())).toEqual({
      ok: false,
      code: "E_IDEMPOTENCY_CONFLICT",
      effect: "none",
    });
    await h.service.dispose();
  });
  it("cross-browser ensure joins one pending fork, two explicit new remain distinct", async () => {
    const h = harness();
    await h.service.initialize(signal());
    const gate = deferred<void>();
    h.resolveGate = gate.promise;
    const a = h.create(id("a"), "ensure-empty"),
      b = h.create(id("b"), "ensure-empty");
    gate.resolve();
    const [one, two] = await Promise.all([a, b]);
    expect(one.ok && two.ok && one.termId === two.termId).toBe(true);
    expect(h.counts.spawn).toBe(1);
    const three = await h.create(id("c"));
    expect(three.ok && one.ok && three.termId !== one.termId).toBe(true);
    expect(h.counts.spawn).toBe(2);
    await h.service.dispose();
  });
  it("durable reserve barrier has ZERO backend; stale context after commit cannot fork", async () => {
    const h = harness();
    await h.service.initialize(signal());
    const gate = deferred<void>();
    h.commitGate = gate.promise;
    const pending = h.create();
    await h.reserveReached.promise;
    expect(h.counts.spawn).toBe(0);
    expect(h.disk.allocations).toHaveLength(0);
    h.current = false;
    gate.resolve();
    expect((await pending).ok).toBe(false);
    await h.service.dispose();
    expect(h.counts.spawn).toBe(0);
    expect(h.disk.allocations).toHaveLength(0);
  });
  it.each(["none", "unknown"] as const)(
    "reserve %s never forks; unknown is globally resource failclosed",
    async (effect) => {
      const h = harness();
      await h.service.initialize(signal());
      h.failure = effect;
      expect(await h.create()).toEqual({ ok: false, code: "E_RESOURCE_UNAVAILABLE", effect });
      expect(h.counts.spawn).toBe(0);
      h.failure = undefined;
      const next = await h.create(id("t"));
      expect(next.ok).toBe(effect === "none");
      await h.service.dispose();
    },
  );
  it("proof barrier keeps allocation; invalidation is synchronous; prune failure never frees", async () => {
    const h = harness();
    await h.service.initialize(signal());
    const created = await h.create();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const request = { scope, hubInstance: id("h"), termId: created.termId, viewId: id("v") };
    const result = await h.service.runtime(auth, request, signal());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    h.autoProof = false;
    h.service.invalidateCreators(() => true);
    expect(result.runtime.invalidated.aborted).toBe(true);
    expect(result.runtime.current()).toBe(false);
    expect(h.disk.allocations).toHaveLength(1);
    h.failure = "none";
    h.physical.resolve(proof);
    const disposed = await h.service.dispose();
    expect(disposed.clean).toBe(false);
    expect(h.disk.allocations).toHaveLength(1);
  });
  it("only complete physical proof plus exact prune closes, shared user not creator ACL", async () => {
    const h = harness();
    await h.service.initialize(signal());
    const c = await h.create();
    if (!c.ok) throw new Error("create failed");
    const other = { ...auth, principal: "u2", sidTag: "b".repeat(43), userId: 2 };
    const request = { scope, hubInstance: id("h"), termId: c.termId, viewId: id("v") };
    const runtime = await h.service.runtime(other, request, signal());
    expect(runtime.ok).toBe(true);
    if (!runtime.ok) return;
    expect(runtime.runtime.read(0, 3)).toEqual({
      start: 2,
      end: 5,
      chunks: [{ offset: 2, bytesB64: Buffer.from("llo").toString("base64") }],
    });
    expect(await runtime.runtime.write("eA==", "user", signal())).toEqual({ ok: true });
    expect(h.counts.inputs).toBe(1);
    expect(await runtime.runtime.resize(100, 40, signal())).toEqual({ ok: true });
    expect(h.counts.resizes).toBe(1);
    expect(await h.service.close(other, request, signal())).toMatchObject({ ok: true, state: "closed" });
    expect(h.disk.allocations).toEqual([]);
    expect(h.disk.revision).toBe(2);
    expect(await runtime.runtime.write("eA==", "user", signal())).toEqual({
      ok: false,
      code: "E_VIEW_CHANGED",
      effect: "none",
    });
    expect(await h.service.close(other, request, signal())).toMatchObject({ ok: true, state: "closed" });
    expect(await h.service.dispose()).toEqual({ clean: true, unresolved: 0 });
    expect(h.service.maintenanceSnapshot()).toMatchObject({
      stopped: true,
      pendingCreates: 0,
      runtimes: [],
      allocationCount: 0,
    });
  });
  it("HTTP cancellation only cancels waiting; accepted owner still settles once", async () => {
    const h = harness();
    await h.service.initialize(signal());
    const gate = deferred<void>();
    h.resolveGate = gate.promise;
    const abort = new AbortController();
    const result = h.service.create(
      auth,
      scope,
      { hubInstance: id("h"), requestId: id("r"), mode: "new", cols: 80, rows: 24 },
      abort.signal,
    );
    abort.abort();
    expect(await result).toEqual({ ok: false, code: "E_DEADLINE", effect: "unknown" });
    gate.resolve();
    const retry = await h.create();
    expect(retry.ok).toBe(true);
    expect(h.counts.spawn).toBe(1);
    await h.service.dispose();
  });
  it("retire scope seals before awaits and late context cannot adopt", async () => {
    const h = harness();
    await h.service.initialize(signal());
    const gate = deferred<void>();
    h.resolveGate = gate.promise;
    const pending = h.create();
    h.service.retireScope(scope);
    gate.resolve();
    expect((await pending).ok).toBe(false);
    expect(h.counts.spawn).toBe(0);
    expect(h.disk.allocations).toEqual([]);
    await h.service.dispose();
  });
  it("invalidate callback is synchronous/no IO, close starts later and callback faults never escape auth", async () => {
    const h = harness();
    await h.service.initialize(signal());
    expect((await h.create()).ok).toBe(true);
    h.service.invalidateCreators(() => true);
    expect(h.counts.closes).toBe(0);
    expect(h.disk.allocations).toHaveLength(1);
    await h.service.dispose();
    expect(h.counts.closes).toBe(1);
    const broken = harness();
    await broken.service.initialize(signal());
    await broken.create();
    expect(() =>
      broken.service.invalidateCreators(() => {
        throw new Error("callback fault");
      }),
    ).not.toThrow();
    expect(broken.service.maintenanceSnapshot().resourceAvailable).toBe(false);
    await broken.service.dispose();
  });
  it("context deadline is 2s and unresolved ignored-abort contexts still occupy 32 physical flights", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      await h.service.initialize(signal());
      const gate = deferred<void>();
      h.resolveGate = gate.promise;
      const work = Array.from({ length: 32 }, (_, n) =>
        h.create(id(`A${n}_`), "new", { ...scope, sessionId: `s${n}` }),
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(await h.create(id("z"), "new", { ...scope, sessionId: "overflow" })).toEqual({
        ok: false,
        code: "E_LIMIT",
        effect: "none",
      });
      await vi.advanceTimersByTimeAsync(2000);
      const results = await Promise.all(work);
      expect(results.every((r) => !r.ok && r.code === "E_DEADLINE")).toBe(true);
      expect(h.counts.resolveCount).toBe(32);
      expect(h.counts.spawn).toBe(0);
      expect(await h.create(id("y"), "new", { ...scope, sessionId: "still-full" })).toEqual({
        ok: false,
        code: "E_LIMIT",
        effect: "none",
      });
      gate.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await h.service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
  it("5s accepted create deadline seals an ignored-abort late reserve; late commit never forks", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      await h.service.initialize(signal());
      const gate = deferred<void>();
      h.commitGate = gate.promise;
      const work = h.create();
      await h.reserveReached.promise;
      expect(h.counts.spawn).toBe(0);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await work).toEqual({ ok: false, code: "E_DEADLINE", effect: "unknown" });
      expect(h.counts.spawn).toBe(0);
      gate.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.counts.spawn).toBe(0);
      expect(h.disk.allocations).toEqual([]);
      expect(await h.service.dispose()).toEqual({ clean: true, unresolved: 0 });
      expect(h.service.maintenanceSnapshot().unspawnedPrunes).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("active runtime wakes for inactive-tab rename/create/close without a second stream", async () => {
    const h = harness();
    await h.service.initialize(signal());
    const first = await h.create();
    if (!first.ok) throw new Error("first");
    const runtime = await h.service.runtime(
      auth,
      { scope, hubInstance: id("h"), termId: first.termId, viewId: id("v") },
      signal(),
    );
    if (!runtime.ok) throw new Error("runtime");
    let wakes = 0;
    const stop = runtime.runtime.subscribe(() => {
      wakes++;
    });
    const second = await h.create(id("b"));
    if (!second.ok) throw new Error("second");
    expect(wakes).toBeGreaterThan(0);
    const before = wakes;
    expect(
      (await h.service.rename(auth, { scope, hubInstance: id("h"), termId: second.termId, name: "renamed" }, signal()))
        .ok,
    ).toBe(true);
    expect(wakes).toBeGreaterThan(before);
    stop();
    await h.service.dispose();
  });
  it("pending durable reservation is starting quota, not a cold unknown projection", async () => {
    const h = harness();
    await h.service.initialize(signal());
    const gate = deferred<void>();
    h.commitGate = gate.promise;
    const create = h.create();
    await h.reserveReached.promise;
    const list = await h.service.list(auth, scope, signal());
    if (!list.ok) throw new Error("list");
    expect(list.quota.session).toEqual({ used: 1, unknown: 0, limit: 2 });
    expect(list.unknownResources).toEqual([]);
    expect(h.counts.spawn).toBe(0);
    gate.resolve();
    await create;
    await h.service.dispose();
  });
  it("closing a newly published starting tab seals its still-unstarted backend future", async () => {
    const h = harness();
    await h.service.initialize(signal());
    const first = await h.create();
    if (!first.ok) throw new Error("first");
    const runtime = await h.service.runtime(
      auth,
      { scope, hubInstance: id("h"), termId: first.termId, viewId: id("v") },
      signal(),
    );
    if (!runtime.ok) throw new Error("runtime");
    let requested = false,
      close: Promise<unknown> | undefined;
    const stop = runtime.runtime.subscribe(() => {
      const next = h.service.maintenanceSnapshot().runtimes.find((r) => r.termId !== first.termId);
      if (next && !requested) {
        requested = true;
        close = h.service.close(auth, { scope, hubInstance: id("h"), termId: next.termId }, signal());
      }
    });
    expect((await h.create(id("b"))).ok).toBe(false);
    expect(requested).toBe(true);
    await close;
    expect(h.counts.spawn).toBe(1);
    stop();
    await h.service.dispose();
  });
  it("auth revision/privacy changed during context has zero reserve and fork", async () => {
    for (const mutate of [
      (h: ReturnType<typeof harness>) => {
        h.rev = 1;
      },
      (h: ReturnType<typeof harness>) => {
        h.allow = false;
      },
    ]) {
      const h = harness();
      await h.service.initialize(signal());
      const gate = deferred<void>();
      h.resolveGate = gate.promise;
      const pending = h.create();
      mutate(h);
      gate.resolve();
      expect((await pending).ok).toBe(false);
      expect(h.disk.revision).toBe(0);
      expect(h.counts.spawn).toBe(0);
      await h.service.dispose();
    }
  });
});

describe("P6 scope invalidation versus permanent retirement", () => {
  it("original link handles are sealed but a fresh trusted declaration in the same epoch may create", async () => {
    const h = harness();
    await h.service.initialize(signal());
    const created = await h.create();
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("expected original term");
    const original = await h.service.runtime(auth, { scope, hubInstance: id("h"), termId: created.termId }, signal());
    expect(original.ok).toBe(true);
    h.service.invalidateScope(scope);
    if (original.ok) expect(original.runtime.invalidated.aborted).toBe(true);
    expect((await h.service.close(auth, { scope, hubInstance: id("h"), termId: created.termId }, signal())).ok).toBe(
      true,
    );
    expect((await h.service.list(auth, scope, signal())).ok).toBe(true);
    h.resetPhysical();
    const next = await h.create(id("z"));
    expect(next.ok).toBe(true);
    expect(h.counts.spawn).toBe(2);
    h.service.retireScope(scope);
    expect(await h.create(id("y"))).toMatchObject({ ok: false, code: "E_SESSION_CHANGED" });
    await h.service.dispose();
  });
});
