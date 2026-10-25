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
§2.3 covers transport/ssh/helpers, gpg, mailmap, replace/notes, drivers/attributes/worktree
reads, hooks/fsmonitor/pager, object/ref/index writes and the accepted trace2 residual;
graph never reads file contents or collects dedicated email fields (free text may contain
secrets; sole-user LAN exposure is accepted). **R11-style upgrade gate**: new git versions
adding executing config/argv behaviour, or any Gr/Gl argv change, require re-checking argv
and `git help config`, updating the matrix with paired unhardened/hardened tests, and running
`tests/integration/{git-graph,web-hub-worktree-graph}.test.ts` in the same PR; do NOT widen
`WTDIFF_DRIVER_NAME_RE` or the Cc driver regex for graph. Budget ledger §2.4: admission 8s +
git 14s (four 2s steps + Gl 6s) + close 1s = 23s; transfer 10s fits the 35s client deadline;
response ≤512 KiB. The WorktreePanel's default-collapsed, lazy-loaded graph shows ≤200
commits, merge rows dimmed, full-oid worktree HEAD rings and ≤4 lanes at mobile width.
Design: `docs/dev/worktree-graph/plan.md`; device checklist:
`docs/dev/worktree-graph/acceptance.md`.
