import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExternalAgentsPort } from "../../src/external-agent/types.js";
import type { InboxPort } from "../../src/fabric/wake.js";
import { createSpawnService } from "../../src/service/spawn-service.js";
import type { Runner, RunnerSpec } from "../../src/service/ports.js";
import { snapshot, target } from "../helpers/fabric-inbox.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const inbox: InboxPort = { onResumeAdmitted: () => ({ trackInput: false }), onRunGone() {} };
function rig(
  opts: {
    inbox?: InboxPort;
    quotaGate?: (m: { provider: string; id: string }) => undefined | { message: string };
    external?: Partial<ExternalAgentsPort>;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "w5-spawn-"));
  dirs.push(dir);
  const file = join(dir, "owned.jsonl");
  writeFileSync(file, "session");
  const previous = snapshot(target, { status: "completed", phase: "settled" });
  previous.diag.sessionFile = file;
  const specs: RunnerSpec[] = [];
  const run: Runner["run"] = (spec) => {
    specs.push(spec);
    return new Promise(() => undefined);
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
    ...(opts.inbox ? { inbox: opts.inbox } : {}),
    ...(opts.quotaGate ? { quotaGate: opts.quotaGate as never } : {}),
    ...(opts.external
      ? {
          external: {
            owns: (p: string) => p === "droid",
            exists: () => true,
            unavailableReason: () => undefined,
            unknownModelMessage: () => "unknown",
            advertised: () => [],
            ownerOfSessionFile: () => undefined,
            pricingFor: () => ({}) as never,
            planRun: () => ({}) as never,
            dispose() {},
            ...opts.external,
          } as ExternalAgentsPort,
        }
      : {}),
    now: () => 0,
  });
  return { service, specs, file, dir };
}

describe("W5 spawn admission: wakeExclusion (plan §4.5) — written once, only with the wake inbox wired", () => {
  it("an ordinary run is `none`", async () => {
    const h = rig({ inbox });
    await h.service.spawn({ type: "worker", prompt: "x" });
    expect(h.specs[0]!.request.wakeExclusion).toBe("none");
  });
  it.each([
    ["toolDomain readonly", { toolDomain: "readonly" as const }, "readonly_domain"],
    ["suppressDelivery", { suppressDelivery: true }, "caller_owned"],
    ["expectAck (spawnAndWait: goal verifier, tidy, nested blocking)", { expectAck: true }, "caller_owned"],
    ["callerOwned (workflow child)", { callerOwned: true as const }, "caller_owned"],
  ])("%s ⇒ %s", async (_name, extra, expected) => {
    const h = rig({ inbox });
    await h.service.spawn({ type: "worker", prompt: "x", ...extra });
    expect(h.specs[0]!.request.wakeExclusion).toBe(expected);
  });
  it("a consult fork is consult_fork (and wins over every later cause)", async () => {
    const h = rig({ inbox });
    const parent = await h.service.spawn({ type: "worker", prompt: "parent" });
    if (!("runId" in parent)) throw new Error("parent");
    const fork = join(h.dir, "fork.jsonl");
    writeFileSync(fork, "fork");
    await h.service.spawn({
      type: "worker",
      prompt: "ask",
      parentRunId: parent.runId,
      forkSessionFrom: fork,
      expectAck: true,
    });
    expect(h.specs[1]!.request.wakeExclusion).toBe("consult_fork");
  });
  it("an external (droid) model is external_agent", async () => {
    const h = rig({ inbox, external: {} });
    await h.service.spawn({ type: "worker", prompt: "x", modelOverride: { provider: "droid", id: "m" } });
    expect(h.specs[0]!.request.wakeExclusion).toBe("external_agent");
  });
  it("a resume run is classified from ITS OWN request: a wake-revived/human resume stays revivable", async () => {
    const h = rig({ inbox });
    await h.service.spawn({ type: "worker", prompt: "again", resumeFrom: target });
    expect(h.specs[0]!.request.wakeExclusion).toBe("none");
  });
  it("wake off (no inbox): the field is never written and a caller-forged value is stripped", async () => {
    const h = rig();
    await h.service.spawn({ type: "worker", prompt: "x", wakeExclusion: "none", callerOwned: true });
    expect(h.specs[0]!.request).not.toHaveProperty("wakeExclusion");
  });
  it("wakeOrigin reaches the runner request WITHOUT the mailbox claim token; wake off drops it entirely", async () => {
    const origin = {
      by: "r_SENDER01",
      key: "r_SENDER01:r_TARGET01:1:1" as never,
      level: 1,
      via: "fabric" as const,
      trigger: { key: "r_SENDER01:r_TARGET01:1:1" as never, claimToken: "SECRET-TOKEN" },
    };
    const on = rig({ inbox });
    await on.service.spawn({ type: "worker", prompt: "x", resumeFrom: target, wakeOrigin: origin });
    const seen = on.specs[0]!.request.wakeOrigin!;
    expect(seen).toMatchObject({ by: "r_SENDER01", level: 1, trigger: { key: origin.trigger.key } });
    expect(JSON.stringify(seen)).not.toContain("SECRET-TOKEN");
    const off = rig();
    await off.service.spawn({ type: "worker", prompt: "x", resumeFrom: target, wakeOrigin: origin });
    expect(off.specs[0]!.request).not.toHaveProperty("wakeOrigin");
  });
});

describe("W5 model pin happens BEFORE the quota gate", () => {
  it("a pinned modelOverride is what the quota gate sees (not the agent type's default)", async () => {
    const gate = vi.fn(() => undefined);
    const h = rig({ inbox, quotaGate: gate });
    await h.service.spawn({
      type: "worker",
      prompt: "x",
      resumeFrom: target,
      modelOverride: { provider: "p", id: "pinned" },
    });
    expect(gate).toHaveBeenCalledWith({ provider: "p", id: "pinned" });
  });
  it("a blocked pinned model rejects with reason quota and creates nothing (no run, no resume owner)", async () => {
    const h = rig({ inbox, quotaGate: () => ({ message: "5h exhausted" }) });
    const res = await h.service.spawn({
      type: "worker",
      prompt: "x",
      resumeFrom: target,
      modelOverride: { provider: "p", id: "pinned" },
    });
    expect(res).toMatchObject({ error: { reason: "quota", retryable: false } });
    expect(h.specs).toHaveLength(0);
    expect(h.service.successorOf(h.file)).toBeUndefined();
  });
});
