/**
 * worktree-diff plan #1/I15 (D3, H3's HEAD-binding half): the request-binding hard gate.
 *
 * HEAD's single read point is THIS request's C0 on the pinned chain — never a cached value:
 * - a cached changeset under oid=X while this request's C0=Y ⇒ cache MISS ⇒ recompute;
 * - `file` with base=X while C0=Y ⇒ 409 base and C4 never executes;
 * - C2's `# branch.oid` ≠ this C0 ⇒ 409 base (HEAD moved INSIDE the request window);
 * - C4's argv oid is ALWAYS this request's C0 (constructor-call record assertion);
 * - the v3.1 commondir shape: C0 succeeds but C2 exits nonzero ⇒ 500 git-failed, never data.
 */

import { describe, expect, it } from "vitest";

import { denyCtxOf } from "../../../../src/web-hub/hub/preview/admit.js";
import { createWorktreeDiffRoutes } from "../../../../src/web-hub/hub/worktree-diff/routes.js";
import { parseWtDiffFileList, type WtDiffFileList } from "../../../../src/web-hub/protocol/worktree-diff.js";
import {
  AGENT,
  HEAD_SHA1,
  LINKED,
  LINKED_GITDIR,
  REPO,
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
} from "./helpers.js";

const DENY = denyCtxOf("/home/tester", "/home/tester/.pi/agent");
const OTHER_SHA1 = "fedcba9876543210fedcba9876543210fedcba98";

function kit() {
  const fx = repoFixture();
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
  const q = { agentKey: AGENT, sessionId: SESSION, wt: LINKED };
  const files = () => routes.handleFiles(fakeReq({ "x-pwh": "1" }), fakeRes(), new URLSearchParams(q), io);
  const file = (base: string, path: string, orig?: string) =>
    routes.handleFile(
      fakeReq({ "x-pwh": "1" }),
      fakeRes(),
      new URLSearchParams(orig === undefined ? { ...q, base, path } : { ...q, base, path, orig }),
      io,
    );
  const c2Calls = () => fx.runner.calls.filter((c) => isCmd(c.argv, "C2"));
  return { fx, routes, io, log, files, file, c2Calls };
}

const recM = (path: string): string => `1 .M N... 100644 100644 100644 h1 h2 ${path}`;

describe("head-binding #1/I15 (D3)", () => {
  it("a cached changeset under oid=X is NOT served when this request's C0=Y — the key recompute runs a fresh C2", async () => {
    const k = kit();
    // first request: HEAD = X, cached under X
    k.fx.scriptAdmission({ head: OTHER_SHA1 });
    k.fx.runner.push(okRun(""), okRun(statusV2Z(OTHER_SHA1, [recM("a.txt")])), okRun(""), okRun(""));
    await k.files();
    expect(k.io.sent[0]!.status).toBe(200);
    expect((k.io.sent[0]!.body as WtDiffFileList).base).toBe(OTHER_SHA1);
    expect(k.c2Calls()).toHaveLength(1);

    // second request IMMEDIATELY (well inside the 5s TTL) but HEAD moved to Y:
    // the cache key carries the REQUEST's C0 ⇒ miss ⇒ a second C2 runs and its oid is Y
    k.fx.scriptAdmission({ head: HEAD_SHA1 });
    k.fx.runner.push(okRun(""), okRun(statusV2Z(HEAD_SHA1, [recM("b.txt")])), okRun(""), okRun(""));
    k.io.sent.length = 0;
    await k.files();
    expect(k.io.sent[0]!.status).toBe(200);
    const second = k.io.sent[0]!.body as WtDiffFileList;
    expect(second.base).toBe(HEAD_SHA1);
    expect(second.entries[0]!.path).toBe("b.txt");
    expect(k.c2Calls()).toHaveLength(2);
  });

  it("file: base=X (valid hex) while this C0=Y ⇒ 409 base, C4 never executed", async () => {
    const k = kit();
    k.fx.scriptAdmission({ head: HEAD_SHA1 });
    k.fx.runner.push(okRun(""), okRun(statusV2Z(HEAD_SHA1, [recM("a.txt")])), okRun("MUST NOT RUN"), okRun(""));
    await k.file(OTHER_SHA1, "a.txt");
    expect(k.io.sent[0]).toMatchObject({ status: 409, body: { error: "E_STALE_CTX", reason: "base" } });
    expect(k.fx.runner.argvLog().some((a) => a.includes("diff-index -p"))).toBe(false);
  });

  it("C2 reports `# branch.oid` ≠ this C0 ⇒ 409 base (HEAD moved inside this request's window)", async () => {
    const k = kit();
    k.fx.scriptAdmission({ head: HEAD_SHA1 });
    k.fx.runner.push(okRun(""), okRun(statusV2Z(OTHER_SHA1, [recM("a.txt")])), okRun(""), okRun(""));
    await k.files();
    expect(k.io.sent[0]).toMatchObject({ status: 409, body: { error: "E_STALE_CTX", reason: "base" } });
  });

  it("C4's argv oid is ALWAYS this request's C0 — across two different HEADs", async () => {
    for (const head of [HEAD_SHA1, OTHER_SHA1]) {
      const k = kit();
      k.fx.scriptAdmission({ head });
      k.fx.runner.push(okRun(""), okRun(statusV2Z(head, [recM("a.txt")])), okRun("@@"), okRun(""));
      await k.file(head, "a.txt");
      expect(k.io.sent[0]!.status).toBe(200);
      const c4 = k.fx.runner.calls.find((c) => isCmd(c.argv, "C4"))!;
      // the oid slot: the argument just before the `--` pathspec terminator
      const dash = c4.argv.indexOf("--");
      expect(c4.argv[dash - 1]).toBe(head);
      expect(c4.argv).toContain(head);
    }
  });

  it("an index-stat change invalidates the cache even when the oid is identical (§1.10 key)", async () => {
    const k = kit();
    k.fx.scriptAdmission();
    k.fx.runner.push(okRun(""), okRun(statusV2Z(HEAD_SHA1, [recM("a.txt")])), okRun(""), okRun(""));
    await k.files();
    expect(k.c2Calls()).toHaveLength(1);
    // the agent touched the index between the two requests (same HEAD, well inside the TTL)
    k.fx.fs.writeFile(`${LINKED_GITDIR}/index`, Buffer.from([7, 7, 7])).ctimeMs = 2_000;
    k.fx.scriptAdmission();
    k.fx.runner.push(okRun(""), okRun(statusV2Z(HEAD_SHA1, [recM("a.txt")])), okRun(""), okRun(""));
    k.io.sent.length = 0;
    await k.files();
    expect(k.io.sent[0]!.status).toBe(200);
    expect(k.c2Calls()).toHaveLength(2); // recomputed — the key carries the index stat
  });

  it("v3.1 commondir shape: C0 succeeds, C2 exits nonzero ⇒ 500 git-failed — the failure output is NEVER served as list data", async () => {
    const k = kit();
    k.fx.scriptAdmission();
    k.fx.runner.push(okRun(""), {
      ...okRun("# branch.oid redirection-garbage"),
      code: 128,
      stderr: "fatal: bad object",
    });
    await k.files();
    expect(k.io.sent[0]).toMatchObject({ status: 500, body: { error: "E_INTERNAL" } });
    expect(parseWtDiffFileList(k.io.sent[0]!.body, 64)).toBeNull(); // never list-shaped data
    const warn = k.log.lines.find((l) => l.msg === "wtdiff git failed");
    expect(warn?.data).toMatchObject({ cmd: "C2", exit: 128 });
  });
});
