/**
 * schedule macOS end-to-end (darwin plan §5.3, P4-B) — REAL `activate()` × fake pi on a REAL
 * darwin machine: the full agent-side lifecycle over the real platform backends (ps/sysctl
 * identity, snapshot path backend, perl flock locks — no seam is injected):
 *   create (cron/once/every) → list/get → run_now through BOTH executors (background + message) →
 *   the real session clock auto-claiming a due occurrence → history.
 *
 * The auto-claim segment deliberately uses REAL timers (a `once` task due ~1.2 s ahead) instead
 * of a FakeClock: `activate()` pins the production `systemClock` inside the wiring, and real
 * segmented timers + real perl lock children in the loop are the stronger E-MAC evidence.
 *
 * The hub segment (real hub child process: projection of this session's tasks, pendingReports
 * receipt cleanup, unknown-run prediction, hub zero-write snapshots) is NOT wired yet: it needs
 * the hub-side identity injection of P4-A (`service.ts` reads the platform identity), which is
 * not merged at the time this file landed. On darwin the hub's `readSelfIdentity()` yields
 * nothing, so every hub projection fail-closes — the segment would be red for the wrong reason.
 * TODO-P4A: flip `HUB_SEGMENT_READY` once P4-A lands, then port the harness of
 * tests/integration/schedule-hub.test.ts (real hub child over a Unix socket).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import activate from "../../src/index.js";
import type { RunOutcome } from "../../src/core/types.js";
import type { SpawnServiceDeps } from "../../src/service/spawn-service.js";
import { resetSecureDomainForTests } from "../../src/secure/domain.js";
import { freezeDomain, makeFakeVault } from "../secure/helpers.js";
import {
  BASELINE,
  emit,
  fakeCtx,
  fakePi,
  resetGlobals,
  sandbox,
  SID,
  systemPromptFor,
  userTrigger,
  wakeEvent,
  type FakeCtx,
  type FakePi,
} from "./helpers/schedule-activate.js";

/** TODO-P4A: set to true when the hub-side identity injection (P4-A) is merged. */
const HUB_SEGMENT_READY = false;

const harness = vi.hoisted(() => ({
  requests: [] as any[],
  outcome: undefined as undefined | ((req: any, runId: string) => RunOutcome),
  seq: 0,
  gate: undefined as undefined | Promise<void>,
  spawnDeps: undefined as SpawnServiceDeps | undefined,
}));

vi.mock("../../src/service/spawn-service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/service/spawn-service.js")>();
  return {
    ...original,
    createSpawnService: (deps: SpawnServiceDeps) => {
      harness.spawnDeps = deps;
      const runs = new Map<string, any>();
      return {
        spawn: async (req: any) => {
          harness.requests.push(req);
          const runId = `r_bg${++harness.seq}`;
          runs.set(runId, req);
          return { runId, slots: { limit: 4, inUse: 1, free: 3 } };
        },
        waitOutcome: async (runId: string) => {
          await harness.gate;
          return { kind: "settled" as const, outcome: harness.outcome!(runs.get(runId), runId) };
        },
        spawnAndWait: async () => {
          throw new Error("unused");
        },
        abort: async () => false,
        waitAll: async () => ({ settled: [], pending: [] }),
        stopChildrenOf: async () => ({ stopped: [], pending: [] }),
        resolveRun: () => ({ ok: false as const, error: "unused" }),
        resolveResume: () => ({ ok: false as const, error: "unused" }),
        snapshots: () => [],
      };
    },
  };
});

function outcomeOf(runId: string, status: RunOutcome["status"], text: string): RunOutcome {
  return {
    runId,
    status,
    text,
    turns: 1,
    durationMs: 5,
    diag: {
      createdAt: 0,
      phase: "settled",
      phaseEnteredAt: 0,
      pendingTools: 0,
      turns: 1,
      escalation: [],
      orphaned: false,
      generation: 1,
      degraded: [],
      staleInputs: 0,
      unkillable: [],
    },
  };
}

const sb = sandbox("pi-sched-darwin-e2e-");
afterAll(() => sb.cleanup());
let sessionN = 0;
let schedDir = "";

beforeEach(() => {
  resetGlobals();
  harness.requests.length = 0;
  harness.seq = 0;
  harness.gate = undefined;
  harness.outcome = (_req, runId) => outcomeOf(runId, "completed", "darwin e2e 报告正文。");
  schedDir = join(sb.home, `sched-${++sessionN}`);
  sb.writeSettings({ ...BASELINE, schedule: { enabled: true, dir: schedDir } });
});
afterEach(() => {
  resetGlobals();
  resetSecureDomainForTests();
  vi.useRealTimers();
});

interface Session {
  h: FakePi;
  c: FakeCtx;
  file: string;
  tool: (params: Record<string, unknown>) => Promise<any>;
  cmd: (args: string) => Promise<void>;
  shutdown: () => Promise<void>;
  ledger: () => any;
  stateFile: string;
}

async function openSession(opts: { sid?: string; mode?: string } = {}): Promise<Session> {
  const h = fakePi();
  activate(h.pi);
  const file = join(sb.home, `s-${++sessionN}.jsonl`);
  writeFileSync(file, '{"type":"session"}\n');
  h.sessionFile.path = file;
  const c = fakeCtx(sb.home, {
    file,
    ...(opts.sid ? { sid: opts.sid } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
  });
  await emit(h, "session_start", { type: "session_start", reason: "startup" }, c.ctx);
  const sid = opts.sid ?? SID;
  const stateFile = join(schedDir, sid, "state.json");
  return {
    h,
    c,
    file,
    stateFile,
    tool: (params) => h.tools.get("schedule")!.execute("c1", params, undefined, undefined, c.ctx),
    cmd: (args) => h.commands.get("schedule")!.handler(args, c.ctx),
    shutdown: async () => void (await emit(h, "session_shutdown", { type: "session_shutdown" }, c.ctx)),
    ledger: () => JSON.parse(readFileSync(stateFile, "utf8")),
  };
}

/** The tool result's text content (pi content blocks, not a plain string). */
function textOf(r: { content: Array<{ type: string; text?: string }> }): string {
  return r.content.map((b) => b.text ?? "").join("\n");
}

async function until(cond: () => boolean, label: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout: ${label}`);
}

/** The next UTC minute boundary as "YYYY-MM-DDTHH:mm" (a valid once `at`, cron.ts ONCE_AT_RE). */
function nextMinuteUtc(): string {
  return new Date(Math.ceil((Date.now() + 500) / 60_000) * 60_000).toISOString().slice(0, 16);
}

describe.skipIf(process.platform !== "darwin")("schedule darwin e2e — real activate, real platform backends", () => {
  it("create (cron/once/every) is active at once; list and get render the tasks; run_now (background) executes through the real executor and lands a report", async () => {
    const s = await openSession();
    // cron
    const cron = await s.tool({
      action: "create",
      name: "daily",
      cron: "0 8 * * *",
      tz: "UTC",
      prompt: "summarize commits",
    });
    expect(cron.details).toMatchObject({ ok: true });
    expect(typeof cron.details.id).toBe("string");
    // once (future, minute-granular wall time in UTC — cron.ts ONCE_AT_RE)
    const once = await s.tool({
      action: "create",
      name: "one-shot",
      at: nextMinuteUtc(),
      tz: "UTC",
      prompt: "one shot",
    });
    expect(once.details).toMatchObject({ ok: true });
    // every — local-only interval (webHub off) must be accepted at once
    const every = await s.tool({
      action: "create",
      name: "tick",
      form: "message",
      every: "20m",
      prompt: "tick",
      feishu: false,
    });
    expect(every.details).toMatchObject({ ok: true });
    const ids = [cron.details.id, once.details.id, every.details.id] as string[];

    // list carries all three; get renders one with its schedule line
    const list = await s.tool({ action: "list" });
    for (const id of ids) expect(textOf(list)).toContain(id);
    const get = await s.tool({ action: "get", id: cron.details.id });
    expect(textOf(get)).toContain("daily");
    expect(s.ledger().tasks).toHaveLength(3);
    expect(s.ledger().tasks[0]).not.toHaveProperty("approval"); // active at once, no approval step

    // run_now (background executor): claim → mocked spawn child → completed + report file
    await s.tool({ action: "run_now", id: cron.details.id });
    await until(() => s.ledger().runs.some((x: any) => x.state === "completed"), "background run completed");
    const run = s.ledger().runs.find((x: any) => x.state === "completed");
    expect(run).toMatchObject({ form: "background", kind: "manual" });
    expect(harness.requests[0]).toMatchObject({
      type: "general-purpose",
      prompt: expect.stringContaining("summarize commits"),
      suppressDelivery: true,
      callerOwned: true,
      timeoutPolicy: "fixed",
    });
    expect(existsSync(join(schedDir, SID, run.reportFile))).toBe(true);
    expect(readFileSync(join(schedDir, SID, run.reportFile), "utf8")).toContain("darwin e2e 报告正文。");
    await s.shutdown();
  });

  it("run_now (message executor): queued → wake with a token → authorized trigger → settled with a report; a forged token is aborted on sight", async () => {
    const s = await openSession();
    const r = await s.tool({
      action: "create",
      name: "msg",
      form: "message",
      cron: "0 8 * * *",
      tz: "UTC",
      prompt: "say hi",
      feishu: true,
    });
    const id = r.details.id as string;
    await emit(s.h, "before_agent_start", userTrigger(), s.c.ctx); // capability: unknown → observed
    await s.tool({ action: "run_now", id });
    await until(() => s.h.sent.some((m) => m.message.details?.kind === "message"), "message wake sent");
    const wake = s.h.sent.find((m) => m.message.details?.kind === "message")!;
    expect(wake.options).toEqual({ triggerTurn: true });

    // a forged token is an orphan: aborted on sight
    await emit(
      s.h,
      "before_agent_start",
      wakeEvent({ kind: "message", token: "forged", runKey: "x", noteId: "n" }),
      s.c.ctx,
    );
    expect(s.c.aborts.n).toBe(1);

    // the authorized trigger runs the turn and settles the run with a report
    s.c.state.idle = false;
    await emit(s.h, "before_agent_start", wakeEvent(wake.message.details), s.c.ctx);
    await emit(s.h, "agent_start", { type: "agent_start" }, s.c.ctx);
    await emit(
      s.h,
      "message_start",
      { message: { role: "custom", customType: "subagent:schedule", details: wake.message.details } },
      s.c.ctx,
    );
    await emit(s.h, "context", { messages: [] }, s.c.ctx);
    await emit(
      s.h,
      "message_end",
      { message: { role: "assistant", content: [{ type: "text", text: "hi!" }] } },
      s.c.ctx,
    );
    s.c.state.idle = true;
    await emit(s.h, "agent_settled", { aborted: false }, s.c.ctx);
    await until(() => s.ledger().runs[0].state === "settled", "message run settled");
    expect(s.ledger().runs[0].reportFile).toBeDefined();
    await s.shutdown();
  });

  it(
    "the real session clock auto-claims a due once task (real timers, real perl locks); history lists the run",
    { timeout: 120_000 },
    async () => {
      const s = await openSession();
      // A once `at` is minute-granular wall time and must satisfy T >= armedSince (the stack build),
      // so arm the NEXT UTC minute boundary and let the real segmented timer fire there — at most
      // ~61 s of wall time, the price of a real activate() pinning the production system clock.
      const r = await s.tool({
        action: "create",
        name: "auto-one",
        at: nextMinuteUtc(),
        tz: "UTC",
        prompt: "auto run",
      });
      const id = r.details.id as string;
      await until(
        () => existsSync(s.stateFile) && s.ledger().runs.some((x: any) => x.taskId === id),
        "auto run claimed",
        90_000,
      );
      await until(
        () => s.ledger().runs.some((x: any) => x.taskId === id && x.state === "completed"),
        "auto run completed",
        30_000,
      );
      const run = s.ledger().runs.find((x: any) => x.taskId === id);
      expect(run).toMatchObject({ form: "background", kind: "auto", state: "completed" });
      expect(existsSync(join(schedDir, SID, run.reportFile))).toBe(true);
      // history renders the auto run; get shows it under "recent runs"
      const history = await s.tool({ action: "history" });
      expect(textOf(history)).toContain(id);
      expect(history.details).toMatchObject({ runs: expect.any(Number) });
      const get = await s.tool({ action: "get", id });
      expect(textOf(get)).toContain("recent runs");
      await s.shutdown();
    },
  );

  it("secure/locked domains still expose no schedule surface and create nothing (D8/D11)", async () => {
    const v = makeFakeVault();
    try {
      const verdict = freezeDomain(v, { mountinfo: v.unmounted });
      expect(verdict.domain.kind).toBe("locked");
      const sb2 = sandbox("pi-sched-darwin-e2e-sec-");
      try {
        sb2.writeSettings({ ...BASELINE, schedule: { enabled: true } });
        const h = fakePi();
        const c = fakeCtx(sb2.home);
        activate(h.pi);
        expect(h.tools.has("schedule")).toBe(false);
        expect(h.commands.has("schedule")).toBe(false);
        await emit(h, "session_start", { type: "session_start", reason: "startup" }, c.ctx);
        const prompt = await systemPromptFor(h, c.ctx);
        expect(prompt).not.toContain("pi_schedules");
        expect(existsSync(join(sb2.home, ".pi", "agent", "schedules"))).toBe(false);
        await emit(h, "session_shutdown", { type: "session_shutdown" }, c.ctx);
      } finally {
        resetGlobals();
        sb2.cleanup();
      }
    } finally {
      resetSecureDomainForTests();
      v.cleanup();
    }
  });
});

// TODO-P4A (darwin plan §5.3 end): the real-hub-child segment — projection of this session's
// tasks, pendingReports receipt cleanup, unknown-run prediction, and the hub's zero-write
// snapshot of the ledger directory. Blocked on P4-A (hub-side identity injection): until it is
// merged the hub's readSelfIdentity() is undefined on darwin and every projection fail-closes.
describe.skipIf(!HUB_SEGMENT_READY || process.platform !== "darwin")(
  "schedule darwin e2e — real hub child (P4-A)",
  () => {
    it("hub projection / receipt / unknown prediction / zero ledger writes", async () => {
      expect.fail("TODO-P4A: port the schedule-hub.test.ts harness once P4-A (hub identity) lands");
    });
  },
);
