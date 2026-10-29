// merge-plan D5: drive the wired TaskCreate → TaskUpdate → TaskDelete chain
// through an inline fake ExtensionAPI (revision S7: no shared cross-package
// helper). Asserts the enqueue serialization, the appendEntry persist count,
// the persisted customType constant (D3), and the N5 TUI gate on the widget.

import { describe, expect, test } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { wireTodo } from "../../src/todo/index.js";
import { replayState, STATE_ENTRY, type TodoState } from "../../src/todo/state.js";

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

/** Branch view over the given appended entries — the replay source for restore(). */
function toBranch(entries: { customType: string; data: unknown }[]): unknown[] {
  return entries.map(({ customType, data }) => ({ type: "custom", customType, data }));
}

/** Branch view over everything persist() appended so far — the replay source for restore(). */
function branchOf(host: Host): unknown[] {
  return toBranch(host.appended);
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
    // Quick win ① (todo-archive-split §2.3): details no longer embed the state snapshot;
    // the task count is asserted through the replay path instead.
    expect(deleted.details.state).toBeUndefined();
    expect(replayState(branchOf(host))?.tasks).toHaveLength(0);
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
    // Quick win ①: no embedded state; the task count comes from the persisted snapshots.
    expect(second.details.state).toBeUndefined();
    expect(host.appended).toHaveLength(2);
    // Each persist carries a full snapshot; the second one sees both tasks.
    const snapshots = host.appended
      .filter((entry) => entry.customType === STATE_ENTRY)
      .map((entry) => (entry.data as TodoState).tasks.length);
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
    const list = await exec(host2, "TaskList", { includeCompleted: true }, ctx2);
    expect(list.content[0]?.text).toContain("#1");
    expect(list.content[0]?.text).toContain("completed");
    // Default (collapsed) output hides the completed task behind the footer.
    const collapsed = await exec(host2, "TaskList", {}, ctx2);
    expect(collapsed.content[0]?.text).not.toContain("#1 pending");
    expect(collapsed.content[0]?.text).toContain("Completed: 1 hidden");
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

  // plan §4.9 point 6 / D22 (package C12): a web-hub-claimed `/tasklist` (no
  // args) must fall back to the text listing — never the TUI-only custom
  // overlay — and must never become the long-lived widget host, since
  // `currentUI` is shared by every *other* future `refreshWidget()` call
  // (TaskCreate/TaskUpdate/session_start), not just this one invocation.
  test("web-invoked /tasklist (no args) falls back to formatTaskList text and never becomes the widget host", async () => {
    const host = fakePi();
    wireTodo(host.pi);
    const tuiCtx = fakeCtx(host, "tui");
    await host.handlers.get("session_start")?.({}, tuiCtx);
    await exec(host, "TaskCreate", { subject: "A", description: "do A" }, tuiCtx);
    host.notifications.length = 0;
    host.widgetCalls.length = 0;

    const webWidgetCalls: unknown[] = [];
    const webCtx = {
      ...(tuiCtx as unknown as Record<string, unknown>),
      webInvocation: true,
      ui: {
        ...(tuiCtx as unknown as { ui: Record<string, unknown> }).ui,
        setWidget: (key: string, content: unknown) => webWidgetCalls.push({ key, content }),
      },
    } as unknown as ExtensionContext;

    const command = host.commands.get("tasklist");
    await command?.handler("", webCtx);

    // Text fallback (formatTaskList via notify), never the custom overlay.
    expect(host.notifications.some((n) => n.includes("do A"))).toBe(true);
    expect(webWidgetCalls).toHaveLength(0);

    // `currentUI` must not have been swapped to the web ctx's ui: force the
    // widget to unmount (`/tasklist clear` on the REAL tui ctx) and confirm
    // that `ui.setWidget(WIDGET_KEY, undefined)` call still lands on the
    // terminal ctx's setWidget, not the (now-defunct) web one.
    host.widgetCalls.length = 0;
    await command?.handler("clear", tuiCtx);
    expect(host.widgetCalls.some((c) => c.key === "claude-code-todo" && c.content === undefined)).toBe(true);
    expect(webWidgetCalls).toHaveLength(0);
  });

  test("TaskUpdate reports Unblocked in the tool text and notifies via ctx.ui when completing a task unblocks another", async () => {
    const host = fakePi();
    wireTodo(host.pi);
    const ctx = fakeCtx(host);
    await host.handlers.get("session_start")?.({}, ctx);
    await exec(host, "TaskCreate", { subject: "A", description: "A" }, ctx);
    await exec(host, "TaskCreate", { subject: "B", description: "B", blockedBy: ["1"] }, ctx);

    // Before completion, the list still shows #2 as blocked (regression guard
    // for the bug this task fixed: display must reflect predecessor status).
    const before = await exec(host, "TaskList", {}, ctx);
    expect(before.content[0]?.text).toContain("blocked by #1");

    host.notifications.length = 0;
    const completed = await exec(host, "TaskUpdate", { taskId: "1", status: "completed" }, ctx);
    expect(completed.content[0]?.text).toContain("Unblocked: #2 B");
    expect(completed.details.unblocked?.map((task: { id: number }) => task.id)).toEqual([2]);
    expect(host.notifications.some((message) => message.includes("#2") && message.includes("B"))).toBe(true);

    // Fixed: the list no longer shows #2 as blocked once #1 is completed.
    const after = await exec(host, "TaskList", {}, ctx);
    expect(after.content[0]?.text).not.toContain("blocked by");
  });

  test("TaskUpdate does not report Unblocked when other predecessors remain incomplete", async () => {
    const host = fakePi();
    wireTodo(host.pi);
    const ctx = fakeCtx(host);
    await exec(host, "TaskCreate", { subject: "A", description: "A" }, ctx);
    await exec(host, "TaskCreate", { subject: "B", description: "B" }, ctx);
    await exec(host, "TaskCreate", { subject: "C", description: "C", blockedBy: ["1", "2"] }, ctx);

    const partial = await exec(host, "TaskUpdate", { taskId: "1", status: "completed" }, ctx);
    expect(partial.content[0]?.text).not.toContain("Unblocked");

    const rest = await exec(host, "TaskUpdate", { taskId: "2", status: "completed" }, ctx);
    expect(rest.content[0]?.text).toContain("Unblocked: #3 C");
  });

  test("TaskDelete reports and notifies Unblocked when deleting an incomplete predecessor frees a task", async () => {
    const host = fakePi();
    wireTodo(host.pi);
    const ctx = fakeCtx(host);
    await host.handlers.get("session_start")?.({}, ctx);
    await exec(host, "TaskCreate", { subject: "A", description: "A" }, ctx);
    await exec(host, "TaskCreate", { subject: "B", description: "B", blockedBy: ["1"] }, ctx);

    host.notifications.length = 0;
    const deleted = await exec(host, "TaskDelete", { taskId: "1" }, ctx);
    expect(deleted.content[0]?.text).toContain("Unblocked: #2 B");
    expect(host.notifications.some((message) => message.includes("#2"))).toBe(true);
  });

  test("no ctx.ui.notify in rpc/headless sessions even when a task is unblocked (must not throw)", async () => {
    const host = fakePi();
    wireTodo(host.pi);
    const rpcCtx = fakeCtx(host, "rpc");
    await exec(host, "TaskCreate", { subject: "A", description: "A" }, rpcCtx);
    await exec(host, "TaskCreate", { subject: "B", description: "B", blockedBy: ["1"] }, rpcCtx);

    const completed = await exec(host, "TaskUpdate", { taskId: "1", status: "completed" }, rpcCtx);
    expect(completed.content[0]?.text).toContain("Unblocked: #2 B");
    expect(host.notifications).toEqual([]);
  });
});

// ── todo-archive (plan §3): TaskList folding, auto-archive wiring, clear high-water ──

describe("wireTodo todo-archive", () => {
  describe("TaskList folding (D3)", () => {
    test("only open tasks ⇒ byte-identical to the pre-archive full output", async () => {
      const host = fakePi();
      wireTodo(host.pi, { archive: { onCompact: false, afterTurns: 0 } });
      const ctx = fakeCtx(host);
      await exec(host, "TaskCreate", { subject: "A", description: "do A" }, ctx);
      await exec(host, "TaskUpdate", { taskId: "1", status: "in_progress" }, ctx);
      await exec(host, "TaskCreate", { subject: "B", description: "do B" }, ctx);

      const list = await exec(host, "TaskList", {}, ctx);
      expect(list.content[0]?.text).toBe(`\u2733 #1 in_progress A\n  do A\n\u25cb #2 pending B\n  do B`);
    });

    test("hidden completed + archived tasks produce the footer (zero-count clauses omitted)", async () => {
      const host = fakePi();
      wireTodo(host.pi, { archive: { onCompact: true, afterTurns: 0 } });
      const ctx = fakeCtx(host);
      await exec(host, "TaskCreate", { subject: "A", description: "A" }, ctx);
      await exec(host, "TaskCreate", { subject: "B", description: "B" }, ctx);
      await exec(host, "TaskCreate", { subject: "C", description: "C" }, ctx);
      await exec(host, "TaskUpdate", { taskId: "2", status: "completed" }, ctx);
      await exec(host, "TaskUpdate", { taskId: "3", status: "completed" }, ctx);

      // Completed only: latest ids ascending, no Archived clause.
      const withOpen = await exec(host, "TaskList", {}, ctx);
      expect(withOpen.content[0]?.text).toBe(
        `\u25cb #1 pending A\n  A\nCompleted: 2 hidden (latest #2, #3; includeCompleted:true lists all)`,
      );

      // Archive #3 via the compaction sweep, then drop the last open task too.
      await host.handlers.get("session_compact")?.({}, fakeCtx(host, "tui", branchOf(host)));
      await exec(host, "TaskUpdate", { taskId: "1", status: "completed" }, ctx);
      const onlyDone = await exec(host, "TaskList", {}, ctx);
      expect(onlyDone.content[0]?.text).toBe(
        "No open tasks.\n" +
          "Completed: 1 hidden (latest #1; includeCompleted:true lists all) \u00b7 " +
          "Archived: 2 (TaskGet <id> still works)",
      );
    });

    test("footer caps the latest-id list at 3", async () => {
      const host = fakePi();
      wireTodo(host.pi, { archive: { onCompact: false, afterTurns: 0 } });
      const ctx = fakeCtx(host);
      for (const subject of ["A", "B", "C", "D", "E"]) {
        await exec(host, "TaskCreate", { subject, description: subject }, ctx);
      }
      for (const id of ["1", "2", "3", "4", "5"]) {
        await exec(host, "TaskUpdate", { taskId: id, status: "completed" }, ctx);
      }
      const list = await exec(host, "TaskList", {}, ctx);
      expect(list.content[0]?.text).toContain(
        "Completed: 5 hidden (latest #3, #4, #5; includeCompleted:true lists all)",
      );
    });

    test("no tasks at all still says 'No tasks.'", async () => {
      const host = fakePi();
      wireTodo(host.pi);
      const ctx = fakeCtx(host);
      const list = await exec(host, "TaskList", {}, ctx);
      expect(list.content[0]?.text).toBe("No tasks.");
    });

    test("includeCompleted:true restores the full output with [archived] markers; TaskGet still works", async () => {
      const host = fakePi();
      wireTodo(host.pi, { archive: { onCompact: true, afterTurns: 0 } });
      const ctx = fakeCtx(host);
      await exec(host, "TaskCreate", { subject: "A", description: "A" }, ctx);
      await exec(host, "TaskCreate", { subject: "B", description: "B" }, ctx);
      await exec(host, "TaskUpdate", { taskId: "1", status: "completed" }, ctx);
      await host.handlers.get("session_compact")?.({}, fakeCtx(host, "tui", branchOf(host)));

      const full = await exec(host, "TaskList", { includeCompleted: true }, ctx);
      const text = full.content[0]?.text ?? "";
      expect(text).toBe(`\u25cb #2 pending B\n  B\n\u2713 #1 completed A [archived]\n  A`);
      expect(text).not.toContain("Completed:"); // no footer in full mode

      const got = await exec(host, "TaskGet", { taskId: "1" }, ctx);
      expect(got.content[0]?.text).toContain("#1 completed A");
      expect(got.content[0]?.text).toContain("[archived]");
    });

    test("an archived completed predecessor does not block successors in the default list", async () => {
      const host = fakePi();
      wireTodo(host.pi, { archive: { onCompact: true, afterTurns: 0 } });
      const ctx = fakeCtx(host);
      await exec(host, "TaskCreate", { subject: "A", description: "A" }, ctx);
      await exec(host, "TaskCreate", { subject: "B", description: "B", blockedBy: ["1"] }, ctx);
      await exec(host, "TaskUpdate", { taskId: "1", status: "completed" }, ctx);
      await host.handlers.get("session_compact")?.({}, fakeCtx(host, "tui", branchOf(host)));

      // Pre-fix bug shape: partitioned subset would make #1 look blocking again.
      const list = await exec(host, "TaskList", {}, ctx);
      expect(list.content[0]?.text).not.toContain("blocked by");
      const full = await exec(host, "TaskList", { includeCompleted: true }, ctx);
      expect(full.content[0]?.text).not.toContain("blocked by");
    });
  });

  describe("compaction sweep (D1a/D8)", () => {
    test("session_compact archives all completed tasks after restore, persisting exactly once", async () => {
      const host = fakePi();
      wireTodo(host.pi, { archive: { onCompact: true, afterTurns: 0 } });
      const ctx = fakeCtx(host);
      await exec(host, "TaskCreate", { subject: "A", description: "A" }, ctx);
      await exec(host, "TaskCreate", { subject: "B", description: "B" }, ctx);
      await exec(host, "TaskUpdate", { taskId: "1", status: "completed" }, ctx);
      expect(host.appended).toHaveLength(3);

      await host.handlers.get("session_compact")?.({}, fakeCtx(host, "tui", branchOf(host)));
      expect(host.appended).toHaveLength(4); // ONE archive snapshot
      const swept = host.appended.at(-1)?.data as TodoState;
      expect(swept.tasks[0]?.archivedAt).toBeDefined();
      expect(swept.tasks[1]?.archivedAt).toBeUndefined(); // #2 still open
      expect(swept.tasks[0]?.completedAt).toBeDefined();

      // Nothing new to archive ⇒ no further write.
      await host.handlers.get("session_compact")?.({}, fakeCtx(host, "tui", branchOf(host)));
      expect(host.appended).toHaveLength(4);
    });

    test("onCompact:false restores without sweeping", async () => {
      const host = fakePi();
      wireTodo(host.pi, { archive: { onCompact: false, afterTurns: 0 } });
      const ctx = fakeCtx(host);
      await exec(host, "TaskCreate", { subject: "A", description: "A" }, ctx);
      await exec(host, "TaskUpdate", { taskId: "1", status: "completed" }, ctx);
      const before = host.appended.length;
      await host.handlers.get("session_compact")?.({}, fakeCtx(host, "tui", branchOf(host)));
      expect(host.appended).toHaveLength(before); // restore only, no sweep write
    });

    test("session_start and session_tree never sweep", async () => {
      const host = fakePi();
      wireTodo(host.pi, { archive: { onCompact: true, afterTurns: 0 } });
      const ctx = fakeCtx(host);
      await exec(host, "TaskCreate", { subject: "A", description: "A" }, ctx);
      await exec(host, "TaskUpdate", { taskId: "1", status: "completed" }, ctx);
      const before = host.appended.length;
      await host.handlers.get("session_start")?.({}, fakeCtx(host, "tui", branchOf(host)));
      await host.handlers.get("session_tree")?.({}, fakeCtx(host, "tui", branchOf(host)));
      expect(host.appended).toHaveLength(before);
    });
  });

  describe("per-turn archive ages (D1b/D8/commit)", () => {
    test("afterTurns=0 registers no turn_end handler", () => {
      const host = fakePi();
      wireTodo(host.pi, { archive: { onCompact: true, afterTurns: 0 } });
      expect(host.handlers.has("turn_end")).toBe(false);

      const hostNudge = fakePi();
      wireTodo(hostNudge.pi, { nudge: { enabled: true, graceTurns: 2, fallbackTurns: 20, cooldownTurns: 8 } });
      expect(hostNudge.handlers.has("turn_end")).toBe(true); // nudge only, archive defaults 30
    });

    test("archives on the Nth turn_end, batching everything due into ONE persist", async () => {
      const host = fakePi();
      wireTodo(host.pi, { archive: { onCompact: false, afterTurns: 2 } });
      const ctx = fakeCtx(host);
      await exec(host, "TaskCreate", { subject: "A", description: "A" }, ctx);
      await exec(host, "TaskUpdate", { taskId: "1", status: "completed" }, ctx);
      const before = host.appended.length;

      await host.handlers.get("turn_end")?.({});
      expect(host.appended).toHaveLength(before); // 1st turn_end: age 1 < 2
      await host.handlers.get("turn_end")?.({});
      expect(host.appended).toHaveLength(before + 1); // 2nd: age 2 ⇒ archived
      const snapshot = host.appended.at(-1)?.data as TodoState;
      expect(snapshot.tasks[0]?.archivedAt).toBeDefined();
      // Already archived ⇒ further turns never write again.
      await host.handlers.get("turn_end")?.({});
      await host.handlers.get("turn_end")?.({});
      expect(host.appended).toHaveLength(before + 1);
    });

    test("a same-turn reopen+recomplete before the Nth boundary restarts the age", async () => {
      const host = fakePi();
      wireTodo(host.pi, { archive: { onCompact: false, afterTurns: 2 } });
      const ctx = fakeCtx(host);
      await exec(host, "TaskCreate", { subject: "A", description: "A" }, ctx);
      await exec(host, "TaskUpdate", { taskId: "1", status: "completed" }, ctx);

      await host.handlers.get("turn_end")?.({}); // age 1
      // Turn 2: reopen then re-complete within the same turn.
      await exec(host, "TaskUpdate", { taskId: "1", status: "pending" }, ctx);
      await exec(host, "TaskUpdate", { taskId: "1", status: "completed" }, ctx);
      const before = host.appended.length;
      await host.handlers.get("turn_end")?.({}); // age since re-completion = 1 < 2
      expect(host.appended).toHaveLength(before);
      await host.handlers.get("turn_end")?.({}); // age 2 ⇒ archived
      expect(host.appended).toHaveLength(before + 1);
    });

    test("multiple tool calls in one turn all age from the same baseline", async () => {
      const host = fakePi();
      wireTodo(host.pi, { archive: { onCompact: false, afterTurns: 1 } });
      const ctx = fakeCtx(host);
      await exec(host, "TaskCreate", { subject: "A", description: "A" }, ctx);
      await exec(host, "TaskCreate", { subject: "B", description: "B" }, ctx);
      await exec(host, "TaskUpdate", { taskId: "1", status: "completed" }, ctx);
      await exec(host, "TaskUpdate", { taskId: "2", status: "completed" }, ctx);
      const before = host.appended.length;
      await host.handlers.get("turn_end")?.({});
      expect(host.appended).toHaveLength(before + 1); // both archived in one sweep
      const snapshot = host.appended.at(-1)?.data as TodoState;
      expect(snapshot.tasks.map((task) => task.archivedAt ?? 0).every((at) => at > 0)).toBe(true);
    });

    test("a queued reopen and a concurrent turn_end serialize in queue order — no false archive", async () => {
      const host = fakePi();
      wireTodo(host.pi, { archive: { onCompact: false, afterTurns: 1 } });
      const ctx = fakeCtx(host);
      await exec(host, "TaskCreate", { subject: "A", description: "A" }, ctx);
      await exec(host, "TaskUpdate", { taskId: "1", status: "completed" }, ctx);
      const before = host.appended.length;

      // The reopen is enqueued FIRST, the turn_end lands behind it in the same queue.
      const reopen = exec(host, "TaskUpdate", { taskId: "1", status: "pending" }, ctx);
      const turn = host.handlers.get("turn_end")?.({});
      await Promise.all([reopen, turn]);

      // Reopen ran before the sweeper looked at the state ⇒ nothing was archived.
      const snapshot = host.appended.at(-1)?.data as TodoState;
      expect(snapshot.tasks[0]?.status).toBe("pending");
      expect(snapshot.tasks[0]?.archivedAt).toBeUndefined();
      expect(snapshot.tasks[0]?.completedAt).toBeUndefined();
      expect(host.appended).toHaveLength(before + 1); // only the reopen's own persist
    });

    test("delete and archive clean the age map (no later ghost sweeps)", async () => {
      const host = fakePi();
      wireTodo(host.pi, { archive: { onCompact: false, afterTurns: 1 } });
      const ctx = fakeCtx(host);
      await exec(host, "TaskCreate", { subject: "A", description: "A" }, ctx);
      await exec(host, "TaskCreate", { subject: "B", description: "B" }, ctx);
      await exec(host, "TaskUpdate", { taskId: "2", status: "completed" }, ctx);
      await exec(host, "TaskDelete", { taskId: "2" }, ctx); // completed task deleted pre-age
      const before = host.appended.length;
      await host.handlers.get("turn_end")?.({});
      await host.handlers.get("turn_end")?.({});
      expect(host.appended).toHaveLength(before); // deleted id never sweeps

      await exec(host, "TaskUpdate", { taskId: "1", status: "completed" }, ctx);
      await host.handlers.get("turn_end")?.({});
      expect(host.appended).toHaveLength(before + 2); // update + archive sweep
      await host.handlers.get("turn_end")?.({});
      expect(host.appended).toHaveLength(before + 2); // archived id cleaned from the map
    });

    test("collapsed (not displayed) completed tasks age identically", async () => {
      const host = fakePi();
      wireTodo(host.pi, { archive: { onCompact: false, afterTurns: 1 } });
      const ctx = fakeCtx(host);
      for (const subject of ["A", "B", "C", "D"]) {
        await exec(host, "TaskCreate", { subject, description: subject }, ctx);
      }
      // Complete 3: only the 2 most recent are visible anywhere; #1 is fully collapsed.
      for (const id of ["1", "2", "3"]) {
        await exec(host, "TaskUpdate", { taskId: id, status: "completed" }, ctx);
      }
      const before = host.appended.length;
      await host.handlers.get("turn_end")?.({});
      expect(host.appended).toHaveLength(before + 1);
      const snapshot = host.appended.at(-1)?.data as TodoState;
      expect(snapshot.tasks.filter((task) => task.archivedAt !== undefined).map((task) => task.id)).toEqual([1, 2, 3]);
    });

    test("isChildSession:true with nudge off still archives per turn", async () => {
      const host = fakePi();
      wireTodo(host.pi, { isChildSession: true, archive: { onCompact: false, afterTurns: 1 } });
      expect(host.handlers.has("turn_end")).toBe(true);
      const ctx = fakeCtx(host);
      await exec(host, "TaskCreate", { subject: "A", description: "A" }, ctx);
      await exec(host, "TaskUpdate", { taskId: "1", status: "completed" }, ctx);
      const before = host.appended.length;
      await host.handlers.get("turn_end")?.({});
      expect(host.appended).toHaveLength(before + 1);
      expect((host.appended.at(-1)?.data as TodoState).tasks[0]?.archivedAt ?? 0).toBeGreaterThan(0);
    });
  });

  describe("/tasklist clear keeps the nextId high-water mark (D9)", () => {
    test("create → complete → archive → delete → clear → create gets a fresh id", async () => {
      const host = fakePi();
      wireTodo(host.pi, { archive: { onCompact: true, afterTurns: 0 } });
      const ctx = fakeCtx(host);
      await exec(host, "TaskCreate", { subject: "A", description: "A" }, ctx);
      await exec(host, "TaskCreate", { subject: "B", description: "B" }, ctx);
      await exec(host, "TaskUpdate", { taskId: "1", status: "completed" }, ctx);
      await host.handlers.get("session_compact")?.({}, fakeCtx(host, "tui", branchOf(host))); // archive #1
      await exec(host, "TaskDelete", { taskId: "2" }, ctx);

      const command = host.commands.get("tasklist");
      await command?.handler("clear", ctx);
      const cleared = host.appended.at(-1)?.data as TodoState;
      expect(cleared.tasks).toEqual([]);
      expect(cleared.nextId).toBe(3); // high-water preserved

      const created = await exec(host, "TaskCreate", { subject: "C", description: "C" }, ctx);
      expect(created.details.task.id).toBe(3);

      // Replay after clear: nextId survives the round trip.
      const host2 = fakePi();
      wireTodo(host2.pi);
      const ctx2 = fakeCtx(host2, "tui", branchOf(host));
      await host2.handlers.get("session_start")?.({}, ctx2);
      await host2.handlers.get("session_compact")?.({}, ctx2); // no-op sweep, but restore replays
      const again = await exec(host2, "TaskCreate", { subject: "D", description: "D" }, ctx2);
      expect(again.details.task.id).toBe(4); // #3 snapshot existed; nextId advanced past it
    });
  });

  describe("widget unmount (D7)", () => {
    test("a list of only archived tasks unmounts the widget", async () => {
      const host = fakePi();
      wireTodo(host.pi, { archive: { onCompact: true, afterTurns: 0 } });
      const ctx = fakeCtx(host);
      await host.handlers.get("session_start")?.({}, ctx);
      await exec(host, "TaskCreate", { subject: "A", description: "A" }, ctx);
      expect(host.widgetCalls.some((call) => call.key === "claude-code-todo" && call.content !== undefined)).toBe(true);

      await exec(host, "TaskUpdate", { taskId: "1", status: "completed" }, ctx);
      await host.handlers.get("session_compact")?.({}, fakeCtx(host, "tui", branchOf(host)));
      expect(host.widgetCalls.at(-1)).toEqual({ key: "claude-code-todo", content: undefined });
    });
  });
});

// ── todo-archive-split plan §7 (package 1, quick win ②): live-snapshot dedup ──
// persist() skips a write when the snapshot content is byte-identical to the last one
// written. The `liveKey` baseline lives in the wireTodo closure and is reset to undefined
// by restore() at every session boundary (session_start/session_tree/session_compact) —
// without that reset, a navigateTree rollback followed by re-deriving identical content
// would skip the write and resurrect deleted tasks on replay (review Major #2).

describe("wireTodo live-snapshot dedup (todo-archive-split quick win ②)", () => {
  test("byte-identical snapshots are not re-written (double /tasklist clear)", async () => {
    const host = fakePi();
    wireTodo(host.pi);
    const ctx = fakeCtx(host);
    const command = host.commands.get("tasklist");
    // Empty list: the first clear still writes (fresh baseline).
    await command?.handler("clear", ctx);
    expect(host.appended).toHaveLength(1);
    // Identical content {tasks:[],nextId:1} ⇒ the second clear writes nothing.
    await command?.handler("clear", ctx);
    expect(host.appended).toHaveLength(1);
    expect(replayState(branchOf(host))?.tasks).toHaveLength(0);
  });

  test("the first persist after a session boundary always writes (baseline reset)", async () => {
    const host = fakePi();
    wireTodo(host.pi);
    const ctx = fakeCtx(host);
    const command = host.commands.get("tasklist");
    await command?.handler("clear", ctx); // arms the dedup key
    await command?.handler("clear", ctx); // skipped
    expect(host.appended).toHaveLength(1);

    // restore() replays the very same empty snapshot but must reset the dedup key —
    // a persist of identical content afterwards has to write anyway.
    await host.handlers.get("session_start")?.({}, fakeCtx(host, "tui", branchOf(host)));
    await command?.handler("clear", ctx);
    expect(host.appended).toHaveLength(2);
  });

  test("regression (review Major #2): rollback to a leaf, re-delete writes — no resurrect on replay", async () => {
    const host = fakePi();
    wireTodo(host.pi);
    const ctx = fakeCtx(host);
    await exec(host, "TaskCreate", { subject: "A", description: "do A" }, ctx); // S1: #1 exists
    await exec(host, "TaskDelete", { taskId: "1" }, ctx); // S0: empty (content-equal to the re-delete below)
    expect(host.appended).toHaveLength(2);

    // navigateTree back to the leaf that still contains A: the branch is truncated to
    // [S1] and session_tree re-restores from it.
    const rolledBack = branchOf(host).slice(0, 1);
    await host.handlers.get("session_tree")?.({}, fakeCtx(host, "tui", rolledBack));
    // Sanity: the rollback leaf really restored A.
    const got = await exec(host, "TaskGet", { taskId: "1" }, ctx);
    expect(got.content[0]?.text).toContain("#1");

    // Deleting A again re-derives a snapshot byte-identical to S0. If the dedup key had
    // survived the rollback, this write would be skipped and the branch's last valid
    // candidate would stay S1 — replay would resurrect the deleted task.
    await exec(host, "TaskDelete", { taskId: "1" }, ctx);
    expect(host.appended).toHaveLength(3);

    // The post-rollback branch is [S1, S0'] — replay must see the deletion.
    const replayed = replayState(toBranch([host.appended[0]!, host.appended[2]!]));
    expect(replayed?.tasks).toHaveLength(0);
  });

  test("dedup never skips a changed snapshot (create/update/delete chain all write)", async () => {
    const host = fakePi();
    wireTodo(host.pi);
    const ctx = fakeCtx(host);
    await exec(host, "TaskCreate", { subject: "A", description: "do A" }, ctx);
    await exec(host, "TaskUpdate", { taskId: "1", status: "in_progress" }, ctx);
    await exec(host, "TaskCreate", { subject: "B", description: "do B" }, ctx);
    await exec(host, "TaskDelete", { taskId: "1" }, ctx);
    expect(host.appended).toHaveLength(4); // every persist saw different content
    expect(replayState(branchOf(host))?.tasks.map((task) => task.id)).toEqual([2]);
  });
});
