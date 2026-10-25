/**
 * worktree-graph plan v2 §2.6 (P2): the route pipeline over the fake fs + scripted runner —
 * the error matrix row by row, empty-tips (no Gl run), the Gr→Gl tip-snapshot invariant (a ref
 * "moving" between the two commands never changes Gl's argv), `refsTruncated` propagation, the
 * Gl single-flight join / all-disconnected abort / join-only (never stored) semantics, the §2.5
 * degrade states end-to-end, the audit key whitelist + 429 throttle, and dispose ≤1 s.
 */

import { describe, expect, it } from "vitest";

import { denyCtxOf } from "../../../../src/web-hub/hub/preview/admit.js";
import { createWorktreeGraphRoutes } from "../../../../src/web-hub/hub/worktree-graph/routes.js";
import { WTGRAPH_AUDIT_KEYS } from "../../../../src/web-hub/hub/audit.js";
import { parseWtGraphPayload, type WtGraphPayload } from "../../../../src/web-hub/protocol/worktree-graph.js";
import type { GitRunResult } from "../../../../src/git/run.js";
import {
  AGENT,
  FakeFs,
  HEAD_SHA1,
  LINKED,
  REPO,
  REPO_GIT,
  SESSION,
  fakeIo,
  fakeRegistry,
  fakeReq,
  fakeRes,
  cherryOut,
  glStdout,
  grStdout,
  hookFs,
  installMergedHandler,
  isCcArgv,
  isGmArgv,
  memLog,
  mergedWindow,
  okRun,
  oidOf,
  query,
  repoFixture,
  scriptGraphAdmission,
  type MergedScenario,
  type RepoFixture,
  type Scripted,
  type ScriptedRunner,
} from "./helpers.js";

const DENY = denyCtxOf("/home/tester", "/home/tester/.pi/agent");

/** A `fakeRes()`-shaped stub whose `once("close", cb)` actually stores the callback so a test
 * can simulate a client disconnect (worktree-diff's own `fakeRes()` is a permanent no-op here,
 * so this is a small LOCAL addition rather than a worktree-diff file edit). */
function fakeClosableRes(): {
  res: Parameters<ReturnType<typeof createWorktreeGraphRoutes>["handle"]>[1];
  close(): void;
} {
  let onClose: (() => void) | undefined;
  const res = {
    headersSent: false,
    writableFinished: true,
    destroyed: false,
    once: (event: string, cb: () => void) => {
      if (event === "close") onClose = cb;
    },
    destroy() {
      (this as { destroyed: boolean }).destroyed = true;
    },
  };
  return {
    res: res as unknown as Parameters<ReturnType<typeof createWorktreeGraphRoutes>["handle"]>[1],
    close: () => {
      (res as unknown as { writableFinished: boolean }).writableFinished = false;
      onClose?.();
    },
  };
}

/** Two distinct principals (graph's per-principal in-flight cap is 1 — §2.5 — so a join test
 * MUST come from different principals, unlike a single-principal concurrency test). */
function fakeIoAs(user: string): ReturnType<typeof fakeIo> {
  const io = fakeIo();
  (io as unknown as { authorize: unknown }).authorize = async () => ({ ip: "127.0.0.1", user });
  return io;
}

function isGr(argv: readonly string[]): boolean {
  return argv.includes("for-each-ref");
}
function isGl(argv: readonly string[]): boolean {
  return argv.includes("log") && argv.includes("--date-order");
}

/** A scripted response that hangs until the signal aborts (mirrors worktree-diff's helper). */
const hangUntilAbort: Scripted = ({ opts }) =>
  new Promise((resolve) => {
    if (opts.signal === undefined) return;
    opts.signal.addEventListener(
      "abort",
      () => resolve({ code: null, stdout: "", stdoutCapped: false, stderr: "", killed: "abort" }),
      { once: true },
    );
  });

interface Kit {
  fx: RepoFixture;
  routes: ReturnType<typeof createWorktreeGraphRoutes>;
  log: ReturnType<typeof memLog>;
  call(io?: ReturnType<typeof fakeIo>, params?: Record<string, string>): Promise<ReturnType<typeof fakeIo>>;
}

function kit(opts: { fs?: FakeFs; runner?: ScriptedRunner } = {}): Kit {
  const fx =
    opts.fs !== undefined && opts.runner !== undefined
      ? ({ fs: opts.fs, runner: opts.runner } as RepoFixture)
      : repoFixture();
  const log = memLog();
  const routes = createWorktreeGraphRoutes({
    mode: "on",
    denyCtx: DENY,
    registry: fakeRegistry(REPO),
    run: fx.runner,
    log,
    now: Date.now,
    fs: fx.fs,
  });
  const base = { agentKey: AGENT, sessionId: SESSION, wt: LINKED };
  return {
    fx,
    routes,
    log,
    async call(io = fakeIo(), params = {}) {
      await routes.handle(fakeReq({ "x-pwh": "1" }), fakeRes(), query({ ...base, ...params }), io);
      return io;
    },
  };
}

function auditLines(log: ReturnType<typeof memLog>): Array<Record<string, unknown>> {
  return log.lines.filter((l) => l.msg === "wtgraph").map((l) => (l.data ?? {}) as Record<string, unknown>);
}

/** Script the admission + Gr + (optional) Gl happy path. */
function scriptHappy(fx: RepoFixture, gr: string, gl?: string): void {
  scriptGraphAdmission(fx);
  fx.runner.push(okRun(gr));
  if (gl !== undefined) fx.runner.push(okRun(gl));
}

const MAIN_REF = { type: "commit" as const, oid: HEAD_SHA1, refname: "refs/heads/main" };
const FEAT_REF = { type: "commit" as const, oid: HEAD_SHA1, refname: "refs/heads/feat" };

describe("worktree-graph routes — happy path + empty tips", () => {
  it("happy path: Gr+Gl produce a valid payload matching the parser", async () => {
    const fx = repoFixture();
    scriptHappy(fx, grStdout([MAIN_REF, FEAT_REF]), glStdout([{ h: HEAD_SHA1, p: [], an: "a", at: 10, s: "subject" }]));
    const k = kit({ fs: fx.fs, runner: fx.runner });
    const io = await k.call();
    expect(io.sent[0]!.status).toBe(200);
    const payload = io.sent[0]!.body as WtGraphPayload;
    expect(parseWtGraphPayload(payload)).not.toBeNull();
    expect(payload.commits).toHaveLength(1);
    expect(payload.refs.map((r) => r.n).sort()).toEqual(["feat", "main"]);
    expect(payload.wtHeads).toEqual([{ h: HEAD_SHA1, path: LINKED, b: "feat", self: true }]);
    expect(payload.head).toEqual({ h: HEAD_SHA1, b: "feat" });
    expect(payload.complete).toBe(true);
  });

  it("empty tips (no valid refs, unborn self HEAD, no other detached worktree) ⇒ Gl is never run", async () => {
    const fx = repoFixture();
    const list = [
      `worktree ${REPO}`,
      `HEAD ${HEAD_SHA1}`,
      "branch refs/heads/main",
      "",
      `worktree ${LINKED}`,
      "HEAD 0000000000000000000000000000000000000000",
      "detached",
      "",
      "",
    ].join("\n");
    scriptGraphAdmission(fx, { list });
    fx.runner.push(okRun(grStdout([]))); // Gr: no refs at all
    const k = kit({ fs: fx.fs, runner: fx.runner });
    const io = await k.call();
    expect(io.sent[0]!.status).toBe(200);
    const payload = io.sent[0]!.body as WtGraphPayload;
    expect(payload.empty).toBe(true);
    expect(payload.commits).toEqual([]);
    expect(fx.runner.calls.some((c) => isGl(c.argv))).toBe(false); // Gl never ran
    expect(fx.runner.calls.filter((c) => isGr(c.argv))).toHaveLength(1); // Gr ran exactly once
  });

  it("a ref 'moving' between Gr and Gl changes nothing: Gl's argv is exactly Gr's snapshot tips", async () => {
    const fx = repoFixture();
    const OTHER_OID = "fedcba9876543210fedcba9876543210fedcba98";
    scriptGraphAdmission(fx);
    fx.runner.push(okRun(grStdout([MAIN_REF])));
    // Gl's scripted OUTPUT can say anything (e.g. as if a totally different commit were current)
    // — the assertion below is about Gl's INPUT argv, which must be the Gr-time snapshot only.
    fx.runner.push(okRun(glStdout([{ h: OTHER_OID, p: [], an: "a", at: 1, s: "s" }])));
    const k = kit({ fs: fx.fs, runner: fx.runner });
    await k.call();
    const glCall = fx.runner.calls.find((c) => isGl(c.argv));
    expect(glCall).toBeDefined();
    // the explicit revision arguments are exactly [HEAD_SHA1] (Gr's snapshot) — never re-resolved
    expect(glCall!.argv.includes(HEAD_SHA1)).toBe(true);
    expect(glCall!.argv.includes(OTHER_OID)).toBe(false);
    expect(glCall!.argv.some((a) => a === "--branches" || a === "--all" || a === "HEAD")).toBe(false);
  });

  it("refsTruncated: Gr stdout capped (overflow) ⇒ propagates to the payload", async () => {
    const fx = repoFixture();
    scriptGraphAdmission(fx);
    fx.runner.push({ code: null, stdout: grStdout([MAIN_REF]), stdoutCapped: true, stderr: "", killed: "overflow" });
    fx.runner.push(okRun(glStdout([{ h: HEAD_SHA1, p: [], an: "a", at: 1, s: "s" }])));
    const k = kit({ fs: fx.fs, runner: fx.runner });
    const io = await k.call();
    const payload = io.sent[0]!.body as WtGraphPayload;
    expect(payload.degrade.refsTruncated).toBe(true);
    expect(payload.complete).toBe(false);
  });
});

describe("worktree-graph routes — error matrix", () => {
  it("Gl times out ⇒ 504 E_DEADLINE{reason:log-timeout}", async () => {
    const fx = repoFixture();
    scriptGraphAdmission(fx);
    fx.runner.push(okRun(grStdout([MAIN_REF])));
    fx.runner.push(hangUntilAbort as unknown as Scripted); // Gl: never settles until aborted
    const k = kit({ fs: fx.fs, runner: fx.runner });
    // force a near-exhausted deadline by racing dispose instead is complex; simulate the
    // timeout path via run.ts's own `killed:"timeout"` classification directly:
    fx.runner.calls.length = 0; // reset; re-script with an explicit timeout response for Gl
    const fx2 = repoFixture();
    scriptGraphAdmission(fx2);
    fx2.runner.push(okRun(grStdout([MAIN_REF])));
    fx2.runner.push({ code: null, stdout: "", stdoutCapped: false, stderr: "", killed: "timeout" });
    const k2 = kit({ fs: fx2.fs, runner: fx2.runner });
    const io = await k2.call();
    expect(io.sent[0]!.status).toBe(504);
    expect(io.sent[0]!.body).toMatchObject({ error: "E_DEADLINE", reason: "log-timeout" });
  });

  it("missing-object (hardened stderr match) ⇒ 503 E_WTDIFF_UNSUPPORTED{reason:missing-object}", async () => {
    const fx = repoFixture();
    scriptGraphAdmission(fx);
    fx.runner.push(okRun(grStdout([MAIN_REF])));
    fx.runner.push({ code: 128, stdout: "", stdoutCapped: false, stderr: "fatal: bad tag" });
    const k = kit({ fs: fx.fs, runner: fx.runner });
    const io = await k.call();
    expect(io.sent[0]!.status).toBe(503);
    expect(io.sent[0]!.body).toMatchObject({ error: "E_WTDIFF_UNSUPPORTED", reason: "missing-object" });
  });

  it("git-too-old (exit 129) ⇒ 503 E_WTDIFF_UNSUPPORTED{reason:git-too-old}", async () => {
    const fx = repoFixture();
    scriptGraphAdmission(fx);
    fx.runner.push({ code: 129, stdout: "", stdoutCapped: false, stderr: "unknown option --no-lazy-fetch" });
    const k = kit({ fs: fx.fs, runner: fx.runner });
    const io = await k.call();
    expect(io.sent[0]!.status).toBe(503);
    expect(io.sent[0]!.body).toMatchObject({ error: "E_WTDIFF_UNSUPPORTED", reason: "git-too-old" });
  });

  it("git-failed (generic non-zero exit) ⇒ 500 E_INTERNAL{reason:git-failed}", async () => {
    const fx = repoFixture();
    scriptGraphAdmission(fx);
    fx.runner.push({ code: 1, stdout: "", stdoutCapped: false, stderr: "fatal: some other failure" });
    const k = kit({ fs: fx.fs, runner: fx.runner });
    const io = await k.call();
    expect(io.sent[0]!.status).toBe(500);
    expect(io.sent[0]!.body).toMatchObject({ error: "E_INTERNAL", reason: "git-failed" });
  });
  it("git-failed on Gl also carries reason:git-failed", async () => {
    const fx = repoFixture();
    scriptGraphAdmission(fx);
    fx.runner.push(okRun(grStdout([MAIN_REF])));
    fx.runner.push({ code: 1, stdout: "", stdoutCapped: false, stderr: "fatal: generic graph failure" });
    const k = kit({ fs: fx.fs, runner: fx.runner });
    const io = await k.call();
    expect(io.sent[0]!.status).toBe(500);
    expect(io.sent[0]!.body).toMatchObject({ error: "E_INTERNAL", reason: "git-failed" });
  });

  it("badRecords: a malformed Gl record ⇒ complete=false", async () => {
    const fx = repoFixture();
    scriptGraphAdmission(fx);
    fx.runner.push(okRun(grStdout([MAIN_REF])));
    fx.runner.push(okRun(`${HEAD_SHA1}\x1f\x1fnotanumber\x1fsubject\0`)); // only 4 fields, bad timestamp shape too
    const k = kit({ fs: fx.fs, runner: fx.runner });
    const io = await k.call();
    const payload = io.sent[0]!.body as WtGraphPayload;
    expect(payload.degrade.badRecords).toBeGreaterThan(0);
    expect(payload.complete).toBe(false);
  });

  it("parentsTruncated: 9 parents ⇒ cut to 8 with pT:true, complete=false", async () => {
    const fx = repoFixture();
    scriptGraphAdmission(fx);
    fx.runner.push(okRun(grStdout([MAIN_REF])));
    const parents = Array.from({ length: 9 }, (_, i) => (i + 1).toString(16).padStart(40, "0"));
    fx.runner.push(okRun(glStdout([{ h: HEAD_SHA1, p: parents, an: "a", at: 1, s: "s" }])));
    const k = kit({ fs: fx.fs, runner: fx.runner });
    const io = await k.call();
    const payload = io.sent[0]!.body as WtGraphPayload;
    expect(payload.commits[0]!.p).toHaveLength(8);
    expect(payload.commits[0]!.pT).toBe(true);
    expect(payload.degrade.parentsTruncated).toBe(1);
    expect(payload.complete).toBe(false);
  });

  it("refsSkipped: a non-commit ref target ⇒ complete=false", async () => {
    const fx = repoFixture();
    scriptGraphAdmission(fx);
    fx.runner.push(
      okRun(
        grStdout([
          MAIN_REF,
          { type: "tree", oid: "abcdef0123456789abcdef0123456789abcdef01", refname: "refs/tags/weird" },
        ]),
      ),
    );
    fx.runner.push(okRun(glStdout([{ h: HEAD_SHA1, p: [], an: "a", at: 1, s: "s" }])));
    const k = kit({ fs: fx.fs, runner: fx.runner });
    const io = await k.call();
    const payload = io.sent[0]!.body as WtGraphPayload;
    expect(payload.degrade.refsSkipped).toBe(1);
    expect(payload.complete).toBe(false);
  });

  it("refsOmitted: >400 refs ⇒ capped, complete=false", async () => {
    const fx = repoFixture();
    scriptGraphAdmission(fx);
    const rows = Array.from({ length: 450 }, (_, i) => ({
      type: "commit" as const,
      oid: HEAD_SHA1,
      refname: `refs/heads/b${i}`,
    }));
    fx.runner.push(okRun(grStdout(rows)));
    fx.runner.push(okRun(glStdout([{ h: HEAD_SHA1, p: [], an: "a", at: 1, s: "s" }])));
    const k = kit({ fs: fx.fs, runner: fx.runner });
    const io = await k.call();
    const payload = io.sent[0]!.body as WtGraphPayload;
    expect(payload.refs).toHaveLength(400);
    expect(payload.degrade.refsOmitted).toBe(50);
    expect(payload.complete).toBe(false);
  });

  it("wtHeadsCapped: >32 other detached worktrees ⇒ capped, complete=false", async () => {
    const fx = repoFixture();
    const lines = [`worktree ${REPO}`, `HEAD ${HEAD_SHA1}`, "branch refs/heads/main", ""];
    for (let i = 0; i < 40; i++) {
      lines.push(`worktree /w/extra${i}`, `HEAD ${HEAD_SHA1}`, "detached", "");
    }
    lines.push(`worktree ${LINKED}`, `HEAD ${HEAD_SHA1}`, "branch refs/heads/feat", "", "");
    scriptGraphAdmission(fx, { list: lines.join("\n") });
    fx.runner.push(okRun(grStdout([MAIN_REF, FEAT_REF])));
    fx.runner.push(okRun(glStdout([{ h: HEAD_SHA1, p: [], an: "a", at: 1, s: "s" }])));
    const k = kit({ fs: fx.fs, runner: fx.runner });
    const io = await k.call();
    const payload = io.sent[0]!.body as WtGraphPayload;
    expect(payload.wtHeads).toHaveLength(32);
    expect(payload.degrade.wtHeadsCapped).toBe(true);
    expect(payload.complete).toBe(false);
  });

  it("logCapped: Gl stdout overflow ⇒ complete=false, 200 still answered", async () => {
    const fx = repoFixture();
    scriptGraphAdmission(fx);
    fx.runner.push(okRun(grStdout([MAIN_REF])));
    fx.runner.push({
      code: null,
      stdout: glStdout([{ h: HEAD_SHA1, p: [], an: "a", at: 1, s: "s" }]),
      stdoutCapped: true,
      stderr: "",
      killed: "overflow",
    });
    const k = kit({ fs: fx.fs, runner: fx.runner });
    const io = await k.call();
    expect(io.sent[0]!.status).toBe(200);
    const payload = io.sent[0]!.body as WtGraphPayload;
    expect(payload.degrade.logCapped).toBe(true);
    expect(payload.complete).toBe(false);
  });
});

describe("worktree-graph routes — Gl single-flight (join / all-disconnected abort / join-only)", () => {
  it("two concurrent requests with the same tips share ONE Gl execution (joined:true audits on one)", async () => {
    const fx = repoFixture();
    fx.runner.setHandler(({ argv }) => {
      if (argv.includes("--git-common-dir")) return okRun(`${REPO_GIT}\n`);
      if (argv.includes("worktree") && argv.includes("list")) return okRun(fx.porcelain);
      if (isGr(argv)) return okRun(grStdout([MAIN_REF, FEAT_REF]));
      if (isGl(argv)) return okRun(glStdout([{ h: HEAD_SHA1, p: [], an: "a", at: 1, s: "s" }]));
      return okRun("");
    });
    const k = kit({ fs: fx.fs, runner: fx.runner });
    const [io1, io2] = await Promise.all([k.call(fakeIoAs("alice")), k.call(fakeIoAs("bob"))]);
    expect(io1.sent[0]!.status).toBe(200);
    expect(io2.sent[0]!.status).toBe(200);
    expect(fx.runner.calls.filter((c) => isGl(c.argv))).toHaveLength(1); // ONE Gl execution
    expect(fx.runner.calls.filter((c) => isGr(c.argv))).toHaveLength(2); // Gr runs per-request
    const audits = auditLines(k.log);
    expect(audits).toHaveLength(2);
    expect(audits.some((a) => a["joined"] === true)).toBe(true);
  });

  it("both leavers disconnect before Gl settles ⇒ the shared execution is aborted", async () => {
    const fx = repoFixture();
    let glSignal: AbortSignal | undefined;
    fx.runner.setHandler(({ argv, opts }) => {
      if (argv.includes("--git-common-dir")) return okRun(`${REPO_GIT}\n`);
      if (argv.includes("worktree") && argv.includes("list")) return okRun(fx.porcelain);
      if (isGr(argv)) return okRun(grStdout([MAIN_REF, FEAT_REF]));
      if (isGl(argv)) {
        glSignal = opts.signal;
        return hangUntilAbort({ argv, opts }) as Promise<GitRunResult>;
      }
      return okRun("");
    });
    const k = kit({ fs: fx.fs, runner: fx.runner });
    const io1 = fakeIoAs("alice");
    const io2 = fakeIoAs("bob");
    const q = query({ agentKey: AGENT, sessionId: SESSION, wt: LINKED });
    const req1 = fakeReq({ "x-pwh": "1" });
    const req2 = fakeReq({ "x-pwh": "1" });
    const { res: res1, close: close1 } = fakeClosableRes();
    const { res: res2, close: close2 } = fakeClosableRes();
    const p1 = k.routes.handle(req1, res1, q, io1);
    const p2 = k.routes.handle(req2, res2, q, io2);
    await new Promise((r) => setTimeout(r, 10)); // past admission, into the hanging Gl
    expect(glSignal).toBeDefined();
    expect(glSignal!.aborted).toBe(false);
    // simulate both clients disconnecting
    close1();
    close2();
    await Promise.all([p1, p2]);
    expect(glSignal!.aborted).toBe(true);
  });

  it("Gl is join-only (never cached): a second, later request re-runs Gl even with identical tips", async () => {
    const fx = repoFixture();
    let glCalls = 0;
    fx.runner.setHandler(({ argv }) => {
      if (argv.includes("--git-common-dir")) return okRun(`${REPO_GIT}\n`);
      if (argv.includes("worktree") && argv.includes("list")) return okRun(fx.porcelain);
      if (isGr(argv)) return okRun(grStdout([MAIN_REF, FEAT_REF]));
      if (isGl(argv)) {
        glCalls++;
        return okRun(glStdout([{ h: HEAD_SHA1, p: [], an: "a", at: 1, s: "s" }]));
      }
      return okRun("");
    });
    const k = kit({ fs: fx.fs, runner: fx.runner });
    await k.call();
    expect(glCalls).toBe(1);
    await k.call(); // fully sequential, no overlap ⇒ no join possible — must re-run, never cached
    expect(glCalls).toBe(2);
  });
});

describe("worktree-graph routes — audit whitelist + 429 throttle", () => {
  it("every audit line's keys are a subset of WTGRAPH_AUDIT_KEYS", async () => {
    const fx = repoFixture();
    scriptHappy(fx, grStdout([MAIN_REF]), glStdout([{ h: HEAD_SHA1, p: [], an: "a", at: 1, s: "s" }]));
    const k = kit({ fs: fx.fs, runner: fx.runner });
    await k.call();
    const lines = auditLines(k.log);
    expect(lines).toHaveLength(1);
    for (const key of Object.keys(lines[0]!)) {
      expect(key === "audit" || (WTGRAPH_AUDIT_KEYS as readonly string[]).includes(key), key).toBe(true);
    }
    expect(lines[0]).toMatchObject({ ok: true, phase: "graph", agentKey: AGENT });
  });

  it("429 audit throttle: repeated floods in one window ⇒ exactly ONE 429 audit line", async () => {
    const fx = repoFixture();
    const k = kit({ fs: fx.fs, runner: fx.runner });
    // exhaust the 10-token bucket with cheap admission failures (C1a nonzero ⇒ 403, one audit each)
    for (let i = 0; i < 10; i++) {
      fx.runner.push({ code: 128, stdout: "", stdoutCapped: false, stderr: "" });
      await k.call();
    }
    expect(auditLines(k.log)).toHaveLength(10);
    for (let i = 0; i < 5; i++) await k.call();
    const io = fakeIo();
    await k.routes.handle(
      fakeReq({ "x-pwh": "1" }),
      fakeRes(),
      query({ agentKey: AGENT, sessionId: SESSION, wt: LINKED }),
      io,
    );
    expect(io.sent[0]!.status).toBe(429);
    expect(auditLines(k.log).length).toBe(11); // 10 + exactly one 429 line
  });
});

describe("worktree-graph routes — dispose", () => {
  it("dispose aborts in-flight requests (503 hub-close), closes pins, and settles within ~1s; idempotent", async () => {
    const fx = repoFixture();
    scriptGraphAdmission(fx);
    fx.runner.push(okRun(grStdout([MAIN_REF])));
    fx.runner.push(hangUntilAbort);
    const k = kit({ fs: fx.fs, runner: fx.runner });
    const io = fakeIo();
    const pending = k.routes.handle(
      fakeReq({ "x-pwh": "1" }),
      fakeRes(),
      query({ agentKey: AGENT, sessionId: SESSION, wt: LINKED }),
      io,
    );
    await new Promise((r) => setTimeout(r, 10)); // past Gr, into the hanging Gl
    expect(fx.fs.leakCount()).toBe(3); // the three pins are open
    const deadline = { at: Date.now() + 1_000, remaining: () => 1_000, expired: () => false };
    const startedAt = Date.now();
    await k.routes.dispose("close", deadline);
    expect(Date.now() - startedAt).toBeLessThan(1_100);
    await k.routes.dispose("close", deadline); // idempotent
    await pending;
    expect(io.sent[0]).toMatchObject({ status: 503, body: { error: "E_HUB_RESTARTING" } });
    expect(fx.fs.leakCount()).toBe(0); // every pin closed
  });
});

// ===========================================================================
// merged-plan r3 §3 (P2): `merged=1` — the M phase through the real route pipeline
// ===========================================================================

type MergedBody = WtGraphPayload & {
  merged?: import("../../../../src/web-hub/protocol/worktree-graph.js").WtGraphMerged;
};

interface MKit {
  fx: RepoFixture;
  routes: ReturnType<typeof createWorktreeGraphRoutes>;
  log: ReturnType<typeof memLog>;
  clock: { t: number };
  call(
    params?: Record<string, string>,
    io?: ReturnType<typeof fakeIo>,
  ): Promise<{ io: ReturnType<typeof fakeIo>; body: MergedBody }>;
}

function mkit(
  opts: { mergedEnabled?: boolean; wrapFs?: (fs: FakeFs, fx: RepoFixture) => FakeFs; porcelain?: string } = {},
): MKit {
  const fx = repoFixture();
  if (opts.porcelain !== undefined) fx.porcelain = opts.porcelain;
  const clock = { t: 1_000_000 };
  const log = memLog();
  const routes = createWorktreeGraphRoutes({
    mode: "on",
    denyCtx: DENY,
    registry: fakeRegistry(REPO),
    run: fx.runner,
    log,
    now: () => clock.t,
    fs: opts.wrapFs === undefined ? fx.fs : opts.wrapFs(fx.fs, fx),
    mergedEnabled: opts.mergedEnabled ?? true,
  });
  return {
    fx,
    routes,
    log,
    clock,
    async call(params = {}, io = fakeIo()) {
      const q = query({ agentKey: AGENT, sessionId: SESSION, wt: LINKED, merged: "1", ...params });
      await routes.handle(fakeReq({ "x-pwh": "1" }), fakeRes(), q, io);
      return { io, body: io.sent[0]!.body as MergedBody };
    },
  };
}

const INFO = `${REPO_GIT}/info/attributes`;
const gmCalls = (k: MKit): string[][] => k.fx.runner.calls.filter((c) => isGmArgv(c.argv)).map((c) => c.argv);
const ccCalls = (k: MKit): string[][] => k.fx.runner.calls.filter((c) => isCcArgv(c.argv)).map((c) => c.argv);
const tipOf = (argv: readonly string[]): string => argv[argv.indexOf("--right-only") + 1]!.split("...")[1]!;
const allEq =
  (n: number): MergedScenario["gm"] =>
  () =>
    okRun(
      cherryOut(
        Array.from({ length: n }, (_, i) => oidOf(500 + i)),
        [],
      ),
    );

describe("merged=1 — baseline equivalence (§3.1: no merged=1 ⇒ identical git calls and bytes)", () => {
  it("no query / merged=0 / merged=true / route without mergedEnabled ⇒ same runner call sequence and response bytes", async () => {
    const w = mergedWindow(3);
    const runs: Array<{ calls: string[]; body: string }> = [];
    for (const [enabled, params] of [
      [true, { merged: "" }],
      [true, { merged: "0" }],
      [true, { merged: "true" }],
      [false, { merged: "1" }],
    ] as const) {
      const k = mkit({ mergedEnabled: enabled });
      installMergedHandler(k.fx, { gr: w.gr, gl: w.gl, gm: allEq(1) });
      const { io } = await k.call(params);
      expect(io.sent[0]!.status).toBe(200);
      runs.push({ calls: k.fx.runner.calls.map((c) => c.argv.join(" ")), body: JSON.stringify(io.sent[0]!.body) });
    }
    for (const r of runs.slice(1)) expect(r).toEqual(runs[0]);
    expect(runs[0]!.calls.some((c) => c.includes("--cherry-mark") || c.includes("--get-regexp"))).toBe(false);
    expect(runs[0]!.body).not.toContain('"merged"');
  });

  it("merged=1 on an enabled route: the call sequence is C1a, C1, Gr, Gl, Cc, then one Gm per distinct tip; the base is the self HEAD", async () => {
    const w = mergedWindow(2);
    const k = mkit();
    installMergedHandler(k.fx, { gr: w.gr, gl: w.gl, gm: allEq(1) });
    const { body } = await k.call();
    const kinds = k.fx.runner.calls.map((c) =>
      isGmArgv(c.argv) ? "Gm" : isCcArgv(c.argv) ? "Cc" : isGl(c.argv) ? "Gl" : isGr(c.argv) ? "Gr" : "adm",
    );
    expect(kinds).toEqual(["adm", "adm", "Gr", "Gl", "Cc", "Gm", "Gm"]);
    expect(body.merged?.base).toBe(HEAD_SHA1);
    expect(gmCalls(k).map(tipOf)).toEqual(w.tips);
    for (const argv of gmCalls(k)) {
      expect(argv).toContain("--cherry-mark");
      expect(argv).toContain("--right-only");
      expect(argv).toContain(`${HEAD_SHA1}...${tipOf(argv)}`);
    }
    expect(k.fx.fs.leakCount()).toBe(0);
  });
});

describe("merged=1 — verdicts + candidate rules", () => {
  it("eq / part (e ∩ window) / none / anc, strict-parser clean; the HEAD branch and window ancestors are not candidates", async () => {
    const w = mergedWindow(4);
    // extra branches that must NOT become candidates: one on P1 (a window ancestor of HEAD)
    const gr = w.gr + grStdout([{ type: "commit", oid: w.p1, refname: "refs/heads/old-ancestor" }]);
    const k = mkit();
    installMergedHandler(k.fx, {
      gr,
      gl: w.gl,
      gm: (tip) => {
        if (tip === w.tips[0]) return okRun(cherryOut([oidOf(501), oidOf(502)], []));
        if (tip === w.tips[1]) return okRun(cherryOut([w.p1], [oidOf(503)]));
        if (tip === w.tips[2]) return okRun(cherryOut([], [oidOf(504)]));
        return okRun("");
      },
    });
    const { body } = await k.call();
    expect(parseWtGraphPayload(JSON.parse(JSON.stringify(body)))).not.toBeNull();
    expect(body.merged).toEqual({
      v: 1,
      base: HEAD_SHA1,
      branches: [
        { n: "side-0", h: w.tips[0], v: "eq", k: 2, t: 2 },
        { n: "side-1", h: w.tips[1], v: "part", k: 1, t: 2, e: [w.p1] },
        { n: "side-2", h: w.tips[2], v: "none", k: 0, t: 1 },
        { n: "side-3", h: w.tips[3], v: "anc" },
      ],
    });
    expect(gmCalls(k)).toHaveLength(4); // feat (HEAD branch) and old-ancestor never ran
  });

  it("co:true marks a branch checked out by another worktree, which is still judged", async () => {
    const w = mergedWindow(2);
    const gr = w.gr + grStdout([{ type: "commit", oid: w.tips[1]!, refname: "refs/heads/main" }]); // `main` = the main worktree's branch
    const k = mkit();
    installMergedHandler(k.fx, { gr, gl: w.gl, gm: allEq(1) });
    const { body } = await k.call();
    const byName = new Map(body.merged!.branches.map((b) => [b.n, b]));
    expect(byName.get("main")).toMatchObject({ v: "eq", co: true });
    expect(byName.get("side-1")?.co).toBeUndefined();
  });

  it.each([
    [24, 24, undefined],
    [25, 24, 1],
  ])(
    "%i candidate branches ⇒ %i entries (omitted %s), one Gm per entry, parser-clean",
    async (count, entries, omitted) => {
      const w = mergedWindow(count);
      const k = mkit();
      installMergedHandler(k.fx, { gr: w.gr, gl: w.gl, gm: allEq(1) });
      const { body } = await k.call();
      expect(body.merged!.branches).toHaveLength(entries);
      expect(body.merged!.omitted).toBe(omitted);
      expect(gmCalls(k)).toHaveLength(entries);
      expect(parseWtGraphPayload(JSON.parse(JSON.stringify(body)))).not.toBeNull();
    },
  );

  it("400-class: 390 candidate branches over 30 tips ⇒ 24 entries + omitted 366; Gm runs once per DISTINCT tip among the selected (2)", async () => {
    const tips = Array.from({ length: 30 }, (_, i) => oidOf(i + 1));
    const p2 = oidOf(9002);
    const gl = glStdout([
      { h: HEAD_SHA1, p: [p2], at: 5_000 },
      ...tips.map((h, i) => ({ h, p: [p2], at: 4_000 - i })),
      { h: p2, p: [], at: 2_000 },
    ]);
    const gr = grStdout([
      { type: "commit", oid: HEAD_SHA1, refname: "refs/heads/feat" },
      ...tips.flatMap((h, t) =>
        Array.from({ length: 13 }, (_, b) => ({
          type: "commit" as const,
          oid: h,
          refname: `refs/heads/t${String(t).padStart(2, "0")}-b${String(b).padStart(2, "0")}`,
        })),
      ),
    ]);
    const k = mkit();
    installMergedHandler(k.fx, { gr, gl, gm: allEq(1) });
    const { body } = await k.call();
    expect(body.merged!.branches).toHaveLength(24);
    expect(body.merged!.omitted).toBe(390 - 24);
    expect(gmCalls(k).map(tipOf)).toEqual([tips[0], tips[1]]);
    expect(parseWtGraphPayload(JSON.parse(JSON.stringify(body)))).not.toBeNull();
  });

  it("24 branches on ONE tip ⇒ one Gm, 24 consistent entries", async () => {
    const p2 = oidOf(9002);
    const tip = oidOf(1);
    const gl = glStdout([
      { h: HEAD_SHA1, p: [p2], at: 5_000 },
      { h: tip, p: [p2], at: 4_000 },
      { h: p2, p: [], at: 2_000 },
    ]);
    const gr = grStdout([
      { type: "commit", oid: HEAD_SHA1, refname: "refs/heads/feat" },
      ...Array.from({ length: 24 }, (_, i) => ({ type: "commit" as const, oid: tip, refname: `refs/heads/dup-${i}` })),
    ]);
    const k = mkit();
    installMergedHandler(k.fx, { gr, gl, gm: () => okRun(cherryOut([oidOf(500)], [oidOf(501)])) });
    const { body } = await k.call();
    expect(gmCalls(k)).toHaveLength(1);
    expect(body.merged!.branches).toHaveLength(24);
    expect(body.merged!.branches.every((b) => b.v === "part" && b.k === 1 && b.t === 2)).toBe(true);
    expect(parseWtGraphPayload(JSON.parse(JSON.stringify(body)))).not.toBeNull();
  });

  it("no candidates ⇒ merged = { v:1, base, branches:[] } and neither Cc nor Gm is spawned", async () => {
    const w = mergedWindow(0);
    const k = mkit();
    installMergedHandler(k.fx, { gr: w.gr, gl: w.gl, gm: allEq(1) });
    const { body } = await k.call();
    expect(body.merged).toEqual({ v: 1, base: HEAD_SHA1, branches: [] });
    expect(ccCalls(k)).toHaveLength(0);
    expect(gmCalls(k)).toHaveLength(0);
  });
});

describe("merged=1 — skipped wire shapes (§3.1/§3.4: always branches:[], base iff head)", () => {
  const SKIPPED = (merged: unknown): unknown => merged;

  it("no-head: unborn self HEAD ⇒ { v:1, skipped:'no-head', branches:[] } without base; no Cc/Gm", async () => {
    const list = [
      `worktree ${REPO}`,
      `HEAD ${HEAD_SHA1}`,
      "branch refs/heads/main",
      "",
      `worktree ${LINKED}`,
      "HEAD 0000000000000000000000000000000000000000",
      "detached",
      "",
      "",
    ].join("\n");
    const w = mergedWindow(2);
    const k = mkit({ porcelain: list });
    installMergedHandler(k.fx, { gr: w.gr, gl: w.gl, gm: allEq(1) });
    const { body } = await k.call();
    expect(body.head).toBeUndefined();
    expect(SKIPPED(body.merged)).toEqual({ v: 1, skipped: "no-head", branches: [] });
    expect(ccCalls(k)).toHaveLength(0);
    expect(gmCalls(k)).toHaveLength(0);
  });

  it("no-head: empty repository (no refs at all)", async () => {
    const list = [
      `worktree ${REPO}`,
      "HEAD 0000000000000000000000000000000000000000",
      "branch refs/heads/main",
      "",
      `worktree ${LINKED}`,
      "HEAD 0000000000000000000000000000000000000000",
      "detached",
      "",
      "",
    ].join("\n");
    const k = mkit({ porcelain: list });
    installMergedHandler(k.fx, { gr: "", gl: "", gm: allEq(1) });
    const { body } = await k.call();
    expect(body.empty).toBe(true);
    expect(body.merged).toEqual({ v: 1, skipped: "no-head", branches: [] });
  });

  it("shallow: { v:1, base, skipped:'shallow', branches:[] } and no Cc/Gm", async () => {
    const w = mergedWindow(2);
    const k = mkit();
    k.fx.fs.writeFile(`${REPO_GIT}/shallow`, "");
    installMergedHandler(k.fx, { gr: w.gr, gl: w.gl, gm: allEq(1) });
    const { body } = await k.call();
    expect(body.shallow).toBe(true);
    expect(body.merged).toEqual({ v: 1, base: HEAD_SHA1, skipped: "shallow", branches: [] });
    expect(ccCalls(k)).toHaveLength(0);
    expect(gmCalls(k)).toHaveLength(0);
  });

  it("filter-config: an unsafe driver name in config (Cc) or in info/attributes ⇒ skipped, no Gm", async () => {
    const w = mergedWindow(2);
    const k1 = mkit();
    installMergedHandler(k1.fx, {
      gr: w.gr,
      gl: w.gl,
      cc: { stdout: "filter.-bad.clean\nx\0", code: 0 },
      gm: allEq(1),
    });
    expect((await k1.call()).body.merged).toEqual({ v: 1, base: HEAD_SHA1, skipped: "filter-config", branches: [] });
    expect(gmCalls(k1)).toHaveLength(0);

    const k2 = mkit();
    k2.fx.fs.writeFile(INFO, "*.txt diff=bad/name\n");
    installMergedHandler(k2.fx, { gr: w.gr, gl: w.gl, gm: allEq(1) });
    expect((await k2.call()).body.merged).toEqual({ v: 1, base: HEAD_SHA1, skipped: "filter-config", branches: [] });
    expect(gmCalls(k2)).toHaveLength(0);

    // an oversize info/attributes (> 64 KiB) is also fail-closed
    const k3 = mkit();
    k3.fx.fs.writeFile(INFO, "#".repeat(70 * 1024));
    installMergedHandler(k3.fx, { gr: w.gr, gl: w.gl, gm: allEq(1) });
    expect((await k3.call()).body.merged?.skipped).toBe("filter-config");
  });

  it("driver names from Cc ∪ info/attributes are neutralized (L2) in the Gm argv", async () => {
    const w = mergedWindow(1);
    const k = mkit();
    k.fx.fs.writeFile(INFO, "*.bin filter=lfs\n*.dat diff=tc\n");
    installMergedHandler(k.fx, {
      gr: w.gr,
      gl: w.gl,
      cc: { stdout: "filter.cfgdrv.clean\ncmd\0", code: 0 },
      gm: allEq(1),
    });
    await k.call();
    const argv = gmCalls(k)[0]!.join(" ");
    for (const n of ["cfgdrv", "lfs", "tc"]) expect(argv).toContain(`filter.${n}.clean=`);
    expect(argv).toContain("diff.tc.textconv=");
    expect(argv).toContain("diff.external=");
    expect(argv).toContain("core.bigFileThreshold=512m");
    expect(argv).toContain("--attr-source=");
  });

  it("git-too-old: Gm exit 129 (and Cc exit 129) ⇒ whole-phase skipped", async () => {
    const w = mergedWindow(2);
    const k = mkit();
    installMergedHandler(k.fx, {
      gr: w.gr,
      gl: w.gl,
      gm: () => ({ code: 129, stdout: "", stdoutCapped: false, stderr: "usage" }),
    });
    expect((await k.call()).body.merged).toEqual({ v: 1, base: HEAD_SHA1, skipped: "git-too-old", branches: [] });
    expect(gmCalls(k)).toHaveLength(1); // the first 129 ends the stage

    const k2 = mkit();
    installMergedHandler(k2.fx, { gr: w.gr, gl: w.gl, cc: { code: 129 }, gm: allEq(1) });
    expect((await k2.call()).body.merged?.skipped).toBe("git-too-old");
    expect(gmCalls(k2)).toHaveLength(0);
  });

  it("unconfirmed: Cc cannot be confirmed (unexpected exit / spawn failure) ⇒ skipped, no Gm", async () => {
    const w = mergedWindow(2);
    const k = mkit();
    installMergedHandler(k.fx, { gr: w.gr, gl: w.gl, cc: { code: 2 }, gm: allEq(1) });
    expect((await k.call()).body.merged).toEqual({ v: 1, base: HEAD_SHA1, skipped: "unconfirmed", branches: [] });
    expect(gmCalls(k)).toHaveLength(0);
  });

  it("a defect inside the M phase (a thrown, non-abort error) degrades to skipped:'unconfirmed': 200, graph intact, error logged, pins closed", async () => {
    const w = mergedWindow(1);
    const k = mkit();
    // Cc throws a TypeError out of the runner; everything else behaves as scripted
    const boom = (call: { argv: readonly string[] }): void => {
      if (isCcArgv(call.argv)) throw new TypeError("boom (test)");
    };
    k.fx.runner.setHandler((call) => {
      boom(call);
      const j = call.argv.join(" ");
      if (j.includes("--git-common-dir")) return okRun("/w/repo/.git\n");
      if (j.includes("worktree list --porcelain")) return okRun(k.fx.porcelain);
      if (isGr(call.argv)) return okRun(w.gr);
      if (isGl(call.argv)) return okRun(w.gl);
      return okRun("");
    });
    const { io, body } = await k.call();
    expect(io.sent[0]!.status).toBe(200);
    expect(body.commits.length).toBeGreaterThan(0);
    expect(body.merged).toEqual({ v: 1, base: HEAD_SHA1, skipped: "unconfirmed", branches: [] });
    expect(k.log.lines.some((l) => l.level === "error" && String(l.msg).includes("merged phase failed"))).toBe(true);
    expect(k.fx.fs.leakCount()).toBe(0);
  });
});

describe("merged=1 — per-tip unknown classification (§3.4: any failure is unknown, never merged)", () => {
  it("capped / timeout / missing-object / git-failed / bad output each map to their own `why`, in ONE request", async () => {
    const w = mergedWindow(6);
    const byTip = new Map<string, () => import("../../../../src/git/run.js").GitRunResult>([
      [w.tips[0]!, () => ({ code: null, stdout: "=", stdoutCapped: true, stderr: "", killed: "overflow" })],
      [w.tips[1]!, () => ({ code: null, stdout: "", stdoutCapped: false, stderr: "", killed: "timeout" })],
      [w.tips[2]!, () => ({ code: 128, stdout: "", stdoutCapped: false, stderr: `fatal: unable to read ${oidOf(7)}` })],
      [w.tips[3]!, () => ({ code: 128, stdout: "", stdoutCapped: false, stderr: "fatal: something else" })],
      [w.tips[4]!, () => okRun("garbage line\n")],
      [w.tips[5]!, () => okRun(cherryOut([oidOf(500)], []))],
    ]);
    const k = mkit();
    installMergedHandler(k.fx, { gr: w.gr, gl: w.gl, gm: (tip) => byTip.get(tip)!() });
    const { io, body } = await k.call();
    expect(io.sent[0]!.status).toBe(200);
    expect(body.merged!.branches.map((b) => [b.n, b.v, b.why])).toEqual([
      ["side-0", "unk", "too-many"],
      ["side-1", "unk", "timeout"],
      ["side-2", "unk", "missing-object"],
      ["side-3", "unk", "git-failed"],
      ["side-4", "unk", "git-failed"],
      ["side-5", "eq", undefined],
    ]);
    expect(parseWtGraphPayload(JSON.parse(JSON.stringify(body)))).not.toBeNull();
  });

  it("unknown results are never cached: the next request re-runs every failed tip", async () => {
    const w = mergedWindow(2);
    let call = 0;
    const k = mkit();
    installMergedHandler(k.fx, {
      gr: w.gr,
      gl: w.gl,
      gm: () =>
        call++ < 2
          ? { code: 128, stdout: "", stdoutCapped: false, stderr: "fatal: nope" }
          : okRun(cherryOut([oidOf(500)], [])),
    });
    expect((await k.call()).body.merged!.branches.every((b) => b.v === "unk")).toBe(true);
    expect(gmCalls(k)).toHaveLength(2);
    expect((await k.call()).body.merged!.branches.every((b) => b.v === "eq")).toBe(true);
    expect(gmCalls(k)).toHaveLength(4);
  });
});

describe("merged=1 — per-Gm recheck and the tail recheck (§3.4 R2-5)", () => {
  it("info/attributes changing DURING Gm ⇒ that tip is unk:attr-changed, not cached (next request re-runs)", async () => {
    const w = mergedWindow(1);
    const k = mkit();
    let mutate = true;
    installMergedHandler(k.fx, {
      gr: w.gr,
      gl: w.gl,
      gm: () => {
        if (mutate) k.fx.fs.writeFile(INFO, "*.txt -diff\n");
        return okRun(cherryOut([oidOf(500)], []));
      },
    });
    const first = await k.call();
    expect(first.body.merged!.branches).toEqual([{ n: "side-0", h: w.tips[0], v: "unk", why: "attr-changed" }]);
    mutate = false;
    k.fx.fs.writeFile(INFO, ""); // back to the snapshot the key was built from
    const second = await k.call();
    expect(second.body.merged!.branches[0]).toMatchObject({ v: "eq" });
    expect(gmCalls(k)).toHaveLength(2); // the failed run left nothing behind
  });

  it("a `shallow` boundary appearing DURING Gm ⇒ unk:attr-changed and not cached", async () => {
    const w = mergedWindow(1);
    const k = mkit();
    let first = true;
    installMergedHandler(k.fx, {
      gr: w.gr,
      gl: w.gl,
      gm: () => {
        if (first) k.fx.fs.writeFile(`${REPO_GIT}/shallow`, "");
        first = false;
        return okRun(cherryOut([oidOf(500)], []));
      },
    });
    expect((await k.call()).body.merged!.branches[0]).toMatchObject({ v: "unk", why: "attr-changed" });
    k.fx.fs.node(REPO_GIT)!.children.delete("shallow");
    expect((await k.call()).body.merged!.branches[0]).toMatchObject({ v: "eq" });
    expect(gmCalls(k)).toHaveLength(2);
  });

  it("a per-Gm recheck that cannot be read at all (io error) is also attr-changed", async () => {
    const w = mergedWindow(1);
    const k = mkit({
      wrapFs: (fs) =>
        hookFs(fs, {
          onInfoOpen: (n) => {
            if (n === 2) throw Object.assign(new Error("EIO"), { code: "EIO" }); // head = 1, recheck = 2
          },
        }),
    });
    installMergedHandler(k.fx, { gr: w.gr, gl: w.gl, gm: allEq(1) });
    expect((await k.call()).body.merged!.branches[0]).toMatchObject({ v: "unk", why: "attr-changed" });
  });

  // request #1 fills the cache; in request #2 every verdict is a cache hit, so the ONLY info/
  // shallow probes are the head read (info #1, shallow #1 = S1) and the tail (info #2, shallow #2).
  async function primed(opts: Parameters<typeof hookFs>[1]): Promise<{ k: MKit; arm(): void }> {
    let armed = false;
    let infoN = 0;
    let shallowN = 0;
    const k = mkit({
      wrapFs: (fs) =>
        hookFs(fs, {
          onInfoOpen: async () => {
            if (armed) await opts.onInfoOpen?.(++infoN);
          },
          onShallowStat: async () => {
            if (armed) await opts.onShallowStat?.(++shallowN);
          },
        }),
    });
    const w = mergedWindow(2);
    installMergedHandler(k.fx, { gr: w.gr, gl: w.gl, gm: allEq(2) });
    const first = await k.call();
    expect(first.body.merged!.branches.map((b) => b.v)).toEqual(["eq", "eq"]);
    expect(gmCalls(k)).toHaveLength(2);
    return {
      k,
      arm: () => {
        armed = true;
      },
    };
  }

  it("tail: info/attributes changed since the head snapshot ⇒ skipped:'attr-changed', all verdicts (even cache hits) discarded + keys evicted + warn", async () => {
    const { k, arm } = await primed({
      onInfoOpen: (n) => {
        if (n === 2) k0.fx.fs.writeFile(INFO, "*.txt -diff\n");
      },
    });
    const k0 = k;
    arm();
    const second = await k.call();
    expect(second.body.merged).toEqual({ v: 1, base: HEAD_SHA1, skipped: "attr-changed", branches: [] });
    expect(gmCalls(k)).toHaveLength(2); // cache hits: zero new Gm
    expect(
      k.log.lines.filter((l) => (l.data as { event?: string } | undefined)?.event === "wtgraph.merged_discarded"),
    ).toEqual([expect.objectContaining({ data: { event: "wtgraph.merged_discarded", reason: "attr-changed" } })]);
    // restoring the original bytes ⇒ same cache key; it must have been EVICTED ⇒ Gm runs again
    k.fx.fs.writeFile(INFO, "");
    const third = await k.call();
    expect(third.body.merged!.branches.map((b) => b.v)).toEqual(["eq", "eq"]);
    expect(gmCalls(k)).toHaveLength(4);
  });

  it("tail: `shallow` appearing ⇒ skipped:'shallow' (with base), discarded", async () => {
    const { k, arm } = await primed({
      onShallowStat: (n) => {
        if (n === 2) k0.fx.fs.writeFile(`${REPO_GIT}/shallow`, "");
      },
    });
    const k0 = k;
    arm();
    const { body } = await k.call();
    expect(body.merged).toEqual({ v: 1, base: HEAD_SHA1, skipped: "shallow", branches: [] });
    expect(gmCalls(k)).toHaveLength(2);
  });

  it("tail: an unreadable info/attributes or shallow stat ⇒ skipped:'unconfirmed'", async () => {
    for (const hook of [
      {
        onInfoOpen: (n: number) => {
          if (n === 2) throw Object.assign(new Error("EIO"), { code: "EIO" });
        },
      },
      {
        onShallowStat: (n: number) => {
          if (n === 2) throw Object.assign(new Error("EIO"), { code: "EIO" });
        },
      },
    ]) {
      const { k, arm } = await primed(hook);
      arm();
      const { body } = await k.call();
      expect(body.merged).toEqual({ v: 1, base: HEAD_SHA1, skipped: "unconfirmed", branches: [] });
    }
  });

  it("the tail is skipped when no tip produced a verdict (nothing to discard): only the head reads happen", async () => {
    const w = mergedWindow(1);
    let infoOpens = 0;
    const k = mkit({ wrapFs: (fs) => hookFs(fs, { onInfoOpen: () => void infoOpens++ }) });
    installMergedHandler(k.fx, {
      gr: w.gr,
      gl: w.gl,
      gm: () => ({ code: 128, stdout: "", stdoutCapped: false, stderr: "fatal" }),
    });
    const { body } = await k.call();
    expect(body.merged!.branches[0]).toMatchObject({ v: "unk", why: "git-failed" });
    expect(infoOpens).toBe(1);
  });
});

describe("merged=1 — cache (§3.6)", () => {
  it("a second request is served from cache: zero new Gm spawns (Cc still runs), identical merged block", async () => {
    const w = mergedWindow(3);
    const k = mkit();
    installMergedHandler(k.fx, { gr: w.gr, gl: w.gl, gm: allEq(2) });
    const first = await k.call({}, fakeIoAs("alice"));
    expect(gmCalls(k)).toHaveLength(3);
    const second = await k.call({}, fakeIoAs("alice"));
    expect(gmCalls(k)).toHaveLength(3);
    expect(ccCalls(k)).toHaveLength(2);
    expect(second.body.merged).toEqual(first.body.merged);
    const audits = auditLines(k.log);
    expect(audits[1]).toMatchObject({ mergedReq: 1, mergedRun: 0, mergedHit: 3 });
  });

  it("TTL: past 10 minutes the entry is recomputed", async () => {
    const w = mergedWindow(1);
    const k = mkit();
    installMergedHandler(k.fx, { gr: w.gr, gl: w.gl, gm: allEq(1) });
    await k.call();
    k.clock.t += 9 * 60_000;
    await k.call();
    expect(gmCalls(k)).toHaveLength(1);
    k.clock.t += 2 * 60_000;
    await k.call();
    expect(gmCalls(k)).toHaveLength(2);
  });

  it("a different HEAD or a different info/attributes signature is a different key", async () => {
    const w = mergedWindow(1);
    const k = mkit();
    installMergedHandler(k.fx, { gr: w.gr, gl: w.gl, gm: allEq(1) });
    await k.call();
    k.fx.fs.writeFile(INFO, "*.md linguist-generated\n");
    await k.call();
    expect(gmCalls(k)).toHaveLength(2);
  });

  it("an oversize value (> itemMaxBytes 16 KiB) is returned but never stored", async () => {
    const w = mergedWindow(1);
    const k = mkit();
    const big = Array.from({ length: 450 }, (_, i) => oidOf(20_000 + i)); // ~19 KiB of JSON
    installMergedHandler(k.fx, { gr: w.gr, gl: w.gl, gm: () => okRun(cherryOut(big, [])) });
    const first = await k.call();
    expect(first.body.merged!.branches[0]).toMatchObject({ v: "eq", k: 450, t: 450 });
    await k.call();
    expect(gmCalls(k)).toHaveLength(2);
  });
});

describe("merged=1 — audit (§3.7)", () => {
  it("counts only: mergedReq/Cand/Omitted/Run/Hit/Unk/Skip/Ms, whitelisted, never a branch, oid or driver name", async () => {
    const w = mergedWindow(26);
    const k = mkit();
    k.fx.fs.writeFile(INFO, "*.x diff=secretdriver\n");
    installMergedHandler(k.fx, {
      gr: w.gr,
      gl: w.gl,
      gm: (tip) =>
        tip === w.tips[1]
          ? { code: 128, stdout: "", stdoutCapped: false, stderr: "fatal" }
          : okRun(cherryOut([oidOf(500)], [])),
    });
    await k.call();
    const [line] = auditLines(k.log);
    expect(
      Object.keys(line!).every((key) => key === "audit" || (WTGRAPH_AUDIT_KEYS as readonly string[]).includes(key)),
    ).toBe(true);
    expect(line).toMatchObject({
      ok: true,
      mergedReq: 1,
      mergedCand: 24,
      mergedOmitted: 2,
      mergedRun: 24,
      mergedHit: 0,
      mergedUnk: 1,
      mergedSkip: 0,
    });
    expect(typeof line!["mergedMs"]).toBe("number");
    const text = JSON.stringify(line);
    for (const secret of ["side-0", "secretdriver", HEAD_SHA1, w.tips[0]!]) expect(text).not.toContain(secret);
  });

  it("a baseline (non-merged) request writes none of the merged keys", async () => {
    const w = mergedWindow(2);
    const k = mkit();
    installMergedHandler(k.fx, { gr: w.gr, gl: w.gl, gm: allEq(1) });
    await k.call({ merged: "0" });
    expect(Object.keys(auditLines(k.log)[0]!).filter((key) => key.startsWith("merged"))).toEqual([]);
  });
});

describe("merged=1 — Gm single-flight, abort and pin loans (§3.4 R2-4)", () => {
  /** A Gm response that is held until `release()` or the call's signal aborts. */
  function gate(): { held: Promise<void>; release(): void; signals: AbortSignal[]; run: MergedScenario["gm"] } {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const signals: AbortSignal[] = [];
    return {
      held,
      release,
      signals,
      run: (_tip, { opts }) =>
        new Promise((resolve) => {
          if (opts.signal !== undefined) signals.push(opts.signal);
          const out = (): void => resolve(okRun(cherryOut([oidOf(500)], [])));
          opts.signal?.addEventListener(
            "abort",
            () => resolve({ code: null, stdout: "", stdoutCapped: false, stderr: "", killed: "abort" }),
            { once: true },
          );
          void held.then(out);
        }),
    };
  }
  const settle = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it("a late joiner shares the leader's Gm (one execution, both answered); every pin is released", async () => {
    const w = mergedWindow(1);
    const g = gate();
    const k = mkit();
    installMergedHandler(k.fx, { gr: w.gr, gl: w.gl, gm: g.run });
    const p1 = k.call({}, fakeIoAs("alice"));
    await settle();
    expect(gmCalls(k)).toHaveLength(1);
    const p2 = k.call({}, fakeIoAs("bob")); // arrives while Gm is still running
    await settle();
    g.release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(gmCalls(k)).toHaveLength(1);
    expect(r1.body.merged).toEqual(r2.body.merged);
    expect(r1.body.merged!.branches[0]).toMatchObject({ v: "eq" });
    expect(k.fx.fs.leakCount()).toBe(0);
  });

  it("leader's client aborts while a joiner still waits ⇒ the shared Gm keeps running and the joiner is answered", async () => {
    const w = mergedWindow(1);
    const g = gate();
    const k = mkit();
    installMergedHandler(k.fx, { gr: w.gr, gl: w.gl, gm: g.run });
    const q = query({ agentKey: AGENT, sessionId: SESSION, wt: LINKED, merged: "1" });
    const lead = fakeClosableRes();
    const ioA = fakeIoAs("alice");
    const pA = k.routes.handle(fakeReq({ "x-pwh": "1" }), lead.res, q, ioA);
    await settle();
    const pB = k.call({}, fakeIoAs("bob"));
    await settle();
    lead.close(); // leader's client leaves
    await pA;
    expect(g.signals[0]!.aborted).toBe(false); // refcount still 1 (the joiner)
    g.release();
    const b = await pB;
    expect(b.body.merged!.branches[0]).toMatchObject({ v: "eq" });
    expect(gmCalls(k)).toHaveLength(1);
    expect(k.fx.fs.leakCount()).toBe(0);
  });

  it("every participant disconnects ⇒ the shared Gm is aborted and the pins are released", async () => {
    const w = mergedWindow(1);
    const g = gate();
    const k = mkit();
    installMergedHandler(k.fx, { gr: w.gr, gl: w.gl, gm: g.run });
    const q = query({ agentKey: AGENT, sessionId: SESSION, wt: LINKED, merged: "1" });
    const a = fakeClosableRes();
    const b = fakeClosableRes();
    const pA = k.routes.handle(fakeReq({ "x-pwh": "1" }), a.res, q, fakeIoAs("alice"));
    await settle();
    const pB = k.routes.handle(fakeReq({ "x-pwh": "1" }), b.res, q, fakeIoAs("bob"));
    await settle();
    a.close();
    b.close();
    await Promise.all([pA, pB]);
    expect(g.signals[0]!.aborted).toBe(true);
    await settle(50);
    expect(k.fx.fs.leakCount()).toBe(0);
  });

  it("hub dispose aborts the in-flight Gm (abortAll) and answers 503 hub-close; pins closed", async () => {
    const w = mergedWindow(1);
    const g = gate();
    const k = mkit();
    installMergedHandler(k.fx, { gr: w.gr, gl: w.gl, gm: g.run });
    const p = k.call({}, fakeIoAs("alice"));
    await settle();
    const { createReqDeadline } = await import("../../../../src/web-hub/hub/req-deadline.js");
    await k.routes.dispose("close", createReqDeadline(Date.now, 5_000));
    const r = await p;
    expect(r.io.sent[0]).toMatchObject({ status: 503, body: { error: "E_HUB_RESTARTING" } });
    expect(g.signals[0]!.aborted).toBe(true);
    await settle(50);
    expect(k.fx.fs.leakCount()).toBe(0);
  });

  it("a waiter whose OWN deadline comes first releases and records unk:timeout, while the leader finishes and caches", async () => {
    // Request A starts its M phase at clock 0 and burns 9.95 s of its 10 s loop budget on tip 0;
    // request B (a later M phase, so a much later deadline) leads tip 1 first — A then JOINS B's
    // gated Gm with only 50 ms left, gives up with `timeout`, and B still completes + caches it.
    const w = mergedWindow(2);
    const g1 = gate();
    const g0 = gate();
    const k = mkit();
    let glCalls = 0;
    installMergedHandler(k.fx, {
      gr: w.gr,
      // B's window lists tip 1 first so B leads it before A gets there
      get gl() {
        return glCalls++ === 0
          ? w.gl
          : glStdout([
              { h: HEAD_SHA1, p: [w.p1], at: 5_000 },
              { h: w.tips[1]!, p: [w.p2], at: 4_001 },
              { h: w.tips[0]!, p: [w.p2], at: 4_000 },
              { h: w.p1, p: [w.p2], at: 3_000 },
              { h: w.p2, p: [], at: 2_000 },
            ]);
      },
      gm: (tip, call) => {
        if (tip === w.tips[0]) {
          k.clock.t += 9_950; // A burns almost its whole loop budget here
          return g0.run(tip, call);
        }
        return g1.run(tip, call);
      },
    });
    const pA = k.call({}, fakeIoAs("alice"));
    await settle();
    expect(gmCalls(k).map(tipOf)).toEqual([w.tips[0]]);
    const pB = k.call({}, fakeIoAs("bob")); // its M deadline starts NOW (after A's clock burn)
    await settle();
    g0.release(); // A moves on to tip 1, which B already leads
    const a = await pA;
    expect(a.body.merged!.branches.map((b) => [b.n, b.v, b.why])).toEqual([
      ["side-0", "eq", undefined],
      ["side-1", "unk", "timeout"],
    ]);
    expect(g1.signals[0]!.aborted).toBe(false); // B is still waiting on it ⇒ not abandoned
    g1.release();
    const b = await pB;
    expect(b.body.merged!.branches.map((x) => x.v).sort()).toEqual(["eq", "eq"]);
    // and B's leader result was cached: a third request needs no Gm
    const before = gmCalls(k).length;
    await k.call({}, fakeIoAs("carol"));
    expect(gmCalls(k)).toHaveLength(before);
    expect(k.fx.fs.leakCount()).toBe(0);
  });
});
