// jev-plan §4 J7 memory-jev-gate: the gate's state boundaries through the
// PRODUCTION assembly (`wireMemory` → `wireJev`), jev-arch §9.2's three
// partial/inactive rules, child-session gating, and nested executeTool ids.
//
//   1. inactive (coverage 0, no inline gate*/tags=, no credentials) ⇒ zero
//      sendMessage, zero block;
//   2. partial with inline metadata ⇒ evidence tier only: only
//      `gate=hold` + named program running blocks; others pass + unjudged;
//   3. no Jev call at all while partial (the probe is the only caller);
//   child sessions gate too (Jev judged, `session:"child"`, no bash-job
//   evidence even if a port were attached); `<parent>/1` nested ids are
//   gated like any call (C-J11).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import type { JevQuestion } from "../../src/memory/jev/contracts.js";
import { clearHealthTable } from "../../src/memory/jev/health.js";
import { jevBashJobsFrom, wireMemory, type BashJobRecordLike } from "../../src/memory/index.js";
import { memoryDirFor } from "../../src/memory/paths.js";
import { createPromptSectionHub } from "../../src/sysprompt/hub.js";
import { createFakeRegistry, type ClassifyCallRecord } from "../memory/jev/helpers/fake-registry.js";
import {
  assistantTextMsg,
  disposeHarnessDirs,
  fakeModel,
  withSession,
  type ScriptedTurn,
} from "../conformance/agent-session-harness.js";

type Handler = (event: unknown, ctx: unknown) => unknown;
const HOLD_RULE = [
  "# Pitfalls",
  "",
  "## 发版进行中禁止动 git 状态",
  "",
  "<!-- mem user gate=hold -->",
  "",
  "- release.sh 运行期间禁止 commit/tag/切分支",
  "",
  "## Commit",
  "",
  "- 提交前先跑 `npm run typecheck` <!-- mem user gate -->",
  "",
].join("\n");

let envTmp: string;
let cwd: string;
let memDir: string;

beforeEach(() => {
  clearHealthTable();
  envTmp = mkdtempSync(join(tmpdir(), "jev-int-gate-"));
  vi.stubEnv("HOME", join(envTmp, "nohome"));
  vi.stubEnv("ARMORY_MEMORY_ROOT", join(envTmp, "root"));
  cwd = join(envTmp, "proj");
  mkdirSync(cwd, { recursive: true });
  memDir = memoryDirFor(cwd);
  mkdirSync(memDir, { recursive: true });
  writeFileSync(join(memDir, "core.md"), "# Core\n\n## Rules\n\n- always wrap long commands with timeout\n");
});
afterEach(() => {
  disposeHarnessDirs();
  vi.unstubAllEnvs();
  rmSync(envTmp, { recursive: true, force: true });
  clearHealthTable();
});

function onceAnswers(call: ClassifyCallRecord): Record<string, never> {
  const out: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(call.questions) as [string, JevQuestion][]) {
    if (q.type === "choice")
      out[id] = {
        type: "choice",
        choice: "applies",
        probabilities: { unrelated: 0.1, applies: 0.85, violates_now: 0.05 },
        confidence: 0.85,
      };
    else if (q.type === "bool") out[id] = { type: "bool", probability: 0.9 };
    else out[id] = { type: "score", score: 2, confidence: 0.9 };
  }
  return out as Record<string, never>;
}

function production(opts: { mode: "ok" | "451" | "no-auth"; child?: boolean }) {
  const handlers = new Map<string, Handler[]>();
  const sent: any[] = [];
  const branch: any[] = [];
  let n = 0;
  const pi = {
    on: (event: string, h: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), h]);
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
  const wiring = wireMemory(pi, {
    settings: { ...DEFAULT_SETTINGS.memory },
    isChildSession: opts.child === true,
    sections: hub,
    secureDomainKind: "plain",
    // Empty /proc: host processes (e.g. a release.sh running this suite) must not leak into evidence.
    jevProcRoot: join(envTmp, "empty-proc"),
  });
  const jobs: BashJobRecordLike[] = [];
  wiring.attachJevBashJobs(jevBashJobsFrom(() => jobs));
  const classifiers = DEFAULT_SETTINGS.memory.jev.classifiers;
  const fake = createFakeRegistry({
    available: opts.mode === "no-auth" ? [] : classifiers,
    responses: Object.fromEntries(
      classifiers.map((id) => [
        id,
        [
          (call: ClassifyCallRecord) =>
            opts.mode === "451"
              ? { stopReason: "error" as const, errorMessage: "System One API error (451): blocked" }
              : { stopReason: "stop" as const, answers: onceAnswers(call) },
        ],
      ]),
    ),
  });
  const ctx = {
    cwd,
    hasUI: false,
    modelRegistry: fake.registry,
    sessionManager: { getBranch: () => branch, getSessionId: () => "g-1" },
  };
  let id = 0;
  const toolCall = (command: string, toolCallId = `call_${++id}`): unknown =>
    handlers.get("tool_call")![0]!({ type: "tool_call", toolName: "bash", toolCallId, input: { command } }, ctx);
  const emit = async (event: string, payload: unknown) => {
    for (const h of handlers.get(event) ?? []) await h(payload, ctx);
  };
  return { handlers, sent, jobs, fake, toolCall, emit };
}

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const job = (status = "running"): BashJobRecordLike => ({
  jobId: "job_9",
  status,
  command: "bash scripts/release/release.sh 0.10.3",
  createdAt: Date.now(),
});

describe("arch §9.2 partial/inactive boundaries (production assembly)", () => {
  test("1. inactive: no credentials, coverage 0, no inline gate*/tags= ⇒ zero sendMessage, zero block", async () => {
    writeFileSync(join(memDir, "pitfalls.md"), "# P\n\n## Commit\n\n- 提交前先跑 typecheck 再 git commit\n");
    const p = production({ mode: "no-auth" });
    await p.emit("session_start", { type: "session_start", reason: "startup" });
    await settle();
    expect(p.toolCall("git add -A && git commit -m x")).toBeUndefined();
    expect(p.toolCall("git push --force")).toBeUndefined();
    expect(p.sent).toHaveLength(0);
    expect(p.fake.calls).toHaveLength(0);
  });

  test("2+3. partial with inline metadata ⇒ evidence tier only, and not a single Jev call after the probe", async () => {
    writeFileSync(join(memDir, "pitfalls.md"), HOLD_RULE);
    const p = production({ mode: "451" });
    await p.emit("session_start", { type: "session_start", reason: "startup" });
    await settle();
    const afterProbe = p.fake.calls.length;

    // nothing named is running ⇒ pass + unjudged bodies (once per segment)
    expect(await p.toolCall("git commit -m x")).toBeUndefined();
    const unjudged = p.sent.filter((m) => m.details?.layer === "G");
    expect(unjudged).toHaveLength(1);
    expect(unjudged[0]!.content.startsWith("[memory · G unjudged]")).toBe(true);
    expect(unjudged[0]!.details.partial).toBe(true);

    // gate=hold + the named program running ⇒ blocked on evidence
    p.jobs.push(job());
    const r = (await p.toolCall("git commit -m x")) as any;
    expect(r?.block).toBe(true);
    expect(r.reason).toContain("Jev 未判定（partial），按证据拦截");
    expect(r.reason).toContain("job_9");
    // plain `gate` (not hold) never blocks in partial
    writeFileSync(
      join(memDir, "pitfalls.md"),
      "# P\n\n## Commit\n\n- 提交前先跑 `npm run typecheck` <!-- mem user gate -->\n",
    );
    await settle(2_100); // corpus cache (2s)
    expect(await p.toolCall("git commit -m y")).toBeUndefined();

    expect(p.fake.calls.length).toBe(afterProbe);
  });
});

describe("child sessions and nested tool calls", () => {
  test("child: gate runs (Jev judged, session child), bash jobs never feed child evidence", async () => {
    writeFileSync(join(memDir, "pitfalls.md"), HOLD_RULE);
    const p = production({ mode: "ok", child: true });
    p.jobs.push(job()); // attached, but a child session ignores the port
    const r = (await p.toolCall("git commit -m x")) as any;
    expect(r?.block).toBe(true);
    expect(r.reason).toContain("[memory gate]");
    const gate = p.fake.calls.find((c) => Object.keys(c.questions).some((k) => /^g\d+$/.test(k)))!;
    expect(gate.state["session"]).toBe("child");
    expect(gate.state["running"]).toEqual([]);
  });

  test("nested executeTool id `<parent>/1` (C-J11) is gated like a top-level call", async () => {
    writeFileSync(join(memDir, "pitfalls.md"), HOLD_RULE);
    const p = production({ mode: "ok" });
    const r = (await p.toolCall("git commit -m nested", "call_7/1")) as any;
    expect(r?.block).toBe(true);
  });
});

// J6 residual re-checked for J7 core item 2: a bash-job notice STEERED into a
// streaming run (sendMessage triggerTurn:true while streaming — the path
// notify() takes) DOES emit `message_start` with its customType before the
// next LLM request (pi-agent-core agent-loop emits message_start for every
// steering message). wire.ts's existing `message_start` handler therefore
// already feeds the E layer on that path — no bashJobs-port polling needed.
describe("C-J6 steer path re-check (real AgentSession)", () => {
  test("a steered bash-job notification emits message_start (customType) inside the same run", async () => {
    const starts: string[] = [];
    const model = fakeModel();
    const bashTurn: ScriptedTurn = {
      toolCall: true,
      build: () => {
        const msg = assistantTextMsg(model, "x") as unknown as Record<string, unknown>;
        msg.content = [{ type: "toolCall", id: "s1", name: "bash", arguments: { command: "echo hi" } }];
        msg.stopReason = "toolUse";
        return msg;
      },
    };
    let sentOnce = false;
    await withSession(
      {
        scripted: [bashTurn, { toolCall: false, build: () => assistantTextMsg(model, "done") }],
        extensionFactories: [
          (pi: ExtensionAPI) => {
            pi.on("tool_call", (() => {
              if (!sentOnce) {
                sentOnce = true;
                pi.sendMessage(
                  {
                    customType: "bash-job:notification",
                    content: [{ type: "text", text: "bash job job_1 ($ npm test) finished: failed" }],
                    display: true,
                    details: { jobId: "job_1", status: "failed", exitCode: 1 },
                  },
                  { triggerTurn: true },
                );
              }
              return undefined;
            }) as never);
            pi.on("message_start", ((e: { message: { customType?: string; role: string } }) => {
              starts.push(e.message.customType ?? e.message.role);
            }) as never);
          },
        ],
      },
      async ({ session }) => {
        await session.prompt("go");
      },
    );
    const idx = starts.indexOf("bash-job:notification");
    expect(idx).toBeGreaterThan(starts.indexOf("toolResult"));
    expect(starts.slice(idx + 1)).toContain("assistant"); // same run continued after it
  });
});
