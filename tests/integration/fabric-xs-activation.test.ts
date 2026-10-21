import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import activate from "../../src/index.js";
import { ListSessionsParams } from "../../src/tools/list-sessions-tool.js";
import { MessageSessionParams } from "../../src/tools/message-session-tool.js";
import { sandboxHome } from "./helpers/home-sandbox.js";

let home: ReturnType<typeof sandboxHome>;
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent:host")];
  home?.restore();
});
function setup(fabric = true, xs = true, webHub = true, control = true, wake = true) {
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
  const pi = {
    registerTool: (t: any) => {
      tools.set(t.name, t);
    },
    registerCommand: (n: string) => {
      commands.push(n);
    },
    registerEntryRenderer() {},
    on() {},
    sendMessage() {},
    appendEntry() {},
    getCommands: () => [],
    events: { on: () => () => {}, emit() {} },
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
  } as unknown as ExtensionAPI;
  activate(pi);
  return { tools, commands, file };
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
    expect(s.tools.get("message_session").parameters).toBe(MessageSessionParams);
    expect(s.tools.get("list_sessions").parameters).toBe(ListSessionsParams);
    const before = JSON.stringify([...s.tools].map(([name, t]) => [name, t.parameters]));
    writeFileSync(s.file, JSON.stringify({ fabric: { enabled: false }, webHub: { enabled: false } }));
    expect(JSON.stringify([...s.tools].map(([name, t]) => [name, t.parameters]))).toBe(before);
  });
});
