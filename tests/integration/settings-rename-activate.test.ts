// settings-rename P2 (T-PL1): real activate() over the settings-file states, sandbox HOME only.
//  - main session: legacy file ⇒ migrated at activate, `/agent settings` reads/writes the NEW name, the compat
//    link survives a live write
//  - child session (HOST_KEY already claimed): the settings files are not touched at all (ino + mtime)
//  - S6b: notified exactly once on the first session_start; the registration sequence is identical to S5
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import activate from "../../src/index.js";
import { resetSettingsFiles, sandboxHome } from "./helpers/home-sandbox.js";

const HOST_KEY = Symbol.for("pi-subagent:host");
const FEISHU_HOST_KEY = Symbol.for("pi-subagent:feishu-notify:host");
const releaseGuards = (): void => {
  delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  delete (globalThis as Record<symbol, unknown>)[FEISHU_HOST_KEY];
};

type Handler = (event: unknown, ctx: unknown) => unknown;
function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const tools: string[] = [];
  const order: string[] = [];
  const pi = {
    registerTool(t: { name: string }) {
      tools.push(t.name);
      order.push(`tool:${t.name}`);
    },
    registerCommand(name: string, cmd: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, cmd);
      order.push(`cmd:${name}`);
    },
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      order.push(`on:${event}`);
    },
    sendMessage() {},
    appendEntry() {},
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
  };
  const emit = async (event: string, payload: unknown = {}, ctx: unknown = {}) => {
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
  };
  return { pi: pi as unknown as ExtensionAPI, commands, emit, order };
}

describe("settings-file rename at activate", () => {
  let sb: ReturnType<typeof sandboxHome>;
  let agent: string;
  let warn: ReturnType<typeof vi.spyOn>;
  const NEW = () => join(agent, "pi-toolkit.json");
  const OLD = () => join(agent, "pi-subagent.json");

  beforeEach(() => {
    sb = sandboxHome();
    releaseGuards();
    agent = join(sb.home, ".pi", "agent");
    mkdirSync(agent, { recursive: true });
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    releaseGuards();
    warn.mockRestore();
    sb.restore();
  });

  const seed = (name: string, value: unknown = { budget: { idleS: 111 } }) =>
    writeFileSync(join(agent, name), JSON.stringify(value) + "\n", { mode: 0o600 });
  const sessionCtx = (notify: (m: string, k: string) => void = () => undefined) => ({
    hasUI: true,
    ui: { notify, setStatus() {}, setWidget() {}, setTitle() {} },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    cwd: sb.home,
  });
  const run = async (args: string, pi: ReturnType<typeof fakePi>): Promise<string[]> => {
    const out: string[] = [];
    await pi.commands.get("agent")!.handler(args, { hasUI: false, ui: { notify: (m: string) => out.push(m) } });
    return out;
  };

  it("main session: S1 ⇒ S5 at activate; /agent settings uses the new name and keeps the compat link", async () => {
    seed("pi-subagent.json");
    const ino = statSync(OLD()).ino;
    const p = fakePi();
    activate(p.pi);
    await p.emit("session_start", { reason: "startup" }, sessionCtx());
    expect(statSync(NEW()).ino).toBe(ino);
    expect(readlinkSync(OLD())).toBe("pi-toolkit.json");

    const list = (await run("settings list", p)).join("\n");
    expect(list).toContain(`Extension settings — ${NEW()}`);
    await run("settings set budget.idleS 222", p);
    expect(JSON.parse(readFileSync(NEW(), "utf8")).budget.idleS).toBe(222);
    expect(lstatSync(OLD()).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(OLD(), "utf8")).budget.idleS).toBe(222);
    await p.emit("session_shutdown", { reason: "quit" }, sessionCtx());
  });

  it("main session: no settings at all ⇒ nothing is created at activate", async () => {
    resetSettingsFiles(sb.home);
    const p = fakePi();
    activate(p.pi);
    await p.emit("session_start", { reason: "startup" }, sessionCtx());
    expect(existsSync(NEW())).toBe(false);
    expect(existsSync(OLD())).toBe(false);
    expect((await run("settings list", p)).join("\n")).toContain(`Extension settings — ${NEW()}`);
    await p.emit("session_shutdown", { reason: "quit" }, sessionCtx());
  });

  it("child session (HOST_KEY claimed): settings files are not touched — ino and mtime unchanged, no NEW", async () => {
    seed("pi-subagent.json");
    utimesSync(OLD(), 1_700_000_000, 1_700_000_000);
    const before = statSync(OLD());
    (globalThis as Record<symbol, unknown>)[HOST_KEY] = { activatedAt: 1 };
    const p = fakePi();
    activate(p.pi);
    await p.emit("session_start", { reason: "startup" }, sessionCtx());
    const after = lstatSync(OLD());
    expect(after.isFile()).toBe(true);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(existsSync(NEW())).toBe(false);
    expect(readdirLocks(agent)).toEqual([]);
  });

  it("S6b: notify once on the first session_start only; registration sequence equals the S5 one", async () => {
    // S5 reference run
    seed("pi-toolkit.json");
    symlinkSync("pi-toolkit.json", OLD());
    const ref = fakePi();
    activate(ref.pi);
    await ref.emit("session_start", { reason: "startup" }, sessionCtx());
    await ref.emit("session_shutdown", { reason: "quit" }, sessionCtx());
    releaseGuards();

    // S6b run: two diverged regular files
    resetSettingsFiles(sb.home);
    seed("pi-toolkit.json");
    seed("pi-subagent.json", { budget: { idleS: 5 } });
    utimesSync(OLD(), 4_000_000_000, 4_000_000_000);
    const p = fakePi();
    activate(p.pi);
    const seen: string[] = [];
    const ctx = sessionCtx((m, k) => seen.push(`${k}:${m}`));
    await p.emit("session_start", { reason: "startup" }, ctx);
    await p.emit("session_start", { reason: "reload" }, ctx);
    const conflict = seen.filter((m) => m.includes("settings conflict"));
    expect(conflict).toHaveLength(1);
    expect(conflict[0]).toMatch(/^warning:/);
    expect(conflict[0]).toContain(NEW());
    expect(p.order).toEqual(ref.order); // no new pi.* registration for the notice
    expect(lstatSync(OLD()).isFile()).toBe(true); // untouched
    expect(JSON.parse(readFileSync(NEW(), "utf8")).budget.idleS).toBe(111); // NEW wins
    await p.emit("session_shutdown", { reason: "quit" }, ctx);
  });
});

function readdirLocks(dir: string): string[] {
  return readdirSync(dir).filter((n) => n.includes("lock") || n.endsWith(".lnk"));
}
