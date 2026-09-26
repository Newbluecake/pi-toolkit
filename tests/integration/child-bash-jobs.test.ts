import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, type AgentSettings } from "../../src/config/settings.js";
import { bashJobsEnabled, checkBashToolReturnLag, scheduleBashJobRecovery } from "../../src/stack.js";
import { wireChildBashJobs } from "../../src/bash/child.js";
import { getChildBashRegistry, type HostRunView } from "../../src/bash/child-registry.js";

/**
 * bash-timeout-grace plan §3.4-3.7 (P5): the child (subagent) session half of
 * the feature. T19/T20/T22-T24 and the §3.3/T31 dual-timer orderings.
 *
 * Every test uses a fresh `randomUUID()` sessionId against the real,
 * process-wide `ChildBashRegistry` singleton (same convention as
 * tests/bash/child-registry.test.ts — no reset hook, sessionIds never
 * collide). Real short-lived processes are used to create actual jobs
 * (mirrors tests/integration/bash-auto-background.test.ts); nothing here
 * touches the developer's real `~/.pi/agent/bash-jobs`.
 */
const posix = process.platform !== "win32";

function fakePi() {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const tools = new Map<string, { name: string; execute: (...args: never[]) => unknown }>();
  const sent: { message: Record<string, unknown>; options?: { triggerTurn?: boolean } }[] = [];
  const pi = {
    registerTool: (tool: { name: string; execute: (...args: never[]) => unknown }) => tools.set(tool.name, tool),
    registerCommand: () => undefined,
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage: (message: Record<string, unknown>, options?: { triggerTurn?: boolean }) => {
      sent.push({ message, ...(options ? { options } : {}) });
    },
    appendEntry: () => undefined,
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
  };
  const emit = async (event: string, payload: unknown, ctx: unknown): Promise<unknown[]> => {
    const results: unknown[] = [];
    for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
    return results;
  };
  return { pi: pi as unknown as ExtensionAPI, tools, sent, emit, handlers };
}

function fakeCtx(sessionId: string, cwd: string): ExtensionContext {
  return {
    cwd,
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined },
    model: { provider: "test", id: "test-model" },
  } as unknown as ExtensionContext;
}

function settingsWith(overrides: Partial<AgentSettings["bashJobs"]> = {}, dir: string): AgentSettings {
  return {
    ...DEFAULT_SETTINGS,
    bashJobs: { ...DEFAULT_SETTINGS.bashJobs, dir, ...overrides },
  };
}

/** Poll every 15ms until `predicate()` is true or `timeoutMs` elapses (never throws). */
async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

const dirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-toolkit-child-bash-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function attachHost(sessionId: string, view: Partial<HostRunView> = {}): void {
  getChildBashRegistry().attachHost(sessionId, {
    runId: `run-${sessionId}`,
    watchdogDueAt: () => undefined,
    hardDeadlineAt: () => undefined,
    maxExtensions: () => 3,
    stopping: () => false,
    noteToolReturn: () => undefined,
    ...view,
  });
}

describe("wireChildBashJobs registration (§3.4, T19)", () => {
  it("always registers bash + bash_job when called — the childSessions/bashJobsEnabled gate lives at the call site (index.ts)", () => {
    const { pi, tools } = fakePi();
    wireChildBashJobs(pi, { settings: settingsWith({}, tmpDir()) });
    expect(tools.has("bash")).toBe(true);
    expect(tools.has("bash_job")).toBe(true);
  });

  it("the index.ts call-site gate matches the plan's condition table (§5.1)", () => {
    const on = { ...DEFAULT_SETTINGS, bashJobs: { ...DEFAULT_SETTINGS.bashJobs, childSessions: true } };
    const off = { ...DEFAULT_SETTINGS, bashJobs: { ...DEFAULT_SETTINGS.bashJobs, childSessions: false } };
    const win32Like = { ...DEFAULT_SETTINGS, bashJobs: { ...DEFAULT_SETTINGS.bashJobs, autoBackgroundMs: 0 } };
    expect(bashJobsEnabled(on) && on.bashJobs.childSessions).toBe(true);
    expect(bashJobsEnabled(off) && off.bashJobs.childSessions).toBe(false);
    expect(bashJobsEnabled(win32Like) && win32Like.bashJobs.childSessions).toBe(false);
  });

  it("a manager is never built (no registry entry) until the first real bash/bash_job call", async () => {
    const { pi, tools } = fakePi();
    const sessionId = randomUUID();
    wireChildBashJobs(pi, { settings: settingsWith({}, tmpDir()) });
    expect(getChildBashRegistry().isSealed(sessionId)).toBe(false);
    // No job/entry exists yet — sealAndKill on an unused session is a documented no-op.
    const result = getChildBashRegistry().sealAndKill(sessionId, 100);
    expect(result).toBeUndefined();
  });
});

describe.skipIf(!posix)("wireChildBashJobs lazy manager + notification routing (§3.6/§3.7, T24)", () => {
  it("lazily builds the manager and registers it on the first bash call, and never triggerTurn:true for a grace notice", async () => {
    const { pi, tools, sent } = fakePi();
    const sessionId = randomUUID();
    const dir = tmpDir();
    wireChildBashJobs(pi, {
      settings: settingsWith({ timeoutGraceMs: 300, maxExtensions: 3, maxTimeoutFactor: 5 }, dir),
    });
    const bash = tools.get("bash")!;
    const ctx = fakeCtx(sessionId, dir);
    // A 0.1s job with a 0.1s "timeout" (§2.1: seconds) enters grace ~0.1s later.
    await bash.execute(
      "call-1",
      { command: "sleep 1", timeout: 0.1, run_in_background: true },
      undefined,
      undefined,
      ctx,
    );
    await waitUntil(() => sent.some((s) => s.message.customType === "bash-job:grace"), 3_000);
    const grace = sent.find((s) => s.message.customType === "bash-job:grace");
    expect(grace).toBeDefined();
    expect(grace!.options?.triggerTurn).toBe(false);
  }, 10_000);

  it("never sends a completion notice (§3.7 — completion is read via bash_job status/wait, not pushed)", async () => {
    const { pi, tools, sent } = fakePi();
    const sessionId = randomUUID();
    const dir = tmpDir();
    wireChildBashJobs(pi, { settings: settingsWith({}, dir) });
    const bash = tools.get("bash")!;
    const ctx = fakeCtx(sessionId, dir);
    const result = (await bash.execute(
      "call-1",
      { command: "sleep 0.1 && true", run_in_background: true },
      undefined,
      undefined,
      ctx,
    )) as { details?: { jobId?: string } };
    const jobId = result.details?.jobId;
    expect(jobId).toBeTruthy();
    const bashJob = tools.get("bash_job")!;
    await waitUntil(async () => {
      const status = (await bashJob.execute(
        "call-2",
        { action: "status", job_id: jobId },
        undefined,
        undefined,
        ctx,
      )) as { details?: { terminal?: boolean } };
      return status.details?.terminal === true;
    }, 3_000);
    expect(sent.some((s) => s.message.customType === "bash-job:notification")).toBe(false);
  }, 10_000);
});

describe.skipIf(!posix)("agent_before_settle placement checks (§3.5, T20)", () => {
  async function makeChild(overrides: Partial<AgentSettings["bashJobs"]> = {}) {
    const { pi, tools, emit } = fakePi();
    const sessionId = randomUUID();
    const dir = tmpDir();
    wireChildBashJobs(pi, { settings: settingsWith(overrides, dir) });
    const ctx = fakeCtx(sessionId, dir);
    return { pi, tools, emit, sessionId, ctx, dir };
  }
  function settleEvent(overrides: { outcome?: string; canContinue?: boolean; entries?: unknown[] } = {}) {
    return {
      outcome: overrides.outcome ?? "completed",
      context: { canContinue: overrides.canContinue ?? true },
      entries: overrides.entries ?? [],
    };
  }

  it("放行: outcome !== completed", async () => {
    const { emit, ctx } = await makeChild();
    const [result] = await emit("agent_before_settle", settleEvent({ outcome: "aborted" }), ctx);
    expect(result).toBeUndefined();
  });

  it("放行: canContinue === false", async () => {
    const { emit, ctx } = await makeChild();
    const [result] = await emit("agent_before_settle", settleEvent({ canContinue: false }), ctx);
    expect(result).toBeUndefined();
  });

  it("放行: no manager ever built (no bash call this run)", async () => {
    const { emit, ctx } = await makeChild();
    const [result] = await emit("agent_before_settle", settleEvent(), ctx);
    expect(result).toBeUndefined();
  });

  it("放行: sealed", async () => {
    const { pi, tools, emit, sessionId, ctx } = await makeChild();
    const bash = tools.get("bash")!;
    await bash.execute("call-1", { command: "sleep 5", run_in_background: true }, undefined, undefined, ctx);
    getChildBashRegistry().sealAndKill(sessionId, 100);
    const [result] = await emit("agent_before_settle", settleEvent(), ctx);
    expect(result).toBeUndefined();
    void pi;
  });

  it("放行: no host view attached yet", async () => {
    const { tools, emit, ctx } = await makeChild();
    const bash = tools.get("bash")!;
    await bash.execute("call-1", { command: "sleep 5", run_in_background: true }, undefined, undefined, ctx);
    const [result] = await emit("agent_before_settle", settleEvent(), ctx);
    expect(result).toBeUndefined();
  });

  it("放行: host.stopping()", async () => {
    const { tools, emit, sessionId, ctx } = await makeChild();
    const bash = tools.get("bash")!;
    await bash.execute("call-1", { command: "sleep 5", run_in_background: true }, undefined, undefined, ctx);
    attachHost(sessionId, { stopping: () => true });
    const [result] = await emit("agent_before_settle", settleEvent(), ctx);
    expect(result).toBeUndefined();
  });

  it("放行: no non-terminal jobs", async () => {
    const { tools, emit, sessionId, ctx } = await makeChild();
    const bash = tools.get("bash")!;
    const result0 = (await bash.execute(
      "call-1",
      { command: "true", run_in_background: true },
      undefined,
      undefined,
      ctx,
    )) as { details?: { jobId?: string } };
    const jobId = result0.details?.jobId;
    attachHost(sessionId, { watchdogDueAt: () => Date.now() + 60_000 });
    if (jobId) {
      const bashJob = tools.get("bash_job")!;
      await waitUntil(async () => {
        const status = (await bashJob.execute(
          "call-2",
          { action: "status", job_id: jobId },
          undefined,
          undefined,
          ctx,
        )) as { details?: { terminal?: boolean } };
        return status.details?.terminal === true;
      });
    }
    const [result] = await emit("agent_before_settle", settleEvent(), ctx);
    expect(result).toBeUndefined();
  }, 10_000);

  it("保持: watchdog 即将到期 (hold < HOLD_MIN) 放行", async () => {
    const { tools, emit, sessionId, ctx } = await makeChild();
    const bash = tools.get("bash")!;
    await bash.execute("call-1", { command: "sleep 5", run_in_background: true }, undefined, undefined, ctx);
    // watchdogDueAt only 1s away ⇒ hold = min(120s, 1000 - 15000) < 0 < HOLD_MIN.
    attachHost(sessionId, { watchdogDueAt: () => Date.now() + 1_000 });
    const [result] = await emit("agent_before_settle", settleEvent(), ctx);
    expect(result).toBeUndefined();
  }, 10_000);

  it("保持: 全部结束 ⇒ continue:true + 完成摘要", async () => {
    const { tools, emit, sessionId, ctx } = await makeChild();
    const bash = tools.get("bash")!;
    await bash.execute("call-1", { command: "sleep 0.1 && true", run_in_background: true }, undefined, undefined, ctx);
    attachHost(sessionId, { watchdogDueAt: () => Date.now() + 60_000 });
    const [result] = (await emit("agent_before_settle", settleEvent(), ctx)) as [
      { entries: { content?: string }[]; continue: boolean } | undefined,
    ];
    expect(result?.continue).toBe(true);
    const text = result?.entries.at(-1)?.content ?? "";
    expect(text).toMatch(/finished/i);
  }, 10_000);
});

describe.skipIf(!posix)("agent_before_settle wake reasons (§3.5, T22/T23)", () => {
  async function makeChild(overrides: Partial<AgentSettings["bashJobs"]> = {}) {
    const { pi, tools, emit } = fakePi();
    const sessionId = randomUUID();
    const dir = tmpDir();
    wireChildBashJobs(pi, { settings: settingsWith(overrides, dir) });
    const ctx = fakeCtx(sessionId, dir);
    return { pi, tools, emit, sessionId, ctx, dir };
  }
  function settleEvent() {
    return { outcome: "completed", context: { canContinue: true }, entries: [] };
  }

  it("T22: a job entering its grace window wakes the hold early with a grace reminder", async () => {
    const { tools, emit, sessionId, ctx } = await makeChild({
      timeoutGraceMs: 60_000,
      maxExtensions: 3,
      maxTimeoutFactor: 5,
    });
    const bash = tools.get("bash")!;
    // 0.1s timeout, 60s grace ⇒ enters grace ~0.1s in and stays there.
    await bash.execute(
      "call-1",
      { command: "sleep 5", timeout: 0.1, run_in_background: true },
      undefined,
      undefined,
      ctx,
    );
    // Long watchdog headroom ⇒ hold would otherwise be 120s; the grace episode must wake it early.
    attachHost(sessionId, { watchdogDueAt: () => Date.now() + 600_000 });
    const started = Date.now();
    const [result] = (await emit("agent_before_settle", settleEvent(), ctx)) as [
      { entries: { content?: string }[]; continue: boolean } | undefined,
    ];
    expect(Date.now() - started).toBeLessThan(5_000); // woke on the grace event, not the 120s hold sleep
    expect(result?.continue).toBe(true);
    const text = result?.entries.at(-1)?.content ?? "";
    expect(text).toMatch(/grace/i);
  }, 15_000);

  it("T23: sealing the session wakes an in-progress hold immediately and releases", async () => {
    const { tools, emit, sessionId, ctx } = await makeChild();
    const bash = tools.get("bash")!;
    await bash.execute("call-1", { command: "sleep 30", run_in_background: true }, undefined, undefined, ctx);
    attachHost(sessionId, { watchdogDueAt: () => Date.now() + 600_000 });
    const settlePromise = emit("agent_before_settle", settleEvent(), ctx);
    // Seal shortly after the hold starts sleeping (well before the 30s job or the 120s hold window).
    await new Promise((resolve) => setTimeout(resolve, 100));
    getChildBashRegistry().sealAndKill(sessionId, 500);
    const started = Date.now();
    const [result] = (await settlePromise) as [unknown];
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result).toBeUndefined(); // sealed ⇒ release, no reminder appended
  }, 15_000);
});

describe("§3.5 round-budget cap (Q1, representative T21 case)", () => {
  it("stops issuing settle-hold reminders once childSettleHoldMaxRounds is reached", async () => {
    const { pi, tools, emit, handlers } = fakePi();
    void handlers;
    const sessionId = randomUUID();
    const dir = tmpDir();
    wireChildBashJobs(pi, { settings: settingsWith({ childSettleHoldMaxRounds: 2 }, dir) });
    const ctx = fakeCtx(sessionId, dir);
    const bash = tools.get("bash")!;
    // A long-running job the "被动模型" never touches — every hold round will
    // see it still non-terminal, exercising the cap rather than the
    // all-done wake path.
    await bash.execute("call-1", { command: "sleep 30", run_in_background: true }, undefined, undefined, ctx);
    // Small watchdog headroom → `hold = min(120s, headroom-15s)`; must stay
    // ≥ HOLD_MIN (5s) or the settle-hold releases immediately (check 8).
    attachHost(sessionId, { watchdogDueAt: () => Date.now() + 20_000 });
    const settleEvent = () => ({ outcome: "completed", context: { canContinue: true }, entries: [] });

    const [r1] = (await emit("agent_before_settle", settleEvent(), ctx)) as [{ continue: boolean } | undefined];
    expect(r1?.continue).toBe(true);
    const [r2] = (await emit("agent_before_settle", settleEvent(), ctx)) as [{ continue: boolean } | undefined];
    expect(r2?.continue).toBe(true);
    // cap = 2 reached ⇒ the 3rd call releases the run instead of holding again.
    const [r3] = (await emit("agent_before_settle", settleEvent(), ctx)) as [undefined];
    expect(r3).toBeUndefined();

    // Cleanup: kill the still-running long job so the test process exits cleanly.
    await getChildBashRegistry().sealAndKill(sessionId, 200).done;
  }, 20_000);
});

describe("checkBashToolReturnLag (§3.6 boundary telemetry, T32)", () => {
  it("warns once when a tool's return lags its recorded noteToolReturn instant past the threshold", () => {
    const pending = new Map<string, number>([["call-1", 1_000]]);
    const warned = new Set<string>();
    const warnings: string[] = [];
    checkBashToolReturnLag(pending, warned, [{ toolCallId: "call-1", endedAt: 3_600 }], (m) => warnings.push(m));
    expect(pending.has("call-1")).toBe(false); // matched once, removed
    expect(warned.has("call-1")).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/return lag/);
  });

  it("does not warn (and removes the pending entry) when the lag is within the boundary", () => {
    const pending = new Map<string, number>([["call-1", 1_000]]);
    const warned = new Set<string>();
    const warnings: string[] = [];
    checkBashToolReturnLag(pending, warned, [{ toolCallId: "call-1", endedAt: 1_400 }], (m) => warnings.push(m));
    expect(pending.has("call-1")).toBe(false);
    expect(warnings).toHaveLength(0);
  });

  it("never warns twice for the same toolCallId even if checked again", () => {
    const pending = new Map<string, number>();
    const warned = new Set<string>(["call-1"]);
    const warnings: string[] = [];
    pending.set("call-1", 1_000);
    checkBashToolReturnLag(pending, warned, [{ toolCallId: "call-1", endedAt: 3_600 }], (m) => warnings.push(m));
    expect(warnings).toHaveLength(0);
  });

  it("ignores unmatched or not-yet-ended tool calls", () => {
    const pending = new Map<string, number>([["call-1", 1_000]]);
    const warned = new Set<string>();
    const warnings: string[] = [];
    checkBashToolReturnLag(pending, warned, [{ toolCallId: "call-2", endedAt: 5_000 }], (m) => warnings.push(m));
    expect(pending.has("call-1")).toBe(true); // untouched — no match
    checkBashToolReturnLag(pending, warned, [{ toolCallId: "call-1", endedAt: undefined }], (m) => warnings.push(m));
    expect(pending.has("call-1")).toBe(true); // still pending — not ended yet
    expect(warnings).toHaveLength(0);
  });
});

describe("scheduleBashJobRecovery dual-timer orderings (§2.5 step 4/6, T31 P5 scope)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("(a) recovery settles before its deadline ⇒ cleanup is armed and runs its own bounded phase", async () => {
    vi.useFakeTimers();
    const warnings: string[] = [];
    let cleanupSignalSeen: AbortSignal | undefined;
    const handle = scheduleBashJobRecovery({
      runRecovery: async () => undefined,
      runCleanup: async (signal) => {
        cleanupSignalSeen = signal;
      },
      warn: (m) => warnings.push(m),
    });
    await vi.waitFor(() => expect(cleanupSignalSeen).toBeDefined());
    expect(cleanupSignalSeen?.aborted).toBe(false);
    expect(warnings).toHaveLength(0);
    handle.dispose();
  });

  it("(b) recovery's own timer fires first ⇒ cleanup is never armed, runCleanup is never called, one warn", async () => {
    vi.useFakeTimers();
    const warnings: string[] = [];
    let runCleanupCalls = 0;
    let releaseRecovery: () => void = () => {};
    const handle = scheduleBashJobRecovery({
      runRecovery: () =>
        new Promise<void>((resolve) => {
          releaseRecovery = resolve;
        }),
      runCleanup: async () => {
        runCleanupCalls++;
      },
      recoveryDeadlineMs: 10_000,
      reconcileDeadlineMs: 30_000,
      warn: (m) => warnings.push(m),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    releaseRecovery();
    await vi.waitFor(() => expect(warnings.some((w) => w.includes("cancelled"))).toBe(true));
    await vi.waitFor(() => expect(runCleanupCalls).toBe(0));
    // Give the recovery promise's `.finally()` a tick to run (it already
    // fired above) and confirm cleanup truly never gets armed afterwards.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runCleanupCalls).toBe(0);
    handle.dispose();
  });

  it("(c) dispose() during recovery ⇒ both signals end up aborted, cleanup is never armed", async () => {
    vi.useFakeTimers();
    const warnings: string[] = [];
    let recoverySignalSeen: AbortSignal | undefined;
    let runCleanupCalls = 0;
    let releaseRecovery: () => void = () => {};
    const handle = scheduleBashJobRecovery({
      runRecovery: (signal) => {
        recoverySignalSeen = signal;
        return new Promise<void>((resolve) => {
          releaseRecovery = resolve;
        });
      },
      runCleanup: async () => {
        runCleanupCalls++;
      },
      warn: (m) => warnings.push(m),
    });
    await vi.waitFor(() => expect(recoverySignalSeen).toBeDefined());
    handle.dispose();
    expect(recoverySignalSeen?.aborted).toBe(true);
    releaseRecovery();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runCleanupCalls).toBe(0);
  });

  it("(d) dispose() during cleanup ⇒ only the cleanup signal is aborted, its in-flight call sees it", async () => {
    vi.useFakeTimers();
    let cleanupSignalSeen: AbortSignal | undefined;
    const handle = scheduleBashJobRecovery({
      runRecovery: async () => undefined,
      runCleanup: (signal) =>
        new Promise<void>((resolve) => {
          cleanupSignalSeen = signal;
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    });
    await vi.waitFor(() => expect(cleanupSignalSeen).toBeDefined());
    expect(cleanupSignalSeen?.aborted).toBe(false);
    handle.dispose();
    expect(cleanupSignalSeen?.aborted).toBe(true);
  });

  it("dispose() is idempotent and safe after both phases already settled", async () => {
    vi.useFakeTimers();
    const handle = scheduleBashJobRecovery({
      runRecovery: async () => undefined,
      runCleanup: async () => undefined,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    handle.dispose();
    handle.dispose();
  });
});
