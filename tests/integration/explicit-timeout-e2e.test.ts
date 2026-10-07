import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { TIMEOUT_NOTICE_TYPE } from "../../src/delivery/deadline-notice.js";
import activate from "../../src/index.js";
import { RuntimeRunner } from "../../src/runtime/runner.js";
import { PiSessionDriver } from "../../src/runtime/session-driver.js";

/**
 * agent-explicit-timeout-extend plan §7 收尾 E1/E1b/E2 + N1-N3 (★ 真实入口):
 * the model-facing explicit `timeout_s` semantics driven through the REAL
 * activate() → buildSessionStack → SpawnService → runner chain — only the
 * child-session process is faked (PiSessionDriver spy, the ask-user-interrupt
 * pattern). Real (short) timers per plan §7's fallback option
 * (budget.totalGraceS etc. — fake timers cannot drive the stack's
 * module-captured systemClock).
 *
 *  E1   top-level full chain: grace notice (triggerTurn) → extend rescues →
 *       second grace → clamp to H → limit_reached → NO third grace → timed_out
 *       at H with 2+2 notices, one completion, bounded death, slot released.
 *  E1b  nobody extends ⇒ timed_out at T+G; abort inside grace ⇒ aborted.
 *  E2   extend.enabled=false ⇒ no tool, no grace, death at T.
 *  N1   nested real path: grandchild grace is silent (CC2), parent turn blocks,
 *       terminal at T+G, diag.timeoutPolicy extendable.
 *  N2   the MAIN session can extend the grandchild by run id mid-grace.
 *  N3   nested run_in_background variant + parent abort leaves no orphan.
 */
const HOST_KEY = Symbol.for("pi-subagent:host");
const FEISHU_HOST_KEY = Symbol.for("pi-subagent:feishu-notify:host");
const STATUS_KEY = Symbol.for("pi-subagent:background-status");

type Handler = (event: unknown, ctx: unknown) => unknown;
type Sent = { message: { customType: string; content: string; details: any }; options?: { triggerTurn?: boolean } };

function fakePi(branch: unknown[]) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDefinition>();
  const sent: Sent[] = [];
  const busEvents: { channel: string; payload: any }[] = [];
  const busListeners = new Map<string, Array<(payload: unknown) => void>>();
  const pi = {
    registerTool(tool: { name: string }) {
      if (!tools.has(tool.name)) tools.set(tool.name, tool as ToolDefinition);
    },
    registerCommand() {},
    registerEntryRenderer() {},
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage(message: Sent["message"], options?: Sent["options"]) {
      sent.push({ message, ...(options ? { options } : {}) });
      // Real pi lands sent messages as branch entries — mirror that so the
      // outbox context-receipt read-back on a rebuild sees them.
      branch.push({
        type: "custom_message",
        customType: message.customType,
        details: message.details,
        timestamp: new Date().toISOString(),
      });
    },
    sendUserMessage() {},
    appendEntry(customType: string, data: unknown) {
      branch.push({ type: "custom", customType, data });
    },
    events: {
      on(channel: string, listener: (payload: unknown) => void) {
        busListeners.set(channel, [...(busListeners.get(channel) ?? []), listener]);
        return () => {
          const list = busListeners.get(channel) ?? [];
          const idx = list.indexOf(listener);
          if (idx >= 0) list.splice(idx, 1);
        };
      },
      emit(channel: string, payload: unknown) {
        busEvents.push({ channel, payload });
        for (const listener of [...(busListeners.get(channel) ?? [])]) listener(payload);
      },
    },
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools: () => undefined,
  };
  const ctx = {
    cwd: process.env.HOME,
    hasUI: false,
    mode: "print",
    sessionManager: {
      getEntries: () => branch,
      getBranch: () => branch,
      getSessionId: () => `explicit-timeout-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      getSessionFile: () => undefined,
    },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    ui: { notify: () => undefined },
  } as unknown as ExtensionContext;
  const emit = async (event: string, payload: unknown = {}) => {
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
  };
  const call = async (name: string, params: Record<string, unknown>) =>
    (await tools.get(name)!.execute!("tc", params as never, undefined as never, undefined as never, ctx as never)) as {
      content: { type: string; text: string }[];
      details: any;
    };
  return { pi: pi as unknown as ExtensionAPI, tools, sent, busEvents, emit, call };
}

function writeAgentFiles(home: string) {
  const dir = join(home, ".pi", "agent", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "worker.md"), "---\nname: worker\ndescription: worker\n---\nYou work.\n");
  writeFileSync(
    join(dir, "parent.md"),
    "---\nname: parent\ndescription: parent\ncan_spawn: worker\n---\nYou delegate.\n",
  );
}

function writeSettings(home: string, extra: Record<string, unknown> = {}) {
  const settingsPath = join(home, ".pi", "agent", "pi-subagent.json");
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        // Plan §7 fallback timing: G=1s (N tests widen to 2s), extensions 2,
        // factor 3, fast abort/reap. totalGraceS/maxExtensions/maxTotalFactor
        // shape both the explicit-timeout and default-budget paths.
        budget: { totalGraceS: 1, maxExtensions: 2, maxTotalFactor: 3, abortGraceS: 0.05, reapS: 0.05 },
        fleetWidget: false,
        quota: { enabled: false },
        ...extra,
      },
      null,
      2,
    ) + "\n",
  );
}

let home = "";
let realHome: string | undefined;
let scratch = "";

beforeEach(() => {
  for (const key of [HOST_KEY, FEISHU_HOST_KEY, STATUS_KEY]) delete (globalThis as Record<symbol, unknown>)[key];
  home = mkdtempSync(join(tmpdir(), "pi-explicit-e2e-home-"));
  realHome = process.env.HOME;
  process.env.HOME = home;
  scratch = mkdtempSync(join(tmpdir(), "pi-explicit-e2e-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const key of [HOST_KEY, FEISHU_HOST_KEY, STATUS_KEY]) delete (globalThis as Record<symbol, unknown>)[key];
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

async function until(pred: () => boolean | Promise<boolean>, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const TERMINAL = new Set(["completed", "failed", "timed_out", "aborted"]);
/** Live read of a run's status; "unresolved" while the id is not yet resolvable
 *  (a slotless spawn returns before the runner's first onSnapshot lands). */
async function readStatus(host: ReturnType<typeof fakePi>, runId: string): Promise<string> {
  try {
    const read = await host.call("get_subagent_result", { run_id: runId });
    return String(read.details?.status ?? "unknown");
  } catch {
    return "unresolved";
  }
}

const timeoutNotices = (sent: Sent[]) => sent.filter((s) => s.message.customType === TIMEOUT_NOTICE_TYPE);
const graceNotices = (sent: Sent[]) => timeoutNotices(sent).filter((s) => s.message.details?.kind === "grace");
const completions = (sent: Sent[], runId: string) =>
  sent.filter((s) => s.message.customType === "subagent:notification" && s.message.details?.runId === runId);

/** Stub only the child-session process; every run still flows through the real
 *  SpawnService/runner (a fake driver must never bypass the spawn service). */
interface DriverCall {
  kind: "create" | "resume";
  spec: { customTools?: unknown[] };
}
let handleSeq = 0;
function makeHandle(dir: string, hang: () => boolean) {
  const file = join(dir, `child-${++handleSeq}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session", id: `c${handleSeq}` })}\n`);
  return {
    sessionId: `c${handleSeq}`,
    sessionFile: file,
    prompt: () => (hang() ? new Promise<void>(() => undefined) : Promise.resolve()),
    steer: () => Promise.resolve(),
    requestAbort: () => Promise.resolve(),
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools: () => undefined,
    getActiveTools: () => [],
    getLastAssistantText: () => "hello from subagent",
    getUsage: () => undefined,
  };
}
function stubDriver(hang: () => boolean) {
  const calls: DriverCall[] = [];
  vi.spyOn(PiSessionDriver.prototype, "create").mockImplementation(async (spec) => {
    calls.push({ kind: "create", spec: spec as DriverCall["spec"] });
    return makeHandle(scratch, hang) as never;
  });
  vi.spyOn(PiSessionDriver.prototype, "resume").mockImplementation(async (_file, spec) => {
    calls.push({ kind: "resume", spec: spec as DriverCall["spec"] });
    return makeHandle(scratch, hang) as never;
  });
  vi.spyOn(PiSessionDriver.prototype, "bind").mockResolvedValue(undefined);
  return { calls };
}

interface Captured {
  req: {
    runId: string;
    timeoutPolicy?: string;
    parentRunId?: string;
    label?: string;
  };
  budget: { maxTotalFactor: number; maxExtensions: number };
}
function spyRunnerRun() {
  const captured: Captured[] = [];
  const original = RuntimeRunner.prototype.run;
  vi.spyOn(RuntimeRunner.prototype, "run").mockImplementation(function (this: RuntimeRunner, req, budget) {
    captured.push({ req: req as Captured["req"], budget });
    return original.call(this, req, budget);
  });
  return captured;
}

const toolOf = (spec: { customTools?: unknown[] }, name: string) =>
  (spec.customTools ?? []).find((t) => (t as { name?: string }).name === name) as
    | {
        execute: (
          id: string,
          params: Record<string, unknown>,
          u1: undefined,
          u2: undefined,
          u3: undefined,
        ) => Promise<{ content: { type: string; text: string }[]; details: any }>;
      }
    | undefined;

describe("explicit timeout_s end to end (activate → stack → tools)", () => {
  it("E1: grace notice → extend rescues → second grace → clamped to H → limit_reached → timed_out at H, slot released", async () => {
    writeAgentFiles(home);
    writeSettings(home, { concurrencyLimit: 1 });
    const hang = { value: true };
    const branch: unknown[] = [];
    const host = fakePi(branch);
    stubDriver(() => hang.value);
    const captured = spyRunnerRun();
    activate(host.pi);
    await host.emit("session_start", { reason: "startup" });
    expect(host.tools.has("extend_subagent_timeout")).toBe(true);

    const startedAt = Date.now();
    const started = await host.call("Agent", {
      description: "hang-2s",
      prompt: "work slowly",
      subagent_type: "worker",
      timeout_s: 2,
    });
    const runId = started.details.runId as string;
    expect(started.content[0]!.text).toContain(runId);
    await until(() => captured.some((c) => c.req.runId === runId));
    expect(captured.find((c) => c.req.runId === runId)?.req.timeoutPolicy).toBe("extendable");

    // t≈2s: soft deadline fires → exactly one grace notice, run still alive.
    await until(() => graceNotices(host.sent).length === 1);
    const grace1 = graceNotices(host.sent)[0]!;
    expect(grace1.options).toEqual({ triggerTurn: true });
    expect(grace1.message.details).toMatchObject({ kind: "grace", runId });
    // factor 3 ⇒ H − D0 = 2×T = 4s (H = enqueuedAt + 6s).
    expect(grace1.message.details.hardDeadlineAt - grace1.message.details.deadlineAt).toBe(4_000);
    const mid = await host.call("get_subagent_result", { run_id: runId });
    expect(TERMINAL.has(String(mid.details.status))).toBe(false);
    expect(mid.content[0]!.text).toContain("is still");

    // Extend 1s from inside the grace window → rescued.
    const ext1 = await host.call("extend_subagent_timeout", { run_id: runId, extend_s: 1, reason: "nearly done" });
    expect(ext1.details).toMatchObject({ ok: true, rescuedFromGrace: true, extensionsRemaining: 1 });
    expect(ext1.content[0]!.text).toContain("back to normal execution");

    // t≈3.1s (extended deadline): second grace notice.
    await until(() => graceNotices(host.sent).length === 2);
    expect(graceNotices(host.sent)[1]!.message.details).toMatchObject({ kind: "grace", runId });

    // Ask for 10s — clamped by H; the new deadline IS the hard ceiling.
    const ext2 = await host.call("extend_subagent_timeout", { run_id: runId, extend_s: 10 });
    expect(ext2.details).toMatchObject({ ok: true, clamped: true });
    expect(ext2.content[0]!.text).toContain("clamped by its hard ceiling");
    expect(ext2.details.deadlineAt).toBe(ext2.details.hardDeadlineAt);
    expect(ext2.details.hardDeadlineAt - grace1.message.details.deadlineAt + 2_000).toBe(6_000);

    // Both extensions spent → a third call is refused with the limit text.
    await expect(host.call("extend_subagent_timeout", { run_id: runId, extend_s: 5 })).rejects.toThrow(
      /already used all 2 deadline extensions/,
    );

    // t=6s (H): no third grace (D-6), timed_out, exactly 2 grace + 2 extended
    // receipts (extended are display-only), exactly one completion message.
    await until(() => completions(host.sent, runId).length > 0);
    const notices = timeoutNotices(host.sent);
    expect(notices).toHaveLength(4);
    expect(notices.map((n) => n.message.details.kind)).toEqual(["grace", "extended", "grace", "extended"]);
    for (const n of notices.filter((x) => x.message.details.kind === "extended"))
      expect(n.options).toEqual({ triggerTurn: false });
    expect(completions(host.sent, runId)).toHaveLength(1);

    const done = await host.call("get_subagent_result", { run_id: runId });
    expect(done.details.status).toBe("timed_out");
    expect(done.content[0]!.text).toContain("total budget exceeded");
    expect(done.content[0]!.text).not.toContain("fixed deadline");
    // The PERSISTED terminal entry carries the resolved policy + overtime tally
    // (plan §7 E1 ★ — not just the admission-time req mirror).
    const terminalEntry = branch.find(
      (e) =>
        (e as { customType?: string }).customType === "subagent:run" &&
        (e as { data?: { runId?: string; status?: string } }).data?.runId === runId &&
        TERMINAL.has(String((e as { data?: { status?: string } }).data?.status)),
    ) as
      { data?: { diag?: { timeoutPolicy?: string; overtime?: { graces?: number; extensions?: number } } } } | undefined;
    expect(terminalEntry?.data?.diag?.timeoutPolicy).toBe("extendable");
    expect(terminalEntry?.data?.diag?.overtime).toMatchObject({ graces: 2, extensions: 2 });
    // Death bounded by H + A + R + tick (H = 3×2s, A = R = 50ms, tick = 1s).
    expect(Date.now() - startedAt).toBeLessThan(6_000 + 50 + 50 + 1_000 + 2_500);

    // Slot released: the pool limit is 1 and the Agent tool REJECTS when
    // full (queueWhenFull defaults false) — a successful admission here
    // means the dead run's slot was already freed, and the run completes.
    hang.value = false;
    const next = await host.call("Agent", {
      description: "quick-after-death",
      prompt: "finish fast",
      subagent_type: "worker",
    });
    const nextId = next.details.runId as string;
    await until(() => completions(host.sent, nextId).length > 0);
    const nextRead = await host.call("get_subagent_result", { run_id: nextId });
    expect(nextRead.details.status).toBe("completed");
    await host.emit("session_shutdown", { reason: "quit" });
  }, 40_000);

  it("E1b: nobody extends ⇒ timed_out at T+G with one notice; abort inside grace ⇒ aborted", async () => {
    writeAgentFiles(home);
    writeSettings(home);
    const branch: unknown[] = [];
    const host = fakePi(branch);
    stubDriver(() => true);
    activate(host.pi);
    await host.emit("session_start", { reason: "startup" });

    // (a) ignore the grace notice: the run dies at T+G, exactly one notice.
    const first = await host.call("Agent", {
      description: "no-extend",
      prompt: "hang",
      subagent_type: "worker",
      timeout_s: 1,
    });
    const firstId = first.details.runId as string;
    await until(() => graceNotices(host.sent).length === 1);
    expect(graceNotices(host.sent)[0]!.message.details).toMatchObject({ kind: "grace", runId: firstId });
    await until(() => completions(host.sent, firstId).length > 0);
    const read1 = await host.call("get_subagent_result", { run_id: firstId });
    expect(read1.details.status).toBe("timed_out");
    expect(read1.content[0]!.text).toContain("total budget exceeded after grace");
    expect(timeoutNotices(host.sent)).toHaveLength(1);

    // (b) abort while inside the grace window ⇒ aborted (strict-truncation path).
    const second = await host.call("Agent", {
      description: "abort-in-grace",
      prompt: "hang",
      subagent_type: "worker",
      timeout_s: 1,
    });
    const secondId = second.details.runId as string;
    await until(() => graceNotices(host.sent).length === 2);
    const stopped = await host.call("abort_subagent", { run_id: secondId });
    expect(stopped.details).toMatchObject({ runId: secondId, ok: true });
    await until(() => completions(host.sent, secondId).length > 0);
    const read2 = await host.call("get_subagent_result", { run_id: secondId });
    expect(read2.details.status).toBe("aborted");
    await host.emit("session_shutdown", { reason: "quit" });
  }, 30_000);

  it("E2: extend.enabled=false ⇒ no extend tool, no grace — the timeout_s run dies at T", async () => {
    writeAgentFiles(home);
    writeSettings(home, { extend: { enabled: false, notify: "background" } });
    const branch: unknown[] = [];
    const host = fakePi(branch);
    stubDriver(() => true);
    activate(host.pi);
    await host.emit("session_start", { reason: "startup" });
    expect(host.tools.has("extend_subagent_timeout")).toBe(false);

    const started = await host.call("Agent", {
      description: "hard-cap",
      prompt: "hang",
      subagent_type: "worker",
      timeout_s: 1,
    });
    const runId = started.details.runId as string;
    await until(() => completions(host.sent, runId).length > 0);
    const done = await host.call("get_subagent_result", { run_id: runId });
    expect(done.details.status).toBe("timed_out");
    expect(timeoutNotices(host.sent)).toHaveLength(0); // no grace, no receipts
    await host.emit("session_shutdown", { reason: "quit" });
  }, 20_000);
});

describe("nested Agent timeout_s (N1-N3, real injected tool)", () => {
  async function dispatchParent(host: ReturnType<typeof fakePi>) {
    const parent = await host.call("Agent", {
      description: "parent-run",
      prompt: "delegate to a worker",
      subagent_type: "parent",
    });
    return parent.details.runId as string;
  }

  it("N1: grandchild grace is silent (CC2), the parent turn blocks, terminal at T+G, policy extendable", async () => {
    writeAgentFiles(home);
    // G=2s, factor 4 (H=4s): the grace window outlives T by a wide margin.
    writeSettings(home, {
      budget: { totalGraceS: 2, maxExtensions: 2, maxTotalFactor: 4, abortGraceS: 0.05, reapS: 0.05 },
    });
    const branch: unknown[] = [];
    const host = fakePi(branch);
    const driver = stubDriver(() => true);
    const captured = spyRunnerRun();
    activate(host.pi);
    await host.emit("session_start", { reason: "startup" });

    const parentRunId = await dispatchParent(host);
    await until(() => driver.calls.some((c) => toolOf(c.spec, "Agent") !== undefined));
    const nestedAgent = toolOf(driver.calls.find((c) => toolOf(c.spec, "Agent") !== undefined)!.spec, "Agent")!;

    // Blocking nested call (default) — deliberately not awaited.
    const outcome: { state: "pending" | "rejected"; error?: Error } = { state: "pending" };
    const nestedPromise = nestedAgent
      .execute(
        "nested-call-1",
        { description: "grandchild", prompt: "sub work", subagent_type: "worker", timeout_s: 1 },
        undefined,
        undefined,
        undefined,
      )
      .catch((error: Error) => {
        outcome.state = "rejected";
        outcome.error = error;
        return { content: [{ type: "text", text: "swallowed" }], details: {} } as never;
      });
    void nestedPromise;

    await until(() => captured.some((c) => c.req.parentRunId === parentRunId));
    const grandchild = captured.find((c) => c.req.parentRunId === parentRunId)!;
    expect(grandchild.req.timeoutPolicy).toBe("extendable");
    const grandchildId = grandchild.req.runId;

    // Past T (1s) the grandchild is in its SILENT grace window: alive, no
    // subagent:timeout for it in the main session (CC2), parent turn blocked.
    await until(
      async () =>
        !(
          TERMINAL.has(await readStatus(host, grandchildId)) || (await readStatus(host, grandchildId)) === "unresolved"
        ),
    );
    expect(timeoutNotices(host.sent).filter((n) => n.message.details?.runId === grandchildId)).toHaveLength(0);
    expect(timeoutNotices(host.sent)).toHaveLength(0); // nothing else times out either
    expect(outcome.state).toBe("pending");

    // T+G (≈3s): timed_out, the nested call resolves to the timeout result,
    // the parent run itself is untouched and still running.
    await until(() => outcome.state === "rejected", 12_000);
    expect(outcome.error?.message).toContain("total budget exceeded after grace"); // diag.overtime ⇒ graced
    expect(outcome.error?.message).not.toContain("fixed deadline");
    const grandchildRead = await host.call("get_subagent_result", { run_id: grandchildId });
    expect(grandchildRead.details.status).toBe("timed_out");
    // Plan §7 N1 ★: the persisted terminal snapshot proves exactly one grace was
    // taken (the error-text inference above is only indirect evidence).
    const gcEntry = branch.find(
      (e) =>
        (e as { customType?: string }).customType === "subagent:run" &&
        (e as { data?: { runId?: string; status?: string } }).data?.runId === grandchildId &&
        (e as { data?: { status?: string } }).data?.status === "timed_out",
    ) as { data?: { diag?: { overtime?: { graces?: number } } } } | undefined;
    expect(gcEntry?.data?.diag?.overtime?.graces).toBe(1);
    expect(timeoutNotices(host.sent)).toHaveLength(0); // still silent end to end
    // The parent run itself is untouched and still live.
    expect(TERMINAL.has(await readStatus(host, parentRunId))).toBe(false);

    await host.call("abort_subagent", { run_id: parentRunId });
    await until(async () => {
      const read = await host.call("get_subagent_result", { run_id: parentRunId });
      return read.details.status === "aborted";
    });
    await host.emit("session_shutdown", { reason: "quit" });
  }, 40_000);

  it("N2: the MAIN session extends the grandchild by run id mid-grace — it outlives its original grace end", async () => {
    writeAgentFiles(home);
    writeSettings(home, {
      budget: { totalGraceS: 2, maxExtensions: 2, maxTotalFactor: 4, abortGraceS: 0.05, reapS: 0.05 },
    });
    const branch: unknown[] = [];
    const host = fakePi(branch);
    const driver = stubDriver(() => true);
    const captured = spyRunnerRun();
    activate(host.pi);
    await host.emit("session_start", { reason: "startup" });

    const parentRunId = await dispatchParent(host);
    await until(() => driver.calls.some((c) => toolOf(c.spec, "Agent") !== undefined));
    const nestedAgent = toolOf(driver.calls.find((c) => toolOf(c.spec, "Agent") !== undefined)!.spec, "Agent")!;
    const outcome: { state: string } = { state: "pending" };
    const nestedPromise = nestedAgent
      .execute(
        "nested-call-1",
        { description: "grandchild", prompt: "sub work", subagent_type: "worker", timeout_s: 1 },
        undefined,
        undefined,
        undefined,
      )
      .catch(() => {
        outcome.state = "rejected";
      });
    void nestedPromise;

    await until(() => captured.some((c) => c.req.parentRunId === parentRunId));
    const grandchildId = captured.find((c) => c.req.parentRunId === parentRunId)!.req.runId;
    // Wait until the grandchild is past its soft deadline (inside grace).
    await until(async () => {
      const status = await readStatus(host, grandchildId);
      return status !== "unresolved" && !TERMINAL.has(status);
    });
    await new Promise((r) => setTimeout(r, 1_200)); // ≈T+200ms: inside the 2s window

    const extended = await host.call("extend_subagent_timeout", { run_id: grandchildId, extend_s: 5 });
    expect(extended.details).toMatchObject({ ok: true, rescuedFromGrace: true });
    expect(extended.content[0]!.text).toContain("back to normal execution");
    expect(timeoutNotices(host.sent)).toHaveLength(0); // rescue itself is silent for a child run

    // Past the original grace end (T+2s ≈ +0.8s from here): still alive, the
    // nested call is still blocking — proof the main session rescued it.
    await new Promise((r) => setTimeout(r, 1_000));
    expect(await readStatus(host, grandchildId)).not.toBe("timed_out");
    expect(TERMINAL.has(await readStatus(host, grandchildId))).toBe(false);
    expect(outcome.state).toBe("pending");

    await host.call("abort_subagent", { run_id: parentRunId });
    await until(async () => TERMINAL.has(await readStatus(host, grandchildId)));
    await host.emit("session_shutdown", { reason: "quit" });
  }, 40_000);

  it("N3: run_in_background nested variant — silent, terminal at T+G; parent abort leaves no orphan", async () => {
    writeAgentFiles(home);
    writeSettings(home, {
      budget: { totalGraceS: 1, maxExtensions: 2, maxTotalFactor: 4, abortGraceS: 0.05, reapS: 0.05 },
    });
    const branch: unknown[] = [];
    const host = fakePi(branch);
    const driver = stubDriver(() => true);
    const captured = spyRunnerRun();
    activate(host.pi);
    await host.emit("session_start", { reason: "startup" });

    const parentRunId = await dispatchParent(host);
    await until(() => driver.calls.some((c) => toolOf(c.spec, "Agent") !== undefined));
    const nestedAgent = toolOf(driver.calls.find((c) => toolOf(c.spec, "Agent") !== undefined)!.spec, "Agent")!;

    // (a) background variant: returns a run_id at once; silent grace; the
    // grandchild settles timed_out at T+G with zero notices in the main session.
    const bg = await nestedAgent.execute(
      "nested-bg-1",
      {
        description: "bg-grandchild",
        prompt: "sub work",
        subagent_type: "worker",
        timeout_s: 1,
        run_in_background: true,
      },
      undefined,
      undefined,
      undefined,
    );
    const bgRunId = bg.details.runId as string;
    expect(bg.content[0]!.text).toContain(bgRunId);
    await until(async () => (await readStatus(host, bgRunId)) === "timed_out", 10_000);
    expect(timeoutNotices(host.sent)).toHaveLength(0);

    // (b) a second background grandchild is killed WITH the parent's abort.
    const bg2 = await nestedAgent.execute(
      "nested-bg-2",
      {
        description: "bg-grandchild-2",
        prompt: "more sub work",
        subagent_type: "worker",
        timeout_s: 30,
        run_in_background: true,
      },
      undefined,
      undefined,
      undefined,
    );
    const bg2RunId = bg2.details.runId as string;
    await until(async () => {
      const status = await readStatus(host, bg2RunId);
      return status !== "unresolved" && !TERMINAL.has(status);
    });
    await host.call("abort_subagent", { run_id: parentRunId });
    await until(async () => TERMINAL.has(await readStatus(host, bg2RunId)));
    expect(TERMINAL.has(await readStatus(host, parentRunId))).toBe(true);
    expect(timeoutNotices(host.sent)).toHaveLength(0);
    await host.emit("session_shutdown", { reason: "quit" });
  }, 40_000);
});
