// PG tests exercise only parsing, arithmetic and exact-cache replay. Synthetic
// records below are test inputs, never evaluation data or generated labels.
// The P2 clock/audit regressions inject PRODUCTION modules from source
// (src/core/clock, src/memory/jev/predict/{flight,ledger}) so CI never depends
// on a prebuilt or frozen dist; dist copies are checked opportunistically.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJevClient } from "../../../src/memory/jev/client.js";
import { createTokenBucket } from "../../../src/memory/jev/health.js";
import { jevConfigOf } from "../../../src/memory/jev/config.js";
import { parseMemorySettings } from "../../../src/memory/settings.js";
import { createFakeRegistry } from "../jev/helpers/fake-registry.js";
import { PredictCache } from "../../../src/memory/jev/predict/cache.js";
import * as srcClock from "../../../src/core/clock.js";
import * as srcTaxonomy from "../../../src/memory/jev/taxonomy.js";
import * as srcStore from "../../../src/memory/jev/index-store.js";
import * as srcLlm from "../../../src/memory/jev/predict/llm.js";
import * as srcOutbound from "../../../src/memory/jev/predict/outbound.js";
import * as srcFlight from "../../../src/memory/jev/predict/flight.js";
import { wireJev } from "../../../src/memory/jev/wire.js";
import { EntryIndex } from "../../../src/memory/jev/entries.js";
import { memorySection } from "../../../src/memory/inject.js";
import { RenderCache } from "../../../src/memory/render.js";
import { toSlug } from "../../../src/memory/paths.js";
import { localDayKey } from "../../../src/memory/jev/predict/ledger.js";
import { OUTER_GRACE_MS, createPredictFlight } from "../../../src/memory/jev/predict/flight.js";
import { createPredictLedger } from "../../../src/memory/jev/predict/ledger.js";
import {
  AUDIT_ERROR_CATEGORIES,
  bounded,
  clientFor,
  turnClient,
  logicalComplete,
  persistTurnSummary,
  p2Completion,
  registryFor,
  runTurn,
  canonical,
  classifierTransport,
  classifyErrorCategory,
  corpusAdapter,
  createAuditState,
  createChatCache,
  createFatalRejectionLatch,
  withFatalLatchScope,
  createReplyCache,
  digest,
  g1Support,
  g2P2Evidence,
  main,
  metricsG1,
  metricsG2,
  parseJsonl,
  productionClockPort,
  validateAnswers,
  validateLabels,
  validateRunBudgets,
  verifyTurnSources,
} from "../../../scripts/dev/memory36-gate.mjs";

const dirs: string[] = [];
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "memory36-offline-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function pairs() {
  return [
    ...Array.from({ length: 60 }, (_, i) => ({
      id: `n${i}`,
      expected: "negative",
      pairClass: i < 30 ? "agent-agent" : i < 45 ? "user-user" : "user-agent",
    })),
    ...Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, expected: "positive", pairClass: "user-user" })),
  ];
}
function turns() {
  return Array.from({ length: 30 }, (_, i) => ({ turnId: `t${i}`, relevantIds: i === 0 ? ["a", "b"] : ["a"] }));
}
const questions = { e1: { type: "bool", instructions: "production question", criteria: { true: "yes", false: "no" } } };
const model = { provider: "test", id: "classifier" };
const context = { state: { user_message: "a real request", today: "2026-11-06" }, questions };
const result = { stopReason: "stop", answers: { e1: { type: "bool", probability: 0.7 } } };

describe("PG budget admission", () => {
  it("accepts the authorized ceilings and rejects over-budget and invalid values without transport", () => {
    expect(validateRunBudgets(800, 900000, 1.5)).toBeUndefined();
    expect(validateRunBudgets(400, 900000, 0.5)).toBeUndefined();
    expect(() => validateRunBudgets(801, 900000, 1.5)).toThrow("invalid run budgets");
    expect(() => validateRunBudgets(800, 900000, 1.501)).toThrow("classifier cap exceeds approved budget");
    expect(() => validateRunBudgets(800, 900001, 1.5)).toThrow("invalid run budgets");
    expect(() => validateRunBudgets(0, 900000, 1.5)).toThrow("invalid run budgets");
  });
});

describe("PG parsing/provenance", () => {
  it("parses JSONL with blanks and rejects malformed records, duplicate ids and missing references", () => {
    expect(parseJsonl('\n{"id":"x"}\r\n\n')).toEqual([{ id: "x" }]);
    expect(() => parseJsonl('{"id":')).toThrow("line 1");
    const pair = {
      id: "x",
      a: "a",
      b: "b",
      expected: "negative",
      pairClass: "user-agent",
      rationale: "complementary",
      source: { project: "project" },
    };
    expect(validateLabels("g1", [pair], ["a", "b"])).toEqual([pair]);
    expect(() => validateLabels("g1", [pair, pair], ["a", "b"])).toThrow("duplicate");
    expect(() => validateLabels("g1", [pair], ["a"])).toThrow("reference");
    expect(() => validateLabels("g1", [{ ...pair, expected: "complementary" }], ["a", "b"])).toThrow("label");
    const turn = {
      turnId: "t",
      prompt: "review the implementation",
      relevantIds: ["a"],
      rationale: "applies",
      source: { sessionFile: "/local/session.jsonl", line: 2 },
    };
    expect(validateLabels("g2", [turn], ["a"])).toEqual([turn]);
    expect(() => validateLabels("g2", [{ ...turn, relevantIds: ["a", "a"] }], ["a"])).toThrow("relevantIds");
    expect(() => validateLabels("g2", [{ ...turn, source: { line: 0 } }], ["a"])).toThrow("source");
  });
  it("requires lossless old files and blocks, refuses private entries and unsafe filenames", () => {
    const item = {
      id: "a",
      project: "p",
      old: { file: "topic.md", hash: "old-hash" },
      block: { id: "topic.001", raw: "raw-block" },
    };
    const raw = { entries: [item], files: [{ project: "p", name: "topic.md", raw: "old raw" }] };
    expect(corpusAdapter(raw).entries).toEqual([item]);
    expect(() => corpusAdapter({ entries: [item] })).toThrow("snapshots");
    expect(() => corpusAdapter({ ...raw, entries: [{ ...item, private: true }] })).toThrow("private/secret");
    expect(() => corpusAdapter({ ...raw, files: [{ project: "p", name: "../topic.md", raw: "x" }] })).toThrow("unsafe");
  });
  it("verifies real user-message source lines and exact prompts without trusting label provenance", () => {
    const root = temp();
    const sessionFile = join(root, "session.jsonl");
    writeFileSync(
      sessionFile,
      JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "please review this" }] },
      }) + "\n",
    );
    const row = { prompt: "please review this", source: { sessionFile, line: 1 } };
    expect(verifyTurnSources([row], root).size).toBe(1);
    expect(() => verifyTurnSources([{ ...row, prompt: "fabricated" }], root)).toThrow("differs");
    expect(() => verifyTurnSources([row, row], root)).toThrow("duplicate");
    writeFileSync(
      sessionFile,
      JSON.stringify({ type: "message", message: { role: "assistant", content: "please review this" } }),
    );
    expect(() => verifyTurnSources([row], root)).toThrow("user message");
  });
});

describe("PG actual denominator arithmetic", () => {
  it("excludes audited labels from primary support and cannot pass ten positives", () => {
    const labels = [
      ...pairs().filter((r) => r.expected === "negative" || Number(r.id.slice(1)) < 10),
      ...Array.from({ length: 20 }, (_, i) => ({ id: `excluded${i}`, expected: "excluded", pairClass: "user-agent" })),
    ];
    expect(g1Support(labels)).toMatchObject({ negative: 60, positive: 10, excluded: 20, sufficient: false });
    const runs = labels.map((r) => ({ id: r.id, wouldAuto: r.expected !== "negative" }));
    expect(metricsG1(labels, runs).status).toBe("NOT-EVALUATED");
  });
  it("G1 requires all strata, full predictions, zero AA false-auto and positive recall", () => {
    const labels = pairs();
    const runs = labels.map((r) => ({ id: r.id, wouldAuto: r.expected === "positive" && Number(r.id.slice(1)) < 10 }));
    expect(metricsG1(labels, runs)).toMatchObject({
      status: "PASS",
      negative: 60,
      positive: 20,
      trueAuto: 10,
      positiveRecall: 0.5,
    });
    runs[30]!.wouldAuto = true;
    expect(metricsG1(labels, runs)).toMatchObject({ status: "PASS", falseAuto: 1 });
    runs[0]!.wouldAuto = true;
    expect(metricsG1(labels, runs)).toMatchObject({ status: "FAIL", falseAA: 1, falseAuto: 2 });
    runs[30]!.wouldAuto = false;
    expect(metricsG1(labels, runs).status).toBe("FAIL");
    expect(metricsG1(labels, runs.slice(1)).status).toBe("NOT-EVALUATED");
    expect(metricsG1(labels.slice(1), runs.slice(1)).status).toBe("NOT-EVALUATED");
    expect(
      metricsG1(
        labels,
        runs.map((r) => ({ id: r.id })),
      ).status,
    ).toBe("NOT-EVALUATED");
  });
  it("G1 fails at nine positive autos even with perfect negatives", () => {
    const labels = pairs();
    expect(
      metricsG1(
        labels,
        labels.map((r) => ({ id: r.id, wouldAuto: r.expected === "positive" && Number(r.id.slice(1)) < 9 })),
      ),
    ).toMatchObject({ status: "FAIL", positiveRecall: 0.45 });
  });
  it("G2 uses (turn,rule) pairs, not turn success or array lengths; requires noninferiority", () => {
    const labels = turns();
    const runs = labels.map((r, i) => ({
      turnId: r.turnId,
      oldIds: i < 18 ? ["a"] : [],
      newIds: i < 18 ? ["a", "b", "irrelevant"] : [],
    }));
    expect(metricsG2(labels, runs)).toMatchObject({
      status: "PASS",
      turns: 30,
      denominator: 31,
      oldHits: 18,
      newHits: 19,
      newRecall: 19 / 31,
    });
    expect(
      metricsG2(
        labels,
        runs.map((r) => ({ ...r, oldIds: ["a", "b"] })),
      ).status,
    ).toBe("FAIL");
    expect(
      metricsG2(
        labels,
        runs.map((r) => ({ ...r, newIds: ["irrelevant"] })),
      ).status,
    ).toBe("FAIL");
    expect(metricsG2(labels, runs.slice(1)).status).toBe("NOT-EVALUATED");
    expect(metricsG2(labels.slice(1), runs.slice(1)).status).toBe("NOT-EVALUATED");
  });
});

describe("PG exact classifier cache and offline network barrier", () => {
  it("is canonical for object order but sensitive to every semantic state/question/model field", () => {
    expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
    expect(digest({ model, context })).not.toBe(
      digest({ model, context: { ...context, state: { ...context.state, today: "2026-11-07" } } }),
    );
    expect(digest({ model, context })).not.toBe(digest({ model: { ...model, id: "other" }, context }));
  });
  it("never invokes a supplied transport without the LIVE switch, even if live:true", async () => {
    vi.stubEnv("PI_TOOLKIT_MEMORY36_GATE_LIVE", "");
    const transport = vi.fn();
    const cache = createReplyCache({ dir: temp(), namespace: { v: 1 }, live: true, transport });
    await expect(cache.classify(model, context)).rejects.toThrow("NOT-EVALUATED");
    expect(transport).not.toHaveBeenCalled();
    expect(cache.stats()).toMatchObject({ calls: 0, missing: 1 });
  });
  it("replays only complete exact responses, missing data never becomes a prediction", async () => {
    const dir = temp(),
      namespace = { v: 1 };
    const request = { model, context };
    const key = digest({ namespace, request });
    writeFileSync(
      join(dir, `${key}.json`),
      JSON.stringify({ key, requestHash: digest(request), elapsedMs: 0, result }),
    );
    const transport = vi.fn();
    const cache = createReplyCache({ dir, namespace, live: false, transport });
    expect(await cache.classify(model, context)).toEqual(result);
    expect(cache.stats()).toMatchObject({ hits: 1, missing: 0, calls: 0 });
    await expect(cache.classify(model, { ...context, state: { user_message: "different" } })).rejects.toThrow(
      "NOT-EVALUATED",
    );
    expect(transport).not.toHaveBeenCalled();
    writeFileSync(
      join(dir, `${key}.json`),
      JSON.stringify({ key, requestHash: digest(request), elapsedMs: 0, result: { stopReason: "stop", answers: {} } }),
    );
    await expect(cache.classify(model, context)).rejects.toThrow("answer type");
  });
  it("counts every actual transport attempt, enforces its cap and strips provider extras", async () => {
    vi.stubEnv("PI_TOOLKIT_MEMORY36_GATE_LIVE", "1");
    const dir = temp();
    const transport = vi.fn(async () => ({
      ...result,
      providerDebug: "must not persist",
      usage: { cost: { total: 0.01 } },
    }));
    const namespace = { v: 1 };
    const cache = createReplyCache({ dir, namespace, live: true, transport, maxCalls: 1 });
    const first = await cache.classify(model, context);
    expect(first).toMatchObject({ usage: { cost: { total: 0.01 } }, answers: result.answers });
    const key = digest({ namespace, request: { model, context } });
    expect(readFileSync(join(dir, `${key}.json`), "utf8")).not.toContain("providerDebug");
    await expect(cache.classify(model, { ...context, state: { user_message: "other" } })).rejects.toThrow(
      "budget/abort",
    );
    expect(transport).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toMatchObject({ calls: 1, failures: 1 });
  });
  it("rejects NaN/partial/invalid choice outputs rather than silently choosing false", () => {
    expect(() =>
      validateAnswers(questions, { ...result, answers: { e1: { type: "bool", probability: NaN } } }),
    ).toThrow("probability");
    expect(() => validateAnswers(questions, { stopReason: "error", answers: result.answers })).toThrow("incomplete");
    expect(() =>
      validateAnswers(
        { c1: { type: "choice", criteria: { conflict: "x" } } },
        {
          stopReason: "stop",
          answers: { c1: { type: "choice", choice: "invented", probabilities: { invented: 1 }, confidence: 1 } },
        },
      ),
    ).toThrow("choice");
  });
  it("replays measured latency using a virtual clock, not instant answers", async () => {
    vi.useFakeTimers();
    const dir = temp(),
      namespace = {};
    const request = { model, context },
      key = digest({ namespace, request });
    writeFileSync(
      join(dir, `${key}.json`),
      JSON.stringify({ key, requestHash: digest(request), elapsedMs: 80, result }),
    );
    const cache = createReplyCache({ dir, namespace });
    let done = false;
    const pending = cache.classify(model, context).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(79);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(done).toBe(true);
  });
});

describe("PG chat replay and hard abort", () => {
  it("refuses a missing chat catalog offline without accessing runtime", async () => {
    vi.stubEnv("PI_TOOLKIT_MEMORY36_GATE_LIVE", "");
    const runtime = { getModel: vi.fn() };
    await expect(
      createChatCache({ dir: temp(), models: ["test/chat"], live: false, runtime, maxCalls: 2, maxUsd: 1 }),
    ).rejects.toThrow("catalog absent");
    expect(runtime.getModel).not.toHaveBeenCalled();
  });
  it("refuses uncached chat DTO offline even when caller supplies runtime", async () => {
    vi.stubEnv("PI_TOOLKIT_MEMORY36_GATE_LIVE", "");
    const dir = temp(),
      models = ["test/chat"];
    writeFileSync(
      join(dir, `chat-models-${digest(models)}.json`),
      JSON.stringify([{ provider: "test", id: "chat", cost: { input: 1, output: 1, cacheRead: 1 } }]),
    );
    const runtime = { streamSimple: vi.fn() };
    const chat = await createChatCache({ dir, models, namespace: {}, live: true, runtime, maxCalls: 2, maxUsd: 1 });
    await expect(
      chat
        .streamSimple(
          chat.find("test", "chat"),
          { systemPrompt: "closed tags", messages: [{ role: "user", content: "{}", timestamp: 1 }] },
          { maxTokens: 10 },
        )
        .result(),
    ).rejects.toThrow("uncached chat DTO");
    expect(runtime.streamSimple).not.toHaveBeenCalled();
    expect(chat.stats()).toMatchObject({ calls: 0, missing: 1 });
  });
  it("aborts and settles an ignoring callback at the deadline", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const result = bounded((s: AbortSignal) => {
      signal = s;
      return new Promise(() => {});
    }, 10);
    const assertion = expect(result).rejects.toThrow("deadline/abort");
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    expect(signal?.aborted).toBe(true);
  });
  it("keeps production thresholds/caps/selection out of script literals", () => {
    const source = readFileSync("scripts/dev/memory36-gate.mjs", "utf8");
    expect(source).toContain("memory/govern/supersede.js");
    expect(source).toContain("memory/govern/decay.js");
    expect(source).toContain("createJevWritePort");
    expect(source).toContain('handlers.get("before_agent_start")');
    expect(source).toContain("governance.supersede");
    expect(source).not.toMatch(/(?:SUPERSEDE_AUTO_P|CONFLICT_AUTO_P|TOPIC_USER_POOL_CAP|AUTO_PER_WRITE_MAX)\s*=\s*\d/);
    expect(source).not.toMatch(/\b0\.(?:85|90|93|95|97)\b|\b64\b/);
    expect(source).not.toContain("enabled: false");
  });
  it("injects the production Clock port, never the raw timer shape", () => {
    const source = readFileSync("scripts/dev/memory36-gate.mjs", "utf8");
    expect(source).toContain("clock: productionClockPort(p)");
    expect(source).not.toMatch(/\bclock:\s*\{/);
  });
});

/** The 2026-11-06 authorized G2 live run died at baseline
 * `predict/flight.js:242` because the harness passed the RAW timer shape
 * (`{now,set,clear}`) where BOTH pinned production versions require the full
 * Clock contract (`setTimer`/`clearTimer`). These regressions drive the real
 * production P2 start/flight path — not another layer of pure mocks — with
 * the exact port runTurn now injects, built through each version's own
 * `createSegmentedClock`. */
describe("PG P2 clock port regression (live G2 defect)", () => {
  const FROZEN_DISTS = [
    "/tmp/memory36-current-efa12f26-k9A1Uh/dist/core/clock.js",
    "/tmp/memory36-baseline-122de638-a1KeOc/dist/core/clock.js",
  ];
  function instrument(clock: {
    now(): number;
    setTimer(ms: number, fn: () => void): unknown;
    clearTimer(h: unknown): void;
  }) {
    let setCalls = 0;
    let clearCalls = 0;
    return {
      clock: {
        now: () => clock.now(),
        setTimer: (ms: number, fn: () => void) => {
          setCalls += 1;
          return clock.setTimer(ms, fn);
        },
        clearTimer: (h: unknown) => {
          clearCalls += 1;
          clock.clearTimer(h);
        },
      },
      counts: () => ({ setCalls, clearCalls }),
    };
  }
  const price = { inputPerM: 0.3, cacheReadPerM: 0.006, outputPerM: 1.2 };
  interface FlightLike {
    start(input: unknown): Promise<{ kind: string }>;
  }
  interface LedgerLike {
    snapshot(now: number): { spent: number };
  }
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }
  it("passes the full production Clock contract through each version's own createSegmentedClock", async () => {
    vi.useFakeTimers();
    const modules: Array<[string, () => Promise<unknown>]> = [
      ["current source src/core/clock.ts", async () => srcClock],
    ];
    if (existsSync(resolve("dist/core/clock.js")))
      modules.push(["repo dist/core/clock.js", () => import(pathToFileURL(resolve("dist/core/clock.js")).href)]);
    for (const frozen of FROZEN_DISTS)
      if (existsSync(frozen)) modules.push([`frozen dist ${frozen}`, () => import(pathToFileURL(frozen).href)]);
    expect(modules.length).toBeGreaterThanOrEqual(1);
    for (const [name, load] of modules) {
      const clock = productionClockPort(await load()) as unknown as {
        now(): number;
        setTimer(ms: number, fn: () => void): unknown;
        clearTimer(h: unknown): void;
      };
      expect(typeof clock.now, name).toBe("function");
      expect(typeof clock.setTimer, name).toBe("function");
      expect(typeof clock.clearTimer, name).toBe("function");
      let fired = 0;
      const handle = clock.setTimer(40, () => {
        fired += 1;
      });
      expect(fired, name).toBe(0);
      await vi.advanceTimersByTimeAsync(40);
      expect(fired, name).toBe(1);
      clock.clearTimer(handle);
      clock.clearTimer(
        clock.setTimer(40, () => {
          fired += 1;
        }),
      );
      await vi.advanceTimersByTimeAsync(80);
      expect(fired, name).toBe(1);
    }
  });
  it("runs a real production flight dispatch: timers arm, replayed latency elapses, setTimer/clearTimer are actually called", async () => {
    vi.useFakeTimers();
    const base = productionClockPort(srcClock) as unknown as {
      now(): number;
      setTimer(ms: number, fn: () => void): unknown;
      clearTimer(h: unknown): void;
    };
    const { clock, counts } = instrument(base);
    const ledger = createPredictLedger(new Map(), { maxCallsPerDay: 10, maxUsdPerDay: 5 });
    const flight = createPredictFlight(ledger, { requestBudgetMs: 2000, maxCallsPerDay: 10, maxUsdPerDay: 5, clock });
    const completion = { text: "pred", usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 5 } };
    const models = [
      {
        provider: "test",
        id: "chat",
        price,
        port: {
          complete: () =>
            new Promise((resolve) => {
              const t = setTimeout(() => resolve(completion), 80);
              t.unref?.();
            }),
        },
      },
    ];
    const input = { system: "s", user: "u", models };
    expect(flight.admit(input)).toBe(true);
    const outcomeP = flight.start(input);
    await vi.advanceTimersByTimeAsync(80);
    const outcome = await outcomeP;
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.text).toBe("pred");
      expect(outcome.attempts[0]?.kind).toBe("ok");
      expect(outcome.attempts[0]?.costSource).toBe("usage");
      // The transport seam's delayed response really elapsed inside the
      // attempt accounting (cached replay latency must not be instant).
      expect(outcome.attempts[0]?.ms).toBeGreaterThanOrEqual(80);
    }
    expect(counts().setCalls).toBeGreaterThanOrEqual(2);
    expect(counts().clearCalls).toBeGreaterThanOrEqual(1);
    expect(ledger.snapshot(clock.now()).spent).toBeGreaterThan(0);
    expect(flight.isInFlight()).toBe(false);
    expect(flight.zombies()).toBe(0);
  });
  it("outer deadline really fires through the production clock: zombie settles by reserve, late completion only clears the zombie", async () => {
    vi.useFakeTimers();
    const base = productionClockPort(srcClock) as unknown as {
      now(): number;
      setTimer(ms: number, fn: () => void): unknown;
      clearTimer(h: unknown): void;
    };
    const { clock } = instrument(base);
    const ledger = createPredictLedger(new Map(), { maxCallsPerDay: 10, maxUsdPerDay: 5 });
    const flight = createPredictFlight(ledger, { requestBudgetMs: 2000, maxCallsPerDay: 10, maxUsdPerDay: 5, clock });
    const late = deferred<{ text: string }>();
    const outcomeP = flight.start({
      system: "s",
      user: "u",
      models: [{ provider: "test", id: "chat", price, port: { complete: () => late.promise } }],
    });
    await vi.advanceTimersByTimeAsync(2000 + OUTER_GRACE_MS + 10);
    const outcome = await outcomeP;
    expect(outcome.kind).toBe("timeout");
    expect(outcome.attempts[0]?.kind).toBe("timeout");
    expect(outcome.attempts[0]?.costSource).toBe("reserve");
    expect(flight.zombies()).toBe(1);
    expect(ledger.snapshot(clock.now()).spent).toBeGreaterThan(0);
    late.resolve({ text: "late" });
    await vi.advanceTimersByTimeAsync(1);
    expect(flight.zombies()).toBe(0);
  });
  it("shutdown aborts an ignoring transport, clears timers and releases the reservation without charging", async () => {
    vi.useFakeTimers();
    const base = productionClockPort(srcClock) as unknown as {
      now(): number;
      setTimer(ms: number, fn: () => void): unknown;
      clearTimer(h: unknown): void;
    };
    const { clock, counts } = instrument(base);
    const ledger = createPredictLedger(new Map(), { maxCallsPerDay: 10, maxUsdPerDay: 5 });
    const flight = createPredictFlight(ledger, { requestBudgetMs: 2000, maxCallsPerDay: 10, maxUsdPerDay: 5, clock });
    const outcomeP = flight.start({
      system: "s",
      user: "u",
      models: [
        { provider: "test", id: "chat", price, port: { complete: () => new Promise<{ text: string }>(() => {}) } },
      ],
    });
    await vi.advanceTimersByTimeAsync(0);
    flight.shutdown();
    const outcome = await outcomeP;
    expect(outcome.kind).toBe("aborted");
    expect(flight.isDisposed()).toBe(true);
    expect(flight.isBreakerOpen()).toBe(false);
    expect(counts().clearCalls).toBeGreaterThanOrEqual(1);
    expect(ledger.snapshot(clock.now()).spent).toBe(0);
  });
  it("rejects the legacy raw timer shape at the same production call site the live run hit", async () => {
    vi.useFakeTimers();
    // Exactly what the frozen 87fa2167 script passed as `clock:` to wireJev:
    // a RawTimerClock, not a Clock. Both pinned production versions call
    // `clock.setTimer` synchronously inside start(). An already-aborted signal
    // keeps the attempt loop off the timers so the rejection surfaces at the
    // outer-deadline call site (baseline flight.js:242) without an unhandled
    // attempt-loop rejection.
    const legacyRaw = {
      now: Date.now,
      set: (ms: number, fn: () => void) => setTimeout(fn, ms),
      clear: (t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>),
    };
    expect((legacyRaw as unknown as { setTimer?: unknown }).setTimer).toBeUndefined();
    const ledger = createPredictLedger(new Map(), { maxCallsPerDay: 5, maxUsdPerDay: 5 });
    const flight = createPredictFlight(ledger, {
      requestBudgetMs: 1500,
      maxCallsPerDay: 5,
      maxUsdPerDay: 5,
      clock: legacyRaw as never,
    });
    await expect(
      flight.start({
        system: "s",
        user: "u",
        models: [
          { provider: "test", id: "chat", price, port: { complete: () => new Promise<{ text: string }>(() => {}) } },
        ],
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow(/setTimer is not a function/);
  });
  it("drives each locally available frozen dist's own production flight through the harness clock port (local-only branch)", async () => {
    vi.useFakeTimers();
    const FROZEN_FLIGHT = ["/tmp/memory36-current-efa12f26-k9A1Uh/dist", "/tmp/memory36-baseline-122de638-a1KeOc/dist"];
    for (const distRoot of FROZEN_FLIGHT) {
      const flightPath = join(distRoot, "memory/jev/predict/flight.js");
      if (!existsSync(flightPath)) continue; // CI: source-injected variant above always runs
      const flightMod = (await import(pathToFileURL(flightPath).href)) as {
        createPredictFlight: (ledger: unknown, config: Record<string, unknown>) => FlightLike;
      };
      const ledgerMod = (await import(pathToFileURL(join(distRoot, "memory/jev/predict/ledger.js")).href)) as {
        createPredictLedger: (
          table: Map<string, unknown>,
          config: { maxCallsPerDay: number; maxUsdPerDay: number },
        ) => LedgerLike;
      };
      const clockMod = await import(pathToFileURL(join(distRoot, "core/clock.js")).href);
      const base = productionClockPort(clockMod) as unknown as {
        now(): number;
        setTimer(ms: number, fn: () => void): unknown;
        clearTimer(h: unknown): void;
      };
      const { clock, counts } = instrument(base);
      const ledger = ledgerMod.createPredictLedger(new Map(), { maxCallsPerDay: 10, maxUsdPerDay: 5 });
      const flight = flightMod.createPredictFlight(ledger, {
        requestBudgetMs: 2000,
        maxCallsPerDay: 10,
        maxUsdPerDay: 5,
        clock,
      });
      const completion = { text: "pred", usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 5 } };
      const outcomeP = flight.start({
        system: "s",
        user: "u",
        models: [
          {
            provider: "test",
            id: "chat",
            price,
            port: {
              complete: () =>
                new Promise((resolve) => {
                  const t = setTimeout(() => resolve(completion), 80);
                  t.unref?.();
                }),
            },
          },
        ],
      });
      await vi.advanceTimersByTimeAsync(80);
      const outcome = await outcomeP;
      expect(outcome.kind, distRoot).toBe("ok");
      expect(counts().setCalls, distRoot).toBeGreaterThanOrEqual(2);
      expect(counts().clearCalls, distRoot).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("PG run audit state and formal P2 evidence gate", () => {
  const budgets = { maxCalls: 400, maxClassifierUsd: 0.5, maxChatCalls: 80, maxChatUsd: 0.28, timeoutMs: 900000 };
  const provenance = (mode: "live" | "replay", filesAtStart: number) => ({
    mode,
    filesAtStart,
    freshEmptyAtStart: filesAtStart === 0,
  });
  it("persists a 0600 per-attempt audit file from run start with durable pre-transport counts", () => {
    const dir = temp();
    const audit = createAuditState({ dir, mode: "g2", budgets, cacheProvenance: provenance("live", 0) });
    expect(audit.file).toBe(`audit/attempt-${audit.attemptId}.json`);
    expect(JSON.parse(readFileSync(audit.path, "utf8"))).toMatchObject({
      attempt: audit.attemptId,
      mode: "g2",
      status: "running",
      finishedAt: null,
      budgets,
      cacheProvenance: provenance("live", 0),
      cost: { classifier: { calls: 0, reservedUsd: 0 }, chat: { calls: 0, reservedUsd: 0 } },
      error: null,
    });
    expect(statSync(audit.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "audit")).mode & 0o777).toBe(0o700);
    // Conservative counts land on disk BEFORE the transport can fire (the
    // SIGKILL window: this read needs no finish() and no in-memory state).
    audit.noteTransport("classifier", 1, 0.001344);
    audit.noteTransport("chat", 1, 0.002);
    expect(JSON.parse(readFileSync(audit.path, "utf8"))).toMatchObject({
      status: "running",
      cost: { classifier: { calls: 1, reservedUsd: 0.001344 }, chat: { calls: 1, reservedUsd: 0.002 } },
    });
    audit.finish({
      status: "NOT-EVALUATED",
      errorCategory: "clock-port",
      cache: { calls: 1, hits: 0, missing: 0, failures: 1 },
    });
    expect(JSON.parse(readFileSync(audit.path, "utf8"))).toMatchObject({
      status: "NOT-EVALUATED",
      error: "clock-port",
      cache: { calls: 1, hits: 0, missing: 0, failures: 1 },
    });
    // Non-enum categories are refused: no free text can ever be written.
    expect(() => audit.finish({ status: "NOT-EVALUATED", errorCategory: "401 provider body" })).toThrow();
  });
  it("keeps every attempt byte-identical: same-dir retries/replays never overwrite prior live evidence", () => {
    const dir = temp();
    // The Sonnet-review scenario: a live attempt died mid-run (status running,
    // 7 dispatched calls on disk), then the SAME data dir is reused.
    const live = createAuditState({
      dir,
      mode: "g2",
      budgets,
      cacheProvenance: provenance("live", 0),
      attemptId: "20261106T105522Z-123-ab12cd34",
    });
    live.noteTransport("classifier", 7, 0.009408);
    const sentinel = readFileSync(live.path, "utf8");
    const replay = createAuditState({
      dir,
      mode: "g2",
      budgets,
      cacheProvenance: provenance("replay", 3),
      attemptId: "20261106T193000Z-455-ef56ab78",
    });
    expect(replay.path).not.toBe(live.path);
    replay.noteTransport("classifier", 0, 0);
    replay.finish({ status: "NOT-EVALUATED", errorCategory: "chat-catalog" });
    // Prior live attempt untouched byte-for-byte, still running, calls still 7.
    expect(readFileSync(live.path, "utf8")).toBe(sentinel);
    expect(JSON.parse(sentinel)).toMatchObject({
      status: "running",
      cost: { classifier: { calls: 7, reservedUsd: 0.009408 } },
    });
    // Auto-generated attempt ids are unique; a colliding id fails closed
    // ("wx") instead of clobbering the existing evidence file.
    const a = createAuditState({ dir, mode: "g1", budgets });
    const b = createAuditState({ dir, mode: "g1", budgets });
    expect(a.attemptId).not.toBe(b.attemptId);
    expect(() => createAuditState({ dir, mode: "g1", budgets, attemptId: "20261106T105522Z-123-ab12cd34" })).toThrow();
    // SIGKILL-style durability: reserve readable without finish.
    a.noteTransport("chat", 1, 0.002);
    expect(JSON.parse(readFileSync(a.path, "utf8"))).toMatchObject({
      cost: { chat: { calls: 1, reservedUsd: 0.002 } },
    });
  });
  it("maps errors to the closed category set: no sample text, keys, headers, queries or bodies can reach the audit", () => {
    // Synthetic adversarial error (no real credentials read): key JSON,
    // Authorization header, URL query secret, provider-echoed private text,
    // newlines and an unknown Error.name/code/stack.
    const hostile = new Error(
      [
        `failed to parse auth: ${JSON.stringify({ apiKey: "abcdefghijklmnop1234567890" })}`,
        "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
        '401 body: {"error":"provider echoed the private user prompt text"}',
        "https://provider.example/v1?q=sk-secretsecretsecret01",
      ].join("\n"),
    );
    hostile.name = "ProviderAuthError";
    hostile.code = "E_AUTH leaked";
    hostile.stack = "Error: at secretsecretsecret01 (file:line)";
    const category = classifyErrorCategory(hostile);
    expect(AUDIT_ERROR_CATEGORIES).toContain(category);
    expect(category).toBe("unclassified");
    const recorded = JSON.stringify({ error: category });
    for (const sample of [
      "abcdefghijklmnop1234567890",
      "abcdefghijklmnopqrstuvwxyz123456",
      "secretsecretsecret01",
      "provider echoed",
      "Authorization",
      "ProviderAuthError",
      "E_AUTH",
      "\\n",
    ])
      expect(recorded).not.toContain(sample);
    // Known controlled failures map to stable, distinguishable constants.
    expect(classifyErrorCategory(new TypeError("clock.setTimer is not a function"))).toBe("clock-port");
    expect(classifyErrorCategory(new Error("NOT-EVALUATED: chat catalog absent"))).toBe("chat-catalog");
    expect(classifyErrorCategory(new Error("NOT-EVALUATED: deadline/abort"))).toBe("deadline-abort");
    expect(classifyErrorCategory(new Error("NOT-EVALUATED: classifier USD cap"))).toBe("classifier-budget");
    expect(classifyErrorCategory(new Error("NOT-EVALUATED: pre-transport audit write failed"))).toBe("audit-write");
    expect(classifyErrorCategory(new Error("NOT-EVALUATED: uncached chat DTO"))).toBe("cache-missing");
    expect(classifyErrorCategory("not an error")).toBe("unclassified");
    expect(classifyErrorCategory(undefined)).toBe("unclassified");
  });
  it("a failed pre-transport chat audit write fails closed: no transport call, explicit failure, no P2 evidence", async () => {
    vi.stubEnv("PI_TOOLKIT_MEMORY36_GATE_LIVE", "1");
    const dir = temp();
    const runtimeModel = { provider: "test", id: "chat", cost: { input: 1, output: 1, cacheRead: 1 } };
    writeFileSync(
      join(dir, `chat-models-${digest(["test/chat"])}.json`),
      JSON.stringify([{ ...runtimeModel, semanticHash: digest(runtimeModel) }]),
    );
    const runtime = { getModel: vi.fn(() => runtimeModel), streamSimple: vi.fn() };
    const failingAudit = {
      noteTransport: vi.fn(() => {
        throw new Error("EACCES: disk full");
      }),
      finish: vi.fn(),
    };
    const chat = await createChatCache({
      dir,
      models: ["test/chat"],
      namespace: {},
      live: true,
      runtime,
      maxCalls: 2,
      maxUsd: 1,
      signal: new AbortController().signal,
      audit: failingAudit as never,
      estimate: () => 0.001,
    });
    await expect(
      chat
        .streamSimple(
          chat.find("test", "chat"),
          { systemPrompt: "s", messages: [{ role: "user", content: "{}" }] },
          { maxTokens: 10 },
        )
        .result(),
    ).rejects.toThrow("pre-transport audit write failed");
    expect(runtime.streamSimple).not.toHaveBeenCalled();
    const stats = chat.stats();
    expect(stats.calls).toBe(0);
    expect(stats.failures).toBe(1);
    expect(stats.reservedUsd).toBeGreaterThan(0); // conservative reserve kept, not refunded
    expect(g2P2Evidence(stats, { missing: 0, failures: 0 }).satisfied).toBe(false);
  });
  it("classifier transport fails closed the same way, and its audit note precedes the request", async () => {
    vi.stubEnv("PI_TOOLKIT_MEMORY36_GATE_LIVE", "1");
    const modelSpec = {
      provider: "test",
      id: "classifier",
      cost: { input: 1, output: 1 },
      contextWindow: 8192,
    };
    const failingAudit = {
      noteTransport: vi.fn(() => {
        throw new Error("EACCES: disk full");
      }),
    };
    const failing = classifierTransport(
      { getModelOfType: vi.fn(() => modelSpec), classify: vi.fn() } as never,
      1000,
      0.5,
      failingAudit as never,
    );
    await expect(failing({ provider: "test", id: "classifier" }, context, {})).rejects.toThrow(
      "pre-transport audit write failed",
    );
    // Durable note ordering: the audit record is written BEFORE the request.
    const noteTransport = vi.fn();
    const classify = vi.fn(async () => result);
    const ok = classifierTransport({ getModelOfType: vi.fn(() => modelSpec), classify } as never, 1000, 0.5, {
      noteTransport,
    } as never);
    await ok({ provider: "test", id: "classifier" }, context, {});
    expect(noteTransport.mock.invocationCallOrder[0]).toBeLessThan(classify.mock.invocationCallOrder[0]);
    expect(noteTransport).toHaveBeenCalledWith("classifier", 1, expect.any(Number));
  });
  it("formal G2 requires actual P2 calls/hits above zero and zero cache missing/failures", () => {
    const clean = { missing: 0, failures: 0 };
    expect(g2P2Evidence(undefined, clean).satisfied).toBe(false);
    expect(g2P2Evidence({ calls: 0, hits: 0, missing: 0, failures: 0 }, clean).satisfied).toBe(false);
    expect(g2P2Evidence({ calls: 2, hits: 1, missing: 0, failures: 0 }, clean)).toMatchObject({
      satisfied: true,
      calls: 2,
      hits: 1,
    });
    expect(g2P2Evidence({ calls: 2, hits: 2, missing: 1, failures: 0 }, clean).satisfied).toBe(false);
    expect(g2P2Evidence({ calls: 2, hits: 2, missing: 0, failures: 0 }, { missing: 0, failures: 1 }).satisfied).toBe(
      false,
    );
  });
});

/** Root-confirmed narrow gap: the fatal-rejection handler used to only set
 * process.exitCode/audit NOT-EVALUATED, but main could still return PASS,
 * audit.finish could overwrite the record and the CLI `.then(code)` mapping
 * reset the exit code to 0. The latch below pins the sticky semantics. */
describe("PG fatal-rejection sticky latch", () => {
  const budgets = { maxCalls: 400, maxClassifierUsd: 0.5, maxChatCalls: 80, maxChatUsd: 0.28, timeoutMs: 900000 };
  it("a tripped latch forces NOT-EVALUATED/2 and keeps the closed category against a would-be PASS", () => {
    const audit = createAuditState({ dir: temp(), mode: "g2", budgets, attemptId: "latch-pass" });
    const abortCalls: number[] = [];
    let exitCode: number | undefined;
    const latch = createFatalRejectionLatch({
      audit,
      abort: () => abortCalls.push(1),
      setExitCode: (code) => {
        exitCode = code;
      },
    });
    // Capture the callback exactly the way main registers it; call it
    // directly — never emit a real global unhandledRejection (Vitest's own
    // handler owns that channel).
    const once = vi.spyOn(process, "once");
    process.once("unhandledRejection", latch.onFatalRejection);
    const registered = once.mock.calls.find(([name]) => name === "unhandledRejection")?.[1];
    once.mockRestore();
    expect(registered).toBeTypeOf("function");
    (registered as () => void)();
    // Would-be-PASS gate step after the trip: status mapping, the normal
    // audit finish and the CLI exit mapping — none may restore PASS/exit 0.
    const metricsStatus = latch.forcedStatus("PASS");
    expect(metricsStatus).toBe("NOT-EVALUATED");
    audit.finish({ status: metricsStatus, cache: { calls: 1, hits: 1, missing: 0, failures: 0 } });
    expect(latch.forcedExit(0)).toBe(2);
    expect(exitCode).toBe(2);
    expect(abortCalls).toHaveLength(1);
    const state = JSON.parse(readFileSync(audit.path, "utf8"));
    expect(state.status).toBe("NOT-EVALUATED");
    expect(state.error).toBe("unhandled-rejection");
    process.removeListener("unhandledRejection", latch.onFatalRejection);
  });
  it("the exception-path finalize shape keeps the closed category once tripped; untripped is identity", () => {
    const audit = createAuditState({ dir: temp(), mode: "g2", budgets, attemptId: "latch-err" });
    const latch = createFatalRejectionLatch({ audit });
    latch.onFatalRejection();
    // main's catch path supplies no replacement category once tripped:
    audit.finish({
      status: "NOT-EVALUATED",
      ...(latch.tripped() ? {} : { errorCategory: classifyErrorCategory(new Error("boom")) }),
    });
    expect(JSON.parse(readFileSync(audit.path, "utf8")).error).toBe("unhandled-rejection");
    // Untripped latch changes nothing — the normal catch path keeps mapping.
    const audit2 = createAuditState({ dir: temp(), mode: "g2", budgets, attemptId: "latch-err2" });
    const latch2 = createFatalRejectionLatch({ audit: audit2 });
    expect(latch2.forcedStatus("PASS")).toBe("PASS");
    expect(latch2.forcedExit(0)).toBe(0);
    expect(latch2.tripped()).toBe(false);
  });
  it("main's listener helper removes the listener on success and consecutive activations", async () => {
    const before = process.listenerCount("unhandledRejection");
    for (let i = 0; i < 2; i++) {
      const audit = createAuditState({ dir: temp(), mode: "g2", budgets });
      const controller = new AbortController();
      const value = await withFatalLatchScope({ audit, controller }, async (latch) => {
        expect(process.listenerCount("unhandledRejection")).toBe(before + 1);
        expect(latch.forcedExit(0)).toBe(0);
        audit.finish({ status: "PASS" });
        return "success";
      });
      expect(value).toBe("success");
      expect(JSON.parse(readFileSync(audit.path, "utf8")).status).toBe("PASS");
      expect(process.listenerCount("unhandledRejection")).toBe(before);
    }
  });
  it("main's listener helper removes on exception and preserves a previously tripped latch", async () => {
    const before = process.listenerCount("unhandledRejection");
    for (const trip of [false, true]) {
      const audit = createAuditState({ dir: temp(), mode: "g2", budgets });
      const controller = new AbortController();
      let exitCode = 0;
      await expect(
        withFatalLatchScope(
          {
            audit,
            controller,
            setExitCode: (code) => {
              exitCode = code;
            },
          },
          async (latch) => {
            expect(process.listenerCount("unhandledRejection")).toBe(before + 1);
            if (trip) {
              latch.onFatalRejection(); // direct hook, never emit into Vitest
              audit.finish({ status: latch.forcedStatus("PASS") });
              exitCode = latch.forcedExit(0);
            }
            throw new Error("synthetic scope error");
          },
        ),
      ).rejects.toThrow("synthetic scope error");
      expect(process.listenerCount("unhandledRejection")).toBe(before);
      expect(controller.signal.aborted).toBe(trip);
      const recorded = JSON.parse(readFileSync(audit.path, "utf8"));
      if (trip) {
        expect(recorded).toMatchObject({ status: "NOT-EVALUATED", error: "unhandled-rejection" });
        expect(exitCode).toBe(2);
      } else {
        expect(recorded).toMatchObject({ status: "running", error: null });
        expect(exitCode).toBe(0);
      }
    }
  });
});

describe("PG shared production client and per-sample logical completion", () => {
  function config(maxCalls = 50) {
    return {
      ...jevConfigOf(parseMemorySettings({})),
      classifiers: ["test/free", "test/paid"],
      proxy: "",
      maxCalls,
      maxCostUsd: 0.5,
    };
  }
  function request(registry: unknown) {
    return { duty: "recall", registry, state: context.state, questions, mode: "sync", budgetMs: 4000 };
  }
  function scope(client: unknown, sampleId: string) {
    return turnClient(client, { evalId: "fake-eval", sampleId, turn: 1, variant: "new" });
  }
  function fake(responses: Record<string, unknown[]>) {
    return createFakeRegistry({ available: ["test/free", "test/paid"], responses: responses as never });
  }
  it("shares the actual production lastModel closure across turns, not merely health", async () => {
    const { registry, callCountFor } = fake({
      "test/free": [{ stopReason: "error", errorMessage: "temporary failure" }],
      "test/paid": [result, result],
    });
    const health = new Map();
    const client = createJevClient({
      config: config(),
      isChild: false,
      now: Date.now,
      health,
      bucket: createTokenBucket(),
    });
    await client.probe(registry);
    const a = scope(client, "a");
    expect((await a.client.ask(request(registry))).ok).toBe(true);
    a.close();
    client.abortBackground();
    // Equalize health: only lastModel can now prefer paid over config-first free.
    health.clear();
    const b = scope(client, "b");
    expect((await b.client.ask(request(registry))).model).toBe("test/paid");
    expect(callCountFor("test/free")).toBe(1);
    expect(callCountFor("test/paid")).toBe(2);
    expect(b.usage().calls).toBe(1);
    expect(b.usage().cumulative.calls).toBeGreaterThan(b.usage().calls);
    b.close();
  });
  it("handled tier failure plus FINAL fallback answers is resolved", async () => {
    const { registry } = fake({
      "test/free": [{ stopReason: "error", errorMessage: "temporary" }],
      "test/paid": [result],
    });
    const client = clientFor({ createJevClient, createTokenBucket }, config());
    const a = scope(client, "a");
    await a.client.ask(request(registry));
    expect(a.outcomes).toMatchObject([
      { requestedIds: ["e1"], answeredIds: ["e1"], ok: true, reason: "resolved", callseq: 1 },
    ]);
    expect(logicalComplete(a.outcomes)).toBe(true);
    a.close();
  });
  it("same DTO success in a later sample never backfills an earlier failed FINAL outcome", async () => {
    const { registry } = fake({
      "test/free": [{ stopReason: "error", errorMessage: "temporary" }, result],
      "test/paid": [{ stopReason: "error", errorMessage: "temporary" }],
    });
    const client = clientFor({ createJevClient, createTokenBucket }, config());
    const a = scope(client, "a");
    await a.client.ask(request(registry));
    a.close();
    const b = scope(client, "b");
    await b.client.ask(request(registry));
    b.close();
    expect(logicalComplete(a.outcomes)).toBe(false);
    expect(logicalComplete(b.outcomes)).toBe(true);
    expect(a.outcomes[0].sampleId).toBe("a");
    expect(b.outcomes[0].callseq).toBe(1);
  });
  it("partial answers are unresolved, never evaluated negative zero", async () => {
    const { registry } = fake({ "test/free": [{ stopReason: "stop", answers: {} }] });
    const a = scope(clientFor({ createJevClient, createTokenBucket }, config()), "partial");
    await a.client.ask(request(registry));
    expect(a.outcomes[0]).toMatchObject({ ok: true, resolved: false, reason: "missing-or-invalid" });
    expect(metricsG2(turns(), [{ turnId: "t0" }]).status).toBe("NOT-EVALUATED");
    a.close();
  });
  it("finite production activation budget really exhausts and remains sticky across turns", async () => {
    const { registry, callCountFor } = fake({ "test/free": [result, result] });
    const cfg = config(1),
      client = clientFor({ createJevClient, createTokenBucket }, cfg);
    const a = scope(client, "a");
    await a.client.ask(request(registry));
    a.close();
    const b = scope(client, "b");
    expect(await b.client.ask(request(registry))).toMatchObject({ ok: false, reason: "budget" });
    client.abortBackground();
    expect(await b.client.ask(request(registry))).toMatchObject({ ok: false, reason: "budget" });
    expect(cfg.maxCalls).toBe(1);
    expect(logicalComplete(b.outcomes)).toBe(false);
    expect(callCountFor("test/free")).toBe(1);
    b.close();
  });
  it("turn cleanup unsubscribes status callbacks and abortBackground does not poison the next ask", async () => {
    const { registry } = fake({ "test/free": [result, result] });
    const client = clientFor({ createJevClient, createTokenBucket }, config());
    const a = scope(client, "a"),
      cb = vi.fn();
    a.client.onStatusChange(cb);
    expect(a.subscriptions()).toBe(1);
    await a.client.ask(request(registry));
    a.close();
    cb.mockClear();
    client.abortBackground();
    const b = scope(client, "b");
    expect((await b.client.ask(request(registry))).ok).toBe(true);
    expect(a.subscriptions()).toBe(0);
    expect(cb).not.toHaveBeenCalled();
    b.close();
  });
  it("abortBackground cancels only the active background ask; next turn still uses the production client", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { registry } = createFakeRegistry({
      available: ["test/free"],
      responses: {
        "test/free": [
          ({ signal }) =>
            new Promise((resolve) => {
              started();
              signal!.addEventListener("abort", () => resolve({ stopReason: "aborted" }), { once: true });
            }),
          result as never,
        ],
      },
    });
    const client = clientFor({ createJevClient, createTokenBucket }, config());
    const a = scope(client, "a");
    const pending = a.client.ask({ ...request(registry), mode: "background" });
    await ready;
    client.abortBackground();
    expect(await pending).toMatchObject({ ok: false, reason: "aborted" });
    a.close();
    const b = scope(client, "b");
    expect((await b.client.ask(request(registry))).ok).toBe(true);
    expect(logicalComplete(a.outcomes)).toBe(false);
    expect(logicalComplete(b.outcomes)).toBe(true);
    b.close();
  });
  it("durable 0600 summaries survive failure/missing rounds and cannot overwrite any attempt", () => {
    const dir = temp(),
      identity = { evalId: "attempt-a", sampleId: "s1", variant: "old" };
    const path = persistTurnSummary(dir, identity, { complete: false, closedReason: "not-evaluated", hits: null });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ complete: false, hits: null });
    expect(() => persistTurnSummary(dir, identity, { complete: true })).toThrow("audit write");
    persistTurnSummary(dir, { ...identity, evalId: "attempt-b" }, { complete: true });
    expect(readdirSync(dir)).toHaveLength(2);
    expect(metricsG2(turns(), [])).toMatchObject({
      status: "NOT-EVALUATED",
      oldHits: null,
      newHits: null,
      oldRecall: null,
      newRecall: null,
    });
  });
  it("hard budget/audit denial is sticky even if later fallback transport succeeds", async () => {
    const cache = {
      classify: vi
        .fn()
        .mockRejectedValueOnce(new Error("NOT-EVALUATED: classifier USD cap"))
        .mockResolvedValueOnce(result),
    };
    const registry = registryFor(cache, []);
    await expect(registry.classify(model, context)).rejects.toThrow("USD cap");
    expect(await registry.classify(model, context)).toEqual(result);
    expect(registry.hardFailures()).toEqual(["classifier-budget"]);
    expect(g2P2Evidence({ calls: 1 }, {}, { complete: true, hardFailures: registry.hardFailures() }).satisfied).toBe(
      false,
    );
  });
  it("raw handled provider failure is telemetry, not a logical completeness failure", async () => {
    const registry = registryFor(
      {
        classify: async () => {
          throw new Error("NOT-EVALUATED: classifier failed (details suppressed)");
        },
      },
      [],
    );
    await expect(registry.classify(model, context)).rejects.toThrow("classifier failed");
    expect(registry.hardFailures()).toEqual([]);
    expect(
      g2P2Evidence({ calls: 1, failures: 3 }, { failures: 10 }, { complete: true, hardFailures: [] }).satisfied,
    ).toBe(true);
    expect(p2Completion([{ ok: false, reason: "timeout" }], 1)).toBe(true);
    expect(p2Completion([{ ok: false, reason: "failed" }], 2)).toBe(true);
    expect(p2Completion([], 1)).toBe(false);
    expect(p2Completion([{ ok: false, reason: "aborted" }], 1)).toBe(false);
  });
  it("exact chat cache remains usable by a new independent sample with real measured latency", async () => {
    vi.useFakeTimers();
    const dir = temp(),
      models = ["test/chat"],
      namespace = {};
    const m = { provider: "test", id: "chat", cost: { input: 1, output: 1, cacheRead: 1 } };
    writeFileSync(join(dir, `chat-models-${digest(models)}.json`), JSON.stringify([m]));
    const dto = { systemPrompt: "s", messages: [{ role: "user", content: "{}" }] };
    const request = { model: m, context: dto, maxTokens: 10, reasoning: "minimal" };
    const key = digest({ namespace, chat: request });
    writeFileSync(
      join(dir, `chat-${key}.json`),
      JSON.stringify({
        key,
        requestHash: digest(request),
        elapsedMs: 2000,
        result: { content: [{ type: "text", text: "[]" }] },
      }),
    );
    const chat = await createChatCache({ dir, models, namespace, live: false, maxCalls: 2, maxUsd: 1 });
    for (let sample = 0; sample < 2; sample++) {
      let done = false;
      const pending = chat
        .streamSimple(m, dto, { maxTokens: 10, reasoning: "minimal" })
        .result()
        .then(() => {
          done = true;
        });
      await vi.advanceTimersByTimeAsync(1500);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(500);
      await pending;
    }
    expect(chat.stats()).toMatchObject({ calls: 0, hits: 2 });
  });
  it("fresh wire/branch/PredictCache per sample, late P2 drains before shutdown, cleanup persists on failure", async () => {
    const client = clientFor({ createJevClient, createTokenBucket }, config());
    const branches: unknown[] = [],
      pendingAtStart: unknown[] = [],
      order: string[] = [];
    const p = {
      ...srcClock,
      ...srcTaxonomy,
      ...srcStore,
      ...srcLlm,
      ...srcOutbound,
      ...srcFlight,
      RenderCache: class {},
      toSlug: () => "fake",
      memorySection: () => ({ provider: () => "resident" }),
      wireJev: (pi: any, deps: any) => {
        const cache = new PredictCache({ ttlMs: 10000 });
        pendingAtStart.push(cache.peekPending());
        deps.client.onStatusChange(() => {});
        pi.on("before_agent_start", async (_e: any, ctx: any) => {
          branches.push(ctx.sessionManager.getBranch());
          cache.setPending([], undefined, 1);
          await ctx.modelRegistry.streamSimple({}, {}, {}).result();
          pi.appendEntry("predict", { kind: "call", ok: true, timely: false });
        });
        pi.on("session_shutdown", () => {
          order.push("shutdown");
        });
      },
    };
    const registry = registryFor({ classify: vi.fn() }, [], {
      find: vi.fn((provider, id) => ({ provider, id, cost: { input: 1, cacheRead: 0, output: 1 } })),
      streamSimple: () => ({
        result: async () => {
          order.push("late-result");
          return {};
        },
      }),
    });
    const summaryDir = temp();
    for (let turn = 1; turn <= 2; turn++)
      await runTurn({
        p,
        dir: temp(),
        prompt: "independent",
        registry,
        client,
        config: config(),
        settings: {},
        now: Date.now(),
        signal: new AbortController().signal,
        ledger: new Map(),
        identity: { evalId: "a", sampleId: `s${turn}`, turn, variant: "new" },
        summaryDir,
      });
    expect(branches[0]).not.toBe(branches[1]);
    expect(pendingAtStart).toEqual([undefined, undefined]);
    expect(order).toEqual(["late-result", "shutdown", "late-result", "shutdown"]);
    for (const f of readdirSync(summaryDir))
      expect(JSON.parse(readFileSync(join(summaryDir, f), "utf8"))).toMatchObject({
        complete: true,
        subscriptions: 0,
        p2: { dispatched: 1 },
      });
    const failedDir = temp();
    const failing = {
      ...p,
      wireJev: (pi: any, deps: any) => {
        deps.client.onStatusChange(() => {});
        pi.on("before_agent_start", () => {
          throw new Error("synthetic turn failure");
        });
        pi.on("session_shutdown", () => {
          order.push("failed-shutdown");
        });
      },
    };
    await expect(
      runTurn({
        p: failing,
        dir: temp(),
        prompt: "independent",
        registry,
        client,
        config: config(),
        settings: {},
        now: Date.now(),
        signal: new AbortController().signal,
        ledger: new Map(),
        identity: { evalId: "a", sampleId: "failed", turn: 3, variant: "old" },
        summaryDir: failedDir,
      }),
    ).rejects.toThrow("synthetic turn failure");
    expect(order.at(-1)).toBe("failed-shutdown");
    const failed = JSON.parse(readFileSync(join(failedDir, readdirSync(failedDir)[0]!), "utf8"));
    expect(failed).toMatchObject({ complete: false, hits: null, deliveredIds: null, subscriptions: 0 });
  });
});

/** Narrow Sonnet blocker: production wire, not a test reimplementation of
 * uncertain/admit. Corpus and registries are entirely synthetic. */
describe("PG P2 conservative pre-admission bound through production wire", () => {
  const api = {
    ...srcClock,
    ...srcTaxonomy,
    ...srcStore,
    ...srcLlm,
    ...srcOutbound,
    ...srcFlight,
    wireJev,
    memorySection,
    RenderCache,
    toSlug,
  };
  async function setup() {
    const dir = temp(),
      summaryDir = temp();
    writeFileSync(
      join(dir, "core.md"),
      "# Synthetic\n\n## Dispatch\n- 派发子 agent 前确认范围 <!-- mem user tags=+dispatch -->\n",
    );
    const settings = parseMemorySettings({ layout: "tiered", jev: { enabled: true } });
    settings.jev.predict.enabled = true;
    settings.jev.predict.model.enabled = true;
    settings.jev.predict.model.models = ["test/chat"];
    const config = { ...jevConfigOf(settings), classifiers: ["test/classifier"], proxy: "" };
    const taxonomy = srcTaxonomy.mergeTaxonomy(srcStore.readTaxonomyFile(dir));
    if (!taxonomy.ok) throw new Error("synthetic taxonomy");
    const system = srcLlm.buildPredictSystemPrompt(taxonomy.taxonomy.tags);
    const price = { inputPerM: 1, cacheReadPerM: 0, outputPerM: 1 };
    const bound = srcFlight.estimatePredictUsd(system, "x".repeat(srcOutbound.OUTBOUND_MAX_TOTAL_BYTES), price);
    const fake = createFakeRegistry({ available: ["test/classifier"] });
    const streamSimple = vi.fn(() => ({
      result: async () => ({
        content: [{ type: "text", text: '{"tags":[]}' }],
        usage: { input: 10, cacheRead: 0, output: 1 },
      }),
    }));
    const find = vi.fn((provider, id) => ({ provider, id, cost: { input: 1, cacheRead: 0, output: 1 } }));
    const registry = registryFor({ classify: fake.registry.classify }, [{ provider: "test", id: "classifier" }], {
      find,
      streamSimple,
    });
    const client = clientFor({ createJevClient, createTokenBucket }, config);
    await client.probe(registry);
    const run = (prompt: string, ledger: Map<string, unknown>) =>
      runTurn({
        p: api,
        dir,
        prompt,
        registry,
        client,
        config,
        settings,
        now: Date.now(),
        signal: new AbortController().signal,
        ledger,
        identity: { evalId: "synthetic", sampleId: "turn", turn: 1, variant: "new" },
        summaryDir,
      });
    const summaries = () => readdirSync(summaryDir).map((f) => JSON.parse(readFileSync(join(summaryDir, f), "utf8")));
    const ledgerWithRemaining = (remaining: number) =>
      new Map([
        [localDayKey(Date.now()), { calls: 1, spent: config.predict.model.maxUsdPerDay - remaining, reserved: 0 }],
      ]);
    return { dir, summaryDir, config, bound, run, find, streamSimple, summaries, ledgerWithRemaining };
  }
  it("positive balance below bound/2 rejects as chat budget before any transport and durably records incomplete", async () => {
    const h = await setup();
    await expect(
      h.run("请深入分析这个模块的结构，帮助我明确下一步需要调查的问题", h.ledgerWithRemaining(h.bound / 4)),
    ).rejects.toThrow("NOT-EVALUATED: chat budget");
    expect(h.streamSimple).not.toHaveBeenCalled();
    expect(h.summaries()).toMatchObject([{ complete: false, closedReason: "chat-budget", hits: null }]);
  });
  it("sufficient bound plus certain rule prompt is a legitimate zero-dispatch complete turn", async () => {
    const h = await setup();
    await h.run("派两个子 agent 并行做", h.ledgerWithRemaining(h.bound * 2));
    expect(h.streamSimple).not.toHaveBeenCalled();
    expect(h.summaries()).toMatchObject([{ complete: true, p2: { dispatched: 0 } }]);
  });
  it("sufficient bound plus uncertain prompt actually dispatches the production P2 flight", async () => {
    const h = await setup();
    await h.run("请深入分析这个模块的结构，帮助我明确下一步需要调查的问题", h.ledgerWithRemaining(h.bound * 2));
    expect(h.streamSimple.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(h.summaries()).toMatchObject([{ complete: true, p2: { dispatched: 1, calls: [{ ok: true }] } }]);
  });
  it("an unbound model anywhere in the configured chain is NOT-EVALUATED, not a silent rule gate", async () => {
    const h = await setup();
    h.config.predict.model.models = ["test/chat", "missing/chat"];
    h.find.mockImplementation((provider, id) =>
      provider === "missing" ? (undefined as never) : { provider, id, cost: { input: 1, cacheRead: 0, output: 1 } },
    );
    await expect(h.run("派两个子 agent 并行做", new Map())).rejects.toThrow("chat model unavailable");
    expect(h.streamSimple).not.toHaveBeenCalled();
    expect(h.summaries()).toMatchObject([{ complete: false }]);
  });
  it("invalid model price rejects without guessing a zero-cost model", async () => {
    const h = await setup();
    h.find.mockImplementation((provider, id) => ({ provider, id, cost: { input: NaN, cacheRead: 0, output: 1 } }));
    await expect(h.run("派两个子 agent 并行做", new Map())).rejects.toThrow("chat model price unavailable");
    expect(h.streamSimple).not.toHaveBeenCalled();
    expect(h.summaries()).toMatchObject([{ complete: false }]);
  });
  it("production serializer byte cap upper-bounds production reserve even for multibyte/escaping DTOs", async () => {
    const h = await setup();
    for (const request of ["x".repeat(12000), '中😀\\"\n'.repeat(3000)]) {
      const dto = srcOutbound.serializePredictOutbound({
        v: 1,
        request,
        previous_request: request,
        workspace: { jobs: [], subagents: 0 },
        rule_guess: [],
        todo: Array.from({ length: 8 }, () => ({ status: "pending" as const, subject: request })),
        recent_tools: [],
      });
      expect(Buffer.byteLength(dto, "utf8")).toBeLessThanOrEqual(srcOutbound.OUTBOUND_MAX_TOTAL_BYTES);
      const taxonomy = srcTaxonomy.mergeTaxonomy();
      if (!taxonomy.ok) throw new Error("synthetic taxonomy");
      const system = srcLlm.buildPredictSystemPrompt(taxonomy.taxonomy.tags);
      for (const price of [
        { inputPerM: 1, cacheReadPerM: 0, outputPerM: 1 },
        { inputPerM: 0, cacheReadPerM: 10, outputPerM: 2 },
      ])
        expect(srcFlight.estimatePredictUsd(system, dto, price)).toBeLessThanOrEqual(
          srcFlight.estimatePredictUsd(system, "x".repeat(srcOutbound.OUTBOUND_MAX_TOTAL_BYTES), price),
        );
    }
  });
});
