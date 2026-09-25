// merge-plan D5: drive the wired TaskCreate → TaskUpdate → TaskDelete chain
// through an inline fake ExtensionAPI (revision S7: no shared cross-package
// helper). Asserts the enqueue serialization, the appendEntry persist count,
// the persisted customType constant (D3), and the N5 TUI gate on the widget.

import { describe, expect, test } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { wireTodo } from "../../src/todo/index.js";
import { STATE_ENTRY, type TodoState } from "../../src/todo/state.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyTool = ToolDefinition<any, any, any>;

type ToolResult = { content: { type: string; text: string }[]; details?: any };

interface Host {
  pi: ExtensionAPI;
  tools: Map<string, AnyTool>;
  commands: Map<string, { description: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }>;
  handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
  appended: { customType: string; data: unknown }[];
  widgetCalls: { key: string; content: unknown }[];
  statuses: { key: string; text: string | undefined }[];
  notifications: string[];
}

function fakePi(): Host {
  const host: Host = {
    pi: undefined as unknown as ExtensionAPI,
    tools: new Map(),
    commands: new Map(),
    handlers: new Map(),
    appended: [],
    widgetCalls: [],
    statuses: [],
    notifications: [],
  };
  const pi = {
    registerTool: (def: AnyTool) => {
      host.tools.set(def.name, def);
    },
    registerCommand: (name: string, options: { description: string; handler: never }) => {
      host.commands.set(name, options as never);
    },
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      host.handlers.set(event, handler);
    },
    appendEntry: (customType: string, data?: unknown) => {
      host.appended.push({ customType, data });
    },
  };
  host.pi = pi as unknown as ExtensionAPI;
  return host;
}

function fakeCtx(host: Host, mode: "tui" | "rpc" = "tui", branch: unknown[] = []): ExtensionContext {
  const ctx = {
    mode,
    hasUI: mode === "tui",
    ui: {
      setStatus: (key: string, text: string | undefined) => host.statuses.push({ key, text }),
      setWidget: (key: string, content: unknown) => host.widgetCalls.push({ key, content }),
      notify: (message: string) => host.notifications.push(message),
      confirm: async () => true,
      custom: async (_factory: unknown) => undefined,
    },
    sessionManager: { getBranch: () => branch },
  };
  return ctx as unknown as ExtensionContext;
}

function tool(host: Host, name: string): AnyTool {
  const def = host.tools.get(name);
  if (!def) throw new Error(`tool ${name} not registered`);
  return def;
}

async function exec(host: Host, name: string, params: unknown, ctx: ExtensionContext): Promise<ToolResult> {
  return (await tool(host, name).execute("call-1", params, undefined, undefined, ctx)) as ToolResult;
}

describe("wireTodo tools", () => {
  test("registers the five Task* tools, /tasklist, and the session hooks", () => {
    const host = fakePi();
    wireTodo(host.pi);
    expect([...host.tools.keys()].sort()).toEqual(["TaskCreate", "TaskDelete", "TaskGet", "TaskList", "TaskUpdate"]);
    expect(host.commands.has("tasklist")).toBe(true);
    for (const event of ["session_start", "session_tree", "session_compact", "session_shutdown"]) {
      expect(host.handlers.has(event)).toBe(true);
    }
  });

  test("TaskCreate → TaskUpdate → TaskDelete chain with persist on each mutation", async () => {
    const host = fakePi();
    wireTodo(host.pi);
    const ctx = fakeCtx(host);
    // pi always fires session_start; restore() is also what installs the TUI
    // widget owner (N5), so widget assertions need it.
    await host.handlers.get("session_start")?.({}, ctx);

    const created = await exec(host, "TaskCreate", { subject: "A", description: "do A" }, ctx);
    expect(created.details.action).toBe("create");
    expect(created.details.task.id).toBe(1);
    expect(created.details.task.status).toBe("pending");
    expect(host.appended).toHaveLength(1);
    // D3: the persisted customType keeps the standalone plugin's string.
    expect(host.appended[0]?.customType).toBe(STATE_ENTRY);
    expect(host.appended[0]?.customType).toBe("claude-code-todo-state");

    const updated = await exec(host, "TaskUpdate", { taskId: "1", status: "in_progress" }, ctx);
    expect(updated.details.action).toBe("update");
    expect(updated.details.changed).toBe(true);
    expect(updated.details.task.status).toBe("in_progress");
    expect(host.appended).toHaveLength(2);

    const deleted = await exec(host, "TaskDelete", { taskId: "1" }, ctx);
    expect(deleted.details.action).toBe("delete");
    expect(deleted.details.task.subject).toBe("A");
    expect(deleted.details.state.tasks).toHaveLength(0);
    expect(host.appended).toHaveLength(3);
    // Widget cleared after the last task is deleted (tui ctx).
    expect(host.widgetCalls.at(-1)).toEqual({ key: "claude-code-todo", content: undefined });
  });

  test("TaskList / TaskGet are read-only (no persist)", async () => {
    const host = fakePi();
    wireTodo(host.pi);
    const ctx = fakeCtx(host);
    await exec(host, "TaskCreate", { subject: "A", description: "do A" }, ctx);
    expect(host.appended).toHaveLength(1);

    const list = await exec(host, "TaskList", {}, ctx);
    expect(list.content[0]?.text).toContain("#1");
    const got = await exec(host, "TaskGet", { taskId: "#1" }, ctx);
    expect(got.details.task.subject).toBe("A");
    expect(host.appended).toHaveLength(1);
  });

  test("no-op TaskUpdate does not persist (changed=false)", async () => {
    const host = fakePi();
    wireTodo(host.pi);
    const ctx = fakeCtx(host);
    await exec(host, "TaskCreate", { subject: "A", description: "do A" }, ctx);
    const unchanged = await exec(host, "TaskUpdate", { taskId: "1", status: "pending" }, ctx);
    expect(unchanged.details.changed).toBe(false);
    expect(host.appended).toHaveLength(1);
  });

  test("enqueue serializes concurrent executes", async () => {
    const host = fakePi();
    wireTodo(host.pi);
    const ctx = fakeCtx(host);
    // If execute() were not serialized through the queue, both creates would
    // read the same state (nextId 1) and produce colliding ids / a lost task.
    const [first, second] = await Promise.all([
      exec(host, "TaskCreate", { subject: "A", description: "do A" }, ctx),
      exec(host, "TaskCreate", { subject: "B", description: "do B" }, ctx),
    ]);
    expect(first.details.task.id).toBe(1);
    expect(second.details.task.id).toBe(2);
    expect(second.details.state.tasks).toHaveLength(2);
    expect(host.appended).toHaveLength(2);
    // Each persist carries a full snapshot; the second one sees both tasks.
    const snapshots = host.appended.map((entry) => (entry.data as TodoState).tasks.length);
    expect(snapshots).toEqual([1, 2]);
  });

  test("tool errors propagate without corrupting the queue", async () => {
    const host = fakePi();
    wireTodo(host.pi);
    const ctx = fakeCtx(host);
    await exec(host, "TaskCreate", { subject: "A", description: "do A" }, ctx);
    await expect(exec(host, "TaskUpdate", { taskId: "1" }, ctx)).rejects.toThrow(
      "TaskUpdate requires at least one field to change",
    );
    await expect(exec(host, "TaskGet", { taskId: "99" }, ctx)).rejects.toThrow("Task #99 not found");
    // Queue survived the rejections: a follow-up mutation still runs.
    const created = await exec(host, "TaskCreate", { subject: "B", description: "do B" }, ctx);
    expect(created.details.task.id).toBe(2);
  });

  test("session_start restores state from branch entries (custom + toolResult shapes)", async () => {
    const host = fakePi();
    wireTodo(host.pi);
    const ctx = fakeCtx(host);
    await exec(host, "TaskCreate", { subject: "A", description: "do A" }, ctx);
    await exec(host, "TaskUpdate", { taskId: "1", status: "completed" }, ctx);
    const persisted = host.appended.at(-1)?.data;

    // A fresh wireTodo (new session) replays the branch handed to restore().
    const host2 = fakePi();
    wireTodo(host2.pi);
    // A stale toolResult snapshot BEFORE the custom entry must lose to it
    // (interleaved shapes: the last valid candidate wins).
    const branch = [
      {
        type: "message",
        message: { role: "toolResult", isError: false, details: { state: { tasks: [], nextId: 1 } } },
      },
      { type: "custom", customType: STATE_ENTRY, data: persisted },
    ];
    const ctx2 = fakeCtx(host2, "tui", branch);
    await host2.handlers.get("session_start")?.({}, ctx2);
    const list = await exec(host2, "TaskList", {}, ctx2);
    expect(list.content[0]?.text).toContain("#1");
    expect(list.content[0]?.text).toContain("completed");
  });

  test("N5: widget stays sealed in rpc sessions, opens in tui", async () => {
    const host = fakePi();
    wireTodo(host.pi);
    // rpc (child session) restore: setStatus still runs, setWidget never does.
    const rpcCtx = fakeCtx(host, "rpc");
    await host.handlers.get("session_start")?.({}, rpcCtx);
    expect(host.statuses).toEqual([{ key: "claude-code-todo-status", text: undefined }]);
    await exec(host, "TaskCreate", { subject: "A", description: "do A" }, rpcCtx);
    expect(host.widgetCalls).toHaveLength(0);

    // tui restore: widget is set once tasks exist.
    const tuiCtx = fakeCtx(host, "tui");
    await host.handlers.get("session_start")?.({}, tuiCtx);
    await exec(host, "TaskCreate", { subject: "B", description: "do B" }, tuiCtx);
    expect(host.widgetCalls.some((call) => call.key === "claude-code-todo" && call.content !== undefined)).toBe(true);
  });

  test("/tasklist clear empties the list and persists", async () => {
    const host = fakePi();
    wireTodo(host.pi);
    const ctx = fakeCtx(host);
    await exec(host, "TaskCreate", { subject: "A", description: "do A" }, ctx);
    expect(host.appended).toHaveLength(1);

    const command = host.commands.get("tasklist");
    await command?.handler("clear", ctx);
    expect(host.appended).toHaveLength(2);
    expect((host.appended.at(-1)?.data as TodoState).tasks).toHaveLength(0);
    expect(host.notifications).toContain("Task list cleared.");

    const list = await exec(host, "TaskList", {}, ctx);
    expect(list.content[0]?.text).toBe("No tasks.");
  });
});
