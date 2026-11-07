// jev-plan §4 J6 integration: one full session through the PRODUCTION
// assembly (`wireMemory` + the real PromptSectionHub + `wireJev`) with a
// scripted classifier registry on ctx —
//   session_start probe → bulk tagging → user message (U, static core
//   excluded via the hub's render info) → tool call hits a tag (A) →
//   compaction (B) → `/reload` (fresh activation over the same branch)
//   re-seeds and does not re-inject.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import { clearHealthTable } from "../../src/memory/jev/health.js";
import { readIndex } from "../../src/memory/jev/index-store.js";
import type { JevQuestion } from "../../src/memory/jev/contracts.js";
import { wireMemory } from "../../src/memory/index.js";
import { memoryDirFor } from "../../src/memory/paths.js";
import { createPromptSectionHub } from "../../src/sysprompt/hub.js";
import { createFakeRegistry, type ClassifyCallRecord } from "../memory/jev/helpers/fake-registry.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

let envTmp: string;
let cwd: string;
let memDir: string;

beforeEach(() => {
  clearHealthTable();
  envTmp = mkdtempSync(join(tmpdir(), "jev-int-recall-"));
  vi.stubEnv("HOME", join(envTmp, "nohome"));
  vi.stubEnv("ARMORY_MEMORY_ROOT", join(envTmp, "root"));
  cwd = join(envTmp, "proj");
  mkdirSync(cwd, { recursive: true });
  memDir = memoryDirFor(cwd);
  mkdirSync(memDir, { recursive: true });
  writeFileSync(
    join(memDir, "core.md"),
    "# Core\n\n## Rules\n\n- always wrap long commands with timeout <!-- mem user -->\n",
  );
  writeFileSync(
    join(memDir, "pitfalls-git.md"),
    "# Pitfalls git\n\n## Push\n\n- git push needs the proxy configured, otherwise it hangs forever\n- npm install fails on node 18 because fs.globSync is missing\n",
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(envTmp, { recursive: true, force: true });
  clearHealthTable();
});

/** Scripted classifier: tag-major `git-push` ⇒ the proxy entry; recall ⇒ the
 *  node-18 entry; entry part ⇒ type "rule", importance 2. */
function answers(call: ClassifyCallRecord): Record<string, never> {
  const out: Record<string, unknown> = {};
  const tag = typeof call.state["tag"] === "string" ? (call.state["tag"] as string) : undefined;
  for (const [id, q] of Object.entries(call.questions) as [string, JevQuestion][]) {
    if (q.type === "bool") {
      let p = 0.1;
      if (tag?.startsWith("git-push") === true && q.instructions.includes("proxy")) p = 0.9;
      if (typeof call.state["user_message"] === "string" && q.instructions.includes("node 18")) p = 0.88;
      out[id] = { type: "bool", probability: p };
    } else if (q.type === "score") out[id] = { type: "score", score: 2, confidence: 0.9 };
    else {
      const k = id === "m_type" ? "rule" : Object.keys(q.criteria)[0]!;
      out[id] = { type: "choice", choice: k, probabilities: { [k]: 0.9 }, confidence: 0.9 };
    }
  }
  return out as Record<string, never>;
}

function activation(branch: any[]) {
  const handlers = new Map<string, Handler[]>();
  const sent: any[] = [];
  let n = 0;
  const pi = {
    on: (event: string, h: Handler) => {
      const l = handlers.get(event) ?? [];
      l.push(h);
      handlers.set(event, l);
      return () => {};
    },
    registerTool: () => {},
    registerCommand: () => {},
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
  wireMemory(pi, {
    settings: {
      ...DEFAULT_SETTINGS.memory,
      jev: { ...DEFAULT_SETTINGS.memory.jev, recall: { ...DEFAULT_SETTINGS.memory.jev.recall } },
    },
    isChildSession: false,
    sections: hub,
    secureDomainKind: "plain",
  });
  const fake = createFakeRegistry({
    available: DEFAULT_SETTINGS.memory.jev.classifiers,
    responses: Object.fromEntries(
      DEFAULT_SETTINGS.memory.jev.classifiers.map((id) => [
        id,
        [(call: ClassifyCallRecord) => ({ stopReason: "stop" as const, answers: answers(call) })],
      ]),
    ),
  });
  const ctx = {
    cwd,
    hasUI: true,
    ui: { notify: () => {} },
    modelRegistry: fake.registry,
    sessionManager: { getBranch: () => branch, getSessionId: () => "int-1" },
  };
  const emit = async (event: string, payload: Record<string, unknown>): Promise<any[]> => {
    const out: any[] = [];
    for (const h of handlers.get(event) ?? []) out.push(await h(payload, ctx));
    return out;
  };
  const prompt = async (text: string) => {
    branch.push({ type: "message", id: `u${n++}`, message: { role: "user", content: text } });
    return emit("before_agent_start", {
      type: "before_agent_start",
      messageType: "user",
      prompt: text,
      systemPrompt: "BASE",
      systemPromptOptions: { cwd },
    });
  };
  return { handlers, sent, fake, emit, prompt };
}

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

describe("memory jev recall — full session through wireMemory", () => {
  test("U → A → compaction B → /reload seeding", async () => {
    const branch: any[] = [];
    const a = activation(branch);
    await a.emit("session_start", { type: "session_start", reason: "startup" });
    await settle(); // probe + first-full bulk tagging
    expect(Object.keys(readIndex(memDir).index.entries).length).toBe(3);

    // U: the hub renders first (static core map), then jev recalls.
    const results = await a.prompt("npm install keeps failing on this machine, why?");
    const hubResult = results.find((r) => r?.systemPrompt !== undefined);
    expect(hubResult?.systemPrompt).toContain("always wrap long commands with timeout");
    expect(hubResult?.systemPrompt).not.toContain("<!-- mem"); // jev on ⇒ inline comments stripped
    const u = results.find((r) => r?.message !== undefined)?.message;
    expect(u?.details.layer).toBe("U");
    expect(u?.content).toContain("node 18");
    expect(results.every((r) => r?.message === undefined || r.systemPrompt === undefined)).toBe(true);
    const recallCall = a.fake.calls.find((c) => typeof c.state["user_message"] === "string")!;
    expect(JSON.stringify(recallCall.questions)).not.toContain("wrap long commands"); // static core excluded

    // A: bash git push hits the git-push tag of the proxy entry (tagged by bulk).
    const callsBefore = a.fake.calls.length;
    await a.emit("tool_call", {
      type: "tool_call",
      toolName: "bash",
      toolCallId: "t1",
      input: { command: "git push origin dev" },
    });
    expect(a.fake.calls.length).toBe(callsBefore); // zero calls
    const aMsg = a.sent.find((m) => m.details?.layer === "A");
    expect(aMsg?.content).toContain("proxy configured");

    // compaction ⇒ B re-injects both once.
    branch.push({ type: "compaction", id: "cmp-1" });
    await a.emit("session_compact", { type: "session_compact", compactionEntry: { id: "cmp-1" } });
    const b = a.sent.filter((m) => m.details?.layer === "B");
    expect(b).toHaveLength(1);
    expect(b[0].content).toContain("proxy configured");
    expect(b[0].content).toContain("node 18");

    // /reload: fresh activation over the same branch — seeded, no re-injection.
    await a.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
    const r2 = activation(branch);
    await r2.emit("session_start", { type: "session_start", reason: "reload" });
    await settle();
    const again = await r2.prompt("npm install still fails after the reload, why?");
    expect(again.find((r) => r?.message !== undefined)).toBeUndefined();
    const q2 = r2.fake.calls.filter((c) => typeof c.state["user_message"] === "string");
    for (const c of q2) expect(JSON.stringify(c.questions)).not.toContain("node 18");
    await r2.emit("tool_call", {
      type: "tool_call",
      toolName: "bash",
      toolCallId: "t2",
      input: { command: "git push" },
    });
    expect(r2.sent.filter((m) => m.details?.layer === "A")).toHaveLength(0);
    expect(r2.sent.filter((m) => m.details?.layer === "B")).toHaveLength(0);
  });
});
