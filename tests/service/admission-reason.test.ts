import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { markLiveSessionFile, releaseLiveSessionFile } from "../../src/core/live-session-files.js";
import type { AgentTypeConfig, AdmissionReason, RunOutcome, RunSnapshot, SpawnRequest } from "../../src/core/types.js";
import type { ExternalAgentsPort } from "../../src/external-agent/types.js";
import type { Runner, SlotPool } from "../../src/service/ports.js";
import { createSpawnService } from "../../src/service/spawn-service.js";

/**
 * fabric-cross-session plan v3 §4.1/§4.6 (S0): every spawn-service ADMISSION rejection carries a typed
 * `error.reason`. This is annotation only — `kind`/`message`/`retryable` stay exactly what they were (pinned by the
 * existing admission suites + the wake-off golden); this table pins the reason of each of the 24 `return { error }`
 * sites in `spawn()`, plus a static guard so a future branch cannot be added without one.
 */
const plain: AgentTypeConfig = { name: "worker", description: "w", systemPrompt: "", promptMode: "append" };
const hinted: AgentTypeConfig = { ...plain, name: "hinted", modelHint: "no-such-model" };
const parentType: AgentTypeConfig = { ...plain, name: "parent", canSpawn: ["worker"] };
const TYPES = [plain, hinted, parentType];
const DROID = { provider: "droid", id: "gpt-6-luna" };
const PI_MODEL = { provider: "anthropic", id: "opus" };

let tmp: string;
let agentDir: string;
let extFile: string;
let piFile: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "admission-reason-"));
  agentDir = join(tmp, "agent");
  mkdirSync(join(agentDir, "external-agent", "droid", "sessions"), { recursive: true });
  extFile = join(agentDir, "external-agent", "droid", "sessions", "abcdefgh1.jsonl");
  piFile = join(tmp, "pi-session.jsonl");
  writeFileSync(extFile, "{}\n");
  writeFileSync(piFile, "{}\n");
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => {
  releaseLiveSessionFile(piFile);
});

function snap(runId: string, sessionFile: string, model?: { provider: string; id: string }): RunSnapshot {
  const outcome: RunOutcome = {
    runId,
    status: "completed",
    turns: 1,
    durationMs: 1,
    diag: {
      createdAt: 0,
      phase: "settled",
      phaseEnteredAt: 1,
      pendingTools: 0,
      turns: 1,
      escalation: [],
      orphaned: false,
      generation: 1,
      degraded: [],
      staleInputs: 0,
      unkillable: [],
    },
  };
  return {
    runId,
    generation: 1,
    status: "completed",
    phase: "settled",
    deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
    diag: { ...outcome.diag, sessionFile, label: runId.toLowerCase(), ...(model ? { model } : {}) },
    outcome,
    updatedAt: 1,
  };
}
function port(o: { unavailable?: string; exists?: boolean; allowlist?: readonly string[] } = {}): ExternalAgentsPort {
  return {
    owns: (p) => p === "droid",
    exists: () => o.exists ?? true,
    modelAllowlistRejection: (r) =>
      o.allowlist !== undefined && !o.allowlist.includes(r.id) ? "droid model not allowed" : undefined,
    unavailableReason: () => o.unavailable,
    unknownModelMessage: (r) => `unknown droid model ${r.id}`,
    advertised: () => [],
    ownerOfSessionFile: (f) => (f === extFile ? "droid" : undefined),
    planRun: () => {
      throw new Error("unused");
    },
    pricingFor: () => ({ status: "unpriced", reason: "no_match" }),
    dispose: () => undefined,
  };
}

interface Opts {
  external?: ExternalAgentsPort;
  withAgentDir?: boolean;
  durable?: RunSnapshot[];
  limit?: number;
  quota?: boolean;
  load?: boolean;
  maxNestedDepth?: number;
  modelExists?: boolean;
}
function harness(o: Opts = {}) {
  const hang: Runner = { run: () => new Promise<RunOutcome>(() => undefined) };
  const pool: SlotPool = {
    acquire: async (runId) => ({ ok: true, ticket: { runId, release() {} } }),
    setLimit: () => undefined,
    get stats() {
      return { limit: o.limit ?? 8, inUse: 0, queued: 0, slotless: 0 };
    },
  };
  return createSpawnService({
    types: {
      get: (n: string) => TYPES.find((t) => t.name === n),
      list: () => TYPES,
      reload: async () => ({ types: TYPES, errors: [] }),
    },
    pool,
    runner: hang,
    now: () => 0,
    resolveModelHint: () => undefined,
    availableModels: () => [PI_MODEL],
    modelExists: (m) => (o.modelExists === false ? false : m.provider === "anthropic"),
    ...(o.external ? { external: o.external } : {}),
    ...(o.withAgentDir ? { agentDir } : {}),
    ...(o.durable ? { durableRecords: () => o.durable! } : {}),
    ...(o.quota ? { quotaGate: () => ({ message: "quota exhausted" }) as never } : {}),
    ...(o.load ? { loadGate: () => ({ message: "system overloaded" }) } : {}),
    ...(o.maxNestedDepth !== undefined ? { maxNestedDepth: o.maxNestedDepth } : {}),
  });
}
type Service = ReturnType<typeof harness>;
async function reject(service: Service, req: SpawnRequest) {
  const r = await service.spawn(req);
  if (!("error" in r)) throw new Error(`expected an admission rejection, got run ${r.runId}`);
  return r.error;
}
async function admit(service: Service, req: SpawnRequest) {
  const r = await service.spawn(req);
  if ("error" in r) throw new Error(r.error.message);
  return r;
}

describe("AdmissionReason on every spawn() admission rejection (plan v3 §4.6)", () => {
  const cases: Array<
    [string, AdmissionReason, boolean, () => Promise<{ reason?: AdmissionReason; retryable: boolean; kind: string }>]
  > = [
    [
      "deadlineAt already expired",
      "config",
      false,
      () => reject(harness(), { type: "worker", prompt: "x", deadlineAt: 0 }),
    ],
    [
      "readonly toolDomain + isolation",
      "config",
      false,
      () => reject(harness(), { type: "worker", prompt: "x", toolDomain: "readonly", isolation: "worktree" }),
    ],
    [
      "pool full (reject policy)",
      "pool_full",
      true,
      async () => {
        const s = harness({ limit: 1 });
        await admit(s, { type: "worker", prompt: "a", label: "a" });
        return reject(s, { type: "worker", prompt: "b", label: "b", poolFullPolicy: "reject" });
      },
    ],
    ["unknown agent type", "unknown_type", false, () => reject(harness(), { type: "nope", prompt: "x" })],
    ["unresolvable model hint", "config", false, () => reject(harness(), { type: "hinted", prompt: "x" })],
    [
      "external: resume target is external but the port is absent",
      "config",
      false,
      () =>
        reject(harness({ withAgentDir: true, durable: [snap("r_EXTSESS01", extFile, DROID)] }), {
          type: "worker",
          prompt: "x",
          resumeFrom: "r_EXTSESS01",
        }),
    ],
    [
      "external: pi override on an external resume (cross-runtime)",
      "config",
      false,
      () =>
        reject(harness({ external: port(), withAgentDir: true, durable: [snap("r_EXTSESS01", extFile, DROID)] }), {
          type: "worker",
          prompt: "x",
          resumeFrom: "r_EXTSESS01",
          modelOverride: PI_MODEL,
        }),
    ],
    [
      "external: readonly toolDomain with a droid model",
      "config",
      false,
      () =>
        reject(harness({ external: port(), withAgentDir: true }), {
          type: "worker",
          prompt: "x",
          modelOverride: DROID,
          toolDomain: "readonly",
        }),
    ],
    [
      "external: provider unavailable",
      "external_unavailable",
      false,
      () =>
        reject(harness({ external: port({ unavailable: "drift!" }), withAgentDir: true }), {
          type: "worker",
          prompt: "x",
          modelOverride: DROID,
        }),
    ],
    [
      "external: model not in the allowlist",
      "config",
      false,
      () =>
        reject(harness({ external: port({ allowlist: ["other"] }), withAgentDir: true }), {
          type: "worker",
          prompt: "x",
          modelOverride: DROID,
        }),
    ],
    [
      "external: unknown droid model",
      "config",
      false,
      () =>
        reject(harness({ external: port({ exists: false }), withAgentDir: true }), {
          type: "worker",
          prompt: "x",
          modelOverride: DROID,
        }),
    ],
    [
      "external: droid model resuming a pi session (cross-runtime)",
      "config",
      false,
      () =>
        reject(harness({ external: port(), withAgentDir: true, durable: [snap("r_PISESS01", piFile, PI_MODEL)] }), {
          type: "worker",
          prompt: "x",
          modelOverride: DROID,
          resumeFrom: "r_PISESS01",
        }),
    ],
    [
      "external: resume + isolation",
      "config",
      false,
      () =>
        reject(harness({ external: port(), withAgentDir: true, durable: [snap("r_EXTSESS01", extFile, DROID)] }), {
          type: "worker",
          prompt: "x",
          resumeFrom: "r_EXTSESS01",
          isolation: "worktree",
        }),
    ],
    [
      "strict model unknown to the registry",
      "config",
      false,
      () => reject(harness({ modelExists: false }), { type: "worker", prompt: "x", modelOverride: PI_MODEL }),
    ],
    [
      "quota gate",
      "quota",
      false,
      () => reject(harness({ quota: true }), { type: "worker", prompt: "x", modelOverride: PI_MODEL }),
    ],
    [
      "load gate",
      "load",
      true,
      () => reject(harness({ load: true }), { type: "worker", prompt: "x", loadPolicy: "reject" }),
    ],
    [
      "nested: parent type may not spawn this type",
      "config",
      false,
      async () => {
        const s = harness();
        const parent = await admit(s, { type: "parent", prompt: "p", label: "p" });
        return reject(s, { type: "hinted", prompt: "x", parentRunId: parent.runId, modelOverride: PI_MODEL });
      },
    ],
    [
      "nested: depth exceeded",
      "config",
      false,
      async () => {
        const s = harness({ maxNestedDepth: 0 });
        const parent = await admit(s, { type: "parent", prompt: "p", label: "p" });
        return reject(s, { type: "worker", prompt: "x", parentRunId: parent.runId });
      },
    ],
    [
      "no unique label derivable",
      "config",
      false,
      async () => {
        const s = harness();
        await admit(s, { type: "worker", prompt: "x", label: "dup" });
        for (let i = 2; i <= 999; i++) await admit(s, { type: "worker", prompt: "x", label: "dup" });
        return reject(s, { type: "worker", prompt: "x", label: "dup" });
      },
    ],
    [
      "resume: target not found",
      "config",
      false,
      () => reject(harness(), { type: "worker", prompt: "x", resumeFrom: "missing" }),
    ],
    [
      "resume: target still running",
      "target_running",
      false,
      async () => {
        const s = harness();
        await admit(s, { type: "worker", prompt: "x", label: "busy" });
        return reject(s, { type: "worker", prompt: "again", resumeFrom: "busy" });
      },
    ],
    [
      "resume: session file gone (resolveResume fails)",
      "config",
      false,
      () =>
        reject(harness({ durable: [snap("r_GONE0001", join(tmp, "gone.jsonl"), PI_MODEL)] }), {
          type: "worker",
          prompt: "x",
          resumeFrom: "r_GONE0001",
        }),
    ],
    [
      "resume: session still being closed by the previous stack",
      "session_closing",
      false,
      async () => {
        markLiveSessionFile(piFile);
        return reject(harness({ durable: [snap("r_PISESS01", piFile, PI_MODEL)] }), {
          type: "worker",
          prompt: "x",
          resumeFrom: "r_PISESS01",
        });
      },
    ],
    [
      "resume: another resume of the same session in progress",
      "resume_locked",
      false,
      async () => {
        const s = harness({ durable: [snap("r_PISESS01", piFile, PI_MODEL)] });
        await admit(s, { type: "worker", prompt: "first", resumeFrom: "r_PISESS01" });
        return reject(s, { type: "worker", prompt: "second", resumeFrom: "r_PISESS01" });
      },
    ],
  ];

  it.each(cases)("%s ⇒ reason %s (retryable %s, kind config)", async (_name, reason, retryable, run) => {
    const error = await run();
    expect(error.reason).toBe(reason);
    expect(error.retryable).toBe(retryable);
    expect(error.kind).toBe("config");
  });

  it("covers every rejection site (24) — no reason is accidentally shared by a wrong branch", () => {
    expect(cases).toHaveLength(24);
    const distinct = new Set(cases.map((c) => c[1]));
    expect([...distinct].sort()).toEqual(
      [
        "config",
        "external_unavailable",
        "load",
        "pool_full",
        "quota",
        "resume_locked",
        "session_closing",
        "target_running",
        "unknown_type",
      ].sort(),
    );
  });

  it("static guard: every `retryable:` literal in spawn()'s admission body is paired with a `reason:`", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "service", "spawn-service.ts"),
      "utf8",
    );
    const body = src.slice(src.indexOf("async spawn(req) {"), src.indexOf("successorOf(sessionFile) {"));
    const retryable = (body.match(/retryable: (true|false)/g) ?? []).length;
    const reasons = (body.match(/reason: "/g) ?? []).length;
    // W3 adds the persist-first inbox reservation rejection before any label/tree write.
    expect(retryable).toBe(25);
    expect(reasons).toBe(retryable);
  });

  it("a rejection still creates nothing: no run, label, snapshot or slot (reason is annotation only)", async () => {
    const s = harness();
    const error = await reject(s, { type: "nope", prompt: "x", label: "ghost" });
    expect(error).toEqual({
      kind: "config",
      message: expect.stringContaining("unknown agent type: nope"),
      retryable: false,
      reason: "unknown_type",
    });
    expect(s.getLabel?.("ghost")).toBeUndefined();
    expect(s.snapshots()).toEqual([]);
    expect(s.runningIds()).toEqual([]);
  });
});
