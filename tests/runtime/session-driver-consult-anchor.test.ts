import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, createAgentSession: vi.fn() };
});
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import type { DriverEvent, SessionSpec } from "../../src/core/types.js";
import { getPrefixProbeRegistry, installPrefixProbe } from "../../src/consult/prefix-probe.js";
import { PiSessionDriver } from "../../src/runtime/session-driver.js";

const createMock = vi.mocked(createAgentSession);
const model = { api: "anthropic-messages", provider: "test", id: "model" };
let directory: string;
function sessionFile(): string {
  const path = join(directory, "fork.jsonl");
  writeFileSync(
    path,
    `${JSON.stringify({ type: "session", version: 3, id: "s_fork", timestamp: new Date().toISOString(), cwd: directory })}\n`,
  );
  return path;
}
function body(oauth = false): any {
  const cc = { type: "ephemeral" };
  return {
    model: "model",
    system: [
      ...(oauth ? [{ type: "text", text: "oauth", cache_control: cc }] : []),
      { type: "text", text: "system", cache_control: cc },
    ],
    tools: [{ name: "read", cache_control: cc }],
    messages: [
      { role: "user", content: [{ type: "text", text: "history" }] },
      { role: "assistant", content: [{ type: "text", text: "expert answer" }] },
      { role: "user", content: [{ type: "text", text: "question", cache_control: cc }] },
    ],
  };
}
function fakeSession(original?: (p: unknown, m: unknown) => unknown) {
  const listeners: Array<(event: unknown) => void> = [];
  return {
    sessionId: "s_fork",
    sessionFile: sessionFile(),
    agent: { onPayload: original as unknown },
    subscribe(listener: (event: unknown) => void) {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    emit(event: unknown) {
      for (const listener of [...listeners]) listener(event);
    },
    dispose: vi.fn(),
  };
}
function guard() {
  return {
    preflight: vi.fn(() => ({ ok: true as const })),
    install: vi.fn(),
    counters: vi.fn(() => ({ calls: 0, batches: 0, terminated: false, identity: 0, nested: 0, costAfterUsd: 0 })),
  };
}
const assistant = (read = 90, write = 5) => ({
  type: "message_end",
  message: {
    role: "assistant",
    stopReason: "stop",
    usage: { input: 5, cacheRead: read, cacheWrite: write, output: 1, cost: { total: 0.01 } },
  },
});

describe("PiSessionDriver consult anchor production wiring", () => {
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "pi-consult-anchor-"));
    createMock.mockReset();
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it.each([false, true])(
    "installs inside extensions and outside the unchanged C2 guard (preserve=%s)",
    async (preserve) => {
      const extension = vi.fn((p: any) => {
        expect(p.messages[1].content[0].cache_control).toEqual({ type: "ephemeral" });
        return { ...p, metadata: { user_id: "extension-final" } };
      });
      const session = fakeSession(extension);
      createMock.mockResolvedValue({ session } as never);
      const runId = `consult-anchor-preserve-${preserve}`;
      const g = guard();
      const handle = await new PiSessionDriver().resume(sessionFile(), {
        runId,
        cwd: directory,
        forkSessionFrom: session.sessionFile,
        consultAnchor: { prompt: "question" },
        ...(preserve ? { consultGuard: g } : {}),
      } as SessionSpec);
      expect(createMock.mock.calls[0]?.[0]).not.toHaveProperty("consultAnchor");
      expect(createMock.mock.calls[0]?.[0]).not.toHaveProperty("consultGuard");
      const original = body();
      const effective = await (session.agent.onPayload as Function)(original, model);
      expect(effective.metadata).toEqual({ user_id: "extension-final" });
      const record = getPrefixProbeRegistry().get(runId)!;
      expect(record.first?.anchor?.state).toBe("added");
      expect(record.anchor?.identity).toMatchObject({ k: 2, block: 0, blockType: "text" });
      expect(record.first?.fieldHashes.metadata).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(record)).not.toContain("expert answer");
      expect(JSON.stringify(record)).not.toContain("question");
      expect(original.messages[1].content[0].cache_control).toBeUndefined();
      expect(extension).toHaveBeenCalledTimes(1);
      if (preserve) {
        expect(g.preflight).toHaveBeenCalledTimes(1);
        expect(g.install).toHaveBeenCalledTimes(1);
      }
      handle.dispose();
    },
  );

  it("emits first exactly once, immediately after assistant message_end, using first request usage not later/ping/tool usage", async () => {
    const session = fakeSession();
    createMock.mockResolvedValue({ session } as never);
    const driver = new PiSessionDriver();
    const runId = "consult-anchor-first";
    const handle = await driver.resume(sessionFile(), {
      runId,
      cwd: directory,
      forkSessionFrom: session.sessionFile,
      consultAnchor: { prompt: "question" },
      consultGuard: guard(),
    } as SessionSpec);
    const events: DriverEvent[] = [];
    await driver.bind(handle, (event) => events.push(event));
    session.emit(assistant()); // no request: no metric yet
    expect(events.some((e) => e.t === "consult_cache_first")).toBe(false);
    await (session.agent.onPayload as Function)(body(), model);
    session.emit({ type: "message_end", message: { role: "toolResult", usage: { input: 90000, cacheRead: 0 } } });
    session.emit({
      type: "entry_appended",
      entry: { customType: "subagent:cache-keepalive", data: { cacheRead: 900000 } },
    });
    expect(events.some((e) => e.t === "consult_cache_first")).toBe(false);
    session.emit(assistant());
    const firstIndex = events.findIndex((e) => e.t === "consult_cache_first");
    expect(events[firstIndex - 1]?.t).toBe("message_end");
    expect(events[firstIndex]).toEqual({
      t: "consult_cache_first",
      result: { v: 1, anchor: "added", readShare: 0.9, label: "hit" },
    });
    await (session.agent.onPayload as Function)(body(), model);
    session.emit(assistant(0, 95));
    session.emit(assistant(0, 95));
    expect(events.filter((e) => e.t === "consult_cache_first")).toHaveLength(1);
    expect(getPrefixProbeRegistry().get(runId)?.requests?.[1]?.usage?.cacheRead).toBe(0);
    handle.dispose();
  });

  it.each([
    ["OAuth", true, model, { prompt: "question" }, "relocated", true],
    ["non-Anthropic", false, { ...model, api: "other" }, { prompt: "question" }, "n/a", undefined],
    ["untrusted prompt", false, model, { prompt: "wrong" }, "skipped:shape", undefined],
    ["main without anchor spec", false, model, undefined, "n/a", undefined],
  ] as const)("reports %s first status honestly", async (_name, oauth, route, anchor, state, degraded) => {
    const session = fakeSession();
    createMock.mockResolvedValue({ session } as never);
    const driver = new PiSessionDriver();
    const events: DriverEvent[] = [];
    const handle = await driver.resume(sessionFile(), {
      runId: `consult-status-${_name}`,
      cwd: directory,
      forkSessionFrom: session.sessionFile,
      ...(anchor ? { consultAnchor: anchor } : {}),
    } as SessionSpec);
    await driver.bind(handle, (e) => events.push(e));
    await (session.agent.onPayload as Function)(body(oauth), route);
    session.emit(assistant(0, 95));
    expect(events.find((e) => e.t === "consult_cache_first")).toEqual({
      t: "consult_cache_first",
      result: { v: 1, anchor: state, readShare: 0, label: "miss", ...(degraded ? { degraded } : {}) },
    });
    handle.dispose();
  });

  it("marks the first cache result degraded if an extension invalidates the final anchor identity", async () => {
    const session = fakeSession((p: any) => ({
      ...p,
      system: [{ type: "text", text: "extension-rewritten", cache_control: { type: "ephemeral" } }],
    }));
    createMock.mockResolvedValue({ session } as never);
    const driver = new PiSessionDriver();
    const events: DriverEvent[] = [];
    const runId = "consult-final-identity-invalid";
    const handle = await driver.resume(sessionFile(), {
      runId,
      cwd: directory,
      forkSessionFrom: session.sessionFile,
      consultAnchor: { prompt: "question" },
    } as SessionSpec);
    await driver.bind(handle, (e) => events.push(e));
    await (session.agent.onPayload as Function)(body(), model);
    session.emit(assistant());
    expect(getPrefixProbeRegistry().get(runId)?.first?.anchorIdentityValid).toBe(false);
    expect(events.filter((e) => e.t === "consult_cache_first")).toEqual([
      { t: "consult_cache_first", result: { v: 1, anchor: "added", label: "hit", readShare: 0.9, degraded: true } },
    ]);
    handle.dispose();
  });

  it("pairs a successful response with the latest onPayload attempt when fallback re-enters before message_end", async () => {
    const session = fakeSession();
    createMock.mockResolvedValue({ session } as never);
    const driver = new PiSessionDriver();
    const events: DriverEvent[] = [];
    const runId = "consult-first-fallback-no-error-event";
    const handle = await driver.resume(sessionFile(), {
      runId,
      cwd: directory,
      forkSessionFrom: session.sessionFile,
      consultAnchor: { prompt: "question" },
    } as SessionSpec);
    await driver.bind(handle, (e) => events.push(e));
    await (session.agent.onPayload as Function)(body(true), model);
    await (session.agent.onPayload as Function)(body(true), model);
    session.emit(assistant());
    const record = getPrefixProbeRegistry().get(runId)!;
    expect(record.requests?.map((r) => r.anchor?.state)).toEqual(["relocated", "relocated"]);
    expect(record.first?.responseOk).toBe(false);
    expect(record.first?.usage).toBeUndefined();
    expect(record.firstSuccessful).toBe(record.requests?.[1]);
    expect(record.firstSuccessful?.usage?.cacheRead).toBe(90);
    expect(events.filter((e) => e.t === "consult_cache_first")).toHaveLength(1);
    handle.dispose();
  });

  it.each(["error", "aborted"])(
    "does not consume first on %s; retries keep relocation and emit successful usage once",
    async (stopReason) => {
      const session = fakeSession();
      createMock.mockResolvedValue({ session } as never);
      const driver = new PiSessionDriver();
      const events: DriverEvent[] = [];
      const runId = `consult-first-retry-${stopReason}`;
      const handle = await driver.resume(sessionFile(), {
        runId,
        cwd: directory,
        forkSessionFrom: session.sessionFile,
        consultAnchor: { prompt: "question" },
      } as SessionSpec);
      await driver.bind(handle, (e) => events.push(e));
      const apply = session.agent.onPayload as Function;
      await apply(body(true), model);
      const failed = assistant(0, 0);
      failed.message.stopReason = stopReason;
      session.emit(failed);
      expect(events.some((e) => e.t === "consult_cache_first")).toBe(false);
      expect(getPrefixProbeRegistry().get(runId)?.first?.responseOk).toBe(false);
      expect(getPrefixProbeRegistry().get(runId)?.firstSuccessful).toBeUndefined();
      await apply(body(true), model);
      session.emit(assistant());
      const record = getPrefixProbeRegistry().get(runId)!;
      expect(record.requests?.map((r) => r.anchor?.state)).toEqual(["relocated", "relocated"]);
      expect(record.firstSuccessful).toBe(record.requests?.[1]);
      expect(events.filter((e) => e.t === "consult_cache_first")).toEqual([
        {
          t: "consult_cache_first",
          result: { v: 1, anchor: "relocated", label: "hit", readShare: 0.9, degraded: true },
        },
      ]);
      expect(events[events.findIndex((e) => e.t === "consult_cache_first") - 1]?.t).toBe("message_end");
      await apply(body(true), model);
      session.emit(assistant(0, 95));
      expect(events.filter((e) => e.t === "consult_cache_first")).toHaveLength(1);
      handle.dispose();
    },
  );

  it("does not lose the exactly-once first metric when the bounded diagnostic registry evicts its run", async () => {
    const session = fakeSession();
    createMock.mockResolvedValue({ session } as never);
    const driver = new PiSessionDriver();
    const events: DriverEvent[] = [];
    const handle = await driver.resume(sessionFile(), {
      runId: "consult-evicted-metric",
      cwd: directory,
      forkSessionFrom: session.sessionFile,
      consultAnchor: { prompt: "question" },
    } as SessionSpec);
    await driver.bind(handle, (e) => events.push(e));
    await (session.agent.onPayload as Function)(body(), model);
    for (let index = 0; index < 65; index++)
      installPrefixProbe({ agent: {} }, { runId: `evict-consult-metric-${index}` })();
    expect(getPrefixProbeRegistry().get("consult-evicted-metric")).toBeUndefined();
    session.emit(assistant());
    session.emit(assistant());
    expect(events.filter((e) => e.t === "consult_cache_first")).toEqual([
      { t: "consult_cache_first", result: { v: 1, anchor: "added", label: "hit", readShare: 0.9 } },
    ]);
    handle.dispose();
  });

  it("records n/a for a zero/missing-usage first response, never replaces it with later hits", async () => {
    const session = fakeSession();
    createMock.mockResolvedValue({ session } as never);
    const driver = new PiSessionDriver();
    const events: DriverEvent[] = [];
    const handle = await driver.resume(sessionFile(), {
      runId: "consult-missing-usage",
      cwd: directory,
      forkSessionFrom: session.sessionFile,
    } as SessionSpec);
    await driver.bind(handle, (e) => events.push(e));
    await (session.agent.onPayload as Function)(body(), model);
    session.emit({ type: "message_end", message: { role: "assistant" } });
    session.emit(assistant());
    expect(events.filter((e) => e.t === "consult_cache_first")).toEqual([
      { t: "consult_cache_first", result: { v: 1, anchor: "n/a", readShare: null, label: "n/a" } },
    ]);
    handle.dispose();
  });

  it.each(["create", "resume"] as const)(
    "T-A1: ordinary %s requests keep reference, bytes, hook semantics and emit no new metric even with an anchor spec",
    async (method) => {
      const original = vi.fn((_payload: unknown, _model: unknown) => undefined);
      const session = fakeSession(original);
      createMock.mockResolvedValue({ session } as never);
      const driver = new PiSessionDriver();
      const spec = {
        runId: `ordinary-anchor-${method}`,
        cwd: directory,
        persist: false,
        consultAnchor: { prompt: "question" },
      } as SessionSpec;
      const handle = await (method === "create" ? driver.create(spec) : driver.resume(sessionFile(), spec));
      const events: DriverEvent[] = [];
      await driver.bind(handle, (e) => events.push(e));
      const before = body();
      const bytes = JSON.stringify(before);
      expect(await (session.agent.onPayload as Function)(before, model)).toBeUndefined();
      expect(original.mock.calls[0]?.[0]).toBe(before);
      expect(JSON.stringify(before)).toBe(bytes);
      session.emit(assistant());
      expect(events.some((e) => e.t === "consult_cache_first")).toBe(false);
      expect(getPrefixProbeRegistry().get(`ordinary-anchor-${method}`)?.anchor).toBeUndefined();
      handle.dispose();
    },
  );
});

describe("runtime adapter host-only anchor handoff", () => {
  it.each([false, true])("passes the exact NOT_THREADED anchor only for a consult (consult=%s)", async (consult) => {
    const { FakeClock } = await import("../../src/core/clock.js");
    const { DEFAULT_BUDGET } = await import("../../src/core/deadline.js");
    const { MemoryRunStore } = await import("../../src/core/store.js");
    const { EscalatingReaper } = await import("../../src/runtime/reaper.js");
    const { SingleSlotPool } = await import("../../src/runtime/slot-pool.js");
    const { EventWatchdog } = await import("../../src/runtime/watchdog.js");
    const { createRuntimeRunnerAdapter } = await import("../../src/service/runtime-adapter.js");
    const clock = new FakeClock();
    const budget = {
      ...DEFAULT_BUDGET,
      queueWaitMs: 200,
      startupMs: 200,
      bindMs: 200,
      firstEventMs: 200,
      idleMs: 200,
      totalMs: 500,
      abortGraceMs: 20,
      reapMs: 30,
    };
    const anchor = { prompt: "question" };
    const captured: Array<SessionSpec & { prompt?: string }> = [];
    const handle = {
      sessionId: "adapter-anchor",
      sessionFile: undefined,
      prompt: async () => undefined,
      steer: async () => undefined,
      requestAbort: async () => undefined,
      dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
      killableHandles: new Set<never>(),
      setActiveTools: () => undefined,
      getActiveTools: () => [],
      getLastAssistantText: () => "answer",
      getUsage: () => undefined,
    };
    const capture = (spec: SessionSpec) => {
      captured.push(spec);
      return handle;
    };
    const adapter = createRuntimeRunnerAdapter({
      clock,
      pool: new SingleSlotPool(clock, 1),
      store: new MemoryRunStore(),
      reaper: new EscalatingReaper(clock),
      watchdog: new EventWatchdog({ clock, budget, getState: () => undefined, dispatch: () => undefined }),
      driver: {
        create: capture,
        resume: async (_file, spec) => capture(spec),
        bind: async () => undefined,
        onLateArrival: () => undefined,
      },
      notifier: {
        enqueue: () => undefined,
        finalize: () => "missing",
        settleBatch: () => undefined,
        peek: () => undefined,
        consume: () => false,
        reconcile: () => ({ redelivered: [], suppressed: [], abandoned: [] }),
        verifyPersisted: () => ({ missing: [] }),
        degraded: [],
        stats: { staged: 0, pending: 0, batched: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
      },
    });
    const promise = adapter.run({
      runId: "adapter-anchor-run",
      type: { name: "explorer", description: "explorer", systemPrompt: "explorer" },
      request: {
        type: "explorer",
        prompt: "question",
        consultAnchor: anchor,
        ...(consult ? { forkSessionFrom: "/trusted/fork.jsonl" } : {}),
      },
      budget,
    });
    for (let tick = 0; tick < 20; tick++) {
      await Promise.resolve();
      clock.advance(1);
      await Promise.resolve();
    }
    await promise;
    expect(captured).toHaveLength(1);
    expect(captured[0]?.consultAnchor).toBe(consult ? anchor : undefined);
    expect(captured[0]?.prompt).toBe(consult ? "question" : "explorer\n\nquestion"); // anchor stays out of the model-facing prompt
  });
});
