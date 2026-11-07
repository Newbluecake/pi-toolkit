/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * jev-reflex · #25 B4: `wireReflex` with runtime drafts (BA §4.6, R-I12/R-I13). Real fs + a real temp
 * `<agentDir>/reflex/drafts` (injected through `draftsDir`), FakeClock, fake pi. The headline property:
 * a draft is shadow-only whatever `autoResolve` says, and never touches the builtin state machine.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import activate from "../../src/index.js";
import { resetSecureDomainForTests } from "../../src/secure/domain.js";
import { BASELINE, emitAll, fakeCtx, fakePi, resetGlobals, sandbox } from "../integration/helpers/schedule-activate.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FakeClock } from "../../src/core/clock.js";
import { BUILTIN_SCRIPTS } from "../../src/reflex/core/catalog.js";
import { compileCatalog } from "../../src/reflex/core/match.js";
import { templateHash, draftHash } from "../../src/reflex/core/identity.js";
import { DEFAULT_REFLEX_SETTINGS } from "../../src/reflex/core/settings.js";
import type { RScriptV1 } from "../../src/reflex/core/types.js";
import type { DraftFs } from "../../src/reflex/drafts/load.js";
import { wireReflex, type ReflexWireDeps } from "../../src/reflex/wire.js";
import { fakeDraftFs, hang, QUEUE_Q, QUEUE_Q2, queueDraft, tmpAgent, type TmpAgent } from "./drafts/helpers.js";

const GIT_Q = "工作区干净吗"; // builtin git.status strong
const flush = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};

const userMsg = (text: string) => ({ type: "message", message: { role: "user", content: text } });
const assistantText = { type: "message", message: { role: "assistant", content: [{ type: "text", text: "好" }] } };
const assistantTools = (...calls: Array<{ name: string; arguments?: unknown }>) => ({
  type: "message",
  message: { role: "assistant", content: calls.map((c) => ({ type: "toolCall", id: "t", ...c })) },
});

interface H {
  pi: ExtensionAPI;
  wiring: ReturnType<typeof wireReflex>;
  handlers: Map<string, Array<(e: any, c: any) => any>>;
  commands: Map<string, any>;
  appended: Array<{ customType: string; data: any }>;
  sent: string[];
  notices: string[];
  state: { branch: any[] };
  gitMode: { code: number };
  listCalls: { n: number };
  start(): Promise<void>;
  /** wait (real fs) until `/reflex drafts` stops saying loading / not-loaded */
  untilLoaded(): Promise<string>;
  input(text: string, over?: Record<string, unknown>): any;
  settled(): void;
  cmd(args: string): Promise<string>;
  records(): any[];
  corrections(): any[];
}

function harness(
  opts: {
    drafts?: boolean;
    autoResolve?: string[];
    draftsDir?: string;
    draftFs?: DraftFs;
    secure?: "plain" | "secure" | "locked";
    gitCode?: number;
  } = {},
): H {
  const handlers = new Map<string, Array<(e: any, c: any) => any>>();
  const commands = new Map<string, any>();
  const appended: Array<{ customType: string; data: any }> = [];
  const sent: string[] = [];
  const notices: string[] = [];
  const state = { branch: [] as any[] };
  const gitMode = { code: opts.gitCode ?? 1 };
  const listCalls = { n: 0 };
  const clock = new FakeClock(1_000_000);
  const pi: any = {
    on: (event: string, h: (e: any, c: any) => any) => handlers.set(event, [...(handlers.get(event) ?? []), h]),
    registerCommand: (name: string, cmd: unknown) => commands.set(name, cmd),
    registerMessageRenderer: () => undefined,
    appendEntry: (customType: string, data: unknown) => void appended.push({ customType, data }),
    sendMessage: () => void sent.push("sendMessage"),
    sendUserMessage: () => void sent.push("sendUserMessage"),
  };
  let mono = 0;
  const deps: ReflexWireDeps = {
    settings: () => ({
      ...DEFAULT_REFLEX_SETTINGS,
      enabled: true,
      autoResolve: opts.autoResolve ?? [],
      drafts: { enabled: opts.drafts ?? false },
    }),
    secureDomainKind: opts.secure ?? "plain",
    ports: {
      bashJobs: () => ({
        list: () => {
          listCalls.n++;
          return [];
        },
      }),
      fleet: () => undefined,
      quota: () => undefined,
      git: (() => Promise.resolve({ code: gitMode.code, stdout: "", stderr: "", killed: false })) as never,
    },
    fences: { topicSwitchActive: () => false, goalBusy: () => false },
    clock,
    monoNow: () => (mono += 5),
    ...(opts.draftsDir !== undefined ? { draftsDir: opts.draftsDir } : {}),
    ...(opts.draftFs !== undefined ? { draftFs: opts.draftFs } : {}),
  };
  const wiring = wireReflex(pi, deps);
  const ctx = () => ({
    mode: "tui",
    cwd: "/tmp/reflex-cwd",
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => state.branch },
    ui: { notify: (m: string) => void notices.push(m) },
  });
  const h: H = {
    pi: pi as ExtensionAPI,
    wiring,
    handlers,
    commands,
    appended,
    sent,
    notices,
    state,
    gitMode,
    listCalls,
    start: async () => {
      for (const fn of handlers.get("session_start") ?? []) fn({ type: "session_start" }, ctx());
      await flush();
    },
    untilLoaded: async () => {
      for (let i = 0; i < 200; i++) {
        const out = await h.cmd("drafts");
        if (!/loading|尚未加载/.test(out)) return out;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error("drafts never finished loading");
    },
    input: (text, over = {}) =>
      handlers.get("input")![0]!({ type: "input", text, source: "interactive", ...over }, ctx()),
    settled: () => handlers.get("agent_settled")![0]!({ type: "agent_settled" }, ctx()),
    cmd: async (args) => {
      const out: string[] = [];
      await commands.get("reflex").handler(args, { ...ctx(), ui: { notify: (m: string) => void out.push(m) } });
      return out.join("\n");
    },
    records: () => appended.filter((a) => a.customType === "subagent:reflex-record").map((a) => a.data),
    corrections: () => appended.filter((a) => a.customType === "subagent:reflex-correction").map((a) => a.data),
  };
  return h;
}

let agent: TmpAgent;
beforeEach(() => {
  agent = tmpAgent();
});
afterEach(() => agent.cleanup());

/** git.status draft: its port fails with exit 1 in the default harness ⇒ `error` outcomes. */
const gitDraft = (id = "draft.dirty"): RScriptV1 => queueDraft(id, "git.status");

describe("sanity: the queue vocabulary really is a builtin MISS (so only the draft layer can see it)", () => {
  it("builtin matcher misses every queue sentence", () => {
    const m = compileCatalog(BUILTIN_SCRIPTS);
    const caps = new Set(["git", "bashJobs", "fleet", "quota"] as const);
    for (const q of [QUEUE_Q, QUEUE_Q2]) expect(m.match(q, caps as never).kind).toBe("miss");
  });
});

describe("draft layer is shadow-only (R-I12)", () => {
  it("autoResolve=[draft.queue] + a high draft hit ⇒ SYNC continue, non-thenable, zero sendMessage, record state:'shadow'", async () => {
    agent.write("queue.json", queueDraft("draft.queue"));
    const h = harness({ drafts: true, draftsDir: agent.draftsDir, autoResolve: ["draft.queue"] });
    await h.start();
    await h.untilLoaded();
    const out = h.input(QUEUE_Q);
    expect(out).toEqual({ action: "continue" });
    expect(typeof (out as { then?: unknown }).then).not.toBe("function");
    await flush();
    expect(h.listCalls.n).toBe(1); // the port ran (evidence), nothing answered
    h.state.branch = [userMsg(QUEUE_Q), assistantText];
    h.settled();
    expect(h.sent).toEqual([]);
    expect(h.records()).toHaveLength(1);
    expect(h.records()[0]).toMatchObject({ kind: "shadow", state: "shadow", scriptId: "draft.queue", band: "high" });
  });

  it("the record carries origin / draftHash / templateHash / port.portId (draft rows only)", async () => {
    const draft = queueDraft("draft.queue");
    agent.write("queue.json", draft);
    const h = harness({ drafts: true, draftsDir: agent.draftsDir });
    await h.start();
    await h.untilLoaded();
    h.input(QUEUE_Q);
    await flush();
    h.state.branch = [userMsg(QUEUE_Q), assistantText];
    h.settled();
    const rec = h.records()[0];
    expect(rec).toMatchObject({
      origin: "draft",
      draftHash: draftHash(draft),
      templateHash: templateHash(draft),
      port: { outcome: "ok", portId: "jobs.list" },
    });
  });

  it("settled: the draft participates in agreement (agree / no-tool / diverge — never unknown)", async () => {
    agent.write("queue.json", queueDraft("draft.queue"));
    const h = harness({ drafts: true, draftsDir: agent.draftsDir });
    await h.start();
    await h.untilLoaded();
    const cases: Array<[any[], string]> = [
      [[assistantTools({ name: "bash_job", arguments: { action: "list" } })], "agree"],
      [[assistantText], "no-tool"],
      [[assistantTools({ name: "read", arguments: {} })], "diverge"],
    ];
    for (const [tail, expected] of cases) {
      h.input(QUEUE_Q);
      await flush();
      h.state.branch = [userMsg(QUEUE_Q), ...tail];
      h.settled();
      expect(h.records().at(-1)?.model.agree).toBe(expected);
    }
  });

  it("port error ×2 on a DRAFT: no runtime overlay, no notify, builtin git.status untouched; a builtin control demotes", async () => {
    agent.write("dirty.json", gitDraft());
    // autoResolve names the draft: were it ever accounted as a builtin, `before==="auto"` would notify on demotion
    const h = harness({ drafts: true, draftsDir: agent.draftsDir, gitCode: 1, autoResolve: ["draft.dirty"] });
    await h.start();
    await h.untilLoaded();
    for (let i = 0; i < 2; i++) {
      h.input(QUEUE_Q);
      await flush();
      h.state.branch = [userMsg(QUEUE_Q), assistantText];
      h.settled();
    }
    expect(h.records().map((r) => r.port.outcome)).toEqual(["error", "error"]);
    expect(h.notices).toEqual([]);
    const snap = h.wiring!.snapshot();
    expect(snap.scripts.find((s) => s.id === "git.status")).toMatchObject({ state: "shadow", strikes: 0 });
    expect(snap.scripts.map((s) => s.id)).not.toContain("draft.dirty"); // no runtime entry for drafts
    const status = await h.cmd("status");
    expect(status).not.toMatch(/draft\.dirty (shadow|demoted|auto)/);

    // control: the SAME failing port on the BUILTIN script strikes and demotes it
    for (let i = 0; i < 2; i++) {
      h.input(GIT_Q);
      await flush();
      h.state.branch = [userMsg(GIT_Q), assistantText];
      h.settled();
    }
    expect(h.wiring!.snapshot().scripts.find((s) => s.id === "git.status")).toMatchObject({
      state: "demoted",
      strikes: 2,
    });
  });

  it("builtin and draft alternate on the single slot: each record keeps its own origin; strikes are builtin-only", async () => {
    agent.write("dirty.json", gitDraft());
    const h = harness({ drafts: true, draftsDir: agent.draftsDir, gitCode: 1 });
    await h.start();
    await h.untilLoaded();
    h.input(QUEUE_Q); // draft (git.status port)
    await flush();
    h.input(GIT_Q); // builtin replaces ⇒ draft slot flushed as an unknown-agreement record
    await flush();
    h.input(QUEUE_Q); // draft replaces ⇒ builtin slot flushed
    await flush();
    h.state.branch = [userMsg(QUEUE_Q), assistantText];
    h.settled();
    const recs = h.records();
    expect(recs.map((r) => [r.scriptId, r.origin])).toEqual([
      ["draft.dirty", "draft"],
      ["git.status", undefined],
      ["draft.dirty", "draft"],
    ]);
    // builtin record has NO draft fields at all (BD11)
    expect(Object.keys(recs[1]).filter((k) => ["origin", "draftHash", "templateHash"].includes(k))).toEqual([]);
    expect("portId" in recs[1].port).toBe(false);
    // two draft errors + one builtin error ⇒ exactly ONE strike on the builtin
    expect(h.wiring!.snapshot().scripts.find((s) => s.id === "git.status")?.strikes).toBe(1);
  });

  it("a correction aimed at a draft candidate: entry carries targetOrigin/targetTemplateHash, nothing is demoted", async () => {
    const draft = queueDraft("draft.queue");
    agent.write("queue.json", draft);
    const h = harness({ drafts: true, draftsDir: agent.draftsDir, autoResolve: ["jobs.list"] });
    await h.start();
    await h.untilLoaded();
    h.input(QUEUE_Q);
    await flush();
    h.state.branch = [userMsg(QUEUE_Q), assistantText];
    h.settled();
    h.input("不对，说错了");
    const [c] = h.corrections();
    expect(c).toMatchObject({
      targetKind: "shadow",
      targetScriptId: "draft.queue",
      targetOrigin: "draft",
      targetTemplateHash: templateHash(draft),
    });
    expect(h.notices).toEqual([]);
    expect(h.wiring!.snapshot().scripts.every((s) => s.state !== "demoted")).toBe(true);
    expect((await h.cmd("status")).includes("corrected=0")).toBe(true); // builtin counter untouched
  });

  it("a correction of a BUILTIN candidate stays byte-identical (no draft keys)", async () => {
    agent.write("queue.json", queueDraft("draft.queue"));
    const h = harness({ drafts: true, draftsDir: agent.draftsDir });
    await h.start();
    await h.untilLoaded();
    h.input(GIT_Q);
    await flush();
    h.state.branch = [userMsg(GIT_Q), assistantText];
    h.settled();
    h.input("不对，说错了");
    const [c] = h.corrections();
    expect(c.targetScriptId).toBe("git.status");
    expect("targetOrigin" in c).toBe(false);
    expect("targetTemplateHash" in c).toBe(false);
  });

  it("builtin wins: a sentence the builtin catalog hits never reaches the draft layer", async () => {
    // a draft that ALSO claims the builtin git sentence as strong
    const sneaky = queueDraft("draft.sneaky", "git.status", {
      intent: {
        strong: [GIT_Q, QUEUE_Q, QUEUE_Q2, "队列现在还剩多少活", "当前队列还剩多少活"],
        weak: ["队列"],
        exclude: ["清空", "停掉"],
        examples: {
          hit: [GIT_Q, QUEUE_Q, QUEUE_Q2, "队列现在还剩多少活", "当前队列还剩多少活"],
          miss: ["帮我清空队列", "把队列停掉", "今天天气怎么样", "队列的日志在哪", "谢谢你"],
        },
      },
    });
    agent.write("sneaky.json", sneaky);
    const h = harness({ drafts: true, draftsDir: agent.draftsDir });
    await h.start();
    await h.untilLoaded();
    h.input(GIT_Q);
    await flush();
    h.state.branch = [userMsg(GIT_Q), assistantText];
    h.settled();
    expect(h.records()[0]).toMatchObject({ scriptId: "git.status" });
    expect(h.records()[0].origin).toBeUndefined();
  });

  it("re-asking the same draft question inside the window marks the record reasked", async () => {
    agent.write("queue.json", queueDraft("draft.queue"));
    const h = harness({ drafts: true, draftsDir: agent.draftsDir });
    await h.start();
    await h.untilLoaded();
    h.input(QUEUE_Q);
    await flush();
    h.input(QUEUE_Q);
    await flush();
    h.state.branch = [userMsg(QUEUE_Q), assistantText];
    h.settled();
    expect(h.records().map((r) => r.reasked)).toEqual([undefined, true]);
  });
});

describe("loading lifecycle (BD8) and gates", () => {
  it("drafts OFF ⇒ ZERO fs access (DraftFs spy), `/reflex drafts` says disabled, status has no draft line", async () => {
    const spy = fakeDraftFs({ files: { "a.json": JSON.stringify(queueDraft("draft.a")) } });
    const h = harness({ drafts: false, draftFs: spy.fs, draftsDir: agent.draftsDir });
    await h.start();
    await h.start();
    h.input(QUEUE_Q);
    await flush();
    expect(spy.calls.lstat).toEqual([]);
    expect(spy.calls.opendir).toBe(0);
    expect(spy.calls.open).toEqual([]);
    expect(await h.cmd("drafts")).toMatch(/disabled/);
    const status = await h.cmd("status");
    expect(status).not.toContain("草案");
    expect(h.records()).toEqual([]); // the queue sentence is a plain miss without drafts
  });

  it("drafts ON ⇒ status gains the draft line and `/reflex drafts` lists loaded + rejected (control for the off case)", async () => {
    agent.write("queue.json", queueDraft("draft.queue"));
    agent.write("loose.json", queueDraft("draft.loose"), 0o644);
    const h = harness({ drafts: true, draftsDir: agent.draftsDir, autoResolve: ["draft.queue"] });
    await h.start();
    const out = await h.untilLoaded();
    expect(out).toContain("loaded 1");
    expect(out).toContain("rejected 1");
    expect(out).toMatch(/loaded draft\.queue@1#[0-9a-f]{8} port=jobs\.list/);
    expect(out).toContain("rejected loose.json perm");
    const status = await h.cmd("status");
    expect(status).toContain("草案：enabled");
    expect(status).toContain("loaded=1");
    expect(status).toContain("autoResolve 含 draft.* id");
  });

  it("the load starts at session_start only (not at wire time), once; the result survives re-arms", async () => {
    const spy = fakeDraftFs({ files: { "a.json": JSON.stringify(queueDraft("draft.a")) } });
    const h = harness({ drafts: true, draftFs: spy.fs, draftsDir: agent.draftsDir });
    expect(spy.calls.lstat).toEqual([]); // wiring alone touches nothing
    await h.start();
    await flush(20);
    const afterFirst = spy.calls.lstat.length;
    expect(afterFirst).toBeGreaterThan(0);
    await h.start(); // re-arm (new session) ⇒ no second load
    await flush(20);
    expect(spy.calls.lstat.length).toBe(afterFirst);
    expect(spy.calls.opendir).toBe(1);
  });

  it("shutdown aborts an in-flight load, drops its result, and the next session_start retries", async () => {
    let attempts = 0;
    const base = fakeDraftFs({ files: { "a.json": JSON.stringify(queueDraft("draft.a")) } });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fs: DraftFs = {
      ...base.fs,
      opendir: async (p) => {
        attempts += 1;
        if (attempts === 1) await gate;
        return base.fs.opendir(p);
      },
    };
    const h = harness({ drafts: true, draftFs: fs, draftsDir: agent.draftsDir });
    await h.start();
    expect(await h.cmd("drafts")).toMatch(/loading/);
    for (const fn of h.handlers.get("session_shutdown") ?? []) fn({ type: "session_shutdown" }, {});
    release();
    await flush(20);
    expect(await h.cmd("drafts")).toMatch(/尚未加载/); // the aborted result was dropped
    await h.start(); // new session ⇒ retried
    const out = await h.untilLoaded();
    expect(attempts).toBe(2);
    expect(out).toContain("loaded 1");
  });

  it("an fs that hangs forever is bounded by shutdown (abort), and wiring stays responsive", async () => {
    const base = fakeDraftFs({ files: {} });
    const fs: DraftFs = { ...base.fs, lstat: () => hang() as never };
    const h = harness({ drafts: true, draftFs: fs, draftsDir: agent.draftsDir });
    await h.start();
    expect(h.input(QUEUE_Q)).toEqual({ action: "continue" }); // still a plain miss, never blocked
    for (const fn of h.handlers.get("session_shutdown") ?? []) fn({ type: "session_shutdown" }, {});
    await flush();
    expect(await h.cmd("drafts")).toMatch(/尚未加载/);
  });

  it("secure / locked ⇒ wireReflex registers nothing and never touches the draft fs", async () => {
    for (const kind of ["secure", "locked"] as const) {
      const spy = fakeDraftFs({ files: { "a.json": "{}" } });
      const h = harness({ drafts: true, draftFs: spy.fs, secure: kind });
      expect(h.wiring).toBeUndefined();
      expect(h.handlers.size).toBe(0);
      expect(spy.calls.lstat).toEqual([]);
    }
  });

  it("a rejected directory (0755) loads nothing: the queue sentence stays a plain miss", async () => {
    agent.write("queue.json", queueDraft("draft.queue"));
    const { chmodSync } = await import("node:fs");
    chmodSync(agent.draftsDir, 0o755);
    const h = harness({ drafts: true, draftsDir: agent.draftsDir });
    await h.start();
    const out = await h.untilLoaded();
    expect(out).toMatch(/failure dir-untrusted/);
    h.input(QUEUE_Q);
    await flush();
    expect(h.records()).toEqual([]);
  });
});

describe("real activate() smoke in a throw-away agentDir (default drafts path, BD9)", () => {
  async function smoke(draftsEnabled: boolean) {
    const sb = sandbox("pi-drafts-smoke-");
    resetGlobals();
    resetSecureDomainForTests();
    const savedEnv = process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_CODING_AGENT_DIR; // the default `<HOME>/.pi/agent` is the path under test
    try {
      sb.writeSettings({ ...BASELINE, reflex: { enabled: true, drafts: { enabled: draftsEnabled } } });
      const reflexDir = join(sb.home, ".pi", "agent", "reflex");
      const draftsDir = join(reflexDir, "drafts");
      mkdirSync(draftsDir, { recursive: true });
      chmodSync(reflexDir, 0o700);
      chmodSync(draftsDir, 0o700);
      const good = join(draftsDir, "queue.json");
      writeFileSync(good, JSON.stringify(queueDraft("draft.queue")));
      chmodSync(good, 0o600);
      const loose = join(draftsDir, "loose.json");
      writeFileSync(loose, JSON.stringify(queueDraft("draft.loose")));
      chmodSync(loose, 0o644);

      const h = fakePi();
      const branch: any[] = [];
      const appended: Array<{ customType: string; data: any }> = [];
      (h.pi as any).appendEntry = (customType: string, data: unknown) => void appended.push({ customType, data });
      (h.pi as any).sendMessage = () => undefined;
      activate(h.pi);
      const c = fakeCtx(sb.home);
      c.ctx.mode = "tui";
      c.ctx.sessionManager.getBranch = () => branch;
      await emitAll(h, "session_start", { type: "session_start", reason: "startup" }, c.ctx);
      const cmd = async (args: string): Promise<string> => {
        const out: string[] = [];
        await (h.commands.get("reflex") as any).handler(args, {
          ...c.ctx,
          ui: { ...c.ctx.ui, notify: (m: unknown) => void out.push(String(m)) },
        });
        return out.join("\n");
      };
      let drafts = "";
      for (let i = 0; i < 200; i++) {
        drafts = await cmd("drafts");
        if (!/loading|尚未加载/.test(drafts)) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const res = await emitAll(h, "input", { type: "input", text: QUEUE_Q, source: "interactive" }, c.ctx);
      await flush(12);
      branch.push(userMsg(QUEUE_Q), assistantTools({ name: "bash_job", arguments: { action: "list" } }));
      await emitAll(h, "agent_settled", { aborted: false }, c.ctx);
      return {
        drafts,
        res,
        records: appended.filter((a) => a.customType === "subagent:reflex-record").map((a) => a.data),
      };
    } finally {
      if (savedEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = savedEnv;
      sb.cleanup();
    }
  }

  it("drafts on: 1 loaded + 1 perm; the example question continues to the model and settles as an origin:'draft' record with a judged agreement", async () => {
    const r = await smoke(true);
    console.log(`[smoke drafts on]\n${r.drafts}\nrecord=${JSON.stringify(r.records)}`);
    expect(r.drafts).toContain("loaded 1");
    expect(r.drafts).toContain("rejected 1");
    expect(r.drafts).toContain("loaded draft.queue@1#");
    expect(r.drafts).toContain("rejected loose.json perm");
    expect(JSON.stringify(r.res)).not.toContain("handled"); // the model answers as usual
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({
      origin: "draft",
      scriptId: "draft.queue",
      state: "shadow",
      model: { agree: "agree" },
    });
  });

  it("drafts off (same files on disk): nothing loads, the question is a plain miss", async () => {
    const r = await smoke(false);
    expect(r.drafts).toMatch(/disabled/);
    expect(r.records).toEqual([]);
  });
});
