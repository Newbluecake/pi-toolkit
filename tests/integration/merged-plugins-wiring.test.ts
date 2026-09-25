import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import activate from "../../src/index.js";

/**
 * plugin-merge wiring (merge-plan D2/D6 + review B1/S6):
 *  1. child sessions (HOST_KEY pre-claimed) still get the merged web_search /
 *     TaskCreate..TaskDelete tools + /tasks — they register BEFORE the guard
 *     (ask_user does NOT: it is post-guard, so it stays host-session only);
 *  2. the host session additionally gets Agent, /agent and the HUD surface;
 *  3. hud/webSearch/todo gates (settings file) each suppress their surface;
 *  4. B1: the pre-guard path performs ZERO file writes — a legacy-settings
 *     file that loadSettingsFromFile would migrate comes out byte-identical
 *     after a child activation.
 *
 * Runs against a throwaway $HOME so defaultSettingsPath() never touches the
 * developer's real ~/.pi/agent/pi-subagent.json (same convention as
 * mention-autocomplete-wiring.test.ts).
 */
const HOST_KEY = Symbol.for("pi-subagent:host");
const FEISHU_HOST_KEY = Symbol.for("pi-subagent:feishu-notify:host");
const fakeHome = mkdtempSync(join(tmpdir(), "pi-subagent-merge-home-"));
const realHome = process.env.HOME;
process.env.HOME = fakeHome;

const settingsPath = join(fakeHome, ".pi", "agent", "pi-subagent.json");

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, unknown>();
  const tools = new Map<string, unknown>();
  const pi = {
    registerTool(tool: { name: string }) {
      if (!tools.has(tool.name)) tools.set(tool.name, tool);
    },
    registerCommand(name: string, cmd: unknown) {
      commands.set(name, cmd);
    },
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage() {},
    appendEntry() {},
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
  };
  return { pi: pi as unknown as ExtensionAPI, handlers, commands, tools };
}

function writeSettings(raw: unknown): void {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(raw, null, 2) + "\n", "utf8");
}

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  delete (globalThis as Record<symbol, unknown>)[FEISHU_HOST_KEY];
  rmSync(settingsPath, { force: true });
});
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  delete (globalThis as Record<symbol, unknown>)[FEISHU_HOST_KEY];
  rmSync(settingsPath, { force: true });
});
afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

const MERGED_TOOLS = ["web_search", "TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "TaskDelete"];

describe("merged plugins wiring (plugin-merge)", () => {
  it("child session (HOST_KEY claimed): merged tools register pre-guard, host surface stays inert", () => {
    (globalThis as Record<symbol, unknown>)[HOST_KEY] = { activatedAt: Date.now() };
    const { pi, tools, commands } = fakePi();
    activate(pi);
    for (const name of MERGED_TOOLS) expect(tools.has(name), `tool ${name}`).toBe(true);
    expect(commands.has("tasks")).toBe(true);
    // ask_user is post-guard (host-session only): a subagent must not see a tool
    // that can only ever return the headless error in print mode.
    expect(tools.has("ask_user")).toBe(false);
    // host-only surface must NOT register in a child session
    expect(tools.has("Agent")).toBe(false);
    expect(commands.has("agent")).toBe(false);
    expect(commands.has("pi-hud-refresh")).toBe(false);
    expect(commands.has("watch")).toBe(false);
    expect(commands.has("feishu-test")).toBe(false);
    expect(commands.has("resume-recent")).toBe(false);
    expect(commands.has("clear")).toBe(false);
  });

  it("host session: merged tools + subagent surface + HUD command all present", () => {
    const { pi, tools, commands } = fakePi();
    activate(pi);
    for (const name of MERGED_TOOLS) expect(tools.has(name), `tool ${name}`).toBe(true);
    expect(tools.has("ask_user")).toBe(true);
    expect(tools.has("Agent")).toBe(true);
    expect(commands.has("tasks")).toBe(true);
    expect(commands.has("agent")).toBe(true);
    expect(commands.has("pi-hud-refresh")).toBe(true);
    expect(commands.has("watch")).toBe(true);
    expect(commands.has("feishu-test")).toBe(true);
    expect(commands.has("resume-recent")).toBe(true);
    expect(commands.has("clear")).toBe(true);
  });

  it("gates: webSearch/todo/hud/askUser/feishuNotify disabled in settings file suppress their surfaces", () => {
    writeSettings({
      webSearch: { enabled: false },
      todo: { enabled: false },
      hud: { enabled: false },
      askUser: { enabled: false },
      feishuNotify: { enabled: false },
      sessionNav: { enabled: false },
    });
    const { pi, tools, commands } = fakePi();
    activate(pi);
    for (const name of MERGED_TOOLS) expect(tools.has(name), `tool ${name}`).toBe(false);
    expect(tools.has("ask_user")).toBe(false);
    expect(commands.has("tasks")).toBe(false);
    expect(commands.has("pi-hud-refresh")).toBe(false);
    expect(commands.has("watch")).toBe(false);
    expect(commands.has("feishu-test")).toBe(false);
    expect(commands.has("resume-recent")).toBe(false);
    expect(commands.has("clear")).toBe(false);
    // the subagent host surface is unaffected by merged-plugin gates
    expect(tools.has("Agent")).toBe(true);
    expect(commands.has("agent")).toBe(true);
  });

  it("B1: child activation performs zero file writes (legacy settings file stays byte-identical)", () => {
    // A legacy ms key that loadSettingsFromFile would migrate + rewrite.
    writeSettings({ deliveryBackoffMs: 1000 });
    const before = readFileSync(settingsPath, "utf8");
    (globalThis as Record<symbol, unknown>)[HOST_KEY] = { activatedAt: Date.now() };
    const { pi, tools } = fakePi();
    activate(pi);
    expect(tools.has("web_search")).toBe(true); // pre-guard read still applied
    expect(readFileSync(settingsPath, "utf8")).toBe(before); // …but nothing was written
    expect(existsSync(`${settingsPath}.${process.pid}.tmp`)).toBe(false);
  });

  it("B1 contrast: host activation migrates the legacy key in place (atomically, no tmp residue)", () => {
    writeSettings({ deliveryBackoffMs: 1000 });
    const { pi, tools } = fakePi();
    activate(pi);
    expect(tools.has("Agent")).toBe(true);
    const migrated = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    expect(migrated.deliveryBackoffMs).toBeUndefined();
    expect(migrated.deliveryBackoffS).toBe(1);
    expect(existsSync(`${settingsPath}.${process.pid}.tmp`)).toBe(false);
  });
});
