/**
 * child-context-switch plan.md §7 P3 — T-F1/T-F2/T-F3 (§6): pi's OWN automatic compaction
 * failing, driven end-to-end through the REAL production stack (a real `AgentSession` with a
 * scripted faux `modelRuntime`, wrapped by the REAL `PiSessionDriver.bind()` event mapping and
 * the REAL `createRuntimeRunnerAdapter` runner — not a hand-rolled stub), so the assertions land
 * on the actual `RunOutcome` / `diag.compactionFailures` / result text a calling session would
 * see, matching the plan's §2.3.1 failure-mode table.
 *
 * `PiSessionDriver.create()` normally resolves `spec.model` against a live model registry (not
 * available in a unit test), so — same idea as `child-switch-runner.test.ts` and
 * `tests/conformance/pi-boundary.test.ts` — we build the `AgentSession` ourselves (fake
 * `modelRuntime`, real `SessionManager`/`SettingsManager`), wrap it in the REAL, exported
 * `PiSessionHandle`, and hand the runner a driver whose `create()` just returns that pre-built
 * handle while `bind()` delegates to a real `PiSessionDriver` instance (so the actual
 * `compaction_end{errorMessage}` → `compaction_failed` mapping in `src/runtime/session-driver.ts`
 * is exercised, not re-implemented).
 *
 * Getting pi's REAL compaction machinery to actually fire (rather than silently no-op with
 * "nothing to compact") took empirical probing of the real dist code (`prepareCompaction`,
 * `_checkCompaction`, `_compactBeforeNextAssistantResponse` in `agent-session.js` /
 * `compaction.js`) — the exact settings below (`compaction.keepRecentTokens` /
 * `compaction.reserveTokens`, applied via `SettingsManager.applyOverrides` AFTER `loader.reload()`
 * — reload() resets settings from disk, silently discarding an override applied before it) and
 * scripted-turn shapes were chosen because they are the smallest ones observed to reliably
 * reproduce each row of the plan's failure-mode table against the REAL pi runtime — not
 * theoretical values. Any pi upgrade that changes this machinery should first be caught by
 * `npm run test:conformance` (plan §3.1); if these tests start failing without a conformance
 * regression, the compaction internals changed shape and the constants here need re-probing.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig, RunOutcome } from "../../src/core/types.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import { PiSessionDriver, PiSessionHandle } from "../../src/runtime/session-driver.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";
import type { RunnerSpec } from "../../src/service/ports.js";
import { formatCompactionFailureNote, formatContextSwitches } from "../../src/tools/result-text.js";

function fakeModel(overrides: Partial<{ contextWindow: number }> = {}) {
  return {
    id: "fake-model",
    name: "Fake Model",
    api: "anthropic-messages",
    provider: "fake-provider",
    baseUrl: "http://localhost",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0 },
    contextWindow: overrides.contextWindow ?? 200_000,
    maxTokens: 4096,
  };
}

interface ScriptedTurn {
  build: (model: ReturnType<typeof fakeModel>) => {
    stopReason: "stop" | "toolUse" | "error";
    message: Record<string, unknown>;
  };
}

function fakeModelRuntime(model: ReturnType<typeof fakeModel>, scripted: ScriptedTurn[], clock?: FakeClock) {
  let call = 0;
  const requestMessages: unknown[][] = [];
  return {
    streamSimple: (_m: unknown, context: { messages?: unknown[] }) => {
      requestMessages.push(context.messages ?? []);
      const turn = scripted[call] ?? scripted[scripted.length - 1]!;
      call += 1;
      // Each provider round-trip advances the clock by a small, distinct amount — mirrors real
      // wall-clock elapsed time between calls (matters for runner.ts's `compactionFailureAnnotation`
      // staleness check, which compares timestamps: without this every event in a synthetic,
      // all-microtask test run lands on the exact same `clock.now()` instant, and a genuinely LIVE
      // compaction failure gets misjudged as "superseded by an earlier successful compaction").
      clock?.advance(1);
      const stream = createAssistantMessageEventStream();
      const { stopReason, message } = turn.build(model);
      if (stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
      else stream.push({ type: "done", reason: stopReason, message });
      return stream;
    },
    getAuth: async () => undefined,
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ ok: true }),
    isUsingOAuth: () => false,
    getAvailableSnapshot: () => [model],
    getModel: () => model,
    callCount: () => call,
    requestMessages,
  };
}

function assistantTextMsg(model: ReturnType<typeof fakeModel>, text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}
function assistantToolCallMsg(model: ReturnType<typeof fakeModel>, toolCallId: string, name: string, args: unknown) {
  return {
    role: "assistant" as const,
    content: [{ type: "toolCall" as const, id: toolCallId, name, arguments: args }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    stopReason: "toolUse" as const,
    timestamp: Date.now(),
  };
}
function assistantErrorMsg(model: ReturnType<typeof fakeModel>, errorMessage: string) {
  return {
    role: "assistant" as const,
    content: [] as unknown[],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1 },
    stopReason: "error" as const,
    errorMessage,
    timestamp: Date.now(),
  };
}

// A pattern from pi's own OVERFLOW_PATTERNS list (agent-session.js `isContextOverflow`) — real pi
// classifies an assistant message with this exact errorMessage shape as a context-overflow error,
// independent of actual token counts, routing it into `_checkCompaction`'s overflow-recovery
// branch. It does not match `RETRYABLE_PROVIDER_ERROR_PATTERN`, so pi's own wire-level auto-retry
// never intercepts it before compaction gets a chance to run.
const OVERFLOW_ERROR_MESSAGE = "prompt too long for this model";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function withRealRunnerSession(
  opts: {
    model?: ReturnType<typeof fakeModel>;
    settingsOverrides?: Record<string, unknown>;
    warmup?: ScriptedTurn;
    scripted: ScriptedTurn[];
  },
  run: (env: { runResult: Promise<RunOutcome>; clock: FakeClock }) => Promise<void>,
) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-child-compaction-failure-"));
  dirs.push(cwd);
  const model = opts.model ?? fakeModel();
  const clock = new FakeClock();
  const modelRuntime = fakeModelRuntime(model, [...(opts.warmup ? [opts.warmup] : []), ...opts.scripted], clock);
  const settingsManager = SettingsManager.create(cwd, join(cwd, ".pi-agent"));
  const loader = new DefaultResourceLoader({ cwd, agentDir: join(cwd, ".pi-agent"), settingsManager });
  await loader.reload();
  // MUST come after reload() — reload() re-reads settings from disk and would silently discard
  // an override applied before it.
  if (opts.settingsOverrides) settingsManager.applyOverrides(opts.settingsOverrides as never);
  const sessionManager = SessionManager.create(cwd, join(cwd, "sessions"));
  const { session } = await createAgentSession({
    cwd,
    model: model as never,
    modelRuntime: modelRuntime as never,
    sessionManager,
    settingsManager,
    resourceLoader: loader,
  });

  if (opts.warmup) {
    // A separate, already-SETTLED prior turn — pi's compaction machinery only ever finds
    // something to summarize in COMPLETED turns before the current (possibly still open) one.
    await session.prompt("warm up turn");
  }

  const handle: SessionHandle = new PiSessionHandle(session);
  const realDriverForBind = new PiSessionDriver();
  const driver: SessionDriver = {
    create: () => Promise.resolve(handle),
    bind: (h, onEvent) => realDriverForBind.bind(h, onEvent),
    onLateArrival: () => undefined,
  };

  const pool = new SingleSlotPool(clock, 1);
  const store = new MemoryRunStore();
  const reaper = new EscalatingReaper(clock);
  const budget = {
    ...DEFAULT_BUDGET,
    queueWaitMs: 5_000,
    startupMs: 5_000,
    bindMs: 5_000,
    firstEventMs: 20_000,
    idleMs: 20_000,
    modelTurnMs: 20_000,
    toolMs: 20_000,
    totalMs: 30_000,
    compactionS: 20,
    abortGraceMs: 200,
    steerMs: 200,
    reapMs: 200,
  };
  const watchdog = new EventWatchdog({ clock, budget, getState: () => undefined, dispatch: () => undefined });
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
  const runner = createRuntimeRunnerAdapter({ clock, driver, pool, store, watchdog, reaper, notifier });

  const type: AgentTypeConfig = { name: "worker", description: "x", systemPrompt: "", promptMode: "append" };
  const spec: RunnerSpec = { runId: "r1", type, request: { type: "worker", prompt: "please do the task" }, budget };
  const runResult = runner.run(spec);

  try {
    await run({ runResult, clock });
  } finally {
    session.dispose();
  }
}

/** Real async work (the faux modelRuntime, pi's compaction machinery) resolves via microtasks,
 *  not the FakeClock — this just gives it turns while nudging the clock in case any
 *  runner-internal timer depends on it. */
async function drainUntilSettled(promise: Promise<RunOutcome>, clock: FakeClock, maxTicks = 2000): Promise<RunOutcome> {
  let settled: { value: RunOutcome } | undefined;
  void promise.then((value) => {
    settled = { value };
  });
  for (let i = 0; i < maxTicks && !settled; i++) {
    // A real macrotask yield (not just a microtask flush): real child-process I/O (the bash tool
    // really spawns `echo`) and any real setTimeout-based delay inside pi's own retry/backoff
    // machinery only fire once the event loop actually reaches its timers/poll phase — a tight
    // `await Promise.resolve()` loop starves both and hangs forever.
    await new Promise((resolve) => setTimeout(resolve, 0));
    clock.advance(5);
  }
  if (!settled) throw new Error("run did not settle within the tick budget");
  return settled.value;
}

describe("T-F1: real context overflow, twice in a row (compact-and-retry exhausted)", () => {
  it("run fails(model); error concatenates the provider text and pi's overflow-exhausted reason; diag.compactionFailures has exactly 1 entry; no fabricated result-text duplicate", async () => {
    await withRealRunnerSession(
      {
        // keepRecentTokens small enough that the warm-up turn is NOT retained verbatim (there is
        // something real to summarize), but not so small it forces a mid-turn split (which routes
        // through a DIFFERENT summarization call and produces a different failure/success shape
        // — see T-F2/T-F3 below, which deliberately use that).
        settingsOverrides: { compaction: { keepRecentTokens: 20 } },
        warmup: {
          build: (m) => ({
            stopReason: "stop",
            message: assistantTextMsg(
              m,
              "warm up reply with a decent amount of text to summarize later on, padding padding padding padding padding",
            ),
          }),
        },
        scripted: [
          {
            build: (m) => ({
              stopReason: "toolUse",
              message: assistantToolCallMsg(m, "tc1", "bash", { command: "echo hi" }),
            }),
          },
          { build: (m) => ({ stopReason: "error", message: assistantErrorMsg(m, OVERFLOW_ERROR_MESSAGE) }) },
          { build: (m) => ({ stopReason: "stop", message: assistantTextMsg(m, "summary of everything so far") }) },
          { build: (m) => ({ stopReason: "error", message: assistantErrorMsg(m, OVERFLOW_ERROR_MESSAGE) }) },
        ],
      },
      async ({ runResult, clock }) => {
        const outcome = await drainUntilSettled(runResult, clock);
        expect(outcome.status).toBe("failed");
        expect(outcome.error?.kind).toBe("model");
        expect(outcome.error?.message).toContain(OVERFLOW_ERROR_MESSAGE);
        expect(outcome.error?.message).toContain(
          "Context overflow recovery failed after one compact-and-retry attempt",
        );
        expect(outcome.diag.compactionFailures ?? []).toHaveLength(1);
        expect(outcome.diag.compactionFailures?.[0]?.reason).toBe("overflow");
        // The runner's OWN error-concatenation already folded the compaction failure reason into
        // error.message, so result-text's helper (used by get_subagent_result / the completion
        // notice) recognizes it as already-covered and adds nothing extra — no doubled line.
        const note = formatCompactionFailureNote(outcome.diag.compactionFailures, outcome.error?.message);
        expect(note).toBeUndefined();
      },
    );
  });
});

describe("T-F2: pi's own summarization call throws (threshold compaction)", () => {
  const smallModel = fakeModel({ contextWindow: 500 });
  const settingsOverrides = { compaction: { reserveTokens: 50, keepRecentTokens: 10 } };
  // Large enough toolResult content to push the projected context estimate above
  // `contextWindow - reserveTokens` (450 tokens ≈ 1800 chars) before pi's NEXT request.
  const padding = "x".repeat(6000);
  const SUMMARIZATION_ERROR_MESSAGE = "faux summarization backend refused the request";

  it("threshold compaction failure is recorded (diag.compactionFailures); a SUBSEQUENT successful request still completes the run, with a result-text diagnostic note", async () => {
    await withRealRunnerSession(
      {
        model: smallModel,
        settingsOverrides,
        scripted: [
          {
            build: (m) => ({
              stopReason: "toolUse",
              message: assistantToolCallMsg(m, "tc1", "bash", { command: `echo ${padding}` }),
            }),
          },
          // The compaction machinery's OWN summarization call — scripted as a hard failure.
          { build: (m) => ({ stopReason: "error", message: assistantErrorMsg(m, SUMMARIZATION_ERROR_MESSAGE) }) },
          // The ORIGINAL continuation request still goes out (uncompacted) and succeeds.
          { build: (m) => ({ stopReason: "stop", message: assistantTextMsg(m, "final ok reply") }) },
        ],
      },
      async ({ runResult, clock }) => {
        const outcome = await drainUntilSettled(runResult, clock);
        expect(outcome.status).toBe("completed");
        expect(outcome.text).toBe("final ok reply");
        expect(outcome.diag.compactionFailures ?? []).toHaveLength(1);
        expect(outcome.diag.compactionFailures?.[0]?.reason).toBe("threshold");
        expect(outcome.diag.compactionFailures?.[0]?.message).toContain(SUMMARIZATION_ERROR_MESSAGE);
        // completed runs never got a turnError, so the runner's own concatenation never fired —
        // result-text's note is how a calling session finds out compaction had trouble at all.
        const note = formatCompactionFailureNote(outcome.diag.compactionFailures, outcome.error?.message);
        expect(note).toBe(`auto-compaction failed: ${outcome.diag.compactionFailures?.[0]?.message}`);
      },
    );
  });

  it("...and when the SUBSEQUENT continuation request also fails outright (not overflow-classified — see the module doc comment for why a REAL overflow can't be used as the FINAL message here), the run fails with the LAST compaction failure reason concatenated in", async () => {
    // NOTE: deliberately NOT `OVERFLOW_ERROR_MESSAGE` for the final message. Real pi's
    // `_checkCompaction` calls `_omitRecoveryAttempt()` (splicing the message OUT of the LIVE
    // `session.messages` pi's own `getLastAssistantText()`/our `getTurnError()` scan) on the
    // FIRST-ever overflow occurrence in a run, unconditionally — regardless of whether the
    // triggered recovery compaction then succeeds or fails. An overflow that is the run's only
    // (first) occurrence and whose recovery also fails is therefore invisible to
    // `session.messages`-based turn-error detection; T-F1 above exercises the (real, working)
    // case where the FINAL message is instead the SECOND overflow occurrence in the same run
    // (`_overflowRecoveryAttempted` already true — no omission). A generic non-overflow error
    // exercises the exact same runner-side concatenation logic without hitting that omission path.
    //
    // Empirically (same discovery as T-F3 below): `_compactBeforeNextAssistantResponse` has no
    // "already attempted" flag, so while the content stays oversized it re-attempts compaction
    // before EVERY subsequent request, not just once — a second scripted error here is consumed
    // as a SECOND compaction attempt, not yet the real continuation. A third, distinct message is
    // needed for the real continuation's own failure.
    const GENERIC_ERROR_MESSAGE = "some other unrecoverable model error";
    const FINAL_ERROR_MESSAGE = "the actual continuation also failed outright";
    await withRealRunnerSession(
      {
        model: smallModel,
        settingsOverrides,
        scripted: [
          {
            build: (m) => ({
              stopReason: "toolUse",
              message: assistantToolCallMsg(m, "tc1", "bash", { command: `echo ${padding}` }),
            }),
          },
          { build: (m) => ({ stopReason: "error", message: assistantErrorMsg(m, SUMMARIZATION_ERROR_MESSAGE) }) },
          { build: (m) => ({ stopReason: "error", message: assistantErrorMsg(m, GENERIC_ERROR_MESSAGE) }) },
          { build: (m) => ({ stopReason: "error", message: assistantErrorMsg(m, FINAL_ERROR_MESSAGE) }) },
        ],
      },
      async ({ runResult, clock }) => {
        const outcome = await drainUntilSettled(runResult, clock);
        expect(outcome.status).toBe("failed");
        expect(outcome.error?.kind).toBe("model");
        expect(outcome.error?.message).toContain(FINAL_ERROR_MESSAGE);
        expect(outcome.error?.message).toContain(GENERIC_ERROR_MESSAGE);
        expect(outcome.error?.message).not.toContain(SUMMARIZATION_ERROR_MESSAGE);
        expect(outcome.diag.compactionFailures ?? []).toHaveLength(2);
        expect(outcome.diag.compactionFailures?.every((f) => f.reason === "threshold")).toBe(true);
      },
    );
  });
});

describe("T-F3: two INDEPENDENT compaction failures in the same run", () => {
  it("both are recorded (sorted by time, 2 entries); error concatenates the LAST one", async () => {
    // Same omission constraint as T-F2 above (see its comment) rules out a literal
    // "threshold-then-overflow" pair ending in a live, detectable overflow message — pi's own
    // `_omitRecoveryAttempt` would splice a first-and-only, unsuccessfully-recovered overflow out
    // of `session.messages` regardless of outcome. Two INDEPENDENT threshold failures achieve the
    // exact same acceptance-relevant shape (independent compactionFailures entries, sorted by
    // time, runner error concatenation always uses the LAST one): `_compactBeforeNextAssistantResponse`
    // has no "already attempted" flag (unlike overflow's `_overflowRecoveryAttempted`), and
    // `_checkCompaction`'s threshold Case 3 re-checks even the run's OWN final (errored) turn
    // post-hoc, so the SECOND compaction attempt can land either right before the real
    // continuation OR right after it errors — both are legitimate, independent failures. Since
    // WHICH scripted slot ends up being "the real continuation's own error" vs. "the second
    // compaction attempt" is an internal pi scheduling detail we do not pin down, slots 2 and 3
    // deliberately share the SAME text so the assertions below hold either way.
    const smallModel = fakeModel({ contextWindow: 500 });
    const padding = "x".repeat(6000);
    const SUMM_ERR_1 = "faux summarization backend refused the request (1)";
    const SUMM_ERR_2 = "faux summarization backend refused the request (2)";
    await withRealRunnerSession(
      {
        model: smallModel,
        settingsOverrides: { compaction: { reserveTokens: 50, keepRecentTokens: 10 } },
        scripted: [
          {
            build: (m) => ({
              stopReason: "toolUse",
              message: assistantToolCallMsg(m, "tc1", "bash", { command: `echo ${padding}` }),
            }),
          },
          // 1st, independent failure: the threshold compaction pi runs before the (still-pending)
          // continuation request throws.
          { build: (m) => ({ stopReason: "error", message: assistantErrorMsg(m, SUMM_ERR_1) }) },
          // Whichever of "the real continuation" / "a second, independent compaction attempt" comes
          // next, it is this exact text either way (see comment above) — and BOTH of those
          // internal shapes still error, so the run fails regardless.
          { build: (m) => ({ stopReason: "error", message: assistantErrorMsg(m, SUMM_ERR_2) }) },
          { build: (m) => ({ stopReason: "error", message: assistantErrorMsg(m, SUMM_ERR_2) }) },
        ],
      },
      async ({ runResult, clock }) => {
        const outcome = await drainUntilSettled(runResult, clock);
        expect(outcome.status).toBe("failed");
        expect(outcome.error?.kind).toBe("model");
        expect(outcome.diag.compactionFailures ?? []).toHaveLength(2);
        expect(outcome.diag.compactionFailures?.map((f) => f.reason)).toEqual(["threshold", "threshold"]);
        expect(outcome.diag.compactionFailures?.[0]?.message).toContain(SUMM_ERR_1);
        expect(outcome.diag.compactionFailures?.[1]?.message).toContain(SUMM_ERR_2);
        expect(outcome.diag.compactionFailures?.[0]?.at ?? 0).toBeLessThanOrEqual(
          outcome.diag.compactionFailures?.[1]?.at ?? 0,
        );
        // The runner's own concatenation always uses the LAST (most recent, non-stale) failure —
        // the run's own turnError is ALSO `SUMM_ERR_2` in every observed internal scheduling (the
        // "real continuation" and "second compaction attempt" share identical text by design), so
        // this assertion holds without pinning down which internal call produced which.
        expect(outcome.error?.message).toContain(SUMM_ERR_2);
        expect(outcome.error?.message).not.toContain(SUMM_ERR_1);
      },
    );
  });

  it("no-model / prepareCompaction-empty branch: a lone overflow with nothing to summarize yet ⇒ only the provider text, no fabricated compaction annotation", async () => {
    // Default settings (keepRecentTokens 20000): with no warm-up turn at all, pi's own
    // `prepareCompaction` finds literally nothing to summarize and silently returns early —
    // NO compaction_start/compaction_end ever fires, so `diag.compactionFailures` stays empty and
    // the runner must never invent a reason pi never gave.
    await withRealRunnerSession(
      {
        scripted: [{ build: (m) => ({ stopReason: "error", message: assistantErrorMsg(m, OVERFLOW_ERROR_MESSAGE) }) }],
      },
      async ({ runResult, clock }) => {
        const outcome = await drainUntilSettled(runResult, clock);
        expect(outcome.status).toBe("failed");
        expect(outcome.error?.kind).toBe("model");
        expect(outcome.error?.message).toBe(OVERFLOW_ERROR_MESSAGE);
        expect(outcome.diag.compactionFailures ?? []).toHaveLength(0);
        expect(formatCompactionFailureNote(outcome.diag.compactionFailures, outcome.error?.message)).toBeUndefined();
      },
    );
  });
});

describe("get_subagent_result / notification text surfaces the same reasons (T-F1/T-F2/T-F3, §2.3.1)", () => {
  it("formatContextSwitches stays silent (no switch happened) while formatCompactionFailureNote carries the failure for a completed-with-trouble run", async () => {
    const smallModel = fakeModel({ contextWindow: 500 });
    const padding = "x".repeat(6000);
    const SUMMARIZATION_ERROR_MESSAGE = "faux summarization backend refused the request";
    await withRealRunnerSession(
      {
        model: smallModel,
        settingsOverrides: { compaction: { reserveTokens: 50, keepRecentTokens: 10 } },
        scripted: [
          {
            build: (m) => ({
              stopReason: "toolUse",
              message: assistantToolCallMsg(m, "tc1", "bash", { command: `echo ${padding}` }),
            }),
          },
          { build: (m) => ({ stopReason: "error", message: assistantErrorMsg(m, SUMMARIZATION_ERROR_MESSAGE) }) },
          { build: (m) => ({ stopReason: "stop", message: assistantTextMsg(m, "final ok reply") }) },
        ],
      },
      async ({ runResult, clock }) => {
        const outcome = await drainUntilSettled(runResult, clock);
        expect(formatContextSwitches(outcome.diag.contextSwitches)).toBeUndefined();
        expect(formatCompactionFailureNote(outcome.diag.compactionFailures, outcome.error?.message)).toContain(
          SUMMARIZATION_ERROR_MESSAGE,
        );
      },
    );
  });
});
