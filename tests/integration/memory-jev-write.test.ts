// jev-plan §4 J7 memory-jev-write: production wiring of the J5 write port,
// the J8 doctor port and the Q34 reminder through `wireMemory`:
//   · jev on ⇒ the memory tool description is the §9.3 variant;
//   · write → tag (scripted classifier) → echo → sidecar on disk → the A
//     layer sees the new entry on the next matching tool call;
//   · a registry the hooks treat as off(pi-api) (no getModelOfType) never
//     reaches the classifier through the write path either;
//   · `/mem doctor` reports D17–D19; the startup reminder carries the jev
//     extras including the core-usage line (J8 acceptance #3);
//   · Q34: all-invalid classifiers ⇒ jev unwired + one reminder line
//     (deduped per session); an empty list ⇒ no line, same as disabled.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import type { JevQuestion } from "../../src/memory/jev/contracts.js";
import { EntryIndex } from "../../src/memory/jev/entries.js";
import { clearHealthTable } from "../../src/memory/jev/health.js";
import { readIndex } from "../../src/memory/jev/index-store.js";
import { wireMemory } from "../../src/memory/index.js";
import { memoryDirFor } from "../../src/memory/paths.js";
import type { MemorySettings } from "../../src/memory/settings.js";
import { MEMORY_TOOL_V2_TEXT, MEMORY_TOOL_V2_TEXT_JEV } from "../../src/memory/tool-surface.js";
import { createPromptSectionHub } from "../../src/sysprompt/hub.js";
import { createFakeRegistry, type ClassifyCallRecord } from "../memory/jev/helpers/fake-registry.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

let envTmp: string;
let cwd: string;
let memDir: string;

beforeEach(() => {
  clearHealthTable();
  envTmp = mkdtempSync(join(tmpdir(), "jev-int-write-"));
  vi.stubEnv("HOME", join(envTmp, "nohome"));
  vi.stubEnv("ARMORY_MEMORY_ROOT", join(envTmp, "root"));
  cwd = join(envTmp, "proj");
  mkdirSync(cwd, { recursive: true });
  memDir = memoryDirFor(cwd);
  mkdirSync(memDir, { recursive: true });
  writeFileSync(join(memDir, "core.md"), "# Core\n\n## Rules\n\n- always wrap long commands with timeout\n");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(envTmp, { recursive: true, force: true });
  clearHealthTable();
});

/** Tagging answers: `t_git-push` 0.9 (others 0.1), type pitfall, importance
 *  2, guard 0.1, permanent; compare questions unrelated. */
function tagAnswers(call: ClassifyCallRecord): Record<string, never> {
  const out: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(call.questions) as [string, JevQuestion][]) {
    if (q.type === "bool") out[id] = { type: "bool", probability: id === "t_git-push" ? 0.9 : 0.1 };
    else if (q.type === "score") out[id] = { type: "score", score: 2, confidence: 0.9 };
    else {
      const k = id === "m_type" ? "pitfall" : id === "m_temporal" ? "permanent" : "unrelated";
      out[id] = { type: "choice", choice: k, probabilities: { [k]: 0.9 }, confidence: 0.9 };
    }
  }
  return out as Record<string, never>;
}

function production(settings: MemorySettings = { ...DEFAULT_SETTINGS.memory }) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const sent: any[] = [];
  const branch: any[] = [];
  let n = 0;
  const pi = {
    on: (event: string, h: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), h]);
      return () => {};
    },
    registerTool: (t: any) => tools.set(t.name, t),
    registerCommand: (name: string, c: any) => commands.set(name, c),
    registerMessageRenderer: () => {},
    getActiveTools: () => ["read", "bash", "memory"],
    sendMessage: (m: any) => {
      sent.push(m);
      branch.push({ type: "custom_message", id: `m${n++}`, ...m });
    },
    appendEntry: (customType: string, data: unknown) =>
      branch.push({ type: "custom", id: `e${n++}`, customType, data }),
  } as unknown as ExtensionAPI;
  const hub = createPromptSectionHub(pi, { mode: () => "stable", wakeReplay: false, adoptForeignForcedPrompt: false });
  wireMemory(pi, { settings, isChildSession: false, sections: hub, secureDomainKind: "plain" });
  const fake = createFakeRegistry({
    available: DEFAULT_SETTINGS.memory.jev.classifiers,
    responses: Object.fromEntries(
      DEFAULT_SETTINGS.memory.jev.classifiers.map((id) => [
        id,
        [(call: ClassifyCallRecord) => ({ stopReason: "stop" as const, answers: tagAnswers(call) })],
      ]),
    ),
  });
  const notes: string[] = [];
  const ctx = (extra: Record<string, unknown> = {}) => ({
    cwd,
    mode: "tui",
    hasUI: true,
    ui: {
      notify: (m: string) => notes.push(m),
      confirm: async () => true,
      editor: async (_t: string, body: string) => {
        notes.push(body);
        return undefined;
      },
    },
    modelRegistry: fake.registry,
    sessionManager: { getBranch: () => branch, getSessionId: () => "w-1" },
    ...extra,
  });
  const emit = async (event: string, payload: unknown, c: unknown = ctx()) => {
    for (const h of handlers.get(event) ?? []) await h(payload, c);
  };
  return { handlers, tools, commands, sent, fake, notes, ctx, emit };
}

const text = (r: any): string => r.content.map((c: any) => c.text).join("\n");

describe("write port in production wiring", () => {
  test("tool description variant; write → tag → echo → sidecar → A layer sees the entry", async () => {
    const p = production();
    const tool = p.tools.get("memory");
    expect(tool.description).toBe(MEMORY_TOOL_V2_TEXT_JEV.description);
    expect(tool.description).not.toBe(MEMORY_TOOL_V2_TEXT.description);

    const r = await tool.execute(
      "w1",
      {
        command: "create",
        path: "pitfalls-git.md",
        file_text:
          "# Pitfalls git\n\n## Push\n\n- git push needs the corp proxy configured, otherwise it hangs forever\n",
      },
      undefined,
      undefined,
      p.ctx(),
    );
    const out = text(r);
    expect(out).toContain("jev: pitfall 0.90");
    expect(out).toContain("tags git-push 0.90");
    expect(p.fake.calls.length).toBeGreaterThan(0);

    const entry = new EntryIndex().get(memDir).find((e) => e.body.includes("corp proxy"))!;
    const idx = readIndex(memDir).index;
    expect(idx.entries[entry.hash]?.tags["git-push"]?.p).toBe(0.9);

    const callsBefore = p.fake.calls.length;
    const res = p.handlers.get("tool_call")![0]!(
      { type: "tool_call", toolName: "bash", toolCallId: "t9", input: { command: "git push origin dev" } },
      p.ctx(),
    );
    expect(res).toBeUndefined(); // not guarded (guard 0.1) ⇒ coarse filter passes synchronously
    const a = p.sent.find((m) => m.details?.layer === "A");
    expect(a?.content).toContain("corp proxy");
    expect(p.fake.calls.length).toBe(callsBefore); // A layer is zero-call
  });

  test("a registry without getModelOfType is off(pi-api) for the write path too (one verdict with the hooks)", async () => {
    const p = production();
    const partial = { classify: p.fake.registry.classify, getAvailableOfType: p.fake.registry.getAvailableOfType };
    const r = await p.tools
      .get("memory")
      .execute(
        "w2",
        { command: "create", path: "notes.md", file_text: "# Notes\n\n- git push goes through the proxy\n" },
        undefined,
        undefined,
        p.ctx({ modelRegistry: partial }),
      );
    expect(text(r)).toContain("jev: not tagged (off: pi-api)");
    expect(p.fake.calls).toHaveLength(0);
    // arch §8 / plan §1.1: the description variant is a settings-period,
    // registration-time choice (frozen for the activation) — off(pi-api) is
    // only knowable per ctx at runtime, so the variant stays.
    expect(p.tools.get("memory").description).toBe(MEMORY_TOOL_V2_TEXT_JEV.description);
  });
});

describe("doctor port in production wiring", () => {
  const bigCore = () => {
    const lines = ["# Core", "", "## Rules", ""];
    while (lines.join("\n").length < 1_380)
      lines.push(`- rule number ${lines.length} keeps the core file reasonably full`);
    lines.push("- GPT 系模型临时禁用 <!-- mem user expires=2026-01-01 -->");
    lines.push("- broken marker here <!-- mem expires=2026-13-45 -->");
    return `${lines.join("\n")}\n`;
  };

  test("/mem doctor lists D17–D19; the startup reminder carries expired + core usage lines", async () => {
    writeFileSync(join(memDir, "core.md"), bigCore());
    const p = production();
    await p.commands.get("mem").handler("doctor", p.ctx());
    const report = p.notes.join("\n");
    expect(report).toContain("D17");
    expect(report).toContain("D18");
    expect(report).toContain("D19");

    p.notes.length = 0;
    await p.emit("session_start", { type: "session_start", reason: "startup" });
    const reminder = p.notes.find((m) => m.includes("core usage"));
    expect(reminder).toBeDefined();
    expect(reminder).toMatch(/memory: core usage — core\.md is at \d+% of coreBytes/);
    expect(reminder).toContain("memory: 1 expired entry → /mem expired");
  });

  test("core below 80% ⇒ no core usage line", async () => {
    writeFileSync(join(memDir, "core.md"), "# Core\n\n## Rules\n\n- tiny <!-- mem user expires=2026-01-01 -->\n");
    const p = production();
    await p.emit("session_start", { type: "session_start", reason: "startup" });
    const all = p.notes.join("\n");
    expect(all).toContain("memory: 1 expired entry → /mem expired");
    expect(all).not.toContain("core usage");
  });
});

describe("Q34 classifiers reminder", () => {
  const withClassifiers = (classifiers: string[], rejected: string[]): MemorySettings => ({
    ...DEFAULT_SETTINGS.memory,
    jev: { ...DEFAULT_SETTINGS.memory.jev, classifiers, classifiersRejected: rejected },
  });

  test("all entries invalid ⇒ jev unwired + one reminder line, deduped per session", async () => {
    const p = production(withClassifiers([], ["foo"]));
    expect(p.handlers.get("tool_call")).toBeUndefined(); // jev not wired
    expect(p.tools.get("memory").description).toBe(MEMORY_TOOL_V2_TEXT.description);
    await p.emit("session_start", { type: "session_start", reason: "startup" });
    await p.emit("session_start", { type: "session_start", reason: "startup" });
    const lines = p.notes.filter((m) => m.includes("memory.jev.classifiers"));
    expect(lines).toEqual(["memory.jev.classifiers: all entries invalid (foo) — jev off"]);
  });

  test("an empty list (nothing rejected) ⇒ no reminder line, identical to disabled", async () => {
    const empty = production(withClassifiers([], []));
    await empty.emit("session_start", { type: "session_start", reason: "startup" });
    const disabled = production({
      ...DEFAULT_SETTINGS.memory,
      jev: { ...DEFAULT_SETTINGS.memory.jev, enabled: false },
    });
    await disabled.emit("session_start", { type: "session_start", reason: "startup" });
    expect(empty.notes).toEqual(disabled.notes);
    expect(empty.notes.join("\n")).not.toContain("memory.jev.classifiers");
    expect(empty.handlers.get("tool_call")).toBeUndefined();
  });
});
