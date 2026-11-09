import * as fs from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { setup, setupMany } from "./revision-retire-helpers.js";
import { host, fixture } from "./revision-e-helpers.js";
import * as safeFs from "../../../src/memory/safe-fs.js";
import { restoreRevisionRaw } from "../../../src/memory/govern/revision-audit.js";

it.each([false, true])(
  "one admitted full retire batch caps two actual actions, unknown=%s and low-confidence consumes none",
  async (unknown) => {
    const options: { coverageVerdict: "partial" | "complete" } = { coverageVerdict: "partial" };
    const { h, pairs, frozen } = await setupMany(4, options);
    const low = await h.prepareRetire(frozen[0]!);
    expect(low.kind).toBe("ok");
    if (low.kind !== "ok") throw Error("low unavailable");
    expect(low.proposal.autoEligible).toBe(false);
    const lowHost = await host(h, { frozen: frozen[0]!, proposal: low.proposal });
    expect((await lowHost.commit()).kind).toBe("skipped");
    options.coverageVerdict = "complete";
    const hosts = [];
    for (let i = 1; i < 4; i++) {
      const prepared = await h.prepareRetire(frozen[i]!);
      if (prepared.kind !== "ok") throw Error("retire unavailable");
      expect(prepared.proposal.autoEligible).toBe(true);
      hosts.push(await host(h, { frozen: frozen[i]!, proposal: prepared.proposal }));
    }
    const batchId = frozen[0]!.batchId;
    expect(frozen.every((f) => f.batchId === batchId)).toBe(true);
    const successorBytes = pairs.map((p) => fs.readFileSync(join(h.blocks, `${p.successor}.md`)));
    if (unknown) {
      const actual = safeFs.replaceRevisionObserved;
      vi.spyOn(safeFs, "replaceRevisionObserved").mockImplementation((...args) => {
        const result = actual(...args);
        return args[0] === h.blocks && args[2] === `${pairs[1]!.target}.md`
          ? { ...result, error: "after real rename" }
          : result;
      });
    }
    expect((await hosts[0]!.commit()).kind).toBe(unknown ? "effect-unknown" : "committed");
    vi.restoreAllMocks();
    expect((await hosts[1]!.commit()).kind).toBe("committed");
    const beforeThird = fs.readFileSync(join(h.blocks, `${pairs[3]!.target}.md`));
    expect(await hosts[2]!.commit()).toMatchObject({ kind: "skipped", reason: "permission" });
    expect(fs.readFileSync(join(h.blocks, `${pairs[3]!.target}.md`))).toEqual(beforeThird);
    for (let i = 0; i < pairs.length; i++)
      expect(fs.readFileSync(join(h.blocks, `${pairs[i]!.successor}.md`))).toEqual(successorBytes[i]);
    expect(frozen.every((f) => f.batchId === batchId)).toBe(true); // no retry-made batch/epoch/policy
  },
);

it.each([
  "prepared-file",
  "prepared-dir",
  "expected-file",
  "expected-dir",
  "post-gate",
  "data-fsync",
  "final-audit",
  "observer",
] as const)(
  "retire %s fault preserves exact evidence/successor and never retries an uncertain data action",
  async (phase) => {
    const h = await setup(),
      owned = await h.retire(),
      x = await host(h, owned);
    const actionDir = h.actionPath(owned.frozen),
      originalSourceAudit = fs.readFileSync(h.sourceAuditPath);
    const apply = safeFs.replaceRevisionObserved,
      sync = safeFs.fsyncDir,
      fileSync = safeFs.fsyncRevisionFile;
    let after = false,
      applied = false,
      dataCalls = 0;
    vi.spyOn(safeFs, "replaceRevisionObserved").mockImplementation((...args) => {
      if (args[0] === actionDir && args[2] === "after.md") after = true;
      if (phase === "final-audit" && applied && args[0] === actionDir && args[2] === "audit.json")
        throw Error("final audit failure");
      const r = apply(...args);
      if (args[0] === h.blocks) {
        dataCalls++;
        applied = r.observation.kind === "applied";
        if (phase === "post-gate") x.state.lease = false;
        if (phase === "observer") return { ...r, error: "post-rename observer failure" };
      }
      return r;
    });
    vi.spyOn(safeFs, "fsyncRevisionFile").mockImplementation((...args) => {
      if (args[0] === actionDir && ((phase === "prepared-file" && !after) || (phase === "expected-file" && after)))
        throw Error("evidence file sync fault");
      return fileSync(...args);
    });
    vi.spyOn(safeFs, "fsyncDir").mockImplementation((dir) => {
      if (
        (dir === actionDir &&
          ((phase === "prepared-dir" && !after) || (phase === "expected-dir" && after && !applied))) ||
        (phase === "data-fsync" && applied && dir === h.blocks)
      )
        throw Error("directory sync fault");
      return sync(dir);
    });
    const result = await x.commit();
    const beforeData = phase.startsWith("prepared") || phase.startsWith("expected");
    expect(result.kind).toBe(beforeData ? "skipped" : "effect-unknown");
    expect(dataCalls).toBe(beforeData ? 0 : 1);
    const bytes = fs.readFileSync(h.contextPath);
    expect(bytes.equals(h.oldBefore)).toBe(!applied);
    expect(fs.readFileSync(h.targetPath)).toEqual(h.successorAfter);
    expect(fs.readFileSync(h.sourceAuditPath)).toEqual(originalSourceAudit);
    vi.restoreAllMocks();
    x.state.lease = true;
    if (!beforeData || after) {
      const retry = vi.spyOn(safeFs, "replaceRevisionObserved");
      expect((await x.commit()).kind).toBe("effect-unknown");
      expect(retry.mock.calls.filter((c) => c[0] === h.blocks)).toHaveLength(0);
      expect(fs.readFileSync(h.contextPath)).toEqual(bytes);
      expect((await restoreRevisionRaw(h.dir, { actionId: owned.frozen.actionId }, h.auditDeps)).kind).toBe("refused");
    }
  },
);

it.each([
  "target-rev",
  "successor-rev",
  "target-authority",
  "successor-private",
  "target-archive",
  "blocks-inode",
  "lease",
  "owner",
  "gate",
  "dismiss",
  "resolved",
] as const)("retire live %s check prevents late/unauthorized action", async (which) => {
  const h = await setup(),
    owned = await h.retire(),
    x = await host(h, owned);
  if (which === "target-rev") fs.appendFileSync(h.contextPath, "\nuser new rule");
  if (which === "successor-rev") fs.appendFileSync(h.targetPath, "\nuser new survivor");
  if (which === "target-authority")
    fs.writeFileSync(h.contextPath, h.oldBefore.toString().replace("authority: agent", "authority: user"));
  if (which === "successor-private")
    fs.writeFileSync(
      h.targetPath,
      h.successorAfter.toString().replace("status: active", "private: true\nstatus: active"),
    );
  if (which === "target-archive") {
    fs.mkdirSync(join(h.blocks, "archive"));
    fs.renameSync(h.contextPath, join(h.blocks, "archive/rules.002.md"));
  }
  if (which === "blocks-inode") {
    fs.renameSync(h.blocks, `${h.blocks}-held`);
    fs.mkdirSync(h.blocks, { mode: 0o700 });
    fs.cpSync(`${h.blocks}-held`, h.blocks, { recursive: true });
  }
  if (which === "lease") x.state.lease = false;
  if (which === "owner") h.state.current = false;
  if (which === "gate") x.state.autoEnabled = false;
  if (which === "dismiss" || which === "resolved") {
    const index = JSON.parse(fs.readFileSync(h.indexPath, "utf8")),
      key = JSON.stringify(["revision", "retire", "rules.001", "rules.002"]);
    if (which === "dismiss")
      index.review.dismissed.push({ suggestionKey: key, hashKey: "x", anchorKey: "x", kind: "supersedes" });
    else index.review.resolved = [key];
    fs.writeFileSync(h.indexPath, JSON.stringify(index));
  }
  const before = fs.existsSync(h.contextPath) ? fs.readFileSync(h.contextPath) : undefined;
  const successor = fs.readFileSync(h.targetPath);
  const data = vi.spyOn(safeFs, "replaceRevisionObserved");
  expect((await x.commit()).kind).toBe("skipped");
  expect(data.mock.calls.filter((c) => c[0] === h.blocks)).toHaveLength(0);
  expect(fs.existsSync(h.contextPath) ? fs.readFileSync(h.contextPath) : undefined).toEqual(before);
  expect(fs.readFileSync(h.targetPath)).toEqual(successor);
});

it.each(["prepared-file", "expected-file", "expected-dir"] as const)(
  "real source merge %s barrier failure retains frozen request spec and cannot yield a committed source",
  async (phase) => {
    const h = await fixture(),
      frozen = await h.freeze(1, "merge-survivor"),
      prepared = await h.prepare(frozen);
    if (prepared.kind !== "ok") throw Error("source prepare failed");
    const x = await host(h, { frozen, proposal: prepared.proposal, generationMaxOutputTokens: 2048 });
    const actionDir = h.actionPath(frozen),
      fileSync = safeFs.fsyncRevisionFile,
      sync = safeFs.fsyncDir,
      replace = safeFs.replaceRevisionObserved;
    let after = false,
      dataCalls = 0;
    vi.spyOn(safeFs, "replaceRevisionObserved").mockImplementation((...args) => {
      if (args[0] === actionDir && args[2] === "after.md") after = true;
      if (args[0] === h.blocks) dataCalls++;
      return replace(...args);
    });
    vi.spyOn(safeFs, "fsyncRevisionFile").mockImplementation((...args) => {
      if (args[0] === actionDir && ((phase === "prepared-file" && !after) || (phase === "expected-file" && after)))
        throw Error("source evidence file fault");
      fileSync(...args);
    });
    vi.spyOn(safeFs, "fsyncDir").mockImplementation((dir) => {
      if (phase === "expected-dir" && after && dir === actionDir) throw Error("source expected directory fault");
      sync(dir);
    });
    expect((await x.commit("web-b3")).kind).toBe("skipped");
    expect(dataCalls).toBe(0);
    expect(fs.readFileSync(h.targetPath)).toEqual(frozen.target.rawBefore);
    expect(fs.readFileSync(h.contextPath)).toEqual(frozen.context!.rawBefore);
    const a = JSON.parse(fs.readFileSync(join(actionDir, "audit.json"), "utf8"));
    expect(a.state).not.toBe("committed");
    expect(a.generationRequest).toEqual(prepared.proposal.generationRequest);
  },
);
