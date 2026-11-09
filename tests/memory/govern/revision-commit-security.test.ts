/** E independent-acceptance regressions: real disk/audit/apply/restore, not VM
 * probes. The sole host-confirmation capability cannot override domain policy. */
import * as fs from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { fixture, action, host } from "./revision-e-helpers.js";
import * as safeFs from "../../../src/memory/safe-fs.js";
import { withMemoryDirLock } from "../../../src/memory/lock.js";
import { createRevisionCommitter } from "../../../src/memory/govern/revision-commit.js";
import { createRevisionAuditPort, restoreRevisionRaw } from "../../../src/memory/govern/revision-audit.js";
import { prepareRevisionApplicationLocked } from "../../../src/memory/govern/revision-applier.js";
import { revisionInputIsLiveLocked } from "../../../src/memory/govern/revision.js";

type Harness = Awaited<ReturnType<typeof fixture>>;
type Origin = "p50-auto" | "web-b3";
const now = new Date("2026-11-10T00:00:00.000Z");
function evidence(h: Harness, batchId: string, actionId: string) {
  const path = join(h.blocks, ".jev/revisions", batchId, actionId);
  return {
    path,
    auditPath: join(path, "audit.json"),
    read: () =>
      Object.fromEntries(
        fs
          .readdirSync(path)
          .sort()
          .map((name) => [name, fs.readFileSync(join(path, name))]),
      ),
  };
}
function checkFrozen(f: Parameters<typeof revisionInputIsLiveLocked>[0]) {
  if (!revisionInputIsLiveLocked(f)) throw Error("test frozen input stale");
}

it.each(["p50-auto", "web-b3"] as const)(
  "user delete is a hard prohibition for %s, even with exact confirmed host capability",
  async (origin) => {
    const h = await fixture(false, "user");
    fs.writeFileSync(
      h.targetPath,
      h.before.toString().replace("status: active", "expires: 2020-01-01\r\nstatus: active"),
    );
    const owned = await action(h, "delete"),
      x = await host(h, owned);
    const before = fs.readFileSync(h.targetPath),
      e = evidence(h, owned.frozen.batchId, owned.frozen.actionId),
      snapshots = e.read();
    const del = vi.spyOn(safeFs, "deleteRevisionObserved"),
      replace = vi.spyOn(safeFs, "replaceRevisionObserved");
    expect(await x.commit(origin)).toMatchObject({ kind: "skipped", reason: "permission" });
    expect(x.confirm).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(replace.mock.calls.filter((c) => c[0] === h.blocks)).toHaveLength(0);
    expect(fs.readFileSync(h.targetPath)).toEqual(before);
    expect(fs.existsSync(join(h.blocks, ".trash"))).toBe(false);
    expect(e.read()).toEqual(snapshots);
    expect(JSON.parse(fs.readFileSync(e.auditPath, "utf8"))).toMatchObject({ state: "prepared" });
    expect((await restoreRevisionRaw(h.dir, { actionId: owned.frozen.actionId }, h.auditDeps)).kind).toBe("refused");
  },
);

it("confirmed agent deletion still commits and C restores exact raw bytes", async () => {
  const h = await fixture(),
    owned = await action(h, "delete"),
    x = await host(h, owned);
  expect((await x.commit("web-b3")).kind).toBe("committed");
  expect(x.confirm).toHaveBeenCalledTimes(1);
  expect(fs.existsSync(h.targetPath)).toBe(false);
  expect((await restoreRevisionRaw(h.dir, { actionId: owned.frozen.actionId }, h.auditDeps)).kind).toBe("restored");
  expect(fs.readFileSync(h.targetPath)).toEqual(owned.frozen.target.rawBefore);
});

it("C retains its hard refusal of historical committed user deletion; E cannot replay it as success", async () => {
  const h = await fixture(false, "user"),
    owned = await action(h, "delete"),
    x = await host(h, owned);
  // Reproduce the obsolete unsafe state through C's trusted lower-level seam
  // ONLY in own temp data; production E is now incapable of making this state.
  await withMemoryDirLock(h.dir, () => {
    const application = prepareRevisionApplicationLocked(h.dir, owned.frozen, owned.proposal, now);
    expect(
      h.audit.persistExpectedAfterBarrierLocked({
        batchId: owned.frozen.batchId,
        actionId: owned.frozen.actionId,
        proposalDigest: owned.proposal.proposalDigest,
        commitOrigin: "web-b3",
        expected: application.expected,
      }).kind,
    ).toBe("ok");
    const result = application.applyLocked(() => checkFrozen(owned.frozen));
    expect(result.observation.kind).toBe("applied");
    expect(
      h.audit.finalizeCommitLocked({
        batchId: owned.frozen.batchId,
        actionId: owned.frozen.actionId,
        proposalDigest: owned.proposal.proposalDigest,
        observation: result.observation,
        dataDirectories: result.dataDirectories,
      }).kind,
    ).toBe("committed");
  });
  const e = evidence(h, owned.frozen.batchId, owned.frozen.actionId),
    snapshots = e.read();
  expect(await restoreRevisionRaw(h.dir, { actionId: owned.frozen.actionId }, h.auditDeps)).toMatchObject({
    kind: "refused",
    reason: "permission",
  });
  expect(await x.commit("web-b3")).toMatchObject({ kind: "skipped", reason: "permission" });
  expect(fs.existsSync(h.targetPath)).toBe(false);
  expect(e.read()).toEqual(snapshots);
});

const attemptedStates = ["proposed", "committed", "commit-unknown", "skipped", "failed", "restored"] as const;
async function diskState(state: (typeof attemptedStates)[number], origin: Origin) {
  const h = await fixture(),
    owned = await action(h, "expires"),
    x = await host(h, owned);
  if (state === "proposed" || state === "failed") {
    await withMemoryDirLock(h.dir, () => {
      const app = prepareRevisionApplicationLocked(h.dir, owned.frozen, owned.proposal, now);
      expect(
        h.audit.persistExpectedAfterBarrierLocked({
          batchId: owned.frozen.batchId,
          actionId: owned.frozen.actionId,
          proposalDigest: owned.proposal.proposalDigest,
          commitOrigin: origin,
          expected: app.expected,
        }).kind,
      ).toBe("ok");
    });
  } else {
    if (state === "commit-unknown") {
      const actual = safeFs.replaceRevisionObserved;
      const spy = vi.spyOn(safeFs, "replaceRevisionObserved").mockImplementation((...args) => {
        const r = actual(...args);
        return args[0] === h.blocks ? { ...r, error: "injected after real rename" } : r;
      });
      expect((await x.commit(origin)).kind).toBe("effect-unknown");
      spy.mockRestore();
    } else if (state === "skipped") {
      const actual = safeFs.writeTempRegular;
      const spy = vi.spyOn(safeFs, "writeTempRegular").mockImplementation((...args) => {
        if (args[0] === h.blocks) throw Error("pre-data temp failure");
        return actual(...args);
      });
      expect((await x.commit(origin)).kind).toBe("skipped");
      spy.mockRestore();
    } else {
      expect((await x.commit(origin)).kind).toBe("committed");
      if (state === "restored")
        expect((await restoreRevisionRaw(h.dir, { actionId: owned.frozen.actionId }, h.auditDeps)).kind).toBe(
          "restored",
        );
    }
  }
  const e = evidence(h, owned.frozen.batchId, owned.frozen.actionId);
  if (state === "failed") {
    // C has no public failure-state mutator; construct a valid historical
    // on-disk terminal fixture without a target syscall, then use real readers.
    const audit = JSON.parse(fs.readFileSync(e.auditPath, "utf8"));
    audit.state = "failed";
    audit.reason = "historical pre-data failure";
    fs.writeFileSync(e.auditPath, JSON.stringify(audit));
  }
  const read = await withMemoryDirLock(h.dir, () =>
    createRevisionAuditPort(h.dir, h.auditDeps).readActionLocked(owned.frozen.batchId, owned.frozen.actionId),
  );
  expect(read).toMatchObject({ kind: "ok", audit: { state, commitOrigin: origin } });
  return { h, owned, x, e };
}

for (const state of attemptedStates) {
  for (const frozenOrigin of ["p50-auto", "web-b3"] as const) {
    it.each([false, true])(
      `${state}/${frozenOrigin} replay source switched=%s checks frozen intent before any shortcut`,
      async (switched) => {
        const { h, owned, x, e } = await diskState(state, frozenOrigin);
        const requestOrigin: Origin = switched ? (frozenOrigin === "p50-auto" ? "web-b3" : "p50-auto") : frozenOrigin;
        const snapshots = e.read(),
          before = fs.readFileSync(h.targetPath),
          confirmationCalls = x.confirm.mock.calls.length;
        const apply = vi.spyOn(safeFs, "replaceRevisionObserved"),
          del = vi.spyOn(safeFs, "deleteRevisionObserved");
        const result = await createRevisionCommitter(h.dir, x.deps).commitAction(x.request(requestOrigin));
        if (switched) expect(result).toMatchObject({ kind: "skipped", reason: "digest" });
        else if (state === "committed") expect(result.kind).toBe("committed");
        else if (state === "proposed" || state === "commit-unknown") expect(result.kind).toBe("effect-unknown");
        else expect(result).toMatchObject({ kind: "skipped", reason: "stale" });
        expect(apply.mock.calls.filter((c) => c[0] === h.blocks)).toHaveLength(0);
        expect(del).not.toHaveBeenCalled();
        expect(x.confirm).toHaveBeenCalledTimes(confirmationCalls);
        expect(fs.readFileSync(h.targetPath)).toEqual(before);
        expect(e.read()).toEqual(snapshots);
        expect(JSON.parse(fs.readFileSync(e.auditPath, "utf8")).commitOrigin).toBe(frozenOrigin);
        expect(owned.frozen.target.rev).toBe(owned.proposal.expectedRev);
      },
    );
  }
}

for (const state of attemptedStates) {
  it.each(["p50-auto", "web-b3"] as const)(
    `legacy ${state} without commitOrigin remains readable, %s cannot invent an intent`,
    async (requestOrigin) => {
      const { h, owned, x, e } = await diskState(state, "p50-auto");
      const audit = JSON.parse(fs.readFileSync(e.auditPath, "utf8"));
      delete audit.commitOrigin;
      fs.writeFileSync(e.auditPath, JSON.stringify(audit));
      const snapshots = e.read(),
        before = fs.readFileSync(h.targetPath);
      const port = createRevisionAuditPort(h.dir, h.auditDeps);
      const read = await withMemoryDirLock(h.dir, () =>
        port.readActionLocked(owned.frozen.batchId, owned.frozen.actionId),
      );
      expect(read).toMatchObject({ kind: "ok", audit: { state } });
      if (read.kind !== "ok") throw Error("legacy audit unavailable");
      expect(Object.hasOwn(read.audit, "commitOrigin")).toBe(false);
      const apply = vi.spyOn(safeFs, "replaceRevisionObserved");
      expect(await x.commit(requestOrigin)).toMatchObject({ kind: "skipped", reason: "unavailable" });
      expect(apply.mock.calls.filter((c) => c[0] === h.blocks)).toHaveLength(0);
      expect(fs.readFileSync(h.targetPath)).toEqual(before);
      expect(e.read()).toEqual(snapshots);
    },
  );
}

it.each(["p50-auto", "web-b3"] as const)(
  "legacy prepared has no frozen intent; first %s application freezes exactly its own source",
  async (origin) => {
    const h = await fixture(),
      owned = await action(h, "expires"),
      x = await host(h, owned);
    const e = evidence(h, owned.frozen.batchId, owned.frozen.actionId),
      prepared = JSON.parse(fs.readFileSync(e.auditPath, "utf8"));
    expect(prepared.state).toBe("prepared");
    expect(Object.hasOwn(prepared, "commitOrigin")).toBe(false);
    expect(prepared.origin).toBe("p50-suggestion");
    expect((await x.commit(origin)).kind).toBe("committed");
    const committed = JSON.parse(fs.readFileSync(e.auditPath, "utf8"));
    expect(committed.origin).toBe("p50-suggestion");
    expect(committed.commitOrigin).toBe(origin);
  },
);

it.each(
  [
    [],
    ["web-b3"],
    ["p50-auto"],
    ["web-b3", "p50-auto"],
    {},
    { toString: "web-b3" },
    0,
    1,
    true,
    false,
    null,
    "",
    "other",
  ].map((value) => [value]),
)("audit commitOrigin codec rejects raw non-enum %j without coercion", async (invalid) => {
  const { h, owned, x, e } = await diskState("proposed", "p50-auto");
  const audit = JSON.parse(fs.readFileSync(e.auditPath, "utf8"));
  audit.commitOrigin = invalid;
  fs.writeFileSync(e.auditPath, JSON.stringify(audit));
  const snapshots = e.read(),
    before = fs.readFileSync(h.targetPath);
  const read = await withMemoryDirLock(h.dir, () =>
    createRevisionAuditPort(h.dir, h.auditDeps).readActionLocked(owned.frozen.batchId, owned.frozen.actionId),
  );
  expect(read.kind).toBe("corrupted");
  const apply = vi.spyOn(safeFs, "replaceRevisionObserved");
  expect(await x.commit()).toMatchObject({ kind: "skipped", reason: "unavailable" });
  expect(apply.mock.calls.filter((c) => c[0] === h.blocks)).toHaveLength(0);
  expect(fs.readFileSync(h.targetPath)).toEqual(before);
  expect(e.read()).toEqual(snapshots);
});

it("old C callers omit commitOrigin byte-for-byte on rebarriers/finalize replay/restore", async () => {
  const h = await fixture(),
    owned = await action(h, "expires"),
    x = await host(h, owned);
  const e = evidence(h, owned.frozen.batchId, owned.frozen.actionId);
  await withMemoryDirLock(h.dir, () => {
    const snapshots = e.read();
    expect(h.audit.persistPreparedBarrierLocked({ ...owned, origin: "p50-suggestion" }).kind).toBe("ok");
    expect(e.read()).toEqual(snapshots);
    const app = prepareRevisionApplicationLocked(h.dir, owned.frozen, owned.proposal, now);
    const expectedInput = {
      batchId: owned.frozen.batchId,
      actionId: owned.frozen.actionId,
      proposalDigest: owned.proposal.proposalDigest,
      expected: app.expected,
    };
    expect(h.audit.persistExpectedAfterBarrierLocked(expectedInput).kind).toBe("ok");
    const proposed = e.read();
    expect(Object.hasOwn(JSON.parse(fs.readFileSync(e.auditPath, "utf8")), "commitOrigin")).toBe(false);
    expect(h.audit.persistExpectedAfterBarrierLocked(expectedInput).kind).toBe("ok");
    expect(e.read()).toEqual(proposed);
    const result = app.applyLocked(() => checkFrozen(owned.frozen));
    const finalizeInput = {
      batchId: owned.frozen.batchId,
      actionId: owned.frozen.actionId,
      proposalDigest: owned.proposal.proposalDigest,
      observation: result.observation,
      dataDirectories: result.dataDirectories,
    };
    expect(h.audit.finalizeCommitLocked(finalizeInput).kind).toBe("committed");
    const committed = e.read();
    expect(Object.hasOwn(JSON.parse(fs.readFileSync(e.auditPath, "utf8")), "commitOrigin")).toBe(false);
    expect(h.audit.finalizeCommitLocked(finalizeInput).kind).toBe("committed");
    expect(e.read()).toEqual(committed);
  });
  expect(await x.commit()).toMatchObject({ kind: "skipped", reason: "unavailable" });
  expect((await restoreRevisionRaw(h.dir, { actionId: owned.frozen.actionId }, h.auditDeps)).kind).toBe("restored");
  expect(fs.readFileSync(h.targetPath)).toEqual(owned.frozen.target.rawBefore);
  expect(Object.hasOwn(JSON.parse(fs.readFileSync(e.auditPath, "utf8")), "commitOrigin")).toBe(false);
});

it("real merge survivor commit→C raw restore is one-file only in both directions", async () => {
  const h = await fixture(),
    frozen = await h.freeze(1, "merge-survivor"),
    prepared = await h.prepare(frozen);
  expect(prepared.kind).toBe("ok");
  if (prepared.kind !== "ok") throw Error("real B/D merge failed");
  const x = await host(h, {
    frozen,
    proposal: prepared.proposal,
    generationMaxOutputTokens: 2048,
    coverageMaxOutputTokens: 2048,
  });
  const before = fs.readFileSync(h.targetPath),
    contextBefore = fs.readFileSync(h.contextPath);
  expect((await x.commit("web-b3")).kind).toBe("committed");
  expect(fs.readFileSync(h.targetPath).equals(before)).toBe(false);
  expect(fs.readFileSync(h.targetPath, "utf8")).toContain(prepared.proposal.generatedBody);
  expect(fs.readFileSync(h.contextPath)).toEqual(contextBefore);
  expect((await restoreRevisionRaw(h.dir, { actionId: frozen.actionId }, h.auditDeps)).kind).toBe("restored");
  expect(fs.readFileSync(h.targetPath)).toEqual(before);
  expect(fs.readFileSync(h.contextPath)).toEqual(contextBefore);
});

it("expected-after input rejects non-string origins without invoking object coercion or mutating prepared evidence", async () => {
  const h = await fixture(),
    owned = await action(h, "expires");
  await host(h, owned);
  const e = evidence(h, owned.frozen.batchId, owned.frozen.actionId),
    snapshots = e.read();
  let coerced = 0;
  const invalid = [
    [],
    ["web-b3"],
    ["p50-auto"],
    {},
    null,
    0,
    true,
    {
      toString() {
        coerced++;
        return "web-b3";
      },
    },
  ];
  await withMemoryDirLock(h.dir, () => {
    const app = prepareRevisionApplicationLocked(h.dir, owned.frozen, owned.proposal, now);
    for (const value of invalid) {
      const result = h.audit.persistExpectedAfterBarrierLocked({
        batchId: owned.frozen.batchId,
        actionId: owned.frozen.actionId,
        proposalDigest: owned.proposal.proposalDigest,
        commitOrigin: value as never,
        expected: app.expected,
      });
      expect(result.kind).toBe("corrupted");
      expect(e.read()).toEqual(snapshots);
    }
  });
  expect(coerced).toBe(0);
  expect(fs.readFileSync(h.targetPath)).toEqual(owned.frozen.target.rawBefore);
});

it("confirmed user expires remains restorable; hard delete ban is not a ban on every confirmed user operation", async () => {
  const h = await fixture(false, "user"),
    owned = await action(h, "expires"),
    x = await host(h, owned);
  expect((await x.commit("web-b3")).kind).toBe("committed");
  expect(fs.readFileSync(h.targetPath, "utf8")).toContain("expires: 2027-01-01");
  expect((await restoreRevisionRaw(h.dir, { actionId: owned.frozen.actionId }, h.auditDeps)).kind).toBe("restored");
  expect(fs.readFileSync(h.targetPath)).toEqual(owned.frozen.target.rawBefore);
});
