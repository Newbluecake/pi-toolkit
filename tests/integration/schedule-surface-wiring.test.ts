/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import activate from "../../src/index.js";

/**
 * scheduled-reports A3 — real `activate()` wiring of the session-visible surface.
 *  - schedule OFF (the default): no `schedule` tool, no status key, no `pi_schedules` section — the
 *    system prompt is byte-identical — and no `/schedule` command either (plan §1: command table unchanged);
 *  - schedule ON: the `schedule` tool exists (frozen schema), the section stays EMPTY until a task
 *    exists (bytes unchanged), a created task shows up in the system prompt as a definition-only line,
 *    the status bar appears with English tokens, and teardown clears it.
 * Runs against a throwaway $HOME (never the developer's real settings).
 */
const HOST_KEY = Symbol.for("pi-subagent:host");
const FEISHU_HOST_KEY = Symbol.for("pi-subagent:feishu-notify:host");
const fakeHome = mkdtempSync(join(tmpdir(), "pi-sched-a3-home-"));
const realHome = process.env.HOME;
process.env.HOME = fakeHome;
const settingsPath = join(fakeHome, ".pi", "agent", "pi-subagent.json");
const SID = "019a0000-aaaa-7bbb-8ccc-dddddddddddd";

type Handler = (event: any, ctx: any) => any;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const sent: any[] = [];
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
    sendMessage: (m: unknown) => void sent.push(m),
    appendEntry() {},
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
  };
  return { pi: pi as unknown as ExtensionAPI, handlers, commands, tools, sent };
}

function writeSettings(raw: unknown): void {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(raw, null, 2) + "\n", "utf8");
}

function ctxOf(statuses: Array<[string, string | undefined]>) {
  return {
    mode: "rpc", // interactive per the §3.3 matrix, and skips the TUI-only editor wrappers
    hasUI: false,
    cwd: fakeHome,
    isIdle: () => true,
    sessionManager: {
      getEntries: () => [],
      getBranch: () => [],
      getSessionId: () => SID,
      getSessionFile: () => join(fakeHome, "s.jsonl"),
      getSessionDir: () => fakeHome,
    },
    modelRegistry: { getAvailable: () => [], getAll: () => [], find: () => undefined },
    ui: {
      setWidget: () => undefined,
      setStatus: (k: string, v: string | undefined) => void statuses.push([k, v]),
      notify: () => undefined,
    },
  };
}

async function emit(h: ReturnType<typeof fakePi>, event: string, payload: unknown, ctx: unknown): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const fn of h.handlers.get(event) ?? []) out.push(await fn(payload, ctx));
  return out;
}

/** Fold the system prompt through every `before_agent_start` handler, like pi does. */
async function systemPromptFor(h: ReturnType<typeof fakePi>, ctx: unknown): Promise<string> {
  let prompt = "BASE";
  for (const fn of h.handlers.get("before_agent_start") ?? []) {
    const r = await fn(
      { type: "before_agent_start", prompt: "go", systemPrompt: prompt, systemPromptOptions: {} },
      ctx,
    );
    if (r?.systemPrompt !== undefined) prompt = r.systemPrompt;
  }
  return prompt;
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

// Everything unrelated to the feature is switched off so the fake ctx stays small (HUD footer, session-nav…).
const baseline = {
  webHub: { enabled: false },
  memory: { enabled: false },
  hud: { enabled: false },
  sessionNav: { enabled: false },
  askUser: { enabled: false },
  feishuNotify: { enabled: false },
  webSearch: { enabled: false },
  todo: { enabled: false },
};

describe("schedule surface — OFF (default)", () => {
  it("no tool, no /schedule command; system prompt bytes equal the pre-feature output", async () => {
    writeSettings({ ...baseline });
    const off = fakePi();
    activate(off.pi);
    expect(off.tools.has("schedule")).toBe(false);
    expect(off.commands.has("schedule")).toBe(false);

    const statuses: Array<[string, string | undefined]> = [];
    const ctx = ctxOf(statuses);
    await emit(off, "session_start", { type: "session_start", reason: "startup" }, ctx);
    const promptOff = await systemPromptFor(off, ctx);
    expect(statuses.filter(([k]) => k.includes("schedule"))).toEqual([]);
    await emit(off, "session_shutdown", { type: "session_shutdown" }, ctx);

    // The same activation with the feature ON but no task: byte-identical prompt (the section is empty).
    delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
    delete (globalThis as Record<symbol, unknown>)[FEISHU_HOST_KEY];
    writeSettings({ ...baseline, schedule: { enabled: true, dir: join(fakeHome, "sched-on") } });
    const on = fakePi();
    activate(on.pi);
    const ctx2 = ctxOf([]);
    await emit(on, "session_start", { type: "session_start", reason: "startup" }, ctx2);
    expect(await systemPromptFor(on, ctx2)).toBe(promptOff);
    await emit(on, "session_shutdown", { type: "session_shutdown" }, ctx2);
  });

  it("the handler footprint of ENABLING the feature over the OFF baseline (which already carries the orphan guard) is pinned", () => {
    writeSettings({ ...baseline });
    const off = fakePi();
    activate(off.pi);
    delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
    delete (globalThis as Record<symbol, unknown>)[FEISHU_HOST_KEY];
    writeSettings({ ...baseline, schedule: { enabled: true, dir: join(fakeHome, "sched-fp") } });
    const on = fakePi();
    activate(on.pi);
    const diff: Record<string, number> = {};
    for (const [event, fns] of on.handlers) {
      const d = fns.length - (off.handlers.get(event)?.length ?? 0);
      if (d !== 0) diff[event] = d;
    }
    // A3: +2 turn_start (A0 clock poke, status bar), +1 agent_settled (status/digest). I1: the A2 message scheduler's
    // fence/ui-prompt/input/run-lifecycle hooks and the A1 notes `agent_settled` hook (before_agent_start/context
    // are present OFF already — the guard — so they do not diff).
    expect(diff).toEqual({
      agent_settled: 2,
      agent_start: 1,
      input: 1,
      message_end: 1,
      message_start: 1,
      session_before_compact: 1,
      session_before_fork: 1,
      session_before_switch: 1,
      session_before_tree: 1,
      session_compact: 1,
      session_compact_failed: 1,
      session_shutdown: 1,
      session_start: 1,
      session_tree: 1,
      turn_start: 2,
      ui_prompt_end: 1,
      ui_prompt_start: 1,
    });
    expect([...on.tools.keys()].filter((k) => !off.tools.has(k))).toEqual(["schedule"]);
  });
});

describe("schedule surface — ON", () => {
  it("tool creates a pending task → section line in the system prompt, status bar token, cleared on shutdown", async () => {
    writeSettings({ ...baseline, schedule: { enabled: true, dir: join(fakeHome, "sched-live") } });
    const h = fakePi();
    activate(h.pi);
    const statuses: Array<[string, string | undefined]> = [];
    const ctx = ctxOf(statuses);
    await emit(h, "session_start", { type: "session_start", reason: "startup" }, ctx);
    const empty = await systemPromptFor(h, ctx);
    expect(empty).not.toContain("Scheduled tasks");

    const tool = h.tools.get("schedule");
    const r = await tool.execute(
      "c1",
      { action: "create", name: "daily", cron: "0 8 * * *", tz: "Asia/Shanghai", prompt: "summarize" },
      undefined,
      undefined,
      ctx,
    );
    expect(r.details).toMatchObject({ ok: true, pending: true });

    // status bar refreshes on the next turn_start
    await emit(h, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);
    const sched = () => statuses.filter(([k]) => k === "pi-subagent:schedule");
    expect(sched().at(-1)).toEqual(["pi-subagent:schedule", "sched 1 · pending 1"]);

    // the frozen system prompt does not change mid-session; the definition arrives as a tail message
    const same = await systemPromptFor(h, ctx);
    expect(same).toBe(empty);

    await emit(h, "session_shutdown", { type: "session_shutdown" }, ctx);
    expect(sched().at(-1)).toEqual(["pi-subagent:schedule", undefined]);
  });

  it("a NEW session (cold start) with a task on disk shows it in the system prompt; a different session id does not", async () => {
    const dir = join(fakeHome, "sched-cold");
    writeSettings({ ...baseline, schedule: { enabled: true, dir } });
    const first = fakePi();
    activate(first.pi);
    const ctx = ctxOf([]);
    await emit(first, "session_start", { type: "session_start", reason: "startup" }, ctx);
    await first.tools
      .get("schedule")
      .execute(
        "c1",
        { action: "create", name: "daily", cron: "0 8 * * *", tz: "UTC", prompt: "p" },
        undefined,
        undefined,
        ctx,
      );
    await emit(first, "session_shutdown", { type: "session_shutdown" }, ctx);

    delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
    delete (globalThis as Record<symbol, unknown>)[FEISHU_HOST_KEY];
    const second = fakePi();
    activate(second.pi);
    const ctx2 = ctxOf([]);
    await emit(second, "session_start", { type: "session_start", reason: "startup" }, ctx2);
    const prompt = await systemPromptFor(second, ctx2);
    expect(prompt).toMatch(
      /## Scheduled tasks \(pi-subagent\)\n.*\n- s_[a-z2-7]{8} "daily" · cron "0 8 \* \* \*" UTC · background · feishu · pending$/s,
    );
    await emit(second, "session_shutdown", { type: "session_shutdown" }, ctx2);

    // another session id (fork / new session) owns no tasks ⇒ empty section, prompt bytes as without the feature
    delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
    delete (globalThis as Record<symbol, unknown>)[FEISHU_HOST_KEY];
    const third = fakePi();
    activate(third.pi);
    const ctx3: any = ctxOf([]);
    ctx3.sessionManager.getSessionId = () => "019a9999-aaaa-7bbb-8ccc-eeeeeeeeeeee";
    await emit(third, "session_start", { type: "session_start", reason: "fork" }, ctx3);
    expect(await systemPromptFor(third, ctx3)).not.toContain("Scheduled tasks");
    await emit(third, "session_shutdown", { type: "session_shutdown" }, ctx3);
  });
});
