// Diagnostic log sink (J6 follow-up): interactive TUI sessions must never
// have jev write stdout/stderr directly (breaks the TUI layout). Covers:
//   - hasUI ⇒ failover failures (client.ts) and handler exceptions (wire.ts)
//     never reach console.warn, and land in the bounded ring buffer instead
//   - buffer capacity cap
//   - `/mem jev` report surfaces the most recent entries
//   - no UI ⇒ console.warn behavior is byte-identical to before this change

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { jevConfigOf } from "../../../src/memory/jev/config.js";
import type { JevConfig, JevQuestion } from "../../../src/memory/jev/contracts.js";
import { clearHealthTable } from "../../../src/memory/jev/health.js";
import { wireJev } from "../../../src/memory/jev/wire.js";
import { DEFAULT_MEMORY_SETTINGS } from "../../../src/memory/settings.js";
import { createFakeRegistry, type ClassifyCallRecord } from "./helpers/fake-registry.js";

type Handler = (event: unknown, ctx: unknown) => unknown;
const CLASSIFIERS = ["opencode/jev-1.13-free", "opencode/jev-1.13"];

let tmp: string;
let memDir: string;

beforeEach(() => {
  clearHealthTable();
  tmp = mkdtempSync(join(tmpdir(), "jev-wire-errlog-"));
  memDir = join(tmp, "mem");
  mkdirSync(memDir, { recursive: true });
  writeFileSync(
    join(memDir, "core.md"),
    [
      "# Core",
      "",
      "## Rules",
      "",
      "- always run long commands with timeout so nothing hangs",
      "- commit only exact paths and never use git add -A",
      "",
    ].join("\n"),
  );
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  clearHealthTable();
});

type Rules = readonly (readonly [string, number])[];
function answersFor(questions: Record<string, JevQuestion>, rules: Rules): Record<string, never> {
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

/** No `log` dep override on purpose — exercises the real default sink. */
function harness(opts: {
  hasUI: boolean;
  isChild?: boolean;
  fail?: string; // force every classify() call to error with this message (failover path)
  rules?: Rules; // bool-question answers, for a successful U-layer recall (handler-exception path)
  delayMs?: number; // delay classify() answers past recall.waitMs so the U result sends async via send()
  sendMessageThrows?: boolean;
  settings?: typeof DEFAULT_MEMORY_SETTINGS;
  config?: Partial<JevConfig>;
}) {
  const handlers = new Map<string, Handler[]>();
  const notes: { text: string; level?: string }[] = [];
  const branch: unknown[] = [];
  let nextId = 1;
  const pi = {
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage: (message: unknown) => {
      if (opts.sendMessageThrows === true) throw new Error("sendMessage boom");
      branch.push({ type: "custom_message", id: `m${nextId++}`, ...(message as object) });
    },
    appendEntry: (customType: string, data: unknown) => {
      branch.push({ type: "custom", id: `c${nextId++}`, customType, data });
    },
    registerMessageRenderer: () => {},
  } as unknown as ExtensionAPI;
  const fake = createFakeRegistry({
    available: CLASSIFIERS,
    responses: Object.fromEntries(
      CLASSIFIERS.map((id) => [
        id,
        [
          async (call: ClassifyCallRecord) => {
            if (opts.delayMs !== undefined) await new Promise((r) => setTimeout(r, opts.delayMs));
            return opts.fail !== undefined
              ? { stopReason: "error" as const, errorMessage: opts.fail }
              : {
                  stopReason: "stop" as const,
                  answers: answersFor(call.questions, opts.rules ?? []),
                  usage: { input: 1, cost: { total: 0.0001 } },
                };
          },
        ],
      ]),
    ),
  });
  const config: JevConfig = { ...jevConfigOf(DEFAULT_MEMORY_SETTINGS), classifiers: CLASSIFIERS, ...opts.config };
  const writeHooks: ((cwd: string) => void)[] = [];
  const wire = wireJev(pi, {
    config,
    settings: opts.settings ?? DEFAULT_MEMORY_SETTINGS,
    isChildSession: opts.isChild ?? false,
    dirFor: () => memDir,
    getRenderInfo: () => undefined,
    onAfterWriteHook: (fn) => writeHooks.push(fn),
    // intentionally no `log` override: exercises the real default sink
  });
  const ctx = (extra: Record<string, unknown> = {}) => ({
    cwd: tmp,
    hasUI: opts.hasUI,
    ui: { notify: (text: string, level?: string) => notes.push({ text, level }) },
    modelRegistry: fake.registry,
    sessionManager: { getBranch: () => branch, getSessionId: () => "s1" },
    ...extra,
  });
  const emit = async (event: string, payload: unknown, c: unknown = ctx()): Promise<unknown[]> => {
    const out: unknown[] = [];
    for (const h of handlers.get(event) ?? []) out.push(await h(payload, c));
    return out;
  };
  const prompt = async (text: string) => {
    branch.push({ type: "message", id: `u${nextId++}`, message: { role: "user", content: text } });
    return (await emit("before_agent_start", { type: "before_agent_start", messageType: "user", prompt: text }))[0] as
      { message?: unknown } | undefined;
  };
  return { handlers, notes, fake, wire, emit, prompt, writeHooks };
}

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

describe("jev diagnostic log sink — hasUI", () => {
  test("failover failures (client.ts) never reach console.warn; they land in the ring buffer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const h = harness({ hasUI: true, fail: "System One API error (451): nope" });
      await h.emit("session_start", { type: "session_start", reason: "startup" });
      await settle(150);
      expect(warn).not.toHaveBeenCalled();
      const report = await h.wire.commandPort.report(tmp, undefined);
      expect(report).toContain("errors");
      expect(report).toMatch(/opencode\/jev-1\.13(-free)? failed \(unavailable\)/);
    } finally {
      warn.mockRestore();
    }
  });

  test("handler exceptions (wire.ts catch sites, e.g. a late sendMessage throwing) also go to the buffer, not console.warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const h = harness({
        hasUI: true,
        rules: [["timeout", 0.9]],
        delayMs: 120,
        sendMessageThrows: true,
        config: { recall: { threshold: 0.6, maxEntries: 3, maxBytes: 4096, waitMs: 20 } },
      });
      await h.emit("session_start", { type: "session_start", reason: "startup" });
      await settle(150);
      const r = await h.prompt("please run it with a timeout");
      expect(r?.message).toBeUndefined(); // the answer is late: nothing returned synchronously
      await settle(250); // the late answer arrives and the async send() throws
      expect(warn).not.toHaveBeenCalled();
      const report = await h.wire.commandPort.report(tmp, undefined);
      expect(report).toMatch(/sendMessage failed/);
    } finally {
      warn.mockRestore();
    }
  });

  test("ring buffer caps at its capacity and `/mem jev` only shows the most recent entries", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const h = harness({
        hasUI: true,
        rules: [["timeout", 0.9]],
        delayMs: 20,
        sendMessageThrows: true,
        config: { recall: { threshold: 0.6, maxEntries: 3, maxBytes: 4096, waitMs: 5 } },
      });
      await h.emit("session_start", { type: "session_start", reason: "startup" });
      await settle(150);
      // Each prompt's late U-layer answer ⇒ async send() ⇒ throws ⇒ one more
      // "sendMessage failed" push onto the ring buffer.
      for (let i = 0; i < 60; i += 1) {
        await h.prompt(`please run command number ${i} with a timeout`);
        await settle(30);
      }
      expect(warn).not.toHaveBeenCalled();
      const report = await h.wire.commandPort.report(tmp, undefined);
      const errorLines = report.split("\n").filter((l) => l.includes("sendMessage failed"));
      expect(errorLines.length).toBeGreaterThan(0);
      // Only the configured display count is surfaced by the report; the
      // internal cap (50) is exercised by 60 pushes not crashing / growing
      // the report unbounded.
      expect(errorLines.length).toBeLessThanOrEqual(5);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("jev diagnostic log sink — no UI", () => {
  test("console.warn behavior is unchanged: failover failures still print, byte-identical prefix", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const h = harness({ hasUI: false, fail: "System One API error (451): nope" });
      await h.emit("session_start", { type: "session_start", reason: "startup" });
      await settle(150);
      expect(warn).toHaveBeenCalled();
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.startsWith("[pi-subagent] jev: ") && l.includes("failed (unavailable)"))).toBe(true);
      const report = await h.wire.commandPort.report(tmp, undefined);
      expect(report).not.toContain("errors");
    } finally {
      warn.mockRestore();
    }
  });

  test("child sessions share the host process's stdout: diagnostics go to the ring buffer, never console.warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const h = harness({
        hasUI: false,
        isChild: true,
        fail: "System One API error (451): nope",
        settings: { ...DEFAULT_MEMORY_SETTINGS, injectInChildSessions: true },
        config: { childSessions: true },
      });
      await h.emit("session_start", { type: "session_start", reason: "startup" });
      await h.prompt("please remember this child-session command");
      await settle(150);
      // Not a tautology: the classifier path must actually have run.
      expect(h.fake.calls.length).toBeGreaterThan(0);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("jev diagnostic persistence — `.jev/diag.jsonl` (2026-11-04 fix)", () => {
  test("ring-bound lines are also persisted to the memory dir's diag ring (redacted, jsonl)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const h = harness({ hasUI: true, fail: "System One API error (451): nope" });
      await h.emit("session_start", { type: "session_start", reason: "startup" });
      await settle(300); // fire-and-forget append runs on its own tick
      const diagPath = join(memDir, ".jev", "diag.jsonl");
      expect(existsSync(diagPath)).toBe(true);
      const text = readFileSync(diagPath, "utf8");
      for (const line of text.trim().split("\n")) {
        const rec = JSON.parse(line) as { at: string; line: string };
        expect(typeof rec.at).toBe("string");
        expect(rec.line).toMatch(/opencode\/jev-1\.13(-free)? failed \(unavailable\)/);
      }
    } finally {
      warn.mockRestore();
    }
  });

  test("restart: a fresh activation with an empty in-memory ring surfaces the persisted errors in `/mem jev`", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // session 1: errors land on disk
      const h1 = harness({ hasUI: true, fail: "System One API error (451): nope" });
      await h1.emit("session_start", { type: "session_start", reason: "startup" });
      await settle(300);
      expect(existsSync(join(memDir, ".jev", "diag.jsonl"))).toBe(true);

      // session 2 (same project): healthy registry, no new failures — the
      // report must fall back to the persisted diag ring.
      const h2 = harness({ hasUI: true });
      await h2.emit("session_start", { type: "session_start", reason: "startup" });
      await settle(200);
      const report = await h2.wire.commandPort.report(tmp, undefined);
      expect(report).toContain("errors");
      expect(report).toMatch(/errors\s+\d\d:\d\d .*failed \(unavailable\)/);
    } finally {
      warn.mockRestore();
    }
  });

  test("in-memory ring wins while non-empty (no duplicated/stale errors section)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const h = harness({ hasUI: true, fail: "System One API error (451): nope" });
      await h.emit("session_start", { type: "session_start", reason: "startup" });
      await settle(300);
      const report = await h.wire.commandPort.report(tmp, undefined);
      const errorLines = report.split("\n").filter((l) => l.includes("failed (unavailable)"));
      expect(errorLines.length).toBeGreaterThan(0);
      expect(errorLines.length).toBeLessThanOrEqual(5);
    } finally {
      warn.mockRestore();
    }
  });

  test("no-UI main sessions never read the persisted ring: report stays ring-less even with diag.jsonl present", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // seed the diag file via a UI session
      const h1 = harness({ hasUI: true, fail: "System One API error (451): nope" });
      await h1.emit("session_start", { type: "session_start", reason: "startup" });
      await settle(300);
      // a no-UI session must keep its byte-identical console.warn + ring-less report
      const h2 = harness({ hasUI: false });
      await h2.emit("session_start", { type: "session_start", reason: "startup" });
      await settle(200);
      const report = await h2.wire.commandPort.report(tmp, undefined);
      expect(report).not.toContain("errors");
    } finally {
      warn.mockRestore();
    }
  });
});
