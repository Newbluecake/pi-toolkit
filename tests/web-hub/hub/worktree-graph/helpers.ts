/**
 * worktree-graph plan v2 §2.6/§5 (P2) shared test harness. Reuses the worktree-diff D3 harness
 * (`../worktree-diff/helpers.js`) for the scripted git runner, the in-memory `PreviewFs`, the
 * standard repo fixture and the route-level fakes (io/req/res/registry) — those are NOT
 * reimplemented here, only graph-specific pieces: Gr/Gl stdout builders (the raw `%00`/`\x1f`
 * wire shapes `src/git/graph.ts` parses) and an admission script that pushes exactly the two
 * membership commands (`C1a`/`C1`) graph routes actually consume — NEVER wtdiff's own `C0`
 * (worktree-graph's routes never run a HEAD-resolution command at all, §2.2: "HEAD 取自
 * membership 的 porcelain 自身行").
 */

export {
  AGENT,
  HEAD_SHA1,
  LINKED,
  LINKED_GITDIR,
  REPO,
  REPO_GIT,
  SESSION,
  createFakeFs,
  fakeIo,
  fakeRegistry,
  fakeReq,
  fakeRes,
  memLog,
  okRun,
  query,
  repoFixture,
  scriptedRunner,
  type FakeFs,
  type RepoFixture,
  type Scripted,
  type ScriptedRunner,
} from "../worktree-diff/helpers.js";

import { okRun, type RepoFixture } from "../worktree-diff/helpers.js";

/** Push exactly C1a + C1 (the two membership commands `createMembership` runs) — no C0. Mirrors
 * `RepoFixture.scriptAdmission` without its trailing C0 push, since worktree-graph routes never
 * run one. */
export function scriptGraphAdmission(fx: RepoFixture, opts: { commonDir?: string; list?: string } = {}): void {
  fx.runner.push(
    okRun((opts.commonDir ?? "/w/repo/.git") + "\n"), // C1a
    okRun(opts.list ?? fx.porcelain), // C1
  );
}

// ---------------------------------------------------------------------------
// Gr (for-each-ref) wire builders — src/git/graph.ts's `parseForEachRefZ`
// ---------------------------------------------------------------------------

export interface GrRowInput {
  type: "commit" | "tag" | "tree" | "blob" | "";
  oid: string;
  derefType?: "commit" | "tag" | "tree" | "blob" | "";
  derefOid?: string;
  refname: string;
  upstream?: string;
  symref?: string;
}

/** One `for-each-ref --format=%(objecttype)%00%(objectname)%00%(*objecttype)%00%(*objectname)
 * %00%(refname)%00%(upstream:short)%00%(symref)` line (NUL-field, newline-record). */
export function grRow(r: GrRowInput): string {
  return [r.type, r.oid, r.derefType ?? "", r.derefOid ?? "", r.refname, r.upstream ?? "", r.symref ?? ""].join("\0");
}

/** Full Gr stdout: one `grRow` per line, trailing newline (git always terminates the last
 * record too — `parseForEachRefZ`'s non-capped path drops exactly one trailing empty split). */
export function grStdout(rows: readonly GrRowInput[]): string {
  return rows.map((r) => grRow(r)).join("\n") + (rows.length > 0 ? "\n" : "");
}

// ---------------------------------------------------------------------------
// Gl (log -z) wire builders — src/git/graph.ts's `parseGraphLogZ`
// ---------------------------------------------------------------------------

export interface GlRecordInput {
  h: string;
  p?: readonly string[];
  an?: string;
  at?: number;
  s?: string;
}

/** One `log -z --format=%H%x1f%P%x1f%an%x1f%at%x1f%s` record (NUL-terminated, `\x1f` fields). */
export function glRecord(r: GlRecordInput): string {
  return [r.h, (r.p ?? []).join(" "), r.an ?? "author", String(r.at ?? 1_000), r.s ?? "subject"].join("\x1f");
}

/** Full Gl stdout: one `glRecord` per NUL-terminated record. */
export function glStdout(records: readonly GlRecordInput[]): string {
  return records.map((r) => `${glRecord(r)}\0`).join("");
}

/** A commit chain of `n` commits, newest (index 0) first, each parenting the next — handy for
 * `more`/windowing/trim tests. hashes are deterministic 40-hex. */
export function commitChain(n: number, startAt = 2_000_000): GlRecordInput[] {
  const hashOf = (i: number): string => i.toString(16).padStart(40, "0");
  const out: GlRecordInput[] = [];
  for (let i = 0; i < n; i++) {
    const parents = i + 1 < n ? [hashOf(i + 1)] : [];
    out.push({ h: hashOf(i), p: parents, an: `author${i}`, at: startAt - i, s: `commit ${i}` });
  }
  return out;
}
