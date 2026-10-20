import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InboxPort } from "../../src/fabric/wake.js";
import { createSpawnService } from "../../src/service/spawn-service.js";
import type { Runner, RunnerSpec } from "../../src/service/ports.js";
import type { RunOutcome } from "../../src/core/types.js";
import { snapshot, target, sender } from "../helpers/fabric-inbox.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function rig(inbox?: InboxPort, impl?: Runner["run"]) {
  const dir = mkdtempSync(join(tmpdir(), "w3-spawn-"));
  dirs.push(dir);
  const file = join(dir, "owned.jsonl");
  writeFileSync(file, "session");
  const previous = snapshot(target, { status: "completed", phase: "settled" });
  previous.diag.sessionFile = file;
  const specs: RunnerSpec[] = [];
  const run: Runner["run"] = (spec, cb) => {
    specs.push(spec);
    return impl ? impl(spec, cb) : new Promise(() => undefined);
  };
  const worker = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" as const };
  const service = createSpawnService({
    types: {
      get: () => worker,
      list: () => [worker],
      reload: async () => ({ types: [worker], errors: [] }),
      configHashOf: () => undefined,
    },
    pool: { acquire: async (runId) => ({ ok: true, ticket: { runId, release() {} } }) },
    runner: { run },
    durableRecords: () => [previous],
    ...(inbox ? { inbox } : {}),
    now: () => 0,
  });
  return { service, specs, file };
}
const outcome = (spec: RunnerSpec): RunOutcome => ({
  runId: spec.runId,
  status: "failed",
  turns: 0,
  durationMs: 0,
  diag: snapshot().diag,
});

describe("W3 SpawnService inbox seam", () => {
  it("reserves synchronously before start and appends block with trusted trackInput, never fabricates wakeOrigin", async () => {
    let beforeStart = false;
    const inbox: InboxPort = {
      onResumeAdmitted: vi.fn((a) => {
        expect(h.specs).toHaveLength(0);
        expect(h.service.successorOf(a.sessionFile)).toBe(a.runId);
        beforeStart = true;
        return { trackInput: true, block: "[fabric inbox n=1] parked" };
      }),
      onRunGone: vi.fn(),
    };
    const h = rig(inbox);
    const pending = h.service.spawn({ type: "worker", prompt: "human request", resumeFrom: target });
    expect(beforeStart).toBe(true);
    expect(h.specs).toHaveLength(1);
    const result = await pending;
    expect(result).toHaveProperty("runId");
    expect(h.specs[0]?.request).toMatchObject({
      prompt: "human request\n\n[fabric inbox n=1] parked",
      trackInput: true,
    });
    expect(h.specs[0]?.request).not.toHaveProperty("wakeOrigin");
  });
  it("a failed trigger reservation rejects BEFORE label/tree/slot writes and releases BOTH resume owner keys", async () => {
    let fail = true;
    const inbox: InboxPort = {
      onResumeAdmitted: vi.fn(() =>
        fail ? { trackInput: false, persistFailed: true as const } : { trackInput: false },
      ),
      onRunGone: vi.fn(),
    };
    const h = rig(inbox);
    const req = {
      type: "worker",
      prompt: "trigger",
      resumeFrom: target,
      label: "same",
      wakeOrigin: {
        by: sender,
        key: "key" as never,
        level: 1,
        via: "fabric" as const,
        trigger: { key: "key" as never, claimToken: "token" },
      },
    };
    expect(await h.service.spawn(req)).toMatchObject({ error: { reason: "inbox_persist_failed", retryable: true } });
    expect(h.service.successorOf(h.file)).toBeUndefined();
    expect(h.service.getLabel?.("same")).toBeUndefined();
    expect(h.service.snapshots()).toEqual([]);
    expect(h.specs).toHaveLength(0);
    expect(h.service.slots().inUse).toBe(0);
    fail = false;
    expect(await h.service.spawn(req)).toMatchObject({ runId: expect.any(String), label: "same" });
  });
  it("ordinary resume is not blocked by reservation failure; caller trackInput is stripped with/without wake", async () => {
    for (const on of [false, true]) {
      const inbox: InboxPort = { onResumeAdmitted: () => ({ trackInput: false }), onRunGone() {} };
      const h = rig(on ? inbox : undefined);
      expect(
        await h.service.spawn({ type: "worker", prompt: "human", resumeFrom: target, trackInput: true }),
      ).toHaveProperty("runId");
      expect(h.specs[0]?.request.prompt).toBe("human");
      expect(h.specs[0]?.request).not.toHaveProperty("trackInput");
    }
  });
  it("new dispatch never calls the resume inbox hook, even if caller forged trackInput", async () => {
    const inbox: InboxPort = { onResumeAdmitted: vi.fn(() => ({ trackInput: true, block: "bad" })), onRunGone() {} };
    const h = rig(inbox);
    await h.service.spawn({ type: "worker", prompt: "new", trackInput: true });
    expect(inbox.onResumeAdmitted).not.toHaveBeenCalled();
    expect(h.specs[0]?.request).not.toHaveProperty("trackInput");
  });
  it("runner throw with no snapshot calls onRunGone; a later throw preserves evidence in fallback terminal", async () => {
    const gone = vi.fn();
    const inbox: InboxPort = { onResumeAdmitted: () => ({ trackInput: true, block: "inbox" }), onRunGone: gone };
    const before = rig(inbox, async () => {
      throw new Error("before runtime");
    });
    const a = await before.service.spawn({ type: "worker", prompt: "p", resumeFrom: target });
    expect(gone).toHaveBeenCalledOnce();
    expect(a).toHaveProperty("runId");
    const after = rig(inbox, async (spec, cb) => {
      const s = snapshot(spec.runId);
      s.diag.inputAcceptedAt = 0;
      s.diag.promptDispatchedAt = 0;
      cb?.onSnapshot?.(s);
      throw new Error("after acceptance");
    });
    const b = await after.service.spawn({ type: "worker", prompt: "p", resumeFrom: target });
    expect(gone).toHaveBeenCalledOnce();
    if (!("runId" in b)) throw new Error("rejected");
    expect(after.service.snapshots().find((s) => s.runId === b.runId)?.diag).toMatchObject({
      inputAcceptedAt: 0,
      promptDispatchedAt: 0,
    });
  });
  it("normal runner settlement still releases successor ownership", async () => {
    const h = rig(undefined, async (spec) => outcome(spec));
    await h.service.spawn({ type: "worker", prompt: "p", resumeFrom: target });
    expect(h.service.successorOf(h.file)).toBeUndefined();
  });
});
