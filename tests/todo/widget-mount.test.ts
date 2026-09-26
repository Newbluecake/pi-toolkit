// Mount-once + update-in-place behavior for the todo aboveEditor widget
// (src/todo/index.ts refreshWidget), and the TODO_WIDGET_MOUNTED_EVENT signal
// it emits on hidden→visible transitions. See src/ui/widget-mount-events.ts
// for the full rationale (pi's setExtensionWidget always does a Map
// delete()+set(), so a repeat setWidget call on every task touch was what
// kept shoving the todo widget below the fleet widget).
//
// Harness pattern follows tests/todo/nudge-wiring.test.ts (inline fake
// ExtensionAPI/ExtensionContext).

import { describe, expect, test } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { wireTodo } from "../../src/todo/index.js";
import { TODO_WIDGET_MOUNTED_EVENT } from "../../src/ui/widget-mount-events.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyTool = ToolDefinition<any, any, any>;
type ToolResult = { content: { type: string; text: string }[]; details?: any };

type WidgetFactory = (tui: { requestRender: () => void }, theme: unknown) => { render(width: number): string[] };

/** Minimal Map-semantics fake mirroring pi's real setExtensionWidget: every
 *  call, content or not, does delete()+set() on a single ordered key list.
 *  Component factories are invoked eagerly at call time (matching pi's real
 *  `setExtensionWidget`, which builds the component immediately rather than
 *  storing the factory) so the captured `tui.requestRender` closure behaves
 *  the same way it would against the real host. */
function fakeWidgetMap() {
  const order: string[] = [];
  const setCalls: { key: string; hadContent: boolean }[] = [];
  return {
    order,
    setCalls,
    setWidget(key: string, content: WidgetFactory | string[] | undefined, tui: { requestRender: () => void }): void {
      const idx = order.indexOf(key);
      if (idx >= 0) order.splice(idx, 1);
      setCalls.push({ key, hadContent: content !== undefined });
      if (content === undefined) return;
      order.push(key);
      if (typeof content === "function") content(tui, {});
    },
    mountedKeys(): string[] {
      return [...order];
    },
  };
}

interface Host {
  pi: ExtensionAPI;
  tools: Map<string, AnyTool>;
  handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
  events: {
    emitted: { channel: string; data: unknown }[];
    on: (channel: string, handler: (data: unknown) => void) => () => void;
  };
}

function fakePi(): Host {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const host: Host = {
    pi: undefined as unknown as ExtensionAPI,
    tools: new Map(),
    handlers: new Map(),
    events: {
      emitted: [],
      on: (channel, handler) => {
        let set = listeners.get(channel);
        if (!set) {
          set = new Set();
          listeners.set(channel, set);
        }
        set.add(handler);
        return () => set!.delete(handler);
      },
    },
  };
  const pi = {
    registerTool: (def: AnyTool) => host.tools.set(def.name, def),
    registerCommand: () => undefined,
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
      host.handlers.set(event, handler),
    appendEntry: () => undefined,
    sendMessage: () => undefined,
    events: {
      emit: (channel: string, data: unknown) => {
        host.events.emitted.push({ channel, data });
        for (const handler of listeners.get(channel) ?? []) handler(data);
      },
      on: host.events.on,
    },
  };
  host.pi = pi as unknown as ExtensionAPI;
  return host;
}

async function exec(host: Host, name: string, params: unknown, ctx: ExtensionContext): Promise<ToolResult> {
  const def = host.tools.get(name);
  if (!def) throw new Error(`tool ${name} not registered`);
  return (await def.execute("call-1", params, undefined, undefined, ctx)) as ToolResult;
}

function fakeCtx(widgetMap: ReturnType<typeof fakeWidgetMap>, tuiRequestRender: () => void): ExtensionContext {
  const tui = { requestRender: tuiRequestRender };
  return {
    mode: "tui",
    hasUI: true,
    ui: {
      setStatus: () => undefined,
      notify: () => undefined,
      setWidget: (key: string, content: unknown) =>
        widgetMap.setWidget(key, content as WidgetFactory | string[] | undefined, tui),
    },
    sessionManager: { getBranch: () => [] },
  } as unknown as ExtensionContext;
}

const WIDGET_KEY = "claude-code-todo";

describe("todo widget: mount-once + update-in-place", () => {
  test("first task creation mounts the widget exactly once and emits the mount event", async () => {
    const host = fakePi();
    const widgetMap = fakeWidgetMap();
    let renders = 0;
    const ctx = fakeCtx(widgetMap, () => renders++);
    wireTodo(host.pi);

    // session_start / restore(): no tasks yet, no widget.
    host.handlers.get("session_start")?.({}, ctx);
    expect(widgetMap.mountedKeys()).toEqual([]);

    await exec(host, "TaskCreate", { subject: "A", description: "d" }, ctx);
    expect(widgetMap.mountedKeys()).toEqual([WIDGET_KEY]);
    expect(widgetMap.setCalls.filter((c) => c.key === WIDGET_KEY && c.hadContent)).toHaveLength(1);
    expect(host.events.emitted.filter((e) => e.channel === TODO_WIDGET_MOUNTED_EVENT)).toHaveLength(1);
  });

  test("after session_shutdown (/reload), the first task change remounts and re-emits the mount event", async () => {
    const host = fakePi();
    const widgetMap = fakeWidgetMap();
    const ctx = fakeCtx(widgetMap, () => undefined);
    wireTodo(host.pi);
    host.handlers.get("session_start")?.({}, ctx);
    await exec(host, "TaskCreate", { subject: "A", description: "d" }, ctx);
    expect(host.events.emitted.filter((e) => e.channel === TODO_WIDGET_MOUNTED_EVENT)).toHaveLength(1);

    host.handlers.get("session_shutdown")?.({}, ctx);
    expect(widgetMap.mountedKeys()).toEqual([]);

    // Next session: restore finds no persisted tasks (fake branch is empty);
    // the first TaskCreate must mount again and signal the fleet widget again.
    host.handlers.get("session_start")?.({}, ctx);
    await exec(host, "TaskCreate", { subject: "B", description: "d" }, ctx);
    expect(widgetMap.mountedKeys()).toEqual([WIDGET_KEY]);
    expect(host.events.emitted.filter((e) => e.channel === TODO_WIDGET_MOUNTED_EVENT)).toHaveLength(2);
  });

  test("subsequent task updates repaint in place — no repeat setWidget call, no repeat mount event", async () => {
    const host = fakePi();
    const widgetMap = fakeWidgetMap();
    let renders = 0;
    const ctx = fakeCtx(widgetMap, () => renders++);
    wireTodo(host.pi);
    host.handlers.get("session_start")?.({}, ctx);

    await exec(host, "TaskCreate", { subject: "A", description: "d" }, ctx);
    const mountCallsAfterFirst = widgetMap.setCalls.filter((c) => c.key === WIDGET_KEY && c.hadContent).length;
    const rendersAfterFirst = renders;

    await exec(host, "TaskCreate", { subject: "B", description: "d" }, ctx);
    await exec(host, "TaskUpdate", { taskId: "1", status: "in_progress" }, ctx);
    await exec(host, "TaskUpdate", { taskId: "2", status: "completed" }, ctx);

    // Same single mount the whole time.
    expect(widgetMap.setCalls.filter((c) => c.key === WIDGET_KEY && c.hadContent)).toHaveLength(mountCallsAfterFirst);
    expect(host.events.emitted.filter((e) => e.channel === TODO_WIDGET_MOUNTED_EVENT)).toHaveLength(1);
    // But it did repaint via requestRender for each of the three touches.
    expect(renders).toBeGreaterThan(rendersAfterFirst);
    expect(widgetMap.mountedKeys()).toEqual([WIDGET_KEY]);
  });

  test("deleting the last task hides the widget; a new task afterwards remounts and re-emits the signal", async () => {
    const host = fakePi();
    const widgetMap = fakeWidgetMap();
    const ctx = fakeCtx(widgetMap, () => undefined);
    wireTodo(host.pi);
    host.handlers.get("session_start")?.({}, ctx);

    await exec(host, "TaskCreate", { subject: "A", description: "d" }, ctx);
    expect(widgetMap.mountedKeys()).toEqual([WIDGET_KEY]);

    await exec(host, "TaskDelete", { taskId: "1" }, ctx);
    expect(widgetMap.mountedKeys()).toEqual([]);
    expect(widgetMap.setCalls.at(-1)).toEqual({ key: WIDGET_KEY, hadContent: false });

    await exec(host, "TaskCreate", { subject: "C", description: "d" }, ctx);
    expect(widgetMap.mountedKeys()).toEqual([WIDGET_KEY]);
    expect(widgetMap.setCalls.filter((c) => c.key === WIDGET_KEY && c.hadContent)).toHaveLength(2);
    expect(host.events.emitted.filter((e) => e.channel === TODO_WIDGET_MOUNTED_EVENT)).toHaveLength(2);
  });

  test("if another widget mounted after todo (e.g. fleet), todo's own remount always lands it at the end of the ordered keys", async () => {
    const host = fakePi();
    const widgetMap = fakeWidgetMap();
    const ctx = fakeCtx(widgetMap, () => undefined);
    wireTodo(host.pi);
    host.handlers.get("session_start")?.({}, ctx);

    await exec(host, "TaskCreate", { subject: "A", description: "d" }, ctx);
    expect(widgetMap.mountedKeys()).toEqual([WIDGET_KEY]);

    // Simulate a sibling widget (fleet) mounting after todo — insertion order.
    widgetMap.setWidget("pi-subagent:fleet", ["fleet line"], { requestRender: () => undefined });
    expect(widgetMap.mountedKeys()).toEqual([WIDGET_KEY, "pi-subagent:fleet"]);

    // Task touches must not re-set todo's widget (would otherwise flip order).
    await exec(host, "TaskUpdate", { taskId: "1", status: "in_progress" }, ctx);
    expect(widgetMap.mountedKeys()).toEqual([WIDGET_KEY, "pi-subagent:fleet"]);
  });
});
