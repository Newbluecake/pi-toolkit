import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import activate from "../../src/index.js";
import { RESERVED_TOOL_NAMES, buildToolScopePolicy, createToolScopeEnforcer } from "../../src/runtime/tool-scope.js";
import { sandboxHome } from "./helpers/home-sandbox.js";

let home: ReturnType<typeof sandboxHome> | undefined;
const globals = globalThis as Record<symbol, unknown>;
const host = Symbol.for("pi-subagent:host");
afterEach(() => {
  delete globals[host];
  home?.restore();
  home = undefined;
});

function child(xs: boolean) {
  home ??= sandboxHome();
  const dir = join(home.home, ".pi/agent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "pi-subagent.json"),
    JSON.stringify({
      webHub: { enabled: true },
      fabric: { enabled: true, crossSession: { enabled: xs } },
      memory: { enabled: false },
      todo: { enabled: false },
      date: { enabled: false },
      webSearch: { enabled: false },
      bashJobs: { autoBackgroundMs: 0 },
      cacheTtl: { keepalive: false },
      compact: { switchTool: false },
    }),
  );
  globals[host] = { main: true };
  const registered: string[] = [],
    commands: string[] = [],
    events: string[] = [];
  const pi = {
    on: (name: string) => {
      events.push(name);
    },
    registerTool: (tool: { name: string }) => {
      registered.push(tool.name);
    },
    registerCommand: (name: string) => {
      commands.push(name);
    },
    registerMessageRenderer() {},
    registerEntryRenderer() {},
    events: { on: () => () => {}, emit() {} },
  } as unknown as ExtensionAPI;
  activate(pi);
  return { registered, commands, events, reserved: [...RESERVED_TOOL_NAMES] };
}

describe("XW xs stays post-guard, no reserved-name widening", () => {
  it("off/on child registration, hooks, command and reserved surfaces are identical", () => {
    const off = child(false),
      on = child(true);
    expect(on).toEqual(off);
    expect(on.registered).not.toContain("list_sessions");
    expect(on.registered).not.toContain("message_session");
    expect(on.commands).not.toContain("fabric");
    expect(on.reserved).not.toContain("list_sessions");
    expect(on.reserved).not.toContain("message_session");
  });

  it.each([false, true])("a same-name MCP child tool survives bind AND late scope refresh (xs=%s)", (xs) => {
    child(xs);
    let active = ["read", "message_session", "list_sessions", "Agent"];
    const handle = {
      getActiveTools: () => [...active],
      setActiveTools: (names: string[]) => {
        active = names;
      },
    };
    const enforcer = createToolScopeEnforcer(),
      policy = buildToolScopePolicy({});
    expect(enforcer.onBind(handle, policy).applied).toEqual(["list_sessions", "message_session", "read"]);
    expect(enforcer.onTurnBoundary(handle, policy).blockedNewcomers).toEqual([]);
    expect(active).toEqual(["list_sessions", "message_session", "read"]);
  });
});
