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
  PARKED_TTL_MS,
  createParkedRegistry,
  questionFingerprint,
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
    expect(statuses).toContainEqual(["ask-user", "ask⏸1"]);
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
        optionCount: 3,
        cursorIndex: 1,
        selectedIndex: null,
        selectedIndices: [],
        confirmed: false,
        freeTextValue: null,
        freeDraft: null,
        mode: "options",
        draftText: "",
        savedOptionsCursorIndex: 0,
        activeTab: 0,
      },
    });
    h.trigger("session_start", {}, fakeCtx(parkedBranch([restored]), { statuses }));
    expect(statuses).toContainEqual(["ask-user", "ask⏸1"]);
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
  it("persists ask-user:parked, sets ask⏸1, notifies once, and starts no extra run", async () => {
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
      expect(statuses).toContainEqual(["ask-user", "ask⏸1"]);
      expect(notifies).toHaveLength(1);
      expect(notifies[0]).toContain("Which DB?");
    } finally {
      session.dispose();
    }
  });
});
