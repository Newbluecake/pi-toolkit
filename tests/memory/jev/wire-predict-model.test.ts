// memory-predict plan.md v3.2 §11.2 `wire-predict-model` tests: the P2 model
// branch wired into the real `before_agent_start` path — wait-window
// orchestration (§8.3, fake clock), late-result next-turn redemption (§7.2),
// exact-key cache hit (§7.1), partial/child/no-model gates, U independence,
// shutdown, the process-level day ledger (§9.2) and the extended /mem jev
// predict line (§9.4). Harness mirrors wire-predict.test.ts (same fake-pi /
// fake-registry shape) plus a FakeClock (deps.clock + deps.now) and a
// topic-switch-style fake model registry with manually-gated calls.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FakeClock } from "../../../src/core/clock.js";
import type { JevClientHandle } from "../../../src/memory/jev/client.js";
import { jevConfigOf } from "../../../src/memory/jev/config.js";
import type { JevConfig, JevQuestion, PredictModelConfig } from "../../../src/memory/jev/contracts.js";
import { EntryIndex } from "../../../src/memory/jev/entries.js";
import { clearHealthTable } from "../../../src/memory/jev/health.js";
import { writeIndexPatch } from "../../../src/memory/jev/index-store.js";
import { PredictCache, PENDING_CAP_P } from "../../../src/memory/jev/predict/cache.js";
import { isCarryPhrase } from "../../../src/memory/jev/predict/carry.js";
import { clearPredictLedgerTable, wireJev } from "../../../src/memory/jev/wire.js";
import { DEFAULT_MEMORY_SETTINGS, type MemorySettings } from "../../../src/memory/settings.js";
import { createFakeRegistry, type ClassifyCallRecord, type ClassifyResult } from "./helpers/fake-registry.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

const CLASSIFIERS = ["opencode/jev-1.13-free", "opencode/jev-1.13"];
/** ≥40 codepoints, passes the prompt gate, hits no rule (§4.4 "uncertain"). */
const UNCERTAIN = "帮我把这份重构方案从头到尾读一遍，对照现有模块把风险点都列出来，然后说说你觉得还需要补充哪些细节";
const REPLY_OK = '{"tags":[{"id":"git-commit","p":1}]}';
const USAGE = { input: 800, cacheRead: 0, output: 60 };
const DEEPSEEK_USAGE_USD = (800 * 0.3 + 0 * 0.006 + 60 * 1.2) / 1e6;

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ───────────────────── fake model registry (topic-switch runJudge shape) ─────────────────────

interface ModelReply {
  readonly content: { type: "text"; text: string }[];
  readonly usage?: { input: number; cacheRead: number; output: number };
  readonly errorMessage?: string;
}

interface ModelCall {
  readonly model: unknown;
  readonly context: { systemPrompt: string; messages: unknown[] };
  readonly options: { signal?: AbortSignal; maxTokens?: number; reasoning?: string } | undefined;
}

interface FakeModelRegistry {
  readonly calls: ModelCall[];
  /** Resolve/reject the i-th model call (the gate exists once the call started). */
  resolve(i: number, reply: ModelReply): void;
  reject(i: number, err: unknown): void;
}

function fakeModelRegistry(opts: { completeOnly?: boolean } = {}): FakeModelRegistry {
  const calls: ModelCall[] = [];
  const gates: ReturnType<typeof deferred<ModelReply>>[] = [];
  const model = {
    provider: "deepseek",
    id: "deepseek-flash",
    cost: { input: 0.3, cacheRead: 0.006, output: 1.2, cacheWrite: 0 },
  };
  const take = (): Promise<ModelReply> => {
    const g = deferred<ModelReply>();
    gates.push(g);
    return g.promise;
  };
  const record = (m: unknown, context: unknown, options: unknown): void => {
    calls.push({ model: m, context: context as ModelCall["context"], options: options as ModelCall["options"] });
  };
  const reg: FakeModelRegistry = {
    calls,
    resolve: (i, reply) => gates[i]?.resolve(reply),
    reject: (i, err) => gates[i]?.reject(err),
    find: (provider: string, id: string) => (provider === "deepseek" && id === "deepseek-flash" ? model : undefined),
  };
  if (opts.completeOnly) {
    (reg as { complete?: unknown }).complete = (m: unknown, context: unknown, options: unknown) => {
      record(m, context, options);
      return take();
    };
  } else {
    (reg as { streamSimple?: unknown }).streamSimple = (m: unknown, context: unknown, options: unknown) => {
      record(m, context, options);
      const p = take();
      return { result: () => p };
    };
  }
  return reg;
}

// ───────────────────── harness ─────────────────────

let tmp: string;
let memDir: string;

beforeEach(() => {
  clearHealthTable();
  clearPredictLedgerTable();
  tmp = mkdtempSync(join(tmpdir(), "jev-wire-predict-model-"));
  memDir = join(tmp, "mem");
  mkdirSync(memDir, { recursive: true });
  writeFileSync(
    join(memDir, "core.md"),
    [
      "# Core",
      "",
      "## Dispatch",
      "",
      "- 派发子 agent 前先确认范围 <!-- mem tags=+dispatch -->",
      "",
      "## Release",
      "",
      "- 发版前确认 CI 是绿的 <!-- mem user tags=+release -->",
      "",
      "## Commit",
      "",
      "- 提交只用精确路径，不要 git add -A <!-- mem tags=+git-commit -->",
      "",
    ].join("\n"),
  );
});

afterEach(async () => {
  // Drain any still-running background chain of the finished harness (full
  // status kicks bulk tagging, whose fs-write macrotask hops can otherwise
  // leak a late health-"ok" mark across the clear below into the NEXT test).
  await sleep(60);
  rmSync(tmp, { recursive: true, force: true });
  clearHealthTable();
  clearPredictLedgerTable();
});

function answersFor(questions: Record<string, JevQuestion>, rules: readonly (readonly [string, number])[]) {
  const out: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "bool") {
      const hit = rules.find(([needle]) => q.instructions.includes(needle));
      out[id] = { type: "bool", probability: hit?.[1] ?? 0.1 };
    } else if (q.type === "score") out[id] = { type: "score", score: 2, confidence: 0.9 };
    else {
      const k = Object.keys(q.criteria)[0]!;
      out[id] = { type: "choice", choice: k, probabilities: { [k]: 0.9 }, confidence: 0.9 };
    }
  }
  return out as Record<string, never>;
}

type UMode = "gate" | "hang" | "fail" | "fast";

interface HarnessOpts {
  probeGate?: Promise<void>;
  /** Recall-duty classify behavior; `gate` waits for resolveU (default `fast`). */
  uMode?: UMode;
  /** Classifiers fail with this message ⇒ Jev status partial(!inactive). */
  fail?: string;
  isChild?: boolean;
  /** `memory.jev.predict.model.*` overrides (merged onto the defaults). */
  predictModel?: Partial<PredictModelConfig>;
  /** `recall.waitMs` override (real-ms; U's settle is not on the fake clock). */
  recallWaitMs?: number;
  completeOnly?: boolean;
  /** Extra `JevConfig` overrides (e.g. `fastPath.allowTags` for #36 tests). */
  config?: Partial<JevConfig>;
}

interface Harness {
  clock: FakeClock;
  model: FakeModelRegistry;
  wire: ReturnType<typeof wireJev>;
  sent: { message: { customType: string; content: unknown; details: any }; options: unknown }[];
  appended: { customType: string; data: any }[];
  branch: any[];
  emit(event: string, payload: unknown, c?: unknown): Promise<unknown[]>;
  prompt(text: string): Promise<{ message?: any } | undefined>;
  /** Kick before_agent_start and return its UNAWAITED promise — the window
   *  tests drive the fake clock while the handler is suspended. */
  promptNow(text: string): Promise<{ message?: any } | undefined>;
  resolveU(): void;
  report(): Promise<string>;
  predictCalls(): any[];
}

function harness(opts: HarnessOpts = {}): Harness {
  const handlers = new Map<string, Handler[]>();
  const sent: { message: { customType: string; content: unknown; details: any }; options: unknown }[] = [];
  const appended: { customType: string; data: any }[] = [];
  const branch: any[] = [];
  let nextId = 1;
  const pi = {
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage: (message: any, options: unknown) => {
      sent.push({ message, options });
      branch.push({ type: "custom_message", id: `m${nextId++}`, ...message });
    },
    appendEntry: (customType: string, data: unknown) => {
      appended.push({ customType, data });
      branch.push({ type: "custom", id: `c${nextId++}`, customType, data });
    },
    registerMessageRenderer: () => {},
  } as unknown as ExtensionAPI;
  const uGate = deferred<void>();
  const uScript = async (call: ClassifyCallRecord): Promise<ClassifyResult> => {
    if ("probe" in (call.state as Record<string, unknown>)) {
      await opts.probeGate;
      return opts.fail !== undefined
        ? { stopReason: "error", errorMessage: opts.fail }
        : { stopReason: "stop", answers: { probe: { type: "bool", probability: 0.95 } } as never };
    }
    if (opts.uMode === "hang") return new Promise<ClassifyResult>(() => {});
    if (opts.uMode === "fail") return { stopReason: "error", errorMessage: "u failed" };
    if (opts.uMode === "gate") await uGate.promise;
    return {
      stopReason: "stop",
      answers: answersFor(call.questions, [
        ["发版前确认", 0.95],
        ["Health check", 0.95],
      ]),
    };
  };
  const fake = createFakeRegistry({
    available: CLASSIFIERS,
    responses: Object.fromEntries(CLASSIFIERS.map((id) => [id, [uScript]])),
  });
  const model = fakeModelRegistry({ completeOnly: opts.completeOnly });
  const settings: MemorySettings = { ...DEFAULT_MEMORY_SETTINGS };
  const base = jevConfigOf(settings);
  const modelCfg: PredictModelConfig = { ...base.predict.model, ...opts.predictModel };
  const config: JevConfig = {
    ...base,
    classifiers: CLASSIFIERS,
    ...(opts.recallWaitMs === undefined ? {} : { recall: { ...base.recall, waitMs: opts.recallWaitMs } }),
    predict: { ...base.predict, model: modelCfg },
    ...opts.config,
  };
  const clock = new FakeClock(0);
  const wire = wireJev(pi, {
    config,
    settings,
    isChildSession: opts.isChild === true,
    dirFor: () => memDir,
    getRenderInfo: () => undefined,
    onAfterWriteHook: () => {},
    now: () => clock.now(),
    clock,
    log: () => {},
    todo: { list: () => [] },
  });
  wire.attachPredictPorts({ bashJobs: { list: () => [] }, fleet: { activeRuns: () => 0 } });
  const modelRegistry: Record<string, unknown> = { ...fake.registry };
  modelRegistry["find"] = model.find;
  if (model.streamSimple !== undefined) modelRegistry["streamSimple"] = model.streamSimple;
  if (model.complete !== undefined) modelRegistry["complete"] = model.complete;
  const ctx = (extra: Record<string, unknown> = {}) => ({
    cwd: tmp,
    hasUI: true,
    ui: { notify: () => {} },
    modelRegistry,
    sessionManager: { getBranch: () => branch, getSessionId: () => "s1" },
    ...extra,
  });
  const emit = async (event: string, payload: unknown, c: unknown = ctx()): Promise<unknown[]> => {
    const out: unknown[] = [];
    for (const h of handlers.get(event) ?? []) out.push(await h(payload, c));
    return out;
  };
  const handlerOf = (event: string): Handler | undefined => (handlers.get(event) ?? [])[0];
  const beforeAgent = (text: string): Promise<{ message?: any } | undefined> => {
    branch.push({ type: "message", id: `u${nextId++}`, message: { role: "user", content: text } });
    const h = handlerOf("before_agent_start");
    if (h === undefined) throw new Error("no before_agent_start handler");
    return h({ type: "before_agent_start", messageType: "user", prompt: text }, ctx()) as Promise<
      { message?: any } | undefined
    >;
  };
  return {
    clock,
    model,
    wire,
    sent,
    appended,
    branch,
    emit,
    prompt: beforeAgent,
    promptNow: beforeAgent,
    resolveU: () => uGate.resolve(),
    report: () => wire.commandPort.report(tmp, undefined),
    predictCalls: () =>
      appended.filter((a) => a.customType === "subagent:memory-predict" && a.data?.kind === "call").map((a) => a.data),
  };
}

const flush = async (n = 10): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function goStatus(h: Harness, kind: "full" | "partial"): Promise<void> {
  // wire returns the real client handle, typed as the narrower JevClient port.
  // Subscribe before startup so even a synchronous transition cannot be missed.
  // Probe status follows the async registry/classifier chain, not the prediction
  // FakeClock. Await its event instead of imposing a short wall-time deadline;
  // Vitest's per-test timeout still bounds a probe that never settles.
  const client = h.wire.client as JevClientHandle;
  const settled = deferred<void>();
  const unsubscribe = client.onStatusChange((_prev, next) => {
    if (next.kind !== "probing") settled.resolve();
  });
  try {
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    if (client.status().kind === "probing") await settled.promise;
    expect(client.status().kind).toBe(kind);
  } finally {
    unsubscribe();
  }
}

/** Records the fake-clock moment at which `p` settles (−1 until then). */
function settledAt(h: Harness, p: Promise<unknown>): { at: () => number } {
  let t = -1;
  void p.then(
    () => {
      t = h.clock.now();
    },
    () => {
      t = h.clock.now();
    },
  );
  return { at: () => t };
}

test("startup waits for a gated classifier probe rather than 30ms", async () => {
  const gate = deferred<void>();
  const h = harness({ fail: "System One API error (451): blocked", probeGate: gate.promise });
  let outcome: "pending" | "resolved" | "rejected" = "pending";
  const started = goStatus(h, "partial").then(
    () => {
      outcome = "resolved";
    },
    () => {
      outcome = "rejected";
    },
  );
  try {
    await flush();
    await sleep(30); // The old fixed wait elapsed while the probe is explicitly held.
    expect(h.wire.client.status().kind).toBe("probing");
    expect(outcome).toBe("pending");
  } finally {
    gate.resolve();
  }
  await started;
  expect(outcome).toBe("resolved");
  expect(h.wire.client.status().kind).toBe("partial");
});

// ───────────────────── §8.3 wait window (fake clock) ─────────────────────

describe("wait window (§8.3, §11.2 wire-predict-model list)", () => {
  test("U settles at 1.8s, model at 1.5s ⇒ merged this turn, handler returns at U's settle moment (no extra wait)", async () => {
    const h = harness({ uMode: "gate" });
    await goStatus(h, "full");
    const p = h.promptNow(UNCERTAIN);
    const s = settledAt(h, p);
    h.clock.advance(1500);
    h.model.resolve(0, { content: [{ type: "text", text: REPLY_OK }], usage: USAGE });
    await flush();
    // the flight won the race, but the handler still waits for U — nothing
    // settles before U's own completion
    expect(s.at()).toBe(-1);
    h.clock.advance(300);
    h.resolveU();
    const r = await p;
    expect(s.at()).toBe(1800);
    expect(r?.message).toBeDefined();
    const d = r!.message.details;
    expect(d.layer).toBe("P");
    expect(d.parts.map((x: any) => x.layer)).toEqual(["P", "U"]);
    expect(d.predict.origin).toBe("rules+model");
    expect(r!.message.content).toContain("提交只用精确路径");
    expect(r!.message.content).toContain("[memory · P jev]");
    expect(h.sent).toHaveLength(0); // P never sendMessage; U was timely
    const [call] = h.predictCalls();
    expect(call).toMatchObject({
      kind: "call",
      model: "deepseek/deepseek-flash",
      ok: true,
      timely: true,
      ms: 1500,
      costSource: "usage",
    });
    expect(call.costUsd).toBeCloseTo(DEEPSEEK_USAGE_USD, 9);
  });

  test("U settles at 0.2s, model at 0.4s ⇒ merged, handler returns at 0.4s (window holds past U)", async () => {
    const h = harness({ uMode: "gate" });
    await goStatus(h, "full");
    const p = h.promptNow(UNCERTAIN);
    const s = settledAt(h, p);
    h.clock.advance(200);
    h.resolveU();
    await flush();
    expect(s.at()).toBe(-1); // U done; model + window still open
    h.clock.advance(200);
    h.model.resolve(0, { content: [{ type: "text", text: REPLY_OK }] });
    const r = await p;
    expect(s.at()).toBe(400);
    expect(r?.message?.details?.predict?.origin).toBe("rules+model");
    expect(r.message.details.parts.map((x: any) => x.layer)).toEqual(["P", "U"]);
  });

  test("U settles at 0.2s, model at 0.8s ⇒ handler returns at the 0.5s window, model NOT merged, late result only cached", async () => {
    // #36 P0: pin the pre-#36 default window (500ms) — the settings default is
    // 1000 now (Q9); P6a reworks these window cases for the new semantics.
    const h = harness({ uMode: "gate", predictModel: { waitMs: 500 } });
    await goStatus(h, "full");
    const p = h.promptNow(UNCERTAIN);
    const s = settledAt(h, p);
    h.clock.advance(200);
    h.resolveU();
    h.clock.advance(300); // window closes at 500
    const r = await p;
    expect(s.at()).toBe(500);
    expect(r?.message?.details?.layer).toBe("U"); // no P part: rules found nothing
    expect(r.message.details.parts).toBeUndefined();
    // late settle: cache + pendingModel + call record, and NEVER a sendMessage
    h.model.resolve(0, { content: [{ type: "text", text: REPLY_OK }] });
    await flush(14);
    expect(h.sent).toHaveLength(0);
    const [call] = h.predictCalls();
    expect(call).toMatchObject({ kind: "call", ok: true, timely: false });
  });

  test("U not running (partial) ⇒ merged at the model's own 0.4s return", async () => {
    const h = harness({ fail: "System One API error (451): blocked" });
    await goStatus(h, "partial");
    const p = h.promptNow(UNCERTAIN);
    const s = settledAt(h, p);
    h.clock.advance(400);
    h.model.resolve(0, { content: [{ type: "text", text: REPLY_OK }] });
    const r = await p;
    expect(s.at()).toBe(400);
    expect(r?.message?.details?.layer).toBe("P");
    expect(r.message.details.parts).toBeUndefined(); // U never ran
    expect(r.message.details.predict.origin).toBe("rules+model");
    expect(r.message.details.partial).toBe(true);
    expect(h.predictCalls()[0]).toMatchObject({ ok: true, timely: true });
  });

  test("U waits out recall.waitMs without settling ⇒ the model is cut off at the same window and never merges", async () => {
    const h = harness({ uMode: "hang", recallWaitMs: 60, predictModel: { waitMs: 500 } }); // #36 P0: 500ms 窗口钉（默认已改 1000，Q9）
    await goStatus(h, "full");
    const p = h.promptNow(UNCERTAIN);
    const s = settledAt(h, p);
    h.clock.advance(500); // waitMs timer fires; U's real settle timer has not
    await flush();
    expect(s.at()).toBe(-1);
    await sleep(90); // U's real recall.waitMs (60ms) settles uDone
    const r = await p;
    expect(s.at()).toBe(500);
    expect(r).toBeUndefined(); // no P picks (uncertain rules), U timed out
    h.model.resolve(0, { content: [{ type: "text", text: REPLY_OK }] });
    await flush(14);
    expect(h.sent).toHaveLength(0);
    expect(h.predictCalls()[0]).toMatchObject({ ok: true, timely: false });
    expect(h.clock.pendingTimers).toBe(0);
  });

  test("waitS=0 and U not running ⇒ no await introduced at all (resolves without any clock advance)", async () => {
    const h = harness({ fail: "System One API error (451): blocked", predictModel: { waitMs: 0 } });
    await goStatus(h, "partial");
    const p = h.promptNow(UNCERTAIN);
    const r = await p; // zero advance — only microtasks
    expect(r).toBeUndefined();
    expect(h.model.calls).toHaveLength(1); // the flight DID start
    h.model.resolve(0, { content: [{ type: "text", text: REPLY_OK }] });
    await flush(14);
    expect(h.predictCalls()[0]).toMatchObject({ ok: true, timely: false });
  });

  test("waitS=0, U settles at 1.8s, model at 1.5s ⇒ window rides U, merged this turn, handler returns at U's settle", async () => {
    const h = harness({ uMode: "gate", predictModel: { waitMs: 0 } });
    await goStatus(h, "full");
    const p = h.promptNow(UNCERTAIN);
    const s = settledAt(h, p);
    h.clock.advance(1500);
    h.model.resolve(0, { content: [{ type: "text", text: REPLY_OK }], usage: USAGE });
    await flush();
    // window = max(0, U settle): the flight settled inside U's window — no
    // cutoff at 0, the handler still waits for U to commit (§5.3 P-first)
    expect(s.at()).toBe(-1);
    h.clock.advance(300);
    h.resolveU();
    const r = await p;
    expect(s.at()).toBe(1800);
    expect(r?.message?.details?.predict?.origin).toBe("rules+model");
    expect(r.message.details.parts.map((x: any) => x.layer)).toEqual(["P", "U"]);
    expect(h.sent).toHaveLength(0); // P never sendMessage; U was timely
    const [call] = h.predictCalls();
    expect(call).toMatchObject({ kind: "call", ok: true, timely: true, ms: 1500 });
  });
});

// ───────────────────── §7.2 late-result next-turn redemption ─────────────────────
// （#36 P6a：原“承接/新指令/cancel”三个 500ms 钉住用例已并入下方 G3 的
// 3a/3b/3c —— 按 plan r3 §4 P6a，P0 的 7 处 predictModel:{waitMs:500} 临时钉
// 在重做窗口语义用例时消化；这里保留 exact-key cache 用例（waitMs:0 是其
// 自身语义，不是默认窗口钉）。）

describe("late result: exact-key cache + pendingModel next-turn redemption (§7.2)", () => {
  test("exact-key cache hit: the same DTO replays from cache — no second model call, origin rules+cache", async () => {
    const h = harness({ fail: "System One API error (451): blocked", predictModel: { waitMs: 0 } });
    await goStatus(h, "partial");
    // Warm the dirty bit to a stable value so turn 1 and turn 2 build the
    // same DTO (an "unknown" first read would change workspace.dirty).
    await h.prompt("好的");
    await sleep(40);
    // Simulate a resume replay: the branch holds ONLY the replayed prompt, so
    // both turns build the identical DTO — the warm-up prompt must not leak
    // into turn 1's previous_request either, or the turnKeys diverge.
    h.branch.length = 0;
    // Turn 1: uncached ask, window 0 ⇒ immediate miss; late result seeds the cache.
    await h.promptNow(UNCERTAIN);
    h.model.resolve(0, { content: [{ type: "text", text: REPLY_OK }] });
    await flush(14);
    expect(h.model.calls).toHaveLength(1);
    // Turn 2: the same resume replay ⇒ the same DTO ⇒ cache hit.
    h.branch.length = 0;
    const r = await h.promptNow(UNCERTAIN);
    expect(r?.message?.details?.layer).toBe("P");
    expect(r.message.content).toContain("提交只用精确路径");
    expect(r.message.details.predict.origin).toBe("rules+cache");
    expect(h.model.calls).toHaveLength(1); // no second call — served from cache
    const text = await h.report();
    expect(text).toContain("cached 1");
  });
});

// ───────────────────── G3 预测注入及时/迟到/下一轮兑现（#36 arch r5 §7.4，8 用例，假时钟） ─────────────────────
// 默认窗口 waitMs=1000（#36 Q9）、单链预算 3000（最后一档拿全部剩余预算）。
// 3a–3c / 4 按 `cache.ts redeemPending` 的代码规则直接导入 PENDING_CAP_P 与
// isCarryPhrase，不在测试里复制常量。

describe("G3 offline gate: timely / late / next-turn redemption (arch r5 §7.4)", () => {
  /** partial（U 不跑）下制造一次迟到：窗口 = waitMs = 1000，之后模型才回。 */
  async function lateTurn1(h: Harness): Promise<void> {
    const p = h.promptNow(UNCERTAIN);
    h.clock.advance(1000); // 窗口（U 未跑 ⇒ 纯 waitMs）在 1000 关闭
    await p;
    h.model.resolve(0, { content: [{ type: "text", text: REPLY_OK }] });
    await flush(14);
    expect(h.predictCalls()).toHaveLength(1);
  }

  test("1 · U 1500ms 结束、模型 800ms 返回 ⇒ timely:true，本轮合并；call 记 windowMs=1500/attempts=1", async () => {
    const h = harness({ uMode: "gate" });
    await goStatus(h, "full");
    const p = h.promptNow(UNCERTAIN);
    const s = settledAt(h, p);
    h.clock.advance(800);
    h.model.resolve(0, { content: [{ type: "text", text: REPLY_OK }], usage: USAGE });
    await flush();
    h.clock.advance(700); // U settles at 1500
    h.resolveU();
    const r = await p;
    expect(s.at()).toBe(1500);
    expect(r?.message?.details?.parts?.map((x: any) => x.layer)).toEqual(["P", "U"]);
    expect(r.message.details.predict.origin).toBe("rules+model");
    const [call] = h.predictCalls();
    expect(call).toMatchObject({ ok: true, timely: true, ms: 800, windowMs: 1500, attempts: 1 });
  });

  test("2 · U 1500ms 结束、模型 1700ms 返回（单链，预算 3000）⇒ 不被 1500ms 摘断；迟到入 pendingModel，timely:false，windowMs=1500", async () => {
    const h = harness({ uMode: "gate" });
    await goStatus(h, "full");
    const p = h.promptNow(UNCERTAIN);
    h.clock.advance(1500);
    h.resolveU(); // 窗口 = max(1000, 1500) = 1500 关闭
    const r = await p;
    expect(r?.message?.details?.layer).toBe("U"); // 无 P 部分：规则零注入，模型未及时
    h.clock.advance(200); // 1700：旧代码会在 1500 被 attempt 预算摘断；修复后仍在档内
    h.model.resolve(0, { content: [{ type: "text", text: REPLY_OK }] });
    await flush(14);
    const [call] = h.predictCalls();
    expect(call).toMatchObject({ ok: true, timely: false, ms: 1700, windowMs: 1500, attempts: 1 });
    expect(h.sent).toHaveLength(0); // 迟到结果永不投递，只写 pendingModel（3a 验证）
  });

  test("3a · 相邻下一轮是承接短语（isCarryPhrase）⇒ full：pending tag 按原 p 全权重兑现并注入，无新调用", async () => {
    const h = harness({ fail: "System One API error (451): blocked" }); // partial：U 不跑
    await goStatus(h, "partial");
    await lateTurn1(h);
    expect(isCarryPhrase("继续")).toBe(true); // 直接导入判定，不复制短语表
    const r = await h.prompt("继续");
    expect(r?.message?.details?.layer).toBe("P");
    expect(r.message.content).toContain("提交只用精确路径"); // p=1 全权重 ⇒ 过 0.85 门注入（封顶 0.6 不可能注入）
    expect(r.message.details.predict.origin).toBe("rules+model");
    expect(h.model.calls).toHaveLength(1); // 兑现而非重问
    expect(h.predictCalls()).toHaveLength(1);
  });

  test("3b · 相邻下一轮是普通新指令 ⇒ capped：无支撑 tag 丢弃、有支撑 p 封顶 PENDING_CAP_P；本轮零注入", async () => {
    const h = harness({ fail: "System One API error (451): blocked" });
    await goStatus(h, "partial");
    await lateTurn1(h);
    // 新指令本身 uncertain（§4.4）⇒ 第二次 flight 被准入；封顶 0.6 单独达不到注入门槛。
    const p = h.promptNow("顺便再看一下测试覆盖的情况，列一下薄弱点");
    h.clock.advance(1000);
    const r = await p;
    expect(r).toBeUndefined();
    expect(h.model.calls).toHaveLength(2); // 新的 uncertain 指令重问（§4.4）
    h.model.resolve(1, { content: [{ type: "text", text: REPLY_OK }] });
    await flush(14);
    expect(h.predictCalls()[1]).toMatchObject({ kind: "call", ok: true, timely: false });
    expect(h.sent).toHaveLength(0);
    // 封顶规则直接在生产常量上验证（redeemPending 代码规则）：
    expect(isCarryPhrase("顺便再看一下测试覆盖的情况，列一下薄弱点")).toBe(false);
    const cache = new PredictCache({ ttlMs: 60_000, clock: () => 0 });
    cache.setPending(
      [
        { tag: "git-commit", p: 1 },
        { tag: "docs", p: 0.95 },
      ],
      undefined,
      1,
    );
    const redeemed = cache.redeemPending({
      turnSeq: 2,
      prompt: "顺便再看一下测试覆盖的情况，列一下薄弱点",
      currentTags: [{ tag: "docs", score: 0.7, sources: ["U"], rules: ["x"] }],
      modifiers: [],
    });
    expect(redeemed.kind).toBe("capped");
    if (redeemed.kind === "capped") {
      expect(redeemed.tags.find((t) => t.tag === "git-commit")).toBeUndefined(); // 无支撑 ⇒ 丢弃
      expect(redeemed.tags.find((t) => t.tag === "docs")?.p).toBe(PENDING_CAP_P); // 直接导入常量
    }
  });

  test("3c · 相邻下一轮带 cancel 修饰 ⇒ dropped：不兑现，单槽已清空", async () => {
    const h = harness({ fail: "System One API error (451): blocked" });
    await goStatus(h, "partial");
    await lateTurn1(h);
    const r = await h.prompt("算了，这个先不提交了");
    expect(r).toBeUndefined();
    expect(h.model.calls).toHaveLength(1); // 不重问
    // 单槽已清空：之后的承接短语也无从兑现
    const later = await h.prompt("继续");
    expect(later).toBeUndefined();
  });

  test("4 · 隔一轮再到来 ⇒ none：turnSeq 不相邻不兑现，单槽已清空（redeemPending 代码规则）", () => {
    const cache = new PredictCache({ ttlMs: 60_000, clock: () => 0 });
    cache.setPending([{ tag: "git-commit", p: 1 }], undefined, 5);
    // wire 层每个 predict 轮都会尝试兑现，相邻性只由 redeemPending 的
    // turnSeq 规则决定 —— 直接在生产规则上钉住隔轮语义。
    expect(cache.redeemPending({ turnSeq: 7, prompt: "继续", currentTags: [], modifiers: [] })).toEqual({
      kind: "none",
    });
    // 用过一次即清空：再相邻也无可兑现
    expect(cache.redeemPending({ turnSeq: 6 + 1, prompt: "继续", currentTags: [], modifiers: [] })).toEqual({
      kind: "none",
    });
  });

  test("5 · 模型 3600ms 仍不返回 ⇒ 外层期限（3000+500）结算 timeout，不迟到投递", async () => {
    const h = harness({ fail: "System One API error (451): blocked" });
    await goStatus(h, "partial");
    const p = h.promptNow(UNCERTAIN);
    h.clock.advance(1000); // 窗口（waitMs）关闭
    const r = await p;
    expect(r).toBeUndefined();
    h.clock.advance(2500); // 3500：外层 race 宽限到点
    await flush(14);
    const [call] = h.predictCalls();
    expect(call).toMatchObject({ ok: false, reason: "timeout", timely: false, attempts: 1 });
    expect(h.sent).toHaveLength(0);
    // 迟到的 resolve 只做 zombie 减回，不投递、不追加记账（partial 状态下
    // client 的恢复重试计时器仍在 —— 与本用例无关，不断言 pendingTimers）
    h.model.resolve(0, { content: [{ type: "text", text: REPLY_OK }] });
    await flush(14);
    expect(h.sent).toHaveLength(0);
    expect(h.predictCalls()).toHaveLength(1);
  });

  test("6 · U 不跑（partial）⇒ 窗口 = waitMs（1000）；900ms 返回即及时，call 记 windowMs=1000", async () => {
    // 注：arch 表格写「短 prompt」；字面上的短 prompt 同时会挡掉模型分支
    // （同一 passesPromptGate 门），可测的语义是「U 不跑 ⇒ 窗口退化为
    // waitMs」—— 用 partial（U 被跳过、模型分支仍跑）刻画。
    const h = harness({ fail: "System One API error (451): blocked" });
    await goStatus(h, "partial");
    const p = h.promptNow(UNCERTAIN);
    h.clock.advance(900); // < 1000 = waitMs
    h.model.resolve(0, { content: [{ type: "text", text: REPLY_OK }] });
    const r = await p;
    expect(r?.message?.details?.layer).toBe("P");
    expect(r.message.details.predict.origin).toBe("rules+model");
    const [call] = h.predictCalls();
    expect(call).toMatchObject({ ok: true, timely: true, ms: 900, windowMs: 1000, attempts: 1 });
  });
});

// ───────────────────── #36 §5.2 model-off 差分 + §6.4 bypass ─────────────────────

describe("switch differentials and bypass (#36 §5.2 / §6.4)", () => {
  /** decisive 提示（规则路径注入 P）+ 三种 model 配置下跑同一场景。 */
  async function decisive(h: Harness): Promise<string | undefined> {
    const r = await h.prompt("提交并推送一下，把这两个文件的改动都带上");
    return r === undefined ? undefined : JSON.stringify(r.message);
  }

  test("model-off 差分：model on 但调用被拒（链不可绑定 / 日额拒绝）vs model off ⇒ P 层输出逐字节相同；off 无 flight、无 kind:'call'", async () => {
    // 三个 harness 共享本测试的 memDir：先把 git-commit 条目标进 pInjectedAt
    // 冷却，使三者的 P 选择都走同一条（冷却饿死 bypass）路径 —— 否则第一个
    // harness 的注入会异步写下冷却 stamp，后续 harness 的输出路径分叉。
    const target = new EntryIndex().get(memDir).find((e) => e.body.includes("提交只用精确路径"))!;
    expect(await writeIndexPatch(memDir, { pInjectedAt: { [target.hash]: new Date().toISOString() } })).toBe("ok");

    const off = harness({ fail: "System One API error (451): blocked", predictModel: { enabled: false } });
    await goStatus(off, "partial");
    const offText = await decisive(off);
    expect(offText).toBeDefined();
    expect(off.model.calls).toHaveLength(0);
    expect(off.predictCalls()).toHaveLength(0);

    const unbindable = harness({
      fail: "System One API error (451): blocked",
      predictModel: { models: ["nope/none"] },
    });
    await goStatus(unbindable, "partial");
    expect(await decisive(unbindable)).toBe(offText); // 逐字节相同
    expect(unbindable.model.calls).toHaveLength(0);
    expect(unbindable.predictCalls()).toHaveLength(0);

    const dayCapped = harness({
      fail: "System One API error (451): blocked",
      predictModel: { maxCallsPerDay: 0 },
    });
    await goStatus(dayCapped, "partial");
    expect(await decisive(dayCapped)).toBe(offText); // 逐字节相同
    expect(dayCapped.model.calls).toHaveLength(0);
    expect(dayCapped.predictCalls()).toHaveLength(0);
  });

  test("§6.4 冷却饿死 bypass：高危 tag 命中但合格候选全在 pInjectedAt 冷却 ⇒ 仍注入 1 条，details.predict.bypass=true", async () => {
    const h = harness({ fail: "System One API error (451): blocked" });
    // 在任何 corpus 读取前把 git-commit 条目标进冷却（默认 cooldown 24h）。
    const target = new EntryIndex().get(memDir).find((e) => e.body.includes("提交只用精确路径"))!;
    expect(await writeIndexPatch(memDir, { pInjectedAt: { [target.hash]: new Date().toISOString() } })).toBe("ok");
    await goStatus(h, "partial");
    const r = await h.prompt("提交并推送一下，把这两个文件的改动都带上");
    expect(r?.message?.details?.layer).toBe("P");
    expect(r.message.content).toContain("提交只用精确路径"); // 绕过冷却注入的那 1 条
    expect(r.message.details.predict.bypass).toBe(true);
    expect(h.model.calls).toHaveLength(0); // decisive 提示不走模型分支
    // 同一块每个 segment 最多 1 条：同 segment 再问不重注（isInjected 去重）
    const again = await h.prompt("再提交一次并且推送上去");
    expect(again?.message?.content ?? "").not.toContain("提交只用精确路径");
  });

  test("§6.4 反例（root 追认）：非高危 tag 命中但候选在冷却 ⇒ 仍不注入、无 bypass（冷却在正常路径照旧生效）", async () => {
    // memory-system 是 risk:normal —— rules-only 上限 w(U)×c(high)=0.72，须经
    // 模型 M 源（w(M)×p=0.85×1=0.85）才过 0.85 门，故反例只能在本文件（有模型
    // 通路）构造；fastPath.allowTags 放行其 P 资格。
    writeFileSync(
      join(memDir, "mem-how.md"),
      "# Mem\n\n## Style\n\n- 写记忆前先 view/search 查重 <!-- mem tags=+memory-system -->\n",
    );
    const REPLY = '{"tags":[{"id":"memory-system","p":1}]}';
    const h = harness({
      fail: "System One API error (451): blocked",
      config: { fastPath: { allowTags: ["memory-system"], denyTags: [], cooldownMs: 24 * 3_600_000 } },
    });
    await goStatus(h, "partial");
    // Turn 1：模型 timely 回复 memory-system（p=1 ⇒ 0.85 过门）⇒ 正常路径注入并落 pInjectedAt。
    const p1 = h.promptNow(
      "把这次会话里讨论过的记忆条目风格问题重新梳理一遍，对照现有条目把要改的都列出来，然后说说还有哪些细节要补充",
    );
    h.clock.advance(400);
    h.model.resolve(0, { content: [{ type: "text", text: REPLY }] });
    const r1 = await p1;
    expect(r1?.message?.content).toContain("写记忆前先 view/search 查重");
    expect(r1?.message?.details?.predict?.bypass).toBeUndefined(); // 正常路径，非 bypass
    await flush(20); // recordPInjection fire-and-forget 落盘（pStamps overlay 本就同步生效）
    // Turn 2：同 tag 再次过门（final 记录含 memory-system，证明被拦下的是条目
    // 不是 tag），但唯一合格候选在冷却、tag 非高危 ⇒ 不触发 §6.4 出口 ⇒
    // 零注入、零 bypass —— 冷却在正常路径照旧生效。
    const p2 = h.promptNow(
      "再把记忆条目的整理建议从头到尾过一遍，列出哪些条目需要合并或拆分，顺便给出你建议的先后顺序和理由",
    );
    h.clock.advance(400);
    h.model.resolve(1, { content: [{ type: "text", text: REPLY }] });
    const r2 = await p2;
    expect(r2).toBeUndefined();
    expect(h.sent).toHaveLength(0);
    const finals = h.appended.filter((a) => a.customType === "subagent:memory-predict" && a.data?.kind === "final");
    expect(finals.at(-1)?.data.tags.map((t: any) => t.tag)).toContain("memory-system");
  });
});

// ───────────────────── gates: child / no-model / U independence ─────────────────────

describe("admission gates (§4.4/§5.2)", () => {
  test("child sessions never call the model — rules path keeps its P1 behavior", async () => {
    const h = harness({ isChild: true });
    const decisive = await h.prompt("提交并推送一下");
    expect(decisive?.message?.content).toContain("提交只用精确路径");
    const uncertain = await h.prompt(UNCERTAIN);
    // child ⇒ the model is never called, but U keeps its P1 behavior:
    // a U-only message (no P part) is still returned.
    expect(uncertain?.message?.details?.layer).toBe("U");
    expect(uncertain?.message?.details?.parts).toBeUndefined();
    expect(h.model.calls).toHaveLength(0);
  });

  test("no-model (chain not in the registry) ⇒ silent skip, P1 rules-only behavior", async () => {
    const h = harness({ fail: "System One API error (451): blocked", predictModel: { models: ["nope/none"] } });
    await goStatus(h, "partial");
    const r = await h.prompt(UNCERTAIN);
    expect(r).toBeUndefined();
    expect(h.model.calls).toHaveLength(0);
    expect(h.predictCalls()).toHaveLength(0);
    const text = await h.report();
    expect(text).toContain("model 0");
  });

  test("deepseek hang never breaks U: U still settles within recall.waitMs and merges alone", async () => {
    const h = harness({ uMode: "gate", predictModel: { waitMs: 500 } }); // #36 P0: 500ms 窗口钉
    await goStatus(h, "full");
    const p = h.promptNow(UNCERTAIN);
    const s = settledAt(h, p);
    h.clock.advance(300);
    h.resolveU(); // U done at 0.3s; the model gate stays pending forever
    h.clock.advance(200); // window closes at 0.5s
    const r = await p;
    expect(s.at()).toBe(500);
    expect(r?.message?.details?.layer).toBe("U");
    expect(r.message.content).toContain("发版前确认 CI 是绿的");
    expect(h.sent).toHaveLength(0);
    // the outer deadline reaps the hanging attempt: timeout record, no cache
    h.clock.advance(3500);
    await flush(14);
    expect(h.predictCalls()[0]).toMatchObject({ ok: false, reason: "timeout", timely: false });
    expect(h.clock.pendingTimers).toBe(0);
    const text = await h.report();
    expect(text).toContain("breaker closed"); // one failure does not open it
  });

  test("maxCallsPerDay=1: the second uncertain turn is denied admission (no second call)", async () => {
    const h = harness({
      fail: "System One API error (451): blocked",
      predictModel: { maxCallsPerDay: 1, waitMs: 500 },
    }); // #36 P0: 500ms 窗口钉
    await goStatus(h, "partial");
    const p1 = h.promptNow(UNCERTAIN);
    h.clock.advance(500);
    await p1;
    h.model.resolve(0, { content: [{ type: "text", text: REPLY_OK }] });
    await flush(14);
    expect(h.model.calls).toHaveLength(1);
    const r2 = await h.prompt("帮我把这份部署清单从头到尾再核对一遍，确认没有遗漏的检查项");
    expect(r2).toBeUndefined();
    expect(h.model.calls).toHaveLength(1); // denied — day cap hit
  });
});

// ───────────────────── shutdown (§8.2) ─────────────────────

describe("session_shutdown (§8.2)", () => {
  test("mid-flight shutdown aborts the request, clears timers, and late settles produce no records", async () => {
    const h = harness({ uMode: "gate" });
    await goStatus(h, "full");
    const p = h.promptNow(UNCERTAIN);
    h.clock.advance(200);
    h.resolveU();
    await h.emit("session_shutdown", { type: "session_shutdown", reason: "shutdown" });
    await flush(14);
    const r = await p;
    expect(r?.message?.details?.layer).toBe("U"); // P degraded, U intact
    expect(h.predictCalls()).toHaveLength(0); // disposed ⇒ no call record
    expect(h.clock.pendingTimers).toBe(0);
  });
});

// ───────────────────── day ledger (§9.2) + report (§9.4) ─────────────────────

describe("process-level day ledger (§9.2) and /mem jev predict line (§9.4)", () => {
  test("two wireJev closures in one process share the day spend; usage settles at the catalog price", async () => {
    const h1 = harness({ fail: "System One API error (451): blocked" });
    await goStatus(h1, "partial");
    const p1 = h1.promptNow(UNCERTAIN);
    h1.clock.advance(400);
    h1.model.resolve(0, { content: [{ type: "text", text: REPLY_OK }], usage: USAGE });
    await p1;
    // Exact accounting lives on the kind:"call" record; the /mem jev line
    // is a 4-decimal display (§9.4) — assert each at its own precision.
    const [call1] = h1.predictCalls();
    expect(call1).toMatchObject({ kind: "call", ok: true, costSource: "usage" });
    expect(call1.costUsd).toBeCloseTo(DEEPSEEK_USAGE_USD, 9);
    const spent1 = Number(/\$([0-9.]+)\//.exec(await h1.report())![1]);
    expect(spent1).toBe(0.0003); // $0.000312 rendered at 4 decimals

    const h2 = harness({ fail: "System One API error (451): blocked" });
    await goStatus(h2, "partial");
    const p2 = h2.promptNow(UNCERTAIN);
    h2.clock.advance(400);
    h2.model.resolve(0, { content: [{ type: "text", text: REPLY_OK }] }); // no usage ⇒ reserve settlement
    await p2;
    const spent2 = Number(/\$([0-9.]+)\//.exec(await h2.report())![1]);
    expect(spent2).toBeGreaterThan(spent1); // the shared table accumulated
    const [call2] = h2.predictCalls();
    expect(call2.costSource).toBe("reserve");
    expect(call2.reserveUsd).toBeCloseTo(call2.costUsd, 12);
  });

  test("the predict line carries model/timely/cached/$est/breaker while model.enabled, and stays rules-only when off", async () => {
    const on = harness({ fail: "System One API error (451): blocked" });
    await goStatus(on, "partial");
    const p = on.promptNow(UNCERTAIN);
    on.clock.advance(400);
    on.model.resolve(0, { content: [{ type: "text", text: REPLY_OK }], usage: USAGE });
    await p;
    const text = await on.report();
    expect(text).toContain("predict  rules 1 · model 1 (timely 1, cached 0) · $");
    expect(text).toContain("/0.14 est today · breaker closed");

    const off = harness({ fail: "System One API error (451): blocked", predictModel: { enabled: false } });
    const offText = await off.report();
    expect(offText).toContain("predict  rules 0");
    expect(offText).not.toContain("model 0");
  });
});

// ───────────────────── binding details (§6.2) ─────────────────────

describe("model binding (§6.2, topic-switch runJudge shape)", () => {
  test("streamSimple is used with maxTokens 384 + reasoning minimal, and usage is passed through", async () => {
    const h = harness({ fail: "System One API error (451): blocked" });
    await goStatus(h, "partial");
    const p = h.promptNow(UNCERTAIN);
    h.clock.advance(400);
    h.model.resolve(0, { content: [{ type: "text", text: REPLY_OK }], usage: USAGE });
    await p;
    expect(h.model.calls).toHaveLength(1);
    const call = h.model.calls[0]!;
    expect(call.options).toMatchObject({ maxTokens: 384, reasoning: "minimal" });
    expect(call.options?.signal).toBeInstanceOf(AbortSignal);
    expect(call.context.systemPrompt).toContain("You predict which kinds of project rules");
    // The DTO rides inside the message's `content` string — assert on the
    // raw content (JSON.stringify of the whole messages array would escape
    // the inner quotes and never match a bare-quote needle).
    const user = String((call.context.messages[0] as { content: unknown }).content);
    expect(user).toContain('"rule_guess"');
    expect(user).not.toContain("发版前确认 CI"); // memory bodies never leave
    const [record] = h.predictCalls();
    expect(record.costSource).toBe("usage"); // usage reached the settlement
  });

  test("registries without streamSimple fall back to complete({signal, maxTokens: 384})", async () => {
    const h = harness({ fail: "System One API error (451): blocked", completeOnly: true });
    await goStatus(h, "partial");
    const p = h.promptNow(UNCERTAIN);
    h.clock.advance(400);
    h.model.resolve(0, { content: [{ type: "text", text: REPLY_OK }] });
    await p;
    expect(h.model.calls).toHaveLength(1);
    expect(h.model.calls[0]!.options).toMatchObject({ maxTokens: 384 });
    expect(h.model.calls[0]!.options?.reasoning).toBeUndefined();
  });
});
