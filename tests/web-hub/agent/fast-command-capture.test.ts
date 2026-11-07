import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCommandCaptureEngine, wrapCommandApi } from "../../../src/commands/capture.js";
import { wireFastMain } from "../../../src/fast/wire.js";
import { createCommandRecorder } from "../../../src/web-hub/agent/command-record.js";
import { CMD_RECORD_ENTRY_TYPE, type CmdRecordData } from "../../../src/web-hub/protocol/cmd-record.js";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

/** Production wrapper + capture + recorder + Fast wiring, with only the SDK/UI/storage ports controlled. */
function setup(mode = "on", fail = false) {
  const branch: unknown[] = [{ type: "custom", customType: "subagent:fast", data: { v: 1, mode } }];
  const records: CmdRecordData[] = [];
  const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  type Hook = (event: never, ctx: ExtensionContext) => unknown;
  const hooks = new Map<string, Hook>();
  const appendEntry = vi.fn((customType: string, data: unknown) => {
    if (customType === CMD_RECORD_ENTRY_TYPE) records.push(data as CmdRecordData);
    else {
      if (fail) throw Error("append failed");
      branch.push({ type: "custom", customType, data });
    }
  });
  const api = {
    registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) =>
      commands.set(name, command),
    on: (event: string, hook: Hook) => {
      hooks.set(event, hook);
      return () => hooks.delete(event);
    },
    appendEntry,
    sendMessage: vi.fn(),
  };
  const ownedNames = new Set<string>();
  const engine = createCommandCaptureEngine({ ownedNames });
  // Virtual timers: commands settle synchronously, with no elapsed-time or environment dependency.
  const timers = new Map<object, () => void>();
  const recorder = createCommandRecorder({
    appendEntry,
    sessionId: () => "fast-history",
    now: () => 1000,
    setTimer: (_ms, fn) => {
      const key = {};
      timers.set(key, fn);
      return { cancel: () => void timers.delete(key) };
    },
    onChange: () => undefined,
  });
  const pi = wrapCommandApi(
    api as unknown as ExtensionAPI,
    () => engine,
    ownedNames,
    undefined,
    () => recorder,
  );
  const makeContext = () => {
    const ui = { notify: vi.fn(), setStatus: vi.fn() };
    return {
      ui,
      ctx: {
        mode: "tui",
        ui,
        sessionManager: {
          getSessionId: () => "fast-history",
          getSessionFile: () => undefined,
          getBranch: () => branch,
        },
      } as unknown as ExtensionCommandContext,
    };
  };
  const opened = makeContext();
  const callback = makeContext();
  const ports = wireFastMain(pi, true)!.open(opened.ctx);
  disposers.push(() => {
    ports.dispose();
    recorder.dispose();
    engine.dispose();
  });
  let sequence = 0;
  const execute = async (args: string, source: "web" | "tui") => {
    const cmdId = `fast-command-${++sequence}`;
    if (source === "web")
      engine.arm({
        cmdId,
        reqId: "fast-request",
        origin: { listener: "loopback", ip: "127.0.0.1", reqId: "fast-request" },
        name: "fast",
        args,
        deadlineAt: Date.now() + 10_000,
      });
    await commands.get("fast")!.handler(args, callback.ctx);
    engine.settleArm();
    return cmdId;
  };
  return { api, engine, recorder, records, timers, opened, callback, hooks, execute, ports, appendEntry };
}

const cases = [
  { args: "status", mode: "on", expected: /^Fast requested=on/, level: "info", writes: 0 },
  { args: "on", mode: "inherit", expected: /^Fast requested=on/, level: "info", writes: 1 },
  { args: "off", mode: "on", expected: /^Fast requested=off/, level: "info", writes: 1 },
  { args: "inherit", mode: "on", expected: /^Fast requested=inherit/, level: "info", writes: 1 },
  { args: "on", mode: "on", expected: /^Fast requested=on/, level: "info", writes: 0 },
  { args: "status", mode: "invalid", expected: /invalid-record/, level: "info", writes: 0 },
  { args: "reset", mode: "invalid", expected: /^Fast requested=inherit/, level: "info", writes: 1 },
  { args: "bad args", mode: "on", expected: /^用法：\/fast/, level: "warning", writes: 0 },
  { args: "on", mode: "off", expected: /^Fast storage-fault/, level: "error", writes: 1, fail: true },
];

describe.each(["web", "tui"] as const)("Fast %s command feedback through production capture/recording", (source) => {
  it.each(cases)("$args from $mode records one notify, not a no-output placeholder", async (row) => {
    const f = setup(row.mode, row.fail);
    const cmdId = await f.execute(row.args, source);
    expect(f.engine.owns("fast")).toBe(true);
    expect(f.callback.ui.notify).toHaveBeenCalledTimes(1); // capture/observe still forwards once to terminal
    expect(f.callback.ui.notify).toHaveBeenLastCalledWith(expect.stringMatching(row.expected), row.level);
    expect(f.opened.ui.notify).not.toHaveBeenCalled();
    expect(f.callback.ui.setStatus).not.toHaveBeenCalled(); // footer remains session-only
    const output = {
      entries: [{ kind: "notify", level: row.level, text: f.callback.ui.notify.mock.calls[0]![0] }],
    };
    if (source === "web") {
      expect(f.engine.isActive(cmdId)).toBe(false);
      expect(f.engine.outputFor(cmdId)).toEqual(output);
    } else expect(f.engine.outputFor(cmdId)).toBeUndefined();
    expect(f.records).toHaveLength(1);
    expect(f.records[0]).toMatchObject({
      name: "fast",
      args: row.args,
      source,
      phase: "end",
      state: "done",
      output,
    });
    expect(f.records[0]).not.toHaveProperty("notice");
    expect(f.recorder.running()).toEqual([]);
    expect(f.timers.size).toBe(0);
    expect(f.appendEntry.mock.calls.filter(([type]) => type === "subagent:fast")).toHaveLength(row.writes);
    expect(f.api.sendMessage).not.toHaveBeenCalled(); // custom entries only; no LLM context route
    if (row.fail) expect(f.ports.workflow.capture()).toEqual({ v: 1, mode: "off" });
  });

  it("provider feedback during the next live command window stays on the session channel", async () => {
    const f = setup();
    const firstId = await f.execute("status", source);
    const firstOutput = structuredClone(f.records[0]!.output);
    // The async SDK handler has emitted its command feedback but wrapper settlement is still pending.
    const pending = f.execute("off", source);
    expect(f.recorder.running()).toHaveLength(1);
    if (source === "web") expect(f.engine.isActive("fast-command-2")).toBe(true);
    for (const payload of [{ messages: [] }, { model: "physical", input: [] }])
      f.hooks.get("before_provider_request")!({ payload } as never, f.callback.ctx);
    const nextId = await pending;
    expect(f.opened.ui.notify).toHaveBeenCalledTimes(2);
    expect(f.callback.ui.notify).toHaveBeenCalledTimes(2);
    expect(f.callback.ui.notify.mock.calls[1]?.[0]).toMatch(/^Fast requested=off/);
    expect(f.records[0]!.output).toEqual(firstOutput);
    expect(f.records[1]!.output?.entries).toEqual([
      { kind: "notify", level: "info", text: f.callback.ui.notify.mock.calls[1]![0] },
    ]);
    if (source === "web") {
      expect(f.engine.outputFor(firstId)).toEqual(firstOutput);
      expect(f.engine.outputFor(nextId)).toEqual(f.records[1]!.output);
    }
  });

  it("provider warnings and observations cannot stick to an ended command UI or its next window", async () => {
    const f = setup();
    const firstId = await f.execute("status", source);
    const firstOutput = structuredClone(f.records[0]!.output);
    for (const payload of [{ messages: [] }, { model: "physical", input: [] }]) {
      f.hooks.get("before_provider_request")!({ payload } as never, f.callback.ctx);
      f.hooks.get("before_provider_request")!({ payload } as never, f.callback.ctx); // static reason dedup
    }
    expect(f.opened.ui.notify).toHaveBeenCalledTimes(2);
    expect(f.opened.ui.notify.mock.calls[0]?.[0]).toMatch(/^Fast suspended/);
    expect(f.opened.ui.notify.mock.calls[1]?.[0]).toMatch(/^Fast unsupported-payload/);
    expect(f.callback.ui.notify).toHaveBeenCalledTimes(1);
    expect(f.records[0]!.output).toEqual(firstOutput);
    if (source === "web") expect(f.engine.outputFor(firstId)).toEqual(firstOutput);
    f.hooks.get("provider_stream_event")!(
      {
        data: { type: "response.completed", response: { service_tier: "priority" } },
        api: "openai-responses",
      } as never,
      f.callback.ctx,
    );
    const nextId = await f.execute("status", source);
    expect(f.callback.ui.notify).toHaveBeenCalledTimes(2);
    expect(f.callback.ui.notify.mock.calls[1]?.[0]).toContain("latest observed=priority (origin unknown)");
    expect(f.records).toHaveLength(2);
    expect(f.records[1]!.output?.entries).toEqual([
      { kind: "notify", level: "info", text: f.callback.ui.notify.mock.calls[1]![0] },
    ]);
    expect(f.records[1]).not.toHaveProperty("notice");
    expect(f.records[0]!.output).toEqual(firstOutput);
    if (source === "web") {
      expect(f.engine.outputFor(nextId)).toEqual(f.records[1]!.output);
      expect(f.engine.outputFor(firstId)).toEqual(firstOutput);
    }
    expect(f.api.sendMessage).not.toHaveBeenCalled();
  });
});
