# Worktree diff / graph · 开发者要点

> 何时读：改动 `/api/worktree-diff/*`、`/api/worktree-graph`、`src/git/` 里的 graph/diff 参数、`WTDIFF_DRIVER_NAME_RE`、升级 git 版本之前（`docs/dev/worktree-graph/` 也读这一份）。
> 来源：AGENTS.md@fcbf71dc 的对应条目，原文搬运，未改写（仅路径按目录移动更新）。新的实现细节直接写在这里，不要再写回 AGENTS.md。
> 相关：`plan.md`、`acceptance.md`、`../worktree-graph/`、`../worktree-web/`

## Worktree diff

**Worktree diff (worktree-diff plan v3.1, D0–D6)**: per-file diff viewing for the session repo's
worktrees, riding the SAME `webHub.preview` gate (mode `on`/`loopback`; no separate setting) plus
a `/proc/self/fd` probe (Linux-only, fail-closed — no `wtdiff.v1` cap and no routes without it).
Two GET endpoints (`/api/worktree-diff/files`, `/api/worktree-diff/file`, both `X-PWH: 1`): the
hub runs git itself — pinned through THREE fds (worktree, gitdir, commondir; `-C
/proc/self/fd/3 --git-dir=/proc/self/fd/4 --work-tree=/proc/self/fd/3` + `GIT_COMMON_DIR=`,
membership-checked against a bounded `worktree list --porcelain`), with `envPolicy:"minimal"`
(PATH pinned to `/usr/bin:/bin`) and plumbing **`diff-index`** — never porcelain `diff`, which
2.53 measured to WRITE the index and fire `post-index-change` even under `--no-optional-locks`.
External-driver neutralization is three-layered (L1 `--attr-source=<empty tree>` kills committed/
working-tree `.gitattributes` sources; L2 unconditionally blanks every `filter.*`/`diff.*` driver
name found in config ∪ `$GIT_COMMON_DIR/info/attributes`, macros included; L3 post-hoc re-scan ⇒
503 `attr-changed` + discard) plus `--no-textconv --no-ext-diff`, `hooksPath=/dev/null`,
`--ignore-submodules=all`. Anti-arbitrary-history: `base` must equal THIS request's C0 HEAD
resolution (409 `base`), `(path, orig)` must be a requestable entry of the ≤5 s TTL single-flight
changeset (409 `entry`, zero oracle) — the residual exposure is exactly appendix A1 (a): LAN is
as wide as loopback, pinned to the current HEAD, changesets computed server-side per request,
denylist hits hidden everywhere (list, total, file asks — D14). **Driver-scan regex maintenance
rule**: `WTDIFF_DRIVER_NAME_RE` + the Cc `config --get-regexp` pattern enumerate the executable
config surface — when a NEW git version adds an executing config key family (R11), extend both
(and `driverNamesFromAttributes`' superset regex) in the same PR and re-run the H1 suite
(`tests/integration/{git-wtdiff,web-hub-worktree-diff}.test.ts`); new ASSET classes (things the
endpoint exposes) follow A1: LAN same-width, current-HEAD-pinned, server-computed, denylist-
blocked. Design: `docs/dev/worktree-diff/plan.md` (§9.3 revision log); real-device checklist:
`docs/dev/worktree-diff/acceptance.md`; endpoint integration: `tests/integration/web-hub-worktree-diff.test.ts`.

## Worktree graph

**Worktree graph**: `GET /api/worktree-graph` (`X-PWH: 1`), cap `wtgraph.v1`, shares wtdiff's
`webHub.preview` on/loopback gate + `/proc/self/fd` probe (Linux-only, fail-closed). The hub's
single runner serves both route frontends through membership + three-fd pins + minimal env;
frozen `src/git/graph.ts` `wtGraphArgs` (byte-pinned tests) runs Gr `for-each-ref` then Gl
`log --date-order` over validated explicit snapshot tips, with `--no-lazy-fetch`, no replace
objects, pager, hooks, signatures, mailmap or notes. The exec/read surface matrix in plan
§2.3 (plus the Gm column, merged-plan §4.1) covers transport/ssh/helpers, gpg, mailmap, replace/notes,
drivers/attributes/worktree reads, hooks/fsmonitor/pager, object/ref/index writes and the accepted
trace2 residual. Graph reads commit/tree/blob objects ONLY inside Gm (`rev-list --cherry-mark
--right-only <HEAD>...<tip> --`, patch-id judgement), under L1 (`--attr-source=<empty tree>`) + L2
(every `filter.*`/`diff.*` driver name blanked, `diff.external=`, fixed `core.bigFileThreshold=512m`)
plus per-tip and tail re-checks of `info/attributes`/shallow; it never reads the work tree or the
index, the Gm/patch-id verdict returns no file paths or patch contents (the payload's
`wtHeads[].path` worktree paths are a separate, already-broadcast asset) and collects no dedicated email fields (free text may contain
secrets; sole-user LAN exposure is accepted).
**Gm (merged-branch marks, #48)**: four frozen commands now — Gr / Gl / Gm / Cc (`wtGraphArgs.cherry`
/ `driverScan`, the latter delegating to wtdiff's). Cap `wtgraph.merged.v1`, same gate/condition as
`wtgraph.v1` (`preview:"loopback"` ⇒ no cap on LAN). The M phase runs only for `?merged=1` against a
route built with `mergedEnabled`; no `merged=1` ⇒ legacy path byte-identical. Upstream is pinned to
this request's HEAD (`merged.base`); ≤24 candidate branches (`omitted` beyond), same-tip dedup,
failures are always "unknown", never "merged". Accepted new assets: per-branch full-history counts
(`t`/`k`), patch-equivalence relations (possibly over denylisted paths), window `e` marks, `co`.
Results are single-flight cached (10 min TTL, `store` only after a passing re-check). **Budget ledger
with `merged=1`**: admission 8 s + git 14 s + M phase 14 s (head 6 / loop ≥4 / tail 4) + close 1 s =
37 s, +10 s transfer = 47 s ≤ 48 s client deadline (`WTGRAPH_MERGED_CLIENT_TIMEOUT_MS`); non-merged
requests keep 23 s / 35 s. Response ≤512 KiB (merged reserve 32 KiB; drop `e`, then `skipped:"bytes"`).
**R11-style upgrade gate**: when upgrading the git baseline, or changing ANY Gr/Gl/Gm/Cc argv —
(1) re-check `git help config` for new rev-list / patch-id / diff-machinery keys that execute
programs, trigger transport, write files or change patch-id results (cf. `core.bigFileThreshold`);
(2) update the matrix with paired unhardened/hardened tests; (3) re-run E4's 36-cell driver matrix
(each cell with a positive control — a control < 1 means the fixture is dead and must be fixed
first), E11 attribute consumption and E12 file-access tracing; (4) in the same PR run
`tests/integration/{git-graph,git-graph-cherry,web-hub-worktree-graph}.test.ts`. Graph CONSUMES but
never widens `WTDIFF_DRIVER_NAME_RE` / the Cc regex: extending them for wtdiff covers Gm; do not widen
them for graph alone. Budget ledger §2.4 (non-merged): admission 8s +
git 14s (four 2s steps + Gl 6s) + close 1s = 23s; transfer 10s fits the 35s client deadline;
response ≤512 KiB. The WorktreePanel's default-collapsed, lazy-loaded graph shows ≤200
commits, merge rows dimmed, full-oid worktree HEAD rings and ≤4 lanes at mobile width. With the
merged cap the UI folds branches judged fully patch-equivalent (`eq`, not checked out) by default;
a toggle ("show/hide N merged branches", not remembered — F3) restores them in the landed colour
with a "merged" / "merged k/t" badge (hidden at ≤480px); the toggle is not rendered when folding
is blocked (`fold off` footnote). Plan: `docs/dev/worktree-graph/merged-plan.md`.
Design: `docs/dev/worktree-graph/plan.md`; device checklist:
`docs/dev/worktree-graph/acceptance.md`.

## Worktree graph · commit files（`wtgraph.files.v1`）

**What**: clicking a commit row in the graph (or Enter/Space on the focused row) expands ONE
detail row listing that commit's changed files — status badge (M/A/D/R/T), `+add −del` (or `bin`),
left-ellipsized path (full path on `title`); loading spinner / error + retry / 「无文件变更」.
Cap `wtgraph.files.v1` (same preview + `/proc` gate as `wtgraph.v1`, LAN via `preview.lan.v1`);
without it rows stay inert and the graph DOM is byte-identical. Endpoint
`GET /api/worktree-graph/files?agentKey&sessionId&wt&h` (`X-PWH: 1`), a separate path + optional
`WorktreeGraphRoutes.handleFiles` (append-only; no PROTO bump). Code: `hub/worktree-graph/commit-files.ts`,
UI `composables/useCommitFiles.ts` + `components/graph/WorktreeGraph.vue`.

**Asset gate (A1)**: `h` must be a commit THIS routes instance served in a graph window for the
same pinned repository (common-dir dev:ino) within 30 min (`ServedCommitWindows`, ≤4000 oids × 64
repos) — checked after membership and BEFORE any git-phase spawn, else 409
`E_STALE_CTX{reason:"commit"}` (UI: 「刷新提交图」 re-pulls the graph, then the files fetch re-runs).
Denylist hits are hidden from entries AND `total` (D14), applied after the cache, per request.

**Gf (the only new git command)**: `log --no-walk --max-count=1 -z --format= --raw --numstat -M
-O/dev/null --diff-merges=first-parent --ignore-submodules=none --no-textconv --no-ext-diff <h> --`
with Gm's neutralization (L1 empty-tree `--attr-source` + `core.attributesFile=/dev/null`, L2 every
driver from Cc ∪ `info/attributes` blanked, `diff.external=`), `--no-lazy-fetch`,
`--no-replace-objects`, pinned `core.bigFileThreshold=512m` / `diff.renameLimit=1000` /
`log.showRoot=true`. **Why not `diff-tree`**: git 2.53's `diff-tree` reads the index and, via
`reuse_worktree_file`, opens work-tree files whose stat matches the index (strace-verified);
`log` loads no index, and `--ignore-submodules=none` avoids the `.gitmodules`/index lookup a
gitlink diff otherwise triggers — so Gf keeps the graph's "never reads the work tree or the
index" rule (single execve, no helper processes). The argv lives in `wtGraphFilesArgs`
(hub-local because this feature was scoped to `src/web-hub/**`; source-scan pins argv-only-via
that builder) — if it ever moves to `src/git/graph.ts`, follow the R11 upgrade gate above.

**Merge semantics (fixed)**: first parent — a merge lists only what it brought onto parent 1; a
root commit (and a shallow boundary commit, flagged `shallow:true`) diffs against the empty tree.

**Budgets / caps**: admission 8 s + git 10 s (Cc 2 s, info read, Gf 5 s, recheck) + close 1 s,
client deadline 30 s; Gf stdout ≤512 KiB (cut ⇒ `limits.output`, counts may be missing, list a
lower bound), ≤1000 entries (`limits.files`), body ≤256 KiB (tail dropped ⇒ `limits.bytes`).
Own rate bucket (20 tok / 250 ms) and in-flight caps (per principal 2, global 4). Post-Gf
`info/attributes` recheck: changed ⇒ 503 `E_BUSY{attr-changed}`, never stored. Cache: PARSED
entries (never raw stdout) per `(repo, oid, attribute signature)`, TTL 10 min, LRU 256, 4 MiB
total / 512 KiB per item. Audit: same `wtgraph` channel, `phase:"files"`, new count keys
`files` / `cached` (never paths or oids).

**UI lane alignment**: the detail row carries no `data-row`, so `measure()` keeps returning the
commit rows' own centers (SVG lines stretch across the inserted row); the lane cell's rowspan
grows by one; the pitch (lane gap, dot radius) comes from the first adjacent pair that does not
straddle the open row; the measurement also re-runs on open/switch (the tbody size may not change
when switching between equally tall detail rows). Pinned at 100/200/300 % in
`tests/web-hub/ui/graph-commit-files.test.ts`.
