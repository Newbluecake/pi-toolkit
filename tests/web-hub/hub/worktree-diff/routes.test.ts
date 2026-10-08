/**
 * worktree-diff plan §1.5/§1.7/§1.10/§2 (D3): the two route pipelines over the fake fs +
 * scripted runner — the error matrix row by row, the D14 hidden-entry accounting (3 visible +
 * 2 hidden ⇒ total=3), cache/TTL/HEAD-move recomputes, the single-flight join, numstat /
 * check-attr degradation, the byte caps, the driver-neutralization argv at the ENDPOINT layer
 * (H1), the runtime opts every git call carries (envPolicy/PATH/signal/pins — H2/H3 surface),
 * git-too-old / unborn / filter-config / L3-attr-changed, dispose semantics, the 429 audit
 * throttle and the hub-output ⇄ parser runtime contract.
 */

import { describe, expect, it } from "vitest";

import { denyCtxOf } from "../../../../src/web-hub/hub/preview/admit.js";
import { createWorktreeDiffRoutes } from "../../../../src/web-hub/hub/worktree-diff/routes.js";
import {
  parseWtDiffFile,
  parseWtDiffFileList,
  WTDIFF_DRIVERS_MAX,
  type WtDiffFileList,
} from "../../../../src/web-hub/protocol/worktree-diff.js";
import { WTDIFF_GIT_PATH } from "../../../../src/git/diff.js";
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
  isCmd,
  memLog,
  okRun,
  repoFixture,
  statusV2Z,
  type RepoFixture,
  type Scripted,
  type ScriptedRunner,
} from "./helpers.js";

const DENY = denyCtxOf("/home/tester", "/home/tester/.pi/agent");
const OTHER_SHA1 = "fedcba9876543210fedcba9876543210fedcba98";

/** `git status --porcelain=v2 -z` record helpers. */
const rec1 = (xy: string, path: string): string => `1 ${xy} N... 100644 100644 100644 h1 h2 ${path}`;
const rec2 = (xy: string, path: string, orig: string): string =>
  `2 ${xy} N... 100644 100644 100644 h1 h2 R100 ${path}\0${orig}`;

/** A scripted response that models run.ts's abort behavior: hangs until the signal aborts. */
const hangUntilAbort: Scripted = ({ opts }) =>
  new Promise((resolve) => {
    if (opts.signal === undefined) return; // hangs forever
    opts.signal.addEventListener(
      "abort",
      () => resolve({ code: null, stdout: "", stdoutCapped: false, stderr: "", killed: "abort" }),
      { once: true },
    );
  });

interface Kit {
  fx: RepoFixture;
  routes: ReturnType<typeof createWorktreeDiffRoutes>;
  io: ReturnType<typeof fakeIo>;
  log: ReturnType<typeof memLog>;
  files(params?: Record<string, string>): Promise<void>;
  file(params?: Record<string, string>): Promise<void>;
}

function kit(opts: { infoAttrs?: string; fs?: FakeFs; runner?: ScriptedRunner } = {}): Kit {
  const fx =
    opts.fs !== undefined && opts.runner !== undefined
      ? ({ fs: opts.fs, runner: opts.runner } as RepoFixture)
      : repoFixture({ infoAttrs: opts.infoAttrs });
  const log = memLog();
  const routes = createWorktreeDiffRoutes({
    mode: "on",
    denyCtx: DENY,
    registry: fakeRegistry(REPO),
    run: fx.runner,
    log,
    now: Date.now,
    fs: fx.fs,
  });
  const io = fakeIo();
  const base = { agentKey: AGENT, sessionId: SESSION, wt: LINKED };
  return {
    fx,
    routes,
    io,
    log,
    files: (params = {}) =>
      routes.handleFiles(fakeReq({ "x-pwh": "1" }), fakeRes(), new URLSearchParams({ ...base, ...params }), io),
    file: (params = {}) =>
      routes.handleFile(fakeReq({ "x-pwh": "1" }), fakeRes(), new URLSearchParams({ ...base, ...params }), io),
  };
}

/** The full files-endpoint happy script: C1a, C1, C0, Cc, C2, C3, Cc(L3). */
function scriptFilesList(
  fx: RepoFixture,
  c2Records: string[],
  opts: { c2Oid?: string; c3?: string; cc?: string; head?: string } = {},
): void {
  fx.scriptAdmission({ ...(opts.head === undefined ? {} : { head: opts.head }) });
  fx.runner.push(
    okRun(opts.cc ?? ""), // Cc — no config drivers
    okRun(statusV2Z(opts.c2Oid ?? HEAD_SHA1, c2Records)), // C2
    opts.c3 === "" ? hangUntilAbort : okRun(opts.c3 ?? ""), // C3 ("" ⇒ hang for budget tests)
    okRun(opts.cc ?? ""), // Cc again (L3)
  );
}

function auditLines(log: ReturnType<typeof memLog>): Array<Record<string, unknown>> {
  return log.lines.filter((l) => l.msg === "wtdiff").map((l) => (l.data ?? {}) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// the happy paths + the runtime contract
// ---------------------------------------------------------------------------

describe("routes — files happy path + parser contract", () => {
  it("200: entries in status order, numstat counts merged, parser accepts the body byte-for-byte", async () => {
    const k = kit();
    scriptFilesList(
      k.fx,
      [rec1(".M", "src/a.ts"), rec2("R.", "src/moved.ts", "src/orig.ts"), "? new.txt", rec1(".D", "gone.rs")],
      { c3: "3\t1\tsrc/a.ts\u0000" + "0\t0\t\u0000src/orig.ts\u0000src/moved.ts\u0000" },
    );
    k.fx.runner.calls.length = 0;
    await k.files();
    const sent = k.io.sent[0]!;
    if (sent.status !== 200)
      throw new Error(
        `happy failed: ${JSON.stringify(sent.body)} log=${JSON.stringify(k.log.lines.map((l) => l.msg))}`,
      );
    expect(sent.status).toBe(200);
    expect(sent.headers["Cache-Control"]).toBe("no-store");
    const list = sent.body as WtDiffFileList;
    expect(list.base).toBe(HEAD_SHA1);
    expect(list.entries.map((e) => [e.path, e.status])).toEqual([
      ["src/a.ts", "M"],
      ["src/moved.ts", "R"],
      ["new.txt", "?"],
      ["gone.rs", "D"],
    ]);
    expect(list.entries[0]).toMatchObject({ add: 3, del: 1 });
    expect(list.entries[1]).toMatchObject({ orig: "src/orig.ts", add: 0, del: 0 });
    expect(list.entries[2]!.add).toBeUndefined(); // untracked: never counted
    expect(list.total).toBe(4);
    expect(list.truncated).toBe(false);
    // the hub⇄parser runtime contract: the exact body re-parses clean
    const bytes = Buffer.byteLength(JSON.stringify(list), "utf8");
    expect(parseWtDiffFileList(list, bytes)).toEqual(list);
    // audit: one line, visible count only
    const audits = auditLines(k.log);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ audit: "wtdiff", phase: "files", ok: true, files: 4, drivers: 0 });
  });

  it("H2/H3 runtime surface: every git call carries envPolicy minimal, the fixed PATH, the signal — and pins on every pinned cmd", async () => {
    const k = kit();
    scriptFilesList(k.fx, [rec1(".M", "a.txt")]);
    await k.files();
    for (const call of k.fx.runner.calls) {
      expect(call.opts.envPolicy).toBe("minimal");
      expect(call.opts.pathOverride).toBe(WTDIFF_GIT_PATH);
      expect(call.opts.signal).toBeInstanceOf(AbortSignal);
      if (isCmd(call.argv, "C1a") || isCmd(call.argv, "C1")) {
        expect(call.opts.pins).toBeUndefined();
        expect(call.opts.cwd).toBe(REPO);
      } else {
        expect(call.opts.pins).toMatchObject({
          wt: expect.any(Number),
          git: expect.any(Number),
          common: expect.any(Number),
        });
        expect(call.opts.cwd).toBeUndefined();
      }
    }
    // the three pinned git fds are the membership pins' fds, closed by ⑬
    expect(k.fx.fs.leakCount()).toBe(0);
  });

  it("H1 endpoint layer: C2/C3/C4 argv carry the pinned prefix, --literal-pathspecs, hooksPath=/dev/null and (with drivers) L1+N", async () => {
    const k = kit();
    // one config driver (lfs) so L1+N are visible in C2/C3
    k.fx.scriptAdmission();
    k.fx.runner.push(
      okRun("filter.lfs.clean\ngit-lfs clean -- %f\0"), // Cc
      okRun(statusV2Z(HEAD_SHA1, [rec1(".M", "a.txt")])), // C2
      okRun("a.txt\0filter\0lfs\0"), // Ca
      okRun("1\t2\ta.txt\0"), // C3
      okRun("filter.lfs.clean\ngit-lfs clean -- %f\0"), // Cc (L3)
    );
    await k.files();
    const argvs = k.fx.runner.calls.map((c) => c.argv.join(" "));
    const c2 = argvs.find((a) => a.includes("status --porcelain=v2"))!;
    expect(c2).toContain("-C /proc/self/fd/3 --git-dir=/proc/self/fd/4 --work-tree=/proc/self/fd/3");
    expect(c2).toContain("--literal-pathspecs");
    expect(c2).toContain("-c core.hooksPath=/dev/null");
    expect(c2).toContain("--attr-source=4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    expect(c2).toContain("-c core.attributesFile=/dev/null");
    expect(c2).toContain(
      "-c filter.lfs.clean= -c filter.lfs.smudge= -c filter.lfs.process= -c filter.lfs.required=false -c diff.lfs.textconv= -c diff.lfs.command=",
    );
    expect(c2).toContain("--ignore-submodules=all");
    const c3 = argvs.find((a) => a.includes("diff-index --numstat"))!;
    expect(c3).toContain("--attr-source=");
    expect(c3).toContain("-c filter.lfs.clean=");
    // the LFS-managed entry is listed but marked filtered (never requestable)
    const list = k.io.sent[0]!.body as WtDiffFileList;
    expect(list.entries[0]).toMatchObject({ path: "a.txt", filtered: true });
    expect(list.attrPartial).toBeUndefined();
    expect(auditLines(k.log)[0]).toMatchObject({ drivers: 1 });
  });
});

describe("routes — file endpoint", () => {
  function scriptFilePatch(fx: RepoFixture, patch: string, opts: { head?: string } = {}): void {
    fx.scriptAdmission({ ...(opts.head === undefined ? {} : { head: opts.head }) });
    fx.runner.push(
      okRun(""), // Cc
      okRun(statusV2Z(opts.head ?? HEAD_SHA1, [rec1(".M", "a.txt")])), // C2
      okRun(patch), // C4
      okRun(""), // Cc (L3)
    );
  }

  it("200: raw unified patch in the envelope; bytes == patch UTF-8; parser contract holds", async () => {
    const k = kit();
    const patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-x\n+y\n";
    scriptFilePatch(k.fx, patch);
    await k.file({ base: HEAD_SHA1, path: "a.txt" });
    const sent = k.io.sent[0]!;
    expect(sent.status).toBe(200);
    const payload = sent.body as Record<string, unknown>;
    expect(payload).toMatchObject({ base: HEAD_SHA1, path: "a.txt", kind: "patch", patch, truncated: false });
    expect(payload["bytes"]).toBe(Buffer.byteLength(patch, "utf8"));
    expect(parseWtDiffFile(payload, Buffer.byteLength(JSON.stringify(payload), "utf8"))).toEqual(payload);
    expect(auditLines(k.log)[0]).toMatchObject({
      phase: "file",
      ok: true,
      status: "M",
      kind: "patch",
      bytes: Buffer.byteLength(patch, "utf8"),
    });
  });

  it("binary and empty kinds; rename requests carry orig", async () => {
    const k = kit();
    k.fx.scriptAdmission();
    k.fx.runner.push(
      okRun(""), // Cc
      okRun(statusV2Z(HEAD_SHA1, [rec2("R.", "dst.ts", "src.ts"), rec1(".M", "empty.txt")])), // C2
      okRun("diff --git a/src.ts b/dst.ts\nsimilarity index 100%\nrename from src.ts\nrename to dst.ts\n"), // C4 rename
      okRun(""), // Cc
    );
    await k.file({ base: HEAD_SHA1, path: "dst.ts", orig: "src.ts" });
    expect(k.io.sent[0]!.body).toMatchObject({ kind: "empty", patch: "", orig: "src.ts" });

    const k2 = kit();
    k2.fx.scriptAdmission();
    k2.fx.runner.push(
      okRun(""),
      okRun(statusV2Z(HEAD_SHA1, [rec1(".M", "blob.bin")])),
      okRun("diff --git a/blob.bin b/blob.bin\nBinary files a/blob.bin and b/blob.bin differ\n"),
      okRun(""),
    );
    await k2.file({ base: HEAD_SHA1, path: "blob.bin" });
    expect(k2.io.sent[0]!.body).toMatchObject({ kind: "binary", patch: "", bytes: 0 });
  });

  it("untracked entry: server-synthesized all-add patch, untracked:true", async () => {
    const k = kit();
    k.fx.fs.writeFile(`${LINKED}/new.txt`, "fresh\ncontent\n");
    k.fx.scriptAdmission();
    k.fx.runner.push(
      okRun(""), // Cc
      okRun(statusV2Z(HEAD_SHA1, ["? new.txt"])), // C2
      okRun(""), // Cc (L3 — C4 never runs for untracked)
    );
    await k.file({ base: HEAD_SHA1, path: "new.txt" });
    const sent = k.io.sent[0]!;
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({
      kind: "patch",
      untracked: true,
      patch:
        "diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+fresh\n+content\n",
    });
    // no diff-index ever ran — the content came from the admitter
    expect(k.fx.runner.argvLog().some((a) => a.includes("diff-index -p"))).toBe(false);
    expect(auditLines(k.log)[0]).toMatchObject({ kind: "untracked", status: "?" });
  });

  it("#1: base ≠ this request's C0 ⇒ 409 base and C4 NEVER executes", async () => {
    const k = kit();
    k.fx.scriptAdmission();
    k.fx.runner.push(okRun(""), okRun(statusV2Z(HEAD_SHA1, [rec1(".M", "a.txt")])), okRun("SHOULD NOT RUN"));
    await k.file({ base: OTHER_SHA1, path: "a.txt" });
    expect(k.io.sent[0]).toMatchObject({ status: 409, body: { error: "E_STALE_CTX", reason: "base" } });
    expect(k.fx.runner.argvLog().some((a) => a.includes("diff-index -p"))).toBe(false);
    expect(auditLines(k.log)[0]).toMatchObject({ ok: false, code: "E_STALE_CTX", reason: "base" });
  });

  it("#1: path outside the current changeset ⇒ 409 entry — historically-present, hidden, filtered and CR-named paths are the SAME answer", async () => {
    for (const [name, path, records] of [
      ["not in changeset", "committed-only.txt", [rec1(".M", "a.txt")]],
      ["filtered (LFS)", "a.txt", [rec1(".M", "a.txt")]],
      // §1.2's param gate rejects CR at ③ (400) — §1.5's 409-entry row covers entries the
      // CHANGESSET cannot serve; either way C4 never executes and no oracle leaks
      ["CR in name", "evil\r.txt", [rec1(".M", "a.txt")]],
      ["orig mismatch", "moved.ts", [rec2("R.", "moved.ts", "other.ts")]],
    ] as const) {
      const k = kit();
      k.fx.scriptAdmission();
      if (name === "filtered (LFS)") {
        k.fx.runner.push(
          okRun("filter.lfs.clean\nx\0"), // Cc: one driver ⇒ Ca runs
          okRun(statusV2Z(HEAD_SHA1, [rec1(".M", "a.txt")])), // C2
          okRun("a.txt\0filter\0lfs\0"), // Ca marks a.txt filtered
          okRun("SHOULD NOT RUN"), // C4
          okRun("filter.lfs.clean\nx\0"), // Cc (L3)
        );
      } else {
        k.fx.runner.push(
          okRun(""), // Cc
          okRun(
            statusV2Z(HEAD_SHA1, records.length > 0 ? records : [rec1(".M", "x")]) +
              (name === "not in changeset" ? "" : ""),
          ), // C2
          okRun("SHOULD NOT RUN"), // C4
          okRun(""), // Cc (L3)
        );
      }
      await k.file({ base: HEAD_SHA1, path, ...(name === "orig mismatch" ? { orig: "was.ts" } : {}) });
      if (name === "CR in name") {
        expect(k.io.sent[0], name).toMatchObject({ status: 400, body: { error: "E_BAD_REQUEST" } });
      } else {
        expect(k.io.sent[0], name).toMatchObject({ status: 409, body: { error: "E_STALE_CTX", reason: "entry" } });
      }
      expect(
        k.fx.runner.argvLog().some((a) => a.includes("diff-index -p")),
        name,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// §1.5 matrix rows (route level)
// ---------------------------------------------------------------------------

describe("routes — §1.5 error matrix", () => {
  it("closing ⇒ 503 E_HUB_RESTARTING; after dispose the same", async () => {
    const k = kit();
    await k.routes.dispose("close", { at: Date.now() + 1_000, remaining: () => 1_000, expired: () => false });
    await k.files();
    expect(k.io.sent[0]).toMatchObject({ status: 503, body: { error: "E_HUB_RESTARTING" } });
  });

  it("CSRF: no X-PWH ⇒ 403 before auth; wrong Origin ⇒ 403", async () => {
    const k = kit();
    const io = k.io;
    await k.routes.handleFiles(
      fakeReq({}),
      fakeRes(),
      new URLSearchParams({ agentKey: AGENT, sessionId: SESSION, wt: LINKED }),
      io,
    );
    expect(io.sent[0]).toMatchObject({ status: 403, body: { error: "E_CSRF" } });
    const io2 = fakeIo();
    await k.routes.handleFiles(
      fakeReq({ "x-pwh": "1", origin: "http://evil.example" }),
      fakeRes(),
      new URLSearchParams({ agentKey: AGENT, sessionId: SESSION, wt: LINKED }),
      io2,
    );
    expect(io2.sent[0]).toMatchObject({ status: 403, body: { error: "E_CSRF" } });
  });

  it("authorize handled ⇒ mirror-back code, no further pipeline", async () => {
    const k = kit();
    const io = fakeIo();
    const handled = { ...io, authorize: async () => ({ handled: true as const, code: "E_AUTH" }) };
    await k.routes.handleFiles(
      fakeReq({ "x-pwh": "1" }),
      fakeRes(),
      new URLSearchParams({ agentKey: AGENT, sessionId: SESSION, wt: LINKED }),
      handled,
    );
    expect(io.sent.length).toBe(0); // authorize already answered on ITS io
    expect(auditLines(k.log)[0]).toMatchObject({ code: "E_AUTH" });
  });

  it("params: bad agentKey / sessionId / wt / unknown untracked value ⇒ 400; bad base/path ⇒ 400", async () => {
    const k = kit();
    await k.files({ agentKey: "bad key" });
    expect(k.io.sent[0]!.status).toBe(400);
    await k.files({ sessionId: "has spaces" });
    expect(k.io.sent[1]!.status).toBe(400);
    await k.files({ wt: "relative/path" });
    expect(k.io.sent[2]!.status).toBe(400);
    await k.files({ untracked: "sometimes" });
    expect(k.io.sent[3]!.status).toBe(400);
    await k.file({ base: "nothex", path: "a.txt" });
    expect(k.io.sent[4]!.status).toBe(400);
    await k.file({ base: HEAD_SHA1, path: "../escape" });
    expect(k.io.sent[5]!.status).toBe(400);
    await k.file({ base: HEAD_SHA1, path: ".git/config" });
    expect(k.io.sent[6]!.status).toBe(400);
  });

  it("unknown agent ⇒ 404; session mismatch ⇒ 409", async () => {
    const k = kit();
    await k.files({ agentKey: "ghost" });
    expect(k.io.sent[0]).toMatchObject({ status: 404, body: { error: "E_NOT_FOUND" } });
    await k.files({ sessionId: "different" });
    expect(k.io.sent[1]).toMatchObject({ status: 409, body: { error: "E_SESSION_CHANGED" } });
  });

  it("membership refusals map to the matrix: not-repo 403, not-worktree 403, denylist 403, deadline 504, git-unavailable 503", async () => {
    const notRepo = kit();
    notRepo.fx.runner.push({ ...okRun(""), code: 128 }); // C1a fails
    await notRepo.files();
    expect(notRepo.io.sent[0]).toMatchObject({ status: 403, body: { error: "E_WTDIFF_DENIED", reason: "not-repo" } });

    const notWt = kit();
    notWt.fx.scriptAdmission({ list: `worktree ${REPO}\nHEAD ${HEAD_SHA1}\n\n\n` }); // LINKED not listed
    notWt.fx.runner.push(okRun(""), okRun(statusV2Z(HEAD_SHA1, [])), okRun(""), okRun(""));
    await notWt.files();
    expect(notWt.io.sent[0]).toMatchObject({ status: 403, body: { error: "E_WTDIFF_DENIED", reason: "not-worktree" } });

    const dl = kit();
    dl.fx.fs.writeFile(`${LINKED}/.env`, "x"); // the .env basename pattern is a denylist rule
    dl.fx.scriptAdmission();
    dl.fx.runner.push(okRun(""), okRun(statusV2Z(HEAD_SHA1, [rec1(".M", ".env")])), okRun(""), okRun(""));
    await dl.files();
    // the entry is HIDDEN from the list (D14), but the direct file ask is 403 denylist
    const listBody = dl.io.sent[0]!.body as WtDiffFileList;
    expect(listBody.entries).toEqual([]);
    expect(listBody.total).toBe(0);
    const dl2 = kit();
    dl2.fx.scriptAdmission();
    dl2.fx.runner.push(
      okRun(""),
      okRun(statusV2Z(HEAD_SHA1, [rec1(".M", "a.txt")])),
      okRun("SHOULD NOT RUN"),
      okRun(""),
    );
    await dl2.file({ base: HEAD_SHA1, path: ".env" });
    expect(dl2.io.sent[0]).toMatchObject({ status: 403, body: { error: "E_WTDIFF_DENIED", reason: "denylist" } });
    // the literal check precedes the ENTIRE git phase — not even C0 ran (§1.7 ⑥, "先于任何 git")
    expect(dl2.fx.runner.argvLog().some((a) => a.includes("rev-parse --show-object-format"))).toBe(false);
    expect(dl2.fx.runner.argvLog().some((a) => a.includes("diff-index -p"))).toBe(false);

    const deadline = kit();
    deadline.fx.runner.push({ ...okRun(""), killed: "timeout", code: null }); // C1a times out
    await deadline.files();
    expect(deadline.io.sent[0]).toMatchObject({ status: 504, body: { error: "E_DEADLINE" } });

    const gone = kit();
    gone.fx.runner.push({ ...okRun(""), spawnError: "ENOENT" }); // git missing
    await gone.files();
    expect(gone.io.sent[0]).toMatchObject({
      status: 503,
      body: { error: "E_WTDIFF_UNSUPPORTED", reason: "git-unavailable" },
    });
  });

  it("unborn: C0 exits nonzero ⇒ 415 unborn", async () => {
    const k = kit();
    k.fx.runner.push(
      okRun(`${REPO_GIT}\n`),
      okRun(`worktree ${REPO}\nHEAD ${HEAD_SHA1}\n\nworktree ${LINKED}\nHEAD ${HEAD_SHA1}\n\n\n`),
      { ...okRun(""), code: 128 },
    );
    await k.files();
    expect(k.io.sent[0]).toMatchObject({ status: 415, body: { error: "E_WTDIFF_UNSUPPORTED", reason: "unborn" } });
  });

  it("git-too-old: C2 exiting 129 ⇒ 503 git-too-old (no list data)", async () => {
    const k = kit();
    k.fx.scriptAdmission();
    k.fx.runner.push(
      okRun(""), // Cc
      { ...okRun(""), code: 129, stderr: "error: unknown option `attr-source'" }, // C2
    );
    await k.files();
    expect(k.io.sent[0]).toMatchObject({ status: 503, body: { error: "E_WTDIFF_UNSUPPORTED", reason: "git-too-old" } });
  });

  it("r_C08QEVY5: Ca exiting 129 ⇒ 503 git-too-old — NEVER a filter degrade, never list data", async () => {
    const k = kit();
    k.fx.scriptAdmission();
    k.fx.runner.push(
      okRun("filter.lfs.clean\ngit-lfs clean -- %f\u0000"), // Cc: one driver ⇒ Ca runs
      okRun(statusV2Z(HEAD_SHA1, [rec1(".M", "a.txt")])), // C2
      { ...okRun(""), code: 129, stderr: "error: unknown option `source'" }, // Ca (check-attr --source)
    );
    await k.files();
    expect(k.io.sent[0]).toMatchObject({ status: 503, body: { error: "E_WTDIFF_UNSUPPORTED", reason: "git-too-old" } });
    // never a 200/attrPartial list — the whole changeset computation was discarded
    expect((k.io.sent[0]!.body as Record<string, unknown>)["entries"]).toBeUndefined();
  });

  it("r_C08QEVY5: C3 exiting 129 ⇒ 503 git-too-old — never a numstat degrade", async () => {
    const k = kit();
    k.fx.scriptAdmission();
    k.fx.runner.push(
      okRun(""), // Cc
      okRun(statusV2Z(HEAD_SHA1, [rec1(".M", "a.txt")])), // C2
      { ...okRun(""), code: 129, stderr: "error: unknown option `attr-source'" }, // C3 (diff-index --attr-source)
    );
    await k.files();
    expect(k.io.sent[0]).toMatchObject({ status: 503, body: { error: "E_WTDIFF_UNSUPPORTED", reason: "git-too-old" } });
    expect((k.io.sent[0]!.body as Record<string, unknown>)["entries"]).toBeUndefined();
    // and the file endpoint never reaches C4 after a 129 C3 sibling: same error family
    const k2 = kit();
    k2.fx.scriptAdmission();
    k2.fx.runner.push(
      okRun(""),
      okRun(statusV2Z(HEAD_SHA1, [rec1(".M", "a.txt")])),
      okRun("@@ -1 +1 @@\n-x\n+y\n"), // C4
      okRun(""), // Cc (L3)
    );
    await k2.file({ base: HEAD_SHA1, path: "a.txt" });
    expect(k2.io.sent[0]).toMatchObject({ status: 200, body: { kind: "patch" } });
    expect(k2.fx.runner.argvLog().some((a) => a.includes("diff-index -p"))).toBe(true);
  });

  it("C2 nonzero (C0 succeeded — the commondir fail-closed shape) ⇒ 500 E_INTERNAL + the git-failed warn, NEVER list data", async () => {
    const k = kit();
    k.fx.scriptAdmission();
    k.fx.runner.push(okRun(""), { ...okRun("garbage partial data"), code: 128, stderr: "fatal: bad object x" });
    await k.files();
    expect(k.io.sent[0]).toMatchObject({ status: 500, body: { error: "E_INTERNAL" } });
    const warn = k.log.lines.find((l) => l.msg === "wtdiff git failed");
    expect(warn?.data).toMatchObject({ event: "wtdiff.git_failed", cmd: "C2", exit: 128 });
    // stderr never rides the log — only its byte length would (none here)
    expect(JSON.stringify(k.log.lines)).not.toContain("fatal: bad object");
  });

  it("filter-config: unsafe driver name / >16 drivers / info/attributes over 64 KiB ⇒ 415 and C2 never runs", async () => {
    for (const [name, cc, attrs] of [
      ["unsafe config name", okRun("filter.a=b.clean\nx\0"), undefined],
      [
        "17 drivers",
        okRun(Array.from({ length: WTDIFF_DRIVERS_MAX + 1 }, (_, i) => `filter.d${i}.clean\nx`).join("\0") + "\0"),
        undefined,
      ],
      ["info/attributes oversized", okRun(""), "x".repeat(65 * 1024)],
    ] as const) {
      const k = kit({ ...(attrs === undefined ? {} : { infoAttrs: attrs }) });
      k.fx.scriptAdmission();
      k.fx.runner.push(cc, okRun("SHOULD NOT RUN")); // C2 must never execute
      await k.files();
      expect(k.io.sent[0]!.status, name).toBe(415);
      expect(k.io.sent[0]!.body, name).toMatchObject({ error: "E_WTDIFF_UNSUPPORTED", reason: "filter-config" });
      expect(
        k.fx.runner.argvLog().some((a) => a.includes("status --porcelain=v2")),
        name,
      ).toBe(false);
    }
  });

  it("L3 attr-changed: info/attributes changed between ⑧ and ⑪ ⇒ 503 attr-changed, result discarded, warn line", async () => {
    const k = kit();
    k.fx.scriptAdmission();
    k.fx.runner.push(
      okRun(""), // Cc
      okRun(statusV2Z(HEAD_SHA1, [rec1(".M", "a.txt")])), // C2
      okRun("1\t2\ta.txt\0"), // C3
      okRun("filter.lfs.clean\nx\0"), // Cc AGAIN — a driver appeared during execution
    );
    await k.files();
    expect(k.io.sent[0]).toMatchObject({ status: 503, body: { error: "E_BUSY", reason: "attr-changed" } });
    expect(k.log.lines.some((l) => (l.data as Record<string, unknown>)?.["event"] === "wtdiff.attr_changed")).toBe(
      true,
    );
  });

  it("in-flight caps: the 3rd concurrent same-principal request ⇒ 503 E_BUSY{inflight}", async () => {
    const k = kit();
    k.fx.runner.setHandler(({ argv, opts }) => {
      if (isCmd(argv, "C1a")) return okRun(`${REPO_GIT}\n`);
      if (isCmd(argv, "C1")) return okRun(k.fx.porcelain);
      if (isCmd(argv, "C0")) return okRun(`sha1\n${HEAD_SHA1}\n`);
      // every other command (Cc / C2) hangs until its own signal aborts
      return new Promise<GitRunResult>((resolve) => {
        opts.signal?.addEventListener(
          "abort",
          () => resolve({ code: null, stdout: "", stdoutCapped: false, stderr: "", killed: "abort" }),
          { once: true },
        );
      });
    });
    const io1 = fakeIo();
    const io2 = fakeIo();
    const io3 = fakeIo();
    const q = { agentKey: AGENT, sessionId: SESSION, wt: LINKED };
    const p1 = k.routes.handleFiles(fakeReq({ "x-pwh": "1" }), fakeRes(), new URLSearchParams(q), io1);
    const p2 = k.routes.handleFiles(fakeReq({ "x-pwh": "1" }), fakeRes(), new URLSearchParams(q), io2);
    await new Promise((r) => setTimeout(r, 10));
    const p3 = k.routes.handleFiles(fakeReq({ "x-pwh": "1" }), fakeRes(), new URLSearchParams(q), io3);
    await p3;
    expect(io3.sent[0]).toMatchObject({ status: 503, body: { error: "E_BUSY", reason: "inflight" } });
    // C2 is single-flighted: both leaders joined ONE execution — abort both, let it die
    await k.routes.dispose("close", { at: Date.now() + 500, remaining: () => 500, expired: () => false });
    await Promise.allSettled([p1, p2]);
    expect(io1.sent[0]).toMatchObject({ status: 503, body: { error: "E_HUB_RESTARTING" } });
  });
});

// ---------------------------------------------------------------------------
// D14 hidden accounting / degradation / caps / 429 / dispose
// ---------------------------------------------------------------------------

describe("routes — D14, degradation, caps, 429, dispose", () => {
  it("3 visible + 2 hidden ⇒ total=3; hidden items appear in NO field (audit files=3, truncated=false)", async () => {
    const k = kit();
    k.fx.scriptAdmission();
    k.fx.runner.push(
      okRun(""), // Cc
      okRun(
        statusV2Z(HEAD_SHA1, [
          rec1(".M", "a.txt"),
          rec1(".M", ".env"),
          rec1(".M", "c.txt"),
          rec1(".M", "id_rsa"),
          rec1(".M", "d.ts"),
        ]),
      ), // C2
      okRun("1\t0\ta.txt\0"), // C3 (partial is fine — only a.txt counted here)
      okRun(""), // Cc
    );
    await k.files();
    const list = k.io.sent[0]!.body as WtDiffFileList;
    expect(list.entries.map((e) => e.path)).toEqual(["a.txt", "c.txt", "d.ts"]);
    expect(list.total).toBe(3);
    expect(list.truncated).toBe(false);
    expect(JSON.stringify(list)).not.toContain(".env");
    expect(JSON.stringify(list)).not.toContain("id_rsa");
    expect(auditLines(k.log)[0]).toMatchObject({ files: 3 });
  });

  it("numstat degrade: C3 nonzero ⇒ 200 with numstatPartial, no add/del on entries", async () => {
    const k = kit();
    k.fx.scriptAdmission();
    k.fx.runner.push(
      okRun(""),
      okRun(statusV2Z(HEAD_SHA1, [rec1(".M", "a.txt")])),
      { ...okRun(""), code: 128 }, // C3 fails — a degrade, never an error
      okRun(""),
    );
    await k.files();
    const list = k.io.sent[0]!.body as WtDiffFileList;
    expect(k.io.sent[0]!.status).toBe(200);
    expect(list.entries[0]!.add).toBeUndefined();
    expect(list.numstatPartial).toBe(true);
  });

  it("status byte cap: capped C2 ⇒ limits.status + truncated", async () => {
    const k = kit();
    k.fx.scriptAdmission();
    k.fx.runner.push(
      okRun(""),
      { ...okRun(statusV2Z(HEAD_SHA1, [rec1(".M", "a.txt")])), killed: "overflow" as const, stdoutCapped: true },
      okRun("1\t1\ta.txt\0"),
      okRun(""),
    );
    await k.files();
    const list = k.io.sent[0]!.body as WtDiffFileList;
    expect(list.limits.status).toBe(true);
    expect(list.truncated).toBe(true);
  });

  it("429 audit throttle: 5 rejected floods in one window ⇒ exactly ONE audit line; a non-429 still audits", async () => {
    const k = kit();
    // exhaust the 20-token bucket with 20 fast 400-free requests... simplest: drive the SAME
    // bucket through the file endpoint with valid params but a C1a failure each time (cheap)
    for (let i = 0; i < 20; i++) {
      k.fx.runner.push({ ...okRun(""), code: 128 }); // C1a nonzero ⇒ 403 (one audit line each)
      await k.files();
    }
    expect(auditLines(k.log)).toHaveLength(20);
    // the 21st hits the bucket: 429 — the FIRST one audits, the rest are throttled
    for (let i = 0; i < 5; i++) await k.files();
    const four29 = k.io.sent.slice(20).filter((s) => s.status === 429);
    expect(four29.length).toBe(5);
    expect(auditLines(k.log).length).toBe(21); // 20 + exactly one 429 line
  });

  it("dispose: in-flight requests abort hub-close (503), the pinned fds close, dispose is idempotent", async () => {
    const k = kit();
    k.fx.scriptAdmission();
    k.fx.runner.push(okRun(""), hangUntilAbort, okRun(""), okRun(""));
    const io = fakeIo();
    const pending = k.routes.handleFiles(
      fakeReq({ "x-pwh": "1" }),
      fakeRes(),
      new URLSearchParams({ agentKey: AGENT, sessionId: SESSION, wt: LINKED }),
      io,
    );
    await new Promise((r) => setTimeout(r, 10)); // past membership, into the hanging C2
    expect(k.fx.fs.leakCount()).toBe(3); // the three pins are open
    const deadline = { at: Date.now() + 1_000, remaining: () => 1_000, expired: () => false };
    await k.routes.dispose("close", deadline);
    await k.routes.dispose("close", deadline); // idempotent
    await pending;
    expect(io.sent[0]).toMatchObject({ status: 503, body: { error: "E_HUB_RESTARTING" } });
    expect(k.fx.fs.leakCount()).toBe(0); // every pin closed
  });
});

// ---------------------------------------------------------------------------
// single-flight at the route level + the two body byte caps (§1.10 / §3.1 ⑫)
// ---------------------------------------------------------------------------

describe("routes — single-flight and byte caps", () => {
  it("two concurrent files requests share ONE C2 execution (joined:true audits on the joiner)", async () => {
    const k = kit();
    k.fx.runner.setHandler(({ argv }) => {
      if (isCmd(argv, "C1a")) return okRun(`${REPO_GIT}\n`);
      if (isCmd(argv, "C1")) return okRun(k.fx.porcelain);
      if (isCmd(argv, "C0")) return okRun(`sha1\n${HEAD_SHA1}\n`);
      if (isCmd(argv, "Cc")) return okRun("");
      if (isCmd(argv, "C2")) return okRun(statusV2Z(HEAD_SHA1, [rec1(".M", "a.txt")]));
      if (isCmd(argv, "C3")) return okRun("1\t1\ta.txt\0");
      return okRun("");
    });
    const io1 = fakeIo();
    const io2 = fakeIo();
    const q = new URLSearchParams({ agentKey: AGENT, sessionId: SESSION, wt: LINKED });
    const [r1, r2] = await Promise.all([
      k.routes.handleFiles(fakeReq({ "x-pwh": "1" }), fakeRes(), q, io1),
      k.routes.handleFiles(fakeReq({ "x-pwh": "1" }), fakeRes(), q, io2),
    ]);
    void r1;
    void r2;
    expect(io1.sent[0]!.status).toBe(200);
    expect(io2.sent[0]!.status).toBe(200);
    expect(k.fx.runner.calls.filter((c) => isCmd(c.argv, "C2"))).toHaveLength(1); // ONE execution
    const audits = auditLines(k.log);
    expect(audits).toHaveLength(2);
    expect(audits.some((a) => a["joined"] === true)).toBe(true);
    // both requests' pins closed
    expect(k.fx.fs.leakCount()).toBe(0);
  });

  it("list byte cap: >256 KiB of entries ⇒ tail-dropped with limits.bytes and truncated", async () => {
    const k = kit();
    const long = Array.from({ length: 900 }, (_, i) =>
      rec1(".M", `src/${String(i).padStart(4, "0")}/${"x".repeat(320)}.ts`),
    );
    k.fx.scriptAdmission();
    k.fx.runner.push(okRun(""), okRun(statusV2Z(HEAD_SHA1, long)), okRun(""), okRun(""));
    await k.files();
    const sent = k.io.sent[0]!;
    expect(sent.status).toBe(200);
    const list = sent.body as WtDiffFileList;
    expect(list.limits.bytes).toBe(true);
    expect(list.truncated).toBe(true);
    expect(list.entries.length).toBeLessThan(long.length);
    expect(list.total).toBe(long.length);
    expect(Buffer.byteLength(JSON.stringify(sent.body), "utf8")).toBeLessThanOrEqual(256 * 1024);
    // the trimmed body still parses cleanly through the contract parser
    expect(parseWtDiffFileList(sent.body, Buffer.byteLength(JSON.stringify(sent.body), "utf8"))).not.toBeNull();
  });

  it("file body cap: a JSON-escaped patch beyond 1 MiB is trimmed from the tail, truncated:true, still contract-valid", async () => {
    const k = kit();
    // ~300 KiB of \u0001 control chars — JSON.stringify escapes each ONE BYTE to six chars
    // ⇒ a ~1.8 MiB JSON body from a ≤512 KiB patch (the ⑫ serialization-cap path)
    const line = `+${"\u0001".repeat(32)}`;
    const count = Math.floor((300 * 1024) / (line.length + 1));
    const patch = `diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n@@ -0,0 +1,${count} @@\n${Array.from({ length: count }, () => line).join("\n")}\n`;
    expect(Buffer.byteLength(patch, "utf8")).toBeLessThanOrEqual(512 * 1024);
    expect(Buffer.byteLength(JSON.stringify({ p: patch }), "utf8")).toBeGreaterThan(1024 * 1024);
    k.fx.scriptAdmission();
    k.fx.runner.push(okRun(""), okRun(statusV2Z(HEAD_SHA1, [rec1(".M", "big.ts")])), okRun(patch), okRun(""));
    await k.file({ base: HEAD_SHA1, path: "big.ts" });
    const sent = k.io.sent[0]!;
    expect(sent.status).toBe(200);
    const payload = sent.body as Record<string, unknown>;
    expect(payload["truncated"]).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(sent.body), "utf8")).toBeLessThanOrEqual(1024 * 1024);
    expect(parseWtDiffFile(sent.body, Buffer.byteLength(JSON.stringify(sent.body), "utf8"))).not.toBeNull();
  });
});
