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
