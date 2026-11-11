/** Real processes, actual locks/CAS/C restore intents; no timing sleep or mock
 * success. Model work runs beforehand on the existing controlled client. */
import * as fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fork, type ChildProcess } from "node:child_process";
import { expect, it } from "vitest";
import { setup } from "../memory/govern/revision-retire-helpers.js";
import { host } from "../memory/govern/revision-e-helpers.js";
import { withMemoryDirLock } from "../../src/memory/lock.js";
import { freezeRevisionInputsLocked } from "../../src/memory/govern/revision.js";
import type { CommitActionResult, RestoreRevisionResult, RevisionProposal } from "../../src/memory/jev/contracts.js";
function worker(
  mem: string,
  p: RevisionProposal,
  mode: "retire" | "restore" | "restore-put-back",
  children: ChildProcess[],
) {
  const child = fork(
    fileURLToPath(new URL("../memory/govern/revision-retire-worker.ts", import.meta.url)),
    [mem, JSON.stringify(p), mode],
    { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  children.push(child);
  let stderr = "",
    completed = false;
  child.stderr?.on("data", (data) => {
    stderr += String(data);
  });
  let readyResolve!: () => void, readyReject!: (e: Error) => void;
  let doneResolve!: (r: CommitActionResult | RestoreRevisionResult) => void, doneReject!: (e: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const done = new Promise<CommitActionResult | RestoreRevisionResult>((resolve, reject) => {
    doneResolve = resolve;
    doneReject = reject;
  });
  void done.catch(() => {});
  child.on("message", (m: { phase: string; result: CommitActionResult | RestoreRevisionResult }) => {
    if (m.phase === "ready") readyResolve();
    if (m.phase === "done") {
      completed = true;
      doneResolve(m.result);
    }
  });
  child.on("error", (e) => {
    readyReject(e);
    doneReject(e);
  });
  child.on("exit", (code) => {
    if (code !== 0 || !completed) {
      const e = Error(`worker ${mode} exit ${code}: ${stderr}`);
      readyReject(e);
      doneReject(e);
    }
  });
  return { ready, done, go: () => child.send("go") };
}

it.each([false, true])(
  "two real retire CAS requests for one old block have one effect (reverse=%s)",
  async (reverse) => {
    const h = await setup();
    fs.writeFileSync(join(h.blocks, "rules.003.md"), h.sourceFrozen.target.rawBefore, { mode: 0o600 });
    // Second genuine source, same still-active old context, independently
    // admitted before either competing retirement is attempted.
    const secondSource = await withMemoryDirLock(h.dir, () =>
      freezeRevisionInputsLocked(
        h.dir,
        {
          directory: h.sourceFrozen.directory,
          selectionBatchId: "second-source-pass",
          policyVersion: h.sourceFrozen.policyVersion,
          action: "merge-survivor",
          target: h.parse("rules.003"),
          context: h.parse("rules.002"),
        },
        { isCurrent: () => true },
      ),
    );
    if ("kind" in secondSource) throw Error("second source freeze");
    const prepared = await h.prepare(secondSource);
    if (prepared.kind !== "ok") throw Error("second source generate");
    const sourceHost = await host(h, {
      frozen: secondSource,
      proposal: prepared.proposal,
      generationMaxOutputTokens: 2048,
    });
    expect((await sourceHost.commit("web-b3")).kind).toBe("committed");
    const a = await h.retire();
    const bFrozen = await withMemoryDirLock(h.dir, () =>
      freezeRevisionInputsLocked(
        h.dir,
        {
          directory: h.sourceFrozen.directory,
          selectionBatchId: "second-admitted-session-pass",
          policyVersion: h.sourceFrozen.policyVersion,
          action: "retire",
          target: h.parse("rules.002"),
          context: h.parse("rules.003"),
          retireSource: {
            batchId: secondSource.batchId,
            actionId: secondSource.actionId,
            proposalDigest: prepared.proposal.proposalDigest,
          },
        },
        { isCurrent: () => true, audit: h.freshAudit() },
      ),
    );
    if ("kind" in bFrozen) throw Error("second retire freeze");
    const bPrepared = await h.prepareRetire(bFrozen);
    if (bPrepared.kind !== "ok") throw Error("second retire prepare");
    const b = { frozen: bFrozen, proposal: bPrepared.proposal };
    await host(h, a);
    await host(h, b);
    expect(a.proposal.batchId).not.toBe(b.proposal.batchId); // two distinct, fixed full candidate sets
    const beforeS1 = fs.readFileSync(h.targetPath),
      beforeS2 = fs.readFileSync(join(h.blocks, "rules.003.md"));
    const children: ChildProcess[] = [];
    try {
      const ordered = reverse ? [b.proposal, a.proposal] : [a.proposal, b.proposal];
      const runs = ordered.map((p) => worker(h.dir, p, "retire", children));
      await Promise.all(runs.map((r) => r.ready));
      runs.forEach((r) => r.go());
      const results = await Promise.all(runs.map((r) => r.done));
      expect(results.filter((r) => r.kind === "committed")).toHaveLength(1);
      expect(results.filter((r) => r.kind === "skipped")).toHaveLength(1);
      expect(results.find((r) => r.kind === "skipped")).toMatchObject({ reason: "stale" });
      const winningIndex = results.findIndex((r) => r.kind === "committed"),
        winner = ordered[winningIndex]!;
      expect(fs.readFileSync(h.contextPath, "utf8")).toContain(`supersededBy: ${winner.contextId}`);
      expect(fs.readFileSync(h.contextPath, "utf8")).toContain("version: 8");
      expect(fs.readFileSync(h.targetPath)).toEqual(beforeS1);
      expect(fs.readFileSync(join(h.blocks, "rules.003.md"))).toEqual(beforeS2);
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    }
  },
  20_000,
);

it.each([false, true])(
  "real source restore competes on same memDir lock; put-back-after=%s never repairs its qualification",
  async (putBack) => {
    const h = await setup(),
      owned = await h.retire();
    await host(h, owned);
    const children: ChildProcess[] = [];
    try {
      const retire = worker(h.dir, owned.proposal, "retire", children);
      const restore = worker(h.dir, owned.proposal, putBack ? "restore-put-back" : "restore", children);
      await Promise.all([retire.ready, restore.ready]);
      retire.go();
      restore.go();
      const [rr, sr] = await Promise.all([retire.done, restore.done]);
      expect(sr.kind).toBe("restored");
      expect(["committed", "skipped"]).toContain(rr.kind);
      if (rr.kind === "skipped") {
        expect(rr.reason).toBe("stale");
        expect(fs.readFileSync(h.contextPath)).toEqual(h.oldBefore);
        // Even with after bytes restored by hand, a new prepare can only suggest.
        if (putBack) await expect(h.freezeRetire()).rejects.toThrow("retire freeze unavailable");
      } else expect(fs.readFileSync(h.contextPath, "utf8")).toContain("supersededBy: rules.001");
      expect(fs.readFileSync(h.targetPath)).toEqual(putBack ? h.successorAfter : h.sourceFrozen.target.rawBefore);
      const a = JSON.parse(fs.readFileSync(h.sourceAuditPath, "utf8"));
      expect(a.state).toBe("restored");
      expect(a.generationRequest).toEqual(h.sourceProposal.generationRequest);
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    }
  },
  20_000,
);

it.each(["restore-first", "retire-first"] as const)(
  "two frozen real processes observe the %s linearization, including put-back-after",
  async (order) => {
    const h = await setup(),
      owned = await h.retire();
    await host(h, owned);
    const children: ChildProcess[] = [];
    try {
      const retire = worker(h.dir, owned.proposal, "retire", children),
        restore = worker(h.dir, owned.proposal, "restore-put-back", children);
      await Promise.all([retire.ready, restore.ready]);
      if (order === "restore-first") {
        restore.go();
        expect((await restore.done).kind).toBe("restored");
        expect(fs.readFileSync(h.targetPath)).toEqual(h.successorAfter);
        retire.go();
        expect(await retire.done).toMatchObject({ kind: "skipped", reason: "stale" });
        expect(fs.readFileSync(h.contextPath)).toEqual(h.oldBefore);
      } else {
        retire.go();
        expect((await retire.done).kind).toBe("committed");
        restore.go();
        expect((await restore.done).kind).toBe("restored");
        expect(fs.readFileSync(h.contextPath, "utf8")).toContain("supersededBy: rules.001");
      }
      expect(fs.readFileSync(h.targetPath)).toEqual(h.successorAfter);
      expect(JSON.parse(fs.readFileSync(h.sourceAuditPath, "utf8")).state).toBe("restored");
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    }
  },
  20_000,
);
