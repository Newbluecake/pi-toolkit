import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, type ConsultSettings } from "../../src/config/settings.js";
import type { RunId, RunSnapshot, SpawnRequest } from "../../src/core/types.js";
import type { QueryService } from "../../src/service/query-service.js";
import type { SpawnService } from "../../src/service/spawn-service.js";
import { wireConsult } from "../../src/consult/index.js";
import { createConsultSpawnPort, type ConsultForkStore } from "../../src/consult/tool.js";
import {
  FORK_TTL_MS,
  forkExpertSession,
  removeForkFile,
  resolveForkCwd,
  sweepForkDir,
} from "../../src/consult/fork-store.js";

/**
 * wireConsult assembly tests (consult plan §9 T-16/T-20 + port semantics of
 * T-5): the dispatch-time resolver's live∪index semantics (same label across
 * reload generations ⇒ ambiguous), the narrow port's owned-runId rules
 * (abortRun maps to abort(runId, "user_stop"), §15 #1), the concurrency
 * caps, dispatchSnapshot fan-out, and onReaped's consult-dir-scoped delete.
 */

const CONSULT_DIR = join(tmpdir(), "consult-wire-test-forkdir");
const FORK_FILE = join(CONSULT_DIR, "fork-1.jsonl");

let tmp: string;
let oldExpertFile: string;
let newExpertFile: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "consult-wire-"));
  oldExpertFile = join(tmp, "old-expert.jsonl");
  newExpertFile = join(tmp, "new-expert.jsonl");
  writeFileSync(oldExpertFile, "{}\n", "utf8");
  writeFileSync(newExpertFile, "{}\n", "utf8");
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function snapshot(opts: {
  runId: RunId;
  status?: RunSnapshot["status"];
  sessionFile?: string;
  label?: string;
  agentType?: string;
  model?: { provider: string; id: string };
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}): RunSnapshot {
  return {
    runId: opts.runId,
    generation: 1,
    status: opts.status ?? "completed",
    phase: "settled",
    deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
    diag: {
      createdAt: 0,
      phase: "settled",
      phaseEnteredAt: 0,
      pendingTools: 0,
      turns: 1,
      escalation: [],
      orphaned: false,
      generation: 1,
      degraded: [],
      staleInputs: 0,
      unkillable: [],
      ...(opts.sessionFile !== undefined ? { sessionFile: opts.sessionFile } : {}),
      ...(opts.label !== undefined ? { label: opts.label } : {}),
      ...(opts.agentType !== undefined ? { agentType: opts.agentType } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.contextUsage !== undefined ? { contextUsage: opts.contextUsage } : {}),
    },
    updatedAt: 1000,
  };
}

function fakeQuery(snapshots: readonly RunSnapshot[]): QueryService {
  return {
    get: (id) => snapshots.find((s) => s.runId === id),
    list: () => [...snapshots],
    wait: async () => ({ ok: false as const, reason: "wait_timeout" as const }),
    waitAll: async () => ({ settled: [], pending: [] }),
    steer: async () => ({ ok: false as const, reason: "not_running" as const }),
    setModel: async () => ({ ok: false as const, reason: "not_running" as const }),
    stop: async () => ({ ok: false as const, reason: "unknown_run" as const }),
    extendTimeout: () => ({ ok: false as const, reason: "unsupported" as const }),
  };
}

function forkStoreStub(opts: { removed?: string[] } = {}): ConsultForkStore {
  return {
    forkExpertSession: () => ({ ok: true, path: FORK_FILE }),
    removeForkFile: (path) => {
      opts.removed?.push(path);
    },
  };
}

function makeSpawnService(
  behaviour: {
    spawnResult?: { runId: RunId } | { error: { kind: "config"; message: string; retryable: false } };
    outcome?: unknown;
  } = {},
) {
  const calls: SpawnRequest[] = [];
  const aborts: Array<{ runId: RunId; cause?: string }> = [];
  const defaultOutcome = {
    runId: "r_CONSULTX",
    status: "completed" as const,
    text: "answer",
    turns: 1,
    durationMs: 1,
    diag: {
      createdAt: 0,
      phase: "settled" as const,
      phaseEnteredAt: 0,
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
  const spawnService: Pick<SpawnService, "spawn" | "waitOutcome" | "abort"> = {
    spawn: async (req) => {
      calls.push(req);
      return behaviour.spawnResult ?? { runId: "r_CONSULTX" };
    },
    waitOutcome: async () =>
      ({ kind: "settled", outcome: behaviour.outcome ?? defaultOutcome }) as Awaited<
        ReturnType<SpawnService["waitOutcome"]>
      >,
    abort: async (runId, cause) => {
      aborts.push({ runId, cause });
      return true;
    },
  };
  return { spawnService, calls, aborts };
}

function wiring(opts: {
  live?: readonly RunSnapshot[];
  entries?: readonly unknown[];
  settings?: Partial<ConsultSettings>;
  forkStore?: ConsultForkStore;
  spawnService?: Pick<SpawnService, "spawn" | "waitOutcome" | "abort">;
}) {
  return wireConsult({
    settings: () => ({ ...DEFAULT_SETTINGS.consult, ...opts.settings }),
    query: fakeQuery(opts.live ?? []),
    spawnService: opts.spawnService ?? makeSpawnService().spawnService,
    priceOf: () => undefined,
    forkStore: opts.forkStore ?? forkStoreStub(),
    consultDir: CONSULT_DIR,
    ...(opts.entries !== undefined ? { prefetchedEntries: opts.entries } : {}),
  });
}

// T-16 fixture: frozen entry for the OLD expert, a live run reusing its label.
const frozenOldEntry = {
  type: "custom",
  customType: "subagent:run",
  data: snapshot({
    runId: "r_OLDEXPERT",
    label: "explorer",
    agentType: "explorer",
    sessionFile: "REPLACED-IN-BEFOREALL",
    model: { provider: "acme", id: "big" },
    contextUsage: { tokens: 50_000, contextWindow: 200_000, percent: 25 },
  }),
};

describe("wireConsult.resolveExperts: live ∪ index, cross-source ambiguity (T-16/T-20)", () => {
  beforeAll(() => {
    // Point the frozen entry at the real tmp file (it must exist on disk).
    (frozenOldEntry.data as RunSnapshot).diag.sessionFile = oldExpertFile;
  });

  it("same label in live AND index pointing at different runIds throws ambiguous listing both", () => {
    const w = wiring({
      entries: [frozenOldEntry],
      live: [snapshot({ runId: "r_NEWRUN01", label: "explorer", agentType: "scout", sessionFile: newExpertFile })],
    });
    expect(() => w.resolveExperts(["explorer"])).toThrow(/ambiguous expert "explorer".*r_OLDEXPERT/s);
    expect(() => w.resolveExperts(["explorer"])).toThrow(/ambiguous expert "explorer".*r_NEWRUN01/s);
  });

  it("the old run_id still resolves after reload and echoes run_id + agentType (asks the OLD expert)", () => {
    const w = wiring({
      entries: [frozenOldEntry],
      live: [snapshot({ runId: "r_NEWRUN01", label: "explorer", agentType: "scout", sessionFile: newExpertFile })],
    });
    const result = w.resolveExperts(["r_OLDEXPERT"]);
    expect(result.refs).toHaveLength(1);
    expect(result.refs[0]).toMatchObject({
      runId: "r_OLDEXPERT",
      sessionFile: oldExpertFile,
      agentType: "explorer",
      model: { provider: "acme", id: "big" },
      contextTokens: 50_000,
      contextPercent: 25,
    });
    expect(result.lines).toEqual([`expert "r_OLDEXPERT" → run_id r_OLDEXPERT (explorer)`]);
    expect(result.warnings).toEqual([]);
  });

  it("unknown expert throws with a candidate list; running expert resolves as pending with a warning", () => {
    const w = wiring({
      live: [
        snapshot({
          runId: "r_RUNLIVE1",
          status: "running",
          label: "busybee",
          agentType: "worker",
          sessionFile: newExpertFile,
        }),
      ],
    });
    expect(() => w.resolveExperts(["ghost"])).toThrow(/could not resolve the expert whitelist.*ghost.*busybee/s);
    const pending = w.resolveExperts(["busybee"]);
    expect(pending.refs[0]).toMatchObject({ runId: "r_RUNLIVE1", pending: true });
    expect(pending.warnings).toEqual([`⚠ expert "busybee" is still running; consult will nack until it finishes.`]);
  });

  it("an id hit on a running run WITHOUT a session file fails (rememberAgents=false hint)", () => {
    const w = wiring({
      live: [snapshot({ runId: "r_EPHEMERAL", status: "running", label: "eph", agentType: "worker" })],
    });
    expect(() => w.resolveExperts(["r_EPHEMERAL"])).toThrow(/no persisted session.*rememberAgents=false/s);
  });

  it("a session file that vanished from disk fails resolution at dispatch time (review-2 #15④)", () => {
    const w = wiring({
      live: [
        snapshot({ runId: "r_VANISHED1", label: "gone", agentType: "worker", sessionFile: join(tmp, "nope.jsonl") }),
      ],
    });
    expect(() => w.resolveExperts(["gone"])).toThrow(/no longer exists on disk/);
  });

  it("consult runs are excluded from BOTH resolution paths (structural consultDir marker)", () => {
    const consultRunLive = snapshot({
      runId: "r_LIVECONS1",
      label: "consult-abcd",
      agentType: "explorer",
      sessionFile: join(CONSULT_DIR, "fork-x.jsonl"),
    });
    const consultRunFrozen = {
      type: "custom",
      customType: "subagent:run",
      data: snapshot({
        runId: "r_FROZCON01",
        label: "consult-ffff",
        agentType: "explorer",
        sessionFile: join(CONSULT_DIR, "fork-y.jsonl"),
      }),
    };
    const w = wiring({ live: [consultRunLive], entries: [consultRunFrozen] });
    expect(() => w.resolveExperts(["consult-abcd"])).toThrow(/could not resolve the expert whitelist/);
    expect(() => w.resolveExperts(["r_FROZCON01"])).toThrow(/could not resolve the expert whitelist/);
    expect(w.expertIndex.list()).toHaveLength(0);
  });

  it("throws immediately when consult is disabled", () => {
    const w = wiring({ settings: { enabled: false }, live: [] });
    expect(() => w.resolveExperts(["anything"])).toThrow(
      'consult is disabled (consult.enabled=false); remove "experts" or enable it',
    );
  });

  it("unique-prefix ids resolve across the union of both sources", () => {
    const w = wiring({
      entries: [frozenOldEntry],
      live: [snapshot({ runId: "r_OTHERAAA1", label: "solo", agentType: "scout", sessionFile: newExpertFile })],
    });
    expect(w.resolveExperts(["r_OTHERAAA"]).refs[0]!.runId).toBe("r_OTHERAAA1");
  });
});

describe("wireConsult.depsFactory + concurrency caps", () => {
  it("returns undefined when disabled or the whitelist is empty; a tool otherwise", () => {
    const enabled = wiring({});
    expect(enabled.depsFactory("r_A", "/tmp", [])).toBeUndefined();
    expect(
      enabled.depsFactory("r_A", "/tmp", [{ runId: "r_E", sessionFile: "/s.jsonl", agentType: "t" }]),
    ).toBeDefined();
    const disabled = wiring({ settings: { enabled: false } });
    expect(
      disabled.depsFactory("r_A", "/tmp", [{ runId: "r_E", sessionFile: "/s.jsonl", agentType: "t" }]),
    ).toBeUndefined();
  });

  it("caps per-asker in-flight consults at maxConcurrent (second concurrent consult nacks busy)", async () => {
    // Only the FIRST waitOutcome hangs; later ones resolve immediately (the
    // reassignment hazard: a resolver captured per call would leak between runs).
    let releaseWait: (() => void) | undefined;
    const completed = {
      kind: "settled" as const,
      outcome: {
        runId: "r_C1",
        status: "completed" as const,
        text: "answer",
        turns: 1,
        durationMs: 1,
        diag: {
          createdAt: 0,
          phase: "settled" as const,
          phaseEnteredAt: 0,
          pendingTools: 0,
          turns: 1,
          escalation: [],
          orphaned: false,
          generation: 1,
          degraded: [],
          staleInputs: 0,
          unkillable: [],
        },
      },
    };
    const hanging: Pick<SpawnService, "spawn" | "waitOutcome" | "abort"> = {
      spawn: async () => ({ runId: "r_C1" }),
      waitOutcome: () =>
        releaseWait === undefined
          ? new Promise((resolve) => {
              releaseWait = () => resolve(completed);
            })
          : Promise.resolve(completed),
      abort: async () => true,
    };
    const w = wireConsult({
      settings: () => ({ ...DEFAULT_SETTINGS.consult, maxConcurrent: 1 }),
      query: fakeQuery([]),
      spawnService: hanging,
      priceOf: () => undefined,
      forkStore: forkStoreStub(),
      consultDir: CONSULT_DIR,
    });
    const mk = () => w.depsFactory("r_A", "/tmp", [{ runId: "r_E", sessionFile: newExpertFile, agentType: "t" }])!;
    const execTool = (q: string) =>
      mk().execute("c", { expert: "r_E", question: q }, undefined, undefined, undefined as never);
    const first = execTool("q1");
    await Promise.resolve();
    const second = (await execTool("q2")) as { details: { outcome: string } };
    expect(second.details.outcome).toBe("busy");
    releaseWait!();
    const done = (await first) as { details: { outcome: string } };
    expect(done.details.outcome).toBe("completed");
    // After the release, the asker may consult again.
    const third = (await execTool("q3")) as { details: { outcome: string } };
    expect(third.details.outcome).toBe("completed");
  });
});

describe("wireConsult narrow port (T-5)", () => {
  function portHarness() {
    const { spawnService, calls, aborts } = makeSpawnService();
    const owned = new Set<RunId>();
    const watchers = new Map<RunId, Set<(s: RunSnapshot) => void>>();
    const port = createConsultSpawnPort({ spawnService, owned, watchers });
    return { port, calls, aborts, owned, watchers, spawnService };
  }

  it("spawn rejects non-fork / non-ack requests without reaching the spawn service", async () => {
    const h = portHarness();
    const r1 = await h.port.spawn({ type: "t", prompt: "p", expectAck: false, forkSessionFrom: "/f" });
    expect("error" in r1).toBe(true);
    const r2 = await h.port.spawn({ type: "t", prompt: "p", expectAck: true });
    expect("error" in r2).toBe(true);
    expect(h.calls).toHaveLength(0);
  });

  it("waitOutcome rejects a run the port never spawned", async () => {
    const h = portHarness();
    await expect(h.port.waitOutcome("r_FOREIGN")).rejects.toThrow("was not spawned through this port");
  });

  it("abortRun translates turn_cap/cost_cap into abort(runId, 'user_stop') and no-ops foreign ids (§15 #1)", async () => {
    const h = portHarness();
    await h.port.spawn({ type: "t", prompt: "p", expectAck: true, forkSessionFrom: "/f" });
    h.port.abortRun("r_CONSULTX", "turn_cap");
    h.port.abortRun("r_FOREIGN", "cost_cap");
    await Promise.resolve();
    expect(h.aborts).toEqual([{ runId: "r_CONSULTX", cause: "user_stop" }]);
  });

  it("waitOutcome unwraps the settled outcome and releases ownership (subsequent abortRun no-ops)", async () => {
    const h = portHarness();
    await h.port.spawn({ type: "t", prompt: "p", expectAck: true, forkSessionFrom: "/f" });
    const outcome = await h.port.waitOutcome("r_CONSULTX");
    expect(outcome.runId).toBe("r_CONSULTX");
    h.port.abortRun("r_CONSULTX", "turn_cap");
    await Promise.resolve();
    expect(h.aborts).toHaveLength(0);
  });

  it("watchRun only registers for owned runs; unwatch empties the registry entry", async () => {
    const h = portHarness();
    await h.port.spawn({ type: "t", prompt: "p", expectAck: true, forkSessionFrom: "/f" });
    // Foreign run: no-op unsubscribe, nothing registered.
    h.port.watchRun("r_FOREIGN", () => undefined);
    expect(h.watchers.has("r_FOREIGN")).toBe(false);
    const unwatch = h.port.watchRun("r_CONSULTX", () => undefined);
    expect(h.watchers.get("r_CONSULTX")?.size).toBe(1);
    unwatch();
    expect(h.watchers.size).toBe(0);
    expect(h.owned.has("r_CONSULTX")).toBe(true); // waitOutcome not called yet
  });
});

describe("wireConsult.onReaped / sweep", () => {
  it("deletes only fork files under the consult dir, only for fork runs; idempotent and never throws", () => {
    const removed: string[] = [];
    const w = wiring({ forkStore: forkStoreStub({ removed }) });
    w.onReaped("r_X"); // no forkSessionFrom ⇒ nothing
    w.onReaped("r_X", "/elsewhere/evil.jsonl"); // outside consultDir ⇒ refused
    w.onReaped("r_X", FORK_FILE);
    w.onReaped("r_X", FORK_FILE); // idempotent double-reap (late path)
    expect(removed).toEqual([FORK_FILE, FORK_FILE]);
  });

  it("sweep delegates to the fork store when available and never throws when absent", () => {
    const swept: number[] = [];
    const withSweep = wiring({
      forkStore: { ...forkStoreStub(), sweepForkDir: () => swept.push(1) },
    });
    withSweep.sweep();
    expect(swept).toEqual([1]);
    const withoutSweep = wiring({});
    expect(() => withoutSweep.sweep()).not.toThrow();
  });
});

describe("wireConsult.dispatchSnapshot: snapshot fan-out to registered watchers", () => {
  it("feeds the subscribed run mid-flight; unknown ids are ignored", async () => {
    // First waitOutcome hangs until a snapshot has been dispatched, proving
    // dispatchSnapshot → port.watchRun → cap watcher is one live chain.
    let releaseWait: (() => void) | undefined;
    const completed = {
      kind: "settled" as const,
      outcome: {
        runId: "r_CONSULTX",
        status: "completed" as const,
        text: "answer",
        turns: 1,
        durationMs: 1,
        diag: {
          createdAt: 0,
          phase: "settled" as const,
          phaseEnteredAt: 0,
          pendingTools: 0,
          turns: 1,
          escalation: [],
          orphaned: false,
          generation: 1,
          degraded: [],
          staleInputs: 0,
          unkillable: [],
        },
      },
    };
    const spawnService: Pick<SpawnService, "spawn" | "waitOutcome" | "abort"> = {
      spawn: async () => ({ runId: "r_CONSULTX" }),
      waitOutcome: () =>
        new Promise((resolve) => {
          releaseWait = () => resolve(completed);
        }),
      abort: async () => true,
    };
    const w = wireConsult({
      settings: () => DEFAULT_SETTINGS.consult,
      query: fakeQuery([]),
      spawnService,
      priceOf: () => undefined,
      forkStore: forkStoreStub(),
      consultDir: CONSULT_DIR,
    });
    const tool = w.depsFactory("r_ASK", "/tmp", [{ runId: "r_E", sessionFile: newExpertFile, agentType: "t" }])!;
    const pending = tool.execute("c", { expert: "r_E", question: "q" }, undefined, undefined, undefined as never);
    for (let i = 0; i < 10 && releaseWait === undefined; i++) await Promise.resolve();
    // In-flight: snapshots for unrelated runs and for the consult run itself
    // flow through dispatchSnapshot without disturbing the pending consult.
    w.dispatchSnapshot(snapshot({ runId: "r_UNRELATED", status: "running" }));
    w.dispatchSnapshot(snapshot({ runId: "r_CONSULTX", status: "running" }));
    releaseWait!();
    const done = (await pending) as { details: { outcome: string } };
    expect(done.details.outcome).toBe("completed");
  });
});

describe("wireConsult × real fork-store (package B composition)", () => {
  it("runs a full consult with the real forkExpertSession and cleans up via onReaped", async () => {
    // Real expert session via pi's SessionManager (same fixture style as the
    // package-B fork-store tests): header + entries flushed to disk.
    const expertCwd = mkdtempSync(join(tmpdir(), "consult-wire-real-"));
    const mgr = SessionManager.create(expertCwd, join(expertCwd, "sessions"));
    mgr.appendMessage({ role: "user", content: [{ type: "text", text: "expert task" }] });
    mgr.appendMessage({ role: "assistant", content: [{ type: "text", text: "expert context" }] });
    const expertFile = mgr.getSessionFile()!;
    const forkDir = mkdtempSync(join(tmpdir(), "consult-wire-forks-"));
    // The structural consult-run marker uses this dir for BOTH resolution
    // exclusion and deletion scoping.
    const realForkStore: ConsultForkStore = {
      forkExpertSession: (source, fallbackCwd) => forkExpertSession(source, fallbackCwd, forkDir),
      removeForkFile: (path) => {
        removeForkFile(path, forkDir);
      },
      resolveForkCwd,
      sweepForkDir: () => {
        sweepForkDir(forkDir, FORK_TTL_MS);
      },
    };
    const { calls, spawnService, aborts } = makeSpawnService();
    const w = wireConsult({
      settings: () => DEFAULT_SETTINGS.consult,
      query: fakeQuery([]),
      spawnService,
      priceOf: () => undefined,
      forkStore: realForkStore,
      consultDir: forkDir,
    });
    const tool = w.depsFactory("r_ASKER", "/tmp/asker", [
      { runId: "r_EXPERT9", sessionFile: expertFile, agentType: "explorer" },
    ])!;
    const result = (await tool.execute(
      "c",
      { expert: "r_EXPERT9", question: "what did you learn?" },
      undefined,
      undefined,
      undefined as never,
    )) as {
      content: Array<{ text: string }>;
      details: { outcome: string; consultRunId?: string };
    };
    expect(result.details.outcome).toBe("completed");
    expect(aborts).toHaveLength(0);
    const spawnReq = calls[0]!;
    expect(spawnReq.forkSessionFrom).toBeDefined();
    // The real fork landed in the (temp) consult dir and was handed to the run.
    expect(spawnReq.forkSessionFrom!.startsWith(forkDir)).toBe(true);
    expect(spawnReq.cwd).toBe(expertCwd); // header cwd exists ⇒ two-level pick
    // After the run: the fork file still exists (deletion is the runner's
    // onReaped job)…
    expect(existsSync(spawnReq.forkSessionFrom!)).toBe(true);
    // …and onReaped (wired to the same store) removes exactly it.
    w.onReaped("r_CONSULTX", spawnReq.forkSessionFrom);
    expect(existsSync(spawnReq.forkSessionFrom!)).toBe(false);
    rmSync(expertCwd, { recursive: true, force: true });
    rmSync(forkDir, { recursive: true, force: true });
  });
});
