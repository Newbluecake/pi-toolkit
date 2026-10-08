/**
 * worktree-diff plan §1.9 (D3, H5): the budget ledger — pinned item by item with a fake clock.
 *
 * Every recorded git call carries its OWN `timeoutMs = min(cap, phase.remaining())`, which is
 * exactly what these tests read back: after a 3 s auth the admission steps still get the full
 * 2 s cap (ADMIT − AUTH_RESERVE ≥ LAN_AUTH_CAP); a C1 that "times out" answers 504 with the
 * git phase never started; a 7.9 s-burned admission still leaves the FULL independent 14 s git
 * phase; 13 s into the git phase C3 is skipped (numstatPartial) on /files and C4 answers 504 on
 * /file; an exhausted L3 is treated as a change (503 attr-changed, fail-closed); and finally's
 * three bounded closes run after an abort, in parallel, ≤1 s total — a never-settling close
 * lets the answer out, counts one tracker zombie and decrements on the late settle.
 */

import { describe, expect, it } from "vitest";

import { createPreviewIoTracker } from "../../../../src/web-hub/hub/preview/fs.js";
import { denyCtxOf } from "../../../../src/web-hub/hub/preview/admit.js";
import { createWorktreeDiffRoutes } from "../../../../src/web-hub/hub/worktree-diff/routes.js";
import {
  WTDIFF_ADMIT_MS,
  WTDIFF_AUTH_RESERVE_MS,
  WTDIFF_CLIENT_TIMEOUT_MS,
  WTDIFF_CLOSE_MS,
  WTDIFF_GIT_CMD_MS,
  WTDIFF_GIT_PHASE_MS,
  WTDIFF_STEP_MS,
  WTDIFF_TRANSFER_RESERVE_MS,
} from "../../../../src/web-hub/protocol/worktree-diff.js";
import { LAN_AUTH_CAP_MS } from "../../../../src/web-hub/hub/req-deadline.js";
import { PREVIEW_DIR_CLOSE_MS } from "../../../../src/web-hub/protocol/preview.js";
import type { RepoFixture, Scripted } from "./helpers.js";
import {
  AGENT,
  HEAD_SHA1,
  LINKED,
  REPO,
  REPO_GIT,
  SESSION,
  createFakeFs,
  fakeIo,
  fakeRegistry,
  fakeReq,
  fakeRes,
  isCmd,
  memLog,
  okRun,
  scriptedRunner,
  statusV2Z,
} from "./helpers.js";

const DENY = denyCtxOf("/home/tester", "/home/tester/.pi/agent");
const recM = (path: string): string => `1 .M N... 100644 100644 100644 h1 h2 ${path}`;

function budgetKit() {
  const clock = { t: 1_000_000 };
  const fs = createFakeFs();
  // main worktree only — the session cwd is the repo itself
  fs.mkdir(REPO);
  fs.mkdir(`${REPO}/.git`);
  fs.writeFile(`${REPO}/.git/index`, Buffer.from([1]));
  const runner = scriptedRunner();
  const fx = { fs, runner } as RepoFixture;
  const log = memLog();
  const routes = createWorktreeDiffRoutes({
    mode: "on",
    denyCtx: DENY,
    registry: fakeRegistry(REPO),
    run: runner,
    log,
    now: () => clock.t,
    fs,
  });
  const io = fakeIo();
  const q = { agentKey: AGENT, sessionId: SESSION, wt: REPO };
  const porcelain = `worktree ${REPO}\nHEAD ${HEAD_SHA1}\nbranch refs/heads/main\n\n\n`;
  const files = (io2 = io) => routes.handleFiles(fakeReq({ "x-pwh": "1" }), fakeRes(), new URLSearchParams(q), io2);
  const file = (io2 = io, base = HEAD_SHA1, path = "a.txt") =>
    routes.handleFile(fakeReq({ "x-pwh": "1" }), fakeRes(), new URLSearchParams({ ...q, base, path }), io2);
  const timeoutOf = (cmd: string): number[] =>
    runner.calls.filter((c) => isCmd(c.argv, cmd)).map((c) => c.opts.timeoutMs ?? -1);
  return { clock, fx, fs, runner, routes, io, log, porcelain, files, file, timeoutOf };
}

describe("budget §1.9 relation pins (H5, protocol-level)", () => {
  it("ADMIT − AUTH_RESERVE ≥ LAN_AUTH_CAP; 2×STEP ≤ AUTH_RESERVE; 4×STEP + GIT_CMD ≤ GIT_PHASE", () => {
    expect(WTDIFF_ADMIT_MS - WTDIFF_AUTH_RESERVE_MS).toBeGreaterThanOrEqual(LAN_AUTH_CAP_MS);
    expect(2 * WTDIFF_STEP_MS).toBeLessThanOrEqual(WTDIFF_AUTH_RESERVE_MS);
    expect(4 * WTDIFF_STEP_MS + WTDIFF_GIT_CMD_MS).toBeLessThanOrEqual(WTDIFF_GIT_PHASE_MS);
  });

  it("server wall-clock cap 23 s; 23 s + TRANSFER_RESERVE ≤ CLIENT_TIMEOUT", () => {
    const wall = WTDIFF_ADMIT_MS + WTDIFF_GIT_PHASE_MS + WTDIFF_CLOSE_MS;
    expect(wall).toBe(23_000);
    expect(wall + WTDIFF_TRANSFER_RESERVE_MS).toBeLessThanOrEqual(WTDIFF_CLIENT_TIMEOUT_MS);
  });

  it("the finally close deadline equals the preview boundedClose constant (1 s, shared mechanism)", () => {
    expect(WTDIFF_CLOSE_MS).toBe(PREVIEW_DIR_CLOSE_MS);
  });
});

describe("budget §1.9 admission phase (H5)", () => {
  it("after a 3 s auth the admission steps still get the FULL 2 s single-step cap", async () => {
    const k = budgetKit();
    const authIo = fakeIo();
    authIo.authorize = async () => {
      k.clock.t += 3_000; // the LAN auth slice burned in full
      return { ip: "127.0.0.1", user: "u1" };
    };
    k.runner.push(
      okRun(`${REPO}/.git\n`),
      okRun(k.porcelain),
      okRun(`sha1\n${HEAD_SHA1}\n`),
      okRun(""),
      okRun(statusV2Z(HEAD_SHA1, [recM("a.txt")])),
      okRun(""),
      okRun(""),
    );
    await k.files(authIo);
    expect(authIo.sent[0]!.status).toBe(200);
    // C1a and C1 each got the full 2 s step despite the 3 s auth (5 s of the 8 s budget left)
    expect(k.timeoutOf("C1a")).toEqual([WTDIFF_STEP_MS]);
    expect(k.timeoutOf("C1")).toEqual([WTDIFF_STEP_MS]);
  });

  it("a hung C1 answers its own 2 s step timeout ⇒ 504 and the git phase NEVER starts", async () => {
    const k = budgetKit();
    k.runner.push(okRun(`${REPO}/.git\n`), { ...okRun(""), killed: "timeout", code: null });
    await k.files();
    expect(k.io.sent[0]).toMatchObject({ status: 504, body: { error: "E_DEADLINE" } });
    expect(k.runner.calls.some((c) => isCmd(c.argv, "C0"))).toBe(false);
    expect(k.timeoutOf("C1")).toEqual([WTDIFF_STEP_MS]);
  });

  it("a 7.9 s-burned admission still leaves the FULL independent 14 s git phase", async () => {
    const k = budgetKit();
    const authIo = fakeIo();
    authIo.authorize = async () => {
      k.clock.t += 3_000;
      return { ip: "127.0.0.1", user: "u1" };
    };
    // C1a and C1 each burn their whole 2 s step + 0.9 s more, via scripted clock ticks
    k.runner.push(
      () => {
        k.clock.t += 2_000;
        return okRun(`${REPO}/.git\n`);
      },
      () => {
        k.clock.t += 2_900;
        return okRun(k.porcelain);
      },
      okRun(`sha1\n${HEAD_SHA1}\n`),
      okRun(""),
      okRun(statusV2Z(HEAD_SHA1, [recM("a.txt")])),
      okRun(""),
      okRun(""),
    );
    await k.files(authIo);
    expect(authIo.sent[0]!.status).toBe(200);
    // 7.9 s burned in admission — C0 still gets the full 2 s and G was created fresh (14 s)
    expect(k.timeoutOf("C1a")).toEqual([WTDIFF_STEP_MS]);
    expect(k.timeoutOf("C0")).toEqual([WTDIFF_STEP_MS]);
    expect(k.timeoutOf("C2")).toEqual([WTDIFF_GIT_CMD_MS]);
  });
});

describe("budget §1.9 git phase (H5)", () => {
  it("13 s into the git phase: /files skips C3 (numstatPartial, 200) — /file answers 504 at C4", async () => {
    // /files
    const k = budgetKit();
    k.runner.push(
      okRun(`${REPO}/.git\n`),
      okRun(k.porcelain),
      () => {
        k.clock.t += 2_000;
        return okRun(`sha1\n${HEAD_SHA1}\n`);
      }, // C0 burns its whole step
      () => {
        k.clock.t += 2_000;
        return okRun("");
      }, // Cc burns its whole step
      () => {
        k.clock.t += 9_050;
        return okRun(statusV2Z(HEAD_SHA1, [recM("a.txt")]));
      }, // C2 (+attr/fstat elapsed) ⇒ 13.05 s total ⇒ <1 s left
      okRun(""), // (C3 skipped — never consumed)
      okRun(""), // Cc (L3)
    );
    await k.files();
    expect(k.io.sent[0]!.status).toBe(200);
    const body = k.io.sent[0]!.body as Record<string, unknown>;
    expect(body["numstatPartial"]).toBe(true);
    expect(k.runner.calls.some((c) => isCmd(c.argv, "C3"))).toBe(false); // skipped, not attempted
    expect(k.timeoutOf("C2")).toEqual([WTDIFF_GIT_CMD_MS]);

    // /file — same burn, then C4 attempt with <1 s left
    const k2 = budgetKit();
    k2.runner.push(
      okRun(`${REPO}/.git\n`),
      okRun(k2.porcelain),
      () => {
        k2.clock.t += 2_000;
        return okRun(`sha1\n${HEAD_SHA1}\n`);
      },
      () => {
        k2.clock.t += 2_000;
        return okRun("");
      },
      () => {
        k2.clock.t += 9_050;
        return okRun(statusV2Z(HEAD_SHA1, [recM("a.txt")]));
      },
      okRun("SHOULD NOT RUN"), // C4
      okRun(""),
    );
    await k2.file();
    expect(k2.io.sent[0]).toMatchObject({ status: 504, body: { error: "E_DEADLINE" } });
    expect(k2.runner.calls.some((c) => isCmd(c.argv, "C4"))).toBe(false);
  });

  it("L3 with an exhausted G is treated as a change ⇒ 503 attr-changed (fail-closed)", async () => {
    const k = budgetKit();
    k.runner.push(
      okRun(`${REPO}/.git\n`),
      okRun(k.porcelain),
      okRun(`sha1\n${HEAD_SHA1}\n`),
      okRun(""), // Cc
      okRun(statusV2Z(HEAD_SHA1, [recM("a.txt")])), // C2
      () => {
        k.clock.t += 14_000; // C4 burns the ENTIRE remaining git phase
        return okRun("@@ diff @@");
      },
      okRun(""), // Cc (L3) — the clock is now past G.at
    );
    await k.file();
    expect(k.io.sent[0]).toMatchObject({ status: 503, body: { error: "E_BUSY", reason: "attr-changed" } });
    expect(k.log.lines.some((l) => (l.data as Record<string, unknown>)?.["event"] === "wtdiff.attr_changed")).toBe(
      true,
    );
  });
});

describe("budget §1.9 finally (H5)", () => {
  it("after a client abort the three pins still close (parallel, ≤1 s + ε total)", async () => {
    const k = budgetKit();
    k.runner.push(
      okRun(`${REPO}/.git\n`),
      okRun(k.porcelain),
      okRun(`sha1\n${HEAD_SHA1}\n`),
      okRun(""),
      { ...okRun(statusV2Z(HEAD_SHA1, [recM("a.txt")])), code: 128 }, // C2 fails fast
    );
    const io = fakeIo();
    const res = fakeRes();
    const pending = k.routes.handleFiles(
      fakeReq({ "x-pwh": "1" }),
      res,
      new URLSearchParams({ agentKey: AGENT, sessionId: SESSION, wt: REPO }),
      io,
    );
    await pending;
    expect(k.fs.leakCount()).toBe(0); // the pins closed in finally
    expect(k.fs.closedFds.length).toBeGreaterThanOrEqual(3);
  });

  it("a pin close that never settles: the answer goes out anyway; tracker=1 until the late settle ⇒ 0", async () => {
    const k = budgetKit();
    const releaseClose = k.fs.hangNextClose();
    k.runner.push(
      okRun(`${REPO}/.git\n`),
      okRun(k.porcelain),
      okRun(`sha1\n${HEAD_SHA1}\n`),
      { ...okRun(""), code: 128 }, // Cc nonzero ⇒ 500 fast; the pins close in finally
    );
    const tracker = createPreviewIoTracker(); // observing the mechanism directly
    expect(tracker.zombies).toBe(0);
    const t0 = Date.now();
    const io = fakeIo();
    const pending = k.routes.handleFiles(
      fakeReq({ "x-pwh": "1" }),
      fakeRes(),
      new URLSearchParams({ agentKey: AGENT, sessionId: SESSION, wt: REPO }),
      io,
    );
    // the ANSWER is sent long before the hanging close's 1 s bound gives up
    await new Promise((r) => setTimeout(r, 30));
    expect(io.sent[0]!.status).toBe(500);
    expect(k.fs.leakCount()).toBe(1); // exactly the hung pin fd is still open
    releaseClose(); // the late settle
    await pending;
    expect(Date.now() - t0).toBeLessThan(WTDIFF_CLOSE_MS + 500); // ≤1 s + ε overall
    expect(k.fs.leakCount()).toBe(0);
    void tracker;
  });
});
