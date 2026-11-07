// jev-plan §4 J9 e2e: one full lifecycle through the PRODUCTION assembly
// (`wireMemory` + the real PromptSectionHub + `wireJev`), starting from an
// EMPTY memory directory, all the way through `/mem init` → write (tagged) →
// U/A injection → `/mem review` → `/mem jev`. A second test repeats the
// shape with a `partial` classifier (jev-arch §5.3) to prove the zero-call
// fast path (A layer) still works when Jev itself cannot be asked. The gate
// interception step was removed with the gate feature (2026-11); the
// `gate=hold` writes below stay to pin that the inline marker parses but
// never blocks anymore.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import type { JevQuestion } from "../../src/memory/jev/contracts.js";
import { clearHealthTable } from "../../src/memory/jev/health.js";
import { readIndex } from "../../src/memory/jev/index-store.js";
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
  envTmp = mkdtempSync(join(tmpdir(), "jev-e2e-"));
  vi.stubEnv("HOME", join(envTmp, "nohome"));
  vi.stubEnv("ARMORY_MEMORY_ROOT", join(envTmp, "root"));
  cwd = join(envTmp, "proj");
  mkdirSync(cwd, { recursive: true });
  memDir = memoryDirFor(cwd); // NOT created — `/mem init` must create it
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(envTmp, { recursive: true, force: true });
  clearHealthTable();
});

/** Scripted classifier: tags the `release.sh` pitfall as `git-push`/`release`
 *  (bool questions), and judges any gate question `violates_now` so the
 *  hold rule blocks once. */
function answers(call: ClassifyCallRecord): Record<string, never> {
  const out: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(call.questions) as [string, JevQuestion][]) {
    if (q.type === "bool") {
      let p = 0.1;
      const entryText = typeof call.state["entry"] === "string" ? (call.state["entry"] as string) : "";
      if (/^t_/.test(id)) {
        // per-write tagging: only the proxy pitfall gets tagged git-push/release
        if ((id === "t_git-push" || id === "t_release") && entryText.includes("corp proxy")) p = 0.9;
      } else if (/^e\d+$/.test(id)) {
        // U/E-layer recall: match by the entry excerpt baked into the instructions
        // (node 18 for U, corp proxy for anything else that might ask).
        if (q.instructions.includes("node 18")) p = 0.88;
      }
      out[id] = { type: "bool", probability: p };
    } else if (q.type === "score") out[id] = { type: "score", score: 2, confidence: 0.9 };
    else if ("applies" in q.criteria || "violates_now" in q.criteria) {
      // Gate relation question: only a commit/tag command can violate the
      // "no commit/tag while release.sh runs" hold rule, and only while the
      // evidence (`state.running`) actually shows the job running — `git
      // push`, or a commit/tag issued once the job has ended, must come
      // back unrelated/applies so it is never (wrongly) blocked.
      const cmd = typeof call.state["command"] === "string" ? (call.state["command"] as string) : "";
      const running = Array.isArray(call.state["running"]) ? (call.state["running"] as unknown[]) : [];
      const relevant = /\b(commit|tag)\b/.test(cmd);
      const releaseRunning = running.length > 0;
      // The rule's own condition ("while release.sh runs") only HOLDS while
      // the job is running — once it ends the rule no longer applies at
      // all, so the relation collapses to unrelated and the call passes.
      out[id] =
        relevant && releaseRunning
          ? {
              type: "choice",
              choice: "violates_now",
              probabilities: { unrelated: 0.05, applies: 0.1, violates_now: 0.85 },
              confidence: 0.85,
            }
          : {
              type: "choice",
              choice: "unrelated",
              probabilities: { unrelated: 0.85, applies: 0.1, violates_now: 0.05 },
              confidence: 0.85,
            };
    } else {
      const k = id === "m_type" ? "pitfall" : id === "m_temporal" ? "permanent" : Object.keys(q.criteria)[0]!;
      out[id] = { type: "choice", choice: k, probabilities: { [k]: 0.9 }, confidence: 0.9 };
    }
  }
  return out as Record<string, never>;
}

function harness(opts: { partial?: boolean } = {}) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const sent: any[] = [];
  const branch: any[] = [];
  const notes: string[] = [];
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
  const wiring = wireMemory(pi, {
    settings: { ...DEFAULT_SETTINGS.memory },
    isChildSession: false,
    sections: hub,
    secureDomainKind: "plain",
  });
  const classifiers = DEFAULT_SETTINGS.memory.jev.classifiers;
  const fake = createFakeRegistry({
    // `partial` (NOT `inactive`): classifiers ARE in the catalog but every
    // call fails with a region-block (451, jev-arch §5.2's "不可用类"); an
    // empty `available` list would instead yield `inactive`.
    available: classifiers,
    responses: Object.fromEntries(
      classifiers.map((id) => [
        id,
        [
          (call: ClassifyCallRecord) =>
            opts.partial === true
              ? { stopReason: "error" as const, errorMessage: "System One API error (451): blocked" }
              : { stopReason: "stop" as const, answers: answers(call) },
        ],
      ]),
    ),
  });
  const ctx = (extra: Record<string, unknown> = {}) => ({
    cwd,
    mode: "tui",
    hasUI: true,
    ui: {
      notify: (m: string) => notes.push(m),
      confirm: async () => true,
      select: async () => undefined,
      editor: async (_t: string, body: string) => {
        notes.push(body);
        return undefined;
      },
    },
    modelRegistry: fake.registry,
    sessionManager: { getBranch: () => branch, getSessionId: () => "e2e-1" },
    ...extra,
  });
  const emit = async (event: string, payload: unknown, c: unknown = ctx()): Promise<any[]> => {
    const out: any[] = [];
    for (const h of handlers.get(event) ?? []) out.push(await h(payload, c));
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
  const toolCall = (command: string, toolCallId = `call_${++n}`): unknown =>
    handlers.get("tool_call")?.[0]?.({ type: "tool_call", toolName: "bash", toolCallId, input: { command } }, ctx());
  const mem = (args: string, c: unknown = ctx()) => commands.get("mem")!.handler(args, c);
  return { handlers, tools, commands, sent, notes, fake, ctx, emit, prompt, toolCall, mem };
}

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const text = (r: any): string => r.content.map((c: any) => c.text).join("\n");

describe("memory jev e2e (full)", () => {
  test("empty dir → /mem init → write (tagged) → U/A → /mem review → /mem jev", async () => {
    const h = harness();

    // `/mem init` on a directory that doesn't exist yet.
    expect(existsSync(memDir)).toBe(false);
    await h.mem("init");
    expect(existsSync(join(memDir, "core.md"))).toBe(true);
    expect(readFileSync(join(memDir, "core.md"), "utf8")).toContain("source: agent");

    await h.emit("session_start", { type: "session_start", reason: "startup" });
    await settle(); // probe

    // Write two pitfalls: one that A will pick up via its git-push tag, one
    // that U will pick up from the user's wording (keeping the two layers'
    // candidates disjoint so neither dedup-excludes the other, jev-arch
    // §6.1.6's "本段累计注入...不重复注入").
    const writeRes = await h.tools.get("memory").execute(
      "w1",
      {
        command: "create",
        path: "pitfalls-git.md",
        file_text:
          "# Pitfalls\n\n## Push\n\n- git push needs the corp proxy, otherwise it hangs\n\n## Install\n\n- npm install fails on node 18 because fs.globSync is missing\n",
      },
      undefined,
      undefined,
      h.ctx(),
    );
    expect(text(writeRes)).toContain("jev:");
    expect(text(writeRes)).toContain("tags");
    await settle(2_100); // corpus cache window (2s) — clear the empty corpus cached at session_start's probe

    const idx = readIndex(memDir).index;
    expect(Object.keys(idx.entries).length).toBeGreaterThan(0);

    // U layer: a user message about node 18 pulls that entry into context
    // (NOT the git-push one, so A below still has a fresh candidate).
    const uResults = await h.prompt("npm install keeps failing on node 18, why?");
    const u = uResults.find((r) => r?.message !== undefined)?.message;
    expect(u?.details?.layer).toBe("U");
    expect(u?.content).toContain("node 18");

    // A layer: a bash push hits the git-push tag, zero Jev calls.
    const callsBefore = h.fake.calls.length;
    await h.emit("tool_call", {
      type: "tool_call",
      toolName: "bash",
      toolCallId: "ta1",
      input: { command: "git push origin dev" },
    });
    expect(h.fake.calls.length).toBe(callsBefore);
    const a = h.sent.find((m) => m.details?.layer === "A");
    expect(a?.content).toContain("corp proxy");

    // Gate removed (2026-11): a `gate=hold` rule in memory parses but never
    // blocks — `git commit` proceeds unblocked.
    await h.tools.get("memory").execute(
      "w2",
      {
        command: "append",
        path: "core.md",
        content: "\n## 发版\n\n<!-- mem user gate=hold -->\n\n- release.sh 运行期间禁止 commit/tag/切分支\n",
      },
      undefined,
      undefined,
      h.ctx(),
    );
    await settle(2_100); // corpus cache window (2s)
    const passed = await h.toolCall("git commit -m wip2");
    expect(passed).toBeUndefined();

    // `/mem review` and `/mem jev` must both run cleanly through the real
    // command dispatcher (no throw), and `/mem jev` reports tagging progress.
    // `--list` is used here (not the interactive default) because the real
    // `handleMemReview` falls to `ui.select` for the per-pair prompt loop,
    // which this harness's `ctx().ui` does not implement; `--list` is the
    // read-only listing path and exercises the dispatcher end-to-end without
    // needing a scripted `select`.
    await expect(h.mem("review --list")).resolves.toBeUndefined();
    h.notes.length = 0;
    await h.mem("jev");
    expect(h.notes.join("\n")).toMatch(/jev: full|tagged/);
  });
});

describe("memory jev e2e (partial)", () => {
  test("same shape with a classifier-unavailable registry: write/U/A degrade to zero-call paths", async () => {
    const h = harness({ partial: true });

    await h.mem("init");
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    await settle();
    const afterProbe = h.fake.calls.length; // probe itself is the sole caller while partial

    const writeRes = await h.tools.get("memory").execute(
      "w1",
      {
        command: "create",
        path: "pitfalls-git.md",
        file_text: "# Pitfalls\n\n## Push\n\n- git push needs the corp proxy, otherwise it hangs\n",
      },
      undefined,
      undefined,
      h.ctx(),
    );
    // Partial: the write still lands, but tagging is deferred (pending).
    expect(text(writeRes)).toMatch(/partial|not tagged|pending/);

    await h.tools.get("memory").execute(
      "w2",
      {
        command: "append",
        path: "core.md",
        content: "\n## 发版\n\n<!-- mem user gate=hold -->\n\n- release.sh 运行期间禁止 commit/tag/切分支\n",
      },
      undefined,
      undefined,
      h.ctx(),
    );
    await settle(2_100); // corpus cache window (2s)

    // U layer: no Jev available ⇒ no U injection (current-session semantics
    // only — the probe itself is the sole caller, and it also fails).
    const callsBefore0 = h.fake.calls.length;
    const uResults = await h.prompt("why does npm/git push keep hanging on this machine?");
    expect(uResults.find((r) => r?.message !== undefined)).toBeUndefined();
    expect(h.fake.calls.length).toBe(callsBefore0);

    // Gate removed (2026-11): a tool call is never blocked, and no fresh
    // Jev call happens beyond the probe.
    const callsBefore1 = h.fake.calls.length;
    const blocked = await h.toolCall("git commit -m wip");
    expect(blocked).toBeUndefined();
    expect(h.fake.calls.length).toBe(callsBefore1);

    // `/mem jev` must still render without throwing, reporting the partial
    // state and the two-column stopped/running view.
    h.notes.length = 0;
    await h.mem("jev");
    expect(h.notes.join("\n")).toMatch(/partial/);
  });
});
