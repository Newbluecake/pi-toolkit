// todo-web plan §3.3/§7 (T1): `wireTodo`'s wire result unconditionally exposes
// `getTodoSnapshot()` — unlike `getTrackerSnapshot`, which only exists while the
// nudge tracker is armed. The getter must track every Task* mutation and the
// /tasklist clear, and must survive the session_start restore path.
import { describe, expect, test } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { wireTodo } from "../../src/todo/index.js";
import { STATE_ENTRY } from "../../src/todo/state.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyTool = ToolDefinition<any, any, any>;

interface Host {
  pi: ExtensionAPI;
  tools: Map<string, AnyTool>;
  commands: Map<string, { description: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }>;
  handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
  appended: { customType: string; data: unknown }[];
}

function fakePi(): Host {
  const host: Host = {
    pi: undefined as unknown as ExtensionAPI,
    tools: new Map(),
    commands: new Map(),
    handlers: new Map(),
    appended: [],
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

function fakeCtx(host: Host, mode: "tui" | "rpc" = "rpc", branch: unknown[] = []): ExtensionContext {
  const ctx = {
    mode,
    hasUI: mode === "tui",
    ui: {
      setStatus: () => undefined,
      setWidget: () => undefined,
      notify: () => undefined,
      confirm: async () => true,
      custom: async (_factory: unknown) => undefined,
    },
    sessionManager: { getBranch: () => branch },
  };
  return ctx as unknown as ExtensionContext;
}

async function exec(host: Host, name: string, params: unknown, ctx: ExtensionContext): Promise<unknown> {
  const def = host.tools.get(name);
  if (!def) throw new Error(`tool ${name} not registered`);
  return def.execute("call-1", params, undefined, undefined, ctx);
}

async function fire(host: Host, event: string, ctx: ExtensionContext): Promise<void> {
  const handler = host.handlers.get(event);
  if (!handler) throw new Error(`handler ${event} not registered`);
  await handler({ type: event }, ctx);
}

describe("wireTodo — getTodoSnapshot (todo-web T1)", () => {
  test("unconditional: present without any nudge config; getTrackerSnapshot still absent", () => {
    const host = fakePi();
    const result = wireTodo(host.pi);
    expect(typeof result.getTodoSnapshot).toBe("function");
    expect(result.getTrackerSnapshot).toBeUndefined();
  });

  test("present alongside getTrackerSnapshot when the nudge tracker is armed", () => {
    const host = fakePi();
    const result = wireTodo(host.pi, {
      isChildSession: false,
      nudge: { enabled: true },
      sendMessage: () => undefined,
    });
    expect(typeof result.getTodoSnapshot).toBe("function");
    expect(typeof result.getTrackerSnapshot).toBe("function");
  });

  test("tracks Task* mutations live: create → update → delete, then /tasklist clear", async () => {
    const host = fakePi();
    const result = wireTodo(host.pi);
    const ctx = fakeCtx(host);
    const snap = result.getTodoSnapshot;

    expect(snap()).toEqual({ tasks: [], nextId: 1 });

    await exec(host, "TaskCreate", { subject: "t1", description: "d1" }, ctx);
    expect(snap().tasks).toHaveLength(1);
    expect(snap().tasks[0]).toMatchObject({ id: 1, subject: "t1", description: "d1", status: "pending" });
    expect(snap().nextId).toBe(2);

    await exec(host, "TaskUpdate", { taskId: "1", status: "in_progress" }, ctx);
    expect(snap().tasks[0]!.status).toBe("in_progress");

    await exec(host, "TaskCreate", { subject: "t2", description: "d2" }, ctx);
    await exec(host, "TaskDelete", { taskId: "2" }, ctx);
    expect(snap().tasks.map((t) => t.id)).toEqual([1]);

    const clear = host.commands.get("tasklist")!;
    await clear.handler("clear", ctx);
    expect(snap()).toEqual({ tasks: [], nextId: 1 }); // emptyState() resets id numbering too
  });

  test("session_start restore replaces the closure state behind the same getter", async () => {
    const host = fakePi();
    const result = wireTodo(host.pi);
    const ctx = fakeCtx(host, "rpc", [
      {
        type: "custom",
        customType: STATE_ENTRY,
        data: {
          tasks: [
            {
              id: 7,
              subject: "restored",
              description: "from disk",
              status: "pending",
              blocks: [],
              blockedBy: [],
              createdAt: 1,
              updatedAt: 2,
            },
          ],
          nextId: 8,
        },
      },
    ]);
    await fire(host, "session_start", ctx);
    expect(result.getTodoSnapshot().tasks.map((t) => t.id)).toEqual([7]);
    expect(result.getTodoSnapshot().nextId).toBe(8);
    // and a /new-style empty restore empties it again
    await fire(host, "session_start", fakeCtx(host));
    expect(result.getTodoSnapshot()).toEqual({ tasks: [], nextId: 1 });
  });
});
