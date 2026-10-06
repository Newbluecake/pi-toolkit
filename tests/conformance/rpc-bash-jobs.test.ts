/**
 * bash-jobs-panel plan §3 step 10 / §4 (包 A conformance): the REAL devDependency
 * `pi --mode rpc` against a fake hub socket — same fixture family as `rpc-spawn.test.ts`
 * (temp HOME whose settings.json lists THIS package the regular way, `webHub.enabled`,
 * `PI_WEBHUB_HEADLESS=1`), but seeded with on-disk bash jobs for a KNOWN session id.
 *
 * Session pin: `pi --session-id <uuidv7>` ("creating it if missing", main.js's
 * createSessionManager) makes `ctx.sessionManager.getSessionId()` — and therefore the
 * bash-jobs store dir `<HOME>/.pi/agent/bash-jobs/<sanitizeSessionDirName(id)>` (a bare
 * uuidv7 maps to itself, session-dirs.ts) — fully deterministic, so the seeds land BEFORE
 * the child starts and flow through the real recovery path (`recover()`: pruneExpired →
 * loadAll → per-record adjudication), not through any test-only injection point.
 *
 * Seeds (plan §3.10's list) — note the store's on-disk name contract: job ids must be
 * `b_` + 8 UPPERCASE Crockford chars (`[0-9A-HJKMNP-TV-Z]`, no I/L/O/U — ids.ts); anything
 * else is skipped by the store with an "unexpected name" warning, and the retention key
 * on disk is the seconds alias `bashJobs.retentionS` (loads into `settings.bashJobs.retentionMs`):
 *  - `b_TERM0001` — terminal backgrounded job whose log carries `GITHUB_TOKEN=ghp_…`,
 *    `Authorization: Bearer …`, URL userinfo + `?access_token=…` → must surface with a
 *    REDACTED tail that eventually reaches `tailCurrent` (agent-judged, D3-3).
 *  - `b_DEAD0002` — backgrounded `running` job whose hostPid/pid are dead → recover()
 *    adjudicates it to a terminal status (exited_unknown for a nonexistent pid).
 *  - `b_F0RE0003` — terminal FOREGROUND job (`backgroundedAt` absent) → never selected (D1).
 *  - `b_EXP00004` — terminal backgrounded job older than the test's shortened retention
 *    (`bashJobs.retentionMs: 120_000`) → retention-filtered (D1 ②, pruned on disk).
 *
 * Hard assertions: foreground/expired rows absent from EVERY bashJobs frame; redaction on
 * the wire tail; eventual `tailCurrent`; no `logPath` field anywhere; the slot fits the
 * 24 KiB D6 budget (`bashJobsWireBytes`, measured on the slot only). Skipped when the pi
 * devDependency CLI is not installed (CI without it), exactly like rpc-spawn.test.ts.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROTO } from "../../src/web-hub/protocol/version.js";
import { NdjsonDecoder } from "../../src/web-hub/protocol/ndjson.js";
import {
  BASH_JOBS_WIRE_BUDGET_BYTES,
  bashJobsWireBytes,
  type BashJobsWire,
} from "../../src/web-hub/agent/bash-jobs.js";
import type { JobRecord } from "../../src/bash/types.js";

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const PI_CLI = join(REPO_ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");

/** A valid uuidv7 (version nibble 7, variant 89ab) — `assertValidSessionId`-clean AND
 *  `UUIDV7_RE`-clean, so pi keeps the id verbatim and the bash-jobs dir name IS the id. */
const SESSION_ID = "0197c0de-0000-7000-8000-000000000001";
/** Shortened retention (default is 24h): lets `b_EXP00004` (ended 3 min ago) be expired. */
const RETENTION_MS = 120_000;
/** A pid that does not exist (same trick rpc-spawn.test.ts uses for its dead-pid fixture). */
const DEAD_PID = 2 ** 22 + 12345;

const SECRET_LOG = [
  "building artifact…",
  "step 2 ok",
  "GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
  "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV",
  "curl 'https://user:secretpw@example.com/deploy?access_token=abc123def&x=1'",
  "done",
].join("\n");

describe.skipIf(!existsSync(PI_CLI))("rpc-bash-jobs conformance — real pi --mode rpc (bash-jobs-panel §3.10)", () => {
  let home: string | undefined;
  let workdir: string | undefined;
  let child: ChildProcess | undefined;
  let server: net.Server | undefined;
  const frames: Record<string, unknown>[] = [];

  /** One seeded on-disk job record (store layout: `<dir>/<jobId>.json` + `<jobId>.log`). */
  function seedJob(dir: string, jobId: string, over: Partial<JobRecord>, log: string): void {
    const logPath = join(dir, `${jobId}.log`);
    writeFileSync(logPath, log, { mode: 0o600 });
    const now = Date.now();
    const record: Record<string, unknown> = {
      v: 1,
      jobId,
      command: `echo seed ${jobId}`,
      cwd: "/tmp",
      sessionId: SESSION_ID,
      hostPid: DEAD_PID,
      status: "completed",
      createdAt: now - 60_000,
      spawnedAt: now - 60_000,
      backgroundedAt: now - 59_000,
      endedAt: now - 30_000,
      notifiedAt: now - 30_000, // keep the boot quiet: no pending completion notice
      exitCode: 0,
      logPath,
      logBytes: Buffer.byteLength(log, "utf8"),
      outputTruncated: false,
      readCursor: 0,
      ...over,
    };
    writeFileSync(join(dir, `${jobId}.json`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "pwh-conf-bj-"));
    workdir = join(home, "work");
    mkdirSync(workdir, { recursive: true });

    // Regular installation shape (never -e): settings.json lists THIS package.
    const agentDir = join(home, ".pi", "agent");
    mkdirSync(join(agentDir, "sessions"), { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [REPO_ROOT] }));
    writeFileSync(
      join(agentDir, "pi-subagent.json"),
      JSON.stringify({ webHub: { enabled: true }, bashJobs: { retentionS: Math.round(RETENTION_MS / 1_000) } }),
    );

    // Seed the session's bash-jobs dir BEFORE the child starts (recover() loads it).
    const jobsDir = join(agentDir, "bash-jobs", SESSION_ID);
    mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
    const now = Date.now();
    // Fresh terminal seeds: age ~1s against the 120s retention window, so the whole
    // test (boot + recovery + sampler) fits comfortably before they could expire.
    const endedAt = now - 1_000;
    seedJob(jobsDir, "b_TERM0001", { endedAt, notifiedAt: endedAt }, SECRET_LOG);
    seedJob(
      jobsDir,
      "b_DEAD0002",
      {
        status: "running",
        pid: DEAD_PID,
        pgid: DEAD_PID,
        endedAt: undefined,
        notifiedAt: undefined,
        exitCode: null,
      },
      "still running when pi died\n",
    );
    seedJob(jobsDir, "b_F0RE0003", { backgroundedAt: undefined }, "foreground output\n");
    seedJob(
      jobsDir,
      "b_EXP00004",
      {
        createdAt: now - 300_000,
        spawnedAt: now - 300_000,
        backgroundedAt: now - 299_000,
        endedAt: now - 180_000, // > RETENTION_MS ⇒ retention-filtered (and disk-pruned)
        notifiedAt: now - 180_000,
      },
      "expired long ago\n",
    );

    // Fake hub socket at the exact path the agent side derives from HOME.
    const stateDir = join(agentDir, "web-hub");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const socketPath = join(stateDir, "hub.sock");
    rmSync(socketPath, { force: true });
    server = net.createServer((sock) => {
      const dec = new NdjsonDecoder({
        maxFrameBytes: 512 * 1024,
        onFrame: (raw: unknown) => {
          const frame = raw as Record<string, unknown>;
          frames.push(frame);
          if (frame["t"] === "hello") {
            sock.write(
              `${JSON.stringify({
                t: "hello_ack",
                hubVersion: "1.2.3",
                buildId: "1.2.3@conf-bj",
                proto: { major: PROTO.major, minor: PROTO.minor },
                agentKey: "a-conf-bj-key-000001",
                pingMs: 10_000,
                leaseMs: 30_000,
                http: { port: 0 },
                caps: ["ctl.v1", "cmd.v1"],
              })}\n`,
            );
          }
          // session / status / ping / snapshot_req — collected, deliberately not answered
        },
        onError: () => {},
      });
      sock.on("data", (c: Buffer) => dec.push(c));
      sock.on("error", () => {});
    });
    await new Promise<void>((res) => server!.listen(socketPath, res));

    // Same fork shape rpc-spawn.test.ts uses, plus the pinned session id.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || k.startsWith("PI_WEBHUB_")) continue;
      env[k] = v;
    }
    env["HOME"] = home;
    env["PI_WEBHUB_HEADLESS"] = "1";
    env["PI_WEBHUB_SPAWN_ID"] = "conf-bash-jobs-00001";
    child = spawn(process.execPath, [PI_CLI, "--mode", "rpc", "--session-id", SESSION_ID], {
      cwd: workdir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout?.resume();
    child.stderr?.resume(); // drain (the "creating a new session with that id" warning lands here)
  }, 30_000);

  afterAll(() => {
    try {
      child?.stdin?.end(); // orderly stop lever first …
      child?.kill("SIGKILL"); // … hard fallback immediately after (this suite must not hang)
    } catch {
      /* already gone */
    }
    server?.close();
    server?.closeAllConnections?.();
    if (home !== undefined) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const until = async (pred: () => boolean, ms: number, what: string): Promise<void> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timeout waiting for ${what}`);
  };

  const bashJobsFrames = (): BashJobsWire[] =>
    frames
      .filter((f) => f["t"] === "status" && typeof f["bashJobs"] === "object" && f["bashJobs"] !== null)
      .map((f) => f["bashJobs"] as BashJobsWire);

  it("a status frame carries the seeded bashJobs projection within 30s (live link, recovery done)", async () => {
    const withBoth = (): BashJobsWire | undefined =>
      bashJobsFrames().find(
        (x) => x.rows.some((r) => r.id === "b_TERM0001") && x.rows.some((r) => r.id === "b_DEAD0002"),
      );
    await until(() => withBoth() !== undefined, 30_000, "a status frame with both backgrounded seeds");
    const wire = withBoth()!;
    expect(wire.rows.length).toBeGreaterThan(0);
    // D1: the foreground and retention-expired seeds never surface.
    const ids = wire.rows.map((r) => r.id);
    expect(ids).toContain("b_TERM0001");
    expect(ids).toContain("b_DEAD0002");
    expect(ids).not.toContain("b_F0RE0003");
    expect(ids).not.toContain("b_EXP00004");
  }, 45_000);

  it("dead-hostPid running seed is adjudicated terminal by the real recover() (exited_unknown)", async () => {
    await until(
      () =>
        bashJobsFrames().some((w) => {
          const row = w.rows.find((r) => r.id === "b_DEAD0002");
          return row !== undefined && row.endedAt !== undefined;
        }),
      30_000,
      "b_DEAD0002 to reach a terminal status",
    );
    const wire = bashJobsFrames().find((w) => w.rows.find((r) => r.id === "b_DEAD0002")?.endedAt !== undefined)!;
    const row = wire.rows.find((r) => r.id === "b_DEAD0002")!;
    expect(row.status).toBe("exited_unknown"); // nonexistent pid ⇒ "dead" ⇒ exited_unknown
  }, 45_000);

  it("tail reaches tailCurrent with agent-side redaction; no logPath on the wire; slot ≤ 24 KiB", async () => {
    await until(
      () =>
        bashJobsFrames().some((w) => {
          const row = w.rows.find((r) => r.id === "b_TERM0001");
          return row?.tailCurrent === true;
        }),
      30_000,
      "b_TERM0001 tailCurrent",
    );
    const wire = bashJobsFrames().find((w) => w.rows.find((r) => r.id === "b_TERM0001")?.tailCurrent === true)!;
    const row = wire.rows.find((r) => r.id === "b_TERM0001")!;
    expect(row.tail).toBeDefined();
    // D2a redaction — hygiene on the wire (NOT a boundary claim):
    expect(row.tail).toContain("GITHUB_TOKEN=***");
    expect(row.tail).toContain("Authorization: ***");
    expect(row.tail).toContain("https://***@example.com");
    expect(row.tail).toContain("access_token=***");
    expect(row.tail).toContain("done");
    // …and the raw secrets never cross the wire:
    expect(row.tail).not.toContain("ghp_ABCDEFGH");
    expect(row.tail).not.toContain("Bearer eyJ");
    expect(row.tail).not.toContain("secretpw");
    expect(row.tail).not.toContain("abc123def");
    // Plan v2 #2: `logPath` was cut — no row may ever carry it.
    for (const w of bashJobsFrames()) {
      for (const r of w.rows) expect("logPath" in r).toBe(false);
      expect(bashJobsWireBytes(w)).toBeLessThanOrEqual(BASH_JOBS_WIRE_BUDGET_BYTES);
    }
    expect(bashJobsWireBytes(wire)).toBeLessThanOrEqual(BASH_JOBS_WIRE_BUDGET_BYTES);
  }, 45_000);
});
