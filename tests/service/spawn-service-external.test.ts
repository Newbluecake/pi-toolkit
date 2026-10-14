import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSpawnService } from "../../src/service/spawn-service.js";
import type { AgentTypeConfig, RunOutcome, RunSnapshot, SpawnRequest } from "../../src/core/types.js";
import type { Runner, SlotPool } from "../../src/service/ports.js";
import type { ModelCandidate } from "../../src/config/model-hint.js";
import { formatUnknownModelError } from "../../src/config/model-hint.js";
import type { ExternalAgentsPort } from "../../src/external-agent/types.js";
import {
  MSG_EXPERTS_UNSUPPORTED,
  MSG_READONLY_DOMAIN,
  MSG_RESUME_ISOLATION,
  msgResumeCrossRuntime,
  msgResumeDisabled,
} from "../../src/external-agent/messages.js";

const plain: AgentTypeConfig = { name: "worker", description: "w", systemPrompt: "", promptMode: "append" };
const piDefault: AgentTypeConfig = { ...plain, name: "pidef", model: { provider: "anthropic", id: "opus" } };
const TYPES = [plain, piDefault];
const REGISTRY: ModelCandidate[] = [{ provider: "anthropic", id: "opus" }];
const DROID = { provider: "droid", id: "gpt-6-luna" };

let tmp: string;
let agentDir: string;
let extFile: string;
let piFile: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "spawn-ext-"));
  agentDir = join(tmp, "agent");
  mkdirSync(join(agentDir, "external-agent", "droid", "sessions"), { recursive: true });
  extFile = join(agentDir, "external-agent", "droid", "sessions", "abcdefgh1.jsonl");
  piFile = join(tmp, "pi-session.jsonl");
  writeFileSync(extFile, "{}\n");
  writeFileSync(piFile, "{}\n");
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function outcome(runId: string): RunOutcome {
  return {
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
}
function snap(runId: string, sessionFile: string, model?: { provider: string; id: string }): RunSnapshot {
  const o = outcome(runId);
  return {
    runId,
    generation: 1,
    status: "completed",
    phase: "settled",
    deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
    diag: { ...o.diag, sessionFile, label: runId.toLowerCase(), ...(model ? { model } : {}) },
    outcome: o,
    updatedAt: 1,
  };
}
interface PortOpts {
  unavailable?: string;
  exists?: boolean | undefined;
}
function port(o: PortOpts = {}): ExternalAgentsPort {
  return {
    owns: (p) => p === "droid",
    exists: () => ("exists" in o ? o.exists : true),
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
function harness(opts: { external?: ExternalAgentsPort; agentDir?: string; durable?: RunSnapshot[] }) {
  const runs: Array<{ runId: string; model?: unknown }> = [];
  const labels: string[] = [];
  const runner: Runner = {
    run: async (spec) => {
      runs.push({ runId: spec.runId, model: (spec as { model?: unknown }).model });
      return outcome(spec.runId);
    },
  };
  const pool: SlotPool = { acquire: async (runId) => ({ ok: true, ticket: { runId, release() {} } }) };
  const service = createSpawnService({
    types: {
      get: (n: string) => TYPES.find((t) => t.name === n),
      list: () => TYPES,
      reload: async () => ({ types: TYPES, errors: [] }),
    },
    pool,
    runner,
    now: () => 0,
    availableModels: () => REGISTRY,
    modelExists: (m) => REGISTRY.some((c) => c.provider === m.provider && c.id === m.id),
    onLabel: (l) => labels.push(l),
    ...(opts.external ? { external: opts.external } : {}),
    ...(opts.agentDir ? { agentDir: opts.agentDir } : {}),
    ...(opts.durable ? { durableRecords: () => opts.durable! } : {}),
  });
  return { service, runs, labels };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const msg = (r: unknown) => (r as { error?: { message: string } }).error?.message ?? "";
async function expectRejected(h: ReturnType<typeof harness>, req: SpawnRequest, text: string) {
  const r = await h.service.spawn(req);
  await flush();
  expect(msg(r)).toBe(text);
  expect((r as { error: { kind: string; retryable: boolean } }).error).toMatchObject({
    kind: "config",
    retryable: false,
  });
  // zero side effects
  expect(h.runs).toEqual([]);
  expect(h.labels).toEqual([]);
  expect(h.service.snapshots()).toEqual([]);
  expect(h.service.runningIds()).toEqual([]);
  expect(h.service.slots().inUse).toBe(0);
}

describe("spawn admission: external (droid) gate", () => {
  it("readonly toolDomain + droid ⇒ MSG_READONLY_DOMAIN, zero side effects", async () => {
    const h = harness({ external: port(), agentDir });
    await expectRejected(
      h,
      { type: "worker", prompt: "x", modelOverride: DROID, toolDomain: "readonly" },
      MSG_READONLY_DOMAIN,
    );
  });
  it("unavailableReason ⇒ rejected with that reason", async () => {
    const h = harness({ external: port({ unavailable: "drift!" }), agentDir });
    await expectRejected(h, { type: "worker", prompt: "x", modelOverride: DROID }, "drift!");
  });
  it("exists===false ⇒ unknownModelMessage; exists undefined ⇒ admitted (fail-open)", async () => {
    const h = harness({ external: port({ exists: false }), agentDir });
    await expectRejected(h, { type: "worker", prompt: "x", modelOverride: DROID }, "unknown droid model gpt-6-luna");
    const h2 = harness({ external: port({ exists: undefined }), agentDir });
    const r = await h2.service.spawn({ type: "worker", prompt: "x", modelOverride: DROID });
    await flush();
    expect("runId" in r).toBe(true);
    expect(h2.runs[0]?.model).toEqual(DROID);
  });
  it("consultExperts / forkSessionFrom ⇒ MSG_EXPERTS_UNSUPPORTED", async () => {
    const h = harness({ external: port(), agentDir });
    await expectRejected(
      h,
      {
        type: "worker",
        prompt: "x",
        modelOverride: DROID,
        consultExperts: [{ runId: "r_X", sessionFile: piFile, agentType: "worker" }],
      },
      MSG_EXPERTS_UNSUPPORTED,
    );
    await expectRejected(
      h,
      { type: "worker", prompt: "x", modelOverride: DROID, forkSessionFrom: piFile, parentRunId: "r_P" },
      MSG_EXPERTS_UNSUPPORTED,
    );
  });
  it("droid model + resume of a pi session ⇒ msgResumeCrossRuntime(pi)", async () => {
    const h = harness({
      external: port(),
      agentDir,
      durable: [snap("r_PISESS01", piFile, { provider: "anthropic", id: "opus" })],
    });
    await expectRejected(
      h,
      { type: "worker", prompt: "x", modelOverride: DROID, resumeFrom: "r_PISESS01" },
      msgResumeCrossRuntime("r_PISESS01", "pi"),
    );
  });
  it("external resume + isolation ⇒ MSG_RESUME_ISOLATION", async () => {
    const h = harness({ external: port(), agentDir, durable: [snap("r_EXTSESS01", extFile, DROID)] });
    await expectRejected(
      h,
      { type: "worker", prompt: "x", resumeFrom: "r_EXTSESS01", isolation: "worktree" },
      MSG_RESUME_ISOLATION,
    );
  });
  it("external resume without override inherits the droid model (type default pi model ignored)", async () => {
    const h = harness({ external: port(), agentDir, durable: [snap("r_EXTSESS01", extFile, DROID)] });
    const r = await h.service.spawn({ type: "pidef", prompt: "x", resumeFrom: "r_EXTSESS01" });
    await flush();
    expect("runId" in r).toBe(true);
    expect(h.runs[0]?.model).toEqual(DROID);
  });
  it("external resume with a droid override uses it; with a pi override ⇒ cross-runtime rejection", async () => {
    const other = { provider: "droid", id: "kimi-k3" };
    const h = harness({ external: port(), agentDir, durable: [snap("r_EXTSESS01", extFile, DROID)] });
    const r = await h.service.spawn({ type: "worker", prompt: "x", resumeFrom: "r_EXTSESS01", modelOverride: other });
    await flush();
    expect("runId" in r).toBe(true);
    expect(h.runs[0]?.model).toEqual(other);
    const h2 = harness({ external: port(), agentDir, durable: [snap("r_EXTSESS01", extFile, DROID)] });
    await expectRejected(
      h2,
      { type: "worker", prompt: "x", resumeFrom: "r_EXTSESS01", modelOverride: { provider: "anthropic", id: "opus" } },
      msgResumeCrossRuntime("r_EXTSESS01", "droid"),
    );
  });
  it("port absent + external session file ⇒ msgResumeDisabled (structural evidence)", async () => {
    const h = harness({ agentDir, durable: [snap("r_EXTSESS01", extFile, DROID)] });
    await expectRejected(
      h,
      { type: "worker", prompt: "x", resumeFrom: "r_EXTSESS01" },
      msgResumeDisabled("r_EXTSESS01"),
    );
  });
  it("port absent: droid/x error is byte-identical to the pre-feature unknown-model error", async () => {
    const h = harness({});
    const r = await h.service.spawn({ type: "worker", prompt: "x", modelOverride: DROID });
    expect(msg(r)).toBe(formatUnknownModelError(DROID, REGISTRY, {}));
    expect(h.runs).toEqual([]);
    // agentDir alone (no port) must not change it either
    const h2 = harness({ agentDir });
    expect(msg(await h2.service.spawn({ type: "worker", prompt: "x", modelOverride: DROID }))).toBe(msg(r));
  });
  it("pi models and pi resume are unaffected when the port exists", async () => {
    const h = harness({
      external: port(),
      agentDir,
      durable: [snap("r_PISESS01", piFile, { provider: "anthropic", id: "opus" })],
    });
    const a = await h.service.spawn({ type: "pidef", prompt: "x" });
    const b = await h.service.spawn({ type: "pidef", prompt: "x", resumeFrom: "r_PISESS01" });
    await flush();
    expect("runId" in a && "runId" in b).toBe(true);
  });
});
