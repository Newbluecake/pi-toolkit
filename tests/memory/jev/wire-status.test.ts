// jev-plan §4 J6 wire-status: off(pi-api), probe + notification table,
// recovery timer, /reload clearing the health table, first-full bulk tagging,
// pending backfill, periodic review, child inertness, doctor port.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FakeClock } from "../../../src/core/clock.js";
import { jevConfigOf } from "../../../src/memory/jev/config.js";
import type { JevConfig, JevQuestion } from "../../../src/memory/jev/contracts.js";
import { EntryIndex } from "../../../src/memory/jev/entries.js";
import { clearHealthTable, getHealthTable } from "../../../src/memory/jev/health.js";
import { readIndex, writeIndexPatch } from "../../../src/memory/jev/index-store.js";
import { mergeTaxonomy } from "../../../src/memory/jev/taxonomy.js";
import { corpusFingerprint, wireJev } from "../../../src/memory/jev/wire.js";
import { DEFAULT_MEMORY_SETTINGS } from "../../../src/memory/settings.js";
import { createFakeRegistry, type ClassifyCallRecord } from "./helpers/fake-registry.js";

type Handler = (event: unknown, ctx: unknown) => unknown;
const CLASSIFIERS = ["opencode/jev-1.13-free", "opencode/jev-1.13"];
const HOUR = 3_600_000;

let tmp: string;
let memDir: string;

beforeEach(() => {
  clearHealthTable();
  tmp = mkdtempSync(join(tmpdir(), "jev-wire-status-"));
  memDir = join(tmp, "mem");
  mkdirSync(memDir, { recursive: true });
  writeFileSync(
    join(memDir, "core.md"),
    "# Core\n\n## Rules\n\n- always run long commands with timeout\n- commit only exact paths\n",
  );
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  clearHealthTable();
});

function answer(questions: Record<string, JevQuestion>): Record<string, never> {
  const out: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "bool") out[id] = { type: "bool", probability: 0.2 };
    else if (q.type === "score") out[id] = { type: "score", score: 2, confidence: 0.9 };
    else {
      const k = Object.keys(q.criteria)[0]!;
      out[id] = { type: "choice", choice: k, probabilities: { [k]: 0.9 }, confidence: 0.9 };
    }
  }
  return out as Record<string, never>;
}

function harness(
  opts: { config?: Partial<JevConfig>; isChild?: boolean; available?: string[]; noRegistry?: boolean } = {},
) {
  const handlers = new Map<string, Handler[]>();
  const sent: unknown[] = [];
  const notes: { text: string; level?: string }[] = [];
  const clock = new FakeClock(Date.parse("2026-10-31T00:00:00.000Z"));
  const state = { mode: "ok" as "ok" | "451" | "402" };
  const pi = {
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage: (m: unknown) => sent.push(m),
    appendEntry: () => {},
    registerMessageRenderer: () => {},
  } as unknown as ExtensionAPI;
  const fake = createFakeRegistry({
    available: opts.available ?? CLASSIFIERS,
    responses: Object.fromEntries(
      CLASSIFIERS.map((id) => [
        id,
        [
          (call: ClassifyCallRecord) =>
            state.mode === "ok"
              ? {
                  stopReason: "stop" as const,
                  answers: answer(call.questions),
                  usage: { input: 1, cost: { total: 0.0001 } },
                }
              : { stopReason: "error" as const, errorMessage: `System One API error (${state.mode}): nope` },
        ],
      ]),
    ),
  });
  const config: JevConfig = { ...jevConfigOf(DEFAULT_MEMORY_SETTINGS), classifiers: CLASSIFIERS, ...opts.config };
  const writeHooks: ((cwd: string) => void)[] = [];
  const wire = wireJev(pi, {
    config,
    settings: DEFAULT_MEMORY_SETTINGS,
    isChildSession: opts.isChild === true,
    dirFor: () => memDir,
    getRenderInfo: () => undefined,
    onAfterWriteHook: (fn) => writeHooks.push(fn),
    now: () => clock.now(),
    clock,
    log: () => {},
  });
  const branch: unknown[] = [];
  const ctx = () => ({
    cwd: tmp,
    hasUI: true,
    ui: { notify: (text: string, level?: string) => notes.push({ text, level }) },
    ...(opts.noRegistry === true ? {} : { modelRegistry: fake.registry }),
    sessionManager: { getBranch: () => branch, getSessionId: () => "s" },
  });
  const emit = async (event: string, payload: unknown): Promise<unknown[]> => {
    const out: unknown[] = [];
    for (const h of handlers.get(event) ?? []) out.push(await h(payload, ctx()));
    return out;
  };
  return { handlers, sent, notes, clock, state, fake, wire, emit, writeHooks };
}

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const FIRST_FULL =
  "jev on · opencode/jev-1.13-free — 记忆召回、打标、整理已启用；你的消息与记忆摘录会脱敏后发给该分类器。/mem jev 查看，memory.jev.enabled=false 关闭";

describe("off(pi-api) — runtime-only off", () => {
  test("no modelRegistry on ctx ⇒ status line `jev: off (pi-api)`, zero calls / sends / notifications / timers", async () => {
    const h = harness({ noRegistry: true });
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    const [r] = await h.emit("before_agent_start", { messageType: "user", prompt: "push the dev branch to github" });
    await h.emit("tool_call", { toolName: "bash", toolCallId: "t", input: { command: "git push" } });
    await settle();
    expect(r).toBeUndefined();
    expect(h.fake.calls).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
    expect(h.notes).toHaveLength(0);
    expect(h.clock.pendingTimers).toBe(0);
    expect(h.wire.commandPort.statusLine(tmp)).toBe("jev: off (pi-api)");
  });
});

describe("probe + notification table (main session, UI)", () => {
  test("session_start probes once in the background; first full notifies once per activation (verbatim)", async () => {
    const h = harness({ config: { reviewIntervalDays: 0 } });
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    await settle();
    const probes = h.fake.calls.filter((c) => c.state["probe"] === "ok");
    expect(probes).toHaveLength(1);
    expect(h.notes.map((n) => n.text)).toEqual([FIRST_FULL]);
    expect(h.wire.commandPort.statusLine(tmp)).toMatch(/^jev: full · opencode\/jev-1\.13-free · /);
    await h.emit("session_start", { type: "session_start", reason: "new" });
    await settle();
    expect(h.notes.filter((n) => n.text === FIRST_FULL)).toHaveLength(1);
  });

  test("full → partial notifies `degraded` once; the earliest `until` arms a recovery probe; recovery notifies", async () => {
    const h = harness({ config: { reviewIntervalDays: 0 } });
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    await settle(150); // probe + first-full bulk tagging drain
    h.state.mode = "451";
    await h.emit("before_agent_start", { messageType: "user", prompt: "push the dev branch to github please" });
    await settle();
    const degraded = h.notes.filter((n) => n.text.startsWith("jev partial (451)"));
    expect(degraded).toHaveLength(1);
    expect(degraded[0]!.text).toBe(
      "jev partial (451) — 现场判断已停；动作快速通道与压缩后重注继续使用已有标签（2/2）。/mem jev",
    );
    expect(degraded[0]!.level).toBe("warning");
    expect(h.clock.pendingTimers).toBe(1);
    h.state.mode = "ok";
    h.clock.advance(HOUR + 100);
    await settle();
    expect(h.notes.at(-1)!.text).toBe("jev recovered · opencode/jev-1.13-free");
    expect(h.wire.client.status().kind).toBe("full");
  });

  test("startup straight into partial with credentials (451) ⇒ startup-partial with the proxy hint", async () => {
    const h = harness();
    h.state.mode = "451";
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    await settle();
    expect(h.notes.map((n) => n.text)).toEqual([
      "jev partial (451) — 现场判断已停；动作快速通道与压缩后重注继续使用已有标签（0/2）。/mem jev（451 多为地区拦截，可设 memory.jev.proxy）",
    ]);
  });

  test("inactive (no credentials anywhere) ⇒ never notified", async () => {
    const h = harness({ available: [] });
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    await settle();
    expect(h.notes).toHaveLength(0);
    expect(h.wire.commandPort.statusLine(tmp)).toBe("jev: inactive (no classifier credentials)");
  });
});

describe("/reload and teardown", () => {
  test("session_shutdown(reload) clears the shared health table; other reasons keep it; children never clear", async () => {
    const h = harness();
    const table = getHealthTable();
    table.set("x/y", { state: "unavailable", until: Date.now() + HOUR });
    await h.emit("session_shutdown", { type: "session_shutdown", reason: "new" });
    expect(table.get("x/y")).toBeDefined();
    const child = harness({ isChild: true });
    await child.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
    expect(table.get("x/y")).toBeDefined();
    await h.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
    expect(table.entries()).toHaveLength(0);
  });
});

describe("background work after the first full (main session only)", () => {
  test("first full ⇒ bulk tagging: one tag-major call per enabled tag + one entry call per pending entry; sidecar written", async () => {
    const h = harness({ config: { reviewIntervalDays: 0 } });
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    await settle(200);
    const tax = mergeTaxonomy();
    if (!tax.ok) throw new Error("presets");
    const tagMajor = h.fake.calls.filter((c) => typeof c.state["tag"] === "string");
    expect(tagMajor).toHaveLength(tax.taxonomy.tags.length);
    const entryMajor = h.fake.calls.filter(
      (c) => typeof c.state["body"] === "string" || typeof c.state["entry"] === "string",
    );
    expect(entryMajor.length).toBe(2);
    const idx = readIndex(memDir).index;
    expect(Object.keys(idx.entries)).toHaveLength(2);
    expect(idx.lastTaggedAt).toBeDefined();
  });

  test("pending backfill during full: a new entry gets tagged on a later prompt (≥60s apart)", async () => {
    const h = harness({ config: { reviewIntervalDays: 0 } });
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    await settle(200);
    writeFileSync(join(memDir, "extra.md"), "# Extra\n\n## X\n\n- a freshly written pitfall about proxies\n");
    for (const hook of h.writeHooks) hook(tmp);
    h.clock.advance(61_000);
    await h.emit("before_agent_start", { messageType: "user", prompt: "anything at all goes here" });
    await settle(150);
    const fresh = new EntryIndex().get(memDir).find((e) => e.file === "extra.md")!;
    expect(readIndex(memDir).index.entries[fresh.hash]).toBeDefined();
  });

  test("periodic review runs when full ∧ ≥ intervalDays since last run ∧ corpusFp changed; stores the same corpusFp", async () => {
    await writeIndexPatch(memDir, {
      review: { lastRunAt: "2026-10-01T00:00:00.000Z", corpusFp: "stale", suggestions: [], dismissed: [] },
    });
    const h = harness({ config: { reviewIntervalDays: 7 } });
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    await settle(250);
    const review = readIndex(memDir).index.review!;
    expect(review.lastRunAt).not.toBe("2026-10-01T00:00:00.000Z");
    // parity: wire's pre-run fingerprint == what runReviewPass stored
    expect(review.corpusFp).toBe(corpusFingerprint(new EntryIndex().get(memDir)));
  });

  test("intervalDays=0 never runs; a recent run or an unchanged corpusFp skips", async () => {
    const reviewCalls = (h: ReturnType<typeof harness>) => h.fake.calls.filter((c) => "project" in c.state).length;
    const h0 = harness({ config: { reviewIntervalDays: 0 } });
    await h0.emit("session_start", { type: "session_start", reason: "startup" });
    await settle(200);
    expect(reviewCalls(h0)).toBe(0);
    const fp = corpusFingerprint(new EntryIndex().get(memDir));
    await writeIndexPatch(memDir, {
      review: { lastRunAt: "2026-10-01T00:00:00.000Z", corpusFp: fp, suggestions: [], dismissed: [] },
    });
    const h1 = harness({ config: { reviewIntervalDays: 7 } });
    await h1.emit("session_start", { type: "session_start", reason: "startup" });
    await settle(200);
    expect(reviewCalls(h1)).toBe(0);
    await writeIndexPatch(memDir, {
      review: {
        lastRunAt: new Date(Date.parse("2026-10-30T00:00:00.000Z")).toISOString(),
        corpusFp: "x",
        suggestions: [],
        dismissed: [],
      },
    });
    const h2 = harness({ config: { reviewIntervalDays: 7 } });
    await h2.emit("session_start", { type: "session_start", reason: "startup" });
    await settle(200);
    expect(reviewCalls(h2)).toBe(0);
  });
});

describe("child sessions", () => {
  test("no session_start hook (no probe/timer/notify/bulk/review); recall still allowed via the shared table", async () => {
    const h = harness({ isChild: true });
    expect(h.handlers.get("session_start")).toBeUndefined();
    await h.emit("before_agent_start", { messageType: "user", prompt: "push the dev branch to github" });
    await settle();
    expect(h.fake.calls.filter((c) => c.state["probe"] === "ok")).toHaveLength(0);
    expect(h.fake.calls.filter((c) => c.state["session"] === "child")).toHaveLength(1);
    expect(h.notes).toHaveLength(0);
    expect(h.clock.pendingTimers).toBe(0);
    expect(readIndex(memDir).index.entries).toEqual({});
  });
});

describe("doctor port", () => {
  test("extraReminder counts expired entries via expiredEntries and open review suggestions", async () => {
    writeFileSync(
      join(memDir, "temp.md"),
      "# T\n\n## Window\n\n- freeze until the launch <!-- mem expires=2020-01-01 -->\n",
    );
    const live = new EntryIndex().get(memDir)[0]!;
    await writeIndexPatch(memDir, {
      review: {
        lastRunAt: "2026-10-30T00:00:00.000Z",
        corpusFp: "x",
        suggestions: [{ id: "s1", kind: "obsolete", a: { hash: live.hash, anchor: "a" }, p: 0.9, at: "2026-10-30" }],
        dismissed: [],
      },
    });
    const h = harness();
    expect(h.wire.doctorPort.extraReminder(tmp)).toEqual([
      "memory: 1 expired entry → /mem expired",
      "memory: 1 review suggestion open → /mem review",
    ]);
  });
});
