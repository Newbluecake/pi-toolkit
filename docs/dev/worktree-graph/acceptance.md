# Worktree Graph: Real-Device Acceptance

Checklist for [plan v2, section 8](./plan.md). Automated service coverage lives in
`tests/integration/{git-graph,web-hub-worktree-graph}.test.ts`; this checklist covers the
actual browser, CSP, touch, accessibility and deployment. Record pass/fail/not exercised
with evidence. This document is a procedure, not a claim that device acceptance has run.

## Setup And Access Gate

1. Use Linux with `/proc/self/fd`, Node >=22 and git in `/usr/bin:/bin` supporting
   `--no-lazy-fetch` (introduced in git 2.45; fixtures were measured on 2.53). Install
   pi-toolkit through `pi install`, not only the parent's `-e` flag. Start pi inside a
   disposable repository with branches, merges, tags and a linked/detached worktree.
2. Build this checkout with `timeout 600 npm run build:web`. Set `webHub.enabled:true`
   and `webHub.preview:"on"` in the toolkit settings. In pi, execute `/reload`, then
   `/webhub restart`, then `/webhub open`. Refresh old browser tabs so both the UI and
   hub are current. Use `/webhub status` to record version, pid and verified UI status.
3. For LAN, enable the existing `webHub.lan` settings, configure `/webhub passwd`, reload
   and restart again, then sign in from a phone using the password-authenticated LAN URL.
   Do not expose a token URL or change the host allow-list merely to bypass a failure.
4. With preview `"on"`, loopback and LAN both advertise `wtgraph.v1` and serve authenticated
   `GET /api/worktree-graph` requests with `X-PWH: 1`. Set preview `"loopback"`, run
   `/reload` + `/webhub restart` and refresh both clients: loopback still has the graph;
   LAN has neither its entry nor its cap, and a direct endpoint ask returns 404, just as
   when disabled. With `"off"`, neither listener has the graph. Restore `"on"` afterward.
5. Keep DevTools Network (disable cache) and Console open. Hub audit is in
   `~/.pi/agent/web-hub/logs/hub.log`. Graph log fields contain counts, codes and HMAC
   tags, never subjects/authors/ref names/oids/worktree paths; the JSON log envelope
   adds only `t`, `level`, `pid`, `msg`, `audit` around `WTGRAPH_AUDIT_KEYS`.

LAN exposure is deliberately the same as loopback under `"on"`: commit subjects, author
names/times, hashes, local/remote/tag names and worktree paths. No dedicated email field
or file body is collected; free text may still contain emails, paths or secrets. This
is the accepted sole-LAN-user boundary, not a secret-scrubbing guarantee.

## K1: Entry, Date Order And CSP

- Open the agent detail header, then expand the worktree panel. Expect `graph · 200`
  collapsed and no `/api/worktree-graph` request. Expand it once: exactly one request,
  a lazy `assets/WorktreeGraph-*.js` load under the real hub CSP, then the graph. Record
  Network and Console evidence; there must be no CSP violation or unhandled exception.
- Freeze repository changes while comparing. Resolve local branches, remote-tracking
  branches, tags peeled to commits, the selected worktree HEAD and detached worktree
  HEADs to full oids. Exclude stash/notes and tags to non-commit objects. Use those same
  explicit snapshot tips, not `--all` or a moving `HEAD`, in the comparison:

  ```sh
  git --no-lazy-fetch --no-replace-objects --no-pager log \
    --no-show-signature --no-use-mailmap --no-notes \
    --graph --date-order -n 200 <tip-oid> <peeled-tag-oid> <detached-head-oid> --
  ```

- Compare full `commits[].h` order, parents and subjects in Network against git;
  visible short hashes must match and parents in the displayed set must follow children.
  If refs changed between observations, repeat with a stable snapshot rather than
  accepting a mismatch. All graph git argv comes from `src/git/graph.ts` `wtGraphArgs`.
- Collapse and reopen: requests are on demand. Refresh/remount the detail page: expansion
  is not remembered. An unborn repository shows the complete empty state; a shallow
  clone shows a shallow-boundary note, not fabricated parent lanes.

## K2: Lazy-Chunk Failure And Retry

1. Start with a fresh page where the graph chunk has never loaded. DevTools Network
   request blocking: block `*WorktreeGraph-*.js`, then expand the graph.
2. Expect the chunk-load error state with a retry button, not a blank panel or an
   unhandled error. Record the failed chunk request and visible error.
3. Unblock the URL and press the displayed Retry button without reloading the page.
   Expect the chunk to load and the graph to appear. A fresh page is required to repeat
   this test because a successfully loaded module is already cached in memory.

## K3: Ref Chips, Merge Rows And Worktree Rings

- In a disposable repo, make `master` (or `main`) and `origin/master` point at the same
  oid; expect the combined `master | origin` chip. Move the remote-tracking ref to a
  different existing commit with `git update-ref`; expect separate chips after the
  worktree status refresh/debounced graph refresh, or collapse/reopen to request again.
  This setup changes a local tracking ref only; the graph never fetches.
- Include `origin/HEAD` as a symref, an annotated tag and a lightweight tag. Inspect
  their chip targets against `git rev-parse <ref>^{commit}`. Merge rows are dimmed with
  hollow dots; the current full-oid HEAD row is highlighted and ringed.
- Create a `pi-agent-*` linked worktree and a detached worktree with a commit made only
  there. Match the dashed ring/badge against `git worktree list --porcelain` full HEAD
  oids and absolute paths, not the status panel's 7-character hashes. Chips beyond the
  visible cap use `+n` with full names in the title. Record a desktop screenshot.

## K4: Scaling, Touch And Mobile Width

- At the application's 100%, 200% and 300% font settings, inspect first/middle/last rows
  with long ref names and subjects. SVG point centers must align with text row centers,
  without adjacent-row overlap. Press a hash cell and check the clipboard contains its
  full oid, with an accessible copy announcement.
- On a real coarse-pointer phone, also test 390 x 844 and a viewport at or below 480px.
  Expect only lanes (at most four), subject with the HEAD chip when applicable, and
  short hash; date/author columns are absent and there is no horizontal overflow.
  Hidden lanes have folded markers/stubs, never a false connecting vertical lane.
- Repeat scaling on the phone. Hash targets must remain usable (coarse row minimum
  32px), graph width stable, and long text clipped without covering controls. Keep
  screenshots for each font setting and the mobile viewport.

## K5: Independent Scrolling

Open both the worktree list and graph on desktop and phone, using enough commits to
overflow the graph viewport. Scroll inside the graph, then scroll the transcript and
page. Expect a bounded graph viewport, a transcript still visible/usable (at least
20vh), and no frozen page, scroll trap or horizontal overflow. Capture viewport and
transcript dimensions along with a short touch-scroll recording.

## K6: Themes And Assistive Technology

Test explicit light, system dark (no explicit theme override), and explicit dark
(`.theme-dark`). Lane colors and chip text remain distinguishable in all three.
Use keyboard Tab/Enter/Space for graph expansion, Retry and hash copying. With a screen
reader, traverse a merge row, current row, another worktree HEAD and a folded-lane row:
expect parent hashes, current-checkout status, worktree label, folded-lane status and
out-of-window parents to be announced without relying on SVG. Record the browser,
screen reader and screenshots; automated token-contrast checks complement this test.

## K7: Date-Order Deadline

Use a disposable large repository whose date-order walk without a commit-graph really
exceeds Gl's 6s cap; do not remove the commit-graph from a user's working repository.
Expand the graph: expect HTTP 504 `E_DEADLINE` with `reason:"log-timeout"`, the
date-order timeout explanation and `git commit-graph write` advice, plus Retry. There
is no default-order fallback. Run `timeout 600 git commit-graph write --reachable`
in that test repo and press Retry; expect the date-order graph to succeed. Record both
responses and timings. A fast repository is **not exercised**, not a timeout-test pass.
The server ledger is 8s admission + 14s git (four 2s steps + Gl 6s) + 1s close; with
10s transfer reserve this fits the 35s client budget (plan section 2.4).

## K8: No Lazy Fetch, Gpg Or Writes

Create the following fixture only in a new temporary directory. Its ssh URL is never
used by the hardened endpoint; the absolute marker script exits before any real ssh.
Do not run a normal object-resolving git command after deleting the target, since that
could exercise the _unhardened_ CLI's lazy fetch and contaminate the marker observation.

```sh
fixture=$(mktemp -d /tmp/pwh-wg-accept-XXXXXX)
git -C "$fixture" init -q -b main
git -C "$fixture" config user.name 'Graph acceptance'
git -C "$fixture" config user.email graph@example.invalid
git -C "$fixture" -c commit.gpgSign=false commit -q --allow-empty -m base
target=$(git -C "$fixture" rev-parse HEAD)
git -C "$fixture" -c tag.gpgSign=false tag -a missing-target -m tag "$target"
git -C "$fixture" -c commit.gpgSign=false commit -q --allow-empty -m tip
printf '#!/bin/sh\nprintf "x\\n" >> "%s/ssh-marker"\nexit 1\n' "$fixture" > "$fixture/ssh.sh"
chmod 700 "$fixture/ssh.sh"
git -C "$fixture" config core.repositoryformatversion 1
git -C "$fixture" config extensions.partialClone origin
git -C "$fixture" config remote.origin.promisor true
git -C "$fixture" config remote.origin.url ssh://example.invalid/x
git -C "$fixture" config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git -C "$fixture" config core.sshCommand "$fixture/ssh.sh"
rm -- "$fixture/.git/objects/${target%${target#??}}/${target#??}"
```

- Start a test pi session in this fixture, open its detail/worktree graph, and expect
  503 `E_WTDIFF_UNSUPPORTED` / `missing-object` plus the partial-clone explanation.
  `$fixture/ssh-marker` must not exist. Attach `strace -f -e execve -p <hub-pid>` before
  expanding: no ssh/transport helper executes. Record the response, marker absence and
  trace. The paired automated endpoint control removes only `--no-lazy-fetch`, proves
  this fixture actually invokes the marker, then verifies hardened marker=0.
- For signature checks use a separate disposable repo containing a signed commit
  (a real signature or the fake `gpgsig` fixture in `tests/integration/git-graph.test.ts`).
  Configure `log.showSignature=true` and an absolute `gpg.program` marker script.
  Expand the graph: it loads without invoking gpg; marker remains absent. A repo with
  **no signed commit** is not a meaningful gpg test. Use the same execve trace technique.
- Before/after endpoint calls compare `.git/objects` file inventory, loose-ref contents,
  packed-ref/index size and mtime. Expect no mutation on success or missing-object.
  Copy a graph request and change `wt` to a plain directory or another repo: expect
  403 `E_WTDIFF_DENIED` / `not-worktree`. Close/restart hub during an in-flight request:
  it must settle without hanging, and repo pins/git children must be gone afterward.
  No path, oid, author, ref name or subject appears in `wtgraph` audit fields.

## K9: Bundle Budget

Run `timeout 600 npm run build:web` and `timeout 300 npm run check:web`. Record main
chunk gzip, `assets/WorktreeGraph-*.js` gzip and total JS gzip; compare a matching
pre-P5 build in a separate checkout, not a mixed concurrent-package tree. Check that
layout code stays lazy and total JS/CSS remain under `check-ui-dist.ts` budgets.

Original plan section 8 K9 requires main growth <=1.5 KB gz. **Recorded P5 exception**:
`scripts/web-hub/check-ui-dist.ts` documents the main-session ruling on 2026-10-10:
216,146 -> 218,760 B gz, **+2,614 B**, about 1,334 B eager en/zh dictionaries + 1,280 B
panel wiring. This exceeds the original K9 limit, explicitly accepted, not a pass
against that limit. Its later mixed-tree measurement is main 219,241 B, lazy 6,840 B,
total 248,175 B under the 245 KiB total budget. Re-measure current artifacts and report
the exception separately; do not claim those mixed-tree numbers isolate P5's delta.

## Results

| Check                     | Pass / Fail / Not Exercised | Evidence / Exception                                        |
| ------------------------- | --------------------------- | ----------------------------------------------------------- |
| Gate: on / loopback / off |                             |                                                             |
| K1                        |                             |                                                             |
| K2                        |                             |                                                             |
| K3                        |                             |                                                             |
| K4                        |                             |                                                             |
| K5                        |                             |                                                             |
| K6                        |                             |                                                             |
| K7                        |                             |                                                             |
| K8                        |                             |                                                             |
| K9                        |                             | Original main delta exceeded; P5 exception documented above |

Record tester/date, toolkit commit, git version, browser/OS, device/viewport and all
settings changes. Restore the original preview/LAN settings with `/reload` +
`/webhub restart`, close disposable sessions and remove only their recorded temporary
directories after testing.
