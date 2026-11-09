import * as fs from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { fixture, action, host } from "./revision-e-helpers.js";
import * as safeFs from "../../../src/memory/safe-fs.js";
import { withMemoryDirLock } from "../../../src/memory/lock.js";
import { parseBlockFile } from "../../../src/memory/blocks/format.js";
import { restoreRevisionRaw, createRevisionAuditPort } from "../../../src/memory/govern/revision-audit.js";
import { revisionProposalDigest } from "../../../src/memory/govern/revision.js";
import { createRevisionCommitter } from "../../../src/memory/govern/revision-commit.js";
import type { RevisionProposal } from "../../../src/memory/jev/contracts.js";

it.each(["agent", "user"] as const)(
  "real client→freeze→review→two barriers→rewrite→C raw restore (%s)",
  async (authority) => {
    const h = await fixture(false, authority),
      x = await host(h);
    const context = fs.readFileSync(h.contextPath);
    const data = vi.spyOn(safeFs, "replaceRevisionObserved");
    const result = await x.commit();
    expect(result.kind).toBe("committed");
    const next = fs.readFileSync(h.targetPath);
    expect(next.equals(h.before)).toBe(false);
    expect(next.toString()).toContain(h.proposal.generatedBody);
    expect(fs.readFileSync(h.contextPath)).toEqual(context);
    expect(data.mock.calls.filter((c) => c[0] === h.blocks && c[2] === "rules.001.md")).toHaveLength(1);
    expect(await x.commit()).toEqual(result); // fresh factory: zero second data application
    expect(data.mock.calls.filter((c) => c[0] === h.blocks && c[2] === "rules.001.md")).toHaveLength(1);
    expect(await restoreRevisionRaw(h.dir, { actionId: h.frozen.actionId }, h.auditDeps)).toEqual({
      kind: "restored",
      actionId: h.frozen.actionId,
    });
    expect(fs.readFileSync(h.targetPath)).toEqual(h.before);
  },
);

it.each(["expires-set", "expires-clear", "retire", "delete"] as const)(
  "real %s expected bytes / observations / fsync / raw restore",
  async (kind) => {
    const h = await fixture();
    if (kind === "delete" || kind === "expires-clear") {
      fs.writeFileSync(
        h.targetPath,
        h.before.toString().replace("status: active", "expires: 2020-01-01\r\nstatus: active"),
      );
    }
    const before = fs.readFileSync(h.targetPath),
      context = fs.readFileSync(h.contextPath);
    const owned = await action(h, kind.startsWith("expires") ? "expires" : (kind as "retire" | "delete"), {
      clear: kind === "expires-clear",
    });
    const x = await host(h, owned);
    const trace: string[] = [];
    const replace = safeFs.replaceRevisionObserved,
      del = safeFs.deleteRevisionObserved,
      sync = safeFs.fsyncDir;
    vi.spyOn(safeFs, "replaceRevisionObserved").mockImplementation((...args) => {
      const r = replace(...args);
      if (args[0] === h.blocks) {
        expect(r.observation.kind).toBe("applied");
        trace.push("data-rename");
        const audit = JSON.parse(
          fs.readFileSync(
            join(h.blocks, ".jev/revisions", owned.frozen.batchId, owned.frozen.actionId, "audit.json"),
            "utf8",
          ),
        );
        expect(audit.state).toBe("proposed");
        expect(
          fs.readFileSync(join(h.blocks, ".jev/revisions", owned.frozen.batchId, owned.frozen.actionId, "after.md")),
        ).toEqual(fs.readFileSync(h.targetPath));
      } else if (args[2] === "audit.json" && trace.includes("data-rename")) trace.push("audit-final");
      return r;
    });
    vi.spyOn(safeFs, "deleteRevisionObserved").mockImplementation((...args) => {
      const r = del(...args);
      trace.push("data-unlink");
      expect(r.observation).toMatchObject({ kind: "applied", proof: "unlink-observed" });
      return r;
    });
    vi.spyOn(safeFs, "fsyncDir").mockImplementation((dir) => {
      if (trace.includes("data-rename") || trace.includes("data-unlink")) trace.push(`sync:${dir}`);
      return sync(dir);
    });
    const result = await x.commit(kind === "retire" ? "web-b3" : "p50-auto");
    expect(result.kind).toBe("committed");
    expect(fs.readFileSync(h.contextPath)).toEqual(context);
    if (kind === "delete") {
      expect(fs.existsSync(h.targetPath)).toBe(false);
      const trash = fs.readdirSync(join(h.blocks, ".trash"));
      expect(trash).toHaveLength(1);
      expect(fs.readFileSync(join(h.blocks, ".trash", trash[0]!))).toEqual(before);
      expect(trace.indexOf(`sync:${join(h.blocks, ".trash")}`)).toBeGreaterThan(trace.indexOf("data-unlink"));
    } else {
      const text = fs.readFileSync(h.targetPath, "utf8");
      expect(text).toContain(kind === "retire" ? "status: superseded" : "status: active");
      if (kind === "expires-set") expect(text).toContain("expires: 2027-01-01");
      if (kind === "expires-clear") expect(text).not.toContain("expires:");
      expect(trace.indexOf(`sync:${h.blocks}`)).toBeGreaterThan(trace.indexOf("data-rename"));
      expect(trace.indexOf("audit-final")).toBeGreaterThan(trace.indexOf(`sync:${h.blocks}`));
    }
    vi.restoreAllMocks();
    expect((await restoreRevisionRaw(h.dir, { actionId: owned.frozen.actionId }, h.auditDeps)).kind).toBe("restored");
    expect(fs.readFileSync(h.targetPath)).toEqual(before);
  },
);

it.each(["lease", "enabled", "auto", "epoch", "policy", "date", "plain", "owner"] as const)(
  "late %s change refuses without data syscall",
  async (which) => {
    const h = await fixture(),
      x = await host(h, await action(h, "expires"));
    if (which === "lease") x.state.lease = false;
    if (which === "enabled") x.state.enabled = false;
    if (which === "auto") x.state.autoEnabled = false;
    if (which === "epoch") x.state.epoch++;
    if (which === "policy") x.state.policyVersion = "changed";
    if (which === "date") x.state.dateRuleVersion = "changed";
    if (which === "plain") x.state.plainMain = false;
    if (which === "owner") h.state.current = false;
    const apply = vi.spyOn(safeFs, "replaceRevisionObserved");
    expect((await x.commit()).kind).toBe("skipped");
    expect(fs.readFileSync(h.targetPath)).toEqual(h.before);
    expect(apply.mock.calls.filter((c) => c[0] === h.blocks)).toHaveLength(0);
  },
);

it.each(["delete", "expires"] as const)(
  "user %s never automatic even when autoEligible hint is forged",
  async (kind) => {
    const h = await fixture(false, "user"),
      owned = await action(h, kind);
    const payload = { ...owned.proposal, autoEligible: true };
    const proposal = { ...payload, proposalDigest: revisionProposalDigest(payload) } as RevisionProposal;
    const x = await host(h, owned);
    (owned as { proposal: RevisionProposal }).proposal = proposal;
    expect(await x.commit()).toMatchObject({ kind: "skipped", reason: "digest" }); // D rejects forged authority hint
    expect(fs.readFileSync(h.targetPath)).toEqual(h.before);
  },
);
it("suggestion-only hint is NOT authorization; confirmed port missing/false refuses", async () => {
  const h = await fixture(true),
    x = await host(h);
  expect(h.proposal.autoEligible).toBe(false);
  expect(await x.commit()).toMatchObject({ kind: "skipped", reason: "permission" });
  x.state.confirmed = false;
  expect(await x.commit("web-b3")).toMatchObject({ kind: "skipped", reason: "permission" });
  const { consumeConfirmedLocked: _, ...missing } = x.deps;
  expect(await createRevisionCommitter(h.dir, missing).commitAction(x.request("web-b3"))).toMatchObject({
    kind: "skipped",
    reason: "unavailable",
  });
  expect(fs.readFileSync(h.targetPath)).toEqual(h.before);
});
it.each([
  "target",
  "context",
  "authority",
  "archived",
  "raw",
  "position",
  "digest",
  "date-payload",
  "same-source",
  "wrong-request-cap",
] as const)("reject %s mismatch before data", async (kind) => {
  const h = await fixture(),
    x = await host(h);
  if (kind === "target" || kind === "context")
    fs.appendFileSync(kind === "target" ? h.targetPath : h.contextPath, "\nUser edit");
  if (kind === "authority")
    fs.writeFileSync(h.targetPath, h.before.toString().replace("authority: agent", "authority: user"));
  if (kind === "archived")
    fs.writeFileSync(h.targetPath, h.before.toString().replace("status: active", "status: archived"));
  if (kind === "raw") fs.writeFileSync(h.targetPath, h.before.toString().replace(/\r\n/g, "\n"));
  if (kind === "position") {
    fs.mkdirSync(join(h.blocks, "archive"));
    fs.renameSync(h.targetPath, join(h.blocks, "archive/rules.001.md"));
  }
  if (kind === "wrong-request-cap") (x.owned as { generationMaxOutputTokens: number }).generationMaxOutputTokens = 128;
  if (kind === "same-source") {
    const p = h.proposal;
    if (!p.coverage || !p.generationProvenance) throw new Error("no coverage");
    const changed = { ...p, coverage: { ...p.coverage, provenance: p.generationProvenance } };
    (x.owned as { proposal: RevisionProposal }).proposal = changed as RevisionProposal;
  }
  const before = fs.existsSync(h.targetPath) ? fs.readFileSync(h.targetPath) : undefined;
  const req = { ...x.request() };
  if (kind === "digest" || kind === "date-payload") req.proposalDigest = "0".repeat(64);
  expect((await createRevisionCommitter(h.dir, x.deps).commitAction(req)).kind).toBe("skipped");
  expect(fs.existsSync(h.targetPath) ? fs.readFileSync(h.targetPath) : undefined).toEqual(before);
});
it.each(["dismissed", "resolved", "bad-index"] as const)(
  "stable %s tombstone cannot be bypassed by a late commit",
  async (kind) => {
    const h = await fixture(),
      x = await host(h);
    const index = JSON.parse(fs.readFileSync(h.indexPath, "utf8"));
    const key = JSON.stringify(["revision", "rewrite-single", "rules.001", "rules.002"]);
    if (kind === "dismissed")
      index.review.dismissed.push({ suggestionKey: key, hashKey: "x", anchorKey: "x", kind: "conflict" });
    if (kind === "resolved") index.review.resolved = [key];
    if (kind === "bad-index") index.review.dismissed.push({ suggestionKey: key, get: "malformed tombstone" });
    fs.writeFileSync(h.indexPath, JSON.stringify(index));
    expect((await x.commit()).kind).toBe("skipped");
    expect(fs.readFileSync(h.targetPath)).toEqual(h.before);
  },
);

it.each([
  "prepared-file",
  "prepared-dir",
  "expected-file",
  "expected-dir",
  "data-rename",
  "post-gate",
  "data-fsync",
  "final-audit",
] as const)("%s fault preserves actual bytes and observed attempt fence", async (phase) => {
  const h = await fixture(),
    x = await host(h);
  const apply = safeFs.replaceRevisionObserved,
    sync = safeFs.fsyncDir,
    fileSync = safeFs.fsyncRevisionFile;
  let dataCalls = 0,
    dataApplied = false,
    sawAfter = false;
  vi.spyOn(safeFs, "replaceRevisionObserved").mockImplementation((...args) => {
    if (args[2] === "after.md") sawAfter = true;
    if (args[0] === h.blocks) {
      dataCalls++;
      if (phase === "data-rename") throw new Error("opaque syscall outcome");
      const result = apply(...args);
      dataApplied = result.observation.kind === "applied";
      if (phase === "post-gate") x.state.lease = false;
      return result;
    }
    if (phase === "final-audit" && dataApplied && args[2] === "audit.json") throw new Error("final audit fault");
    return apply(...args);
  });
  vi.spyOn(safeFs, "fsyncRevisionFile").mockImplementation((...args) => {
    if ((phase === "prepared-file" && !sawAfter) || (phase === "expected-file" && sawAfter))
      throw new Error("file fsync fault");
    return fileSync(...args);
  });
  vi.spyOn(safeFs, "fsyncDir").mockImplementation((dir) => {
    if (
      (phase === "prepared-dir" && !sawAfter) ||
      (phase === "expected-dir" && sawAfter && !dataApplied) ||
      (phase === "data-fsync" && dataApplied && dir === h.blocks)
    )
      throw new Error("dir fsync fault");
    return sync(dir);
  });
  const result = await x.commit();
  const beforeData = phase.startsWith("prepared") || phase.startsWith("expected");
  expect(result.kind).toBe(beforeData ? "skipped" : "effect-unknown");
  expect(dataCalls).toBe(beforeData ? 0 : 1);
  expect(fs.readFileSync(h.targetPath).equals(h.before)).toBe(!dataApplied);
  const bytes = fs.readFileSync(h.targetPath);
  vi.restoreAllMocks();
  x.state.lease = true;
  if (!beforeData || sawAfter) {
    const retry = vi.spyOn(safeFs, "replaceRevisionObserved");
    expect((await x.commit()).kind).toBe("effect-unknown");
    expect(retry.mock.calls.filter((c) => c[0] === h.blocks)).toHaveLength(0);
    expect(fs.readFileSync(h.targetPath)).toEqual(bytes);
    expect((await restoreRevisionRaw(h.dir, { actionId: h.frozen.actionId }, h.auditDeps)).kind).toBe("refused");
  }
});

it.each([false, true])(
  "same-batch third action refused after two attempts, including unknown=%s and fresh factory",
  async (unknown) => {
    const h = await fixture();
    fs.writeFileSync(join(h.blocks, "rules.003.md"), h.before, { mode: 0o600 });
    const actions = ["rules.001", "rules.002", "rules.003"].map((id) => {
      const b = parseBlockFile(`${id}.md`, fs.readFileSync(join(h.blocks, `${id}.md`), "utf8"));
      if ("stray" in b) throw new Error("stray");
      return { action: "expires" as const, target: b };
    });
    const owned = await Promise.all(actions.map((a) => action(h, "expires", { targetId: a.target.id, actions })));
    expect(new Set(owned.map((o) => o.frozen.batchId)).size).toBe(1);
    const hosts = [];
    for (const o of owned) hosts.push(await host(h, o));
    if (unknown) {
      const actual = safeFs.replaceRevisionObserved;
      vi.spyOn(safeFs, "replaceRevisionObserved").mockImplementation((...args) => {
        if (args[0] === h.blocks && args[2] === "rules.001.md") throw Error("opaque attempt");
        return actual(...args);
      });
    }
    expect((await hosts[0]!.commit()).kind).toBe(unknown ? "effect-unknown" : "committed");
    vi.restoreAllMocks();
    expect((await hosts[1]!.commit()).kind).toBe("committed");
    const before = fs.readFileSync(join(h.blocks, "rules.003.md"));
    expect(await hosts[2]!.commit()).toMatchObject({ kind: "skipped", reason: "permission" });
    expect(fs.readFileSync(join(h.blocks, "rules.003.md"))).toEqual(before);
  },
);

it("autoEligible=false never blocks independently revalidated complete evidence, nor grants missing evidence", async () => {
  const h = await fixture();
  const payload = { ...h.proposal, autoEligible: false };
  const proposal = { ...payload, proposalDigest: revisionProposalDigest(payload) } as RevisionProposal;
  const x = await host(h, {
    frozen: h.frozen,
    proposal,
    generationMaxOutputTokens: 2048,
    coverageMaxOutputTokens: 2048,
  });
  expect((await x.commit()).kind).toBe("committed");
  expect(fs.readFileSync(h.targetPath, "utf8")).toContain(h.proposal.generatedBody);
});
it("agent context cannot automatically or through the commit port replace a user rule", async () => {
  const h = await fixture(false, "user");
  fs.writeFileSync(h.contextPath, h.contextBefore.toString().replace("authority: user", "authority: agent"));
  const f = await h.freeze(),
    result = await h.prepare(f);
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") throw Error("no user/agent proposal");
  const x = await host(h, {
    frozen: f,
    proposal: result.proposal,
    generationMaxOutputTokens: 2048,
    coverageMaxOutputTokens: 2048,
  });
  expect(await x.commit()).toMatchObject({ kind: "skipped", reason: "permission" });
  expect(await x.commit("web-b3")).toMatchObject({ kind: "skipped", reason: "permission" });
  expect(x.confirm).not.toHaveBeenCalled();
  expect(fs.readFileSync(h.targetPath)).toEqual(h.before);
});
it.each(["expires", "delete"] as const)("ordinary user %s proposal is not automatic", async (kind) => {
  const h = await fixture(false, "user"),
    x = await host(h, await action(h, kind));
  expect(await x.commit()).toMatchObject({ kind: "skipped", reason: "permission" });
  expect(fs.readFileSync(h.targetPath)).toEqual(h.before);
});
it("frozen expires is never rederived from a later wall clock", async () => {
  const h = await fixture(),
    x = await host(h, await action(h, "expires"));
  x.deps.now = () => new Date("2099-12-31T00:00:00.000Z");
  expect((await x.commit()).kind).toBe("committed");
  const text = fs.readFileSync(h.targetPath, "utf8");
  expect(text).toContain("expires: 2027-01-01");
  expect(text).toContain("updated: 2099-12-31T00:00:00.000Z");
});
it("request unknown fields/accessors/non-string digests never reach local owner", async () => {
  const h = await fixture(),
    x = await host(h),
    owner = vi.spyOn(x.deps, "actionLocked");
  let touched = 0;
  const attempts = [
    { ...x.request(), generatedBody: "injected" },
    {
      ...x.request(),
      get proposalDigest() {
        touched++;
        return h.proposal.proposalDigest;
      },
    },
    {
      ...x.request(),
      proposalDigest: {
        toString() {
          touched++;
          return h.proposal.proposalDigest;
        },
      },
    },
  ];
  for (const req of attempts)
    expect(await createRevisionCommitter(h.dir, x.deps).commitAction(req as never)).toMatchObject({
      kind: "skipped",
      reason: "digest",
    });
  expect(touched).toBe(0);
  expect(owner).not.toHaveBeenCalled();
});

it.each(["gate", "abort", "unknown-current", "unknown-lease", "unknown-runtime"] as const)(
  "strict %s denial cannot be truthy-coerced into authority",
  async (kind) => {
    const h = await fixture(),
      x = await host(h);
    const controller = new AbortController();
    let deps = x.deps;
    if (kind === "gate")
      deps = { ...deps, gate: { capture() {}, check: () => ({ ok: false, reason: "identity-changed" }) } };
    if (kind === "abort") {
      controller.abort();
      deps = { ...deps, signal: controller.signal };
    }
    if (kind === "unknown-current") deps = { ...deps, isCurrent: (() => Promise.resolve(true)) as never };
    if (kind === "unknown-lease") deps = { ...deps, leaseValid: (() => Promise.resolve(true)) as never };
    if (kind === "unknown-runtime")
      deps = { ...deps, runtime: () => ({ ...x.deps.runtime(), enabled: "true" as never }) };
    expect((await createRevisionCommitter(h.dir, deps).commitAction(x.request())).kind).toBe("skipped");
    expect(fs.readFileSync(h.targetPath)).toEqual(h.before);
  },
);
