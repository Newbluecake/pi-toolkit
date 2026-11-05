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
 * - kind "timing" = tier1 file with real ≥1 s waits: its failures are TRIAGED like Tier 2
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
export const TIER2_DIRS: readonly string[] = ["tests/integration/", "tests/conformance/"];

/** Tier 2 files outside TIER2_DIRS (plan D2): real private lock / plain child processes /
 * build-artifact-dependent suites. Not real-mount — those are SECURE_MOUNT_FILES. */
export const TIER2_FILES: readonly string[] = [
  // private lock file only — no mount (keeps its fast unit behaviour out of tier1)
  "tests/secure/gocryptfs-test-lock.test.ts",
  // plain child processes, no gocryptfs mount
  "tests/secure/private-real-harness.test.ts",
  // real tsx/loader child processes ×matrix, needs dist/bundle (147 s)
  "tests/governance/bundle-parity.test.ts",
  // actually runs scripts/release/package.sh (36 s)
  "tests/release/package-zip.test.ts",
];

/** The 17 files with REAL gocryptfs mount blocks (plan D2a: each was read; judged by content,
 * not name) → the dedicated `secure` project, so P2 can hang the preflight setup on it. */
export const SECURE_MOUNT_FILES: readonly string[] = [
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
  /** proc = real child processes / sockets · timing = real ≥1 s waits (Tier 2 triage on
   *  failure) · false-positive = mount marker matched but no real mount. */
  kind: Tier1Kind;
  /** Which D4 markers hit (evidence; over-approximate by design). */
  why: string;
}

/**
 * D4a baseline (mechanically generated from the pre-change 1760-file `vitest list`, then
 * hand-reviewed): every tier1 file that hits at least one D4 marker. Kind policy after the
 * manual review: mount ⇒ false-positive (required by the gate); any proc ⇒ proc; sock-only ⇒
 * proc; wait-only ⇒ timing (11 files). Entries whose file disappears fail the
 * "registered but missing" check and are removed — the table converges on deletion.
 */
export const TIER1_DECLARED: Readonly<Record<string, Tier1DeclaredEntry>> = {
  "tests/bash/tool.test.ts": { kind: "timing", why: "wait:setTimeout(…, 5_000)" },
  "tests/cache-ttl/measure-command.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/compact-hint/dynamic/telemetry-store.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/config/agent-dir-sandbox.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/config/package-root-sites.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/extensions/worktree-git-integration.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/external-agent/process.test.ts": { kind: "proc", why: "proc:node:child_process; wait:setTimeout(…, 15000)" },
  "tests/git/run.test.ts": { kind: "proc", why: "proc:node:child_process" },
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
  "tests/memory/safe-fs.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/memory/tidy.test.ts": { kind: "timing", why: "wait:setTimeout(…, 1100)" },
  "tests/quota/credentials.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/reflex/core/draft-regex-redos.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/reflex/ports/git-real.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/release/hub-restart-step.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/release/release-script.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/release/restart-hub.test.ts": { kind: "proc", why: 'sock:".listen("; sock:"createServer("' },
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
  "tests/secure/launcher-helper.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/secure/settings-file-migrate.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/secure/settings-file-secure.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/secure/settings-lock.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/secure/tar.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/secure/tree.test.ts": { kind: "proc", why: 'proc:node:child_process; sock:".listen("; sock:"createServer("' },
  "tests/service/request-threading.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/session-nav/open-discipline.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/setup/sandbox-home-guard.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/startup-bundle/dispatcher.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/traffic/db-contention.test.ts": {
    kind: "proc",
    why: 'sock:".listen("; sock:"createServer("; wait:setTimeout(…, 1000)',
  },
  "tests/traffic/jq.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/traffic/replay-cleanup.test.ts": { kind: "proc", why: 'sock:".listen("; sock:"createServer("' },
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
  "tests/web-hub/http/api-upload.test.ts": { kind: "proc", why: 'sock:".listen("' },
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
  "tests/web-hub/http/security.test.ts": { kind: "proc", why: 'sock:".listen("' },
  "tests/web-hub/http/sse.test.ts": { kind: "proc", why: 'sock:".listen("; sock:"createServer("' },
  "tests/web-hub/http/static.test.ts": { kind: "proc", why: 'sock:".listen("; sock:"createServer("' },
  "tests/web-hub/hub/agent-server-admin.test.ts": { kind: "proc", why: 'sock:".listen("; sock:"createServer("' },
  "tests/web-hub/hub/agent-server-log.test.ts": { kind: "proc", why: 'sock:".listen("; sock:"createServer("' },
  "tests/web-hub/hub/agent-server.test.ts": { kind: "proc", why: 'sock:".listen("; sock:"createServer("' },
  "tests/web-hub/hub/avatar/routes.test.ts": { kind: "proc", why: 'sock:".listen("; sock:"createServer("' },
  "tests/web-hub/hub/command-complete.test.ts": { kind: "timing", why: "wait:setTimeout(…, 3000)" },
  "tests/web-hub/hub/db-child-sqlite-unavailable.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/hub/db-child.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/hub/db-client.test.ts": { kind: "proc", why: "proc:node:child_process; wait:setTimeout(…, 1000)" },
  "tests/web-hub/hub/epoch-up-compat.test.ts": { kind: "proc", why: 'sock:".listen("' },
  "tests/web-hub/hub/feishu/service.test.ts": { kind: "timing", why: "wait:setTimeout(…, 5_600)" },
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
  "tests/web-hub/hub/preview/dir.test.ts": { kind: "timing", why: "wait:setTimeout(…, 1_400)" },
  "tests/web-hub/hub/preview/pv-admit.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/hub/proxy/agent-queue.test.ts": { kind: "proc", why: 'sock:"createServer("' },
  "tests/web-hub/hub/proxy/forward.test.ts": { kind: "proc", why: 'sock:"createServer("' },
  "tests/web-hub/hub/proxy/listener-allowlist.test.ts": { kind: "timing", why: "wait:setTimeout(…, 3000)" },
  "tests/web-hub/hub/schedule-frames.test.ts": { kind: "proc", why: 'sock:".listen("; sock:"createServer("' },
  "tests/web-hub/hub/schedule-http.test.ts": { kind: "proc", why: 'sock:".listen("' },
  "tests/web-hub/hub/schedule-service.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/hub/singleton-hardening.test.ts": { kind: "proc", why: 'sock:".listen("; sock:"createServer("' },
  "tests/web-hub/hub/singleton.test.ts": {
    kind: "proc",
    why: 'proc:node:child_process; sock:".listen("; sock:"createServer("',
  },
  "tests/web-hub/hub/spawn/created-dirs.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/hub/spawn/dirs.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/hub/spawn/golden.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/hub/spawn/history/proc-real.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/hub/spawn/launcher-check.test.ts": { kind: "timing", why: "wait:setTimeout(…, 5_000)" },
  "tests/web-hub/hub/spawn/reaper.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/hub/spawn/supervisor.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/hub/startup-cancel.test.ts": { kind: "proc", why: 'sock:".listen("; sock:"createServer("' },
  "tests/web-hub/hub/supersede-handshake.test.ts": { kind: "proc", why: 'sock:".listen("; sock:"createServer("' },
  "tests/web-hub/hub/totp-key.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/hub/ui-root.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/hub/version-git.test.ts": {
    kind: "proc",
    why: 'proc:node:child_process; sock:".listen("; sock:"createServer("',
  },
  "tests/web-hub/hub/version-info.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/hub/worktree-diff/source-scan.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/hub/worktree-graph/commit-files.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/hub/worktree-graph/source-scan.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/protocol/paths-private-dir.test.ts": { kind: "proc", why: 'sock:".listen("; sock:"createServer("' },
  "tests/web-hub/protocol/pid.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/web-hub/ui/hub-http-integration.test.ts": { kind: "proc", why: 'sock:".listen("' },
  "tests/web-hub/ui/quota-pill.test.ts": { kind: "proc", why: "proc:node:child_process" },
  "tests/workflow/isolation-verify.test.ts": { kind: "proc", why: "proc:node:child_process" },
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
