/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * jev-reflex R2b: shadow wiring of `wireReflex` (fake pi + FakeClock) and the I5 topic-switch interaction
 * against the REAL `activate()` (topic-switch hold built by the real `wireTopicSwitch`).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FakeClock } from "../../src/core/clock.js";
import { CORRECTION_WINDOW_MS, PENDING_MAX_AGE_MS, REPEAT_WINDOW_MS } from "../../src/reflex/core/budget.js";
import { DEFAULT_REFLEX_SETTINGS } from "../../src/reflex/core/settings.js";
import { wireReflex, type ReflexWireDeps } from "../../src/reflex/wire.js";

const JOBS_Q = "后台还有几个 job";
const JOBS_Q2 = "有后台任务在跑吗";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise<void>((r) => setImmediate(r));
};

interface Harness {
  pi: ExtensionAPI;
  clock: FakeClock;
  appended: Array<{ customType: string; data: any }>;
  forbidden: string[];
  handlers: Map<string, Array<(e: any, c: any) => any>>;
  commands: Map<string, any>;
  wiring: ReturnType<typeof wireReflex>;
  listCalls: { n: number };
  gitCalls: { n: number; resolvers: Array<(v: unknown) => void> };
  state: { branch: any[]; idle: boolean; pendingMessages: boolean };
  ctx(over?: Record<string, unknown>): any;
  input(text: string, over?: Record<string, unknown>, ctxOver?: Record<string, unknown>): any;
  settled(): void;
  fire(event: string): void;
  records(): any[];
  corrections(): any[];
}

const userMsg = (text: string) => ({ type: "message", message: { role: "user", content: text } });
const assistantTools = (...calls: Array<{ name: string; arguments?: unknown }>) => ({
  type: "message",
  message: { role: "assistant", content: calls.map((c) => ({ type: "toolCall", id: "t", ...c })) },
});

function harness(
  opts: {
    topic?: () => boolean;
    autoResolve?: string[];
    appendThrows?: boolean;
    gitHangs?: boolean;
  } = {},
): Harness {
  const handlers = new Map<string, Array<(e: any, c: any) => any>>();
  const commands = new Map<string, any>();
  const appended: Array<{ customType: string; data: any }> = [];
  const forbidden: string[] = [];
  const listCalls = { n: 0 };
  const gitCalls = { n: 0, resolvers: [] as Array<(v: unknown) => void> };
  const clock = new FakeClock(1_000_000);
  const state = { branch: [] as any[], idle: true, pendingMessages: false };
  const pi: any = {
    on: (event: string, h: (e: any, c: any) => any) => handlers.set(event, [...(handlers.get(event) ?? []), h]),
    registerCommand: (name: string, cmd: unknown) => commands.set(name, cmd),
    registerMessageRenderer: () => undefined,
    appendEntry: (customType: string, data: unknown) => {
      if (opts.appendThrows) throw new Error("append boom");
      appended.push({ customType, data });
    },
    sendMessage: () => forbidden.push("sendMessage"),
    sendUserMessage: () => forbidden.push("sendUserMessage"),
    triggerTurn: () => forbidden.push("triggerTurn"),
  };
  let mono = 0;
  const deps: ReflexWireDeps = {
    settings: () => ({ ...DEFAULT_REFLEX_SETTINGS, enabled: true, autoResolve: opts.autoResolve ?? [] }),
    secureDomainKind: "plain",
    ports: {
      bashJobs: () => ({
        list: () => {
          listCalls.n++;
          return [];
        },
      }),
      fleet: () => undefined,
      quota: () => undefined,
      git: ((_args: unknown, _o: unknown) => {
        gitCalls.n++;
        if (opts.gitHangs) return new Promise((res) => gitCalls.resolvers.push(res));
        return Promise.resolve({ code: 1, stdout: "", stderr: "", killed: false });
      }) as never,
    },
    fences: { topicSwitchActive: opts.topic ?? (() => false) },
    clock,
    monoNow: () => (mono += 5),
  };
  const wiring = wireReflex(pi, deps);
  const ctx = (over: Record<string, unknown> = {}) => ({
    mode: "tui",
    cwd: "/tmp/reflex-cwd",
    isIdle: () => state.idle,
    hasPendingMessages: () => state.pendingMessages,
    sessionManager: { getBranch: () => state.branch },
    ui: { notify: () => undefined },
    ...over,
  });
  const h: Harness = {
    pi: pi as ExtensionAPI,
    clock,
    appended,
    forbidden,
    handlers,
    commands,
    wiring,
    listCalls,
    gitCalls,
    state,
    ctx,
    input: (text, over = {}, ctxOver = {}) =>
      handlers.get("input")![0]!({ type: "input", text, source: "interactive", ...over }, ctx(ctxOver)),
    settled: () => handlers.get("agent_settled")![0]!({ type: "agent_settled" }, ctx()),
    fire: (event) => handlers.get(event)!.forEach((fn) => fn({ type: event }, ctx())),
    records: () => appended.filter((a) => a.customType === "subagent:reflex-record").map((a) => a.data),
    corrections: () => appended.filter((a) => a.customType === "subagent:reflex-correction").map((a) => a.data),
  };
  return h;
}

describe("R-I5 synchronous shadow", () => {
  it("returns a plain {continue} (non-thenable); the port runs only after a microtask", async () => {
    const h = harness();
    const out = h.input(JOBS_Q);
    expect(out).toEqual({ action: "continue" });
    expect(typeof (out as { then?: unknown }).then).not.toBe("function");
    expect(h.listCalls.n).toBe(0); // not synchronously
    await flush();
    expect(h.listCalls.n).toBe(1);
    expect(h.forbidden).toEqual([]);
    expect(h.appended).toEqual([]); // nothing is persisted until agent_settled
  });

  it("shadow outcome ⇒ exactly one record at agent_settled, field by field; no send/trigger APIs", async () => {
    const h = harness();
    h.input(JOBS_Q);
    await flush();
    h.state.branch = [userMsg(JOBS_Q), assistantTools({ name: "bash_job", arguments: { action: "list" } })];
    h.settled();
    h.settled(); // idempotent: the slot is empty now
    expect(h.records()).toEqual([
      {
        v: 1,
        kind: "shadow",
        at: 1_000_000,
        scriptId: "jobs.list",
        scriptVer: 1,
        state: "shadow",
        band: "high",
        requestDigest: expect.stringMatching(/^[0-9a-f]{16}$/),
        chars: [...JOBS_Q.replace(/\s+/g, " ").toLowerCase()].length,
        port: { outcome: "ok", ms: 5, portVer: 1 },
        model: { agree: "agree", tools: ["bash_job:list"] },
      },
    ]);
    expect(JSON.stringify(h.records())).not.toContain("后台还有几个");
    expect(h.forbidden).toEqual([]);
    expect(h.appended.length).toBe(1);
  });

  it("R3a: auto answers (handled, one sendMessage) while autoResolve holds the id; live removal returns to shadow-only records (no-tool / diverge)", async () => {
    const autoResolve = ["jobs.list"]; // the harness re-reads opts.autoResolve on every input (live)
    const h = harness({ autoResolve });
    const first = h.input(JOBS_Q);
    expect(typeof (first as { then?: unknown }).then).toBe("function"); // AUTO: the only thenable branch
    await expect(first).resolves.toEqual({ action: "handled" });
    expect(h.forbidden).toEqual(["sendMessage"]);
    h.settled(); // an ANSWERED question leaves no reflex-record (deep assertions: wire-auto.test.ts)
    expect(h.records()).toEqual([]);

    autoResolve.length = 0; // live removal (/agent settings): effective on the very next input
    const second = h.input(JOBS_Q2);
    expect(second).toEqual({ action: "continue" });
    expect(typeof (second as { then?: unknown }).then).not.toBe("function");
    await flush();
    h.state.branch = [userMsg(JOBS_Q2)];
    h.settled();
    h.input(JOBS_Q);
    await flush();
    h.state.branch = [userMsg(JOBS_Q), assistantTools({ name: "read", arguments: {} })];
    h.settled();
    const recs = h.records();
    expect(recs.map((r) => [r.state, r.model.agree])).toEqual([
      ["shadow", "no-tool"],
      ["shadow", "diverge"],
    ]);
    expect(recs.every((r) => r.kind === "shadow")).toBe(true);
    expect(h.forbidden).toEqual(["sendMessage"]); // shadow never answers
  });

  it("single slot: a new candidate flushes the unsettled one as unknown", async () => {
    const h = harness();
    h.input(JOBS_Q);
    h.input(JOBS_Q2);
    expect(h.records()).toHaveLength(1);
    expect(h.records()[0]).toMatchObject({ kind: "shadow", model: { agree: "unknown", tools: [] } });
    expect(h.records()[0].port).toBeUndefined(); // replaced before its port settled ⇒ result dropped
    await flush();
    h.state.branch = [userMsg(JOBS_Q2)];
    h.settled();
    expect(h.records()).toHaveLength(2);
    expect(h.records()[1].model.agree).toBe("no-tool");
  });

  it("user text in the branch not matching the pending digest ⇒ unknown", async () => {
    const h = harness();
    h.input(JOBS_Q);
    await flush();
    h.state.branch = [userMsg("something else entirely"), assistantTools({ name: "bash_job", arguments: {} })];
    h.settled();
    expect(h.records()[0].model).toEqual({ agree: "unknown", tools: [] });
  });

  it("getBranch throwing ⇒ unknown, never throws", async () => {
    const h = harness();
    h.input(JOBS_Q);
    await flush();
    const ctx = h.ctx({
      sessionManager: {
        getBranch: () => {
          throw new Error("x");
        },
      },
    });
    expect(() => h.handlers.get("agent_settled")![0]!({}, ctx)).not.toThrow();
    expect(h.records()[0].model.agree).toBe("unknown");
  });

  it("ambiguous band ⇒ kind:ambiguous record (candidates, no port run, agree unknown)", async () => {
    const h = harness();
    h.input("job");
    await flush();
    expect(h.listCalls.n).toBe(0);
    h.state.branch = [userMsg("job"), assistantTools({ name: "bash_job", arguments: { action: "list" } })];
    h.settled();
    expect(h.records()).toHaveLength(1);
    expect(h.records()[0]).toMatchObject({
      kind: "ambiguous",
      band: "ambiguous",
      candidates: ["jobs.list"],
      model: { agree: "unknown", tools: ["bash_job:list"] },
    });
    expect(h.records()[0].port).toBeUndefined();
    expect(h.wiring!.snapshot().counters.ambiguous).toBe(1);
  });

  it("miss / veto record nothing", async () => {
    const h = harness();
    for (const t of ["帮我实现一个新功能", "ok", "把后台 job 都停了", "随便聊聊天气怎么样"]) h.input(t);
    await flush();
    h.settled();
    expect(h.appended).toEqual([]);
    expect(h.listCalls.n).toBe(0);
  });

  it("PD6: same digest becomes a candidate again within the window ⇒ reasked:true; outside ⇒ not", async () => {
    const h = harness();
    h.input(JOBS_Q);
    await flush();
    h.state.branch = [userMsg(JOBS_Q)];
    h.settled();
    h.clock.advance(60_000);
    h.input(JOBS_Q);
    await flush();
    h.settled();
    h.clock.advance(REPEAT_WINDOW_MS + 1);
    h.input(JOBS_Q);
    await flush();
    h.settled();
    expect(h.records().map((r) => r.reasked)).toEqual([undefined, true, undefined]);
    expect(h.wiring!.snapshot().counters.reasked).toBe(1);
  });

  it("fail-open: a throwing ctx, a throwing appendEntry and a malformed event all yield continue", async () => {
    const h = harness();
    const bad = h.handlers.get("input")![0]!(
      { type: "input", text: JOBS_Q, source: "interactive" },
      {
        mode: "tui",
        isIdle: () => {
          throw new Error("boom");
        },
      },
    );
    expect(bad).toEqual({ action: "continue" });
    expect(h.handlers.get("input")![0]!(undefined, undefined)).toEqual({ action: "continue" });
    const h2 = harness({ appendThrows: true });
    h2.input(JOBS_Q);
    await flush();
    expect(() => h2.settled()).not.toThrow();
  });
});

describe("pending age (no timers)", () => {
  it("an over-age slot is flushed only at the next input / agent_settled entry", async () => {
    const h = harness();
    h.input(JOBS_Q);
    await flush();
    h.clock.advance(PENDING_MAX_AGE_MS + 1);
    await flush();
    expect(h.appended).toEqual([]); // clock moved, no entry called ⇒ zero appends
    h.settled();
    expect(h.records()).toHaveLength(1);
    expect(h.records()[0].model).toEqual({ agree: "unknown", tools: [] });
    expect(h.records()[0].port).toMatchObject({ outcome: "ok" });
  });

  it("an over-age slot is flushed by a later (even non-matching) input", async () => {
    const h = harness();
    h.input(JOBS_Q);
    await flush();
    h.clock.advance(PENDING_MAX_AGE_MS + 1);
    h.input("随便聊聊");
    expect(h.records()).toHaveLength(1);
    expect(h.records()[0].model.agree).toBe("unknown");
  });

  it("a slot younger than the limit survives an unrelated input", async () => {
    const h = harness();
    h.input(JOBS_Q);
    await flush();
    h.clock.advance(PENDING_MAX_AGE_MS - 1);
    h.input("随便聊聊");
    expect(h.records()).toEqual([]);
  });
});

describe("I6 / fences: zero execution, zero record", () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["rpc source", { source: "rpc" }, {}],
    ["extension source", { source: "extension" }, {}],
    ["rpc mode", {}, { mode: "rpc" }],
    ["print mode", {}, { mode: "print" }],
    ["json mode", {}, { mode: "json" }],
    ["with image", { images: [{ type: "image" }] }, {}],
    ["streaming steer", { streamingBehavior: "steer" }, {}],
    ["streaming followUp", { streamingBehavior: "followUp" }, {}],
    ["not idle", {}, { isIdle: () => false }],
    ["pending messages", {}, { hasPendingMessages: () => true }],
  ];
  it.each(cases)("%s", async (_n, evOver, ctxOver) => {
    const h = harness();
    expect(h.input(JOBS_Q, evOver, ctxOver)).toEqual({ action: "continue" });
    await flush();
    h.settled();
    expect(h.listCalls.n).toBe(0);
    expect(h.appended).toEqual([]);
    expect(h.wiring!.snapshot().counters.candidates).toBe(0);
  });

  it("topic-switch hold (fence) ⇒ veto", async () => {
    const t = harness({ topic: () => true });
    t.input(JOBS_Q);
    await flush();
    t.settled();
    expect(t.appended).toEqual([]);
    expect(t.listCalls.n).toBe(0);
  });
});

describe("PD11 shutdown / re-arm", () => {
  it("shutdown while a port is in flight ⇒ zero appends and no strike afterwards; re-armed session works", async () => {
    const h = harness({ gitHangs: true });
    h.input("git status");
    await flush();
    expect(h.gitCalls.n).toBe(1);
    const gen0 = h.wiring!.generation();
    h.fire("session_shutdown");
    // late result of the OLD session arrives after shutdown (and would be a parse error ⇒ strike if applied)
    h.gitCalls.resolvers.forEach((r) => r({ code: 0, stdout: "garbage", stderr: "", killed: false }));
    await flush();
    h.settled();
    expect(h.appended).toEqual([]);
    expect(h.wiring!.isStale(gen0)).toBe(true);

    h.fire("session_start");
    h.input("git status");
    await flush();
    expect(h.gitCalls.n).toBe(2);
    h.gitCalls.resolvers[1]!({ code: 0, stdout: "garbage", stderr: "", killed: false });
    await flush();
    h.state.branch = [userMsg("git status"), assistantTools({ name: "bash", arguments: { command: "git status" } })];
    h.settled();
    expect(h.records()).toHaveLength(1);
    expect(h.records()[0]).toMatchObject({ scriptId: "git.status", model: { agree: "agree" } });
    expect(h.records()[0].port.outcome).toBe("error"); // the NEW session's own result
    // only the new session's single error counted: one strike, not two (old late result dropped)
    expect(h.wiring!.snapshot().scripts.find((s) => s.id === "git.status")!.strikes).toBe(1);
  });

  it("shutdown drops the pending slot WITHOUT persisting it; start clears memo and the re-ask window", async () => {
    const h = harness();
    h.input(JOBS_Q);
    await flush();
    h.fire("session_shutdown");
    h.fire("session_start");
    h.settled();
    expect(h.appended).toEqual([]);

    // a settled candidate from the old session cannot trigger a correction in the new one
    h.input(JOBS_Q);
    await flush();
    h.state.branch = [userMsg(JOBS_Q)];
    h.settled();
    expect(h.records()).toHaveLength(1);
    h.fire("session_shutdown");
    h.fire("session_start");
    h.input("不对");
    expect(h.corrections()).toEqual([]);
    // and the re-ask window is per session
    h.input(JOBS_Q);
    await flush();
    h.settled();
    expect(h.records()[1]!.reasked).toBeUndefined();
  });
});

describe("PD12 correction persists in the input step", () => {
  async function candidate(h: Harness): Promise<void> {
    h.input(JOBS_Q);
    await flush();
    h.state.branch = [userMsg(JOBS_Q), assistantTools({ name: "bash_job", arguments: { action: "list" } })];
    h.settled();
  }

  it("candidate → settled → '不对' (short-reply veto) ⇒ exactly one correction entry, synchronously; repeats not re-recorded", async () => {
    const h = harness();
    await candidate(h);
    h.clock.advance(5_000);
    const before = h.appended.length;
    const out = h.input("不对");
    expect(out).toEqual({ action: "continue" });
    expect(h.appended.length).toBe(before + 1); // written before input returned
    expect(h.corrections()).toEqual([
      {
        v: 1,
        at: 1_005_000,
        targetKind: "shadow",
        targetScriptId: "jobs.list",
        targetScriptVer: 1,
        targetDigest: h.records()[0].requestDigest,
        deltaMs: 5_000,
        correctionDigest: expect.stringMatching(/^[0-9a-f]{16}$/),
      },
    ]);
    h.input("不对");
    h.input("错了");
    expect(h.corrections()).toHaveLength(1);
    expect(h.wiring!.snapshot().counters.corrected).toBe(1);
    expect(h.records()).toHaveLength(1); // the correction itself was vetoed ⇒ no record
  });

  it("outside the window, or with no candidate, nothing is recorded", async () => {
    const h = harness();
    h.input("不对");
    expect(h.corrections()).toEqual([]);
    await candidate(h);
    h.clock.advance(CORRECTION_WINDOW_MS + 1);
    h.input("不对");
    expect(h.corrections()).toEqual([]);
  });

  it("correction is skipped outside interactive TUI", async () => {
    const h = harness();
    await candidate(h);
    h.input("不对", { source: "rpc" });
    h.input("不对", {}, { mode: "print" });
    expect(h.corrections()).toEqual([]);
  });

  it("a correcting input that is ALSO a candidate still persists the correction and becomes pending", async () => {
    const h = harness();
    await candidate(h);
    h.input("不对，" + "后台还有几个 job"); // long-enough, not a strong template ⇒ miss, but correction counts
    expect(h.corrections()).toHaveLength(1);
  });
});

describe("strike accounting + /reflex reset", () => {
  it("two port errors demote the script (overlay), reset clears it", async () => {
    const h = harness();
    for (let i = 0; i < 2; i++) {
      h.input("git status");
      await flush();
      h.state.branch = [userMsg("git status")];
      h.settled();
    }
    const git = () => h.wiring!.snapshot().scripts.find((s) => s.id === "git.status")!;
    expect(git()).toMatchObject({ state: "demoted", strikes: 2, demoteReason: "strikes" });
    // demoted behaves as shadow: the next candidate is still recorded, with state:"demoted"
    h.input("git status");
    await flush();
    h.settled();
    expect(h.records().at(-1)).toMatchObject({ state: "demoted" });
    // overlay survives a session switch
    h.fire("session_shutdown");
    h.fire("session_start");
    expect(git().state).toBe("demoted");
    const notes: string[] = [];
    await h.commands.get("reflex").handler("reset git.status", { ui: { notify: (m: string) => notes.push(m) } });
    expect(git()).toMatchObject({ state: "shadow", strikes: 0 });
    expect(notes[0]).toContain("reset git.status");
  });
});

// ---------------------------------------------------------------------------------------------
// I5 against the REAL activate(): topic-switch hold built by the real wireTopicSwitch.
// ---------------------------------------------------------------------------------------------
describe("I5: topic-switch interaction (real activate())", () => {
  const HOST_KEY = Symbol.for("pi-subagent:host");
  const TRANSFER = Symbol.for("pi-subagent:topic-switch-transfer");
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-reflex-wire-home-"));
  const realHome = process.env.HOME;
  const settingsPath = join(fakeHome, ".pi", "agent", "pi-subagent.json");
  const BASE = {
    webHub: { enabled: false },
    memory: { enabled: false },
    hud: { enabled: false },
    sessionNav: { enabled: false },
    askUser: { enabled: false },
    feishuNotify: { enabled: false },
    webSearch: { enabled: false },
    todo: { enabled: false },
  };

  function reset(): void {
    delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
    delete (globalThis as Record<symbol, unknown>)[TRANSFER];
  }
  beforeEach(() => {
    process.env.HOME = fakeHome;
    reset();
  });
  afterEach(reset);
  afterAll(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(fakeHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function writeSettings(raw: unknown): void {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(raw) + "\n", "utf8");
  }

  function fakeActivatePi() {
    const handlers = new Map<string, Array<(e: any, c: any) => any>>();
    const appended: Array<{ customType: string; data: any }> = [];
    const pi: any = {
      registerTool: () => undefined,
      registerCommand: () => undefined,
      registerMessageRenderer: () => undefined,
      on: (event: string, h: (e: any, c: any) => any) => handlers.set(event, [...(handlers.get(event) ?? []), h]),
      sendMessage: () => undefined,
      sendUserMessage: () => undefined,
      appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }),
      getSessionName: () => undefined,
      setSessionName: () => undefined,
      events: { on: () => () => undefined, emit: () => undefined },
      exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
    };
    return { pi: pi as ExtensionAPI, handlers, appended };
  }

  const HI = {
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "end_turn" },
  };
  function ctxFor(branch: unknown[] = [HI]): any {
    return {
      hasUI: true,
      mode: "tui",
      cwd: fakeHome,
      isIdle: () => true,
      hasPendingMessages: () => false,
      getContextUsage: () => ({ tokens: 500_000, contextWindow: 1_000_000, percent: 50 }),
      model: {
        provider: "anthropic",
        id: "claude",
        api: "anthropic-messages",
        cost: { input: 3, cacheWrite: 3.75, tiers: [] },
      },
      modelRegistry: {
        find: () => ({ provider: "anthropic", id: "claude" }),
        complete: () => new Promise(() => undefined), // judge never answers ⇒ the hold stays
      },
      sessionManager: {
        getBranch: () => branch,
        getEntries: () => [
          {
            type: "message",
            message: {
              role: "assistant",
              model: "claude",
              provider: "anthropic",
              timestamp: Date.now() - 24 * 3_600_000,
              usage: { cacheRead: 0, cacheWrite: 0 },
            },
          },
        ],
        getSessionId: () => "s1",
      },
      ui: { setStatus: () => undefined, notify: () => undefined, setEditorText: () => undefined },
    };
  }

  const LONG = "please refactor the entire billing subsystem end to end for multi currency support";
  const TS = { topicSwitch: { enabled: true, costThresholdUsd: 0.01, judgeTimeoutS: 1, confirmTimeoutS: 1 } };

  async function scenario(reflexOn: boolean, holdFirst: boolean) {
    writeSettings({ ...BASE, ...TS, reflex: { enabled: reflexOn } });
    reset();
    const h = fakeActivatePi();
    const activate = (await import("../../src/index.js")).default;
    activate(h.pi);
    const inputs = h.handlers.get("input")!;
    const topicSwitch = inputs.at(-1)!;
    const reflex = reflexOn ? inputs.at(-2)! : undefined;
    const ctx = ctxFor();
    let first: unknown;
    if (holdFirst) first = topicSwitch({ type: "input", text: LONG, source: "interactive" }, ctx);
    const reflexOut = reflex?.({ type: "input", text: "git status", source: "interactive" }, ctx);
    const second = topicSwitch({ type: "input", text: "git status", source: "interactive" }, ctx);
    await flush();
    const branch = [userMsg("git status")];
    for (const fn of h.handlers.get("agent_settled") ?? []) {
      try {
        await fn({ type: "agent_settled" }, ctxFor(branch));
      } catch {
        /* other plugins' handlers may dislike the minimal ctx */
      }
    }
    return {
      first,
      reflexOut,
      second,
      records: h.appended.filter((a) => a.customType === "subagent:reflex-record"),
      inputCount: inputs.length,
    };
  }

  it("reflex registers right before topic-switch (one extra input handler vs off)", async () => {
    const on = await scenario(true, false);
    const off = await scenario(false, false);
    expect(on.inputCount).toBe(off.inputCount + 1);
  });

  it("control: no hold ⇒ the R layer records a git.status shadow candidate", async () => {
    const r = await scenario(true, false);
    expect(r.reflexOut).toEqual({ action: "continue" });
    expect(r.records).toHaveLength(1);
    expect(r.records[0]!.data).toMatchObject({ scriptId: "git.status", kind: "shadow" });
  });

  it("topic-switch hold active ⇒ R layer vetoes (fence-topic): zero records, and topic-switch's own result is unchanged", async () => {
    const withReflex = await scenario(true, true);
    expect(withReflex.first).toEqual({ action: "handled" }); // the hold was really created
    expect(withReflex.reflexOut).toEqual({ action: "continue" });
    expect(withReflex.records).toEqual([]);
    const withoutReflex = await scenario(false, true);
    expect(withoutReflex.first).toEqual({ action: "handled" });
    expect(withReflex.second).toEqual(withoutReflex.second); // queueing semantics identical with / without the R layer
  });

  it("topic-switch re-injection (source:'extension') is waved through by the R layer", async () => {
    writeSettings({ ...BASE, ...TS, reflex: { enabled: true } });
    reset();
    const h = fakeActivatePi();
    (await import("../../src/index.js")).default(h.pi);
    const reflex = h.handlers.get("input")!.at(-2)!;
    expect(reflex({ type: "input", text: "git status", source: "extension" }, ctxFor())).toEqual({
      action: "continue",
    });
    await flush();
    for (const fn of h.handlers.get("agent_settled") ?? []) {
      try {
        await fn({ type: "agent_settled" }, ctxFor([userMsg("git status")]));
      } catch {
        /* ignore */
      }
    }
    expect(h.appended.filter((a) => a.customType.startsWith("subagent:reflex"))).toEqual([]);
  });
});
