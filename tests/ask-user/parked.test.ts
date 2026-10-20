/**
 * P1 parked registry + persistence wiring (plan §4, §6.3, §6.4; §10 P1-11/P1-12):
 * registry units, appendEntry/getBranch persistence, restore on session boundaries, the
 * settle notify, the compact reminder, and a real-session integration test (scripted model)
 * for the "model does not re-ask" acceptance row.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import wireAskUser from "../../src/ask-user/index.js";
import {
  PARKED_CUSTOM_TYPE,
  PARKED_LIMIT,
  PARKED_REMINDER_CUSTOM_TYPE,
  PARKED_REMINDER_WINDOW_MS,
  PARKED_TTL_MS,
  SWEEP_SIMILARITY_THRESHOLD,
  createParkedRegistry,
  questionFingerprint,
  questionSimilarity,
  sanitizeParkedEntries,
  type ParkedEntry,
} from "../../src/ask-user/parked.js";
import type { Question } from "../../src/ask-user/types.js";
import { mockTui, stubTheme } from "./fixtures.js";
import { FakeClock, FakePort, PARAMS, createBgHarness, flush, tuiContext } from "./bg-harness.js";
import { fakeModel, fakeModelRuntime, textTurn, toolTurn, type ScriptedTurn } from "../conformance/tui-harness.js";

const Q: Question = { question: "Which DB?", header: "DB", options: [{ label: "Postgres" }, { label: "SQLite" }] };

function entry(overrides: Partial<ParkedEntry> = {}): ParkedEntry {
  return {
    fp: questionFingerprint(Q),
    question: Q.question,
    header: Q.header,
    interrupts: 1,
    deferrals: 0,
    parkedAt: 1000,
    runSeq: 0,
    ...overrides,
  };
}

describe("parked registry units", () => {
  it("fingerprint covers question text, option labels and multiSelect — not header/description", () => {
    const base = questionFingerprint(Q);
    expect(questionFingerprint({ ...Q })).toBe(base);
    expect(questionFingerprint({ ...Q, header: "Other" })).toBe(base);
    expect(questionFingerprint({ ...Q, options: [{ label: "Postgres", description: "x" }, { label: "SQLite" }] })).toBe(
      base,
    );
    expect(questionFingerprint({ ...Q, question: "Which DB ?" })).not.toBe(base);
    expect(questionFingerprint({ ...Q, options: [{ label: "Postgres" }, { label: "MySQL" }] })).not.toBe(base);
    expect(questionFingerprint({ ...Q, multiSelect: true })).not.toBe(base);
  });

  it("recordInterrupt counts, stores drafts, and keeps the old draft when none is new", () => {
    const registry = createParkedRegistry();
    const fps = [questionFingerprint(Q)];
    const draft = {
      states: [
        {
          optionCount: 3,
          cursorIndex: 1,
          selectedIndex: 1,
          selectedIndices: [],
          confirmed: true,
          freeTextValue: null,
          freeDraft: null,
          mode: "options" as const,
          draftText: "",
          savedOptionsCursorIndex: 0,
          skipped: false,
        },
      ],
      activeTab: 0,
    };
    registry.recordInterrupt({ fps, questions: [Q], draft, runSeq: 1, now: 100 });
    expect(registry.find(fps[0]!)?.interrupts).toBe(1);
    expect(registry.find(fps[0]!)?.draft?.selectedIndex).toBe(1);
    expect(registry.find(fps[0]!)?.runSeq).toBe(1);
    registry.recordInterrupt({ fps, questions: [Q], runSeq: 2, now: 200 });
    const found = registry.find(fps[0]!)!;
    expect(found.interrupts).toBe(2);
    expect(found.draft?.selectedIndex).toBe(1); // kept
    expect(found.runSeq).toBe(2);
    expect(found.parkedAt).toBe(200);
  });

  it("noteReask stamps lastReaskAt and clears the pending flag; resolve drops entries", () => {
    const registry = createParkedRegistry();
    const fps = [questionFingerprint(Q)];
    registry.recordInterrupt({ fps, questions: [Q], runSeq: 3, now: 100 });
    registry.noteReask(fps, 150);
    expect(registry.find(fps[0]!)?.runSeq).toBe(0);
    expect(registry.find(fps[0]!)?.lastReaskAt).toBe(150);
    expect(registry.resolve(fps)).toBe(true);
    expect(registry.resolve(fps)).toBe(false);
    expect(registry.items()).toEqual([]);
  });

  it("caps at PARKED_LIMIT (FIFO) and prunes by TTL", () => {
    const registry = createParkedRegistry();
    for (let i = 0; i < PARKED_LIMIT + 2; i++) {
      const question: Question = { ...Q, question: `Q${i}` };
      registry.recordInterrupt({ fps: [questionFingerprint(question)], questions: [question], runSeq: 1, now: i });
    }
    expect(registry.items()).toHaveLength(PARKED_LIMIT);
    expect(registry.items()[0]!.question).toBe("Q2"); // Q0/Q1 dropped (oldest first)
    expect(registry.prune(PARKED_TTL_MS + 100)).toBe(true);
    expect(registry.items()).toEqual([]);
    expect(registry.prune(0)).toBe(false);
  });

  it("sanitizeParkedEntries drops malformed and expired items and resets runSeq", () => {
    const now = 10_000;
    const good = entry({ parkedAt: now - 1000, runSeq: 7 });
    const expired = entry({ fp: "x".repeat(40), parkedAt: now - PARKED_TTL_MS, runSeq: 2 });
    const result = sanitizeParkedEntries(
      [good, expired, null, 42, { fp: 1 }, { fp: "y", question: "q", parkedAt: "z" }],
      now,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.runSeq).toBe(0);
    expect(result[0]!.interrupts).toBe(1);
  });

  it("r2: restored entries are marked notifiedRunSeq=0 (retire after the first full run)", () => {
    const result = sanitizeParkedEntries([entry({ parkedAt: 9_000, notifiedRunSeq: 5 })], 10_000);
    expect(result).toHaveLength(1);
    expect(result[0]!.notifiedRunSeq).toBe(0);
  });
});

describe("r1 questionSimilarity (normalized char-bigram Dice, threshold 0.6)", () => {
  it("is 1 for identical text modulo case/whitespace, 0 for bigram-less mismatches", () => {
    expect(questionSimilarity("Which DB?", "  which   db? ")).toBe(1);
    expect(questionSimilarity("a", "b")).toBe(0);
    expect(questionSimilarity("", "whatever")).toBe(0);
  });

  it("scores a reworded re-ask above the threshold and an unrelated question below it", () => {
    const parked = "Which database should we use?";
    const reworded = "Which database should we use for this project?";
    const unrelated = "What color should the submit button be?";
    expect(questionSimilarity(parked, reworded)).toBeGreaterThanOrEqual(SWEEP_SIMILARITY_THRESHOLD);
    expect(questionSimilarity(parked, unrelated)).toBeLessThan(SWEEP_SIMILARITY_THRESHOLD);
    // Symmetric.
    expect(questionSimilarity(reworded, parked)).toBeGreaterThanOrEqual(SWEEP_SIMILARITY_THRESHOLD);
  });
});

describe("r1 sweepAnswered", () => {
  const parkedQuestion: Question = {
    question: "Which database should we use?",
    header: "DB",
    options: [{ label: "Postgres" }, { label: "SQLite" }],
  };

  function registryWith(question: Question): ReturnType<typeof createParkedRegistry> {
    const registry = createParkedRegistry();
    registry.recordInterrupt({ fps: [questionFingerprint(question)], questions: [question], runSeq: 1, now: 100 });
    return registry;
  }

  it("drops entries matched by equal normalized header", () => {
    const registry = registryWith(parkedQuestion);
    const asked: Question = {
      question: "Totally different wording here",
      header: " db ",
      options: parkedQuestion.options,
    };
    expect(registry.sweepAnswered([asked])).toBe(true);
    expect(registry.items()).toEqual([]);
  });

  it("drops entries matched by question-text similarity and keeps unrelated ones", () => {
    const registry = registryWith({ ...parkedQuestion, header: undefined });
    const other: Question = {
      ...parkedQuestion,
      question: "What color should the submit button be?",
      header: undefined,
    };
    registry.recordInterrupt({ fps: [questionFingerprint(other)], questions: [other], runSeq: 1, now: 200 });
    const reworded: Question = {
      ...parkedQuestion,
      question: "Which database should we use for this project?",
      header: undefined,
    };
    expect(registry.sweepAnswered([reworded])).toBe(true);
    expect(registry.items().map((item) => item.question)).toEqual([other.question]);
    expect(registry.sweepAnswered([reworded])).toBe(false);
  });
});

describe("r2 retireMoveOn + r4 clear", () => {
  it("retires notified entries only once a LATER full run settles; re-ask resets", () => {
    const registry = createParkedRegistry();
    const fps = [questionFingerprint(Q)];
    registry.recordInterrupt({ fps, questions: [Q], runSeq: 1, now: 100 });
    // Not notified yet: never retired.
    expect(registry.retireMoveOn(2)).toBe(false);
    registry.markNotified(fps, 1);
    expect(registry.find(fps[0]!)?.notifiedRunSeq).toBe(1);
    expect(registry.retireMoveOn(1)).toBe(false); // same run — not later
    // Re-ask restarts the move-on clock.
    registry.noteReask(fps, 150);
    expect(registry.find(fps[0]!)?.notifiedRunSeq).toBeUndefined();
    expect(registry.retireMoveOn(3)).toBe(false);
    // Notified again at run 3, then run 4 settles without a re-ask ⇒ retired.
    registry.markNotified(fps, 3);
    expect(registry.retireMoveOn(4)).toBe(true);
    expect(registry.items()).toEqual([]);
  });

  it("clear() drops everything and reports the count", () => {
    const registry = createParkedRegistry();
    registry.recordInterrupt({ fps: [questionFingerprint(Q)], questions: [Q], runSeq: 1, now: 100 });
    registry.recordInterrupt({
      fps: [questionFingerprint({ ...Q, question: "Q2" })],
      questions: [{ ...Q, question: "Q2" }],
      runSeq: 1,
      now: 200,
    });
    expect(registry.clear()).toBe(2);
    expect(registry.clear()).toBe(0);
    expect(registry.items()).toEqual([]);
  });

  it("prune accepts a custom window (the 2h reminder window)", () => {
    const registry = createParkedRegistry();
    registry.recordInterrupt({ fps: [questionFingerprint(Q)], questions: [Q], runSeq: 1, now: 0 });
    expect(registry.prune(PARKED_REMINDER_WINDOW_MS - 1, PARKED_REMINDER_WINDOW_MS)).toBe(false);
    expect(registry.prune(PARKED_REMINDER_WINDOW_MS, PARKED_REMINDER_WINDOW_MS)).toBe(true);
    expect(registry.items()).toEqual([]);
  });
});

describe("parked persistence wiring", () => {
  it("an interrupt appends an ask-user:parked snapshot and sets the status", async () => {
    const h = createBgHarness();
    const statuses: [string, string | undefined][] = [];
    h.trigger("agent_start"); // runSeq = 1
    const c = tuiContext();
    const ctx = {
      ...c.ctx,
      ui: {
        ...c.ctx.ui,
        setStatus: (key: string, text: string | undefined) => {
          statuses.push([key, text]);
        },
      },
    };
    const pending = h.tool.execute("id", PARAMS, undefined, undefined, ctx);
    await flush();
    h.port.fire();
    h.clock.advance(1000);
    await pending;
    const last = h.appended[h.appended.length - 1]!;
    expect(last.customType).toBe(PARKED_CUSTOM_TYPE);
    const data = last.data as { v: number; items: ParkedEntry[] };
    expect(data.v).toBe(1);
    expect(data.items).toHaveLength(1);
    expect(data.items[0]!.question).toBe("Q");
    expect(data.items[0]!.interrupts).toBe(1);
    expect(data.items[0]!.runSeq).toBe(1);
    expect(statuses).toContainEqual(["ask-user", "ask 1"]);
  });

  function parkedBranch(items: ParkedEntry[]): unknown[] {
    return [{ type: "custom", customType: PARKED_CUSTOM_TYPE, data: { v: 1, items } }];
  }

  function fakeCtx(branch: unknown[], extras: { statuses?: [string, string | undefined][] } = {}) {
    return {
      mode: "tui",
      hasUI: true,
      ui: {
        setStatus: (key: string, text: string | undefined) => {
          extras.statuses?.push([key, text]);
        },
      },
      sessionManager: {
        getBranch: () => branch,
        getEntries: () => {
          throw new Error("getEntries must NOT be used (abandoned-fork resurrection)");
        },
      },
    };
  }

  it("restores parked entries from getBranch() on session_start (never getEntries)", async () => {
    const h = createBgHarness();
    const statuses: [string, string | undefined][] = [];
    const paramsQ: Question = { question: "Q", options: [{ label: "A" }, { label: "B" }] };
    const restored = entry({
      fp: questionFingerprint(paramsQ),
      question: "Q",
      header: undefined,
      draft: {
        optionCount: 4,
        cursorIndex: 1,
        selectedIndex: null,
        selectedIndices: [],
        confirmed: false,
        freeTextValue: null,
        freeDraft: null,
        mode: "options",
        draftText: "",
        savedOptionsCursorIndex: 0,
        skipped: false,
        activeTab: 0,
      },
    });
    h.trigger("session_start", {}, fakeCtx(parkedBranch([restored]), { statuses }));
    expect(statuses).toContainEqual(["ask-user", "ask 1"]);
    // The restored entry makes the next identical call a re-ask (resumed marker).
    const c = tuiContext();
    const pending = h.tool.execute("id", PARAMS, undefined, undefined, c.ctx);
    await flush();
    expect(c.created[0]!.render(100)[1]).toContain("resumed · draft restored");
    c.created[0]!.handleInput("\r");
    await pending;
  });

  it("an abandoned branch's snapshot does not resurrect", async () => {
    const h = createBgHarness();
    // Current branch has NO parked snapshot (the parked one lives on an abandoned fork).
    h.trigger("session_tree", {}, fakeCtx([{ type: "custom", customType: "other", data: {} }]));
    const c = tuiContext();
    const pending = h.tool.execute("id", PARAMS, undefined, undefined, c.ctx);
    await flush();
    expect(c.created[0]!.render(100).join("\n")).not.toContain("resumed");
    c.created[0]!.handleInput("\r");
    await pending;
  });

  it("reload: a fresh activate restores counts and drafts; the budget continues", async () => {
    const first = createBgHarness();
    for (let round = 1; round <= 3; round++) {
      const c = tuiContext();
      const pending = first.tool.execute(`r${round}`, PARAMS, undefined, undefined, c.ctx);
      await flush();
      first.port.fire();
      first.clock.advance(11_000);
      await pending;
    }
    const snapshot = first.appended[first.appended.length - 1]!.data as { items: ParkedEntry[] };
    expect(snapshot.items[0]!.interrupts).toBe(3);
    // Simulate /reload: a brand-new wire (fresh registry) restoring from the same branch.
    const second = createBgHarness();
    second.trigger("session_start", {}, fakeCtx(parkedBranch(snapshot.items)));
    const c = tuiContext();
    const pending = second.tool.execute("r4", PARAMS, undefined, undefined, c.ctx);
    await flush();
    expect(c.created[0]!.render(100)[1]).toContain("resumed · draft restored"); // draft survived
    second.port.fire();
    const flag = { settled: false };
    void pending.then(() => {
      flag.settled = true;
    });
    second.clock.advance(120_000);
    await flush();
    expect(flag.settled).toBe(false); // budget 3 reached across the reload — blocking again
    expect(c.created[0]!.render(100).join("\n")).toContain("answer to continue");
    c.created[0]!.handleInput("\r");
    await pending;
  });

  it("session_compact restores and sends a triggerTurn:false reminder listing the questions", () => {
    const h = createBgHarness();
    h.trigger("session_compact", {}, fakeCtx(parkedBranch([entry({ question: "Which DB?", header: "DB" })])));
    expect(h.sent).toHaveLength(1);
    const { message, options } = h.sent[0]!;
    expect(message.customType).toBe(PARKED_REMINDER_CUSTOM_TYPE);
    expect(message.display).toBe(true);
    expect(message.content).toContain("DB: Which DB?");
    expect(options).toEqual({ triggerTurn: false });
  });

  it("session_compact with empty parked sends nothing; enabled:false suppresses the reminder", () => {
    const h = createBgHarness();
    h.trigger("session_compact", {}, fakeCtx([]));
    expect(h.sent).toEqual([]);
    const off = createBgHarness({ enabled: false });
    off.trigger("session_compact", {}, fakeCtx(parkedBranch([entry()])));
    expect(off.sent).toEqual([]);
  });

  it("agent_settled notifies exactly once with the parked headers (and only for this run)", async () => {
    const h = createBgHarness();
    const notifies: string[] = [];
    const ui = { notify: (message: string) => notifies.push(message) };
    h.trigger("agent_start"); // runSeq = 1
    const c = tuiContext();
    const pending = h.tool.execute("id", PARAMS, undefined, undefined, c.ctx);
    await flush();
    h.port.fire();
    h.clock.advance(1000);
    await pending; // parked entry with runSeq=1
    h.trigger("agent_settled", {}, { ui });
    expect(notifies).toHaveLength(1);
    expect(notifies[0]).toContain("Q");
    h.trigger("agent_settled", {}, { ui }); // same run, already notified
    expect(notifies).toHaveLength(1);
    h.trigger("agent_start"); // runSeq = 2 — nothing parked by this run
    h.trigger("agent_settled", {}, { ui });
    expect(notifies).toHaveLength(1);
  });

  it("a re-ask inside the same run suppresses the settle notify", async () => {
    const h = createBgHarness();
    const notifies: string[] = [];
    const ui = { notify: (message: string) => notifies.push(message) };
    h.trigger("agent_start"); // runSeq = 1
    const first = tuiContext();
    const p1 = h.tool.execute("one", PARAMS, undefined, undefined, first.ctx);
    await flush();
    h.port.fire();
    h.clock.advance(1000);
    await p1;
    // The model re-asks (same run): the dialog is presented → pending flag cleared.
    const second = tuiContext();
    const p2 = h.tool.execute("two", PARAMS, undefined, undefined, second.ctx);
    await flush();
    second.created[0]!.handleInput("\r");
    await p2;
    h.trigger("agent_settled", {}, { ui });
    expect(notifies).toHaveLength(0);
  });

  const DB_PARAMS = {
    questions: [
      {
        question: "Which database should we use?",
        header: "DB",
        options: [{ label: "Postgres" }, { label: "SQLite" }],
      },
    ],
  };

  async function parkViaInterrupt(h: ReturnType<typeof createBgHarness>, params: unknown): Promise<void> {
    const c = tuiContext();
    const pending = h.tool.execute("park", params, undefined, undefined, c.ctx);
    await flush();
    h.port.fire();
    h.clock.advance(1000);
    await pending;
  }

  it("r1 answer-sweep: answering a reworded re-ask (same header) clears the parked entry", async () => {
    const h = createBgHarness();
    h.trigger("agent_start"); // runSeq = 1
    await parkViaInterrupt(h, DB_PARAMS);
    expect((h.appended.at(-1)!.data as { items: ParkedEntry[] }).items).toHaveLength(1);
    h.trigger("agent_start"); // runSeq = 2
    const c = tuiContext();
    const answered = h.tool.execute(
      "reask",
      {
        questions: [
          {
            question: "Totally reworded question with no overlap",
            header: "db",
            options: [{ label: "Postgres" }, { label: "SQLite" }],
          },
        ],
      },
      undefined,
      undefined,
      c.ctx,
    );
    await flush();
    c.created[0]!.handleInput("\r"); // answer (first option)
    await answered;
    expect((h.appended.at(-1)!.data as { items: ParkedEntry[] }).items).toEqual([]);
  });

  it("r1 answer-sweep: similar question text clears the entry; an unrelated answer keeps it", async () => {
    const h = createBgHarness();
    h.trigger("agent_start");
    await parkViaInterrupt(h, {
      questions: [{ question: "Which database should we use?", options: [{ label: "Postgres" }, { label: "SQLite" }] }],
    });
    h.trigger("agent_start");
    // Unrelated question answered ⇒ parked entry stays (no persist; snapshot unchanged).
    const unrelated = tuiContext();
    const p1 = h.tool.execute(
      "unrelated",
      {
        questions: [
          { question: "What color should the submit button be?", options: [{ label: "Red" }, { label: "Blue" }] },
        ],
      },
      undefined,
      undefined,
      unrelated.ctx,
    );
    await flush();
    unrelated.created[0]!.handleInput("\r");
    await p1;
    expect((h.appended.at(-1)!.data as { items: ParkedEntry[] }).items).toHaveLength(1);
    // Reworded same decision answered ⇒ swept.
    const reworded = tuiContext();
    const p2 = h.tool.execute(
      "reworded",
      {
        questions: [
          {
            question: "Which database should we use for this project?",
            options: [{ label: "Postgres" }, { label: "SQLite" }],
          },
        ],
      },
      undefined,
      undefined,
      reworded.ctx,
    );
    await flush();
    reworded.created[0]!.handleInput("\r");
    await p2;
    expect((h.appended.at(-1)!.data as { items: ParkedEntry[] }).items).toEqual([]);
  });

  it("r2 move-on retire: notified in run 1, retired when run 2 settles without a re-ask", async () => {
    const h = createBgHarness();
    const ui = { notify: () => undefined };
    h.trigger("agent_start"); // runSeq = 1
    await parkViaInterrupt(h, PARAMS);
    h.trigger("agent_settled", {}, { ui }); // notify fires, notifiedRunSeq = 1 — NOT yet retired
    expect((h.appended.at(-1)!.data as { items: ParkedEntry[] }).items).toHaveLength(1);
    h.trigger("agent_start"); // runSeq = 2 (no re-ask)
    h.trigger("agent_settled", {}, { ui });
    const last = h.appended.at(-1)!;
    expect(last.customType).toBe(PARKED_CUSTOM_TYPE);
    expect((last.data as { items: ParkedEntry[] }).items).toEqual([]);
  });

  it("r2 restore semantics: a restored entry retires after the first full run if not re-asked", () => {
    const h = createBgHarness();
    h.trigger("session_start", {}, fakeCtx(parkedBranch([entry()])));
    h.trigger("agent_start"); // runSeq = 1
    h.trigger("agent_settled", {}, { ui: { notify: () => undefined } });
    expect((h.appended.at(-1)!.data as { items: ParkedEntry[] }).items).toEqual([]);
  });

  it("r2 restore semantics: a restored entry the model re-asks and re-interrupts is NOT retired", async () => {
    const h = createBgHarness();
    const paramsQ: Question = { question: "Q", options: [{ label: "A" }, { label: "B" }] };
    const restored = entry({ fp: questionFingerprint(paramsQ), question: "Q", header: undefined });
    h.trigger("session_start", {}, fakeCtx(parkedBranch([restored])));
    h.trigger("agent_start"); // runSeq = 1
    // Re-asked (presented) and interrupted again inside run 1.
    const c = tuiContext();
    const pending = h.tool.execute("reask", PARAMS, undefined, undefined, c.ctx);
    await flush();
    h.port.fire();
    h.clock.advance(11_000); // re-ask dwell (10s) + merge window
    await pending;
    h.trigger("agent_settled", {}, { ui: { notify: () => undefined } }); // notify for run 1
    expect((h.appended.at(-1)!.data as { items: ParkedEntry[] }).items).toHaveLength(1);
  });

  it("r3: session_compact drops entries outside the 2h reminder window and prunes them", () => {
    const h = createBgHarness();
    const old = entry({ question: "Old Q", header: "Old", parkedAt: -PARKED_REMINDER_WINDOW_MS - 1 });
    const fresh = entry({ fp: "f".repeat(40), question: "Fresh Q", header: "Fresh", parkedAt: -1000 });
    const statuses: [string, string | undefined][] = [];
    h.trigger("session_compact", {}, fakeCtx(parkedBranch([old, fresh]), { statuses }));
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.message.content).toContain("Fresh: Fresh Q");
    expect(h.sent[0]!.message.content).not.toContain("Old Q");
    // The prune is persisted so the status bar matches what is retained.
    const last = h.appended.at(-1)!;
    expect((last.data as { items: ParkedEntry[] }).items.map((item) => item.question)).toEqual(["Fresh Q"]);
    expect(statuses).toContainEqual(["ask-user", "ask 1"]);
  });

  it("r3: session_compact with only out-of-window entries sends no reminder", () => {
    const h = createBgHarness();
    const old = entry({ question: "Old Q", parkedAt: -PARKED_REMINDER_WINDOW_MS - 1 });
    h.trigger("session_compact", {}, fakeCtx(parkedBranch([old])));
    expect(h.sent).toEqual([]);
    expect((h.appended.at(-1)!.data as { items: ParkedEntry[] }).items).toEqual([]);
  });

  it("r4 dismissParked clears all parked entries immediately without showing UI", async () => {
    const h = createBgHarness();
    h.trigger("agent_start");
    await parkViaInterrupt(h, PARAMS);
    expect((h.appended.at(-1)!.data as { items: ParkedEntry[] }).items).toHaveLength(1);
    const c = tuiContext();
    const result = await h.tool.execute("dismiss", { dismissParked: true }, undefined, undefined, c.ctx);
    expect(c.customCalls).toBe(0); // no dialog
    expect(result.content[0].text).toContain("Dismissed 1 parked question(s)");
    expect(result.details.dismissed).toBe(1);
    expect((h.appended.at(-1)!.data as { items: ParkedEntry[] }).items).toEqual([]);
  });

  it("r4 dismissParked with nothing parked reports zero and persists nothing", async () => {
    const h = createBgHarness();
    const result = await h.tool.execute("dismiss", { dismissParked: true }, undefined, undefined, tuiContext().ctx);
    expect(result.content[0].text).toContain("No parked questions");
    expect(result.details.dismissed).toBe(0);
    expect(h.appended).toEqual([]);
  });

  it("r4 dismissParked + questions is rejected; questions-less non-dismiss calls are rejected", async () => {
    const h = createBgHarness();
    await expect(
      h.tool.execute(
        "combo",
        { dismissParked: true, questions: PARAMS.questions },
        undefined,
        undefined,
        tuiContext().ctx,
      ),
    ).rejects.toThrow("dismissParked: true cannot be combined with questions");
    await expect(h.tool.execute("empty", {}, undefined, undefined, tuiContext().ctx)).rejects.toThrow(
      "questions is required",
    );
  });
});

// ---------------------------------------------------------------------------
// Real-session integration (P1-11 "不重问" acceptance row)
// ---------------------------------------------------------------------------

const integrationDirs: string[] = [];
afterEach(() => {
  for (const dir of integrationDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function until<T>(fn: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 500; i++) {
    const value = fn();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timeout waiting for ${what}`);
}

describe("integration: interrupt on a real session, scripted model does not re-ask", () => {
  it("persists ask-user:parked, sets ask 1, notifies once, and starts no extra run", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ask-user-parked-"));
    integrationDirs.push(cwd);
    const model = fakeModel();
    const scripted: ScriptedTurn[] = [
      toolTurn("ask_user", {
        questions: [{ question: "Which DB?", options: [{ label: "Postgres" }, { label: "SQLite" }] }],
      }),
      textTurn("done — no re-ask"),
    ];
    const modelRuntime = fakeModelRuntime(model, scripted);
    const port = new FakePort();
    const clock = new FakeClock();
    const settingsManager = SettingsManager.create(cwd, join(cwd, ".pi-agent"));
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: join(cwd, ".pi-agent"),
      settingsManager,
      extensionFactories: [
        ((pi: Parameters<typeof wireAskUser>[0]) =>
          wireAskUser(pi, { background: () => port, clock, interrupt: () => ({}) })) as never,
      ],
    });
    await loader.reload();
    const sessionManager = SessionManager.inMemory(cwd);
    const { session } = await createAgentSession({
      cwd,
      model: model as never,
      modelRuntime: modelRuntime as never,
      sessionManager,
      settingsManager,
      resourceLoader: loader,
    });
    try {
      const components: { render(width: number): string[] }[] = [];
      const notifies: string[] = [];
      const statuses: [string, string | undefined][] = [];
      const uiContext = {
        custom: (factoryFn: (...args: any[]) => unknown) =>
          new Promise((resolve) => {
            components.push(factoryFn(mockTui, stubTheme, {}, resolve) as never);
          }),
        notify: (message: string) => notifies.push(message),
        setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
      } as unknown as ExtensionUIContext;
      await session.bindExtensions({ uiContext, mode: "tui" });

      const runDone = session.prompt("go");
      await until(() => (components.length === 1 ? true : undefined), "ask_user dialog");
      port.fire();
      clock.advance(1000);
      await runDone;

      // The scripted model ended WITHOUT re-asking. Exactly the scripted turns ran.
      expect(modelRuntime.callCount()).toBe(2);
      // The tool result text the model saw is the interrupted text.
      expect(JSON.stringify(modelRuntime.requestMessages[1])).toContain(
        "ask_user was interrupted before the user answered",
      );
      // The parked snapshot is on the session branch.
      const branch = session.sessionManager.getBranch() as {
        type?: string;
        customType?: string;
        data?: { items?: ParkedEntry[] };
      }[];
      const parkedEntry = branch.find((e) => e.type === "custom" && e.customType === PARKED_CUSTOM_TYPE);
      expect(parkedEntry).toBeDefined();
      expect(parkedEntry!.data!.items).toHaveLength(1);
      expect(parkedEntry!.data!.items![0]!.question).toBe("Which DB?");
      expect(parkedEntry!.data!.items![0]!.interrupts).toBe(1);
      // Status bar + exactly one settle notify mentioning the question.
      expect(statuses).toContainEqual(["ask-user", "ask 1"]);
      expect(notifies).toHaveLength(1);
      expect(notifies[0]).toContain("Which DB?");
    } finally {
      session.dispose();
    }
  });
});
