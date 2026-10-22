import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import activate from "../../src/index.js";
import { ListSessionsParams } from "../../src/tools/list-sessions-tool.js";
import { MessageSessionParams, messageSessionParamsFor } from "../../src/tools/message-session-tool.js";
import { sandboxHome } from "./helpers/home-sandbox.js";

let home: ReturnType<typeof sandboxHome>;
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent:host")];
  home?.restore();
});
function setup(fabric = true, xs = true, webHub = true, control = true, wake = true, compatible = true) {
  home = sandboxHome();
  const dir = join(home.home, ".pi/agent");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "pi-subagent.json");
  writeFileSync(
    file,
    JSON.stringify({
      fabric: { enabled: fabric, crossSession: { enabled: xs }, wake: { enabled: wake } },
      webHub: { enabled: webHub, control, autoStart: false },
      memory: { enabled: false },
      date: { enabled: false },
      todo: { enabled: false },
      webSearch: { enabled: false },
      topicSwitch: { enabled: false },
      hud: { enabled: false },
      title: { enabled: false },
      cacheTtl: { keepalive: false },
      quota: { enabled: false },
      askUser: { enabled: false },
    }),
  );
  const tools = new Map<string, any>(),
    commands: string[] = [];
  const handlers = new Map<string, Function[]>();
  const pi = {
    registerTool: (t: any) => {
      tools.set(t.name, t);
    },
    registerCommand: (n: string) => {
      commands.push(n);
    },
    registerEntryRenderer() {},
    on: (event: string, fn: Function) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
    sendMessage() {},
    ...(compatible ? { appendEntry() {} } : {}),
    getCommands: () => [],
    events: { on: () => () => {}, emit() {} },
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
  } as unknown as ExtensionAPI;
  activate(pi);
  return { tools, commands, file, handlers };
}
describe("XW activate-frozen main-session surface", () => {
  it.each([
    [false, true, true, true],
    [true, false, true, true],
    [true, true, false, true],
    [true, true, true, false],
  ])("any missing prerequisite removes both tools AND /fabric (%j %j %j %j)", (f, xs, w, c) => {
    const s = setup(f, xs, w, c);
    expect(s.tools.has("message_session")).toBe(false);
    expect(s.tools.has("list_sessions")).toBe(false);
    expect(s.commands).not.toContain("fabric");
  });
  it.each([false, true])("wake=%s never changes either schema; settings edits do not re-register tools", (wake) => {
    const s = setup(true, true, true, true, wake);
    expect(s.commands).toContain("fabric");
    // reply.enabled defaults on (RXW): the frozen instance is the reply schema, still wake-independent.
    expect(s.tools.get("message_session").parameters).toBe(messageSessionParamsFor(true));
    expect(s.tools.get("message_session").parameters).not.toBe(MessageSessionParams);
    expect(s.tools.get("list_sessions").parameters).toBe(ListSessionsParams);
    const before = JSON.stringify([...s.tools].map(([name, t]) => [name, t.parameters]));
    writeFileSync(s.file, JSON.stringify({ fabric: { enabled: false }, webHub: { enabled: false } }));
    expect(JSON.stringify([...s.tools].map(([name, t]) => [name, t.parameters]))).toBe(before);
  });
});

it("reply.enabled=false freezes the legacy (byte-identical) message_session schema", () => {
  const s = setup(true, true, true, true, true);
  expect(s.tools.get("message_session").parameters).not.toBe(MessageSessionParams); // default is reply-on
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent:host")];
  home.restore();
  home = sandboxHome();
  const dir = join(home.home, ".pi/agent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "pi-subagent.json"),
    JSON.stringify({
      fabric: { enabled: true, crossSession: { enabled: true, reply: { enabled: false } } },
      webHub: { enabled: true, control: true, autoStart: false },
      memory: { enabled: false },
      date: { enabled: false },
      todo: { enabled: false },
      webSearch: { enabled: false },
      topicSwitch: { enabled: false },
      hud: { enabled: false },
      title: { enabled: false },
      cacheTtl: { keepalive: false },
      quota: { enabled: false },
      askUser: { enabled: false },
    }),
  );
  const tools = new Map<string, any>();
  activate({
    registerTool: (t: any) => tools.set(t.name, t),
    registerCommand() {},
    registerEntryRenderer() {},
    on() {},
    sendMessage() {},
    appendEntry() {},
    getCommands: () => [],
    events: { on: () => () => {}, emit() {} },
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
  } as unknown as ExtensionAPI);
  expect(tools.get("message_session").parameters).toBe(MessageSessionParams);
});

it("compat failure registers no xs tools/command but retains B1 orphan abort before the first request", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const s = setup(true, true, true, true, true, false);
    expect([...s.tools.keys()]).not.toContain("message_session");
    expect([...s.tools.keys()]).not.toContain("list_sessions");
    expect(s.commands).not.toContain("fabric");
    expect(s.tools.get("Agent").label).toContain("unavailable");
    const abort = vi.fn();
    for (const h of s.handlers.get("before_agent_start") ?? [])
      await h(
        {
          messageType: "custom",
          message: { customType: "subagent:xs", details: { xsWake: true, wakeToken: "orphan" } },
        },
        { sessionManager: { getSessionId: () => "disabled-host" }, abort },
      );
    expect(abort).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("wake_orphan_aborted"));
  } finally {
    warn.mockRestore();
  }
});

it("xs-off minimal host does not read sessionManager in B1/shutdown hooks", async () => {
  const s = setup(true, false, true, true, true, false);
  const read = vi.fn(() => {
    throw new Error("minimal host has no session manager");
  });
  const ctx = {
    get sessionManager() {
      return read();
    },
  };
  for (const h of s.handlers.get("before_agent_start") ?? [])
    await h({ messageType: "user", prompt: "hello", systemPrompt: "host" }, ctx);
  // Only the early XW shutdown hook; later general host cleanup has its own contract.
  await s.handlers.get("session_shutdown")?.[0]?.({ reason: "quit" }, ctx);
  expect(read).not.toHaveBeenCalled();
});
