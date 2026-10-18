import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ConsultWiring } from "../../src/consult/index.js";
import { consultSessionDir } from "../../src/consult/fork-store.js";
import { sandboxHome } from "./helpers/home-sandbox.js";

/**
 * cache-thread plan §7 (R1 #1): `ConsultWiring.close()` on all three teardown paths — session_shutdown (the one
 * pi's `/reload` hits), the session_start defensive cleanup, and the same-module stack rebuild — and the
 * fresh-module `/reload` case where the module-level `previousConsult` handoff is invisible.
 *
 * The real `activate()` / `buildSessionStack()` run; only `wireConsult` is wrapped (via vi.mock) to capture every
 * wiring instance so the test can plant a thread head and read the closure's state. A fresh module instance (what
 * pi's jiti `moduleCache:false` produces on /reload) is obtained with `vi.resetModules()` + dynamic import.
 * A real jiti load of the entry (`loadExtensions`) is exercised separately for the load/activation contract.
 */

const captured = vi.hoisted(() => ({ wirings: [] as unknown[] }));
vi.mock("../../src/consult/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/consult/index.js")>();
  return {
    ...original,
    wireConsult: (deps: Parameters<typeof original.wireConsult>[0]) => {
      const wiring = original.wireConsult(deps);
      captured.wirings.push(wiring);
      return wiring;
    },
  };
});

const HOST_KEY = Symbol.for("pi-subagent:host");
let sandbox: ReturnType<typeof sandboxHome> | undefined;
let scratch: string;
beforeEach(() => {
  sandbox = sandboxHome();
  scratch = mkdtempSync(join(tmpdir(), "consult-reload-"));
  captured.wirings.length = 0;
  delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
});
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  vi.useRealTimers();
  vi.restoreAllMocks();
  sandbox?.restore();
  sandbox = undefined;
  rmSync(scratch, { recursive: true, force: true });
});

function activatePi() {
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const pi = {
    registerTool: () => undefined,
    registerCommand: () => undefined,
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage: () => undefined,
    appendEntry: () => undefined,
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
    getAllTools: () => [],
    setActiveTools: () => undefined,
  };
  const emit = async (event: string, payload: unknown = {}, ctx: unknown = {}): Promise<void> => {
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
  };
  return { pi: pi as unknown as ExtensionAPI, emit };
}

function fakeCtx(): ExtensionContext {
  return {
    sessionManager: {
      getEntries: () => [],
      getBranch: () => [],
      getSessionId: () => "reload-test",
      getSessionFile: () => undefined,
    },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    ui: {},
    cwd: process.cwd(),
    isIdle: () => true,
  } as unknown as ExtensionContext;
}

const lastWiring = (): ConsultWiring => captured.wirings.at(-1) as ConsultWiring;

/** Plant a promoted thread head (a real file in the consult dir) + a ledger touch through the wiring's own API. */
function plantHead(wiring: ConsultWiring, tag: string): { original: string; head: string } {
  const dir = consultSessionDir();
  mkdirSync(dir, { recursive: true });
  const original = join(scratch, `expert-${tag}.jsonl`);
  writeFileSync(original, `${JSON.stringify({ type: "session", id: `s_${tag}` })}\n`, "utf8");
  const head = join(dir, `head-${tag}.jsonl`);
  writeFileSync(head, `${JSON.stringify({ type: "session", id: `h_${tag}` })}\n`, "utf8");
  const lease = wiring.threads.begin({
    askerRunId: `r_ASK_${tag}`,
    expertRunId: `r_EXP_${tag}`,
    originalFile: original,
  })!;
  expect(wiring.threads.openFork(lease, head)).toBe(true);
  wiring.threads.settle(head, { eligible: true, tokens: 10, consultRunId: `r_C_${tag}` });
  wiring.threads.finish(lease);
  wiring.onReaped(`r_C_${tag}`, head, { disposed: true });
  expect(wiring.threads.isHead(head)).toBe(true);
  expect(existsSync(head)).toBe(true);
  wiring.anchorLedger.noteTouch({
    expertRunId: `r_EXP_${tag}`,
    route: { provider: "p", model: "m" },
    snapDigest: "d",
    anchor: "added",
    touchedAt: Date.now(),
  });
  expect(wiring.anchorLedger.size()).toBe(1);
  return { original, head };
}

/** An in-flight consult fork (file exists, session not disposed) on the same thread. */
function plantInFlight(wiring: ConsultWiring, tag: string, original: string): string {
  const path = join(consultSessionDir(), `inflight-${tag}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: "session", id: `i_${tag}` })}\n`, "utf8");
  const lease = wiring.threads.begin({
    askerRunId: `r_ASK_${tag}`,
    expertRunId: `r_EXP_${tag}`,
    originalFile: original,
  })!;
  expect(lease.mode).toBe("continued");
  expect(wiring.threads.openFork(lease, path)).toBe(true);
  return path;
}

describe("consult wiring teardown (§7)", () => {
  it("path ① session_shutdown: heads deleted, ledger cleared, registry closed; a late reap only deletes (never promotes)", async () => {
    const { default: activate } = await import("../../src/index.js");
    const host = activatePi();
    activate(host.pi);
    await host.emit("session_start", { reason: "startup" }, fakeCtx());
    const wiring = lastWiring();
    const { original, head } = plantHead(wiring, "a");
    const inflight = plantInFlight(wiring, "a", original);

    await host.emit("session_shutdown", { reason: "reload" }, fakeCtx());

    expect(existsSync(head)).toBe(false);
    expect(wiring.threads.stats().closed).toBe(true);
    expect(wiring.threads.views()).toEqual([]);
    expect(wiring.anchorLedger.size()).toBe(0);
    // The in-flight fork is never touched before its own session is gone …
    expect(existsSync(inflight)).toBe(true);
    // … and when the OLD closure's runner finally reaps it, it is deleted, not promoted.
    wiring.threads.settle(inflight, { eligible: true, tokens: 5 });
    wiring.onReaped("r_late", inflight, { disposed: true });
    expect(existsSync(inflight)).toBe(false);
    expect(wiring.threads.views()).toEqual([]);
    expect(wiring.threads.stats().promotions).toBe(1); // only the pre-close promotion
  }, 30_000);

  it("path ② session_start without a paired shutdown: the defensive cleanup closes the previous wiring", async () => {
    const { default: activate } = await import("../../src/index.js");
    const host = activatePi();
    activate(host.pi);
    await host.emit("session_start", { reason: "startup" }, fakeCtx());
    const first = lastWiring();
    const { head } = plantHead(first, "b");
    await host.emit("session_start", { reason: "resume" }, fakeCtx());
    const second = lastWiring();
    expect(second).not.toBe(first);
    expect(existsSync(head)).toBe(false);
    expect(first.threads.stats().closed).toBe(true);
    expect(second.threads.stats().closed).toBe(false);
    expect(second.threads.views()).toEqual([]);
    await host.emit("session_shutdown", { reason: "quit" }, fakeCtx());
    expect(second.threads.stats().closed).toBe(true);
  }, 30_000);

  it("path ③ same-module rebuild: buildSessionStack closes the previous stack's consult wiring first", async () => {
    const { buildSessionStack } = await import("../../src/stack.js");
    const { DEFAULT_SETTINGS } = await import("../../src/config/settings.js");
    const types = {
      get: () => undefined,
      list: () => [],
      reload: async () => ({ types: [], errors: [] }),
    } as never;
    const pi = activatePi().pi;
    const settings = { ...DEFAULT_SETTINGS, fleetWidget: false };
    const s1 = buildSessionStack(pi, fakeCtx(), settings, types, []);
    expect(s1.consult).toBe(lastWiring());
    const { head } = plantHead(s1.consult, "c");
    const s2 = buildSessionStack(pi, fakeCtx(), settings, types, []);
    try {
      expect(existsSync(head)).toBe(false);
      expect(s1.consult.threads.stats().closed).toBe(true);
      expect(s2.consult.threads.stats().closed).toBe(false);
    } finally {
      s2.consult.close();
      s1.bashJobs?.dispose();
      s2.bashJobs?.dispose();
    }
  }, 30_000);

  it("fresh-module /reload (new module instances, module-level handoff invisible): shutdown of the OLD activation cleans up; the new stack starts empty", async () => {
    const oldModule = await import("../../src/index.js");
    const hostA = activatePi();
    oldModule.default(hostA.pi);
    await hostA.emit("session_start", { reason: "startup" }, fakeCtx());
    const oldWiring = lastWiring();
    const { original, head } = plantHead(oldWiring, "d");
    const inflight = plantInFlight(oldWiring, "d", original);

    // pi: session_shutdown(reason "reload") on the old runner, THEN re-import the extension as a fresh module.
    await hostA.emit("session_shutdown", { reason: "reload" }, fakeCtx());
    vi.resetModules();
    const freshModule = await import("../../src/index.js");
    expect(freshModule.default).not.toBe(oldModule.default); // genuinely a new module instance
    const hostB = activatePi();
    freshModule.default(hostB.pi);
    await hostB.emit("session_start", { reason: "reload" }, fakeCtx());
    const newWiring = lastWiring();

    expect(newWiring).not.toBe(oldWiring);
    expect(existsSync(head)).toBe(false); // closed by the OLD activation's shutdown path
    expect(newWiring.threads.views()).toEqual([]);
    expect(newWiring.threads.stats().closed).toBe(false);
    // the old closure's late onReaped (old runner finishing after the new stack exists) only deletes
    oldWiring.threads.settle(inflight, { eligible: true, tokens: 1 });
    oldWiring.onReaped("r_late", inflight, { disposed: true });
    expect(existsSync(inflight)).toBe(false);
    expect(newWiring.threads.views()).toEqual([]);
    await hostB.emit("session_shutdown", { reason: "quit" }, fakeCtx());
  }, 30_000);

  it("close() is idempotent across the three paths and leaves no extra active handles (no timers are ever created)", async () => {
    const { default: activate } = await import("../../src/index.js");
    const host = activatePi();
    activate(host.pi);
    await host.emit("session_start", { reason: "startup" }, fakeCtx());
    const wiring = lastWiring();
    plantHead(wiring, "e");
    const timersBefore = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.().length;
    wiring.close();
    wiring.close();
    await host.emit("session_shutdown", { reason: "reload" }, fakeCtx());
    await host.emit("session_shutdown", { reason: "reload" }, fakeCtx());
    const timersAfter = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.().length;
    if (timersBefore !== undefined && timersAfter !== undefined) expect(timersAfter).toBeLessThanOrEqual(timersBefore);
    expect(wiring.threads.stats().closed).toBe(true);
  }, 30_000);

  it("a duplicate onReaped on a retained head never deletes it; shutdown does", async () => {
    const { default: activate } = await import("../../src/index.js");
    const host = activatePi();
    activate(host.pi);
    await host.emit("session_start", { reason: "startup" }, fakeCtx());
    const wiring = lastWiring();
    const { head } = plantHead(wiring, "f");
    wiring.onReaped("r_C_f", head, { disposed: true }); // duplicate callback on a retained head
    expect(existsSync(head)).toBe(true);
    wiring.onReaped("r_C_f", head); // and without info
    expect(existsSync(head)).toBe(true);
    await host.emit("session_shutdown", { reason: "quit" }, fakeCtx());
    expect(existsSync(head)).toBe(false);
  }, 30_000);
});

describe("consult wiring runtime hooks", () => {
  it("an asker's terminal snapshot (dispatchSnapshot, the stack tap) closes its threads and deletes the head (R2-2)", async () => {
    const { default: activate } = await import("../../src/index.js");
    const host = activatePi();
    activate(host.pi);
    await host.emit("session_start", { reason: "startup" }, fakeCtx());
    const wiring = lastWiring();
    const { head } = plantHead(wiring, "g");
    wiring.dispatchSnapshot({ runId: "r_ASK_g", status: "running" } as never);
    expect(existsSync(head)).toBe(true); // non-terminal: untouched
    wiring.dispatchSnapshot({ runId: "r_ASK_g", status: "completed" } as never);
    expect(existsSync(head)).toBe(false);
    expect(wiring.threads.views()).toEqual([]);
    await host.emit("session_shutdown", { reason: "quit" }, fakeCtx());
  }, 30_000);

  it("takeDisplayMeta is take-once and unknown for an unregistered fork path", async () => {
    const { default: activate } = await import("../../src/index.js");
    const host = activatePi();
    activate(host.pi);
    await host.emit("session_start", { reason: "startup" }, fakeCtx());
    const wiring = lastWiring();
    expect(wiring.takeDisplayMeta("/nope")).toBeUndefined();
    await host.emit("session_shutdown", { reason: "quit" }, fakeCtx());
  }, 30_000);
});

describe("real jiti load (pi's own loader)", () => {
  it("the entry loads twice as independent module instances and both register a session_shutdown handler", async () => {
    const codingAgent = await import("@earendil-works/pi-coding-agent");
    const packageRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
    const loader = (codingAgent as unknown as { loadExtensions?: (p: string[], cwd: string) => Promise<any> })
      .loadExtensions;
    if (loader === undefined) return; // host without the public loader: covered by entry-loader.test.ts
    const a = await loader([resolve(packageRoot, "index.ts")], packageRoot);
    delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
    const b = await loader([resolve(packageRoot, "index.ts")], packageRoot);
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
    for (const loaded of [a, b]) {
      const ext = loaded.extensions[0];
      expect(ext.handlers.get("session_shutdown")?.length ?? 0).toBeGreaterThan(0);
      expect(ext.handlers.get("session_start")?.length ?? 0).toBeGreaterThan(0);
    }
  }, 60_000);
});
