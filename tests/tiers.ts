/**
 * Tier partition manifest — the single source of truth for the vitest workspace projects
 * (`vitest.workspace.ts`: tier1 / tier2 / secure). #27 P1; docs/dev/test-speed/plan.md r3 §1 D1–D4a.
 *
 * Invariants:
 * - Pure data + pure functions. No pi imports, no I/O, no module-scope mutable state (I4).
 * - Partitioning is EXPLICIT: only the lists below (plus TIER2_DIRS prefixes) decide a file's
 *   project. Never infer from class names or markers (r1 review #2: the `RealHarness` in
 *   tests/web-hub/agent/commands-hold.test.ts is not a real-mount harness).
 * - scanTier1Markers exists only to FORCE registration (D4): a tier1 file hitting any marker
 *   must appear in TIER1_DECLARED, or be moved to TIER2_FILES / SECURE_MOUNT_FILES. The markers
 *   are lexical and deliberately over-approximate; they cannot catch sleeps hidden behind
 *   helpers, indirect spawns, or slow real I/O — new tests still get a human tier review (D4a
 *   residual, plan r3-2).
 * - kind "timing" = tier1 file with real latency/performance measurements or ≥1 s waits: its failures are TRIAGED like Tier 2
 *   (rerun; green on rerun ⇒ flake) but never bypass a failing release gate (plan §6).
 * - kind "false-positive" = the mount marker matched, but no real gocryptfs mount happens
 *   (fake gocryptfs binaries, string literals). The D4 gate REQUIRES this kind for any
 *   tier1 file whose mount marker hits.
 *
 * The secure project's preflight setupFiles/globalSetup are appended by P2
 * (tests/setup/secure-preflight.*); P1 ships the project with the base setup only.
 */

export type ProjectName = "tier1" | "tier2" | "secure";

/** Base include patterns — identical to the pre-workspace root config (vitest.config.ts). */
export const BASE_TEST_INCLUDE: readonly string[] = ["tests/**/*.test.ts", "tests/**/*.test-d.ts"];

/**
 * Directories whose every test file is Tier 2 (real child processes / real sockets /
 * self-gating conformance suites). Trailing slash on purpose: projectOf matches prefixes.
 */
// #65: memory-web-command-confirm.test.ts + memory-web-command-dispatch.test.ts
// are deliberately covered by these prefixes (real SDK / >5s settled barrier).
// The opt-in real-browser probe lives in scripts/, never the daily test project.
// Schedule interval P1: schedule-secure-activate and schedule-interval-lock are integration/
// (actual activate / real kernel lock), hence covered by this prefix, never the secure mount project.
// Terminal r4: web-hub-terminal-{ingress,old-hub,quarantine,http,journal,pty,wiring,local}.test.ts
// are explicitly owned by this integration/ prefix (real sockets/durable IO/PTY).
// Local authority/receipt tamper/deadline tests and the separate-process terminal-agent
// fixture are real IO/process coverage, not tier1 mocks or secure-mount skips.
// Agent terminal-{owner,owner-factory,connection,environment,wiring} and UI controller/
// authority tests use isolated fake backend/socket/clock ports, hence remain tier1;
// their subprocess/physical counterparts must stay here, never secure-mount-skipped.
export const TIER2_DIRS: readonly string[] = ["tests/integration/", "tests/conformance/"];

/** Tier 2 files outside TIER2_DIRS (plan D2): real private lock / plain child processes /
 * build-artifact-dependent suites. Not real-mount — those are SECURE_MOUNT_FILES. */
export const TIER2_FILES: readonly string[] = [
  // Retained exited lifecycle: real hub assembly/store, sockets and fake-pi child processes.
  "tests/integration/web-hub-exited-discoverable.test.ts",
  // #70 credential-safe persistence tests use the real settings flock, no real vault.
  "tests/config/feishu-notify-settings.test.ts",
  // Interval P1: these drivers use the real single-file writer/flock through fixtures (hidden
  // from lexical proc scanning). Pure raw timer arithmetic remains tier1; contention/activate
  // end-to-end tests are already covered by the integration/ prefix above.
  "tests/schedule/core/every.test.ts",
  "tests/schedule/agent/every-clock.test.ts",
  "tests/schedule/agent/every-consumers.test.ts",
  // Root WebHub activation attempts a real Unix socket connection via its wiring.
  "tests/web-hub/agent/memory-lifecycle-wiring.test.ts",
  // private lock file only — no mount (keeps its fast unit behaviour out of tier1)
  "tests/secure/gocryptfs-test-lock.test.ts",
  // plain child processes, no gocryptfs mount
  "tests/secure/private-real-harness.test.ts",
  // owned executable markers only: PATH binding/bridge checks, no real init or mount
  "tests/secure/real-tool-path.test.ts",
  // real tsx/loader child processes ×matrix, needs dist/bundle (147 s)
  "tests/governance/bundle-parity.test.ts",
  // actually runs scripts/release/package.sh (36 s)
  "tests/release/package-zip.test.ts",
  // #25 B4: needs a real `mkfifo` child process (skips when unavailable)
  "tests/reflex/drafts/load-fifo.test.ts",
];

/** The 18 files with REAL gocryptfs mount blocks (plan D2a: each was read; judged by content,
 * not name) → the dedicated `secure` project, so P2 can hang the preflight setup on it. */
export const SECURE_MOUNT_FILES: readonly string[] = [
  "tests/secure/memory-gate.test.ts",
  "tests/secure/archive.test.ts",
  "tests/secure/convert-state.test.ts",
  "tests/secure/helper-v0-api.test.ts",
  "tests/secure/init-cleanup-real.test.ts",
  "tests/secure/launcher-convert.test.ts",
  "tests/secure/launcher-fuse.test.ts",
  "tests/secure/launcher-off-golden.test.ts",
  "tests/secure/launcher-private-cmd.test.ts",
  "tests/secure/launcher-private-unit.test.ts",
  "tests/secure/launcher-private.test.ts",
  "tests/secure/launcher-symlink.test.ts",
  "tests/secure/launcher-v6-wiring.test.ts",
  "tests/conformance/secure-convert.test.ts",
  "tests/conformance/secure-convert-xc2.test.ts",
  "tests/conformance/secure-convert-xc89.test.ts",
  "tests/conformance/secure-gocryptfs.test.ts",
  "tests/conformance/secure-private-ns.test.ts",
];

export type Tier1Kind = "proc" | "timing" | "false-positive";

export interface Tier1DeclaredEntry {
  /** proc = real child processes / sockets · timing = real latency/performance measurements or ≥1 s waits (Tier 2 triage on
   *  failure) · false-positive = mount marker matched but no real mount. */
  kind: Tier1Kind;
  /** Which D4 markers hit (evidence; over-approximate by design). */
  why: string;
}

/**
 * D4a baseline (mechanically generated from the pre-change 1760-file `vitest list`, then
 * hand-reviewed): every tier1 file that hits at least one D4 marker. Kind policy after the
 * manual review: mount ⇒ false-positive (required by the gate); any proc ⇒ proc; sock-only ⇒
 * proc; wait-only ⇒ timing (10 files at e4531250). Explicit latency declarations below
 * take precedence over that lexical baseline. Entries whose file disappears fail the
 * "registered but missing" check and are removed — the table converges on deletion.
 */
export const TIER1_DECLARED: Readonly<Record<string, Tier1DeclaredEntry>> = {
  "tests/web-hub/agent/connection.perf.test.ts": {
    kind: "timing",
    why: "real paused Unix socket: send p99 <5ms; final admission <50ms (original CPU gates)",
  },
  "tests/web-hub/hub/spawn/stderr-sink.perf.test.ts": {
    kind: "timing",
    why: "CPU: 100k x 10-byte pushes <200ms with parked disk (original push O(1) sentinel)",
  },
  "tests/web-hub/ui/logic-preview.perf.test.ts": {
    kind: "timing",
    why: "CPU: original 5s whole input x scope matrix hang sentinel; charScans hard gates stay in logic-preview.test.ts",
  },

  // #47c: real latency/performance gates are scheduler-sensitive even without a literal
  // ≥1s sleep/proc marker. Keep the assertions (no threshold inflation), but triage
  // failures as Tier 2. Pure FakeClock/vi fake-timer suites stay hard gates. Mixed
  // CPU + fake-budget files (e.g. graph/budget) retain timing at FILE granularity;
  // every deterministic assertion still executes and a failure still stops the gate.
  "tests/bash/process.test.ts": { kind: "timing", why: "real child pipe exit/drain/exit-wake: <1s / <3s / <500ms" },
  "tests/context-switch/boundary.test.ts": { kind: "timing", why: "CPU: replay a 5k-entry branch <2s" },
  "tests/git/graph.test.ts": {
    kind: "timing",
    why: "CPU: refs/log parse median-of-5 ≤50ms; large-ref worst-of-5 ≤200ms",
  },
  "tests/memory/jev/predict/clauses.test.ts": {
    kind: "timing",
    why: "CPU: 10k-codepoint regex adversary <50ms (no catastrophic backtracking)",
  },
  "tests/memory/jev/proxy-fetch.test.ts": {
    kind: "timing",
    why: "real loopback HTTP upstream never responds: request deadline <2s",
  },
  "tests/reflex/core/perf.test.ts": { kind: "timing", why: "CPU: evaluateGate+match p99 ≤5ms over 10k inputs" },
  "tests/reflex/drafts/perf.test.ts": { kind: "timing", why: "CPU: 16 full drafts over 10k inputs, p99 ≤5ms" },
  "tests/web-hub/agent/worktree-sampler.test.ts": {
    kind: "timing",
    why: "real SIGTERM-ignoring git process: deadline/reap <500+250ms",
  },
  "tests/web-hub/http/lan-cmd.test.ts": {
    kind: "timing",
    why: "real HTTP handler: hung touchSession <6s; slow reauth <2s",
  },
  "tests/web-hub/http/preview-e2e.test.ts": {
    kind: "timing",
    why: "real HTTP slow client: hub close and incomplete body <10s",
  },
  "tests/web-hub/hub/feishu/render.test.ts": { kind: "timing", why: "CPU: malformed link syntax scan <1500ms" },
  "tests/web-hub/hub/history.perf.test.ts": {
    kind: "timing",
    why: "real ~44MB archive: snapshot <1s, event-loop gap <100ms, page <500ms",
  },
  "tests/web-hub/hub/proxy/service.test.ts": {
    kind: "timing",
    why: "real proxy service disposal with active work <2s",
  },
  "tests/web-hub/hub/run-file-reader.perf.test.ts": {
    kind: "timing",
    why: "real large-log tail streaming: <2s / <500ms CPU+disk sentinels",
  },
  "tests/web-hub/hub/worktree-graph/budget.test.ts": {
    kind: "timing",
    why: "CPU: full near-cap Gr→Gl projection median-of-5 ≤50ms (incl real-cap ref trimming); injected slow tail step <1500ms",
  },
  "tests/web-hub/ui/logic-markdown-perf.test.ts": {
    kind: "timing",
    why: "CPU: near-cap Markdown render <200ms (original SLA)",
  },
  "tests/web-hub/ui/logic-markdown.test.ts": { kind: "timing", why: "CPU: adversarial Markdown parse/render <200ms" },
  "tests/workflow/wc02-runaway-gate.test.ts": {
    kind: "timing",
    why: "real worker CPU runaway: diagnostic upper bound, slice+1s and total <15s gates",
  },
  "tests/workflow/worker-integration.test.ts": {
    kind: "timing",
    why: "real worker termination/VM interrupts: <2s / <50+30ms",
  },
  "tests/bash/tool.test.ts": { kind: "timing", why: "wait:setTimeout(…, 5_000)" },
  "tests/cache-ttl/measure-command.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/compact-hint/dynamic/telemetry-store.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/config/agent-dir-sandbox.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/config/package-root-sites.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/extensions/worktree-git-integration.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/external-agent/process.test.ts": {
    kind: "timing",
    why: "real process group immediate stop / orphan reap ≤3s; 15s child backstop",
  },
  "tests/git/run.test.ts": { kind: "timing", why: "real SIGTERM-ignoring git process group: deadline kill/settle <1s" },
  "tests/git/worktrees-real-git.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/helpers/free-port.test.ts": { kind: "proc", why: 'sock:".listen("; sock:"createServer("' },
  // this gate's own synthetic fixtures contain marker literals (no real process/mount/sleep)
  "tests/governance/test-tiers.test.ts": {
    kind: "false-positive",
    why: 'proc:node:child_process; mount:"gocryptfs"; wait:setTimeout(…, 5_000) (string literals only)',
  },
  "tests/memory/jev/off-golden.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/memory/jev/wire-predict.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/memory/legacy-golden.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/memory/scopes/session-web-thenable.test.ts": {
    kind: "proc",
    why: "proc:node:child_process; strict unhandled-rejection probe",
  },
  "tests/memory/safe-fs.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/quota/credentials.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/reflex/core/draft-regex-redos.test.ts": {
    kind: "timing",
    why: "real child: 1000 DRX sources x adversarial input self-reported CPU <2s",
  },
  "tests/reflex/ports/git-real.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/release/hub-restart-step.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/release/release-script.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/release/restart-hub.test.ts": {
    kind: "timing",
    why: "real Unix socket hello_ack deadline: rejection <2s",
  },
  "tests/release/web-ui-zip.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/schedule/core/fault-injection.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/schedule/core/reader.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/schedule/core/recovery.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/schedule/core/session-proof.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/schedule/core/writer.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/scripts/feishu-probe-runtime.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/secure/convert-lease-wait.process.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/secure/convert-preflight.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/secure/init-cleanup.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/secure/launcher-cli.test.ts": {
    kind: "false-positive",
    why: 'proc:node:child_process; mount:"\\"gocryptfs\\""',
  },
  "tests/secure/launcher-helper.test.ts": {
    kind: "timing",
    why: "real child/proc/FUSE probe deadlines: <1500ms / <3s / <500ms",
  },
  "tests/secure/settings-file-migrate.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/secure/settings-file-secure.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/secure/settings-lock.test.ts": {
    kind: "timing",
    why: "real flock holder: wait-budget refusal <4s, callback never runs",
  },
  "tests/secure/preflight-adapters.test.ts": {
    kind: "false-positive",
    why: "synthetic fs/spawn adapters and fake-clock mountguard only; no host probes",
  },
  "tests/secure/preflight.test.ts": {
    kind: "false-positive",
    why: "synthetic verdict/task trees and injected global setup only; no host probes",
  },
  "tests/secure/tar.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/secure/tree.test.ts": {
    kind: "timing",
    why: "real helper groups/IO: hung mv/sync/stall/protocol progress <5s / <4s",
  },
  "tests/service/request-threading.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/session-nav/open-discipline.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/setup/sandbox-home-guard.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/startup-bundle/dispatcher.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/traffic/db-contention.test.ts": {
    kind: "proc",
    why: 'sock:".listen("; sock:"createServer("; wait:setTimeout(…, 1000)',
  },
  "tests/traffic/jq.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/traffic/replay-cleanup.test.ts": {
    kind: "timing",
    why: 'sock:".listen("; sock:"createServer("; real latency: 2000 ms',
  },
  "tests/traffic/replay.test.ts": { kind: "proc", why: 'sock:".listen("; sock:"createServer("' },
  "tests/traffic/rewrite-api.test.ts": {
    kind: "proc",
    why: 'sock:".listen("; sock:"createServer("; wait:setTimeout(…, 3000)',
  },
  "tests/traffic/secure.test.ts": { kind: "proc", why: 'sock:".listen("; sock:"createServer("' },
  "tests/traffic/server-hardening.test.ts": { kind: "proc", why: 'sock:".listen("; sock:"createServer("' },
  "tests/traffic/server-start.test.ts": { kind: "proc", why: 'sock:".listen("; sock:"createServer("' },
  "tests/web-hub/agent/resume-open-discipline.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/boundary.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/http/api-agent-remove.test.ts": { kind: "proc", why: 'sock:".listen("' },
  "tests/web-hub/http/api-avatar.test.ts": { kind: "proc", why: 'sock:".listen("' },
  "tests/web-hub/http/api-cmd.test.ts": { kind: "proc", why: 'sock:".listen("' },
  "tests/web-hub/http/api-headless-history.test.ts": { kind: "proc", why: 'sock:".listen("' },
  "tests/web-hub/http/api-headless-mkdir.test.ts": { kind: "proc", why: 'sock:".listen("' },
  "tests/web-hub/http/api-headless-privacy-fork.test.ts": { kind: "proc", why: 'sock:".listen("' },
  "tests/web-hub/http/api-headless-relaunch.test.ts": { kind: "proc", why: 'sock:".listen("' },
  "tests/web-hub/http/api-headless.test.ts": { kind: "proc", why: 'sock:".listen("' },
  "tests/web-hub/http/api-preview-download.test.ts": { kind: "proc", why: 'sock:".listen("' },
  "tests/web-hub/http/api-preview-html.test.ts": { kind: "proc", why: 'sock:".listen("; sock:"createServer("' },
  "tests/web-hub/http/api-preview-probe.test.ts": { kind: "proc", why: 'sock:".listen("' },
  "tests/web-hub/http/api-preview.test.ts": { kind: "proc", why: 'sock:".listen("' },
  "tests/web-hub/http/api-privacy.test.ts": { kind: "proc", why: 'sock:".listen("' },
  "tests/web-hub/http/api-run.test.ts": { kind: "proc", why: 'sock:".listen("' },
  "tests/web-hub/http/api-upload.test.ts": {
    kind: "timing",
    why: 'sock:".listen("; real latency: 1_500 ms; UPLOAD_TOTAL_MS ms',
  },
  "tests/web-hub/http/api-version.test.ts": { kind: "proc", why: 'sock:".listen("' },
  "tests/web-hub/http/api-worktree-diff.test.ts": { kind: "proc", why: 'sock:".listen("' },
  "tests/web-hub/http/api-worktree-graph.test.ts": { kind: "proc", why: 'sock:".listen("' },
  "tests/web-hub/http/api.test.ts": { kind: "proc", why: 'sock:".listen("' },
  "tests/web-hub/http/build-context.test.ts": { kind: "proc", why: 'sock:".listen("; sock:"createServer("' },
  "tests/web-hub/http/command-complete-route.test.ts": { kind: "proc", why: 'sock:".listen("' },
  "tests/web-hub/http/gzip-negotiation.test.ts": { kind: "proc", why: 'sock:".listen("' },
  "tests/web-hub/http/headless-matrix.test.ts": { kind: "proc", why: 'sock:".listen("' },
  "tests/web-hub/http/lan-avatar.test.ts": { kind: "proc", why: 'sock:".listen("' },
  "tests/web-hub/http/lan-headless.test.ts": { kind: "proc", why: 'sock:".listen("' },
  "tests/web-hub/http/lan-password-client.test.ts": { kind: "proc", why: 'sock:".listen("; sock:"createServer("' },
  "tests/web-hub/http/lan-sse-verifiedat.test.ts": { kind: "proc", why: 'sock:".listen("; sock:"createServer("' },
  "tests/web-hub/http/lan-start-lifecycle.test.ts": { kind: "proc", why: 'sock:".listen("' },
  "tests/web-hub/http/lan-static.test.ts": { kind: "proc", why: 'sock:".listen("; sock:"createServer("' },
  "tests/web-hub/http/proxy-lifecycle.test.ts": { kind: "proc", why: 'sock:".listen("' },
  "tests/web-hub/http/proxy-redaction.test.ts": { kind: "timing", why: "wait:setTimeout(…, 3_000)" },
  "tests/web-hub/http/proxy-wiring.test.ts": { kind: "timing", why: "wait:setTimeout(…, 3_000)" },
  "tests/web-hub/http/security.test.ts": { kind: "timing", why: 'sock:".listen("; real latency: 2_500 ms' },
  "tests/web-hub/http/sse.test.ts": { kind: "proc", why: 'sock:".listen("; sock:"createServer("' },
  "tests/web-hub/http/static.test.ts": { kind: "proc", why: 'sock:".listen("; sock:"createServer("' },
  "tests/web-hub/hub/agent-server-admin.test.ts": { kind: "proc", why: 'sock:".listen("; sock:"createServer("' },
  "tests/web-hub/hub/agent-server-log.test.ts": { kind: "proc", why: 'sock:".listen("; sock:"createServer("' },
  "tests/web-hub/hub/agent-server.test.ts": { kind: "proc", why: 'sock:".listen("; sock:"createServer("' },
  "tests/web-hub/hub/avatar/routes.test.ts": {
    kind: "timing",
    why: 'sock:".listen("; sock:"createServer("; real latency: 500 ms; 14_000 ms',
  },
  "tests/web-hub/hub/command-complete.test.ts": { kind: "timing", why: "wait:setTimeout(…, 3000)" },
  "tests/web-hub/hub/db-child-sqlite-unavailable.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/hub/db-child.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/hub/db-client.test.ts": { kind: "proc", why: "proc:node:child_process; wait:setTimeout(…, 1000)" },
  "tests/web-hub/hub/epoch-up-compat.test.ts": { kind: "proc", why: 'sock:".listen("' },
  "tests/web-hub/hub/feishu/service.test.ts": {
    kind: "timing",
    why: "wait:setTimeout(…, 5_600); real latency: 4_000 ms",
  },
  "tests/web-hub/hub/hub-lan.test.ts": { kind: "timing", why: "wait:setTimeout(…, 2_200)" },
  "tests/web-hub/hub/hub-spawn.test.ts": {
    kind: "proc",
    why: 'proc:node:child_process; sock:".listen("; wait:setTimeout(…, 3_100)',
  },
  "tests/web-hub/hub/kdf-upgrade.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/hub/lan-login.test.ts": { kind: "timing", why: "wait:setTimeout(…, 5_000)" },
  "tests/web-hub/hub/lan-store-security.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/hub/lan-store.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/hub/preview/admit.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/hub/preview/dir.test.ts": { kind: "timing", why: "wait:setTimeout(…, 1_400); real latency: 2_000 ms" },
  "tests/web-hub/hub/preview/pv-admit.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/hub/proxy/agent-queue.test.ts": { kind: "proc", why: 'sock:"createServer("' },
  "tests/web-hub/hub/proxy/forward.test.ts": {
    kind: "timing",
    why: 'sock:"createServer("; real latency: 11500 ms; 1250 ms',
  },
  "tests/web-hub/hub/proxy/listener-allowlist.test.ts": { kind: "timing", why: "wait:setTimeout(…, 3000)" },
  "tests/web-hub/hub/reload-status-passthrough.test.ts": {
    kind: "proc",
    why: 'sock:".listen("; sock:"createServer("',
  },
  "tests/web-hub/hub/schedule-frames.test.ts": { kind: "proc", why: 'sock:".listen("; sock:"createServer("' },
  "tests/web-hub/hub/schedule-http.test.ts": { kind: "proc", why: 'sock:".listen("' },
  "tests/web-hub/hub/schedule-service.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/hub/singleton-hardening.test.ts": { kind: "proc", why: 'sock:".listen("; sock:"createServer("' },
  "tests/web-hub/hub/singleton.test.ts": {
    kind: "timing",
    why: 'proc:node:child_process; sock:".listen("; sock:"createServer("; real latency: 2_000 ms; 6_000 ms; 2_500 ms; 500 ms',
  },
  "tests/web-hub/hub/spawn/created-dirs.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/hub/spawn/dirs.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/hub/spawn/golden.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/hub/spawn/history/proc-real.test.ts": {
    kind: "timing",
    why: "real /proc census + mkfifo/O_NONBLOCK child: BUDGET_MS bound",
  },
  "tests/web-hub/hub/spawn/launcher-check.test.ts": {
    kind: "timing",
    why: "wait:setTimeout(…, 5_000); real latency: 1_400 ms",
  },
  "tests/web-hub/hub/spawn/reaper.test.ts": {
    kind: "timing",
    why: "proc:node:child_process; real latency: 1_000 ms; REAPER_HARD_CAP_MS + 2_000 ms",
  },
  "tests/web-hub/hub/spawn/supervisor.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/hub/startup-cancel.test.ts": { kind: "proc", why: 'sock:".listen("; sock:"createServer("' },
  "tests/web-hub/hub/supersede-handshake.test.ts": { kind: "proc", why: 'sock:".listen("; sock:"createServer("' },
  "tests/web-hub/hub/totp-key.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/hub/ui-root.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/hub/version-git.test.ts": {
    kind: "timing",
    why: 'proc:node:child_process; sock:".listen("; sock:"createServer("; real latency: 4000 ms',
  },
  "tests/web-hub/hub/version-info.test.ts": {
    kind: "timing",
    why: "proc:node:child_process; real latency: 500 ms; 1000 ms",
  },
  "tests/web-hub/hub/worktree-diff/source-scan.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/hub/worktree-graph/commit-files.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/hub/worktree-graph/source-scan.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/protocol/paths-private-dir.test.ts": { kind: "proc", why: 'sock:".listen("; sock:"createServer("' },
  "tests/web-hub/protocol/pid.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/ui/hub-http-integration.test.ts": { kind: "proc", why: 'sock:".listen("' },
  "tests/web-hub/ui/quota-pill.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/workflow/isolation-verify.test.ts": {
    kind: "timing",
    why: "real git child verify deadlines: <300+500+2000ms",
  },
  "tests/workflow/wc14-testhooks-gate.test.ts": { kind: "proc", why: "proc:node:child_process" },
};

// ---------------------------------------------------------------------------
// Partition lookup
// ---------------------------------------------------------------------------

const TEST_FILE_RE = /^tests\/.+\.test(?:-d)?\.ts$/;

/** Matches the BASE_TEST_INCLUDE globs (lexical equivalent). */
export function isTestFilePath(rel: string): boolean {
  return TEST_FILE_RE.test(rel);
}

/**
 * The project a test file belongs to. Explicit lists win over directory prefixes;
 * null = not a test file under tests/ (belongs to no project).
 */
export function projectOf(rel: string): ProjectName | null {
  if (SECURE_MOUNT_FILES.includes(rel)) return "secure";
  if (TIER2_FILES.includes(rel)) return "tier2";
  if (TIER2_DIRS.some((d) => rel.startsWith(d))) return "tier2";
  if (isTestFilePath(rel)) return "tier1";
  return null;
}

// ---------------------------------------------------------------------------
// Include / exclude derivation for vitest.workspace.ts (single source: the lists above)
// ---------------------------------------------------------------------------

export function tier1Include(): string[] {
  return [...BASE_TEST_INCLUDE];
}

export function tier1Exclude(): string[] {
  return [...TIER2_DIRS.map((d) => d + "**"), ...TIER2_FILES, ...SECURE_MOUNT_FILES];
}

export function tier2Include(): string[] {
  return [...TIER2_DIRS.flatMap((d) => [d + "**/*.test.ts", d + "**/*.test-d.ts"]), ...TIER2_FILES];
}

/** No real-mount file may run outside the secure project (the 5 conformance ones would
 *  otherwise sneak in through the tests/conformance/** include). */
export function tier2Exclude(): string[] {
  return [...SECURE_MOUNT_FILES];
}

export function secureInclude(): string[] {
  return [...SECURE_MOUNT_FILES];
}

// ---------------------------------------------------------------------------
// D4 markers (lexical, deliberately over-approximate — see file header)
// ---------------------------------------------------------------------------

export type MarkerName = "proc" | "sock" | "wait" | "mount";

export interface MarkerHit {
  marker: MarkerName;
  evidence: string;
}

const SOCK_MARKERS = [".listen(", "createServer(", "createConnection(", "new WebSocket("] as const;
const MOUNT_MARKERS = [
  "acquireGocryptfsTestLock(",
  "realSkipReason(",
  "HAVE_FUSE_STACK",
  '"gocryptfs"',
  "'gocryptfs'",
] as const;
const WAIT_RE = /setTimeout\([^;]{0,200}?,\s*(\d[\d_]*)\s*\)/g;

/** Scan one file's content for D4 markers. First wait-hit only (evidence, not a census). */
export function scanTier1Markers(content: string): MarkerHit[] {
  const hits: MarkerHit[] = [];
  if (content.includes("node:child_process")) hits.push({ marker: "proc", evidence: "node:child_process" });
  for (const m of SOCK_MARKERS) if (content.includes(m)) hits.push({ marker: "sock", evidence: m });
  for (const m of MOUNT_MARKERS) if (content.includes(m)) hits.push({ marker: "mount", evidence: m });
  WAIT_RE.lastIndex = 0;
  let w: RegExpExecArray | null;
  while ((w = WAIT_RE.exec(content))) {
    if (Number(w[1]!.replace(/_/g, "")) >= 1000) {
      hits.push({ marker: "wait", evidence: "setTimeout(…, " + w[1] + ")" });
      break;
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Manifest validation (the D4 gate's engine; tests/governance/test-tiers.test.ts)
// ---------------------------------------------------------------------------

export interface ManifestTables {
  tier1: Readonly<Record<string, Tier1DeclaredEntry>>;
  tier2Files: readonly string[];
  secureMountFiles: readonly string[];
}

export interface ManifestProblem {
  path: string;
  problem: string;
}

/**
 * Validate one partition instance. `files` = discovered test files (relative POSIX paths),
 * `read` = content reader (real readFileSync or a fixture), `tables` = the partition to
 * check (defaults to the real manifest — synthetic tables drive the negative unit tests).
 *
 * Failures (each must be actionable; D4):
 *  1. duplicate registration — the same path in two tables;
 *  2. unregistered marker hit — a tier1 file hitting a D4 marker without a TIER1_DECLARED
 *     entry (fix: register in TIER1_DECLARED, or move to TIER2_FILES / SECURE_MOUNT_FILES);
 *  3. registered but missing — a registered path the discovery did not find;
 *  4. mount marker vs kind — a tier1 file whose mount marker hit but whose kind is not
 *     "false-positive" (real mounts belong in SECURE_MOUNT_FILES, not tier1);
 *  5. no project — a registered path that matches no project's include (not a
 *     tests/** .test.ts / .test-d.ts path).
 */
export function validateManifest(
  files: readonly string[],
  read: (rel: string) => string,
  tables: ManifestTables = {
    tier1: TIER1_DECLARED,
    tier2Files: TIER2_FILES,
    secureMountFiles: SECURE_MOUNT_FILES,
  },
): ManifestProblem[] {
  const problems: ManifestProblem[] = [];
  const projectFor = (rel: string): ProjectName | null => {
    if (tables.secureMountFiles.includes(rel)) return "secure";
    if (tables.tier2Files.includes(rel)) return "tier2";
    if (TIER2_DIRS.some((d) => rel.startsWith(d))) return "tier2";
    if (isTestFilePath(rel)) return "tier1";
    return null;
  };

  // 1. duplicate registration
  const pairs: Array<[readonly string[], readonly string[], string]> = [
    [Object.keys(tables.tier1), tables.tier2Files, "TIER1_DECLARED + TIER2_FILES"],
    [Object.keys(tables.tier1), tables.secureMountFiles, "TIER1_DECLARED + SECURE_MOUNT_FILES"],
    [tables.tier2Files, tables.secureMountFiles, "TIER2_FILES + SECURE_MOUNT_FILES"],
  ];
  for (const [a, b, label] of pairs) {
    for (const p of a) {
      if (b.includes(p)) {
        problems.push({ path: p, problem: "registered in two tables (" + label + ") — keep exactly one" });
      }
    }
  }

  // 3./5. every registered path is a real discovered test file of some project
  const registered = new Set<string>([...Object.keys(tables.tier1), ...tables.tier2Files, ...tables.secureMountFiles]);
  const discovered = new Set(files);
  for (const p of registered) {
    // NOTE: the structural check is on the PATH SHAPE, not projectFor() — projectFor is
    // table-aware, so a registered non-test path would otherwise always "belong" to its table.
    if (!isTestFilePath(p)) {
      problems.push({ path: p, problem: "belongs to no project (expected a tests/** .test.ts path)" });
    } else if (!discovered.has(p)) {
      problems.push({ path: p, problem: "registered but missing from the discovered test files" });
    }
  }

  // 2./4. marker gate over the discovered tier1 files
  for (const p of files) {
    if (projectFor(p) !== "tier1") continue;
    const hits = scanTier1Markers(read(p));
    const entry = tables.tier1[p];
    if (hits.length > 0 && !entry) {
      const evidence = hits.map((h) => h.marker + ":" + JSON.stringify(h.evidence)).join("; ");
      problems.push({
        path: p,
        problem:
          "hits D4 markers [" +
          evidence +
          "] but is not registered — add it to TIER1_DECLARED, " +
          "or move it to TIER2_FILES / SECURE_MOUNT_FILES",
      });
      continue;
    }
    if (entry && hits.some((h) => h.marker === "mount") && entry.kind !== "false-positive") {
      problems.push({
        path: p,
        problem:
          'mount marker hit but kind is "' +
          entry.kind +
          '" — a real mount belongs in SECURE_MOUNT_FILES; ' +
          'a tier1 false hit must be declared kind "false-positive"',
      });
    }
  }
  return problems;
}
