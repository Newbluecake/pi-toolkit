/** Original views -> original service runtime -> original P2 gate -> backend barrier.
 * Only ledger/backend are port doubles. Context producer/resolver and auth fence are
 * production implementations wired synchronously in-process with explicit trusted facts;
 * no SDK, HTTP authentication, UDS, actual kernel/PTY or physical proof claim here. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubTerminalServiceV2 } from "../../../../../src/web-hub/hub/terminal/v2/service.js";
import { createTerminalViewsV2, type TerminalViewsV2 } from "../../../../../src/web-hub/hub/terminal/v2/view.js";
import { createTerminalResizeGateV2 } from "../../../../../src/web-hub/hub/terminal/v2/resize-gate.js";
import { TerminalRevocationFenceV2 } from "../../../../../src/web-hub/hub/terminal/v2/revocation-fence.js";
import { createHubTerminalContextV2 } from "../../../../../src/web-hub/hub/terminal/v2/context.js";
import { createTerminalContextProducer } from "../../../../../src/web-hub/agent/terminal/context.js";
import type { TerminalBackend, TerminalPhysicalResult } from "../../../../../src/web-hub/hub/terminal/v2/backend.js";
import type { LedgerV2 } from "../../../../../src/web-hub/protocol/terminal-v2.js";
import type { TerminalAllocationLedgerPortV2 } from "../../../../../src/web-hub/hub/terminal-v2-ports.js";
import type { AuthIdentity } from "../../../../../src/web-hub/hub/auth-identity.js";
const hubInstance = "h".repeat(24);
const scope = { agentKey: "a".repeat(24), sessionId: "session", epoch: "epoch" };
const signal = () => new AbortController().signal;
const identity = (): AuthIdentity => ({
  listener: "loopback",
  principal: "p",
  sidTag: "s",
  parentExpiresAt: Date.now() + 1_000_000,
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
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
const cleanups: Array<() => Promise<void>> = [];
async function flush() {
  for (let n = 0; n < 30; n++) await Promise.resolve();
}
async function setup() {
  const id = identity(),
    fence = new TerminalRevocationFenceV2();
  const limits = { maxPerSession: 2, inputIdleMs: 3600000, maxLifetimeMs: 28800000 };
  const binding = {};
  const ctx = { cwd: "/isolated", mode: "rpc" as const, sessionManager: { getSessionId: () => scope.sessionId } };
  const producer = createTerminalContextProducer({
    current: () => ({
      ctx,
      epoch: scope.epoch,
      linkInstance: binding,
      domain: "plain" as const,
      privateNamespace: "not-ns" as const,
      isChild: false,
      enabled: true,
      control: true,
      webCommands: true,
      limits,
    }),
    guard: () => true,
  });
  expect(producer.start()).toBe(true);
  const declaration = producer.declaration()!;
  const context = createHubTerminalContextV2({
    permitted: () => true,
    link: () => ({
      instance: binding,
      scope,
      declaration,
      pendingBytes: 0,
      send(frame) {
        context.consume(binding, producer.reply(frame, binding));
        return true;
      },
    }),
  });
  let disk: LedgerV2 = { v: 2, storeId: "s".repeat(24), revision: 0, allocations: [] };
  const ledger: TerminalAllocationLedgerPortV2 = {
    load: async () => ({ kind: "loaded", ledger: structuredClone(disk) }),
    commit: async (expected, next) => {
      expect(expected).toBe(disk.revision);
      disk = structuredClone(next);
      return { kind: "committed", revision: next.revision };
    },
  };
  const backends: Array<{
    resize: ReturnType<typeof vi.fn<TerminalBackend["resize"]>>;
    done: ReturnType<typeof deferred<TerminalPhysicalResult>>;
  }> = [];
  const service = new HubTerminalServiceV2({
    ledger,
    context: context.port,
    hubInstance,
    kernelBootId: "11111111-1111-4111-8111-111111111111",
    revision: () => fence.revision,
    check: (auth, _scope, revision) => {
      fence.check(auth, revision);
      return limits;
    },
    backend: () => {
      const done = deferred<TerminalPhysicalResult>();
      const resize = vi.fn<TerminalBackend["resize"]>(async () => {});
      backends.push({ resize, done });
      return {
        ready: Promise.resolve(),
        done: done.promise,
        managed: [],
        spawnSettled: true,
        input: vi.fn(async () => {}),
        resize,
        close: () => done.resolve(proof),
        retryReap: () => done.promise,
      };
    },
  });
  const factories: TerminalViewsV2[] = [];
  // Deliberately allow a FRESH P2 gate: P1 must fence its physical backend even if
  // a replacement adapter has no knowledge of the earlier logical runtime future.
  const makeViews = () => {
    const views = createTerminalViewsV2({
      service,
      hubInstance,
      auth: fence,
      notifications: fence,
      revalidate: async (auth) => ({ ok: true, identity: auth }),
      resizeGate: createTerminalResizeGateV2(),
    });
    factories.push(views);
    return views;
  };
  await service.initialize(signal());
  const create = async (requestId: string) => {
    const result = await service.create(
      id,
      scope,
      { hubInstance, requestId, mode: "new", cols: 80, rows: 24 },
      signal(),
    );
    if (!result.ok) throw new Error(result.code);
    return result.termId;
  };
  const termId = await create("r".repeat(24));
  const envelope = { scope, hubInstance, termId };
  const acquired = await service.runtime(id, envelope, signal());
  if (!acquired.ok) throw new Error(acquired.code);
  const attach = async (views: TerminalViewsV2, term = termId) => {
    const result = await views.open(id, { ...envelope, termId: term }, signal());
    if (!result.ok) throw new Error(result.code);
    const sink = { send: vi.fn(() => true), close: vi.fn() };
    result.view.start(sink);
    await vi.advanceTimersByTimeAsync(10);
    const writer = { ...envelope, termId: term, viewId: result.view.viewId };
    expect(await views.ack(id, { ...writer, offset: 0, replayComplete: true }, signal())).toEqual({
      ok: true,
      offset: 0,
    });
    await vi.advanceTimersByTimeAsync(10);
    return { writer, view: result.view, sink };
  };
  cleanups.push(async () => {
    for (const views of factories) views.dispose();
    for (const b of backends) b.done.resolve(proof);
    await service.dispose();
    context.dispose();
    producer.dispose();
    fence.dispose();
  });
  return {
    id,
    fence,
    service,
    backends,
    makeViews,
    attach,
    create,
    envelope,
    runtime: acquired.runtime,
    disk: () => disk,
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});
describe("P7A original service/runtime/view resize integration", () => {
  it.each(["abort", "timeout", "detach", "factory"] as const)(
    "%s logical finish cannot release original physical resize across new view/factory/gate",
    async (end) => {
      const h = await setup(),
        views = h.makeViews(),
        old = await h.attach(views);
      const physical = deferred<void>(),
        controller = new AbortController();
      let physicalSettled = false;
      const backend = h.backends[0]!;
      backend.resize.mockImplementationOnce(async () => {
        await physical.promise;
        physicalSettled = true;
      });
      const at = Date.now();
      const first = views.resize(h.id, { ...old.writer, seq: 1, cols: 80, rows: 24 }, controller.signal);
      let logicalSettled = false;
      void first.then(() => {
        logicalSettled = true;
      });
      await flush();
      expect(backend.resize).toHaveBeenCalledOnce();
      if (end === "abort") controller.abort();
      if (end === "timeout") {
        await vi.advanceTimersByTimeAsync(1999);
        expect(logicalSettled).toBe(false);
        expect(physicalSettled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
      }
      if (end === "detach") old.view.detach();
      if (end === "factory") views.dispose();
      expect(await first).toMatchObject({ ok: false, effect: "unknown" });
      expect(Date.now() - at).toBeLessThanOrEqual(2000);
      old.view.detach();
      const replacement = end === "factory" ? h.makeViews() : views;
      const next = await h.attach(replacement);
      const busyAt = Date.now();
      const second = await replacement.resize(h.id, { ...next.writer, seq: 1, cols: 90, rows: 24 }, signal());
      expect(Date.now() - busyAt).toBeLessThan(2000);
      console.info("P7A physical barrier", { end, second, calls: backend.resize.mock.calls.length, physicalSettled });
      expect(second).toEqual({ ok: false, code: "E_NOT_READY", effect: "none" });
      expect(backend.resize).toHaveBeenCalledOnce();
      expect(physicalSettled).toBe(false);
      // Input and the other terminal do not wait behind a resize-only gate.
      expect(await h.runtime.write("eA==", "user", signal())).toEqual({ ok: true });
      const other = await h.create("n".repeat(24));
      const otherView = await h.attach(replacement, other);
      expect(await replacement.resize(h.id, { ...otherView.writer, seq: 1, cols: 100, rows: 24 }, signal())).toEqual({
        ok: true,
        acceptedThrough: 1,
      });
      physical.resolve();
      await flush();
      expect(await replacement.resize(h.id, { ...next.writer, seq: 2, cols: 110, rows: 24 }, signal())).toEqual({
        ok: true,
        acceptedThrough: 2,
      });
      expect(backend.resize.mock.calls.map((args) => args.slice(1))).toEqual([
        [80, 24],
        [110, 24],
      ]);
    },
  );
  it.each(["resolve", "reject"] as const)(
    "late %s releases exactly the original operation, never a pending successor",
    async (end) => {
      const h = await setup(),
        oldWork = deferred<void>(),
        nextWork = deferred<void>();
      const b = h.backends[0]!;
      b.resize.mockImplementationOnce(() => oldWork.promise).mockImplementationOnce(() => nextWork.promise);
      const cancel = new AbortController();
      const first = h.runtime.resize(80, 24, cancel.signal);
      await flush();
      cancel.abort();
      expect(await first).toMatchObject({ ok: false, effect: "unknown" });
      const blocked = h.runtime.resize(90, 24, signal());
      await vi.advanceTimersByTimeAsync(2000);
      expect(await blocked).toMatchObject({ ok: false, effect: "none" });
      expect(b.resize).toHaveBeenCalledOnce();
      if (end === "resolve") oldWork.resolve();
      else oldWork.reject(new Error("injected late reject"));
      await flush();
      const second = h.runtime.resize(100, 24, signal());
      await flush();
      expect(b.resize).toHaveBeenCalledTimes(2);
      // Repeat release/old microtasks cannot unlock the new operation.
      oldWork.resolve();
      await flush();
      expect(await h.runtime.resize(110, 24, signal())).toMatchObject({ ok: false, effect: "none" });
      await vi.advanceTimersByTimeAsync(2000);
      expect(await second).toMatchObject({ ok: false, effect: "unknown" });
      expect(await h.runtime.resize(120, 24, signal())).toMatchObject({ ok: false, effect: "none" });
      expect(b.resize).toHaveBeenCalledTimes(2);
      nextWork.resolve();
      await flush();
      expect(await h.runtime.resize(130, 24, signal())).toEqual({ ok: true });
    },
  );
  it("service dispose stays bounded and unresolved while the real resize future is pending", async () => {
    const h = await setup(),
      physical = deferred<void>();
    h.backends[0]!.resize.mockImplementationOnce(() => physical.promise);
    const first = h.runtime.resize(80, 24, signal());
    const at = Date.now();
    expect(await h.service.dispose()).toEqual({ clean: false, unresolved: 1 });
    expect(Date.now() - at).toBeLessThanOrEqual(2000);
    expect(h.disk().allocations).toHaveLength(1);
    expect(await h.runtime.resize(90, 24, signal())).toMatchObject({ code: "E_VIEW_CHANGED", effect: "none" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await first).toMatchObject({ ok: false, effect: "unknown" });
    expect(h.service.maintenanceSnapshot()).toMatchObject({ stopped: true, allocationCount: 1, physicalPrunes: 0 });
    physical.resolve();
    await flush();
    expect(h.service.maintenanceSnapshot()).toMatchObject({ allocationCount: 0, physicalPrunes: 1 });
    expect(h.disk().allocations).toEqual([]);
  });
  it("service invalidation retains resources until real resize settlement, rejects old runtime and allows a fresh same-scope lifecycle", async () => {
    const h = await setup(),
      physical = deferred<void>();
    h.backends[0]!.resize.mockImplementationOnce(() => physical.promise);
    const controller = new AbortController();
    const first = h.runtime.resize(80, 24, controller.signal);
    controller.abort();
    expect(await first).toMatchObject({ effect: "unknown" });
    h.service.invalidateScope(scope);
    await flush();
    expect(h.runtime.current()).toBe(false);
    expect(await h.runtime.resize(90, 24, signal())).toMatchObject({ code: "E_VIEW_CHANGED", effect: "none" });
    expect(h.disk().allocations).toHaveLength(1);
    const freshTerm = await h.create("f".repeat(24));
    const fresh = await h.service.runtime(h.id, { ...h.envelope, termId: freshTerm }, signal());
    if (!fresh.ok) throw new Error(fresh.code);
    expect(await fresh.runtime.resize(100, 24, signal())).toEqual({ ok: true });
    physical.resolve();
    await flush();
    expect(h.disk().allocations.map((a) => a.termId)).toEqual([freshTerm]);
    expect(h.runtime.current()).toBe(false);
    expect(await h.runtime.resize(110, 24, signal())).toMatchObject({ code: "E_VIEW_CHANGED" });
  });
});
