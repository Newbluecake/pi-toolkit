import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig, DeliveryPayload } from "../../src/core/types.js";
import { wrapWithRunLog } from "../../src/adapters/pi-run-log.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";
import { createSpawnService } from "../../src/service/spawn-service.js";
import { MessageAgentParams } from "../../src/tools/message-agent-tool.js";

/**
 * fabric-cross-session plan v3 §3.9 / §9 S0: the wake-OFF golden. It was captured from `dev` BEFORE any S0 code
 * change and pins, byte for byte, what a run writes to the session log when `fabric.wake` is off (the only mode
 * that exists before W1): (a) a successful run's journal + terminal `subagent:run` entries and its delivery
 * payload, (b) an admission-rejected spawn (error only — no entry, no snapshot, no runner call) and (c) a
 * `startup_failed` run's entries, plus the `message_agent` tool schema.
 *
 * Never regenerate this to make a failing test pass: a diff here means a wake-off behaviour change (W1+ must keep
 * these bytes identical). The only permitted additive key is `error.reason` on an admission error (the typed
 * AdmissionReason annotation, see tests/service/admission-reason.test.ts), which is why (b) compares the
 * `{kind,message,retryable}` triple and not the whole object.
 */
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "fixtures", "fabric-wake-off-golden.json");

const type: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };

const budget = {
  ...DEFAULT_BUDGET,
  queueWaitMs: 200,
  startupMs: 200,
  bindMs: 200,
  firstEventMs: 10_000,
  idleMs: 10_000,
  toolMs: 10_000,
  totalMs: 50_000,
  abortGraceMs: 20,
  steerMs: 10,
  reapMs: 30,
};

function normalize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value).replace(/r_[0-9A-Z]{8}/g, "<runId>"));
}

async function settle(clock: FakeClock, ticks = 40) {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
    clock.advance(1);
    await Promise.resolve();
  }
}

interface Rig {
  clock: FakeClock;
  entries: { type: "custom"; customType: string; data: unknown }[];
  deliveries: DeliveryPayload[];
  runnerCalls: number;
  service: ReturnType<typeof createSpawnService>;
  finish(): void;
}

function rig(mode: "success" | "startup_failed"): Rig {
  const clock = new FakeClock(1_000_000);
  const entries: Rig["entries"] = [];
  const deliveries: DeliveryPayload[] = [];
  let finishPrompt: (() => void) | undefined;
  const pi = {
    appendEntry: (customType: string, data: unknown) =>
      entries.push({ type: "custom", customType, data: JSON.parse(JSON.stringify(data)) }),
    sessionManager: { getEntries: () => entries },
  };
  const store = wrapWithRunLog(new MemoryRunStore(), pi);
  const handle: SessionHandle = {
    sessionId: "s-golden",
    sessionFile: "/tmp/fabric-wake-off-golden.jsonl",
    prompt: () => new Promise<void>((resolve) => (finishPrompt = resolve)),
    steer: () => Promise.resolve(),
    requestAbort: () => Promise.resolve(),
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools: () => undefined,
    getActiveTools: () => [],
    getLastAssistantText: () => "done",
    getUsage: () => undefined,
  };
  const driver: SessionDriver = {
    create: async () => {
      if (mode === "startup_failed") throw new Error("boom: session start failed");
      return handle;
    },
    resume: async () => handle,
    bind: async (_h, onEvent) => {
      onEvent({ t: "turn_start" });
      onEvent({ t: "message_end", usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, costUsd: 0.01 } });
    },
    onLateArrival: () => undefined,
  };
  const notifier = {
    enqueue: (payload: DeliveryPayload) => {
      deliveries.push(JSON.parse(JSON.stringify(payload)) as DeliveryPayload);
    },
    finalize: () => "missing" as const,
    settleBatch: () => undefined,
    peek: () => undefined,
    consume: () => false,
    reconcile: () => ({ redelivered: [], suppressed: [], abandoned: [] }),
    verifyPersisted: () => ({ missing: [] }),
    stats: { staged: 0, pending: 0, batched: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
    degraded: [],
  };
  const runner = createRuntimeRunnerAdapter({
    clock,
    driver,
    pool: new SingleSlotPool(clock, 4),
    store,
    watchdog: new EventWatchdog({ clock, budget, getState: () => undefined, dispatch: () => undefined }),
    reaper: new EscalatingReaper(clock),
    notifier: notifier as never,
    journal: (snapshot) => store.journal(snapshot),
  });
  const state = { runnerCalls: 0 };
  const service = createSpawnService({
    types: { get: (name: string) => (name === "worker" ? type : undefined), list: () => [type] } as never,
    pool: new SingleSlotPool(clock, 4),
    runner: {
      ...runner,
      run: (spec, cb) => {
        state.runnerCalls++;
        return runner.run(spec, cb);
      },
    },
    now: () => clock.now(),
    budget,
  });
  return {
    clock,
    entries,
    deliveries,
    get runnerCalls() {
      return state.runnerCalls;
    },
    service,
    finish: () => finishPrompt?.(),
  } as Rig;
}

async function capture() {
  // (a) a successful run
  const a = rig("success");
  const started = await a.service.spawn({ type: "worker", prompt: "do it", label: "golden-a" });
  if ("error" in started) throw new Error(started.error.message);
  await settle(a.clock);
  a.finish();
  await settle(a.clock);
  const successful = { entries: a.entries, deliveries: a.deliveries };

  // (b) an admission-rejected spawn: error only, nothing written anywhere
  const b = rig("success");
  const rejected = await b.service.spawn({ type: "nope", prompt: "x", label: "golden-b" });
  if (!("error" in rejected)) throw new Error("expected admission rejection");
  const admissionRejected = {
    error: { kind: rejected.error.kind, message: rejected.error.message, retryable: rejected.error.retryable },
    entries: b.entries,
    deliveries: b.deliveries,
    snapshots: b.service.snapshots(),
    runnerCalls: b.runnerCalls,
  };

  // (c) a startup_failed run
  const c = rig("startup_failed");
  const failed = await c.service.spawn({ type: "worker", prompt: "do it", label: "golden-c" });
  if ("error" in failed) throw new Error(failed.error.message);
  await settle(c.clock);
  const startupFailed = { entries: c.entries, deliveries: c.deliveries };

  return normalize({
    note: "wake-off golden captured from dev before S0 (fabric-cross-session plan v3 §3.9). Never regenerate to fix a diff.",
    successful,
    admissionRejected,
    startupFailed,
    messageAgentSchema: MessageAgentParams,
  }) as Record<string, any>;
}

describe("fabric wake-off golden (plan v3 §3.9)", () => {
  it("matches the checked-in golden byte for byte", async () => {
    const actual = await capture();
    if (process.env.FABRIC_WAKE_GOLDEN_UPDATE === "1" && !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
    }
    const golden = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, any>;
    expect(actual).toEqual(golden);
  });

  it("is deterministic and structurally sane (terminal entries, no entry for a rejected spawn)", async () => {
    const first = await capture();
    const second = await capture();
    expect(second).toEqual(first);
    const terminal = (list: any[]) => list.filter((e) => e.customType === "subagent:run" && !e.data.journal);
    expect(terminal(first.successful.entries).map((e) => e.data.status)).toEqual(["completed"]);
    expect(terminal(first.startupFailed.entries).map((e) => e.data.status)).toEqual(["failed"]);
    expect(first.admissionRejected.entries).toEqual([]);
    expect(first.admissionRejected.deliveries).toEqual([]);
    expect(first.admissionRejected.snapshots).toEqual([]);
    expect(first.admissionRejected.runnerCalls).toBe(0);
    // none of the wake-era fields exist yet in the off state
    const text = JSON.stringify([first.successful, first.startupFailed]);
    for (const key of [
      "wakeOrigin",
      "wakeLevel",
      "wakeExclusion",
      "inputAcceptedAt",
      "promptOutcome",
      "trackInput",
      "quiet",
    ])
      expect(text).not.toContain(`"${key}"`);
  });
});
