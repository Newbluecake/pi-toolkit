import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJobRecord } from "../../../src/bash/types.js";
import type { JobRecord } from "../../../src/bash/types.js";
import { createPortRegistry } from "../../../src/reflex/ports/index.js";
import type { RunSnapshot, RunStatus } from "../../../src/core/types.js";
import type { ProviderVerdict } from "../../../src/quota/ladder.js";
import { deps, env } from "./helpers.js";

const job = (patch: Partial<JobRecord> = {}): JobRecord => ({
  ...createJobRecord({
    jobId: "b_one",
    command: "npm test",
    cwd: "/tmp",
    sessionId: "s",
    hostPid: 1,
    logPath: "/tmp/log",
    createdAt: 0,
  }),
  status: "running",
  spawnedAt: 5000,
  ...patch,
});
const run = (status: RunStatus, patch: Partial<RunSnapshot["diag"]> = {}): RunSnapshot => ({
  runId: "r_one",
  generation: 1,
  status,
  phase: "model_turn",
  deadlines: {},
  diag: { createdAt: 0, phase: "model_turn", phaseEnteredAt: 0, pendingTools: 0, turns: 0, ...patch },
  updatedAt: 0,
});
const verdict: ProviderVerdict = {
  provider: "kimi-coding",
  level: 0,
  windows: [{ scope: "5h", usedPct: 25, level: 0, reason: "none" }],
  fetchedAt: 0,
  stale: false,
  demoted: false,
};
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

describe("read-only registry", () => {
  it("registers exactly four ports; capabilities reflect dependency replacement", () => {
    let on = false;
    const registry = createPortRegistry(
      deps({
        bashJobs: () => (on ? { list: () => [] } : undefined),
        fleet: () => (on ? { list: () => [] } : undefined),
        quota: () => (on ? { verdicts: () => [] } : undefined),
        sessionDir: () => "/tmp",
      }),
    );
    expect([...registry.capabilities()]).toEqual(["git"]);
    on = true;
    expect([...registry.capabilities()]).toEqual(["git", "bashJobs", "fleet", "quota"]);
    on = false;
    expect([...registry.capabilities()]).toEqual(["git"]);
    for (const id of ["jobs.list", "fleet.status", "quota.summary", "git.status"] as const)
      expect(registry.get(id)).toMatchObject({ id, version: 1 });
    expect(registry.get("sessions.recent")).toBeUndefined();
  });
  it("reports unavailable managers and empty snapshots without guessing", async () => {
    const missing = createPortRegistry(deps());
    for (const id of ["jobs.list", "fleet.status", "quota.summary"] as const)
      expect(await missing.get(id)!.run(env())).toMatchObject({ kind: "unavailable" });
    const empty = createPortRegistry(
      deps({
        bashJobs: () => ({ list: () => [] }),
        fleet: () => ({ list: () => [] }),
        quota: () => ({ verdicts: () => [] }),
      }),
    );
    expect(await empty.get("jobs.list")!.run(env())).toEqual({
      kind: "ok",
      lines: [],
      facts: { running: 0, unread: 0, total: 0 },
      truncated: false,
    });
    expect(await empty.get("fleet.status")!.run(env())).toMatchObject({ kind: "ok", lines: [], truncated: false });
    expect(await empty.get("quota.summary")!.run(env())).toEqual({ kind: "uncertain", reason: "no trusted snapshot" });
  });
  it("jobs partitions staged/running vs finished unnotified, caps 8+8 and redacts before preview", async () => {
    const rows = [
      job(),
      job({ jobId: "b_done", status: "completed", endedAt: 10000, exitCode: 0 }),
      job({ jobId: "b_read", status: "failed", notifiedAt: 10000 }),
    ];
    const registry = createPortRegistry(deps({ bashJobs: () => ({ list: () => rows }) }));
    expect(await registry.get("jobs.list")!.run(env())).toEqual({
      kind: "ok",
      lines: [
        "bash jobs (1 running, 1 finished unread):",
        "  b_one running 1m00s  npm test",
        "  b_done completed (exit 0) 5s  npm test",
      ],
      facts: { running: 1, unread: 1, total: 3 },
      truncated: false,
    });
    rows.push(
      ...Array.from({ length: 9 }, () => job({ status: "staged", command: "echo token=secret\n" + "x".repeat(90) })),
      ...Array.from({ length: 9 }, () => job({ status: "orphaned" })),
    );
    const out = await registry.get("jobs.list")!.run(env());
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("wrong outcome");
    expect(out.lines).toHaveLength(17);
    expect(out.facts).toEqual({ running: 10, unread: 10, total: 21 });
    expect(out.truncated).toBe(true);
    expect(out.lines.join("\n")).toContain("[REDACTED]");
    expect(out.lines.join("\n")).not.toContain("token=secret");
  });
  it("fleet counts every status, lists only active first eight, uses type/ID fallback", async () => {
    const statuses: RunStatus[] = [
      "queued",
      "starting",
      "running",
      "stopping",
      "completed",
      "failed",
      "timed_out",
      "aborted",
    ];
    const rows = statuses.map((s) => run(s));
    rows[0] = run("queued", { label: "test", enqueuedAt: 5000 });
    rows[1] = run("starting", { agentType: "consult:main-snapshot", startedAt: 64000 });
    const registry = createPortRegistry(deps({ fleet: () => ({ list: () => rows }) }));
    const out = await registry.get("fleet.status")!.run(env());
    expect(out).toMatchObject({ kind: "ok", facts: Object.fromEntries(statuses.map((s) => [s, 1])), truncated: false });
    if (out.kind !== "ok") throw new Error("wrong outcome");
    expect(out.lines.slice(1)).toEqual([
      "test · queued · 1m00s",
      "main · starting · 1s",
      "r_one · running · 1m05s",
      "r_one · stopping · 1m05s",
    ]);
    rows.push(...Array.from({ length: 9 }, () => run("running")));
    expect(await registry.get("fleet.status")!.run(env())).toMatchObject({ truncated: true });
    const capped = await registry.get("fleet.status")!.run(env());
    if (capped.kind !== "ok") throw new Error("wrong outcome");
    expect(capped.lines).toHaveLength(9);
  });
  it("quota uses trusted verdicts with injected now and existing render format", async () => {
    const verdicts = vi.fn(() => [verdict, { ...verdict, provider: "zai" as const, windows: [] }]);
    const registry = createPortRegistry(deps({ quota: () => ({ verdicts }) }));
    expect(await registry.get("quota.summary")!.run(env())).toEqual({
      kind: "ok",
      lines: ["kimi-coding 5h 25%", "zai"],
      facts: { providers: 2 },
      truncated: false,
    });
    expect(verdicts).toHaveBeenCalledTimes(1);
    expect(verdicts).toHaveBeenCalledWith(65000);
  });
  it("all ports only call read methods and never filesystem writes/network", async () => {
    const writes = ["writeFileSync", "mkdirSync", "appendFileSync", "renameSync", "unlinkSync", "rmSync"] as const;
    const spies = writes.map((key) => vi.spyOn(fs, key));
    const asyncWrites = ["writeFile", "mkdir", "appendFile", "rename", "unlink", "rm"] as const;
    const asyncSpies = asyncWrites.map((key) => vi.spyOn(fs.promises, key));
    // Node builtins' named ESM bindings must see the default-export spies too.
    syncBuiltinESMExports();
    const fetch = vi.spyOn(globalThis, "fetch");
    const calls: string[] = [];
    const refresh = vi.fn();
    const only = <T extends object>(name: string, value: T): T =>
      new Proxy(value, {
        get(target, key, receiver) {
          calls.push(`${name}.${String(key)}`);
          return Reflect.get(target, key, receiver);
        },
      });
    const state = { jobs: [job()], fleet: [run("running")], quota: [verdict] };
    const before = structuredClone(state);
    const registry = createPortRegistry(
      deps({
        bashJobs: () => only("jobs", { list: () => state.jobs }),
        fleet: () => only("fleet", { list: () => state.fleet }),
        quota: () => only("quota", { verdicts: () => state.quota, refreshIfStale: refresh }),
      }),
    );
    for (const id of ["jobs.list", "fleet.status", "quota.summary", "git.status"] as const)
      expect(await registry.get(id)!.run(env())).toMatchObject({ kind: "ok" });
    expect(calls).toEqual(["jobs.list", "fleet.list", "quota.verdicts"]);
    expect(state).toEqual(before);
    for (const spy of [...spies, ...asyncSpies]) expect(spy).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});
