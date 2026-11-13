import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  manifestSha256,
  runApprovedClosureProbe,
  validateClosureManifest,
  type ClosureManifest,
  type ProbeStage,
} from "../../../scripts/dev/p50-closure-live-probe.js";
import { ClosureProbeFailure } from "../../../scripts/dev/p50-closure-diagnostics.js";
import { estimatePayload } from "../../../src/memory/jev/p50-estimate.js";
import { wireFixture } from "../govern/revision-wire-helpers.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function manifest(
  root: string,
  payloads: unknown[] = [{ model: "r" }, { model: "r" }, { model: "g" }, { model: "g" }],
): ClosureManifest {
  const paths = Object.fromEntries(
    ["home", "cache", "tmp", "config", "agent", "cwd", "memory", "ccProjects"].map((k) => [k, join(root, k)]),
  ) as unknown as ClosureManifest["paths"];
  return {
    contract: "p50-stock-estimate-suggest-only-v1",
    transport: "proxy",
    root,
    paths,
    maxAttempts: 4,
    budgetUsd: 0.01,
    plannedReserveUsd: 0.0099,
    cEnvelopeEstimatedInputTokens: 8192,
    routes: (["R1", "R2", "G1", "C1"] as const).map((stage, i) => ({
      stage,
      endpoint: `https://p50-wire.invalid/v1/${i < 2 ? "systemone" : "chat/completions"}`,
      model: (payloads[i] as { model: string }).model,
      estimatedInputTokens: i === 3 ? 8192 : estimatePayload(payloads[i])!,
      outputAllowance: i < 2 ? 128 : 384,
      inputUsdPerMillion: 0.1,
      outputUsdPerMillion: 0.1,
      ...(i < 3 ? { payloadSha256: manifestSha256(JSON.stringify(payloads[i])) } : {}),
    })),
  };
}
function ownRoot() {
  const root = mkdtempSync(join(tmpdir(), "p50-probe-offline-"));
  roots.push(root);
  return root;
}
it("default rejects; hash mismatch before runner/data, even a valid manifest still AUTH_UNAVAILABLE without approved auth bridge", async () => {
  const m = manifest(ownRoot()),
    bytes = JSON.stringify(m),
    runner = vi.fn();
  await expect(runApprovedClosureProbe(bytes, undefined, runner)).rejects.toThrow("APPROVAL_HASH_MISMATCH");
  await expect(runApprovedClosureProbe(bytes, "f".repeat(64), runner)).rejects.toThrow("APPROVAL_HASH_MISMATCH");
  expect(runner).not.toHaveBeenCalled();
  await expect(runApprovedClosureProbe(bytes, manifestSha256(bytes))).rejects.toThrow("AUTH_UNAVAILABLE");
});
it("resolved isolation refuses lexical and symlink escape before runner/data; inherited memory roots are replaced", async () => {
  const root = ownRoot(),
    m = manifest(root),
    bytes = JSON.stringify(m);
  const planned = validateClosureManifest(bytes, manifestSha256(bytes), {
    ARMORY_MEMORY_ROOT: "/real-user-memory",
    CC_PROJECTS_ROOT: "/real-user-projects",
    NODE_OPTIONS: "unsafe",
  });
  expect(planned.environment.ARMORY_MEMORY_ROOT).toBe(m.paths.memory);
  expect(planned.environment.CC_PROJECTS_ROOT).toBe(m.paths.ccProjects);
  expect(planned.environment.NODE_OPTIONS).toBe("");
  expect(planned.memoryDir.startsWith(m.paths.memory + "/")).toBe(true);
  const runner = vi.fn();
  for (const key of ["home", "memory", "ccProjects"] as const) {
    const escape = JSON.stringify({ ...m, paths: { ...m.paths, [key]: join(root, "../escape") } });
    await expect(runApprovedClosureProbe(escape, manifestSha256(escape), runner)).rejects.toThrow("ISOLATION_ESCAPE");
  }
  const outside = ownRoot();
  symlinkSync(outside, m.paths.memory);
  await expect(runApprovedClosureProbe(bytes, manifestSha256(bytes), runner)).rejects.toThrow("ISOLATION_ESCAPE");
  expect(runner).not.toHaveBeenCalled();
});
it.each(["extra", "envelope"] as const)("offline gate rejects %s and latches stop", async (fault) => {
  const m = manifest(ownRoot()),
    bytes = JSON.stringify(m);
  await expect(
    runApprovedClosureProbe(bytes, manifestSha256(bytes), async (ctx) => {
      for (const r of m.routes)
        ctx.beforeHttp(r.stage, r.endpoint, {
          model: r.model,
          ...(r.stage === "C1" && fault === "envelope" ? { body: "x".repeat(20000) } : {}),
        });
      if (fault === "extra") ctx.beforeHttp("R1", m.routes[0]!.endpoint, { model: "r" });
      throw Error("must not reach");
    }),
  ).rejects.toThrow(fault === "extra" ? "EXTRA_OR_UNAPPROVED_REQUEST" : "C_ENVELOPE");
});
it("approved OFFLINE manifest → actual default wire/SDK fakeHTTP 2R+G+C → original prepared audit and unchanged raw", async () => {
  // Freeze R/G exact SDK templates offline, never from paid responses.
  const reference = await wireFixture({ stock: true });
  await reference.writePair();
  const start = reference.calls.length;
  await reference.natural();
  const payloads = reference.calls.slice(start).map((c) => c.payload);
  expect(payloads).toHaveLength(4);
  const h = await wireFixture({ stock: true });
  await h.writePair();
  const m = manifest(h.root, payloads),
    bytes = JSON.stringify(m);
  const before = ["rules.001", "rules.002"].map((id) => readFileSync(join(h.blocks, `${id}.md`)));
  let n = 0;
  const result = await runApprovedClosureProbe(bytes, manifestSha256(bytes), async (ctx) => {
    for (const [k, v] of Object.entries(ctx.isolation.environment)) if (v !== undefined) vi.stubEnv(k, v);
    h.state.onHTTP = () => {
      const call = h.calls.at(-1)!;
      const stage = (["R1", "R2", "G1", "C1"] as ProbeStage[])[n++]!;
      ctx.beforeHttp(stage, `https://p50-wire.invalid/v1/${n <= 2 ? "systemone" : "chat/completions"}`, call.payload);
    };
    await h.natural();
    const p = h.suggestions()[0]!.revision!;
    const audit = JSON.parse(
      readFileSync(join(h.blocks, ".jev/revisions", p.batchId, p.actionId, "audit.json"), "utf8"),
    );
    return {
      suggestions: h.suggestions().length,
      autoEligible: p.autoEligible,
      automaticCommitCalls: audit.commitOrigin === "p50-auto" ? 1 : 0,
      targetRawUnchanged: before[0]!.equals(readFileSync(join(h.blocks, "rules.001.md"))),
      contextRawUnchanged: before[1]!.equals(readFileSync(join(h.blocks, "rules.002.md"))),
      auditState: audit.state,
    };
  });
  expect(result).toMatchObject({
    verdict: "PASS",
    live: "NOT_RUN",
    assurance: { serverEnforced: false, billingStatus: "UNKNOWN", identityEvidence: "unknown" },
    effect: { suggestions: 1, automaticCommitCalls: 0, auditState: "prepared" },
  });
  expect(result.events.map((e) => e.stage)).toEqual(["R1", "R2", "G1", "C1"]);
});

it.each(["AUDIT_MISSING", "POSTCONDITION", "RUNNER_FAILED"] as const)(
  "postflight/runner failure maps %s without echoing upstream text",
  async (code) => {
    const m = manifest(ownRoot()),
      bytes = JSON.stringify(m);
    const failure = await runApprovedClosureProbe(bytes, manifestSha256(bytes), async (ctx) => {
      if (code === "RUNNER_FAILED")
        throw new Error("synthetic-secret-in-message", { cause: new Error("synthetic-secret-in-cause") });
      for (const r of m.routes) ctx.beforeHttp(r.stage, r.endpoint, { model: r.model });
      return {
        suggestions: 1,
        autoEligible: false,
        automaticCommitCalls: 0,
        targetRawUnchanged: code !== "POSTCONDITION",
        contextRawUnchanged: true,
        auditState: code === "AUDIT_MISSING" ? "missing" : "prepared",
      };
    }).catch((error) => error);
    expect(failure).toBeInstanceOf(ClosureProbeFailure);
    expect(failure.message).toBe("INCOMPLETE_CLOSURE");
    expect(failure.diagnostic.internalCode).toBe(code);
    expect(failure.diagnostic.beforeHttpCount).toBe(code === "RUNNER_FAILED" ? 0 : 4);
    expect(JSON.stringify(failure.diagnostic)).not.toContain("synthetic-secret");
  },
);
