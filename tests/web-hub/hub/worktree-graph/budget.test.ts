/**
 * worktree-graph plan v2 §2.4 (P2): the time-budget ledger — pinned with a fake clock. The git
 * phase `G` (§2.4 `WTGRAPH_GIT_PHASE_MS` = 14 s) is created fresh at admission's end,
 * INDEPENDENT of the admission budget `A` (`WTDIFF_ADMIT_MS` = 8 s, same constant wtdiff uses);
 * every pinned-run step's `timeoutMs` is `min(capMs, G.remaining())`, so Gl (`WTGRAPH_LOG_MS` =
 * 6 s) always gets its full cap regardless of how much of `G` the four 2 s steps (S1–S4) burned
 * — the real arithmetic relation (`4 × WTDIFF_STEP_MS + WTGRAPH_LOG_MS === WTGRAPH_GIT_PHASE_MS`)
 * is pinned at the protocol level (P0); this file exercises the BEHAVIOR that relation enables.
 */

import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";

import { parseForEachRefZ, tipsFromRefs, parseGraphLogZ } from "../../../../src/git/graph.js";
import { projectGraph, type WtHeadCandidate } from "../../../../src/web-hub/hub/worktree-graph/project.js";
import {
  WTGRAPH_BODY_MAX_BYTES,
  WTGRAPH_LOG_MAX_BYTES,
  WTGRAPH_N,
  WTGRAPH_PATH_MAX_BYTES,
  WTGRAPH_REFNAME_MAX_BYTES,
  WTGRAPH_REFS_MAX,
  WTGRAPH_REFS_MAX_BYTES,
  WTGRAPH_REFS_SCAN_MAX,
  WTGRAPH_WT_HEADS_MAX,
  parseWtGraphPayload,
} from "../../../../src/web-hub/protocol/worktree-graph.js";

import { denyCtxOf } from "../../../../src/web-hub/hub/preview/admit.js";
import type { FakeFs } from "../worktree-diff/helpers.js";
import { createWorktreeGraphRoutes } from "../../../../src/web-hub/hub/worktree-graph/routes.js";
import { WTGRAPH_GIT_PHASE_MS, WTGRAPH_LOG_MS } from "../../../../src/web-hub/protocol/worktree-graph.js";
import { WTDIFF_ADMIT_MS, WTDIFF_STEP_MS } from "../../../../src/web-hub/protocol/worktree-diff.js";
import {
  AGENT,
  HEAD_SHA1,
  LINKED,
  REPO,
  SESSION,
  fakeIo,
  fakeRegistry,
  fakeReq,
  fakeRes,
  glStdout,
  grStdout,
  memLog,
  okRun,
  query,
  repoFixture,
  scriptGraphAdmission,
} from "./helpers.js";

const DENY = denyCtxOf("/home/tester", "/home/tester/.pi/agent");
const MAIN_REF = { type: "commit" as const, oid: HEAD_SHA1, refname: "refs/heads/main" };

function phaseFs(fx: ReturnType<typeof repoFixture>, clock: { t: number }, hangAt?: 1 | 2 | 4): FakeFs {
  let handleStats = 0;
  const fs: FakeFs = { ...fx.fs };
  fs.stat = async (path) => {
    if (path.endsWith("/shallow")) {
      if (hangAt === 1) {
        clock.t += WTDIFF_STEP_MS;
        return new Promise<never>(() => undefined);
      }
      clock.t += WTDIFF_STEP_MS;
    }
    return fx.fs.stat(path);
  };
  fs.open = async (path, flags) => {
    const handle = await fx.fs.open(path, flags);
    const originalStat = handle.stat;
    return {
      ...handle,
      stat: async () => {
        handleStats++;
        if (handleStats >= 4 && (handleStats - 4) % 3 === 0) {
          const phase = handleStats === 4 ? 2 : 4;
          clock.t += WTDIFF_STEP_MS;
          if (hangAt === phase) return new Promise<never>(() => undefined);
        }
        return originalStat();
      },
    };
  };
  return fs;
}

function budgetKit(hangAt?: 1 | 2 | 4) {
  const clock = { t: 1_000_000 };
  const fx = repoFixture();
  const log = memLog();
  const routes = createWorktreeGraphRoutes({
    mode: "on",
    denyCtx: DENY,
    registry: fakeRegistry(REPO),
    run: fx.runner,
    log,
    now: () => clock.t,
    fs: phaseFs(fx, clock, hangAt),
  });
  const io = fakeIo();
  const q = query({ agentKey: AGENT, sessionId: SESSION, wt: LINKED });
  const call = (io2 = io) => routes.handle(fakeReq({ "x-pwh": "1" }), fakeRes(), q, io2);
  const timeoutsFor = (pred: (argv: readonly string[]) => boolean): number[] =>
    fx.runner.calls.filter((c) => pred(c.argv)).map((c) => c.opts.timeoutMs ?? -1);
  const isGr = (argv: readonly string[]): boolean => argv.includes("for-each-ref");
  const isGl = (argv: readonly string[]): boolean => argv.includes("log") && argv.includes("--date-order");
  return { clock, fx, routes, io, log, call, timeoutsFor, isGr, isGl };
}

describe("worktree-graph budget §2.4 — git phase independence + per-step caps", () => {
  it("full near-cap Gr → tips → Gl → projection CPU pipeline has a median ≤50 ms, including real-cap §2.5 ref trimming", () => {
    const oid = (i: number): string => (i + 1).toString(16).padStart(64, "0");
    const refLines: string[] = [];
    let grBytes = 0;
    for (let i = 0; i <= WTGRAPH_REFS_SCAN_MAX; i++) {
      const kind = i % 6 < 4 ? "heads" : i % 6 === 4 ? "remotes" : "tags";
      const prefix = `refs/${kind}/${kind === "remotes" ? "origin/" : ""}${i}-`;
      const name = prefix.padEnd(WTGRAPH_REFNAME_MAX_BYTES, "r");
      const target = oid(i % WTGRAPH_N);
      const fields =
        kind === "tags"
          ? ["tag", oid(10_000 + i), "commit", target, name, "", ""]
          : ["commit", target, "", "", name, kind === "heads" ? "origin/".padEnd(200, "u") : "", ""];
      // Gr has NUL-separated fields but NEWLINE-separated records (not `-z`).
      const line = fields.join("\0") + "\n";
      if (grBytes + Buffer.byteLength(line) > WTGRAPH_REFS_MAX_BYTES) break;
      refLines.push(line);
      grBytes += Buffer.byteLength(line);
    }
    const grRaw = refLines.join("");
    const logPrefixes = Array.from({ length: WTGRAPH_N + 1 }, (_, i) =>
      [
        oid(i),
        Array.from({ length: 8 }, (_, j) => oid(i + j + 1)).join(" "),
        "Long author name ".repeat(16),
        String(1_700_000_000 - i),
        "",
      ].join("\x1f"),
    );
    const logOverhead = logPrefixes.reduce((sum, prefix) => sum + Buffer.byteLength(prefix) + 1, 0);
    const subjectBytes = Math.floor((WTGRAPH_LOG_MAX_BYTES - logOverhead) / logPrefixes.length);
    // JSON-heavy subjects exercise real JSON escaping as well as parser field truncation.
    const subject = 'Update fixture ["","","","","","","","","",""] '.repeat(100).slice(0, subjectBytes);
    const glRaw = logPrefixes.map((prefix) => prefix + subject + "\0").join("");
    expect(grBytes).toBeGreaterThan(WTGRAPH_REFS_MAX_BYTES * 0.99);
    expect(grBytes).toBeLessThanOrEqual(WTGRAPH_REFS_MAX_BYTES);
    expect(Buffer.byteLength(glRaw)).toBeGreaterThan(WTGRAPH_LOG_MAX_BYTES * 0.99);
    expect(Buffer.byteLength(glRaw)).toBeLessThanOrEqual(WTGRAPH_LOG_MAX_BYTES);

    for (const longPaths of [false, true]) {
      const wtHeadCandidates: WtHeadCandidate[] = Array.from({ length: WTGRAPH_WT_HEADS_MAX }, (_, i) => ({
        h: oid(i),
        // Near PATH_MAX, with each component below NAME_MAX; other worktrees are detached,
        // matching routes.ts (only the self row carries a branch).
        path: longPaths
          ? `/${"checkout-component/".repeat(240)}`.slice(0, WTGRAPH_PATH_MAX_BYTES - 4) + String(i).padStart(3, "0")
          : `/worktrees/checkout-${i}`,
        ...(i === 0 ? { b: refLines[0]!.split("\0")[4]!, self: true as const } : {}),
      }));
      const pipeline = (): ReturnType<typeof projectGraph> => {
        const refRows = parseForEachRefZ(grRaw, false);
        const refsTruncated = refRows.length > WTGRAPH_REFS_SCAN_MAX;
        const tips = tipsFromRefs(
          refRows,
          wtHeadCandidates.map((c) => c.h),
        );
        const glParsed = tips.tips.length === 0 ? undefined : parseGraphLogZ(glRaw, false, tips.format ?? "sha1");
        return projectGraph({
          refRows,
          refsTruncated,
          tips,
          gl: glParsed === undefined ? undefined : { ...glParsed, logCapped: false },
          shallow: false,
          wtHeadCandidates,
        });
      };
      pipeline(); // One warm-up; fixture creation and assertions are outside the CPU budget.
      const elapsed: number[] = [];
      for (let run = 0; run < 5; run++) {
        const start = performance.now();
        const result = pipeline();
        elapsed.push(performance.now() - start);
        expect(parseWtGraphPayload(result)).not.toBeNull();
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(WTGRAPH_BODY_MAX_BYTES);
        expect(result.commits).toHaveLength(WTGRAPH_N);
        expect(result.commits.every((c) => c.p.length === 8 && c.a.length === 64 && c.s.length === 200)).toBe(true);
        expect(result.degrade.more).toBe(true);
        expect(result.head).toBeDefined();
        expect(result.wtHeads).toHaveLength(WTGRAPH_WT_HEADS_MAX);
        const remaining = new Set(result.commits.map((c) => c.h));
        for (const ref of result.refs) expect(remaining.has(ref.h)).toBe(true);
        for (const head of result.wtHeads) expect(remaining.has(head.h)).toBe(true);
        expect(remaining.has(result.head!.h)).toBe(true);
        // For this real-cap fixture stage ② suffices; stage ③ is not reached because
        // the 200 capped commits + 32 capped paths fit once refs are removed.
        expect(result.refs.length).toBeGreaterThan(0);
        if (longPaths) expect(result.refs.length).toBeLessThan(WTGRAPH_REFS_MAX);
        else expect(result.refs).toHaveLength(WTGRAPH_REFS_MAX);
        expect(result.degrade.refsOmitted).toBe(refLines.length - result.refs.length);
      }
      elapsed.sort((a, b) => a - b);
      const median = elapsed[2]!;
      console.info(
        `worktree-graph CPU (${longPaths ? "real-cap ref trim" : "near-cap"}): median ${median.toFixed(2)} ms; runs ${elapsed.map((ms) => ms.toFixed(2)).join(", ")} ms`,
      );
      expect(median).toBeLessThanOrEqual(50);
    }
  });

  it("each S1–S4 receives its full 2 s budget and S5 receives 6 s", async () => {
    const k = budgetKit();
    scriptGraphAdmission(k.fx);
    k.fx.runner.push(
      () => {
        k.clock.t += WTDIFF_STEP_MS;
        return okRun(grStdout([MAIN_REF]));
      },
      () => {
        k.clock.t += WTGRAPH_LOG_MS;
        return okRun(glStdout([{ h: HEAD_SHA1, p: [], an: "a", at: 1, s: "s" }]));
      },
    );
    await k.call();
    expect(k.io.sent[0]!.status).toBe(200);
    expect(k.timeoutsFor(k.isGr)).toEqual([WTDIFF_STEP_MS]);
    expect(k.timeoutsFor(k.isGl)).toEqual([WTGRAPH_LOG_MS]);
    expect(k.clock.t - 1_000_000).toBeGreaterThanOrEqual(4 * WTDIFF_STEP_MS + WTGRAPH_LOG_MS);
  });

  it("S1 hang is bounded at 2 s and does not spawn Gr or Gl", async () => {
    const k = budgetKit(1);
    scriptGraphAdmission(k.fx);
    await k.call();
    expect(k.io.sent[0]).toMatchObject({ status: 504, body: { error: "E_DEADLINE" } });
    expect(k.timeoutsFor(k.isGr)).toEqual([]);
    expect(k.timeoutsFor(k.isGl)).toEqual([]);
  });

  it("S2 hang is bounded at 2 s and does not spawn Gr or Gl", async () => {
    const k = budgetKit(2);
    scriptGraphAdmission(k.fx);
    await k.call();
    expect(k.io.sent[0]).toMatchObject({ status: 504, body: { error: "E_DEADLINE" } });
    expect(k.timeoutsFor(k.isGr)).toEqual([]);
    expect(k.timeoutsFor(k.isGl)).toEqual([]);
  });

  it("S4 hang is bounded at 2 s after Gr and does not spawn Gl", async () => {
    const k = budgetKit(4);
    scriptGraphAdmission(k.fx);
    k.fx.runner.push(okRun(grStdout([MAIN_REF])));
    await k.call();
    expect(k.io.sent[0]).toMatchObject({ status: 504, body: { error: "E_DEADLINE" } });
    expect(k.timeoutsFor(k.isGr)).toEqual([WTDIFF_STEP_MS]);
    expect(k.timeoutsFor(k.isGl)).toEqual([]);
  });

  it("S5 is capped at 6 s and the complete request ledger is 8 + 14 + 1 = 23 s", () => {
    expect(WTDIFF_ADMIT_MS + WTGRAPH_GIT_PHASE_MS + 1_000).toBe(23_000);
    expect(WTGRAPH_LOG_MS).toBe(6_000);
  });

  it("a 7.9 s-burned admission still leaves the FULL independent 14 s git phase (Gr gets its full 2 s step)", async () => {
    const k = budgetKit();
    const authIo = fakeIo();
    authIo.authorize = async () => {
      k.clock.t += WTDIFF_ADMIT_MS - 100;
      return { ip: "127.0.0.1", user: "u1" };
    };
    scriptGraphAdmission(k.fx);
    k.fx.runner.push(
      () => {
        k.clock.t += WTDIFF_STEP_MS;
        return okRun(grStdout([MAIN_REF]));
      },
      () => {
        k.clock.t += WTGRAPH_LOG_MS;
        return okRun(glStdout([{ h: HEAD_SHA1, p: [], an: "a", at: 1, s: "s" }]));
      },
    );
    await k.call(authIo);
    expect(authIo.sent[0]!.status).toBe(200);
    expect(k.timeoutsFor(k.isGr)).toEqual([WTDIFF_STEP_MS]);
    expect(k.timeoutsFor(k.isGl)).toEqual([WTGRAPH_LOG_MS]);
  });

  it("admission budget fully exhausted before membership ⇒ 504, git phase never starts", async () => {
    const k = budgetKit();
    const authIo = fakeIo();
    authIo.authorize = async () => {
      k.clock.t += WTDIFF_ADMIT_MS + 1_000; // the whole admission budget, and then some
      return { ip: "127.0.0.1", user: "u1" };
    };
    await k.call(authIo);
    expect(authIo.sent[0]).toMatchObject({ status: 504, body: { error: "E_DEADLINE" } });
    expect(k.fx.runner.calls.some((c) => k.isGr(c.argv))).toBe(false);
  });

  it("relation sanity: 4×STEP + LOG_MS === GIT_PHASE_MS (behavior this file exercises)", () => {
    expect(4 * WTDIFF_STEP_MS + WTGRAPH_LOG_MS).toBe(WTGRAPH_GIT_PHASE_MS);
  });

  it("a hung Gr answers its own step timeout ⇒ 504 and Gl never runs", async () => {
    const k = budgetKit();
    scriptGraphAdmission(k.fx);
    k.fx.runner.push({ code: null, stdout: "", stdoutCapped: false, stderr: "", killed: "timeout" });
    await k.call();
    expect(k.io.sent[0]).toMatchObject({ status: 504, body: { error: "E_DEADLINE" } });
    expect(k.fx.runner.calls.some((c) => k.isGl(c.argv))).toBe(false);
  });
});
