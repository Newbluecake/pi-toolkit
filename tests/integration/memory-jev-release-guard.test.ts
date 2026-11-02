// jev-plan §4 J7 acceptance — the release.sh scenario (jev-arch §16.4)
// through the PRODUCTION assembly: `wireMemory` (real hub, real wireJev,
// real probes with the real git runner and — on Linux — the real /proc
// scan) + the late-bound bashJobs port exactly as `src/index.ts` attaches it
// (`jevBashJobsFrom`). Only the classifier registry is scripted.
//
//   background `bash scripts/release/release.sh 0.10.3` running ⇒
//   `git add -A && git commit` held · retry hits the verdict cache (no Jev
//   call, no second body) · `git -C . commit` held · `echo "git commit"` /
//   `grep "git push" README.md` pass at the coarse filter (zero await, zero
//   Jev) · job completion notice ⇒ the next commit is re-judged and passes ·
//   Jev-timeout variant still holds on evidence · the job command line's
//   token is masked before it reaches Jev (D7 ①).

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

type Handler = (event: unknown, ctx: unknown) => unknown;
const TOKEN = "ghp_0123456789abcdefghijABCDEFGHIJklmnopqrst";

let envTmp: string;
let cwd: string;
let memDir: string;

beforeEach(() => {
  clearHealthTable();
  envTmp = mkdtempSync(join(tmpdir(), "jev-int-release-"));
  vi.stubEnv("HOME", join(envTmp, "nohome"));
  vi.stubEnv("ARMORY_MEMORY_ROOT", join(envTmp, "root"));
  cwd = join(envTmp, "proj");
  mkdirSync(cwd, { recursive: true });
  memDir = memoryDirFor(cwd);
  mkdirSync(memDir, { recursive: true });
  writeFileSync(join(memDir, "core.md"), "# Core\n\n## Rules\n\n- always wrap long commands with timeout\n");
  writeFileSync(
    join(memDir, "pitfalls.md"),
    [
      "# Pitfalls",
      "",
      "## 发版进行中禁止动 git 状态",
      "",
      "<!-- mem user gate=hold -->",
      "",
      "- release.sh 运行期间（含后台任务、其它终端）禁止 commit/tag/切分支",
      "",
    ].join("\n"),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(envTmp, { recursive: true, force: true });
  clearHealthTable();
});

/** Jev: violates_now 0.86 while state.running is non-empty; afterwards
 *  "applies" only (0.8 / 0.05). `hang` ⇒ never answers. */
function gateAnswers(call: ClassifyCallRecord): Record<string, never> {
  const out: Record<string, unknown> = {};
  const running = (call.state["running"] as string[] | undefined) ?? [];
  for (const [id, q] of Object.entries(call.questions) as [string, JevQuestion][]) {
    if (q.type !== "choice") continue;
    const [a, v] = running.length > 0 ? [0.1, 0.86] : [0.8, 0.05];
    const choice = v > a ? "violates_now" : "applies";
    out[id] = {
      type: "choice",
      choice,
      probabilities: { unrelated: 1 - a - v, applies: a, violates_now: v },
      confidence: Math.max(a, v),
    };
  }
  return out as Record<string, never>;
}

function production(mode: "ok" | "hang") {
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
    isChildSession: false,
    sections: hub,
    secureDomainKind: "plain",
    // Empty /proc: host processes (e.g. a release.sh running this suite) must not leak into evidence.
    jevProcRoot: join(envTmp, "empty-proc"),
  });
  const jobs: BashJobRecordLike[] = [];
  // Exactly the src/index.ts post-guard call shape.
  wiring.attachJevBashJobs(jevBashJobsFrom(() => jobs));
  const fake = createFakeRegistry({
    available: DEFAULT_SETTINGS.memory.jev.classifiers,
    responses: Object.fromEntries(
      DEFAULT_SETTINGS.memory.jev.classifiers.map((id) => [
        id,
        [
          (call: ClassifyCallRecord) =>
            mode === "hang"
              ? new Promise<never>(() => {})
              : { stopReason: "stop" as const, answers: gateAnswers(call) },
        ],
      ]),
    ),
  });
  const ctx = {
    cwd,
    hasUI: true,
    ui: { notify: () => {} },
    modelRegistry: fake.registry,
    sessionManager: { getBranch: () => branch, getSessionId: () => "rel-1" },
  };
  let id = 0;
  const toolCall = (command: string): unknown =>
    handlers.get("tool_call")![0]!(
      { type: "tool_call", toolName: "bash", toolCallId: `call_${++id}`, input: { command } },
      ctx,
    );
  const emit = async (event: string, payload: unknown) => {
    for (const h of handlers.get(event) ?? []) await h(payload, ctx);
  };
  const gateCalls = () => fake.calls.filter((c) => Object.keys(c.questions).some((k) => /^g\d+$/.test(k)));
  const bodies = () => sent.filter((m) => m.details?.layer === "G");
  return { handlers, sent, jobs, fake, toolCall, emit, gateCalls, bodies };
}

const releaseJob = (): BashJobRecordLike => ({
  jobId: "job_42",
  status: "running",
  command: `GH_TOKEN=${TOKEN} bash scripts/release/release.sh 0.10.3`,
  createdAt: Date.now() - 3 * 60_000 - 5_000,
  spawnedAt: Date.now() - 3 * 60_000,
});

describe("release.sh background job vs git commit (jev-arch §16.4)", () => {
  test("hold → cached retry → `git -C . commit` held → echo/grep pass → completion ⇒ re-judged and allowed", async () => {
    const p = production("ok");
    p.jobs.push(releaseJob());

    // 1. held by Jev (violates_now 0.86), evidence = the background job.
    const r1 = (await p.toolCall("git add -A && git commit -m 'fix: hud width'")) as any;
    expect(r1?.block).toBe(true);
    expect(r1.reason).toContain(
      "[memory gate·hold] 本次 bash 调用未执行：规则「pitfalls.md › 发版进行中禁止动 git 状态」（用户令）的条件仍成立（violates_now 0.86；证据：job_42 (3m) ",
    );
    expect(r1.reason).toContain("bash scripts/release/release.sh 0.10.3");
    expect(p.gateCalls()).toHaveLength(1);
    const state = p.gateCalls()[0]!.state;
    expect(state["programs"]).toEqual(["git add", "git commit"]);
    expect(state["session"]).toBe("main");
    // D7 ①: the token in the job command line never reaches Jev.
    expect(JSON.stringify(p.fake.calls)).not.toContain(TOKEN);
    expect(r1.reason).not.toContain(TOKEN);
    expect(p.bodies()).toHaveLength(1);

    // 2. retry with unchanged evidence: cache hit — no Jev call, no new body.
    await p.emit("turn_end", { type: "turn_end" });
    const r2 = (await p.toolCall("git add -A && git commit -m 'fix: hud width'")) as any;
    expect(r2?.block).toBe(true);
    expect(p.gateCalls()).toHaveLength(1);
    expect(p.bodies()).toHaveLength(1);

    // 3. `git -C . commit` is a real commit (shell-parse strips -C).
    const r3 = (await p.toolCall("git -C . commit -m x")) as any;
    expect(r3?.block).toBe(true);

    // 4. text that merely mentions git: coarse filter, synchronous, no Jev.
    const before = p.fake.calls.length;
    expect(p.toolCall('echo "git commit"')).toBeUndefined();
    expect(p.toolCall('grep "git push" README.md')).toBeUndefined();
    expect(p.fake.calls.length).toBe(before);

    // 5. the job finishes; its notification arrives; the next commit is re-judged.
    p.jobs[0] = { ...p.jobs[0]!, status: "completed" };
    await p.emit("message_start", {
      type: "message_start",
      message: {
        role: "custom",
        customType: "bash-job:notification",
        content: [{ type: "text", text: "bash job job_42 ($ bash scripts/release/release.sh 0.10.3) finished" }],
        details: { jobId: "job_42", status: "completed", exitCode: 0 },
      },
    });
    await p.emit("turn_end", { type: "turn_end" });
    const r4 = await p.toolCall("git add -A && git commit -m 'fix: hud width'");
    expect(r4).toBeUndefined();
    expect(p.gateCalls().length).toBeGreaterThan(2);
    expect(p.gateCalls().at(-1)!.state["running"]).toEqual([]);
  });

  test("Jev timeout version: still held on evidence (gate=hold + named program running), within the 2.5s cap", async () => {
    const p = production("hang");
    p.jobs.push(releaseJob());
    const t0 = Date.now();
    const r = (await p.toolCall("git add -A && git commit -m x")) as any;
    const waited = Date.now() - t0;
    expect(r?.block).toBe(true);
    expect(r.reason).toContain("Jev 未判定（timeout），按证据拦截");
    expect(r.reason).toContain("job_42");
    expect(r.reason).not.toContain(TOKEN);
    expect(waited).toBeLessThan(2_500 + 400);
  });
});
