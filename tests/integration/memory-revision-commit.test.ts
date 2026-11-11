/** Two real Node processes freeze BEFORE either commit. The same canonical
 * lock serializes their conflicting CAS; no timing sleeps or mock lock. */
import * as fs from "node:fs";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { fixture, action, host } from "../memory/govern/revision-e-helpers.js";
import type { CommitActionResult, RevisionProposal } from "../../src/memory/jev/contracts.js";

it.each([false, true])(
  "real two-process conflicting CAS has one data effect (reverse start=%s)",
  async (reverse) => {
    const h = await fixture();
    fs.writeFileSync(
      h.targetPath,
      h.before.toString().replace("status: active", "expires: 2020-01-01\r\nstatus: active"),
    );
    const expiry = await action(h, "expires"),
      deletion = await action(h, "delete");
    await host(h, expiry);
    await host(h, deletion);
    const children: ChildProcess[] = [];
    const spawn = (proposal: RevisionProposal) => {
      const child = fork(
        fileURLToPath(new URL("../memory/govern/revision-commit-worker.ts", import.meta.url)),
        [h.dir, JSON.stringify(proposal)],
        { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );
      children.push(child);
      let output = "";
      child.stderr?.on("data", (data) => {
        output += String(data);
      });
      let readyResolve!: () => void, resultResolve!: (r: CommitActionResult) => void;
      let readyReject!: (e: Error) => void, resultReject!: (e: Error) => void;
      const ready = new Promise<void>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
      });
      const done = new Promise<CommitActionResult>((resolve, reject) => {
        resultResolve = resolve;
        resultReject = reject;
      });
      let gotResult = false;
      child.on("message", (message: { phase: string; result: CommitActionResult }) => {
        if (message.phase === "ready") readyResolve();
        if (message.phase === "done") {
          gotResult = true;
          resultResolve(message.result);
        }
      });
      child.on("error", (error) => {
        readyReject(error);
        resultReject(error);
      });
      child.on("exit", (code) => {
        if (code !== 0 || !gotResult) {
          const error = Error(`worker exit ${code}: ${output}`);
          readyReject(error);
          resultReject(error);
        }
      });
      // Attach immediately so an early process failure is never unhandled while
      // the sibling is still reaching its rendezvous.
      void done.catch(() => {});
      return { child, ready, done };
    };
    try {
      const ordered = reverse ? [deletion, expiry] : [expiry, deletion];
      const runs = ordered.map((o) => spawn(o.proposal));
      await Promise.all(runs.map((r) => r.ready));
      runs.forEach((r) => r.child.send("go"));
      const results = await Promise.all(runs.map((r) => r.done));
      expect(results.filter((r) => r.kind === "committed")).toHaveLength(1);
      expect(results.filter((r) => r.kind === "skipped")).toHaveLength(1);
      expect(results.find((r) => r.kind === "skipped")).toMatchObject({ reason: "stale" });
      const committed = results.find((r) => r.kind === "committed")!;
      if (committed.actionId === expiry.proposal.actionId) {
        const actual = fs.readFileSync(h.targetPath, "utf8");
        expect(actual).toContain("expires: 2027-01-01");
        expect(actual).toContain("version: 8");
        expect(fs.existsSync(`${h.blocks}/.trash`)).toBe(false);
      } else {
        expect(committed.actionId).toBe(deletion.proposal.actionId);
        expect(fs.existsSync(h.targetPath)).toBe(false);
        const names = fs.readdirSync(`${h.blocks}/.trash`);
        expect(names).toHaveLength(1);
        expect(fs.readFileSync(`${h.blocks}/.trash/${names[0]}`)).toEqual(deletion.frozen.target.rawBefore);
      }
      expect(fs.readFileSync(h.contextPath)).toEqual(h.contextBefore);
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    }
  },
  20_000,
);
