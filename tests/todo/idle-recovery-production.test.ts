// Production wiring guard: B2 exists but wireTodo must not instantiate it or wake a session.
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { wireTodo } from "../../src/todo/index.js";
import { createIdleRecoveryHost } from "../../src/todo/idle-recovery-host.js";
import { createIdleRecoveryRunner } from "../../src/todo/idle-recovery-runner.js";
import { createIdleRecoveryStore } from "../../src/todo/idle-recovery-store.js";
import { selectRecoveryCandidates } from "../../src/todo/idle-recovery.js";

vi.mock("../../src/todo/idle-recovery-host.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/todo/idle-recovery-host.js")>();
  return { ...actual, createIdleRecoveryHost: vi.fn(actual.createIdleRecoveryHost) };
});
vi.mock("../../src/todo/idle-recovery-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/todo/idle-recovery-runner.js")>();
  return { ...actual, createIdleRecoveryRunner: vi.fn(actual.createIdleRecoveryRunner) };
});

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyTool = ToolDefinition<any, any, any>;

describe("production todo topology", () => {
  it("does not register or automatically wake idle recovery", async () => {
    vi.mocked(createIdleRecoveryHost).mockClear();
    vi.mocked(createIdleRecoveryRunner).mockClear();
    const tools = new Map<string, AnyTool>();
    const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
    const entries: { type: string; customType: string; data: unknown }[] = [];
    const send = vi.fn();
    const pi = {
      registerTool: (tool: AnyTool) => tools.set(tool.name, tool),
      registerCommand: () => undefined,
      on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
        const existing = handlers.get(name) ?? [];
        existing.push(handler);
        handlers.set(name, existing);
      },
      appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
      sendMessage: send,
    } as unknown as ExtensionAPI;
    const ctx = {
      mode: "tui",
      hasUI: true,
      isIdle: () => true,
      hasPendingMessages: () => false,
      ui: { setStatus: () => undefined, setWidget: () => undefined, notify: () => undefined },
      sessionManager: { getBranch: () => entries, getEntries: () => entries },
    } as unknown as ExtensionContext;
    const wire = wireTodo(pi, { isChildSession: false, nudge: { enabled: true }, sendMessage: send });
    for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, ctx);
    await tools
      .get("TaskCreate")!
      .execute("1", { subject: "authorized work", description: "continue" }, undefined, undefined, ctx);
    await tools.get("TaskUpdate")!.execute("2", { taskId: "1", status: "in_progress" }, undefined, undefined, ctx);
    expect(wire.getTodoSnapshot().tasks).toMatchObject([{ id: 1, status: "in_progress" }]);
    expect(selectRecoveryCandidates(wire.getTodoSnapshot(), { owner: "root" }).map((c) => c.taskId)).toEqual([1]);

    // No running agent/workflow/bash exists in this isolated host. No recovery busy ports
    // are injected: this is the actual production wireTodo API, not a synthetic B2 host.
    for (const handler of handlers.get("agent_settled") ?? [])
      await handler({ type: "agent_settled", aborted: false }, ctx);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(createIdleRecoveryHost).not.toHaveBeenCalled();
    expect(createIdleRecoveryRunner).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(entries.filter((entry) => entry.customType.startsWith("subagent:todo-idle-recovery"))).toEqual([]);

    // Production has no runner status to inspect. Separately exercise the real runner's
    // capability gate with the same entries and no AgentSession.subscribe (not a wired host).
    const store = createIdleRecoveryStore({
      sessionId: "s",
      owner: "root",
      getEntries: () => entries,
      appendCustomEntry: pi.appendEntry,
    });
    const runner = createIdleRecoveryRunner({
      enabled: true,
      sid: "s",
      owner: "root",
      store,
      getEntries: () => entries,
      appendCustomEntry: pi.appendEntry,
      readHostSnapshot: () => {
        throw new Error("off runner must not read host");
      },
      sendMessage: send,
      abort: vi.fn(),
    });
    runner.onSettled({ type: "agent_settled", aborted: false });
    expect(runner.effective).toBe(false);
    expect(runner.offReason).toBe("root-session-subscription-unavailable");
    expect(store.view().totalAttempts).toBe(0);
    expect(store.view().attemptsInWindow).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(entries.filter((entry) => entry.customType.startsWith("subagent:todo-idle-recovery"))).toEqual([]);
    runner.dispose();
  });
});
