/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Activation call-trace golden (B tier contract; docs/dev/source-governance/batch2-plan.md §3.1).
 *
 * pi dispatches the handlers of one event in REGISTRATION order, so I3 (pre/post-guard), "deferred reload after
 * session-nav", "topic-switch input last" all depend on the order of `pi.on / registerTool / ...` inside
 * `activate()`. The other goldens only pin tool order, command order and per-event handler COUNTS.
 *
 * Phase 1: the ordered calls of a real `activate()` on a recording pi (declared profiles).
 * Phase 2: the externally visible calls (`sendMessage`, `appendEntry`, `setStatus`, `setWidget`, `notify`,
 *          `addAutocompleteProvider`) of session_start(startup) → session_shutdown(new) → session_start(new).
 * `count` / `phase2Count` are asserted separately from the arrays.
 *
 * Refresh ONLY when a registration is added/changed on purpose and say why in the commit:
 *   PI_TOOLKIT_UPDATE_TRACE=1 npx vitest run tests/governance
 * Governance refactors (source-governance batch 2) must NOT refresh it.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import activate from "../../src/index.js";
import { resetSecureDomainForTests } from "../../src/secure/domain.js";
import { traceActivation } from "../helpers/activation-trace.js";
import { fakeCtx, resetGlobals, sandbox, HOST_KEY } from "../integration/helpers/schedule-activate.js";
import { PROFILES, type ProfileName } from "./trace-profiles.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/governance/activate-trace.json", import.meta.url));
const UPDATE = process.env.PI_TOOLKIT_UPDATE_TRACE === "1";

interface Entry {
  calls: string[];
  count: number;
  phase2: string[];
  phase2Count: number;
}
const PHASE2_METHODS = [
  "sendMessage",
  "appendEntry",
  "ui.setStatus",
  "ui.setWidget",
  "ui.addAutocompleteProvider",
  "ui.notify",
];

afterEach(() => {
  resetGlobals();
  resetSecureDomainForTests();
});

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function record(name: ProfileName, historicalOff = false): Promise<Entry> {
  const profile = PROFILES[name];
  const box = sandbox("pi-trace-");
  try {
    resetGlobals();
    resetSecureDomainForTests();
    const settings = profile.settings as { memory?: object };
    box.writeSettings(
      historicalOff
        ? {
            ...settings,
            fast: { enabled: false },
            memory: { ...settings.memory, scopes: { session: false, hub: false } },
          }
        : settings,
    );
    if (profile.child) (globalThis as Record<symbol, unknown>)[HOST_KEY] = { activatedAt: 1 };
    const handlers = new Map<string, Array<(e: unknown, c: unknown) => unknown>>();
    const trace = traceActivation(activate, {
      ...(profile.omit ? { omit: profile.omit } : {}),
      onHandler: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    });
    const calls = [...trace.calls];
    const entry: Entry = { calls, count: calls.length, phase2: [], phase2Count: 0 };
    if (!profile.phase2) return entry;
    const ui = (method: string, arg: unknown, extra?: string) => {
      trace.calls.push(`ui.${method}(${typeof arg === "string" ? arg : ""}${extra ?? ""})`);
    };
    const { ctx } = fakeCtx(box.home, { mode: "rpc" });
    ctx.hasUI = true;
    ctx.ui = {
      setWidget: (key: string, content: unknown) => ui("setWidget", key, content === undefined ? ":clear" : ":set"),
      setStatus: (key: string, text: unknown) => ui("setStatus", key, text === undefined ? ":clear" : ":set"),
      notify: (_m: string, level?: string) => ui("notify", level ?? "info"),
      addAutocompleteProvider: () => ui("addAutocompleteProvider", ""),
      confirm: async () => true,
      input: async () => undefined,
    };
    const mark = trace.calls.length;
    const fire = async (event: string, payload: unknown) => {
      for (const fn of handlers.get(event) ?? []) await fn(payload, ctx);
      await tick();
      await tick();
    };
    await fire("session_start", { type: "session_start", reason: "startup" });
    await fire("session_shutdown", { type: "session_shutdown", reason: "new" });
    await fire("session_start", { type: "session_start", reason: "new" });
    await fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
    entry.phase2 = trace.calls.slice(mark).filter((c) => PHASE2_METHODS.some((m) => c.startsWith(`${m}(`)));
    entry.phase2Count = entry.phase2.length;
    return entry;
  } finally {
    resetGlobals();
    resetSecureDomainForTests();
    box.cleanup();
  }
}

describe("activation call-trace golden", () => {
  const names = Object.keys(PROFILES) as ProfileName[];
  it("explicit fast:false and scopes-off retain the historical SDK1.5 trace bytes", async () => {
    const actual: Record<string, Entry> = {};
    const historicalNames = names.filter((name) => name !== "scopes-on-child");
    for (const name of historicalNames) actual[name] = await record(name, true);
    const golden = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, Entry>;
    for (const name of historicalNames)
      expect(actual[name], name).toEqual(golden[name === "default" ? "fast-disabled" : name]);
    // Optional pre-implementation capture: never regenerate it after wiring. Includes all seven old profiles.
    const path = process.env.PI_TOOLKIT_FAST_OFF_BASELINE;
    if (path) {
      const before = JSON.parse(readFileSync(path, "utf8")) as Record<string, Entry>;
      expect(Object.keys(before)).toHaveLength(7);
      for (const name of Object.keys(before))
        expect(JSON.stringify(actual[name]), name).toBe(JSON.stringify(before[name]));
    }
  });

  it("matches the stored trace for every profile", async () => {
    const actual: Record<string, Entry> = {};
    for (const name of names) actual[name] = await record(name);
    if (UPDATE) {
      mkdirSync(dirname(FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, JSON.stringify(actual, null, 2) + "\n");
    }
    const golden = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, Entry>;
    expect(Object.keys(golden).sort()).toEqual([...names].sort());
    for (const name of names) {
      const g = golden[name]!;
      const a = actual[name]!;
      expect(a.count, `${name} call count`).toBe(g.count);
      expect(a.phase2Count, `${name} phase-2 call count`).toBe(g.phase2Count);
      expect(a.calls, `${name} phase 1`).toEqual(g.calls);
      expect(a.phase2, `${name} phase 2`).toEqual(g.phase2);
      expect(g.calls.length).toBe(g.count);
      expect(g.phase2.length).toBe(g.phase2Count);
    }
  });

  it("default scopes-on child registers its receiver but no human proof hooks", async () => {
    const child = await record("scopes-on-child");
    expect(child.calls.slice(0, 3)).toEqual([
      "events.on(subagent:memory-bind)",
      "on(session_tree)",
      "registerTool(scoped_memory)",
    ]);
    expect(child.calls.filter((c) => c === "registerTool(scoped_memory)")).toHaveLength(1);
    expect(child.calls).not.toContain("on(input)");
    expect(child.calls).not.toContain("on(agent_start)");
  });

  it("is deterministic across two recordings", async () => {
    for (const name of names) expect(await record(name), name).toEqual(await record(name));
  });

  it("compat-failure ends with the stub tool and never reaches post-guard wiring", async () => {
    const e = await record("compat-failure");
    expect(e.calls).toContain("registerTool(Agent)");
    expect(e.calls.some((c) => c === "registerCommand(agent)")).toBe(false);
  });

  it("fabric-thread arch §9.3 (P3): thread-main registers `thread` right after the fabric tool group; thread-child gains no registration", async () => {
    const main = await record("thread-main");
    const child = await record("thread-child");
    // 主会话：post-guard 的 thread 工具 + /thread 命令都存在，且 registerTool(thread) 紧跟
    // message_channel（无则应跟在 fabric 工具组末尾——thread-main 恒开 channel，取前一分支）。
    expect(main.calls).toContain("registerTool(thread)");
    expect(main.calls).toContain("registerCommand(thread)");
    const mc = main.calls.findIndex((c) => c === "registerTool(message_channel)");
    expect(mc).toBeGreaterThanOrEqual(0);
    const thread = main.calls.findIndex((c) => c === "registerTool(thread)");
    expect(thread).toBeGreaterThan(mc);
    expect(main.calls.slice(mc + 1, thread).filter((c) => c.startsWith("registerTool("))).toEqual([]);
    // 子会话：thread 工具走 customTools 注入（runtime-adapter），不经 registerTool ——
    // activation 零新增注册（§9.2；thread-child 的完整 trace 由上面的 golden 比对钉住）。
    expect(child.calls.some((c) => c === "registerTool(thread)" || c === "registerCommand(thread)")).toBe(false);
  });
});
