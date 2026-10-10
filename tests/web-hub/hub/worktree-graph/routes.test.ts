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
  glStdout,
  grStdout,
  memLog,
  okRun,
  query,
  repoFixture,
  scriptGraphAdmission,
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
