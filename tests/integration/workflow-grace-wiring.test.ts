import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import activate from "../../src/index.js";
import { WORKFLOW_NOTIFICATION_TYPE } from "../../src/adapters/workflow-notice.js";
import { OUTBOX_CUSTOM_TYPE } from "../../src/adapters/pi-outbox-store.js";
import { TIMEOUT_NOTICE_TYPE } from "../../src/delivery/deadline-notice.js";

/**
 * workflow-agent-queue §4.5 / §7 stage B: a background workflow's timeout
 * grace + extension wired end to end through the real activate() / stack —
 * the grace notice lands in the main session on the `subagent:timeout`
 * channel with triggerTurn:true, `extend_subagent_timeout(run_id: wf_…)`
 * rescues it (extended receipt, triggerTurn:false), and the notices never
 * touch the delivery outbox (no `subagent:notification`, no persisted
 * outbox entry): the only completion-class message is the workflow's own
 * notification, exactly once.
 *
 * Real worker thread, real orchestrator, real (short) timers: workflowTotalS 1,
 * totalGraceS 2, maxExtensions 1, maxTotalFactor 10. The script parks on a
 * never-settling promise (not `gate()`: an in-flight gate is bounded by the
 * `killAt` of its own call time, which an extension does not lengthen).
 */
const HOST_KEY = Symbol.for("pi-subagent:host");
const FEISHU_HOST_KEY = Symbol.for("pi-subagent:feishu-notify:host");
const STATUS_KEY = Symbol.for("pi-subagent:background-status");
const fakeHome = mkdtempSync(join(tmpdir(), "pi-subagent-wfgrace-home-"));
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
      getSessionId: () => "wf-grace-wiring",
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
  'export const meta = { name: "slow-flow", description: "t" };\nphase("review");\nawait new Promise(() => {});\nreturn "never";';

async function until(pred: () => boolean, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const timeoutNotices = (sent: Sent[]) => sent.filter((s) => s.message.customType === TIMEOUT_NOTICE_TYPE);
const workflowNotices = (sent: Sent[]) => sent.filter((s) => s.message.customType === WORKFLOW_NOTIFICATION_TYPE);

function writeSettings(extra: Record<string, unknown> = {}) {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        workflow: { enabled: true, budget: { workflowTotalS: 1 } },
        budget: { totalGraceS: 2, maxExtensions: 1, maxTotalFactor: 10 },
        fleetWidget: false,
        quota: { enabled: false },
        ...extra,
      },
      null,
      2,
    ) + "\n",
  );
}

beforeEach(() => {
  for (const key of [HOST_KEY, FEISHU_HOST_KEY, STATUS_KEY]) delete (globalThis as Record<symbol, unknown>)[key];
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

describe("workflow grace + extension wiring (activate → stack)", () => {
  it("grace notice → main session (triggerTurn:true); extend_subagent_timeout(wf_…) rescues it; notices never enter the outbox", async () => {
    writeSettings();
    const branch: unknown[] = [];
    const host = fakePi(branch);
    activate(host.pi);
    await host.emit("session_start", { reason: "startup" });
    const started = await host.call("SubagentWorkflow", { script: HELD_SCRIPT });
    const id = started.details.workflowId as string;
    expect(started.content[0]!.text).toContain("budget: 1s (extendable up to 10s)");

    // ~1s: soft deadline → grace window (2s) + notice.
    await until(() => timeoutNotices(host.sent).length > 0);
    const grace = timeoutNotices(host.sent)[0]!;
    expect(grace.options).toEqual({ triggerTurn: true });
    expect(grace.message.details).toMatchObject({ kind: "grace", workflowId: id, extensionsUsed: 0, maxExtensions: 1 });
    expect(grace.message.content).toContain(`⏳ Workflow "slow-flow" (${id.slice(0, 11)}) hit its 1s time budget`);
    expect(grace.message.content).toContain(`extend_subagent_timeout(run_id: "${id}", extend_s: 1)`);
    expect(grace.message.content).toContain('Now: phase "review" · 0 running · 0 queued · 0 settled');
    expect(host.busEvents.some((e) => e.channel === "subagent:workflow:deadline" && e.payload.kind === "grace")).toBe(
      true,
    );
    const view = await host.call("get_subagent_result", { run_id: id });
    expect(view.content[0]!.text).toContain("is still running");

    // Rescue it through the real tool (wf id routed to the background registry).
    const extended = await host.call("extend_subagent_timeout", { run_id: id, extend_s: 2, reason: "nearly done" });
    expect(extended.content[0]!.text).toContain(`Extended workflow ${id} by 2s`);
    expect(extended.content[0]!.text).toContain("back to normal execution");
    expect(extended.details).toMatchObject({
      ok: true,
      workflowId: id,
      rescuedFromGrace: true,
      extensionsRemaining: 0,
    });
    const receipts = timeoutNotices(host.sent);
    expect(receipts).toHaveLength(2);
    expect(receipts[1]!.options).toEqual({ triggerTurn: false });
    expect(receipts[1]!.message.details).toMatchObject({ kind: "extended", workflowId: id, grantedMs: 2_000 });
    expect(receipts[1]!.message.content).toContain("Reason: nearly done");

    // Extension budget used up: a second extend is refused with guidance.
    await expect(host.call("extend_subagent_timeout", { run_id: id, extend_s: 5 })).rejects.toThrow(
      /already used all 1 deadline extensions/,
    );

    // No grace at the extended deadline (no extensions left, D-6): timed_out, one completion notice.
    await until(() => workflowNotices(host.sent).length > 0);
    const done = workflowNotices(host.sent);
    expect(done).toHaveLength(1);
    expect(done[0]!.message.details).toMatchObject({ workflowId: id, status: "timed_out" });
    expect(timeoutNotices(host.sent)).toHaveLength(2); // no second grace notice
    // The timeout channel never used the outbox.
    expect(host.sent.some((s) => s.message.customType === "subagent:notification")).toBe(false);
    expect(branch.some((e) => (e as { customType?: string }).customType === OUTBOX_CUSTOM_TYPE)).toBe(false);
    const read = await host.call("get_subagent_result", { run_id: id });
    expect(read.details).toMatchObject({ workflowId: id, status: "timed_out" });
    await expect(host.call("extend_subagent_timeout", { run_id: id, extend_s: 1 })).rejects.toThrow(
      /already finished \(timed_out\)/,
    );
    await host.emit("session_shutdown", { reason: "quit" });
  }, 40_000);

  it('extend.notify "off": no notice is delivered, but the grace window still applies', async () => {
    writeSettings({ extend: { enabled: true, notify: "off" } });
    const host = fakePi([]);
    activate(host.pi);
    await host.emit("session_start", { reason: "startup" });
    const started = await host.call("SubagentWorkflow", { script: HELD_SCRIPT });
    const id = started.details.workflowId as string;
    await until(() => host.busEvents.some((e) => e.channel === "subagent:workflow:deadline"));
    expect(timeoutNotices(host.sent)).toHaveLength(0);
    // Still running inside the silent grace window, and still extendable.
    const extended = await host.call("extend_subagent_timeout", { run_id: id, extend_s: 1 });
    expect(extended.details).toMatchObject({ ok: true, rescuedFromGrace: true });
    expect(timeoutNotices(host.sent)).toHaveLength(0);
    const stopped = await host.call("abort_subagent", { run_id: id });
    expect(stopped.details).toMatchObject({ workflowId: id, status: "aborted" });
    await host.emit("session_shutdown", { reason: "quit" });
  }, 40_000);

  it("extend.enabled false: no extend tool, no grace — the workflow times out at its budget", async () => {
    writeSettings({ extend: { enabled: false, notify: "background" } });
    const host = fakePi([]);
    activate(host.pi);
    await host.emit("session_start", { reason: "startup" });
    expect(host.tools.has("extend_subagent_timeout")).toBe(false);
    const started = await host.call("SubagentWorkflow", { script: HELD_SCRIPT });
    const id = started.details.workflowId as string;
    expect(started.content[0]!.text).not.toContain("extendable");
    await until(() => workflowNotices(host.sent).length > 0);
    expect(workflowNotices(host.sent)[0]!.message.details).toMatchObject({ workflowId: id, status: "timed_out" });
    expect(timeoutNotices(host.sent)).toHaveLength(0);
    expect(host.busEvents.some((e) => e.channel === "subagent:workflow:deadline")).toBe(false);
    await host.emit("session_shutdown", { reason: "quit" });
  }, 40_000);
});
