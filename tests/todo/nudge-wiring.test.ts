// Wiring tests for the main-session todo staleness nudge (L1 feature):
// event-hook gating (child session / disabled setting → zero new
// registrations), the hidden nudge message shape, git-command E2 detection,
// counter reset on Task* touch, and the switch_context tracker port.
//
// Harness pattern follows tests/todo/tools.test.ts (inline fake
// ExtensionAPI, no shared cross-package helper — merge-plan revision S7).

import { describe, expect, test, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { TODO_NUDGE_CUSTOM_TYPE, wireTodo } from "../../src/todo/index.js";
import { WORKFLOW_NOTIFICATION_TYPE } from "../../src/adapters/workflow-notice.js";
import { BASH_JOB_NOTIFICATION_TYPE } from "../../src/stack.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyTool = ToolDefinition<any, any, any>;
type ToolResult = { content: { type: string; text: string }[]; details?: any };

interface SentMessage {
  message: { customType: string; content: string; display: boolean; details?: unknown };
  options: { triggerTurn: false };
}

interface Host {
  pi: ExtensionAPI;
  tools: Map<string, AnyTool>;
  commands: Map<string, unknown>;
  handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
  sent: SentMessage[];
}

function fakePi(): Host {
  const host: Host = {
    pi: undefined as unknown as ExtensionAPI,
    tools: new Map(),
    commands: new Map(),
    handlers: new Map(),
    sent: [],
  };
  const pi = {
    registerTool: (def: AnyTool) => host.tools.set(def.name, def),
    registerCommand: (name: string, options: unknown) => host.commands.set(name, options),
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
      host.handlers.set(event, handler),
    appendEntry: () => undefined,
    sendMessage: (message: SentMessage["message"], options: SentMessage["options"]) =>
      host.sent.push({ message, options }),
  };
  host.pi = pi as unknown as ExtensionAPI;
  return host;
}

function fakeCtx(mode: "tui" | "rpc" = "tui"): ExtensionContext {
  return {
    mode,
    hasUI: mode === "tui",
    ui: { setStatus: () => undefined, setWidget: () => undefined, notify: () => undefined },
    sessionManager: { getBranch: () => [] },
  } as unknown as ExtensionContext;
}

async function exec(host: Host, name: string, params: unknown, ctx: ExtensionContext): Promise<ToolResult> {
  const def = host.tools.get(name);
  if (!def) throw new Error(`tool ${name} not registered`);
  return (await def.execute("call-1", params, undefined, undefined, ctx)) as ToolResult;
}

function turnEnd(host: Host): void {
  host.handlers.get("turn_end")?.({}, fakeCtx());
}

function toolStart(host: Host, toolCallId: string, toolName: string, args: unknown): void {
  host.handlers.get("tool_execution_start")?.({ toolCallId, toolName, args }, fakeCtx());
}

function toolEnd(host: Host, toolCallId: string, toolName: string, isError: boolean, result?: unknown): void {
  host.handlers.get("tool_execution_end")?.({ toolCallId, toolName, isError, result }, fakeCtx());
}

function messageStart(host: Host, customType: string): void {
  host.handlers.get("message_start")?.({ message: { role: "custom", customType } }, fakeCtx());
}

const NUDGE = { enabled: true, graceTurns: 2, fallbackTurns: 20, cooldownTurns: 8 };

async function makeInProgressTask(host: Host, ctx: ExtensionContext, subject = "Do the thing"): Promise<void> {
  await exec(host, "TaskCreate", { subject, description: "d" }, ctx);
  await exec(host, "TaskUpdate", { taskId: "1", status: "in_progress" }, ctx);
}

describe("todo/index wireTodo: nudge gating", () => {
  test("no opts at all (existing callers): zero new handlers, behavior unchanged", () => {
    const host = fakePi();
    const result = wireTodo(host.pi);
    expect(host.handlers.has("turn_end")).toBe(false);
    expect(host.handlers.has("tool_execution_start")).toBe(false);
    expect(host.handlers.has("tool_execution_end")).toBe(false);
    expect(host.handlers.has("message_start")).toBe(false);
    expect(result.getTrackerSnapshot).toBeUndefined();
  });

  test("child session: zero new handlers even with nudge.enabled=true", () => {
    const host = fakePi();
    const result = wireTodo(host.pi, { isChildSession: true, nudge: NUDGE, sendMessage: host.pi.sendMessage });
    expect(host.handlers.has("turn_end")).toBe(false);
    expect(host.handlers.has("message_start")).toBe(false);
    expect(result.getTrackerSnapshot).toBeUndefined();
  });

  test("nudge.enabled=false: zero new handlers even in the main session", () => {
    const host = fakePi();
    const result = wireTodo(host.pi, {
      isChildSession: false,
      nudge: { ...NUDGE, enabled: false },
      sendMessage: host.pi.sendMessage,
    });
    expect(host.handlers.has("turn_end")).toBe(false);
    expect(result.getTrackerSnapshot).toBeUndefined();
  });

  test("main session + nudge.enabled=true: the four extra handlers register, plus the tracker port", () => {
    const host = fakePi();
    const result = wireTodo(host.pi, { isChildSession: false, nudge: NUDGE, sendMessage: host.pi.sendMessage });
    for (const event of ["turn_end", "tool_execution_start", "tool_execution_end", "message_start"]) {
      expect(host.handlers.has(event), event).toBe(true);
    }
    expect(result.getTrackerSnapshot).toBeTypeOf("function");
  });
});

describe("todo/index wireTodo: nudge firing", () => {
  test("fires a hidden, non-turn-triggering message after fallbackTurns turns with no evidence", async () => {
    const host = fakePi();
    wireTodo(host.pi, { isChildSession: false, nudge: NUDGE, sendMessage: host.pi.sendMessage });
    const ctx = fakeCtx();
    await makeInProgressTask(host, ctx);

    for (let i = 0; i < NUDGE.fallbackTurns - 1; i++) turnEnd(host);
    expect(host.sent).toHaveLength(0);
    turnEnd(host);
    expect(host.sent).toHaveLength(1);

    const sent = host.sent[0]!;
    expect(sent.message.customType).toBe(TODO_NUDGE_CUSTOM_TYPE);
    expect(sent.message.display).toBe(false);
    expect(sent.options.triggerTurn).toBe(false);
    expect(sent.message.content).toContain("#1 Do the thing");
    expect(sent.message.content).toContain(`已过 ${NUDGE.fallbackTurns} 轮`);
  });

  test("never fires with only pending tasks (no in_progress)", async () => {
    const host = fakePi();
    wireTodo(host.pi, { isChildSession: false, nudge: NUDGE, sendMessage: host.pi.sendMessage });
    const ctx = fakeCtx();
    await exec(host, "TaskCreate", { subject: "Pending only", description: "d" }, ctx);

    for (let i = 0; i < NUDGE.fallbackTurns + 5; i++) turnEnd(host);
    expect(host.sent).toHaveLength(0);
  });

  test("any Task* call (including read-only List/Get) resets the counters and postpones the fallback fire", async () => {
    const host = fakePi();
    wireTodo(host.pi, { isChildSession: false, nudge: NUDGE, sendMessage: host.pi.sendMessage });
    const ctx = fakeCtx();
    await makeInProgressTask(host, ctx);

    for (let i = 0; i < NUDGE.fallbackTurns - 1; i++) turnEnd(host);
    expect(host.sent).toHaveLength(0);
    // A read-only touch one tick before the threshold resets e3 to 0 —
    // without it the very next tick below would have fired.
    await exec(host, "TaskList", {}, ctx);

    for (let i = 0; i < NUDGE.fallbackTurns - 1; i++) turnEnd(host);
    expect(host.sent).toHaveLength(0);
    turnEnd(host);
    expect(host.sent).toHaveLength(1);
  });

  test("E1: a subagent/workflow/bash-job completion notification counts as evidence and fires after graceTurns", async () => {
    const host = fakePi();
    wireTodo(host.pi, { isChildSession: false, nudge: NUDGE, sendMessage: host.pi.sendMessage });
    const ctx = fakeCtx();
    await makeInProgressTask(host, ctx);

    messageStart(host, "subagent:notification");
    for (let i = 0; i < NUDGE.graceTurns - 1; i++) turnEnd(host);
    expect(host.sent).toHaveLength(0);
    turnEnd(host);
    expect(host.sent).toHaveLength(1);
    expect(host.sent[0]?.message.content).toContain("1 个子 agent/workflow 完成");
  });

  test("E1 also recognizes the workflow-notification and bash-job:notification customTypes", async () => {
    for (const customType of [WORKFLOW_NOTIFICATION_TYPE, BASH_JOB_NOTIFICATION_TYPE]) {
      const host = fakePi();
      wireTodo(host.pi, { isChildSession: false, nudge: NUDGE, sendMessage: host.pi.sendMessage });
      const ctx = fakeCtx();
      await makeInProgressTask(host, ctx);
      messageStart(host, customType);
      for (let i = 0; i < NUDGE.graceTurns; i++) turnEnd(host);
      expect(host.sent, customType).toHaveLength(1);
    }
  });

  test("E2: a successful git write bash command counts as evidence and fires after graceTurns", async () => {
    const host = fakePi();
    wireTodo(host.pi, { isChildSession: false, nudge: NUDGE, sendMessage: host.pi.sendMessage });
    const ctx = fakeCtx();
    await makeInProgressTask(host, ctx);

    toolStart(host, "call-1", "bash", { command: "git commit -m wip" });
    toolEnd(host, "call-1", "bash", false);
    for (let i = 0; i < NUDGE.graceTurns - 1; i++) turnEnd(host);
    expect(host.sent).toHaveLength(0);
    turnEnd(host);
    expect(host.sent).toHaveLength(1);
    expect(host.sent[0]?.message.content).toContain("1 次 git 提交");
  });

  test("a failed git commit (isError) does not count as E2 evidence", async () => {
    const host = fakePi();
    wireTodo(host.pi, { isChildSession: false, nudge: NUDGE, sendMessage: host.pi.sendMessage });
    const ctx = fakeCtx();
    await makeInProgressTask(host, ctx);

    toolStart(host, "call-1", "bash", { command: "git commit -m wip" });
    toolEnd(host, "call-1", "bash", true); // exit code != 0

    // No evidence, so only the (much later) fallback trigger can fire.
    for (let i = 0; i < NUDGE.graceTurns; i++) turnEnd(host);
    expect(host.sent).toHaveLength(0);
    for (let i = 0; i < NUDGE.fallbackTurns - NUDGE.graceTurns; i++) turnEnd(host);
    expect(host.sent).toHaveLength(1); // fired via fallback, proving E2 was never counted
  });

  test("a backgrounded git write (details.background) does not count as E2 on its early return", async () => {
    const host = fakePi();
    wireTodo(host.pi, { isChildSession: false, nudge: NUDGE, sendMessage: host.pi.sendMessage });
    const ctx = fakeCtx();
    await makeInProgressTask(host, ctx);

    toolStart(host, "call-1", "bash", { command: "git commit -m wip" });
    toolEnd(host, "call-1", "bash", false, { content: [], details: { jobId: "j1", background: true } });

    for (let i = 0; i < NUDGE.graceTurns; i++) turnEnd(host);
    expect(host.sent).toHaveLength(0);
    for (let i = 0; i < NUDGE.fallbackTurns - NUDGE.graceTurns; i++) turnEnd(host);
    expect(host.sent).toHaveLength(1); // only the fallback fired: E2 was never scored
  });

  test("a read-only git command (git log) does not count as E2 evidence", async () => {
    const host = fakePi();
    wireTodo(host.pi, { isChildSession: false, nudge: NUDGE, sendMessage: host.pi.sendMessage });
    const ctx = fakeCtx();
    await makeInProgressTask(host, ctx);

    toolStart(host, "call-1", "bash", { command: "git log --oneline" });
    toolEnd(host, "call-1", "bash", false);

    for (let i = 0; i < NUDGE.graceTurns; i++) turnEnd(host);
    expect(host.sent).toHaveLength(0);
    for (let i = 0; i < NUDGE.fallbackTurns - NUDGE.graceTurns; i++) turnEnd(host);
    expect(host.sent).toHaveLength(1); // fallback, not evidence
  });

  test("a non-bash tool_execution_end is ignored even if its result carries a git-looking command", async () => {
    const host = fakePi();
    wireTodo(host.pi, { isChildSession: false, nudge: NUDGE, sendMessage: host.pi.sendMessage });
    const ctx = fakeCtx();
    await makeInProgressTask(host, ctx);

    toolStart(host, "call-1", "some_other_tool", { command: "git commit -m wip" });
    toolEnd(host, "call-1", "some_other_tool", false);
    for (let i = 0; i < NUDGE.graceTurns; i++) turnEnd(host);
    expect(host.sent).toHaveLength(0);
  });
});

describe("todo/index wireTodo: switch_context tracker port", () => {
  test("reflects live openTaskCount / turnsSinceTouch / hasEvidence", async () => {
    const host = fakePi();
    const { getTrackerSnapshot } = wireTodo(host.pi, {
      isChildSession: false,
      nudge: NUDGE,
      sendMessage: host.pi.sendMessage,
    });
    const ctx = fakeCtx();
    expect(getTrackerSnapshot!()).toEqual({ openTaskCount: 0, turnsSinceTouch: 0, hasEvidence: false });

    await makeInProgressTask(host, ctx);
    expect(getTrackerSnapshot!().openTaskCount).toBe(1);

    turnEnd(host);
    turnEnd(host);
    expect(getTrackerSnapshot!().turnsSinceTouch).toBe(2);

    messageStart(host, "subagent:notification");
    expect(getTrackerSnapshot!().hasEvidence).toBe(true);
  });

  test("completed tasks do not count toward openTaskCount", async () => {
    const host = fakePi();
    const { getTrackerSnapshot } = wireTodo(host.pi, {
      isChildSession: false,
      nudge: NUDGE,
      sendMessage: host.pi.sendMessage,
    });
    const ctx = fakeCtx();
    await exec(host, "TaskCreate", { subject: "A", description: "d" }, ctx);
    await exec(host, "TaskUpdate", { taskId: "1", status: "completed" }, ctx);
    expect(getTrackerSnapshot!().openTaskCount).toBe(0);
  });
});

describe("todo/index wireTodo: send failures are swallowed", () => {
  test("a throwing sendMessage does not crash turn_end", async () => {
    const host = fakePi();
    const throwingSend = vi.fn(() => {
      throw new Error("boom");
    });
    wireTodo(host.pi, { isChildSession: false, nudge: NUDGE, sendMessage: throwingSend });
    const ctx = fakeCtx();
    await makeInProgressTask(host, ctx);
    for (let i = 0; i < NUDGE.fallbackTurns - 1; i++) turnEnd(host);
    expect(() => turnEnd(host)).not.toThrow();
    expect(throwingSend).toHaveBeenCalledOnce();
  });
});
