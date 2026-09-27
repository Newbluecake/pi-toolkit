/**
 * P1 review fix (todo #30 follow-up, §3.3/§3.9) — real-path regression, run through the actual
 * production seam the review specifically asked for: `SpawnService.spawn({resumeFrom})` →
 * `runtime-adapter.ts`'s `createRuntimeRunnerAdapter` → the REAL, unmodified `PiSessionDriver`
 * (constructed with no test double of its own) → `PiSessionDriver.resume()`, which itself calls
 * the REAL `SessionManager.open()`. Only pi's own `createAgentSession` (the one function that
 * would otherwise need real model/provider credentials and a live network) is mocked — everything
 * else in the `create()`/`resume()` chain, including the exact "resume reproduces the SAME
 * sessionId" premise todo #30 rests on, runs unmodified pi code against a real session file on
 * disk (redirected under a scratch `PI_CODING_AGENT_DIR` for the duration of each test, restored
 * and deleted afterwards — see `tests/integration/spike-mock.test.ts` for the isolated proof that
 * this mocking shape reproduces the real sessionId round-trip before this file builds on it).
 *
 * The `onSessionSeen`/`sealSession`/`onReaped` wiring below is a byte-for-byte mirror of
 * `src/stack.ts`'s own (see its `hostViewFor`/`onReaped`/`sealSession` call sites) against the
 * REAL, process-wide `getChildBashRegistry()` / `getChildKeepaliveDisposeRegistry()` singletons —
 * the actual registry-level bug and fix are exercised for real; only the "child session" side
 * (bash tool execution) is simulated the same way every other bash-timeout-grace test in this
 * repo simulates it (`wireChildBashJobs` + a fake `pi`), since driving a real bash tool call
 * through a real `AgentSession` turn is an orthogonal, already-covered concern
 * (`child-bash-jobs-real-session.test.ts`).
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    // The only thing mocked: pi's real session/model machinery. `SessionManager` (imported
    // unmocked from `actual` below via PiSessionDriver's own internals) still does everything —
    // header read/write, sessionId assignment, resume's `SessionManager.open()` — for real.
    createAgentSession: vi.fn(async (opts: Record<string, unknown>) => {
      const sessionManager = opts.sessionManager as {
        getSessionId(): string;
        getSessionFile(): string | undefined;
        appendMessage(message: unknown): string;
      };
      return {
        session: {
          sessionId: sessionManager.getSessionId(),
          sessionFile: sessionManager.getSessionFile(),
          sessionManager,
          model: undefined,
          messages: [] as unknown[],
          subscribe: () => undefined,
          prompt: async () => {
            // A real macrotask delay (not just a microtask chain) so a test can deterministically
            // observe this run "mid-flight" (host attached, sessionId known) before it settles —
            // without this, every step here is promise-chained with zero real I/O and the ENTIRE
            // run lifecycle can complete inside the SAME microtask flush a test's own `await`
            // yields into, leaving no observable window at all. Generous (not just "a bit longer
            // than instant"): a real bash subprocess call made while this run is still "live"
            // must have comfortable headroom to finish BEFORE this run's own on-time seal fires at
            // settle time — too tight a margin here reproduces a genuine race in the TEST HARNESS
            // itself (run-2 legitimately ending and killing a still-in-flight job is correct
            // production behavior, not the bug under test) under this sandbox's own CPU
            // contention, not a bug in the fix.
            await new Promise((resolve) => setTimeout(resolve, 1_500));
            // Real pi only flushes the session HEADER to disk once an assistant message entry
            // exists (`SessionManager._persist`'s "hasAssistant" gate) — force that here through
            // the REAL, public `appendMessage` so a later `SessionManager.open()` (resume) finds
            // a readable header on disk instead of silently minting a brand-new sessionId (see
            // the spike test's own discovery of this).
            sessionManager.appendMessage({
              role: "user",
              content: [{ type: "text", text: "hi" }],
              timestamp: Date.now(),
            });
            sessionManager.appendMessage({
              role: "assistant",
              content: [{ type: "text", text: "ok" }],
              api: "fake-api",
              provider: "fake-provider",
              model: "fake-model",
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
              stopReason: "stop",
              timestamp: Date.now(),
            });
            return undefined;
          },
          steer: async () => undefined,
          abort: () => undefined,
          dispose: () => undefined,
          setActiveToolsByName: () => undefined,
          getActiveToolNames: () => [] as string[],
          getLastAssistantText: () => "ok",
        },
      };
    }),
  };
});

import { PiSessionDriver } from "../../src/runtime/session-driver.js";
import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";
import { createSpawnService } from "../../src/service/spawn-service.js";
import { TombstoneStore } from "../../src/service/tombstone.js";
import { MemoryRunStore } from "../../src/core/store.js";
import { systemClock } from "../../src/core/clock.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import type { AgentTypeConfig } from "../../src/core/types.js";
import { getChildBashRegistry, type HostRunView } from "../../src/bash/child-registry.js";
import { getChildKeepaliveDisposeRegistry } from "../../src/cache-ttl/child-registry.js";
import { wireChildBashJobs } from "../../src/bash/child.js";
import { DEFAULT_SETTINGS, type AgentSettings } from "../../src/config/settings.js";

const posix = process.platform !== "win32";
const GRACE_MS = 50;

/** Minimal `pi` double for `wireChildBashJobs` — same convention as `tests/integration/child-bash-jobs.test.ts`. */
function fakePi() {
  const tools = new Map<string, { name: string; execute: (...args: never[]) => unknown }>();
  const pi = {
    registerTool: (tool: { name: string; execute: (...args: never[]) => unknown }) => tools.set(tool.name, tool),
    registerCommand: () => undefined,
    on: () => undefined,
    sendMessage: () => undefined,
    appendEntry: () => undefined,
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
  };
  return { pi: pi as unknown as ExtensionAPI, tools };
}
function fakeChildCtx(sessionId: string, cwd: string): ExtensionContext {
  return {
    cwd,
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined },
    model: { provider: "test", id: "test-model" },
  } as unknown as ExtensionContext;
}
function settingsWith(dir: string): AgentSettings {
  return { ...DEFAULT_SETTINGS, bashJobs: { ...DEFAULT_SETTINGS.bashJobs, dir } };
}

const scratchDirs: string[] = [];
let prevAgentDir: string | undefined;
afterEach(() => {
  if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  for (const d of scratchDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.clearAllMocks();
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

/** Assembles the SAME real production chain stack.ts wires (runtime-adapter + real PiSessionDriver
 * + SpawnService), with `onSessionSeen`/`sealSession`/`onReaped` mirroring stack.ts's own wiring
 * against the real, process-wide bash + keepalive registries. `deferOnReapedFor` lets a test hold
 * back one specific run's `onReaped` fan-out (the async, defensive call — see module doc) until it
 * is manually released via the returned `releaseDeferred`, to deterministically reproduce the
 * exact "late arrival after a resume already registered" ordering instead of relying on chance.
 */
function buildRealStack(cwd: string, deferOnReapedFor?: Set<string>) {
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-home");
  const driver = new PiSessionDriver();
  const pool = new SingleSlotPool(systemClock, 5);
  const store = new MemoryRunStore();
  const reaper = new EscalatingReaper(systemClock);
  const budget = {
    ...DEFAULT_BUDGET,
    queueWaitMs: 5_000,
    startupMs: 5_000,
    bindMs: 5_000,
    firstEventMs: 5_000,
    idleMs: 5_000,
    modelTurnMs: 5_000,
    toolMs: 5_000,
    totalMs: 8_000,
    abortGraceMs: 200,
    steerMs: 200,
    reapMs: 500,
  };
  const watchdog = new EventWatchdog({
    clock: systemClock,
    budget,
    getState: () => undefined,
    dispatch: () => undefined,
  });
  const notifier = {
    enqueue: () => undefined,
    finalize: () => "missing" as const,
    settleBatch: () => undefined,
    peek: () => undefined,
    consume: () => false,
    reconcile: () => ({ redelivered: [], suppressed: [], abandoned: [] }),
    verifyPersisted: () => ({ missing: [] }),
    stats: { staged: 0, pending: 0, batched: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
    degraded: [],
  };
  const deferred = new Map<string, () => void>();
  const hostViewFor = (runId: string): HostRunView => ({
    runId,
    watchdogDueAt: () => undefined,
    hardDeadlineAt: () => undefined,
    maxExtensions: () => 0,
    stopping: () => false,
    noteToolReturn: () => undefined,
  });
  const runner = createRuntimeRunnerAdapter({
    clock: systemClock,
    driver,
    pool,
    store,
    watchdog,
    reaper,
    notifier,
    // Byte-for-byte mirror of src/stack.ts's own onSessionSeen/sealSession/onReaped wiring.
    onSessionSeen: (runId, sessionId) => {
      getChildBashRegistry().attachHost(sessionId, hostViewFor(runId));
    },
    sealSession: (runId, sessionId) => getChildBashRegistry().sealAndKill(sessionId, GRACE_MS, runId)?.facts,
    onReaped: (runId, _forkSessionFrom, sessionId) => {
      if (sessionId === undefined) return;
      const fire = () => {
        getChildBashRegistry().sealAndKill(sessionId, GRACE_MS, runId);
        getChildKeepaliveDisposeRegistry().disposeSession(sessionId, runId);
      };
      if (deferOnReapedFor?.has(runId)) deferred.set(runId, fire);
      else fire();
    },
  });
  const type: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };
  const service = createSpawnService({
    types: { get: () => type, list: () => [type], reload: async () => ({ types: [type], errors: [] }) },
    pool,
    runner,
    tombstones: new TombstoneStore(),
    budget,
  });
  return {
    service,
    releaseDeferred: (runId: string) => {
      const fn = deferred.get(runId);
      deferred.delete(runId);
      fn?.();
    },
  };
}

describe.skipIf(!posix)(
  "todo #30 P1 real-path regression: SpawnService.spawn({resumeFrom}) → runtime-adapter → PiSessionDriver.resume",
  () => {
    it("(a) a resumed run's bash tool succeeds while the resumed run is still live — resume reproduces the same sessionId through the REAL SessionManager, and the real registry admits the new run", async () => {
      const cwd = scratchDir("pi-toolkit-resume-a-");
      const { service } = buildRealStack(cwd);
      const label = `ra-${randomUUID().slice(0, 8)}`;

      const run1 = await service.spawnAndWait({ type: "worker", prompt: "first", label, cwd });
      expect(run1.status).toBe("completed");
      expect(run1.diag.sessionFile).toBeTruthy();
      const realSessionId = await resolveRealSessionId(run1);

      // Let run-1's own (fire-and-forget) onReaped fan-out actually run — the NORMAL, in-order
      // case (no deferral here): the real bash registry should already show run-1 sealed.
      await waitUntil(() => getChildBashRegistry().isSealed(realSessionId));

      const spawned2 = await service.spawn({ type: "worker", prompt: "continue", resumeFrom: label, cwd });
      if ("error" in spawned2) throw new Error(spawned2.error.message);
      const run2Id = spawned2.runId;

      // todo #30's own premise, proven end-to-end through the real driver/SessionManager: wait
      // until the host view for this sessionId has switched to run-2's OWN runId (onSessionSeen
      // fires very early — well before run-2 settles/seals itself).
      await waitUntil(() => getChildBashRegistry().hostView(realSessionId)?.runId === run2Id);

      // The child session's own bash manager, sharing the sessionId resume reproduced, must be
      // admitted WHILE run-2 is still live (not permanently refused because a prior run of the
      // same sessionId sealed it).
      const { pi, tools } = fakePi();
      wireChildBashJobs(pi, { settings: settingsWith(cwd) });
      const bash = tools.get("bash")!;
      const result = await execBashResilient(bash, "call-1", "echo resumed-ok", fakeChildCtx(realSessionId, cwd));
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).not.toContain("run is ending");
      expect(getChildBashRegistry().isSealed(realSessionId)).toBe(false);

      const { settled } = await service.waitAll({ runIds: [run2Id], waitMs: 5_000 });
      expect(settled[0]?.status).toBe("completed");
    });

    /**
     * The exact bug the review reported (fails without the P1 fix — verified manually against the
     * pre-fix code, see `tests/bash/child-registry.test.ts`'s equivalent unit-level proof): run-1's
     * own defensive `onReaped` fan-out (the SECOND, redundant `sealAndKill`/`disposeSession` call —
     * its FIRST, on-time seal via `sealSession`/`sealBeforeTerminal` already ran synchronously
     * during `spawnAndWait` above) is held back with `deferOnReapedFor` and released only AFTER a
     * resume (run-2) has already attached its host view and registered its own live bash manager
     * AND keepalive dispose callback for the SAME sessionId — exactly the ordering that corrupted
     * a live run-2 before the fix.
     */
    it("(b) a stale, late onReaped fan-out from the OLD run must not affect the resumed run's bash admission or keepalive dispose", async () => {
      const cwd = scratchDir("pi-toolkit-resume-b-");
      const label = `rb-${randomUUID().slice(0, 8)}`;
      const deferred = new Set<string>();
      const { service, releaseDeferred } = buildRealStack(cwd, deferred);

      const spawned1 = await service.spawn({ type: "worker", prompt: "first", label, cwd });
      if ("error" in spawned1) throw new Error(spawned1.error.message);
      const run1Id = spawned1.runId;
      deferred.add(run1Id); // hold back run-1's onReaped fan-out until we manually release it below
      const { settled: settled1 } = await service.waitAll({ runIds: [run1Id], waitMs: 5_000 });
      const run1 = settled1[0]!;
      expect(run1.status).toBe("completed");
      const realSessionId = await resolveRealSessionId(run1);
      // Run-1's own ON-TIME seal (sealSession, synchronous inside runner.run()'s finally) already
      // ran as part of settling above — only the redundant onReaped fan-out is held back.
      expect(getChildBashRegistry().isSealed(realSessionId)).toBe(true);

      const spawned2 = await service.spawn({ type: "worker", prompt: "continue", resumeFrom: label, cwd });
      if ("error" in spawned2) throw new Error(spawned2.error.message);
      const run2Id = spawned2.runId;
      await waitUntil(() => getChildBashRegistry().hostView(realSessionId)?.runId === run2Id);
      // register()'s own stale-seal clearing (the ORIGINAL todo #30 fix) already unsealed it.
      expect(getChildBashRegistry().isSealed(realSessionId)).toBe(false);

      // run-2's own live bash manager, registered while run-2 is live (mid-flight, same technique
      // as test (a)).
      const { pi, tools } = fakePi();
      wireChildBashJobs(pi, { settings: settingsWith(cwd) });
      const bash = tools.get("bash")!;
      const before = await execBashResilient(
        bash,
        "call-1",
        "echo before-late-onReaped",
        fakeChildCtx(realSessionId, cwd),
      );
      expect(before.isError).not.toBe(true);

      // run-2's own keepalive dispose callback, registered the same way src/cache-ttl/child.ts's
      // `ensureService()` does (real registry, minimal fake dispose — the CacheKeepaliveService
      // plumbing itself is orthogonal to this bug).
      const run2Dispose = vi.fn();
      getChildKeepaliveDisposeRegistry().register(realSessionId, run2Dispose, run2Id);

      // LATE: run-1's own defensive onReaped fan-out (a second, redundant sealAndKill/disposeSession
      // call for the ALREADY-sealed-and-killed run-1) finally fires — must be a complete no-op now
      // that run-2 owns the sessionId.
      releaseDeferred(run1Id);

      expect(getChildBashRegistry().isSealed(realSessionId)).toBe(false); // run-2 still live, not resealed
      expect(run2Dispose).not.toHaveBeenCalled(); // run-2's keepalive service untouched

      // run-2's manager must still be admitting jobs — proof its entry (onSealed()/killAll()) was
      // never touched by the stale call.
      const after = await execBashResilient(
        bash,
        "call-2",
        "echo after-late-onReaped",
        fakeChildCtx(realSessionId, cwd),
      );
      expect(after.isError).not.toBe(true);
      expect(JSON.stringify(after)).not.toContain("run is ending");

      // Let run-2 finish normally; its OWN on-time seal now legitimately seals everything.
      const { settled: settled2 } = await service.waitAll({ runIds: [run2Id], waitMs: 5_000 });
      expect(settled2[0]?.status).toBe("completed");
      // Direct proof the stale call did not rip run-2's own entry out of the registry: `isSealed()`
      // self-heals a stale SEAL FLAG on every read (the ORIGINAL todo #30 fix, unrelated to this
      // review's fix), which would otherwise mask the entry itself having been deleted — a future
      // legitimate admit() check can still pass by coincidence even after `entries.delete()` ran,
      // since `wireChildBashJobs` caches its manager and never re-registers. What CANNOT be masked:
      // run-2's own on-time seal (just above) only produces an `exit_facts` session_event — folded
      // into `diag.exitFacts` — when `sealAndKill` still finds a registered entry for the sessionId
      // at that moment (`sealAndKill` returns `undefined`, and `sealBeforeTerminal` dispatches
      // nothing, when there is none). A present `exitFacts` is therefore hard proof run-2's entry
      // was still exactly where it belonged when run-2 legitimately ended.
      expect(settled2[0]?.diag.exitFacts).toBeDefined();
      releaseDeferred(run2Id); // run-2's own defensive fan-out, idempotent no-op — tidy up
    });
  },
);

/** `RunOutcome.diag` does not carry pi's own sessionId directly (only `sessionFile`) — the real
 * sessionId is embedded in the session file's own header, exactly like `SessionManager.open()`
 * reads it. Re-derive it the same way for the test's own bash-admission check. */
async function resolveRealSessionId(outcome: { diag: { sessionFile?: string } }): Promise<string> {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const file = outcome.diag.sessionFile;
  if (!file) throw new Error("no sessionFile on outcome");
  return SessionManager.open(file).getSessionId();
}

/** Poll every 10ms until `predicate()` is true or `timeoutMs` elapses (throws on timeout, never hangs). */
async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitUntil: predicate never became true");
}

/**
 * Defensive belt: this run's own natural settle (see `prompt`'s 1.5s delay above, sized with
 * comfortable headroom over a trivial `echo`) is what actually makes the "mid-flight" bash call
 * below safe from racing the run's OWN on-time seal killing it mid-flight (a real, CORRECT
 * consequence of the run ending while a job is still running — not the bug under test). This
 * retry is only a second line of defense against ordinary sandbox CPU-scheduling noise on the
 * real subprocess spawn itself; it can never mask the actual bug: a permanently-sealed registry
 * throws "run is ending" deterministically on every attempt, so that case is never retried past.
 */
async function execBashResilient(
  bash: { execute: (...args: never[]) => unknown },
  toolCallId: string,
  command: string,
  ctx: unknown,
): Promise<{ isError?: boolean }> {
  let lastResult: { isError?: boolean; content?: unknown } | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    lastError = undefined;
    try {
      lastResult = (await (bash.execute as (...args: unknown[]) => Promise<{ isError?: boolean; content?: unknown }>)(
        toolCallId,
        { command },
        undefined,
        undefined,
        ctx,
      )) as { isError?: boolean; content?: unknown };
    } catch (e) {
      lastError = e;
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes("run is ending")) throw e; // the real bug — never retry past it
      if (!message.includes("exit code")) throw e; // a different, real failure — surface it
      await new Promise((resolve) => setTimeout(resolve, 25));
      continue;
    }
    if (!lastResult.isError) return lastResult;
    if (JSON.stringify(lastResult).includes("run is ending")) return lastResult; // the real bug — never retry past it
    if (!JSON.stringify(lastResult).includes("exit code")) return lastResult; // a different, real failure
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (lastError !== undefined) throw lastError;
  return lastResult!;
}
