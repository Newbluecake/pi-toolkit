/**
 * scheduled-reports plan r3 §4.1/§4.2/§10.2 (S0): the frozen storage spec — defHash
 * canonicalization (deterministic vectors, independently cross-checked with Python's hashlib
 * json.dumps(sort_keys, separators=(",",":"), ensure_ascii=False) → sha256), approval
 * derivation (S2), runKey / reportId helpers and the fixed vocabularies.
 */
import { describe, expect, it } from "vitest";
import { THINKING_LEVELS } from "../../../src/core/types.js";
import {
  autoRunKey,
  canonicalJson,
  defHash,
  emptyStateFile,
  executionDefinition,
  hash8,
  isApproved,
  isExecutable,
  isHash,
  isPendingApproval,
  isTerminalRunState,
  manualRunKey,
  parseRunKey,
  reportFileOf,
  reportIdOf,
  SCHED_EXECUTION_FIELDS,
  SCHED_REPORT_FILE_RE,
  SCHED_RUN_KEY_RE,
  SCHED_TASK_ID_RE,
  SCHED_UPDATE_FORBIDDEN_FIELDS,
  SCHEDULE_ERROR_CODES,
  SCHEDULE_RUN_STATES,
  SCHEDULE_THINKING_LEVELS,
  type ScheduleTask,
} from "../../../src/schedule/core/spec.js";

const BG_TASK: ScheduleTask = {
  id: "s_abcd2345",
  name: "晨报",
  form: "background",
  when: { kind: "cron", expr: "0 8 * * *", tz: "Asia/Shanghai" },
  prompt: "汇总昨日 CI 结果\n并列出失败用例",
  feishu: true,
  bg: { type: "general-purpose", timeoutS: 1800, consultMain: false, handoff: false },
  enabled: true,
  createdBy: "user",
  createdVia: "tui",
  createdAt: 1761264000000,
  ownerCwd: "/home/u/proj",
};
const MSG_TASK: ScheduleTask = {
  id: "s_zzzz7777",
  name: "ping",
  form: "message",
  when: { kind: "once", at: "2026-10-25T09:30", tz: "UTC" },
  prompt: 'say "hi" é',
  feishu: false,
  enabled: false,
  createdBy: "agent",
  createdVia: "tool",
  createdAt: 1,
  ownerCwd: "/tmp",
};
const FULL_BG_TASK: ScheduleTask = {
  ...BG_TASK,
  bg: {
    type: "Explore",
    model: { provider: "anthropic", id: "claude-x" },
    thinking: "high",
    timeoutS: 600,
    consultMain: true,
    handoff: true,
    isolation: "worktree",
  },
};

/** Frozen vectors: canonical string + sha256. Changing ANY of these invalidates stored approvals. */
const VECTORS: Array<[string, ScheduleTask, string, string]> = [
  [
    "background, minimal bg",
    BG_TASK,
    '{"bg":{"consultMain":false,"handoff":false,"timeoutS":1800,"type":"general-purpose"},"feishu":true,"form":"background","ownerCwd":"/home/u/proj","prompt":"汇总昨日 CI 结果\\n并列出失败用例","when":{"expr":"0 8 * * *","kind":"cron","tz":"Asia/Shanghai"}}',
    "fd9fcbba309bbae09b0d3c6d69258712ce12370868bc09012b3649c28daa08e9",
  ],
  [
    "message once (no bg, quotes + non-ASCII)",
    MSG_TASK,
    '{"feishu":false,"form":"message","ownerCwd":"/tmp","prompt":"say \\"hi\\" é","when":{"at":"2026-10-25T09:30","kind":"once","tz":"UTC"}}',
    "1b4611e2ff4f7bc06a36a751b84306214878c05506d49e70aec1d8394ec06655",
  ],
  [
    "background, every bg field",
    FULL_BG_TASK,
    '{"bg":{"consultMain":true,"handoff":true,"isolation":"worktree","model":{"id":"claude-x","provider":"anthropic"},"thinking":"high","timeoutS":600,"type":"Explore"},"feishu":true,"form":"background","ownerCwd":"/home/u/proj","prompt":"汇总昨日 CI 结果\\n并列出失败用例","when":{"expr":"0 8 * * *","kind":"cron","tz":"Asia/Shanghai"}}',
    "903e09819b62a8a998043f26eb9ddc52b736e783a207b767c6a1da07c9051c32",
  ],
];

describe("defHash canonicalization (§4.1) — deterministic vectors", () => {
  it.each(VECTORS)("%s", (_label, task, canonical, hash) => {
    expect(canonicalJson(executionDefinition(task))).toBe(canonical);
    expect(defHash(task)).toBe(hash);
    expect(isHash(defHash(task))).toBe(true);
  });

  it("is independent of property insertion order (top level and nested)", () => {
    const reordered = {
      ownerCwd: BG_TASK.ownerCwd,
      bg: { handoff: false, consultMain: false, timeoutS: 1800, type: "general-purpose" },
      when: { tz: "Asia/Shanghai", kind: "cron", expr: "0 8 * * *" },
      feishu: true,
      prompt: BG_TASK.prompt,
      form: "background",
      createdAt: 0,
      createdVia: "web",
      createdBy: "agent",
      enabled: false,
      name: "other",
      id: "s_aaaaaaaa",
    } as unknown as ScheduleTask;
    expect(defHash(reordered)).toBe(VECTORS[0]![3]);
  });

  it("drops undefined properties (explicit undefined ≡ absent)", () => {
    const withUndef = {
      ...BG_TASK,
      bg: { ...BG_TASK.bg!, model: undefined, thinking: undefined, isolation: undefined },
    } as unknown as ScheduleTask;
    expect(defHash(withUndef)).toBe(VECTORS[0]![3]);
    const msgWithUndefBg = { ...MSG_TASK, bg: undefined } as unknown as ScheduleTask;
    expect(defHash(msgWithUndefBg)).toBe(VECTORS[1]![3]);
  });

  it("name / enabled / approval / id / created* never participate", () => {
    const base = defHash(BG_TASK);
    const variants: ScheduleTask[] = [
      { ...BG_TASK, name: "renamed" },
      { ...BG_TASK, enabled: false },
      { ...BG_TASK, approval: { hash: base, by: "user", via: "web", at: 5 } },
      { ...BG_TASK, id: "s_77777777" },
      { ...BG_TASK, createdBy: "agent", createdVia: "tool", createdAt: 9 },
    ];
    for (const v of variants) expect(defHash(v)).toBe(base);
  });

  it("every execution field changes the hash", () => {
    const base = defHash(BG_TASK);
    const variants: ScheduleTask[] = [
      { ...BG_TASK, form: "message" },
      { ...BG_TASK, when: { ...BG_TASK.when, tz: "UTC" } },
      { ...BG_TASK, when: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" } },
      { ...BG_TASK, prompt: `${BG_TASK.prompt} ` },
      { ...BG_TASK, feishu: false },
      { ...BG_TASK, bg: { ...BG_TASK.bg!, timeoutS: 1801 } },
      { ...BG_TASK, bg: { ...BG_TASK.bg!, consultMain: true } },
      { ...BG_TASK, bg: { ...BG_TASK.bg!, handoff: true } },
      { ...BG_TASK, bg: { ...BG_TASK.bg!, thinking: "low" } },
      { ...BG_TASK, ownerCwd: "/home/u/proj2" },
    ];
    const hashes = variants.map(defHash);
    for (const h of hashes) expect(h).not.toBe(base);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("does not Unicode-normalize (NFC vs NFD prompts hash differently)", () => {
    const nfc = { ...MSG_TASK, prompt: "caf\u00e9" };
    const nfd = { ...MSG_TASK, prompt: "cafe\u0301" };
    expect(defHash(nfc)).not.toBe(defHash(nfd));
  });

  it("execution field list is exactly the plan's", () => {
    expect([...SCHED_EXECUTION_FIELDS].sort()).toEqual(["bg", "feishu", "form", "ownerCwd", "prompt", "when"]);
    expect(Object.keys(executionDefinition(BG_TASK)).sort()).toEqual([...SCHED_EXECUTION_FIELDS].sort());
    expect(Object.keys(executionDefinition(MSG_TASK)).sort()).toEqual(["feishu", "form", "ownerCwd", "prompt", "when"]);
    expect([...SCHED_UPDATE_FORBIDDEN_FIELDS].sort()).toEqual([
      "approval",
      "createdAt",
      "createdBy",
      "createdVia",
      "id",
      "ownerCwd",
    ]);
  });
});

describe("canonicalJson", () => {
  it("matches JSON.stringify for scalars and sorts keys by UTF-16 code unit", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"], B: -0, é: 1.5 })).toBe(
      '{"B":0,"a":[true,null,"x"],"b":1,"é":1.5}',
    );
    expect(canonicalJson("\u2028\n")).toBe(JSON.stringify("\u2028\n"));
    expect(canonicalJson(Object.assign(Object.create(null) as object, { z: 1, y: 2 }))).toBe('{"y":2,"z":1}');
  });

  it.each([
    ["NaN", { a: Number.NaN }],
    ["Infinity", { a: Number.POSITIVE_INFINITY }],
    ["bigint", { a: 1n }],
    ["function", { a: () => 1 }],
    ["symbol", { a: Symbol("x") }],
    ["Date", { a: new Date(0) }],
    ["Map", { a: new Map() }],
  ])("throws on %s", (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });
});

describe("approval derivation (§4.3, S2)", () => {
  const approved = (t: ScheduleTask): ScheduleTask => ({
    ...t,
    approval: { hash: defHash(t), by: "user", via: "tui", at: 1 },
  });

  it("no approval ⇒ pending, never executable (even enabled)", () => {
    expect(isApproved(BG_TASK)).toBe(false);
    expect(isPendingApproval(BG_TASK)).toBe(true);
    expect(isExecutable(BG_TASK)).toBe(false);
  });

  it("approval binding the current hash ⇒ executable iff enabled", () => {
    const t = approved(BG_TASK);
    expect(isExecutable(t)).toBe(true);
    expect(isExecutable({ ...t, enabled: false })).toBe(false);
    expect(isPendingApproval({ ...t, enabled: false })).toBe(false); // pause is not 待确认
  });

  it("editing an execution field invalidates the approval; renaming does not", () => {
    const t = approved(BG_TASK);
    expect(isExecutable({ ...t, prompt: "changed" })).toBe(false);
    expect(isPendingApproval({ ...t, prompt: "changed" })).toBe(true);
    expect(isExecutable({ ...t, name: "renamed" })).toBe(true);
  });
});

describe("keys (§4.2/§4.5b/§7.1)", () => {
  const REQ = "fsAbCdEfGhIjKlMnOpQrStUvWxYz0123";
  const SID = "019a0000-aaaa-7bbb-8ccc-dddddddddddd";

  it("hash8 / manual runKey vector", () => {
    expect(hash8(REQ)).toBe("20f1cd92");
    expect(manualRunKey("s_abcd2345", REQ)).toBe("s_abcd2345@m-20f1cd92");
  });

  it("reportId = sha256(sid \\0 runKey) vector; report path shape", () => {
    expect(reportIdOf(SID, "s_abcd2345@1761350400000")).toBe(
      "9c128a4cc3583e27532af0a668aab529f7c717931f22d79ede0847d949ce9c70",
    );
    const file = reportFileOf(SID, "s_abcd2345@1761350400000");
    expect(file).toBe("reports/9c128a4cc3583e27532af0a668aab529f7c717931f22d79ede0847d949ce9c70.md");
    expect(SCHED_REPORT_FILE_RE.test(file)).toBe(true);
    for (const bad of ["reports/../x.md", "/abs/reports/a.md", "reports/ABC.md", "reports/a.md"])
      expect(SCHED_REPORT_FILE_RE.test(bad)).toBe(false);
  });

  it("auto runKey round-trips and rejects malformed input", () => {
    expect(autoRunKey("s_abcd2345", 1761350400000)).toBe("s_abcd2345@1761350400000");
    expect(parseRunKey("s_abcd2345@1761350400000")).toEqual({ taskId: "s_abcd2345", kind: "auto", t: 1761350400000 });
    expect(parseRunKey("s_abcd2345@m-20f1cd92")).toEqual({ taskId: "s_abcd2345", kind: "manual", h8: "20f1cd92" });
    expect(parseRunKey("s_abcd2345@0")).toEqual({ taskId: "s_abcd2345", kind: "auto", t: 0 });
    for (const bad of ["s_abcd2345@01", "s_abcd2345@-1", "s_ABCD2345@1", "s_abcd2345@m-XYZ", "x@1", "s_abcd2345"])
      expect(parseRunKey(bad)).toBeUndefined();
    expect(() => autoRunKey("bad", 1)).toThrow(TypeError);
    expect(() => autoRunKey("s_abcd2345", 1.5)).toThrow(TypeError);
    expect(() => autoRunKey("s_abcd2345", -1)).toThrow(TypeError);
    expect(() => manualRunKey("s_abc", REQ)).toThrow(TypeError);
  });

  it("task id pattern is s_ + 8 lowercase base32", () => {
    expect(SCHED_TASK_ID_RE.test("s_abcd2345")).toBe(true);
    for (const bad of ["s_abcd234", "s_abcd23456", "s_abcd2341", "s_abcd2348", "S_abcd2345", "s_ABCD2345"])
      expect(SCHED_TASK_ID_RE.test(bad)).toBe(false);
    expect(SCHED_RUN_KEY_RE.test(manualRunKey("s_abcd2345", "x"))).toBe(true);
  });
});

describe("vocabularies", () => {
  it("run states: six non-terminal, the rest terminal", () => {
    const nonTerminal = SCHEDULE_RUN_STATES.filter((s) => !isTerminalRunState(s));
    expect(nonTerminal).toEqual(["dispatching", "running", "queued", "dispatched", "bound", "aborting"]);
    expect(SCHEDULE_RUN_STATES.filter(isTerminalRunState)).toEqual([
      "completed",
      "failed",
      "timed_out",
      "aborted",
      "refused",
      "settled",
      "continued",
      "unknown",
      "dropped",
    ]);
  });

  it("error codes are exactly §10.2's", () => {
    expect([...SCHEDULE_ERROR_CODES]).toEqual([
      "E_DISABLED",
      "E_MODE",
      "E_EPHEMERAL",
      "E_CHILD",
      "E_SECURE",
      "E_LIMIT",
      "E_INVALID",
      "E_REV",
      "E_UNAPPROVED",
      "E_NOT_OWNER",
      "E_OVERLAP",
      "E_BUSY",
      "E_DEGRADED",
      "E_UNSUPPORTED",
    ]);
  });

  it("thinking levels mirror core/types THINKING_LEVELS (protocol cannot import core)", () => {
    expect([...SCHEDULE_THINKING_LEVELS]).toEqual([...THINKING_LEVELS]);
  });

  it("emptyStateFile is a valid empty v1 ledger", () => {
    expect(emptyStateFile("sid-1")).toEqual({
      v: 1,
      sessionId: "sid-1",
      rev: 0,
      tasks: [],
      occ: {},
      manualTotal: {},
      runs: [],
      pendingReports: [],
      reportStats: { droppedIndexCap: 0 },
      manualReqs: {},
      digest: { shownMissedTotal: {}, shownRunsThrough: 0 },
    });
    expect(emptyStateFile("a")).not.toBe(emptyStateFile("a"));
  });
});
