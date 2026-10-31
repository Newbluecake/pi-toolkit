// jev-plan §4 J7 wire-gate: the tool_call gate driven through `wireJev` with
// a fake pi, a scripted classifier registry, a fake /proc tree and a fake
// git runner — coarse filter (five steps, zero await), Jev judgment tier,
// evidence tier, verdict cache, latch, multi-entry strictest, nogate,
// static core, Promise-chain serialization, handler-throw ⇒ allow, and the
// ≤2500ms sync wait (fake clock).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GitRunner } from "../../../src/git/run.js";
import { jevConfigOf } from "../../../src/memory/jev/config.js";
import type { EntryTags, JevConfig, JevQuestion, JevRenderInfo, MemEntry } from "../../../src/memory/jev/contracts.js";
import { EntryIndex } from "../../../src/memory/jev/entries.js";
import { clearHealthTable } from "../../../src/memory/jev/health.js";
import { writeIndexPatch } from "../../../src/memory/jev/index-store.js";
import type { ProbeFs } from "../../../src/memory/jev/probes.js";
import { GATE_WAIT_MS, wireJev, type WireJevDeps } from "../../../src/memory/jev/wire.js";
import { DEFAULT_MEMORY_SETTINGS, type MemorySettings } from "../../../src/memory/settings.js";
import { createFakeRegistry, type ClassifyCallRecord } from "./helpers/fake-registry.js";

type Handler = (event: unknown, ctx: unknown) => unknown;
const CLASSIFIERS = ["opencode/jev-1.13-free", "opencode/jev-1.13"];
const UID = 4242;

let tmp: string;
let memDir: string;

const PITFALLS = [
  "# Pitfalls",
  "",
  "## 发版进行中禁止动 git 状态",
  "",
  "<!-- mem user gate=hold -->",
  "",
  "- release.sh 运行期间（含后台任务、其它终端）禁止 commit/tag/切分支",
  "",
  "## Commit",
  "",
  "- 提交前先跑 `npm run typecheck` 再提交 <!-- mem user gate -->",
  "- 永远不要用 git add -A 提交，只提交精确路径 <!-- mem nogate -->",
  "",
].join("\n");

beforeEach(() => {
  clearHealthTable();
  tmp = mkdtempSync(join(tmpdir(), "jev-wire-gate-"));
  memDir = join(tmp, "mem");
  mkdirSync(memDir, { recursive: true });
  writeFileSync(join(memDir, "core.md"), "# Core\n\n## Rules\n\n- always wrap long commands with timeout\n");
  writeFileSync(join(memDir, "pitfalls.md"), PITFALLS);
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(tmp, { recursive: true, force: true });
  clearHealthTable();
});

function entries(): readonly MemEntry[] {
  return new EntryIndex().get(memDir);
}
function entryWith(text: string): MemEntry {
  const e = entries().find((x) => x.body.includes(text));
  if (e === undefined) throw new Error(`no entry containing ${text}`);
  return e;
}
async function tagEntry(e: MemEntry, tags: Record<string, number>, extra: Partial<EntryTags> = {}): Promise<void> {
  const rec: EntryTags = {
    file: e.file,
    type: "rule",
    typeP: 0.9,
    importance: 3,
    tags: Object.fromEntries(Object.entries(tags).map(([k, p]) => [k, { p, rev: 1 }])),
    guard: 0.9,
    temporal: "permanent",
    userLike: 0.9,
    model: "opencode/jev-1.13",
    at: "2026-10-30T00:00:00.000Z",
    taxonomyRev: "x",
    ...extra,
  };
  expect(await writeIndexPatch(memDir, { upsert: { [e.hash]: rec } })).toBe("ok");
}

/** Gate verdict per question: `(instructions, state) => [applies, violates_now]`. */
type Verdict = (instructions: string, state: Record<string, unknown>) => readonly [number, number];
function gateAnswers(call: ClassifyCallRecord, verdict: Verdict): Record<string, never> {
  const out: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(call.questions) as [string, JevQuestion][]) {
    if (q.type === "choice" && "violates_now" in q.criteria) {
      const [a, v] = verdict(q.instructions, call.state as Record<string, unknown>);
      const u = Math.max(0, 1 - a - v);
      const choice = v >= a && v >= u ? "violates_now" : a >= u ? "applies" : "unrelated";
      out[id] = {
        type: "choice",
        choice,
        probabilities: { unrelated: u, applies: a, violates_now: v },
        confidence: Math.max(a, v, u),
      };
    }
  }
  return out as Record<string, never>;
}

const HOLD_VERDICT: Verdict = (ins, state) =>
  ins.includes("release.sh")
    ? (state["running"] as string[]).length > 0
      ? [0.1, 0.86]
      : [0.05, 0.02]
    : ins.includes("typecheck")
      ? [0.83, 0.05]
      : [0.9, 0.9];

interface Opts {
  verdict?: Verdict;
  mode?: "ok" | "fail" | "hang" | "hang-forever";
  config?: Partial<JevConfig>;
  isChild?: boolean;
  renderInfo?: JevRenderInfo;
  proc?: Record<string, string>;
  platform?: NodeJS.Platform;
  deps?: Partial<WireJevDeps>;
  /** `deps.procRoot` getter throws — read only after the first await. */
  lateThrow?: boolean;
}

function fakeProcFs(files: Record<string, string>): ProbeFs {
  return {
    listDir: (path) => {
      const prefix = `${path}/`;
      const names = new Set<string>();
      for (const p of Object.keys(files)) if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split("/")[0]!);
      return [...names];
    },
    readHead: (path, max) => files[path]?.slice(0, max),
  };
}
const procRelease = (): Record<string, string> => ({
  "/proc/777/status": `Uid:\t${UID}\t${UID}\t${UID}\t${UID}\n`,
  "/proc/777/cmdline": "bash\u0000scripts/release/release.sh\u00000.10.3\u0000",
});

function harness(opts: Opts = {}) {
  const handlers = new Map<string, Handler[]>();
  const sent: any[] = [];
  const appended: any[] = [];
  const branch: any[] = [];
  const logs: string[] = [];
  let n = 0;
  const pi = {
    on: (event: string, h: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), h]);
    },
    sendMessage: (message: any, options: unknown) => {
      sent.push({ message, options });
      branch.push({ type: "custom_message", id: `m${n++}`, ...message });
    },
    appendEntry: (customType: string, data: unknown) => {
      appended.push({ customType, data });
      branch.push({ type: "custom", id: `c${n++}`, customType, data });
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
            if (opts.mode === "fail")
              return { stopReason: "error" as const, errorMessage: "System One API error (451): blocked" };
            if (opts.mode === "hang-forever") return new Promise<never>(() => {});
            if (opts.mode === "hang") {
              await new Promise<void>((resolve) => {
                if (call.signal?.aborted === true) resolve();
                call.signal?.addEventListener("abort", () => resolve());
              });
              return { stopReason: "aborted" as const };
            }
            return { stopReason: "stop" as const, answers: gateAnswers(call, opts.verdict ?? HOLD_VERDICT) };
          },
        ],
      ]),
    ),
  });
  const settings: MemorySettings = { ...DEFAULT_MEMORY_SETTINGS };
  const config: JevConfig = { ...jevConfigOf(settings), classifiers: CLASSIFIERS, ...opts.config };
  const gitCalls: string[][] = [];
  const git: GitRunner = async (args) => {
    gitCalls.push([...args]);
    return { code: 128, stdout: "", stdoutCapped: false, stderr: "not a repo" };
  };
  const proc = { files: opts.proc ?? {} };
  const wireDeps: WireJevDeps = {
    config,
    settings,
    isChildSession: opts.isChild === true,
    dirFor: () => memDir,
    getRenderInfo: () => opts.renderInfo,
    onAfterWriteHook: () => {},
    log: (l) => logs.push(l),
    platform: opts.platform ?? "linux",
    git,
    uid: UID,
    probeFs: {
      listDir: (p) => fakeProcFs(proc.files).listDir(p),
      readHead: (p, m) => fakeProcFs(proc.files).readHead(p, m),
    },
    ...opts.deps,
  };
  if (opts.lateThrow === true) {
    Object.defineProperty(wireDeps, "procRoot", {
      get: () => {
        throw new Error("late explosion");
      },
    });
  }
  const wire = wireJev(pi, wireDeps);
  const ctx = {
    cwd: tmp,
    hasUI: true,
    ui: { notify: () => {} },
    modelRegistry: fake.registry,
    sessionManager: { getBranch: () => branch, getSessionId: () => "s1" },
  };
  let callN = 0;
  /** Raw handler return — sync `undefined` or a Promise. */
  const callRaw = (command: string, tool = "bash", input?: Record<string, unknown>, id?: string): unknown =>
    handlers.get("tool_call")![0]!(
      { type: "tool_call", toolName: tool, toolCallId: id ?? `t${++callN}`, input: input ?? { command } },
      ctx,
    );
  const call = async (command: string, tool = "bash", input?: Record<string, unknown>) =>
    (await callRaw(command, tool, input)) as { block?: boolean; reason?: string } | undefined;
  const emit = async (event: string, payload: unknown) => {
    for (const h of handlers.get(event) ?? []) await h(payload, ctx);
  };
  const turnEnd = () => emit("turn_end", { type: "turn_end" });
  const gateCalls = () => fake.calls.filter((c) => Object.keys(c.questions).some((k) => /^g\d+$/.test(k)));
  const gMessages = () => sent.filter((s) => s.message.details?.layer === "G");
  return {
    handlers,
    sent,
    appended,
    branch,
    logs,
    fake,
    wire,
    ctx,
    callRaw,
    call,
    emit,
    turnEnd,
    gateCalls,
    gMessages,
    gitCalls,
    proc,
  };
}

// ───────────────────────────── coarse filter (§6.4.1) ─────────────────────────────

describe("coarse filter — five steps, all synchronous (zero await)", () => {
  test("misinterception shapes: echo/grep text containing `git commit`/`git push` never reaches the gate", async () => {
    const h = harness({ proc: procRelease() });
    for (const cmd of ['echo "git commit"', 'grep "git push" README.md', "ls -la", 'printf "%s" "git tag v1"']) {
      expect(h.callRaw(cmd)).toBeUndefined(); // not a Promise ⇒ no await at all
    }
    expect(h.fake.calls).toHaveLength(0);
    expect(h.gitCalls).toHaveLength(0);
  });

  test("step 1: gate disabled / off(pi-api) ⇒ sync pass", () => {
    const off = harness({ config: { gate: { enabled: false, threshold: 0.6 } } });
    expect(off.callRaw("git commit -m x")).toBeUndefined();
    const noApi = harness();
    const r = noApi.handlers.get("tool_call")![0]!(
      { type: "tool_call", toolName: "bash", toolCallId: "x", input: { command: "git commit -m x" } },
      { ...noApi.ctx, modelRegistry: undefined },
    );
    expect(r).toBeUndefined();
    expect(off.fake.calls.length + noApi.fake.calls.length).toBe(0);
  });

  test("step 2: read-only tools (read/grep/find/ls/web_search/get_run_result/todo*/Task*, memory view|search) ⇒ sync pass", () => {
    const h = harness();
    for (const tool of ["read", "grep", "find", "ls", "web_search", "get_run_result", "todo_write", "TaskUpdate"]) {
      expect(h.callRaw("", tool, { command: "git commit -m x", path: "tests/fixtures/a.json" })).toBeUndefined();
    }
    expect(h.callRaw("", "memory", { command: "view", path: "pitfalls.md" })).toBeUndefined();
    expect(h.fake.calls).toHaveLength(0);
  });

  test("step 3: no high-risk matcher hit (`npm test` hits only the normal `testing` tag) ⇒ sync pass", () => {
    const h = harness();
    expect(h.callRaw("npm test")).toBeUndefined();
    expect(h.callRaw("git status")).toBeUndefined();
  });

  test("step 4: no guarding entry ⇒ sync pass", () => {
    writeFileSync(join(memDir, "pitfalls.md"), "# P\n\n## X\n\n- an ordinary note about commits\n");
    const h = harness();
    expect(h.callRaw("git commit -m x")).toBeUndefined();
  });

  test("step 5: an entry latched this segment (non-hold) ⇒ sync pass after the turn advanced", async () => {
    writeFileSync(
      join(memDir, "pitfalls.md"),
      "# P\n\n## Commit\n\n- 提交前先跑 `npm run typecheck` 再提交 <!-- mem user gate -->\n",
    );
    const h = harness();
    const first = await h.call("git commit -m x");
    expect(first?.block).toBe(true);
    await h.turnEnd();
    expect(h.callRaw("git commit -m x")).toBeUndefined();
  });
});

// ───────────────────────────── Jev judgment tier (§6.4.4) ─────────────────────────────

describe("Jev judgment tier", () => {
  test("a+v < threshold ⇒ pass (one Jev call, nothing injected)", async () => {
    writeFileSync(
      join(memDir, "pitfalls.md"),
      "# P\n\n## Commit\n\n- 提交前先跑 `npm run typecheck` 再提交 <!-- mem user gate -->\n",
    );
    const h = harness({ verdict: () => [0.2, 0.1] });
    expect(await h.call("git commit -m x")).toBeUndefined();
    expect(h.gateCalls()).toHaveLength(1);
    expect(h.gMessages()).toHaveLength(0);
  });

  test("hold ∧ v ≥ threshold ⇒ hold block; body injected once; retries hit the cache (no Jev call, no re-inject)", async () => {
    const h = harness({ proc: procRelease() });
    const r1 = await h.call("git add -A && git commit -m 'fix: x'");
    expect(r1?.block).toBe(true);
    expect(r1?.reason).toContain(
      "[memory gate·hold] 本次 bash 调用未执行：规则「pitfalls.md › 发版进行中禁止动 git 状态」（用户令）的条件仍成立（violates_now 0.86；证据：pid 777 bash scripts/release/release.sh 0.10.3）",
    );
    expect(h.gateCalls()).toHaveLength(1);
    const state = h.gateCalls()[0]!.state as Record<string, unknown>;
    expect(state).toMatchObject({ tool: "bash", programs: ["git add", "git commit"], session: "main" });
    expect(state["running"]).toEqual(["pid 777 bash scripts/release/release.sh 0.10.3"]);
    expect(h.gMessages()).toHaveLength(1);
    expect(h.gMessages()[0]!.message.content).toContain("release.sh 运行期间");
    expect(h.gMessages()[0]!.options).toEqual({ triggerTurn: false });
    const rec = h.appended.find((a) => a.data.layer === "G");
    expect(rec?.data.gates?.length).toBeGreaterThan(0);
    for (let i = 0; i < 3; i++) {
      await h.turnEnd();
      const again = await h.call("git add -A && git commit -m 'fix: x'");
      expect(again?.block).toBe(true);
      expect(again?.reason).toContain("gate·hold");
    }
    expect(h.gateCalls()).toHaveLength(1);
    expect(h.gMessages()).toHaveLength(1);
  });

  test("once: blocks, the latch takes effect only after turnSeq advances; static-core entry not re-injected, reason cites its title", async () => {
    writeFileSync(
      join(memDir, "pitfalls.md"),
      "# P\n\n## Commit\n\n- 提交前先跑 `npm run typecheck` 再提交 <!-- mem user gate -->\n",
    );
    const h = harness({ renderInfo: { primary: "pitfalls.md", omittedSections: [], coreInlined: true } });
    const r1 = await h.call("git commit -m x");
    expect(r1?.reason).toContain(
      "[memory gate] 本次 bash 调用未执行：Jev 判定它属于记忆规则「pitfalls.md › Commit」（用户令，applies 0.83）的管辖范围",
    );
    expect(h.gMessages()).toHaveLength(0); // static core: already in the system prompt
    const r2 = await h.call("git commit -m y"); // same turn ⇒ still not latched
    expect(r2?.block).toBe(true);
    expect(h.gateCalls()).toHaveLength(1); // cache: same entry/evidence/shape
    await h.turnEnd();
    expect(await h.call("git commit -m z")).toBeUndefined();
  });

  test("same batch: two identical concurrent calls are both blocked, one Jev call, body injected once (Promise-chain lock)", async () => {
    writeFileSync(
      join(memDir, "pitfalls.md"),
      "# P\n\n## Commit\n\n- 提交前先跑 `npm run typecheck` 再提交 <!-- mem user gate -->\n",
    );
    const h = harness();
    const p1 = h.callRaw("git commit -m x") as Promise<any>;
    const p2 = h.callRaw("git commit -m x") as Promise<any>;
    expect(p1).toBeInstanceOf(Promise);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1?.block).toBe(true);
    expect(r2?.block).toBe(true);
    expect(h.gateCalls()).toHaveLength(1);
    expect(h.gMessages()).toHaveLength(1);
  });

  test("latched hold entry: once the condition is gone (Jev a≥thr, v<thr) the 4th row passes", async () => {
    const h = harness({
      proc: procRelease(),
      verdict: (ins, st) => ((st["running"] as string[]).length > 0 ? [0.1, 0.9] : [0.8, 0.05]),
    });
    writeFileSync(join(memDir, "pitfalls.md"), PITFALLS.split("## Commit")[0]!);
    expect((await h.call("git commit -m x"))?.block).toBe(true);
    h.proc.files = {}; // release.sh exited
    await h.emit("message_start", {
      type: "message_start",
      message: {
        role: "custom",
        customType: "bash-job:notification",
        content: "done",
        details: { status: "completed", exitCode: 0 },
      },
    });
    await h.turnEnd();
    expect(await h.call("git commit -m x")).toBeUndefined();
    expect(h.gateCalls()).toHaveLength(2); // evidence changed ⇒ re-judged
  });

  test("multiple guarding entries ⇒ strictest (hold > once), reason lists the others", async () => {
    const h = harness({ proc: procRelease() });
    const r = await h.call("git commit -m x");
    expect(r?.reason).toContain("gate·hold");
    expect(r?.reason).toContain("同时命中：「pitfalls.md › Commit」");
    expect(
      h
        .gMessages()[0]!
        .message.details.items.map((i: any) => i.anchor)
        .sort(),
    ).toEqual(["pitfalls › Commit #1", "pitfalls › 发版进行中禁止动 git 状态 #1"].sort());
  });

  test("nogate never gates even when Jev would say violates_now; inline gate* is a candidate for ANY high-risk hit", async () => {
    writeFileSync(
      join(memDir, "pitfalls.md"),
      "# P\n\n## A\n\n- 永远不要用 git add -A 提交 <!-- mem nogate -->\n\n## B\n\n- 推送前先确认 CI 绿 <!-- mem user gate -->\n",
    );
    await tagEntry(entryWith("git add -A"), { "git-commit": 0.95 });
    const h = harness({ verdict: (ins) => (ins.includes("git add") ? [0.9, 0.9] : [0.7, 0.1]) });
    const r = await h.call("git push origin dev"); // `B` has no tags at all
    expect(r?.reason).toContain("「pitfalls.md › B」");
    expect(r?.reason).not.toContain("› A");
    await h.turnEnd();
    expect(h.callRaw("git add -A && git commit -m x")).toBeUndefined(); // B latched, A nogate
  });

  test("sidecar-guarded entry (guard ≥0.7, type rule) gates only on a shared high-risk tag", async () => {
    writeFileSync(join(memDir, "pitfalls.md"), "# P\n\n## Push\n\n- push only after the CI pipeline is green\n");
    await tagEntry(entryWith("CI pipeline"), { "git-push": 0.9 });
    const h = harness({ verdict: () => [0.8, 0.1] });
    expect(h.callRaw("git commit -m x")).toBeUndefined();
    expect((await h.call("git push"))?.block).toBe(true);
  });

  test("verdict cache is cleared on compaction", async () => {
    writeFileSync(
      join(memDir, "pitfalls.md"),
      "# P\n\n## Commit\n\n- 提交前先跑 `npm run typecheck` 再提交 <!-- mem user gate -->\n",
    );
    const h = harness({ verdict: () => [0.2, 0.1] });
    await h.call("git commit -m x");
    await h.call("git commit -m x");
    expect(h.gateCalls()).toHaveLength(1);
    await h.emit("session_compact", { type: "session_compact", compactionEntry: { id: "cmp1" } });
    await h.call("git commit -m x");
    expect(h.gateCalls()).toHaveLength(2);
  });
});

// ───────────────────────────── evidence tier (§6.4.5, Q29/Q33) ─────────────────────────────

describe("evidence tier", () => {
  test("Jev error + gate=hold + named program running ⇒ block「Jev 未判定，按证据拦截」, body once", async () => {
    const h = harness({ mode: "fail", proc: procRelease() });
    writeFileSync(join(memDir, "pitfalls.md"), PITFALLS.split("## Commit")[0]!);
    const r = await h.call("git commit -m x");
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain("[memory gate·hold] 本次 bash 调用未执行：Jev 未判定（");
    expect(r?.reason).toContain(
      "按证据拦截——规则「pitfalls.md › 发版进行中禁止动 git 状态」（用户令，gate=hold）点名的程序正在运行：pid 777 bash scripts/release/release.sh 0.10.3",
    );
    await h.turnEnd();
    expect((await h.call("git commit -m x"))?.block).toBe(true);
    expect(h.gMessages()).toHaveLength(1);
  });

  test("Jev error, nothing running / non-hold ⇒ pass + `[memory · G unjudged]` once per segment per entry", async () => {
    const h = harness({ mode: "fail" });
    expect(await h.call("git commit -m x")).toBeUndefined();
    const unjudged = h.gMessages();
    expect(unjudged).toHaveLength(1);
    expect(unjudged[0]!.message.content.startsWith("[memory · G unjudged] Jev 未能判定，以下规则请自行核对")).toBe(
      true,
    );
    expect(unjudged[0]!.message.content).toContain("release.sh 运行期间");
    expect(unjudged[0]!.message.content).toContain("typecheck");
    expect(await h.call("git commit -m y")).toBeUndefined();
    expect(h.gMessages()).toHaveLength(1);
  });

  test("Jev answers missing for an entry ⇒ that entry falls to the evidence tier", async () => {
    const h = harness({ proc: procRelease(), verdict: () => [0, 0] });
    (h.fake.registry as any).classify = async () => ({
      stopReason: "stop",
      answers: {},
      provider: "opencode",
      model: "jev-1.13-free",
    });
    const r = await h.call("git commit -m x");
    expect(r?.reason).toContain("Jev 未判定（missing）");
  });

  test("non-Linux: /proc is never consulted — only this session's bash jobs count", async () => {
    const h = harness({ mode: "fail", platform: "darwin", proc: procRelease() });
    writeFileSync(join(memDir, "pitfalls.md"), PITFALLS.split("## Commit")[0]!);
    expect(await h.call("git commit -m x")).toBeUndefined();
    h.wire.attachBashJobs({
      list: () => [
        {
          id: "job_42",
          status: "running",
          command: "bash scripts/release/release.sh 0.10.3",
          startedAt: Date.now() - 180_000,
        },
      ],
    });
    const r = await h.call("git commit -m x");
    expect(r?.reason).toContain("job_42 (3m) bash scripts/release/release.sh 0.10.3");
  });

  test("a bash-job notification clears the 2s /proc cache", async () => {
    const h = harness({ mode: "fail", proc: procRelease() });
    writeFileSync(join(memDir, "pitfalls.md"), PITFALLS.split("## Commit")[0]!);
    expect((await h.call("git commit -m x"))?.block).toBe(true);
    h.proc.files = {};
    expect((await h.call("git commit -m x"))?.block).toBe(true); // cached scan (<2s)
    await h.emit("message_start", {
      type: "message_start",
      message: { role: "custom", customType: "bash-job:notification", content: "x", details: {} },
    });
    expect(await h.call("git commit -m x")).toBeUndefined();
  });
});

// ───────────────────────────── robustness & timing ─────────────────────────────

describe("robustness", () => {
  test("a throw before the first await (sync) or after it (async) always ALLOWS the call and is logged", async () => {
    const sync = harness({
      deps: {
        getRenderInfo: () => {
          throw new Error("render info exploded");
        },
      },
    });
    expect(sync.callRaw("git commit -m x")).toBeUndefined();
    expect(sync.logs.some((l) => l.includes("tool_call failed"))).toBe(true);

    const late = harness({ lateThrow: true });
    const p = late.callRaw("git commit -m x");
    expect(p).toBeInstanceOf(Promise);
    expect(await p).toBeUndefined();
    expect(late.logs.some((l) => l.includes("gate failed (allowed)"))).toBe(true);
  });

  test("sync wait is capped at 2500ms (fake clock): a Jev that never settles falls to the evidence tier at the cap", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    for (const mode of ["hang", "hang-forever"] as const) {
      const h = harness({ mode, proc: procRelease() });
      writeFileSync(join(memDir, "pitfalls.md"), PITFALLS.split("## Commit")[0]!);
      let settled: any = "pending";
      void (h.callRaw("git commit -m x") as Promise<any>).then((r) => {
        settled = r;
      });
      let at = 0;
      while (settled === "pending" && at < 10_000) {
        await vi.advanceTimersByTimeAsync(10);
        at += 10;
      }
      expect(at).toBeLessThanOrEqual(GATE_WAIT_MS);
      if (mode === "hang-forever") expect(at).toBeGreaterThanOrEqual(GATE_WAIT_MS - 20); // only our cap fired
      expect(settled?.block).toBe(true);
      expect(settled?.reason).toContain("Jev 未判定（timeout），按证据拦截");
    }
  });

  test("partial (Jev down) ⇒ zero Jev calls, evidence tier only; child session ⇒ no bash-job evidence", async () => {
    const h = harness({ mode: "fail", proc: procRelease() });
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    await new Promise((r) => setTimeout(r, 30));
    expect(h.wire.client.status().kind).toBe("partial");
    const before = h.fake.calls.length;
    writeFileSync(join(memDir, "pitfalls.md"), PITFALLS.split("## Commit")[0]!);
    const r = await h.call("git commit -m x");
    expect(r?.reason).toContain("Jev 未判定（partial）");
    expect(h.fake.calls.length).toBe(before);

    const child = harness({ isChild: true, mode: "fail", platform: "darwin" });
    child.wire.attachBashJobs({
      list: () => [{ id: "job_1", status: "running", command: "bash release.sh", startedAt: 0 }],
    });
    writeFileSync(join(memDir, "pitfalls.md"), PITFALLS.split("## Commit")[0]!);
    expect(await child.call("git commit -m x")).toBeUndefined();
  });
});
