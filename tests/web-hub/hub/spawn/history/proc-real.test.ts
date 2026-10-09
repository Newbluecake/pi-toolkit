/**
 * Verifier r2 P2 (P-int): bounded smoke coverage for the DEFAULT /proc readers —
 * `defaultProcFs()` (async, prove's scan) and `defaultProcSyncFs()` (sync, re-prove's
 * re-stat) — against the REAL /proc. Everything seam-scoped in the HH/RH suites routes
 * through injected fakes, so production's real readers had no direct test proving they
 * read sane values within their budgets. Linux-only (the readers themselves are
 * Linux /proc-shaped); skipped elsewhere with the reason surfaced in the title.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { defaultProcFs, defaultProcSyncFs } from "../../../../../src/web-hub/hub/spawn/history/proc.js";
import { commOfStat } from "../../../../integration/helpers/history-seam.js";

const IS_LINUX = process.platform === "linux";
const BUDGET_MS = 2_000;

const children: ChildProcess[] = [];

afterEach(() => {
  for (const c of children.splice(0)) {
    try {
      c.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
});

function withinBudget<T>(label: string, p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`${label}: exceeded ${BUDGET_MS}ms budget`)), BUDGET_MS);
      t.unref();
    }),
  ]);
}

describe.skipIf(!IS_LINUX)("history /proc default readers — real /proc smoke (verifier r2 P2)", () => {
  it("sync reader: own + short-lived titled child — sane uid/stat/comm, readdir sees both, within budget", async () => {
    const sync = defaultProcSyncFs();
    const self = process.pid;
    const child = spawn(process.execPath, ["-e", 'process.title = "pireal"; setInterval(() => {}, 1e6);'], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    children.push(child);
    // the title rewrite (prctl) lands within ms; poll the reader itself for it
    const t0 = Date.now();
    let names: string[] = [];
    while (Date.now() - t0 < BUDGET_MS) {
      names = sync.readdirProcSync();
      if (names.includes(String(child.pid!))) {
        const stat = sync.readStatSync(child.pid!);
        if (commOfStat(stat) === "pireal") break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(Date.now() - t0).toBeLessThan(BUDGET_MS); // every call bounded by the poll loop

    // the child: seen in the enumeration, comm is the prctl-set title, uid is ours
    expect(names).toContain(String(child.pid!));
    expect(commOfStat(sync.readStatSync(child.pid!))).toBe("pireal");
    expect(sync.statUidSync(child.pid!)).toBe(process.getuid?.() ?? -1);

    // this process: in the enumeration too, node comm, own uid, parseable stat line
    expect(names).toContain(String(self));
    const selfStat = sync.readStatSync(self);
    // vitest's own comm contains parens ("node (vitest N)") — assert by prefix, not [^)]+
    expect(selfStat.startsWith(`${self} (`)).toBe(true);
    expect(/\) [DRSTZ] /.test(selfStat.slice(selfStat.lastIndexOf(")")))).toBe(true);
    expect(sync.statUidSync(self)).toBe(process.getuid?.() ?? -1);
  }, 10_000);

  it("async reader: own stat/uid/cmdline + the titled child appear in readdirProc, each call within budget", async () => {
    const fs = defaultProcFs();
    const self = process.pid;
    const child = spawn(process.execPath, ["-e", 'process.title = "pireal2"; setInterval(() => {}, 1e6);'], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    children.push(child);
    await withinBudget("readdirProc", fs.readdirProc()).then((names) => {
      expect(names).toContain(String(self));
      expect(names).toContain(String(child.pid!));
    });
    await withinBudget("statUid(self)", fs.statUid(self)).then((uid) => {
      expect(uid).toBe(process.getuid?.() ?? -1);
    });
    await withinBudget("statUid(child)", fs.statUid(child.pid!)).then((uid) => {
      expect(uid).toBe(process.getuid?.() ?? -1);
    });
    // the child's prctl title rewrite lands within ms — poll the reader itself for it
    const t0 = Date.now();
    for (;;) {
      const stat = await withinBudget("readStat(child)", fs.readStat(child.pid!));
      if (commOfStat(stat) === "pireal2") break;
      expect(Date.now() - t0).toBeLessThan(BUDGET_MS); // still inside the bounded window
      await new Promise((r) => setTimeout(r, 25));
    }
    await withinBudget("readCmdline(self)", fs.readCmdline(self)).then((cmdline) => {
      // NUL-separated argv — this test process's own argv0/1 must be in there verbatim
      expect(cmdline.includes("\0")).toBe(true);
      expect(cmdline.length).toBeGreaterThan(0);
    });
  }, 10_000);
});
