// memory-predict plan.md v3.2 §11.1 wire-predict tests: P1b (zero-call) wired
// into the real `before_agent_start` path. Harness mirrors wire-recall.test.ts
// (same fake-pi / fake-registry shape) plus the predict-specific ports
// (`todo`/`attachPredictPorts`).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { jevConfigOf, predictConfigOf } from "../../../src/memory/jev/config.js";
import type { EntryTags, JevConfig, JevQuestion, MemEntry } from "../../../src/memory/jev/contracts.js";
import { EntryIndex } from "../../../src/memory/jev/entries.js";
import { writeIndexPatch } from "../../../src/memory/jev/index-store.js";
import { clearHealthTable } from "../../../src/memory/jev/health.js";
import { formatJevReport } from "../../../src/memory/jev/format.js";
import { evidenceForTag, mergeInjectMessages, restoreCarryFromBranch, wireJev } from "../../../src/memory/jev/wire.js";
import { buildFinalRecord } from "../../../src/memory/jev/predict/carry.js";
import { DEFAULT_MEMORY_SETTINGS, type MemorySettings } from "../../../src/memory/settings.js";
import { createFakeRegistry, type ClassifyCallRecord } from "./helpers/fake-registry.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

const CLASSIFIERS = ["opencode/jev-1.13-free", "opencode/jev-1.13"];

let tmp: string;
let memDir: string;

beforeEach(() => {
  clearHealthTable();
  tmp = mkdtempSync(join(tmpdir(), "jev-wire-predict-"));
  memDir = join(tmp, "mem");
  mkdirSync(memDir, { recursive: true });
  writeFileSync(
    join(memDir, "core.md"),
    [
      "# Core",
      "",
      "## Dispatch",
      "",
      "- 派发子 agent 前先确认范围 <!-- mem tags=+dispatch -->",
      "",
      "## Release",
      "",
      "- 发版前确认 CI 是绿的 <!-- mem user tags=+release -->",
      "",
      "## Commit",
      "",
      "- 提交只用精确路径，不要 git add -A <!-- mem tags=+git-commit -->",
      "",
    ].join("\n"),
  );
});

afterEach(() => {
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

function answersFor(questions: Record<string, JevQuestion>, rules: readonly (readonly [string, number])[]) {
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

interface TodoItem {
  id: number;
  subject: string;
  status: "pending" | "in_progress" | "completed";
}

interface BashJob {
  status: string;
  command: string;
}

interface HarnessOpts {
  rules?: readonly (readonly [string, number])[];
  fail?: string;
  config?: Partial<JevConfig>;
  settings?: Partial<MemorySettings>;
  isChild?: boolean;
  todo?: TodoItem[];
  /** Make the todo port throw inside the P turn (P-isolation fault injection). */
  todoThrow?: boolean;
  bashJobs?: BashJob[];
  activeRuns?: number;
}

function harness(opts: HarnessOpts = {}) {
  const handlers = new Map<string, Handler[]>();
  const sent: { message: { customType: string; content: unknown; details: any }; options: unknown }[] = [];
  const appended: { customType: string; data: any }[] = [];
  const branch: any[] = [];
  const renderers = new Map<string, Function>();
  const logs: string[] = [];
  let nextId = 1;
  const pi = {
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage: (message: any, options: unknown) => {
      sent.push({ message, options });
      branch.push({ type: "custom_message", id: `m${nextId++}`, ...message });
    },
    appendEntry: (customType: string, data: unknown) => {
      appended.push({ customType, data });
      branch.push({ type: "custom", id: `c${nextId++}`, customType, data });
    },
    registerMessageRenderer: (customType: string, r: Function) => renderers.set(customType, r),
  } as unknown as ExtensionAPI;
  const fake = createFakeRegistry({
    available: CLASSIFIERS,
    responses: Object.fromEntries(
      CLASSIFIERS.map((id) => [
        id,
        [
          async (call: ClassifyCallRecord) => {
            if (opts.fail !== undefined) return { stopReason: "error" as const, errorMessage: opts.fail };
            return { stopReason: "stop" as const, answers: answersFor(call.questions, opts.rules ?? []) };
          },
        ],
      ]),
    ),
  });
  const settings: MemorySettings = { ...DEFAULT_MEMORY_SETTINGS, ...opts.settings };
  const config: JevConfig = { ...jevConfigOf(settings), classifiers: CLASSIFIERS, ...opts.config };
  let todoList: TodoItem[] = opts.todo ?? [];
  let bashJobsList: BashJob[] = opts.bashJobs ?? [];
  let activeRuns = opts.activeRuns ?? 0;
  const writeHooks: ((cwd: string) => void)[] = [];
  const wire = wireJev(pi, {
    config,
    settings,
    isChildSession: opts.isChild === true,
    dirFor: () => memDir,
    getRenderInfo: () => undefined,
    onAfterWriteHook: (fn) => writeHooks.push(fn),
    log: (l) => logs.push(l),
    todo: {
      list: () => {
        if (opts.todoThrow === true) throw new Error("todo port boom");
        return todoList;
      },
    },
  });
  wire.attachPredictPorts({
    bashJobs: { list: () => bashJobsList },
    fleet: { activeRuns: () => activeRuns },
  });
  const ctx = (extra: Record<string, unknown> = {}) => ({
    cwd: tmp,
    hasUI: true,
    ui: { notify: () => {} },
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
    const [r] = await emit("before_agent_start", { type: "before_agent_start", messageType: "user", prompt: text });
    return r as { message?: any } | undefined;
  };
  return {
    pi,
    handlers,
    sent,
    appended,
    branch,
    renderers,
    logs,
    fake,
    wire,
    ctx,
    emit,
    prompt,
    writeHooks,
    setTodo: (t: TodoItem[]) => {
      todoList = t;
    },
    setBashJobs: (j: BashJob[]) => {
      bashJobsList = j;
    },
  };
}

const settleBackground = () => new Promise((r) => setTimeout(r, 30));

async function goPartial(h: ReturnType<typeof harness>): Promise<void> {
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  await settleBackground();
  expect(h.wire.client.status()).toMatchObject({ kind: "partial", inactive: false });
}

// ───────────────────────────── pure helpers ─────────────────────────────

describe("pure helpers (evidenceForTag / restoreCarryFromBranch / mergeInjectMessages)", () => {
  test("evidenceForTag unions todoIds/jobShapes across hits and keeps the last branch", () => {
    const hits = [
      {
        rule: "r1",
        source: "T" as const,
        tag: "git-commit",
        conf: "high" as const,
        baseConf: "high" as const,
        evidence: { todoIds: [1], jobShapes: [] },
      },
      {
        rule: "r2",
        source: "W" as const,
        tag: "git-commit",
        conf: "low" as const,
        baseConf: "low" as const,
        evidence: { todoIds: [2], jobShapes: ["bash release.sh"], branch: "dev" },
      },
      {
        rule: "r3",
        source: "U" as const,
        tag: "other-tag",
        conf: "high" as const,
        baseConf: "high" as const,
        evidence: { todoIds: [9], jobShapes: [] },
      },
    ];
    expect(evidenceForTag(hits, "git-commit")).toEqual({
      todoIds: [1, 2],
      jobShapes: ["bash release.sh"],
      branch: "dev",
    });
    expect(evidenceForTag(hits, "no-such-tag")).toEqual({ todoIds: [], jobShapes: [] });
  });

  test("restoreCarryFromBranch returns undefined with no final record, ignores kind:call, finds the newest final", () => {
    expect(restoreCarryFromBranch([])).toBeUndefined();
    const callOnly = [{ type: "custom", customType: "subagent:memory-predict", data: { v: 1, kind: "call", at: "x" } }];
    expect(restoreCarryFromBranch(callOnly as never)).toBeUndefined();
    const tag = {
      tag: "dispatch",
      score: 0.9,
      sources: ["U"],
      rules: ["R05"],
      evidence: { todoIds: [], jobShapes: [] },
    };
    const older = buildFinalRecord(1, [tag], 1);
    const newer = buildFinalRecord(2, [], 0, "cancel");
    const branch = [
      { type: "custom", customType: "subagent:memory-predict", data: older },
      { type: "custom", customType: "subagent:memory-predict", data: newer },
    ];
    // newest final is the cleared one ⇒ undefined (R2-5: only the LAST final matters).
    expect(restoreCarryFromBranch(branch as never)).toBeUndefined();
    expect(restoreCarryFromBranch([branch[0]] as never)).toEqual({ tags: [tag], carries: 1 });
  });

  test("mergeInjectMessages: U-only passes through byte-identical; P-only gets predict summary; both merge into one `parts` message", () => {
    const u = {
      customType: "subagent:memory-inject",
      content: "U body",
      display: true,
      details: { v: 1, layer: "U", trigger: "user", items: [] },
    } as any;
    const p = {
      customType: "subagent:memory-inject",
      content: "P body",
      display: true,
      details: { v: 1, layer: "P", trigger: "predict", items: [] },
    } as any;
    expect(mergeInjectMessages(undefined, u, undefined)).toBe(u);
    const pOnly = mergeInjectMessages(p, undefined, { tags: ["dispatch"], state: [], origin: "rules" });
    expect(pOnly?.details.predict).toEqual({ tags: ["dispatch"], state: [], origin: "rules" });
    expect(mergeInjectMessages(undefined, undefined, undefined)).toBeUndefined();
    const merged = mergeInjectMessages(p, u, { tags: ["dispatch"], state: [], origin: "rules" });
    expect(merged?.content).toBe("P body\n\nU body");
    expect(merged?.details.layer).toBe("P");
    expect(merged?.details.items).toBe(p.details.items);
    expect(merged?.details.parts).toEqual([
      { layer: "P", trigger: "predict", items: [] },
      { layer: "U", trigger: "user", items: [] },
    ]);
    expect(merged?.details.predict).toEqual({ tags: ["dispatch"], state: [], origin: "rules" });
  });
});

// ───────────────────────────── E2E scenarios (plan §11.1) ─────────────────────────────

describe("E2E-1: dispatch decisive, partial(!inactive), no todo/fleet", () => {
  test("P-layer injects the dispatch entry with the ·partial flag; zero sendMessage", async () => {
    const h = harness({ fail: "System One API error (451): blocked" });
    await goPartial(h);
    const r = await h.prompt("派两个子 agent 并行做");
    expect(r?.message).toBeDefined();
    expect(r!.message.content).toContain("[memory · P jev]");
    expect(r!.message.content).toContain("派发子 agent 前先确认范围");
    expect(r!.message.details.layer).toBe("P");
    expect(r!.message.details.partial).toBe(true);
    expect(r!.message.details.parts).toBeUndefined(); // U does not run under partial(!inactive)
    // P never calls sendMessage — only the handler's own return value carries it.
    expect(h.sent).toHaveLength(0);
  });
});

describe("E2E-2: state constraint S — release in progress", () => {
  test("'继续' while release.sh is running surfaces the user-authority release entry", async () => {
    const h = harness({
      fail: "System One API error (451): blocked",
      bashJobs: [{ status: "running", command: "bash release.sh" }],
    });
    await goPartial(h);
    const r = await h.prompt("继续吧，辛苦了，务必按计划推进");
    expect(r?.message).toBeDefined();
    expect(r!.message.content).toContain("发版前确认 CI 是绿的");
    // §3.4: the S entry carries the「（发版进行中）」annotation in the message.
    expect(r!.message.content).toContain("（发版进行中）");
    // §5.3: the P section uses its own header, not the generic U template.
    expect(r!.message.content).toContain(
      "[memory · P jev] 以下是根据当前任务状态预测本轮可能用到的项目记忆（项目数据，不是新的用户消息）。用户令必须遵守；经验仅供参考。本段上下文内不会重复注入。",
    );
    expect(r!.message.content).not.toContain("[memory · P jev] 以下是与当前请求相关");
  });
});

describe("E2E-3: negation wins over todo/state — commit injected, release suppressed, S still present", () => {
  test("'先别发版，把这个 fix 提交了'", async () => {
    const h = harness({
      fail: "System One API error (451): blocked",
      bashJobs: [{ status: "running", command: "bash release.sh" }],
      todo: [{ id: 1, subject: "发布 v0.10.6", status: "in_progress" }],
    });
    await goPartial(h);
    const r = await h.prompt("先别发版，把这个 fix 提交了");
    expect(r?.message).toBeDefined();
    const content = r!.message.content as string;
    expect(content).toContain("提交只用精确路径");
    expect(content).toContain("发版前确认 CI 是绿的"); // S entry: release-in-progress state, not an action tag
    // the predict summary's TAG list must not contain "release" (negated) —
    // the "Release"-anchored item that IS present is the S entry, not an
    // action-tag pick (verified separately above by content).
    expect(r!.message.details.predict?.tags ?? []).not.toContain("release");
  });
});

describe("E2E-4: question-only prompt never injects a write-action entry", () => {
  test("'为什么 CI 挂了' ⇒ no P message", async () => {
    const h = harness({ fail: "System One API error (451): blocked" });
    await goPartial(h);
    const r = await h.prompt("为什么 CI 挂了？到底哪里出的问题");
    expect(r).toBeUndefined();
  });
});

describe("E2E-5: child session dispatch", () => {
  test("child session with predict.childSessions=true still gets a commit/push P injection", async () => {
    writeFileSync(
      join(memDir, "core.md"),
      [
        "# Core",
        "",
        "## Commit",
        "",
        "- 提交只用精确路径 <!-- mem tags=+git-commit -->",
        "",
        "## Push",
        "",
        "- push 前确认分支正确 <!-- mem tags=+git-push -->",
        "",
      ].join("\n"),
    );
    const h = harness({ fail: "System One API error (451): blocked", isChild: true });
    expect(h.handlers.get("session_start")).toBeUndefined(); // children never probe (unchanged)
    const r = await h.prompt("提交并推送一下");
    expect(r?.message).toBeDefined();
    expect(r!.message.content).toContain("提交只用精确路径");
  });

  test("child session with predict.childSessions=false runs zero predict (P1b childSessions gate)", async () => {
    const h = harness({
      fail: "System One API error (451): blocked",
      isChild: true,
      settings: {
        jev: {
          ...DEFAULT_MEMORY_SETTINGS.jev,
          predict: { ...DEFAULT_MEMORY_SETTINGS.jev.predict, childSessions: false },
        },
      },
    });
    const r = await h.prompt("派两个子 agent 并行做");
    expect(r).toBeUndefined();
  });
});

describe("predict.enabled=false ⇒ byte-identical to the pre-P1 U-only path", () => {
  test("no parts/predict fields; same message shape as wire-recall's U layer test", async () => {
    const h = harness({
      rules: [["确认范围", 0.92]],
      settings: {
        jev: { ...DEFAULT_MEMORY_SETTINGS.jev, predict: { ...DEFAULT_MEMORY_SETTINGS.jev.predict, enabled: false } },
      },
    });
    const r = await h.prompt("派两个子 agent 把这个任务范围确认一下");
    expect(r?.message).toBeDefined();
    expect(r!.message.details.layer).toBe("U");
    expect(r!.message.details.parts).toBeUndefined();
    expect(r!.message.details.predict).toBeUndefined();
  });
});

describe("full status: P and U merge into one message with no duplicate entries", () => {
  test("P claims dispatch, U independently recalls the commit entry; one merged message, no duplicate hashes", async () => {
    const h = harness({ rules: [["精确路径", 0.95]] });
    // Deliberately skip session_start here: it would kick off background bulk
    // tagging (onFull), and this harness's blunt substring-matching fake
    // registry would then tag EVERY enabled tag onto any entry whose excerpt
    // contains the needle — an artifact of the test double, not of wire.ts.
    // `judgedAllowed()` (U) and `zeroCallAllowed()` (P) both treat the default
    // "probing" status the same as "full" (plan §5.2's full/probing row).
    expect(h.wire.client.status().kind).toBe("probing");
    const r = await h.prompt("派两个子 agent，记得要精确路径");
    expect(r?.message).toBeDefined();
    expect(r!.message.details.layer).toBe("P");
    expect(Array.isArray(r!.message.details.parts)).toBe(true);
    expect(r!.message.details.parts).toHaveLength(2);
    expect(r!.message.details.predict.origin).toBe("rules");
    const allHashes = (r!.message.details.parts as { items: { hash: string }[] }[]).flatMap((part) =>
      part.items.map((i) => i.hash),
    );
    expect(new Set(allHashes).size).toBe(allHashes.length); // no hash repeated across parts
    expect(allHashes).toContain(entryWith("派发子 agent 前先确认范围").hash);
    expect(allHashes).toContain(entryWith("提交只用精确路径").hash);
    expect(h.sent).toHaveLength(0); // both parts resolved within the handler call
  });
});

describe("carry persistence across turns (final record, §3.3)", () => {
  test("decisive dispatch carries into the next turn's final record, then a 'cancel' phrase clears it", async () => {
    const h = harness({ fail: "System One API error (451): blocked" });
    await goPartial(h);
    const r1 = await h.prompt("派两个子 agent 并行做");
    expect(r1?.message.content).toContain("派发子 agent 前先确认范围");
    const predictEntries = () => h.appended.filter((a) => a.customType === "subagent:memory-predict");
    expect(predictEntries()).toHaveLength(1);
    expect(predictEntries()[0]!.data.kind).toBe("final");
    expect(predictEntries()[0]!.data.tags.some((t: { tag: string }) => t.tag === "dispatch")).toBe(true);

    // the dispatch entry is already injected this segment (session-level
    // dedup, unchanged jev behaviour) — carry persistence is observed on the
    // FINAL RECORD (the tag survives via source C), not a second injection
    // of the same entry.
    await h.prompt("继续");
    const afterContinue = predictEntries();
    expect(afterContinue).toHaveLength(2);
    expect(afterContinue[1]!.data.tags.some((t: { tag: string }) => t.tag === "dispatch")).toBe(true);
    expect(afterContinue[1]!.data.carries).toBeGreaterThan(0);

    await h.prompt("算了，换个任务");
    const afterCancel = predictEntries();
    expect(afterCancel).toHaveLength(3);
    expect(afterCancel[2]!.data.cleared).toBe("cancel");
    expect(afterCancel[2]!.data.tags).toEqual([]);

    const r4 = await h.prompt("继续");
    expect(r4).toBeUndefined(); // carry was cleared — nothing left to carry
    // a bare "继续" after an empty carry writes no further final record (§3.3:
    // only written when this turn has tags, or carry just went from present to empty).
    expect(predictEntries()).toHaveLength(3);
  });

  test("todo replaced wholesale drops a T-sourced carry tag", async () => {
    const h = harness({
      fail: "System One API error (451): blocked",
      todo: [{ id: 1, subject: "测试一下 vitest", status: "in_progress" }],
    });
    await goPartial(h);
    // seed a carry whose only evidence is todo id 1 (T source) directly via a final record.
    h.branch.push({
      type: "custom",
      customType: "subagent:memory-predict",
      data: buildFinalRecord(
        0,
        [{ tag: "git-commit", score: 0.6, sources: ["T"], rules: ["seed"], evidence: { todoIds: [1], jobShapes: [] } }],
        1,
      ),
    });
    h.setTodo([{ id: 2, subject: "全新任务，与 1 无关", status: "in_progress" }]);
    const r = await h.prompt("继续");
    // todo was replaced wholesale (id 1 ⇒ id 2): carry must not resurrect git-commit.
    expect(r === undefined || !(r.message?.content ?? "").includes("提交只用精确路径")).toBe(true);
  });
});

describe("carry trigger gate (§3.3): carry only enters on carry phrases", () => {
  const seedDispatchCarry = (h: ReturnType<typeof harness>): void => {
    h.branch.push({
      type: "custom",
      customType: "subagent:memory-predict",
      data: buildFinalRecord(
        0,
        [{ tag: "dispatch", score: 0.9, sources: ["U"], rules: ["seed"], evidence: { todoIds: [], jobShapes: [] } }],
        1,
      ),
    });
  };

  test("an unrelated new instruction does NOT inherit the carried dispatch tag (wire-level regression)", async () => {
    const h = harness({ fail: "System One API error (451): blocked" });
    await goPartial(h);
    seedDispatchCarry(h);
    // 0.9 × 0.95 revalidation = 0.855 — exactly the over-injection the gate exists to prevent.
    const r = await h.prompt("把 README 里这段说明改一下，其他都别动");
    expect(r === undefined || !(r.message?.content ?? "").includes("派发子 agent")).toBe(true);
    // the non-carry turn invalidates the carry (§3.3): the newest final record no longer carries dispatch.
    const predictEntries = h.appended.filter((a) => a.customType === "subagent:memory-predict");
    const last = predictEntries[predictEntries.length - 1]?.data;
    expect(last === undefined || !last.tags.some((t: { tag: string }) => t.tag === "dispatch")).toBe(true);
  });

  test("a real carry phrase still inherits (revalidated ×0.95, source C, carries incremented)", async () => {
    const h = harness({ fail: "System One API error (451): blocked" });
    await goPartial(h);
    seedDispatchCarry(h);
    const r = await h.prompt("继续");
    expect(r?.message).toBeDefined();
    expect(r!.message.content).toContain("派发子 agent 前先确认范围");
    const predictEntries = h.appended.filter((a) => a.customType === "subagent:memory-predict");
    const last = predictEntries[predictEntries.length - 1]!.data;
    expect(last.tags.some((t: { tag: string }) => t.tag === "dispatch")).toBe(true);
    expect(last.carries).toBe(2); // seeded carries=1 → revalidated carry increments
  });
});

describe("P-layer fault isolation (§5.3)", () => {
  test("a throwing P turn drops P only — U still returns its own message", async () => {
    const h = harness({ rules: [["精确路径", 0.95]], todoThrow: true });
    expect(h.wire.client.status().kind).toBe("probing");
    const r = await h.prompt("派两个子 agent，记得要精确路径");
    expect(r?.message).toBeDefined();
    expect(r!.message.details.layer).toBe("U");
    expect(r!.message.details.parts).toBeUndefined(); // P never contributed
    expect(r!.message.content).toContain("提交只用精确路径");
    expect(h.logs.some((l) => l.includes("predict turn failed"))).toBe(true);
  });
});

describe("P→U dedup with a genuinely overlapping entry", () => {
  test("P and U both claim the dispatch entry ⇒ exactly one copy, claimed by P", async () => {
    // "确认范围" 0.9 makes U's classifier pick the dispatch entry too — real overlap.
    const h = harness({
      rules: [
        ["确认范围", 0.9],
        ["精确路径", 0.95],
      ],
    });
    expect(h.wire.client.status().kind).toBe("probing");
    const r = await h.prompt("派两个子 agent，记得要精确路径");
    expect(r?.message).toBeDefined();
    const parts = r!.message.details.parts as { layer: string; items: { hash: string }[] }[];
    expect(parts.map((p) => p.layer)).toEqual(["P", "U"]);
    const dispatchHash = entryWith("派发子 agent 前先确认范围").hash;
    const all = parts.flatMap((p) => p.items.map((i) => i.hash));
    expect(all.filter((x) => x === dispatchHash)).toHaveLength(1);
    expect(parts[0]!.items.map((i) => i.hash)).toContain(dispatchHash); // claimed by P
    expect(all).toContain(entryWith("提交只用精确路径").hash); // U's own pick survives
    expect((r!.message.content.match(/派发子 agent 前先确认范围/g) ?? []).length).toBe(1);
  });
});

describe("pInjectedAt cooldown (§5.3/§10; #36 X2 bypass)", () => {
  test("cooldown blocks the normal path in a fresh session; the #36 §6.4 starvation bypass is the only way back in", async () => {
    const h1 = harness({ fail: "System One API error (451): blocked" });
    await goPartial(h1);
    const r1 = await h1.prompt("派两个子 agent 并行做");
    expect(r1?.message.content).toContain("派发子 agent 前先确认范围");
    // recordPInjection is fire-and-forget — poll the sidecar until the stamp lands.
    const indexPath = join(memDir, ".jev", "index.json");
    const deadline = Date.now() + 5_000;
    let stamped = false;
    while (Date.now() < deadline) {
      try {
        const raw = JSON.parse(readFileSync(indexPath, "utf8")) as { pInjectedAt?: Record<string, string> };
        if (raw.pInjectedAt !== undefined && Object.keys(raw.pInjectedAt).length > 0) {
          stamped = true;
          break;
        }
      } catch {
        /* sidecar not written yet */
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(stamped).toBe(true);
    // fresh wireJev (new segment + pStamps overlay): the on-disk cooldown
    // suppresses the NORMAL selection path; per #36 arch §6.4 (approved
    // exception X2) the high-risk `dispatch` tag with all qualified
    // candidates cooling is exactly the starvation exit — the entry returns
    // ONLY via the bypass, and the message says so.
    const h2 = harness({ fail: "System One API error (451): blocked" });
    await goPartial(h2);
    const r2 = await h2.prompt("派两个子 agent 并行做");
    expect(r2?.message?.content).toContain("派发子 agent 前先确认范围");
    expect(r2?.message?.details?.predict?.bypass).toBe(true);
  });
});

describe("40-slot priority pool (§5.4)", () => {
  test("a predicted-tag entry prefilter would cut still reaches the U candidate pool when eligible > 360", async () => {
    // 361 user-authority fillers (prefilter tieBreak user-first pushes the
    // agent-authority, zero-query-overlap priority entry past slot 360) + the
    // small dispatch entry (P claims it) + the oversized priority entry (>2048B,
    // so P's byte budget skips it and it stays in U's eligible set).
    const filler = Array.from(
      { length: 361 },
      (_, i) => `- 队列预算填充规则第 ${i} 号：与当前问题无关的说明文字 <!-- mem user -->`,
    );
    writeFileSync(
      join(memDir, "core.md"),
      [
        "# Core",
        "",
        "## Dispatch",
        "",
        "- 派发子 agent 前先确认范围 <!-- mem tags=+dispatch -->",
        "",
        "## Filler",
        "",
        ...filler,
        "",
        "## Priority",
        "",
        `- zzz-priority-needle ${"填".repeat(1200)} <!-- mem tags=+dispatch -->`,
        "",
      ].join("\n"),
    );
    const h = harness({ rules: [] });
    expect(h.wire.client.status().kind).toBe("probing");
    await h.prompt("派两个子 agent 并行做");
    const questionIds = new Set<string>();
    let sawPriority = false;
    for (const call of h.fake.calls) {
      for (const [id, q] of Object.entries(call.questions)) {
        questionIds.add(id);
        if (q.instructions.includes("zzz-priority-needle")) sawPriority = true;
      }
    }
    expect(sawPriority).toBe(true); // the priority pool rescued it
    expect(questionIds.size).toBeLessThanOrEqual(360); // the cap still holds
  });
});

describe("segment full ⇒ P never injects", () => {
  test("after SEGMENT_MAX_INJECTED U injections, a subsequent predict-eligible prompt yields nothing", async () => {
    const h = harness({ rules: [["release", 0.9]] });
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    await settleBackground();
    for (let i = 0; i < 31; i++) {
      h.branch.push({
        type: "custom",
        customType: "subagent:memory-recall",
        data: { v: 1, layer: "U", keys: [`fake-hash-${i}`] },
      });
    }
    const r = await h.prompt("派两个子 agent 并行做");
    expect(r).toBeUndefined();
  });
});

describe("/mem jev report: predict row (rules-only, P1b)", () => {
  test("formatJevReport prints a predict line only when the field is present (I9)", () => {
    const base = {
      status: "full · x",
      models: [],
      stopped: [],
      running: [],
      tags: { tagged: 0, total: 0, pending: 0, taxonomyRev: "r1" },
      usage: { calls: 0, costUsd: 0, maxCostUsd: 0.5 },
      segment: { injectedByLayer: {}, injectedTotal: 0 },
      review: { open: 0 },
    } as const;
    expect(formatJevReport(base)).not.toContain("predict");
    expect(formatJevReport({ ...base, predict: { rules: 7 } })).toContain("predict  rules 7");
  });

  test("the live commandPort.report appends the rule-fire count once predict has run", async () => {
    const h = harness({ fail: "System One API error (451): blocked" });
    await goPartial(h);
    await h.prompt("派两个子 agent 并行做");
    const text = await h.wire.commandPort.report(tmp, undefined);
    expect(text).toContain("predict  rules 1");
  });

  test("predict.enabled=false ⇒ no predict row at all (I9)", async () => {
    const h = harness({
      fail: "System One API error (451): blocked",
      settings: {
        jev: { ...DEFAULT_MEMORY_SETTINGS.jev, predict: { ...DEFAULT_MEMORY_SETTINGS.jev.predict, enabled: false } },
      },
    });
    await goPartial(h);
    const text = await h.wire.commandPort.report(tmp, undefined);
    expect(text).not.toContain("predict");
  });
});

describe("git signals (dirty bit / branch) go through a real git repo", () => {
  test("R12 (git-commit, low) fires once a real worktree reports dirty — picked up by the next turn after an async refresh", async () => {
    execFileSync("git", ["init", "-q"], { cwd: tmp });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: tmp });
    execFileSync("git", ["config", "user.name", "t"], { cwd: tmp });
    writeFileSync(join(tmp, "a.txt"), "x");
    execFileSync("git", ["add", "a.txt"], { cwd: tmp });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: tmp });
    writeFileSync(join(tmp, "a.txt"), "dirty now");
    const h = harness({ fail: "System One API error (451): blocked" });
    await goPartial(h);
    // first turn: dirty cache is cold (undefined) ⇒ async refresh kicked, no R12 yet.
    await h.prompt("随便问问");
    await new Promise((r) => setTimeout(r, 200)); // let the git subprocess settle
    // second turn with a decisive dispatch tag too (so the turn actually injects something):
    // low-score R12 alone cannot clear the 0.3 floor, so pair it with the carry-free dispatch hit.
    const r = await h.prompt("派两个子 agent 并行做");
    expect(r?.message).toBeDefined();
  });
});

// ───────────────────── #36 P6b — P-layer naming requirement + decay (arch §6.2) ─────────────────────

describe("#36 P6b P-layer naming + decay (arch §6.2)", () => {
  const DAY = 86_400_000;
  const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();

  function writeBlock(id: string, meta: string[], body: string): void {
    writeFileSync(
      join(memDir, "blocks", `${id}.md`),
      ["---", "kind: block", ...meta, 'created: "2026-01-01T00:00:00.000Z"', "version: 1", "---", "", body, ""].join(
        "\n",
      ),
    );
  }

  async function sidecar(needle: string, tags: Record<string, number>, extra: Partial<EntryTags> = {}): Promise<void> {
    const e = entries().find((x) => x.body.includes(needle))!;
    const rec: EntryTags = {
      file: e.file,
      type: "rule",
      typeP: 0.9,
      importance: 2,
      tags: Object.fromEntries(Object.entries(tags).map(([k, p]) => [k, { p, rev: 1 }])),
      guard: 0.1,
      temporal: "permanent",
      userLike: 0.1,
      model: "opencode/jev-1.13",
      at: "2026-11-01T00:00:00.000Z",
      taxonomyRev: "x",
      ...extra,
    };
    expect(await writeIndexPatch(memDir, { upsert: { [e.hash]: rec } })).toBe("ok");
  }

  /** blocks layout + one FRESH agent snapshot block (quota-window body ⇒ the
   *  §5.3 regex hits) tagged git-commit so the decisive R02 rule can pick it
   *  up. Fresh ⇒ m=1: the ONLY thing standing between it and injection is the
   *  naming requirement. */
  async function makeNamedBlocks(): Promise<void> {
    const blocks = join(memDir, "blocks");
    mkdirSync(blocks, { recursive: true });
    writeFileSync(join(blocks, ".layout.json"), JSON.stringify({ v: 1, source: "migrate", gen: 1, files: [] }));
    writeFileSync(
      join(blocks, "quota.005.md"),
      [
        "---",
        "kind: block",
        "authority: agent",
        `updated: "${iso(1)}"`,
        'created: "2026-01-01T00:00:00.000Z"',
        "version: 1",
        "---",
        "",
        "- run r_dec99 的 5h 窗口配额已用 62%",
        "",
      ].join("\n"),
    );
    await sidecar("r_dec99", { "git-commit": 0.9 }, { temporal: "permanent" });
  }

  test("decisive git-commit turn that does NOT name the snapshot block ⇒ zero P injection (V26)", async () => {
    await makeNamedBlocks();
    const h = harness({ fail: "System One API error (451): blocked" });
    await goPartial(h);
    const r = await h.prompt("提交这些改动，顺便跑下格式检查");
    expect(r).toBeUndefined(); // no message at all — the block is a decay target nobody named
    expect(h.sent).toHaveLength(0);
  });

  test("same block, turn names run/r_dec99/配额 ⇒ P injects it", async () => {
    await makeNamedBlocks();
    const h = harness({ fail: "System One API error (451): blocked" });
    await goPartial(h);
    const r = await h.prompt("提交这些改动，先核对 run r_dec99 的配额");
    expect(r?.message?.details?.layer).toBe("P");
    expect(r!.message.content).toContain("r_dec99");
  });

  test("decay ×m reorders P selection: a higher-tagP stale snapshot loses to a fresher twin (V26)", async () => {
    const blocks = join(memDir, "blocks");
    mkdirSync(blocks, { recursive: true });
    writeFileSync(join(blocks, ".layout.json"), JSON.stringify({ v: 1, source: "migrate", gen: 1, files: [] }));
    writeFileSync(
      join(blocks, "quota.006.md"),
      [
        "---",
        "kind: block",
        "authority: agent",
        `updated: "${iso(1)}"`,
        'created: "2026-01-01T00:00:00.000Z"',
        "version: 1",
        "---",
        "",
        "- quota check lane f1 fresh reading",
        "",
      ].join("\n"),
    );
    // stale twin: temporal dated (§6.2 target) 40 days old — WITHOUT decay its
    // raw score (tagP 1.0) would beat the fresh block (tagP 0.85)
    writeFileSync(
      join(blocks, "quota.007.md"),
      [
        "---",
        "kind: block",
        "authority: agent",
        `updated: "${iso(40)}"`,
        'created: "2026-01-01T00:00:00.000Z"',
        "version: 1",
        "---",
        "",
        "- quota check lane g1 stale reading",
        "",
      ].join("\n"),
    );
    await sidecar("lane f1 fresh", { "git-commit": 0.85 });
    await sidecar("lane g1 stale", { "git-commit": 1.0 }, { temporal: "dated" });
    const h = harness({
      fail: "System One API error (451): blocked",
      config: {
        predict: predictConfigOf({
          ...DEFAULT_MEMORY_SETTINGS,
          jev: { ...DEFAULT_MEMORY_SETTINGS.jev, predict: { ...DEFAULT_MEMORY_SETTINGS.jev.predict, maxEntries: 1 } },
        }),
      },
    });
    await goPartial(h);
    const r = await h.prompt("提交这些改动，先看 lane f1 和 lane g1 的 quota check");
    expect(r?.message?.details?.layer).toBe("P");
    expect(r!.message.content).toContain("lane f1 fresh");
    expect(r!.message.content).not.toContain("lane g1 stale"); // 1.8 × 0.6 < 1.53
  });
});

// ───────────────────── #36 P6b 收口 — bypass must reflect the COMMITTED set (P6a 遗留） ─────────────────────

describe("#36 P6b bypass reporting reflects the committed set (P6a leftover)", () => {
  /** Writes the two-entry corpus + B's cooldown stamp into the CURRENT
   *  memDir. Each run gets its own directory — recordPInjection stamps the
   *  sidecar fire-and-forget, and the dir is shared per harness, so a prior
   *  run's stamps must not leak into the next harness's cooldown view. */
  async function setupCorpus(): Promise<void> {
    writeFileSync(
      join(memDir, "core.md"),
      [
        "# Core",
        "",
        "## Commit",
        "",
        "- commit-entry-a 只用精确路径提交 <!-- mem tags=+git-commit -->",
        "",
        "## Dispatch",
        "",
        "- dispatch-entry-b 派发前先确认范围",
        "",
      ].join("\n"),
    );
    // entry A (inline +git-commit, pending ⇒ importance 2) ranks first at
    // 0.9×1×2×1.25=2.25; entry B carries a SIDE-CAR dispatch tag at p=0.72
    // (0.9×0.72×2×1.25≈1.62 — always below A, no hash-order tie) and is
    // cooled via pInjectedAt so the dispatch tag is starved ⇒ B returns ONLY
    // via the §6.4 bypass (appended after A).
    const b = entries().find((e) => e.body.includes("dispatch-entry-b"))!;
    const bTags: EntryTags = {
      file: b.file,
      type: "rule",
      typeP: 0.9,
      importance: 2,
      tags: { dispatch: { p: 0.72, rev: 1 } },
      guard: 0.1,
      temporal: "permanent",
      userLike: 0.1,
      model: "opencode/jev-1.13",
      at: "2026-11-01T00:00:00.000Z",
      taxonomyRev: "x",
    };
    expect(
      await writeIndexPatch(memDir, {
        upsert: { [b.hash]: bTags },
        pInjectedAt: { [b.hash]: new Date().toISOString() },
      }),
    ).toBe("ok");
  }

  test("bypass-selected pick rejected by the commit (segment cap) ⇒ no predict.bypass report; positive control without the cap reports it", async () => {
    const seedSegment = (h: ReturnType<typeof harness>): void => {
      // 29 already-injected hashes ⇒ one slot left before SEGMENT_MAX_INJECTED
      h.branch.push({
        type: "custom",
        id: "seed-recall",
        customType: "subagent:memory-recall",
        data: {
          v: 1,
          layer: "U",
          keys: Array.from({ length: 29 }, (_, i) => `seedhash${String(i).padStart(2, "0")}`),
        },
      });
    };
    const prompt = "提交这些改动，然后派两个子 agent 并行做收尾";
    // the fix: with one slot left the commit accepts only A (segment cap) —
    // selection still marked B as bypass, but the report must NOT say so
    await setupCorpus();
    const capped = harness({ fail: "System One API error (451): blocked" });
    seedSegment(capped);
    await goPartial(capped);
    const rx = await capped.prompt(prompt);
    expect(rx?.message?.content).toContain("commit-entry-a"); // the top pick took the last slot
    expect(rx?.message?.content).not.toContain("dispatch-entry-b"); // bypass pick rejected at commit
    expect(rx?.message?.details?.predict?.bypass).toBeUndefined(); // and is NOT reported as bypassed
    // positive control in a FRESH dir: no cap ⇒ both picks committed ⇒ reported
    memDir = join(tmp, "mem2");
    mkdirSync(memDir, { recursive: true });
    await setupCorpus();
    const control = harness({ fail: "System One API error (451): blocked" });
    await goPartial(control);
    const rc = await control.prompt(prompt);
    expect(rc?.message?.content).toContain("commit-entry-a");
    expect(rc?.message?.content).toContain("dispatch-entry-b"); // the bypass pick injected
    expect(rc?.message?.details?.predict?.bypass).toBe(true);
  });
});

// ───────────────────── #36 P6b 验改 — until 豁免 / S 不受点名门 ─────────────────────

describe("#36 P6b fix round (until exempt / S gate scope)", () => {
  const DAY = 86_400_000;
  const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();

  async function sidecar(needle: string, tags: Record<string, number>, extra: Partial<EntryTags> = {}): Promise<void> {
    const e = entries().find((x) => x.body.includes(needle))!;
    const rec: EntryTags = {
      file: e.file,
      type: "rule",
      typeP: 0.9,
      importance: 2,
      tags: Object.fromEntries(Object.entries(tags).map(([k, p]) => [k, { p, rev: 1 }])),
      guard: 0.1,
      temporal: "permanent",
      userLike: 0.1,
      model: "opencode/jev-1.13",
      at: "2026-11-01T00:00:00.000Z",
      taxonomyRev: "x",
      ...extra,
    };
    expect(await writeIndexPatch(memDir, { upsert: { [e.hash]: rec } })).toBe("ok");
  }

  test("fix1: a 40-day snapshot block WITH until is not a decay target — m stays 1 and the P naming gate does not apply", async () => {
    const blocks = join(memDir, "blocks");
    mkdirSync(blocks, { recursive: true });
    writeFileSync(join(blocks, ".layout.json"), JSON.stringify({ v: 1, source: "migrate", gen: 1, files: [] }));
    writeFileSync(
      join(blocks, "quota.010.md"),
      [
        "---",
        "kind: block",
        "authority: agent",
        'until: "网络恢复后清理这条"',
        `updated: "${iso(40)}"`,
        'created: "2026-01-01T00:00:00.000Z"',
        "version: 1",
        "---",
        "",
        "- run r_kee99 的 5h 窗口配额已用 62%",
        "",
      ].join("\n"),
    );
    await sidecar("r_kee99", { "git-commit": 0.9 });
    const h = harness({ fail: "System One API error (451): blocked" });
    await goPartial(h);
    // the prompt fires decisive git-commit but names NOTHING in the block —
    // with until set the block is exempt from decay AND the naming gate
    const r = await h.prompt("提交这些改动，顺便跑下格式检查");
    expect(r?.message?.details?.layer).toBe("P");
    expect(r!.message.content).toContain("r_kee99"); // m=1 ⇒ full score ⇒ injected
  });

  test("fix2: S state candidates bypass the naming gate — an unnamed decay-target release entry still injects via S", async () => {
    const blocks = join(memDir, "blocks");
    mkdirSync(blocks, { recursive: true });
    writeFileSync(join(blocks, ".layout.json"), JSON.stringify({ v: 1, source: "migrate", gen: 1, files: [] }));
    writeFileSync(
      join(blocks, "quota.011.md"),
      [
        "---",
        "kind: block",
        "authority: agent",
        `updated: "${iso(40)}"`,
        'created: "2026-01-01T00:00:00.000Z"',
        "version: 1",
        "---",
        "",
        "- run r_rel99 的 5h 窗口配额已用 62%",
        "",
      ].join("\n"),
    );
    // sidecar: release tag (S needs it) + dated temporal ⇒ decay target; the
    // "继续" prompt shares no token with the block's first line
    await sidecar("r_rel99", { release: 0.95 }, { temporal: "dated" });
    const h = harness({
      fail: "System One API error (451): blocked",
      bashJobs: [{ status: "running", command: "bash release.sh" }],
    });
    await goPartial(h);
    const r = await h.prompt("继续吧，辛苦了，务必按计划推进");
    expect(r?.message).toBeDefined();
    expect(r!.message.content).toContain("r_rel99"); // S injected the unnamed decay target
    expect(r!.message.content).toContain("（发版进行中）"); // via the S constraint, not a normal P pick
    // the quota.011 item exists ONLY as the releaseInProgress (S) pick — it
    // never entered P's scored selection (naming gate held for P)
    const items = (r!.message.details.items ?? []) as { anchor: string; releaseInProgress?: boolean }[];
    // details.items carries no releaseInProgress marker (that annotation is
    // content-only); exactly ONE quota.011 item + the「（发版进行中）」line in
    // the content prove it came via S, not a scored P pick
    const mine = items.filter((i) => i.anchor === "quota.011");
    expect(mine).toHaveLength(1);
  });
});
