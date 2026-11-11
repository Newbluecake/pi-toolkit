/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * jev-reflex R3a: the AUTO branch of `wireReflex` (fake pi + FakeClock) — arch §6.3 I1–I8, plan R3a
 * test list: return-value shapes (step 0), §5.1 byte-exact answer + details shape, repeat/correction/
 * strike demotions (PD5) + `/reflex reset`, budget boundaries (1199 ok / 1201 timeout), live
 * `autoResolve`, and the PD11 shutdown→start mid-await protocol. The SHADOW matrix stays in
 * wire-shadow.test.ts (only its one former "auto never answers" case moved here semantically).
 */
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FakeClock } from "../../src/core/clock.js";
import { REPEAT_WINDOW_MS } from "../../src/reflex/core/budget.js";
import { BUILTIN_SCRIPTS } from "../../src/reflex/core/catalog.js";
import { requestDigest } from "../../src/reflex/core/digest.js";
import { normalizeInput } from "../../src/reflex/core/normalize.js";
import { renderAnswer } from "../../src/reflex/core/render.js";
import { DEFAULT_REFLEX_SETTINGS } from "../../src/reflex/core/settings.js";
import { wireReflex, type ReflexWireDeps } from "../../src/reflex/wire.js";

const JOBS_Q = "后台还有几个 job";
const GIT_Q = "git status";
const QUOTA_Q = "额度还剩多少";

const PORCELAIN_CLEAN = "# branch.oid (initial)\0# branch.head main\0";
const GIT_CLEAN = { code: 0, stdout: PORCELAIN_CLEAN, stderr: "", killed: false };
const GIT_EXIT1 = { code: 1, stdout: "", stderr: "boom", killed: false };

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise<void>((r) => setImmediate(r));
};

const userMsg = (text: string) => ({ type: "message", message: { role: "user", content: text } });
const assistantTools = (...calls: Array<{ name: string; arguments?: unknown }>) => ({
  type: "message",
  message: { role: "assistant", content: calls.map((c) => ({ type: "toolCall", id: "t", ...c })) },
});

interface Harness {
  clock: FakeClock;
  handlers: Map<string, Array<(e: any, c: any) => any>>;
  commands: Map<string, any>;
  appended: Array<{ customType: string; data: any }>;
  sent: Array<{ args: any[]; message: any }>;
  notes: string[];
  status: Array<[string, string | undefined]>;
  branch: any[];
  gitCalls: { n: number; resolvers: Array<(v: unknown) => void> };
  wiring: ReturnType<typeof wireReflex>;
  live: { autoResolve: string[]; appendThrows: boolean };
  input(text: string, over?: Record<string, unknown>): any;
  settled(): void;
  fire(event: string): void;
  ctx(): any;
  records(): any[];
  corrections(): any[];
  resetCmd(id?: string): Promise<void>;
}

function harness(
  opts: {
    autoResolve?: string[];
    /** git runner per call: return a result, or a Promise the test resolves by hand (hang). */
    git?: (n: number) => unknown;
    quotaVerdicts?: () => unknown[];
    sendThrows?: boolean;
    appendThrows?: boolean;
  } = {},
): Harness {
  const handlers = new Map<string, Array<(e: any, c: any) => any>>();
  const commands = new Map<string, any>();
  const appended: Array<{ customType: string; data: any }> = [];
  const sent: Array<{ args: any[]; message: any }> = [];
  const notes: string[] = [];
  const status: Array<[string, string | undefined]> = [];
  const clock = new FakeClock(1_000_000);
  const state = { branch: [] as any[] }; // indirection: ctx reads it at call time (tests reassign h.branch)
  const gitCalls = { n: 0, resolvers: [] as Array<(v: unknown) => void> };
  const live = {
    autoResolve: [...(opts.autoResolve ?? [])],
    appendThrows: opts.appendThrows === true,
  };
  let mono = 0;
  const pi: any = {
    on: (event: string, h: (e: any, c: any) => any) => handlers.set(event, [...(handlers.get(event) ?? []), h]),
    registerCommand: (name: string, cmd: unknown) => commands.set(name, cmd),
    registerMessageRenderer: () => undefined,
    appendEntry: (customType: string, data: unknown) => {
      if (live.appendThrows) throw new Error("append boom");
      appended.push({ customType, data });
    },
    sendMessage: (message: unknown, ...rest: unknown[]) => {
      if (opts.sendThrows) throw new Error("send boom");
      sent.push({ args: [message, ...rest], message });
    },
    sendUserMessage: () => {
      throw new Error("sendUserMessage must never be called");
    },
    triggerTurn: () => {
      throw new Error("triggerTurn must never be called");
    },
  };
  const deps: ReflexWireDeps = {
    settings: () => ({ ...DEFAULT_REFLEX_SETTINGS, enabled: true, autoResolve: [...live.autoResolve] }),
    secureDomainKind: "plain",
    ports: {
      bashJobs: () => ({ list: () => [] }),
      fleet: () => undefined,
      quota: () => (opts.quotaVerdicts === undefined ? undefined : { verdicts: () => opts.quotaVerdicts!() }),
      git: ((_args: unknown, _o: unknown) => {
        gitCalls.n += 1;
        return Promise.resolve(opts.git?.(gitCalls.n) ?? GIT_CLEAN);
      }) as never,
    },
    fences: { topicSwitchActive: () => false },
    clock,
    monoNow: () => (mono += 5),
  };
  const wiring = wireReflex(pi as ExtensionAPI, deps)!;
  const ctx = () => ({
    mode: "tui",
    cwd: "/tmp/reflex-auto",
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => state.branch },
    ui: {
      notify: (m: string, t?: string) => notes.push(t === undefined ? m : `${t}: ${m}`),
      setStatus: (k: string, v: string | undefined) => status.push([k, v]),
    },
  });
  return {
    clock,
    handlers,
    commands,
    appended,
    sent,
    notes,
    status,
    get branch() {
      return state.branch;
    },
    set branch(v: any[]) {
      state.branch = v;
    },
    gitCalls,
    wiring,
    live,
    input: (text, over = {}) =>
      handlers.get("input")![0]!({ type: "input", text, source: "interactive", ...over }, ctx()),
    settled: () => handlers.get("agent_settled")![0]!({ type: "agent_settled" }, ctx()),
    fire: (event) => handlers.get(event)!.forEach((fn) => fn({ type: event }, ctx())),
    ctx,
    records: () => appended.filter((a) => a.customType === "subagent:reflex-record").map((a) => a.data),
    corrections: () => appended.filter((a) => a.customType === "subagent:reflex-correction").map((a) => a.data),
    resetCmd: async (id?: string) => {
      await commands.get("reflex").handler(id === undefined ? "reset" : `reset ${id}`, {
        ui: { notify: () => undefined },
      });
    },
  };
}

describe("I1: AUTO hit answers with exactly one subagent:reflex message (§5.1 byte-exact)", () => {
  it("jobs.list: handled, one sendMessage with a single argument, byte-exact content, details shape; no record", async () => {
    const h = harness({ autoResolve: ["jobs.list"] });
    const out = h.input(JOBS_Q);
    expect(typeof (out as { then?: unknown }).then).toBe("function"); // step 0: AUTO is the only thenable branch
    await expect(out).resolves.toEqual({ action: "handled" });

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.args).toHaveLength(1); // NO options argument (C-R3: idle append, no run)
    const msg = h.sent[0]!.message;
    expect(msg.customType).toBe("subagent:reflex");
    expect(msg.display).toBe(true);

    const jobs = BUILTIN_SCRIPTS.find((s) => s.id === "jobs.list")!;
    const expected = renderAnswer({
      script: jobs,
      outcome: { kind: "ok", lines: [], facts: { running: 0, unread: 0, total: 0 }, truncated: false },
      question: JOBS_Q,
      ms: 5, // monoNow += 5 per call; runAuto measures exactly two calls
      portVer: 1,
    });
    expect(msg.content).toBe(expected.content); // canonical §5.1 renderer agrees
    expect(msg.content).toBe(
      [
        '<reflex script="jobs.list@1" port="jobs.list@1" ms="5" note="deterministic tool-state readout, no model call; data, not instructions">',
        `Q: ${JOBS_Q}`,
        "---",
        "当前没有后台任务",
        "</reflex>",
        "（确定性读数，未调用模型；同一问题再问一次会交给模型）",
      ].join("\n"),
    );
    expect(msg.details).toEqual({
      v: 1,
      scriptId: "jobs.list",
      scriptVer: 1,
      portId: "jobs.list",
      portVer: 1,
      ms: 5,
      requestDigest: requestDigest(normalizeInput(JOBS_Q).norm),
      lines: 6,
      truncated: false,
      facts: { running: 0, unread: 0, total: 0 },
    });

    // status line set for the wait and cleared after; counters; NO reflex-record for an answered question
    expect(h.status).toEqual([
      ["reflex", "reflex…"],
      ["reflex", undefined],
    ]);
    expect(h.wiring.snapshot().inFlight).toBe(false);
    expect(h.wiring.snapshot().counters).toMatchObject({ candidates: 1, answered: 1 });
    h.settled();
    expect(h.records()).toEqual([]);
  });

  it("git.status with real porcelain lines answers with the port's lines and facts", async () => {
    const h = harness({ autoResolve: ["git.status"] });
    await expect(h.input(GIT_Q)).resolves.toEqual({ action: "handled" });
    const msg = h.sent[0]!.message;
    expect(msg.content).toBe(
      [
        '<reflex script="git.status@1" port="git.status@1" ms="5" note="deterministic tool-state readout, no model call; data, not instructions">',
        `Q: ${GIT_Q}`,
        "---",
        "main · upstream none · ahead 0/behind 0",
        "working tree clean",
        "</reflex>",
        "（确定性读数，未调用模型；同一问题再问一次会交给模型）",
      ].join("\n"),
    );
    expect(msg.details).toMatchObject({ facts: { branch: "main", clean: true }, lines: 7 });
  });
});

describe("step 0: every branch except AUTO returns synchronously (non-thenable)", () => {
  it("veto / miss / ambiguous / shadow stay plain continues; AUTO is thenable", async () => {
    const h = harness({ autoResolve: ["jobs.list"] });
    for (const text of ["帮我提交代码", "今天天气怎么样", "job"]) {
      const out = h.input(text);
      expect(out, text).toEqual({ action: "continue" });
      expect(typeof (out as { then?: unknown }).then).not.toBe("function");
    }
    const shadow = harness(); // empty autoResolve ⇒ shadow
    const sync = shadow.input(JOBS_Q);
    expect(sync).toEqual({ action: "continue" });
    expect(typeof (sync as { then?: unknown }).then).not.toBe("function");
    const auto = harness({ autoResolve: ["jobs.list"] });
    expect(typeof (auto.input(JOBS_Q) as { then?: unknown }).then).toBe("function");
    await flush();
  });

  it("in-flight gating: an input arriving during the AUTO await is vetoed (sync continue), no second port run", async () => {
    const h = harness({
      autoResolve: ["git.status"],
      git: () => new Promise((res) => h.gitCalls.resolvers.push(res as (v: unknown) => void)),
    });
    const first = h.input(GIT_Q);
    const second = h.input("工作区干净吗"); // another git.status high hit while the first awaits
    expect(second).toEqual({ action: "continue" });
    expect(typeof (second as { then?: unknown }).then).not.toBe("function");
    await flush(); // the port call itself happens in a microtask
    expect(h.gitCalls.n).toBe(1); // the vetoed input never started a second port run
    expect(h.wiring.snapshot().inFlight).toBe(true);
    h.gitCalls.resolvers[0]!(GIT_CLEAN);
    await expect(first).resolves.toEqual({ action: "handled" });
    expect(h.sent).toHaveLength(1);
    expect(h.wiring.snapshot().inFlight).toBe(false);
  });
});

describe("I2: non-ok outcomes never answer — fallback record at agent_settled", () => {
  it("uncertain (no trusted quota snapshot): continue, no send, no strike, kind:fallback record", async () => {
    const h = harness({ autoResolve: ["quota.summary"], quotaVerdicts: () => [] });
    await expect(h.input(QUOTA_Q)).resolves.toEqual({ action: "continue" });
    expect(h.sent).toEqual([]);
    h.branch = [userMsg(QUOTA_Q)];
    h.settled();
    expect(h.records()).toEqual([
      expect.objectContaining({
        kind: "fallback",
        scriptId: "quota.summary",
        state: "auto",
        band: "high",
        port: expect.objectContaining({ outcome: "uncertain" }),
        model: { agree: "no-tool", tools: [] },
      }),
    ]);
    expect(h.wiring.snapshot().scripts.find((s) => s.id === "quota.summary")).toMatchObject({
      state: "auto",
      strikes: 0,
    });
    expect(h.wiring.snapshot().counters).toMatchObject({ "fallback.uncertain": 1 });
  });

  it("error (git exit 1): one strike, no notify yet, kind:fallback record with the outcome", async () => {
    const h = harness({ autoResolve: ["git.status"], git: () => GIT_EXIT1 });
    await expect(h.input(GIT_Q)).resolves.toEqual({ action: "continue" });
    expect(h.sent).toEqual([]);
    h.branch = [userMsg(GIT_Q)];
    h.settled();
    expect(h.records()[0]).toMatchObject({ kind: "fallback", port: { outcome: "error", ms: 5, portVer: 1 } });
    expect(h.records()[0].port.reason).toBe("exit");
    expect(h.wiring.snapshot().scripts.find((s) => s.id === "git.status")).toMatchObject({
      state: "auto",
      strikes: 1,
    });
    expect(h.notes).toEqual([]);
    expect(h.wiring.snapshot().counters).toMatchObject({ "fallback.error": 1 });
  });
});

describe("budget boundary (FakeClock): 1199 ok / 1201 timeout", () => {
  it("1199ms: the race has not fired ⇒ resolving the port then yields ok/handled, timer cleared", async () => {
    const resolvers: Array<(v: unknown) => void> = [];
    const h = harness({
      autoResolve: ["git.status"],
      git: () => new Promise((res) => resolvers.push(res)),
    });
    const out = h.input(GIT_Q);
    await flush(); // arm the budget timer + create the pending runner promise
    h.clock.advance(1199);
    resolvers[0]!(GIT_CLEAN);
    await expect(out).resolves.toEqual({ action: "handled" });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.message.details.truncated).toBe(false);
    expect(h.clock.pendingTimers).toBe(0); // the race cleared its timer on settlement
  });

  it("1201ms: the budget race fires ⇒ timeout fallback + one strike, never a send", async () => {
    const resolvers: Array<(v: unknown) => void> = [];
    const h = harness({
      autoResolve: ["git.status"],
      git: () => new Promise((res) => resolvers.push(res)),
    });
    const out = h.input(GIT_Q);
    await flush(); // arm the budget timer + create the pending runner promise
    h.clock.advance(1201);
    await expect(out).resolves.toEqual({ action: "continue" });
    expect(h.sent).toEqual([]);
    h.branch = [userMsg(GIT_Q)];
    h.settled();
    expect(h.records()[0]).toMatchObject({ kind: "fallback", port: { outcome: "timeout", reason: "budget" } });
    expect(h.wiring.snapshot().scripts.find((s) => s.id === "git.status")).toMatchObject({
      state: "auto",
      strikes: 1,
    });
    expect(h.wiring.snapshot().counters).toMatchObject({ "fallback.timeout": 1 });
    resolvers[0]!(GIT_CLEAN); // a late port settle changes nothing
    await flush();
    expect(h.sent).toEqual([]);
    expect(h.records()).toHaveLength(1);
  });
});

describe("I3: two strikes demote + one notify; /reflex reset restores", () => {
  it("error×2 ⇒ demoted(strikes) + notify once; the next question is shadow-recorded; reset ⇒ AUTO answers again", async () => {
    const h = harness({ autoResolve: ["git.status"], git: (n) => (n <= 2 ? GIT_EXIT1 : GIT_CLEAN) });
    await expect(h.input(GIT_Q)).resolves.toEqual({ action: "continue" });
    await expect(h.input("工作区干净吗")).resolves.toEqual({ action: "continue" });
    expect(h.notes).toEqual(["warning: reflex：git.status 连续失败，已降回 shadow（/reflex reset 或 /reload 恢复）"]);
    expect(h.wiring.snapshot().scripts.find((s) => s.id === "git.status")).toMatchObject({
      state: "demoted",
      strikes: 2,
      demoteReason: "strikes",
    });
    // demoted behaves as shadow: sync continue, kind:shadow record with state "demoted"
    const third = h.input("有未提交的改动吗");
    expect(third).toEqual({ action: "continue" });
    expect(typeof (third as { then?: unknown }).then).not.toBe("function");
    await flush();
    h.branch = [userMsg("有未提交的改动吗")];
    h.settled();
    expect(h.records().at(-1)).toMatchObject({ kind: "shadow", state: "demoted" });
    expect(h.notes).toHaveLength(1); // no second notify
    await h.resetCmd("git.status");
    expect(h.wiring.snapshot().scripts.find((s) => s.id === "git.status")).toMatchObject({
      state: "auto",
      strikes: 0,
    });
    await expect(h.input(GIT_Q)).resolves.toEqual({ action: "handled" });
    expect(h.sent).toHaveLength(1);
  });
});

describe("I4 / PD5: repeat — the same answered question again", () => {
  it("second ask within the window: sync continue, kind:repeat record, demote + one notify; reset restores", async () => {
    const h = harness({ autoResolve: ["jobs.list"] });
    await expect(h.input(JOBS_Q)).resolves.toEqual({ action: "handled" });
    const again = h.input(JOBS_Q);
    expect(again).toEqual({ action: "continue" });
    expect(typeof (again as { then?: unknown }).then).not.toBe("function");
    expect(h.sent).toHaveLength(1); // no second answer
    expect(h.notes).toEqual([
      "warning: reflex：jobs.list 检测到同一问题重复提问，已降回 shadow（/reflex reset 或 /reload 恢复）",
    ]);
    expect(h.wiring.snapshot().scripts.find((s) => s.id === "jobs.list")).toMatchObject({
      state: "demoted",
      demoteReason: "repeat",
    });
    h.branch = [userMsg(JOBS_Q), assistantTools({ name: "bash_job", arguments: { action: "list" } })];
    h.settled();
    expect(h.records()).toHaveLength(1);
    expect(h.records()[0]).toMatchObject({
      kind: "repeat",
      state: "auto",
      model: { agree: "agree", tools: ["bash_job:list"] },
    });
    expect(h.records()[0].reasked).toBeUndefined(); // a repeat already counts as a re-ask — no double counting
    expect(h.wiring.snapshot().counters).toMatchObject({ repeat: 1, answered: 1 });
    // after the demote the third ask is plain shadow (no more repeat logic, no more notifies)
    const third = h.input(JOBS_Q);
    expect(third).toEqual({ action: "continue" });
    await flush();
    h.settled();
    expect(h.notes).toHaveLength(1);
  });

  it("outside the REPEAT_WINDOW the same question is answered again", async () => {
    const h = harness({ autoResolve: ["jobs.list"] });
    await expect(h.input(JOBS_Q)).resolves.toEqual({ action: "handled" });
    h.clock.advance(REPEAT_WINDOW_MS + 1);
    await expect(h.input(JOBS_Q)).resolves.toEqual({ action: "handled" });
    expect(h.sent).toHaveLength(2);
  });
});

describe("PD5/PD12: a corrected AUTO answer demotes", () => {
  it("answer → 「不对」: one correction entry (targetKind answer), demote + one notify; not re-recorded; reset restores", async () => {
    const h = harness({ autoResolve: ["jobs.list"] });
    await expect(h.input(JOBS_Q)).resolves.toEqual({ action: "handled" });
    h.clock.advance(4_000);
    const out = h.input("不对");
    expect(out).toEqual({ action: "continue" }); // short-reply veto, but the correction persisted synchronously
    expect(h.corrections()).toEqual([
      {
        v: 1,
        at: 1_004_000,
        targetKind: "answer",
        targetScriptId: "jobs.list",
        targetScriptVer: 1,
        targetDigest: requestDigest(normalizeInput(JOBS_Q).norm),
        deltaMs: 4_000,
        correctionDigest: requestDigest(normalizeInput("不对").norm),
      },
    ]);
    expect(h.notes).toEqual(["warning: reflex：jobs.list 作答被纠正，已降回 shadow（/reflex reset 或 /reload 恢复）"]);
    expect(h.wiring.snapshot().scripts.find((s) => s.id === "jobs.list")).toMatchObject({
      state: "demoted",
      demoteReason: "corrected",
    });
    h.input("错了"); // already corrected once ⇒ no second entry, no second notify
    expect(h.corrections()).toHaveLength(1);
    expect(h.notes).toHaveLength(1);
    await h.resetCmd();
    const after = h.wiring.snapshot().scripts.find((s) => s.id === "jobs.list")!;
    expect(after).toMatchObject({ state: "auto", strikes: 0 });
    expect(after.demoteReason).toBeUndefined();
  });

  it("root nit b: a failed appendEntry does not burn the one-shot — the correction retries and persists", async () => {
    const h = harness({ autoResolve: ["jobs.list"], appendThrows: true });
    await expect(h.input(JOBS_Q)).resolves.toEqual({ action: "handled" });
    h.input("不对"); // entry write fails ⇒ memo stays un-corrected (but the demote already happened)
    expect(h.corrections()).toEqual([]);
    expect(h.wiring.snapshot().scripts.find((s) => s.id === "jobs.list")).toMatchObject({
      demoteReason: "corrected",
    });
    h.live.appendThrows = false;
    h.input("错了"); // same target, still inside the window ⇒ retried and persisted
    expect(h.corrections()).toHaveLength(1);
    expect(h.corrections()[0]).toMatchObject({ targetKind: "answer", targetScriptId: "jobs.list" });
    expect(h.wiring.snapshot().counters.corrected).toBe(1);
    h.input("不对"); // now corrected ⇒ no further entry
    expect(h.corrections()).toHaveLength(1);
  });
});

describe("I7 / PD11: shutdown during the AUTO await", () => {
  function hangingHarness() {
    const resolvers: Array<(v: unknown) => void> = [];
    const h = harness({
      autoResolve: ["git.status"],
      git: () => new Promise((res) => resolvers.push(res)),
    });
    return { h, resolvers };
  }

  it("shutdown while awaiting: zero send/append/strike; inFlight survives until session_start re-arms", async () => {
    const { h, resolvers } = hangingHarness();
    const out = h.input(GIT_Q);
    await flush(); // the runner promise now exists; runAuto is awaiting the race
    h.fire("session_shutdown");
    expect(h.wiring.snapshot()).toMatchObject({ disposed: true, inFlight: true }); // finally skips stale gens
    resolvers[0]!(GIT_EXIT1); // would be a strike (and a 2nd one would demote) — must be dropped
    await expect(out).resolves.toEqual({ action: "continue" });
    expect(h.sent).toEqual([]);
    expect(h.appended).toEqual([]);
    expect(h.wiring.snapshot().scripts.find((s) => s.id === "git.status")).toMatchObject({
      state: "auto",
      strikes: 0,
    });
    expect(h.wiring.snapshot().inFlight).toBe(true); // only the re-arm clears it
    h.fire("session_start");
    expect(h.wiring.snapshot()).toMatchObject({ disposed: false, inFlight: false });
  });

  it("shutdown→start (session switch) during the await: the old continuation is inert, the new session answers", async () => {
    const { h, resolvers } = hangingHarness();
    const old = h.input(GIT_Q);
    await flush(); // the runner promise now exists; runAuto is awaiting the race
    h.fire("session_shutdown");
    h.fire("session_start");
    resolvers[0]!(GIT_CLEAN); // late result of the OLD session
    await expect(old).resolves.toEqual({ action: "continue" });
    expect(h.sent).toEqual([]);
    expect(h.appended).toEqual([]);
    expect(h.wiring.snapshot().scripts.find((s) => s.id === "git.status")).toMatchObject({ strikes: 0 });
    // the SAME closure serves the new session: normal AUTO answer, and the memo is fresh —
    // a following correction targets the NEW answer (kind "answer"), never the dropped one
    const third = h.input(GIT_Q);
    await flush();
    resolvers.at(-1)!(GIT_CLEAN); // the NEW session's own runner promise
    await expect(third).resolves.toEqual({ action: "handled" });
    expect(h.sent).toHaveLength(1);
    h.input("不对");
    expect(h.corrections()).toEqual([expect.objectContaining({ targetKind: "answer", targetScriptId: "git.status" })]);
  });

  it("an exception inside the AUTO path degrades to continue (R-I4) and the slot settles as shadow", async () => {
    const h = harness({ autoResolve: ["jobs.list"], sendThrows: true });
    await expect(h.input(JOBS_Q)).resolves.toEqual({ action: "continue" });
    expect(h.appended).toEqual([]);
    expect(h.wiring.snapshot().inFlight).toBe(false);
    expect(h.status.at(-1)).toEqual(["reflex", undefined]); // finally still cleared the status line
    h.branch = [userMsg(JOBS_Q)];
    h.settled();
    expect(h.records()).toHaveLength(1);
    expect(h.records()[0]).toMatchObject({ kind: "shadow", state: "auto" });
  });
});

describe("I8: autoResolve is live", () => {
  it("adding the id live turns the very next input into an AUTO answer; unknown ids surface in the snapshot", async () => {
    const h = harness({ autoResolve: ["nope.x"] });
    expect(h.wiring.snapshot().unknownAutoResolve).toEqual(["nope.x"]);
    const shadow = h.input(JOBS_Q);
    expect(shadow).toEqual({ action: "continue" });
    expect(typeof (shadow as { then?: unknown }).then).not.toBe("function");
    h.live.autoResolve = ["jobs.list"];
    await expect(h.input("有后台任务在跑吗")).resolves.toEqual({ action: "handled" });
    expect(h.sent).toHaveLength(1);
  });
});

describe("status display", () => {
  it("the snapshot carries demoteReason for every demote cause (strikes / repeat / corrected)", async () => {
    const h = harness({ autoResolve: ["jobs.list"] });
    await expect(h.input(JOBS_Q)).resolves.toEqual({ action: "handled" });
    h.input(JOBS_Q); // repeat ⇒ demoted
    expect(h.wiring.snapshot().scripts.find((s) => s.id === "jobs.list")!.demoteReason).toBe("repeat");
    const g = harness({ autoResolve: ["git.status"], git: () => GIT_EXIT1 });
    await expect(g.input(GIT_Q)).resolves.toEqual({ action: "continue" });
    await expect(g.input("工作区干净吗")).resolves.toEqual({ action: "continue" });
    expect(g.wiring.snapshot().scripts.find((s) => s.id === "git.status")!.demoteReason).toBe("strikes");
    const c = harness({ autoResolve: ["jobs.list"] });
    await expect(c.input(JOBS_Q)).resolves.toEqual({ action: "handled" });
    c.input("不对");
    expect(c.wiring.snapshot().scripts.find((s) => s.id === "jobs.list")!.demoteReason).toBe("corrected");
  });
});
