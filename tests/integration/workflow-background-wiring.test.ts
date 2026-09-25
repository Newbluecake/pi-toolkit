import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import activate from "../../src/index.js";
import { readBackgroundStatus } from "../../src/service/background-status.js";
import { WORKFLOW_NOTICE_ENTRY_TYPE, WORKFLOW_NOTIFICATION_TYPE } from "../../src/adapters/workflow-notice.js";

/**
 * Background SubagentWorkflow end-to-end through the real activate() / stack
 * (docs/dev/workflow-background/plan.md): immediate return, management via
 * get_subagent_result / abort_subagent, exactly-once completion notice, and
 * the shutdown path (running workflow stopped, notice persisted, re-delivered
 * once by the next activation on the same session file).
 *
 * The script blocks on `gate()`, whose `pi.exec` never resolves until the test
 * releases it — a real worker thread, a real orchestrator, no timers faked.
 * Runs on a throwaway $HOME (settings file enables the workflow engine).
 */
const HOST_KEY = Symbol.for("pi-subagent:host");
const FEISHU_HOST_KEY = Symbol.for("pi-subagent:feishu-notify:host");
const STATUS_KEY = Symbol.for("pi-subagent:background-status");
const fakeHome = mkdtempSync(join(tmpdir(), "pi-subagent-wfbg-home-"));
const realHome = process.env.HOME;
process.env.HOME = fakeHome;
const settingsPath = join(fakeHome, ".pi", "agent", "pi-subagent.json");

type Handler = (event: unknown, ctx: unknown) => unknown;
type Sent = { message: { customType: string; content: string; details: any }; options?: { triggerTurn?: boolean } };

function fakePi(branch: unknown[]) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDefinition>();
  const sent: Sent[] = [];
  const execs: (() => void)[] = [];
  const busEvents: { channel: string; payload: any }[] = [];
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
    },
    sendUserMessage() {},
    appendEntry(customType: string, data: unknown) {
      branch.push({ type: "custom", customType, data });
    },
    events: {
      on: () => () => undefined,
      emit: (channel: string, payload: unknown) => busEvents.push({ channel, payload }),
    },
    // gate() → pi.exec: held until the test releases it.
    exec: () => new Promise((resolve) => execs.push(() => resolve({ code: 0, stdout: "", stderr: "", killed: false }))),
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools: () => undefined,
  };
  const ctx = {
    cwd: fakeHome,
    hasUI: false,
    mode: "print",
    sessionManager: {
      getEntries: () => branch,
      getBranch: () => branch,
      getSessionId: () => "wf-background-wiring",
      getSessionFile: () => undefined,
    },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    ui: {},
  } as unknown as ExtensionContext;
  const emit = async (event: string, payload: unknown = {}) => {
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
  };
  const call = async (name: string, params: Record<string, unknown>) =>
    (await tools.get(name)!.execute!("tc", params as never, undefined as never, undefined as never, ctx as never)) as {
      content: { type: string; text: string }[];
      details: any;
    };
  return { pi: pi as unknown as ExtensionAPI, tools, sent, execs, busEvents, emit, call };
}

const HELD_SCRIPT =
  'export const meta = { name: "held-flow", description: "t" };\nawait gate("sleep 1");\nreturn "released";';

async function until(pred: () => boolean, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const workflowNotices = (sent: Sent[]) => sent.filter((s) => s.message.customType === WORKFLOW_NOTIFICATION_TYPE);

beforeEach(() => {
  for (const key of [HOST_KEY, FEISHU_HOST_KEY, STATUS_KEY]) delete (globalThis as Record<symbol, unknown>)[key];
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify({ workflow: { enabled: true }, fleetWidget: false, quota: { enabled: false } }, null, 2) + "\n",
  );
});
afterEach(() => {
  for (const key of [HOST_KEY, FEISHU_HOST_KEY, STATUS_KEY]) delete (globalThis as Record<symbol, unknown>)[key];
  rmSync(settingsPath, { force: true });
});
afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("background SubagentWorkflow wiring (activate → stack)", () => {
  it("returns at once, is managed by id, and notifies exactly once when it completes", async () => {
    const branch: unknown[] = [];
    const host = fakePi(branch);
    activate(host.pi);
    await host.emit("session_start", { reason: "startup" });

    const started = await host.call("SubagentWorkflow", { script: HELD_SCRIPT });
    const id = started.details.workflowId as string;
    expect(started.details).toMatchObject({ status: "running", background: true, label: "held-flow" });
    await until(() => host.execs.length > 0); // the script is really parked in gate()

    const running = await host.call("get_subagent_result", { run_id: id });
    expect(running.content[0]!.text).toContain("is still running");
    // Busy for background-idle gating (feishu) even with no live child run.
    expect(readBackgroundStatus()?.runningSubagents).toBe(1);
    expect(workflowNotices(host.sent)).toHaveLength(0);

    host.execs[0]!();
    const done = await host.call("get_subagent_result", { run_id: id, wait: true, wait_ms: 10_000 });
    expect(done.details).toMatchObject({ workflowId: id, status: "completed" });
    expect(done.content[0]!.text).toContain("result: released");
    await until(() => workflowNotices(host.sent).length > 0);
    const notices = workflowNotices(host.sent);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.options).toEqual({ triggerTurn: true });
    expect(notices[0]!.message.content).toContain(`Workflow "held-flow" (${id}) completed`);
    expect(readBackgroundStatus()?.runningSubagents).toBe(0);

    const again = await host.call("abort_subagent", { run_id: id });
    expect(again.details).toMatchObject({ alreadyTerminal: true, status: "completed" });
    expect(workflowNotices(host.sent)).toHaveLength(1);
    await host.emit("session_shutdown", { reason: "quit" });
  }, 30_000);

  it("abort_subagent stops a running workflow; its notice reports the abort", async () => {
    const host = fakePi([]);
    activate(host.pi);
    await host.emit("session_start", { reason: "startup" });
    const started = await host.call("SubagentWorkflow", { script: HELD_SCRIPT });
    const id = started.details.workflowId as string;
    await until(() => host.execs.length > 0);
    const stopped = await host.call("abort_subagent", { run_id: id });
    expect(stopped.details).toMatchObject({ workflowId: id, ok: true, settled: true, status: "aborted" });
    await until(() => workflowNotices(host.sent).length > 0);
    expect(workflowNotices(host.sent)[0]!.message.details).toMatchObject({ workflowId: id, status: "aborted" });
    await host.emit("session_shutdown", { reason: "quit" });
  }, 30_000);

  it("session_shutdown stops a running workflow, persists its notice, and the next activation re-delivers it once", async () => {
    const branch: unknown[] = [];
    const first = fakePi(branch);
    activate(first.pi);
    await first.emit("session_start", { reason: "startup" });
    const started = await first.call("SubagentWorkflow", { script: HELD_SCRIPT });
    const id = started.details.workflowId as string;
    await until(() => first.execs.length > 0);

    await first.emit("session_shutdown", { reason: "reload" });
    // The orchestrator itself reached its terminal state inside the shutdown drain (no orphan worker) …
    expect(first.busEvents.some((e) => e.channel === "subagent:workflow:aborted" && e.payload?.workflowId === id)).toBe(
      true,
    );
    // Not pushed into the session that is going away …
    expect(workflowNotices(first.sent)).toHaveLength(0);
    // … but persisted into it, as an aborted (shutdown) outcome.
    const persisted = branch.filter(
      (e) => (e as { customType?: string }).customType === WORKFLOW_NOTICE_ENTRY_TYPE,
    ) as { data: { state: string; workflowId: string; outcome: { status: string; stopCause?: string } } }[];
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.data).toMatchObject({ state: "pending", workflowId: id });
    expect(persisted[0]!.data.outcome.status).toBe("aborted");
    expect(persisted[0]!.data.outcome.stopCause).toBe("shutdown");

    const second = fakePi(branch);
    activate(second.pi);
    await second.emit("session_start", { reason: "reload" });
    const redelivered = workflowNotices(second.sent);
    expect(redelivered).toHaveLength(1);
    expect(redelivered[0]!.options).toEqual({ triggerTurn: false });
    expect(redelivered[0]!.message.details).toMatchObject({ workflowId: id, redelivered: true });
    const read = await second.call("get_subagent_result", { run_id: id });
    expect(read.details).toMatchObject({ workflowId: id, status: "aborted" });
    await second.emit("session_shutdown", { reason: "reload" });

    const third = fakePi(branch);
    activate(third.pi);
    await third.emit("session_start", { reason: "reload" });
    expect(workflowNotices(third.sent)).toHaveLength(0); // delivered marker: exactly once
    await third.emit("session_shutdown", { reason: "quit" });
  }, 40_000);

  it("a session_start without a paired shutdown abandons the previous stack's workflows: stopped, no notice", async () => {
    const branch: unknown[] = [];
    const host = fakePi(branch);
    activate(host.pi);
    await host.emit("session_start", { reason: "startup" });
    const started = await host.call("SubagentWorkflow", { script: HELD_SCRIPT });
    const id = started.details.workflowId as string;
    await until(() => host.execs.length > 0);
    await host.emit("session_start", { reason: "new" }); // defensive rebuild path
    // The orphaned workflow is not visible from the new stack …
    await expect(host.call("get_subagent_result", { run_id: id })).rejects.toThrow(/unknown workflow id/);
    // … but it was stopped (the orchestrator's own terminal event: aborted/shutdown — no orphan) …
    await until(() =>
      host.busEvents.some((e) => e.channel === "subagent:workflow:aborted" && e.payload?.workflowId === id),
    );
    const aborted = host.busEvents.find((e) => e.channel === "subagent:workflow:aborted")!;
    expect(aborted.payload.stopCause).toBe("shutdown");
    // … and nothing was sent or persisted for it (its session is no longer current).
    await new Promise((r) => setTimeout(r, 100));
    expect(workflowNotices(host.sent)).toHaveLength(0);
    expect(branch.some((e) => (e as { customType?: string }).customType === WORKFLOW_NOTICE_ENTRY_TYPE)).toBe(false);
    await host.emit("session_shutdown", { reason: "quit" });
  }, 30_000);
});
