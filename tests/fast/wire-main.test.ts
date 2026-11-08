import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { wireFastMain, wireFastChild } from "../../src/fast/wire.js";
import { FAST_BIND_EVENT, type FastBindReply, type FastBindRequest } from "../../src/fast/ports.js";

function api() {
  type Handler = (event: never, ctx: ExtensionContext) => unknown;
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<
    string,
    {
      description: string;
      getArgumentCompletions: (prefix: string) => { value: string }[];
      handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    }
  >();
  const bus = new Map<string, ((data: unknown) => void)[]>();
  const pi = {
    on: vi.fn((event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const i = list.indexOf(handler);
        if (i >= 0) list.splice(i, 1);
      };
    }),
    registerCommand: vi.fn((name: string, def: typeof commands extends Map<string, infer V> ? V : never) =>
      commands.set(name, def),
    ),
    appendEntry: vi.fn(),
    events: {
      on: (event: string, handler: (data: unknown) => void) => {
        const list = bus.get(event) ?? [];
        list.push(handler);
        bus.set(event, list);
        return () => {
          const i = list.indexOf(handler);
          if (i >= 0) list.splice(i, 1);
        };
      },
    },
  };
  return {
    pi: pi as unknown as ExtensionAPI,
    handlers,
    commands,
    append: pi.appendEntry,
    emit(event: string, data: unknown, ctx: ExtensionContext) {
      let value = data;
      for (const h of handlers.get(event) ?? []) {
        const r = h(
          { type: event, payload: value, ...(event === "provider_stream_event" ? (data as object) : {}) } as never,
          ctx,
        );
        if (r !== undefined) value = r;
      }
      return value;
    },
    bind(req: FastBindRequest) {
      for (const fn of [...(bus.get(FAST_BIND_EVENT) ?? [])]) fn(req);
    },
    bus,
  };
}
function context(id = "same-id") {
  let expired = false;
  let branch: unknown[] = [];
  const manager = { getSessionId: () => id, getSessionFile: () => undefined, getBranch: vi.fn(() => branch) };
  const ui = { notify: vi.fn(), setStatus: vi.fn() };
  const ctx = {
    get sessionManager() {
      if (expired) throw Error("SDK stale ctx");
      return { ...manager };
    },
    ui,
  } as unknown as ExtensionCommandContext;
  return {
    ctx,
    ui,
    manager,
    expire: () => {
      expired = true;
    },
    branch: (next: unknown[]) => {
      branch = next;
    },
  };
}
const rec = (mode: string) => ({ type: "custom", customType: "subagent:fast", data: { v: 1, mode } });
const body = { model: "route-physical", store: false, stream: true, input: [], service_tier: "flex" };
describe("Fast fixed main/child wiring", () => {
  it("explicit false is zero commands/hooks/bus/read/write", () => {
    const f = api();
    expect(wireFastMain(f.pi, false)).toBeUndefined();
    wireFastChild(f.pi, false);
    expect(f.commands.size).toBe(0);
    expect(f.handlers.size).toBe(0);
    expect(f.bus.size).toBe(0);
    expect(f.append).not.toHaveBeenCalled();
  });
  it("existing secure write gate denies commands, seeds and payload without becoming a storage fault", async () => {
    const f = api();
    const c = context();
    c.branch([rec("off")]);
    let allowed = true;
    const gate = vi.fn(() => allowed);
    const wire = wireFastMain(f.pi, true, { canUse: gate })!;
    const ports = wire.open(c.ctx);
    expect(ports.workflow.capture()).toEqual({ v: 1, mode: "off" });
    allowed = false;
    await f.commands.get("fast")!.handler("on", c.ctx);
    expect(f.append).not.toHaveBeenCalled();
    expect(ports.workflow.capture()).toBeUndefined();
    expect(f.emit("before_provider_request", body, c.ctx)).toBe(body);
    expect(c.ui.notify).not.toHaveBeenCalled(); // the existing guard owns its LOCKED notification
    allowed = true;
    await f.commands.get("fast")!.handler("status", c.ctx);
    expect(c.ui.notify.mock.calls.at(-1)?.[0]).not.toContain("storage-fault");
    expect(ports.workflow.capture()).toEqual({ v: 1, mode: "off" });
    ports.dispose();
    const count = gate.mock.calls.length;
    const disabled = api();
    wireFastMain(disabled.pi, false, { canUse: gate });
    wireFastChild(disabled.pi, false, { canUse: gate });
    expect(disabled.handlers.size).toBe(0);
    expect(gate.mock.calls).toHaveLength(count);
  });

  it("checks the current public callback context, not only the stack-open context", async () => {
    const f = api();
    const opened = context();
    const callback = context(); // Same public history, independent context/facade.
    opened.branch([rec("on")]);
    const gate = vi.fn((ctx: ExtensionContext) => ctx === opened.ctx);
    const ports = wireFastMain(f.pi, true, { canUse: gate })!.open(opened.ctx);
    expect(ports.workflow.capture()).toEqual({ v: 1, mode: "on" });
    await f.commands.get("fast")!.handler("off", callback.ctx);
    expect(gate).toHaveBeenLastCalledWith(callback.ctx);
    expect(f.append).not.toHaveBeenCalled();
    expect(f.emit("before_provider_request", body, callback.ctx)).toBe(body);
    expect(gate).toHaveBeenLastCalledWith(callback.ctx);
    f.emit(
      "provider_stream_event",
      {
        api: "openai-responses",
        data: { type: "response.completed", response: { service_tier: "priority" } },
      },
      callback.ctx,
    );
    await f.commands.get("fast")!.handler("status", opened.ctx);
    expect(opened.ui.notify.mock.calls.at(-1)?.[0]).toContain("latest observed=unknown");
    opened.expire();
    expect(ports.workflow.capture()).toBeUndefined(); // No context-free query assumes safety.
    ports.dispose();
  });

  it("recommends inherit and not the reset alias in help and completion", () => {
    const f = api();
    wireFastMain(f.pi, true);
    const cmd = f.commands.get("fast")!;
    expect(cmd.description).toContain("inherit");
    expect(cmd.description).not.toContain("reset");
    expect(cmd.getArgumentCompletions("").map((item) => item.value)).toContain("inherit");
    expect(cmd.getArgumentCompletions("reset")).toEqual([]);
  });

  it.each([
    { args: "reset", mode: "on", expected: /^Fast requested=inherit/, level: "info", writes: 1 },
    { args: "status", mode: "off", expected: /^Fast requested=off/, level: "info", writes: 0 },
    { args: "on", mode: "inherit", expected: /^Fast requested=on/, level: "info", writes: 1 },
    { args: "off", mode: "on", expected: /^Fast requested=off/, level: "info", writes: 1 },
    { args: "inherit", mode: "on", expected: /^Fast requested=inherit/, level: "info", writes: 1 },
    { args: "on", mode: "on", expected: /^Fast requested=on/, level: "info", writes: 0 },
    { args: "status", mode: "invalid", expected: /invalid-record/, level: "info", writes: 0 },
    { args: "reset", mode: "invalid", expected: /^Fast requested=inherit/, level: "info", writes: 1 },
    { args: "bad args", mode: "on", expected: /^用法：\/fast/, level: "warning", writes: 0 },
    { args: "on", mode: "off", expected: /^Fast storage-fault/, level: "error", writes: 1, fail: true },
  ])("routes $args from $mode only to this callback UI", async ({ args, mode, expected, level, writes, fail }) => {
    const f = api();
    const opened = context();
    const callback = context(); // Same valid public identity; not the open ctx/UI.
    opened.branch([rec(mode)]);
    f.append.mockImplementation((customType: string, data: unknown) => {
      if (fail) throw Error("append failed");
      opened.branch([{ type: "custom", customType, data }]);
    });
    const ports = wireFastMain(f.pi, true)!.open(opened.ctx);
    await f.commands.get("fast")!.handler(args, callback.ctx);
    expect(callback.ui.notify).toHaveBeenCalledTimes(1);
    expect(callback.ui.notify).toHaveBeenLastCalledWith(expect.stringMatching(expected), level);
    expect(opened.ui.notify).not.toHaveBeenCalled();
    expect(callback.ui.setStatus).not.toHaveBeenCalled();
    expect(f.append).toHaveBeenCalledTimes(writes);
    if (fail) expect(ports.workflow.capture()).toEqual({ v: 1, mode: "off" });
    ports.dispose();
  });

  it("swallows a closed callback UI without fallback, storage fault or retained provider UI", async () => {
    const f = api();
    const opened = context();
    const callback = context();
    const ports = wireFastMain(f.pi, true)!.open(opened.ctx);
    f.append.mockImplementation((customType: string, data: unknown) =>
      opened.branch([{ type: "custom", customType, data }]),
    );
    callback.ui.notify.mockImplementation(() => {
      throw Error("closed UI");
    });
    await f.commands.get("fast")!.handler("on", callback.ctx);
    expect(callback.ui.notify).toHaveBeenCalledTimes(1);
    expect(opened.ui.notify).not.toHaveBeenCalled();
    expect(ports.workflow.capture()).toEqual({ v: 1, mode: "on" });
    expect(opened.ui.setStatus).toHaveBeenLastCalledWith("subagent:fast", "Fast requested");
    f.emit("before_provider_request", { messages: [] }, callback.ctx);
    expect(opened.ui.notify).toHaveBeenCalledTimes(1);
    expect(opened.ui.notify).toHaveBeenLastCalledWith(expect.stringMatching(/^Fast suspended/), "warning");
    expect(callback.ui.notify).toHaveBeenCalledTimes(1);
    const later = context();
    await f.commands.get("fast")!.handler("status", later.ctx);
    expect(later.ui.notify).toHaveBeenCalledTimes(1);
    expect(later.ui.notify).toHaveBeenLastCalledWith(expect.stringMatching(/^Fast requested=on/), "info");
    expect(later.ui.notify.mock.calls[0]?.[0]).not.toContain("storage-fault");
    ports.dispose();
  });

  it("main fixed handlers, no facade identity reliance, expired commands and same-ID ABA owners", async () => {
    const f = api();
    const wire = wireFastMain(f.pi, true)!;
    const a = context();
    const portsA = wire.open(a.ctx);
    expect([...f.handlers.keys()]).toEqual(["before_provider_request", "provider_stream_event"]);
    expect(a.ui.setStatus).not.toHaveBeenCalled();
    expect(f.append).not.toHaveBeenCalled();
    f.append.mockImplementation((customType: string, data: unknown) =>
      a.branch([{ type: "custom", customType, data }]),
    );
    await f.commands.get("fast")!.handler("on", a.ctx);
    expect(f.emit("before_provider_request", body, a.ctx)).toHaveProperty("service_tier", "priority");
    expect(portsA.workflow.capture()).toEqual({ v: 1, mode: "on" });
    a.expire();
    portsA.dispose();
    const b = context();
    b.branch([rec("off")]);
    const portsB = wire.open(b.ctx);
    await f.commands.get("fast")!.handler("on", a.ctx);
    expect(f.append).toHaveBeenCalledTimes(1);
    f.emit(
      "provider_stream_event",
      { api: "openai-responses", data: { type: "response.completed", response: { service_tier: "priority" } } },
      a.ctx,
    );
    await f.commands.get("fast")!.handler("status", b.ctx);
    expect(b.ui.notify.mock.calls.at(-1)?.[0]).toContain("latest observed=unknown");
    expect(portsA.workflow.capture()).toBeUndefined();
    expect(portsB.workflow.capture()).toEqual({ v: 1, mode: "off" });
    expect(f.emit("before_provider_request", body, b.ctx)).toHaveProperty("service_tier", "default");
    portsA.dispose();
    expect(portsB.workflow.capture()).toEqual({ v: 1, mode: "off" });
    portsB.dispose();
  });
  it("receiver replies synchronously, same manager/owner idempotent, foreign manager rejected, cleanup removes handlers", () => {
    const f = api();
    wireFastChild(f.pi, true);
    const c = context();
    c.branch([rec("on")]);
    let reply: FastBindReply | undefined;
    const take = vi.fn((r: FastBindReply) => {
      reply = r;
    });
    const req: FastBindRequest = {
      v: 1,
      owner: { parentRunId: "r", incarnation: {} },
      manager: c.manager,
      reply: take,
    };
    f.bind(req);
    expect(take).toHaveBeenCalledTimes(1);
    expect(reply?.readMode()).toBe("on");
    f.bind(req);
    expect(take).toHaveBeenCalledTimes(2);
    expect(take.mock.calls[0]?.[0]).toBe(take.mock.calls[1]?.[0]);
    f.bind({ ...req, manager: { getBranch: () => [rec("off")] } });
    expect(take).toHaveBeenCalledTimes(2);
    expect(f.emit("before_provider_request", body, c.ctx)).toHaveProperty("service_tier", "priority");
    c.branch([rec("inherit")]);
    expect(reply?.readMode()).toBe("inherit");
    expect(f.emit("before_provider_request", body, c.ctx)).toBe(body);
    expect(f.commands.size).toBe(0);
    expect(c.ui.notify).not.toHaveBeenCalled();
    expect(c.ui.setStatus).not.toHaveBeenCalled();
    expect(f.append).not.toHaveBeenCalled();
    reply!.dispose();
    reply!.dispose();
    expect(reply!.readMode()).toBe("inherit");
    expect([...f.handlers.values()].flat()).toHaveLength(0);
    expect([...f.bus.values()].flat()).toHaveLength(0);
  });
});
