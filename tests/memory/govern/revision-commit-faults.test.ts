/** Actual syscall faults over own temp files; no provider/network/user data. */
import * as fs from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { fixture, action, host } from "./revision-e-helpers.js";
import * as safeFs from "../../../src/memory/safe-fs.js";
import { createRevisionAuditPort, restoreRevisionRaw } from "../../../src/memory/govern/revision-audit.js";
import { withMemoryDirLock } from "../../../src/memory/lock.js";
vi.mock("node:fs", async (original) => ({ ...(await original<typeof import("node:fs")>()) }));

it.each(["rename-throws-before", "rename-throws-after"] as const)(
  "opaque %s is unknown, never not-applied or retried",
  async (phase) => {
    const h = await fixture(),
      x = await host(h);
    const rename = fs.renameSync;
    let calls = 0;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === h.targetPath) {
        calls++;
        if (phase === "rename-throws-after") rename(from, to);
        throw Object.assign(new Error("opaque I/O outcome"), { code: "EIO" });
      }
      return rename(from, to);
    });
    const result = await x.commit();
    expect(result).toMatchObject({ kind: "effect-unknown", dataApplied: "unknown" });
    const bytes = fs.readFileSync(h.targetPath);
    expect(bytes.equals(h.before)).toBe(phase === "rename-throws-before");
    expect(calls).toBe(1);
    expect((await x.commit()).kind).toBe("effect-unknown");
    expect(calls).toBe(1);
    expect(fs.readFileSync(h.targetPath)).toEqual(bytes);
    const audit = await h.readAudit();
    expect(audit).toMatchObject({
      kind: "ok",
      audit: {
        state: "commit-unknown",
        commitOrigin: "p50-auto",
        commitObservation: { kind: "unknown", reason: "rename-outcome-unobserved" },
      },
    });
  },
);

it("delete real link + source-unlink failure retains dual paths in C across restart; no blind retry", async () => {
  const h = await fixture();
  fs.writeFileSync(
    h.targetPath,
    h.before.toString().replace("status: active", "expires: 2020-01-01\r\nstatus: active"),
  );
  const owned = await action(h, "delete"),
    x = await host(h, owned),
    unlink = fs.unlinkSync;
  let dataUnlinks = 0;
  vi.spyOn(fs, "unlinkSync").mockImplementation((path) => {
    if (String(path) === h.targetPath) {
      dataUnlinks++;
      throw Error("source unlink denied");
    }
    return unlink(path);
  });
  const result = await x.commit();
  expect(result).toMatchObject({ kind: "effect-unknown", dataApplied: "unknown" });
  const before = fs.readFileSync(h.targetPath);
  const trash = fs.readdirSync(join(h.blocks, ".trash"));
  expect(trash).toHaveLength(1);
  expect(fs.readFileSync(join(h.blocks, ".trash", trash[0]!))).toEqual(before);
  expect(fs.statSync(h.targetPath).ino).toBe(fs.statSync(join(h.blocks, ".trash", trash[0]!)).ino);
  const audit = await withMemoryDirLock(h.dir, () =>
    createRevisionAuditPort(h.dir, h.auditDeps).readActionLocked(owned.frozen.batchId, owned.frozen.actionId),
  );
  expect(audit).toMatchObject({
    kind: "ok",
    audit: {
      state: "commit-unknown",
      commitOrigin: "p50-auto",
      commitObservation: {
        kind: "unknown",
        paths: [
          { area: "blocks", name: "rules.001.md" },
          { area: "trash", name: trash[0] },
        ],
      },
    },
  });
  expect((await x.commit()).kind).toBe("effect-unknown");
  expect(dataUnlinks).toBe(1);
  expect((await restoreRevisionRaw(h.dir, { actionId: owned.frozen.actionId }, h.auditDeps)).kind).toBe("refused");
  expect(fs.readFileSync(h.targetPath)).toEqual(before);
});

it.each(["EPERM", "ENOTSUP", "EXDEV", "EEXIST"])(
  "delete %s has zero fallback/zero unlink, no overwrite",
  async (code) => {
    const h = await fixture();
    fs.writeFileSync(
      h.targetPath,
      h.before.toString().replace("status: active", "expires: 2020-01-01\r\nstatus: active"),
    );
    const owned = await action(h, "delete"),
      x = await host(h, owned),
      before = fs.readFileSync(h.targetPath);
    const link = fs.linkSync;
    const links = vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
      if (String(from) === h.targetPath) throw Object.assign(Error(code), { code });
      return link(from, to);
    });
    const rename = vi.spyOn(fs, "renameSync"),
      unlink = vi.spyOn(fs, "unlinkSync");
    expect(await x.commit()).toMatchObject({ kind: "skipped" });
    expect(links.mock.calls.filter((c) => String(c[0]) === h.targetPath)).toHaveLength(1);
    expect(unlink.mock.calls.filter((c) => String(c[0]) === h.targetPath)).toHaveLength(0);
    expect(rename.mock.calls.filter((c) => String(c[1]) === h.targetPath)).toHaveLength(0);
    expect(fs.readFileSync(h.targetPath)).toEqual(before);
    expect(fs.readdirSync(join(h.blocks, ".trash"))).toEqual([]);
  },
);

for (const kind of ["expires", "retire", "delete"] as const) {
  it.each(["post-gate", "data-fsync", "final-audit"] as const)(
    `${kind} %s failure retains bytes/proof; fresh committer zero second applier`,
    async (phase) => {
      const h = await fixture();
      if (kind === "delete")
        fs.writeFileSync(
          h.targetPath,
          h.before.toString().replace("status: active", "expires: 2020-01-01\r\nstatus: active"),
        );
      const owned = await action(h, kind),
        x = await host(h, owned);
      const rename = fs.renameSync,
        unlink = fs.unlinkSync,
        sync = safeFs.fsyncDir;
      let applied = false,
        dataCalls = 0;
      vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (applied && phase === "final-audit" && String(to).endsWith("/audit.json"))
          throw Error("finalization failure");
        rename(from, to);
        if (String(to) === h.targetPath) {
          applied = true;
          dataCalls++;
          if (phase === "post-gate") x.state.lease = false;
        }
      });
      vi.spyOn(fs, "unlinkSync").mockImplementation((path) => {
        unlink(path);
        if (String(path) === h.targetPath) {
          applied = true;
          dataCalls++;
          if (phase === "post-gate") x.state.lease = false;
        }
      });
      vi.spyOn(safeFs, "fsyncDir").mockImplementation((dir) => {
        if (phase === "data-fsync" && applied && dir === h.blocks) throw Error("data fsync failed");
        sync(dir);
      });
      expect(await x.commit(kind === "retire" ? "web-b3" : "p50-auto")).toMatchObject({
        kind: "effect-unknown",
        dataApplied: true,
      });
      expect(applied).toBe(true);
      expect(dataCalls).toBe(1);
      const actual = fs.existsSync(h.targetPath) ? fs.readFileSync(h.targetPath) : undefined;
      if (kind !== "delete") expect(actual?.equals(h.before)).toBe(false);
      else expect(actual).toBeUndefined();
      vi.restoreAllMocks();
      x.state.lease = true;
      const applier = vi.spyOn(safeFs, kind === "delete" ? "deleteRevisionObserved" : "replaceRevisionObserved");
      expect((await x.commit(kind === "retire" ? "web-b3" : "p50-auto")).kind).toBe("effect-unknown");
      expect(applier.mock.calls.filter((c) => c[0] === h.blocks)).toHaveLength(0);
      expect(fs.existsSync(h.targetPath) ? fs.readFileSync(h.targetPath) : undefined).toEqual(actual);
      const a = await withMemoryDirLock(h.dir, () =>
        createRevisionAuditPort(h.dir, h.auditDeps).readActionLocked(owned.frozen.batchId, owned.frozen.actionId),
      );
      expect(a).toMatchObject({ kind: "ok", audit: { commitOrigin: kind === "retire" ? "web-b3" : "p50-auto" } });
      if (a.kind !== "ok") throw Error("lost evidence");
      expect(a.before).toEqual(owned.frozen.target.rawBefore);
      expect(a.expectedAfter?.kind).toBe(kind === "delete" ? "missing" : "file");
    },
  );
}

it.each(["prepared-file-fsync", "expected-file-fsync", "prepared-audit-rename", "expected-audit-rename"] as const)(
  "actual %s failure has zero data namespace syscalls",
  async (phase) => {
    const h = await fixture(),
      x = await host(h),
      rename = fs.renameSync,
      fsync = fs.fsyncSync;
    if (phase.startsWith("prepared")) fs.rmSync(h.actionPath(), { recursive: true });
    let afterStarted = false,
      dataCalls = 0;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to).endsWith("/after.md")) afterStarted = true;
      if (String(to) === h.targetPath) dataCalls++;
      if (
        String(to).endsWith("/audit.json") &&
        phase.endsWith("audit-rename") &&
        phase.startsWith("expected") === afterStarted
      )
        throw Error("audit rename failure");
      return rename(from, to);
    });
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      // writeTempRegular's first fsync after expected phase begins is after.md.
      const path = fs.readlinkSync(`/proc/self/fd/${fd}`);
      const expected = path.includes(".after.md.");
      const prepared = path.endsWith("/before.md") || path.includes(".before.md.");
      if ((phase === "prepared-file-fsync" && prepared) || (phase === "expected-file-fsync" && expected))
        throw Error("file fsync failed");
      return fsync(fd);
    });
    expect((await x.commit()).kind).toBe("skipped");
    expect(dataCalls).toBe(0);
    expect(fs.readFileSync(h.targetPath)).toEqual(h.before);
  },
);

it("a confirmed survivor rewrite touches one file only, automatic merge/retire remain refused", async () => {
  const h = await fixture();
  const frozen = await h.freeze(1, "merge-survivor");
  const prepared = await h.prepare(frozen);
  expect(prepared.kind).toBe("ok");
  if (prepared.kind !== "ok") throw Error("merge preparation failed");
  const merge = await host(h, {
    frozen,
    proposal: prepared.proposal,
    generationMaxOutputTokens: 2048,
    coverageMaxOutputTokens: 2048,
  });
  expect(prepared.proposal.autoEligible).toBe(false);
  expect(await merge.commit()).toMatchObject({ kind: "skipped", reason: "permission" });
  const context = fs.readFileSync(h.contextPath);
  expect((await merge.commit("web-b3")).kind).toBe("committed");
  expect(fs.readFileSync(h.contextPath)).toEqual(context);
  expect(fs.readFileSync(h.targetPath, "utf8")).toContain(prepared.proposal.generatedBody);
  // A separate retire is neither inferred nor automatically authorized.
  const owned = await action(h, "retire"),
    x = await host(h, owned);
  expect(await x.commit()).toMatchObject({ kind: "skipped", reason: "permission" });
  expect(x.confirm).not.toHaveBeenCalled();
  expect(fs.readFileSync(h.contextPath)).toEqual(context);
});
