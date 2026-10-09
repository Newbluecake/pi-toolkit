/**
 * web-hub session-history plan §4.8 step 5 (P-int) — RH1–RH4: the REAL devDependency
 * `pi --mode rpc` × the REAL in-process hub (`startHub` + `createHttpFrontend`), with
 * `webHub.spawn.{history,restore}` on: the resume/fork argv tails, `spawns.json` session
 * coordinates, and the graceful-restart restore re-fork, asserted against every fork's REAL
 * argv (captured through a `NODE_OPTIONS=--import` hook — pi rewrites its cmdline, so
 * /proc/<pid>/cmdline can never show `--session`).
 *
 * Both /proc occupancy views run through the PD22 seams (tests/integration/helpers/
 * history-seam.ts): they expose only this hub's managed children + the pids a test explicitly
 * adds (RH4's foreign sample) — the sync re-prove's re-stat included, so a saturated
 * machine's foreign pi/node churn can never surface as an environmental 409.
 *
 * RH4 is a documented-limitation assertion, not a bug report: the restore re-fork deliberately
 * does NOT re-run the occupancy proof (§14.1 / W6 product exception) — a live `comm=pi`
 * process visible to the new hub still gets an in-place `--session` re-fork.
 *
 * Skipped when the pi devDependency CLI is not installed or off Linux.
 */
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import { startHub, type RunningHub } from "../../src/web-hub/hub/hub.js";
import type { HubConfig, HubSpawnConfig } from "../../src/web-hub/hub/ports.js";
import type { HistoryService } from "../../src/web-hub/hub/spawn/history/ports.js";
import { webHubSpawnFiles } from "../../src/web-hub/protocol/paths.js";
import { login, postJson } from "../web-hub/http/helpers.js";
import { waitUntil } from "../web-hub/agent/helpers.js";
import { createHistoryProcSeam } from "../integration/helpers/history-seam.js";

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const PI_CLI = join(REPO_ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const FAKE_PI = resolve("tests/integration/fixtures/fake-rpc-pi.mjs");
const ARGV_LOG_HOOK = resolve("tests/integration/fixtures/argv-log.mjs");
const IS_LINUX = process.platform === "linux";
const HAS_PI = existsSync(PI_CLI);

interface PiSessionManagerLike {
  appendMessage(m: unknown): string;
  appendCustomEntry(type: string, data?: unknown): unknown;
  getSessionFile(): string | undefined;
  getSessionId(): string;
}

/** pi's getDefaultSessionDirPath: `--<cwd with "/", "\", ":" as "-">--` under <agentDir>/sessions. */
function encodedSessionDir(agentDir: string, cwd: string): string {
  const safe = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(agentDir, "sessions", safe);
}

/** A REAL pi-created main session: real `SessionManager` header + a real user message + the
 * `subagent:prompt-sections` entry carrying `"pi_subagent_types":` — the positive kind=main
 * marker `head.ts` looks for (RH1's “真实 main 会话（含 pi_subagent_types 标记）”). */
async function createMainSession(
  agentDir: string,
  cwd: string,
  text: string,
): Promise<{ file: string; id: string; key: string }> {
  const pi = (await import("@earendil-works/pi-coding-agent")) as unknown as {
    SessionManager: { create(cwd: string, sessionDir?: string): PiSessionManagerLike };
  };
  const sm = pi.SessionManager.create(cwd, encodedSessionDir(agentDir, cwd));
  // ORDER MATTERS: `head.ts` stops reading at the FIRST complete user message (PD19), so the
  // kind=main marker must land on the line BEFORE it — the same order a real session gets
  // from a pre-dispatch origin entry or the session-start timing entry.
  sm.appendCustomEntry("subagent:prompt-sections", {
    v: 1,
    sections: { pi_project_memory: {}, pi_subagent_types: {}, pi_subagent_models: {} },
  });
  sm.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
  const file = sm.getSessionFile();
  expect(file).toBeDefined();
  expect(existsSync(file!)).toBe(true);
  const root = realpathSync(join(agentDir, "sessions"));
  const real = realpathSync(file!);
  return { file: real, id: sm.getSessionId(), key: real.slice(root.length + 1) };
}

interface RhEnv {
  home: string;
  agentDir: string;
  workdir: string;
  stateDir: string;
  argvLog: string;
  allowPi: Set<number>;
}

interface RhHub {
  hub: RunningHub;
  port: number;
  stateDir: string;
  cookie: string;
}

const hubs: RunningHub[] = [];
const extraProcs = new Set<ChildProcess>();
let env: RhEnv | undefined;
let prevHome: string | undefined;

function prepare(): RhEnv {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pwh-rh-")));
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(join(agentDir, "sessions"), { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [REPO_ROOT] }));
  writeFileSync(join(agentDir, "pi-subagent.json"), JSON.stringify({ webHub: { enabled: true } }));
  const workdir = join(home, "work");
  mkdirSync(workdir, { recursive: true });
  const argvLog = join(home, "argv.log");
  writeFileSync(argvLog, "");
  // the REAL pi children read settings from HOME and connect to `${HOME}/.pi/agent/web-hub/…`
  // — the supervisor copies THIS process's env, so HOME must be the test home for the run
  prevHome = process.env["HOME"];
  process.env["HOME"] = home;
  process.env["ARGV_LOG"] = argvLog;
  process.env["NODE_OPTIONS"] = `--import ${ARGV_LOG_HOOK}`;
  return { home, agentDir, workdir, stateDir: join(agentDir, "web-hub"), argvLog, allowPi: new Set<number>() };
}

async function bootHub(e: RhEnv, opts: { restore: boolean }): Promise<RhHub> {
  const spawn: HubSpawnConfig = {
    roots: [e.home],
    maxProcesses: 8,
    maxPerPrincipal: 8,
    ratePerMinute: 60,
    maxLifetimeMinutes: 720,
    registerTimeoutS: 30,
    lan: "off",
    history: true,
    ...(opts.restore ? { restore: true } : {}),
  };
  const cfg: HubConfig = {
    v: 1,
    home: e.home,
    port: 0,
    idleExitMinutes: 30,
    pluginVersion: "1.2.3",
    buildId: "1.2.3@rh",
    launcher: [process.execPath, PI_CLI],
    spawn,
  };
  const started = await startHub(cfg, createHttpFrontend, {
    uid: process.getuid?.() ?? 0,
    childUmask: 0o022,
    spawnSeams: {
      // both /proc views seam-scoped to the hub's own managed children (helpers/history-seam)
      ...(() => {
        const seam = createHistoryProcSeam({ allowPi: e.allowPi });
        return { historyProcFs: seam.procFs, historyProcSyncFs: seam.procSyncFs };
      })(),
      restoreStableMs: 500,
    },
  });
  if ("exists" in started) throw new Error("unexpected singleton collision");
  hubs.push(started);
  const cookie = await login(started.httpPort, started.paths.tokenFile);
  return { hub: started, port: started.httpPort, stateDir: started.paths.stateDir, cookie };
}

interface StoredRecord {
  spawnId: string;
  state?: string;
  pid?: number;
  endReason?: string;
  sessionId?: string;
  sessionFile?: string;
  [k: string]: unknown;
}

function recordsOf(e: RhEnv): StoredRecord[] {
  const file = webHubSpawnFiles(e.stateDir).spawnsJson;
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { records?: StoredRecord[] };
  return parsed.records ?? [];
}

async function waitRecord(
  e: RhEnv,
  spawnId: string,
  pred: (r: StoredRecord | undefined) => boolean,
  ms: number,
  what: string,
): Promise<StoredRecord> {
  await waitUntil(() => pred(recordsOf(e).find((r) => r.spawnId === spawnId)), ms, `${spawnId}: ${what}`);
  return recordsOf(e).find((r) => r.spawnId === spawnId)!;
}

interface ArgvLine {
  pid: number;
  argv: string[];
}

function argvOf(e: RhEnv, pid: number): ArgvLine {
  const lines = readFileSync(e.argvLog, "utf8").trim().split("\n");
  for (const line of lines.reverse()) {
    if (line.length === 0) continue;
    const parsed = JSON.parse(line) as ArgvLine;
    if (parsed.pid === pid) return parsed;
  }
  throw new Error(`no argv line for pid ${pid}`);
}

async function resume(
  h: RhHub,
  e: RhEnv,
  s: { key: string; id: string },
  mode: "resume" | "fork",
): Promise<{ status: number; body: string }> {
  const res = await postJson(
    h.port,
    "/api/headless",
    {
      id: `rh${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
      cwd: e.workdir,
      session: { key: s.key, id: s.id, mode },
    },
    { Cookie: h.cookie, Origin: `http://127.0.0.1:${h.port}` },
  );
  return { status: res.status, body: res.body };
}

function spawnTitleOnly(e: RhEnv): ChildProcess {
  const child = spawnChild(process.execPath, [FAKE_PI, "--mode", "rpc", "--title-only"], {
    cwd: e.workdir,
    env: { ...process.env },
    stdio: ["ignore", "ignore", "ignore"],
  });
  extraProcs.add(child);
  e.allowPi.add(child.pid!);
  return child;
}

afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close("test-teardown").catch(() => undefined);
  for (const c of extraProcs) {
    try {
      c.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }
  extraProcs.clear();
  delete process.env["NODE_OPTIONS"];
  delete process.env["ARGV_LOG"];
  if (prevHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = prevHome;
  prevHome = undefined;
  if (env !== undefined && process.env.KEEP_SANDBOX === undefined) {
    rmSync(env.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  env = undefined;
});

afterAll(() => {
  delete process.env["NODE_OPTIONS"];
  delete process.env["ARGV_LOG"];
});

describe.skipIf(!IS_LINUX || !HAS_PI)("web-hub history restore conformance — real pi + real hub (RH1–RH4)", () => {
  it('RH1: resume → live with persisted sessionFile == abs → graceful restart ⇒ same spawnId live again, argv tail exactly ["--session", file], no --model, no session-swapped', async () => {
    env = prepare();
    const e = env;
    const session = await createMainSession(e.agentDir, e.workdir, "rh1 resume source");

    let h = await bootHub(e, { restore: true });
    const first = await resume(h, e, session, "resume");
    expect(first.status).toBe(202);
    const spawnId = (JSON.parse(first.body) as { spawnId: string }).spawnId;
    const rec1 = await waitRecord(e, spawnId, (r) => r?.state === "live", 45_000, "live (first boot)");
    e.allowPi.add(rec1.pid!);
    expect(rec1.sessionFile).toBe(session.file); // goLive adopted pi's literal report
    expect(argvOf(e, rec1.pid!).argv.slice(-2)).toEqual(["--session", session.file]);
    expect(argvOf(e, rec1.pid!).argv).not.toContain("--model");

    await h.hub.close("restart"); // RESTORE_REASONS ⇒ the supervisor parks the record for restore
    h = await bootHub(e, { restore: true });
    const rec2 = await waitRecord(
      e,
      spawnId,
      (r) => r?.state === "live" && r?.pid !== rec1.pid,
      60_000,
      "live (restore re-fork)",
    );
    e.allowPi.add(rec2.pid!);
    expect(argvOf(e, rec2.pid!).argv.slice(-2)).toEqual(["--session", session.file]); // EXACT tail
    expect(argvOf(e, rec2.pid!).argv).not.toContain("--model");
    expect(rec2.sessionFile).toBe(session.file);
    // W6-adjacent invariant: the re-fork went live with NO swap detection, and the restore
    // path never created a fork snapshot (it re-forks --session directly)
    const log2 = readFileSync(join(e.stateDir, "hub.log"), "utf8");
    expect(log2.slice(log2.lastIndexOf("hub started"))).not.toContain("session-swapped");
    const forkSrcDir = webHubSpawnFiles(e.stateDir).forkSrcDir;
    expect(!existsSync(forkSrcDir) || readdirSync(forkSrcDir).length === 0).toBe(true);
  }, 180_000);

  it('RH2: fork → live with pi\'s OWN new file (outside forkSrcDir), snapshot unlinked → restart ⇒ argv tail ["--session", <new file>]', async () => {
    env = prepare();
    const e = env;
    const session = await createMainSession(e.agentDir, e.workdir, "rh2 fork source");

    let h = await bootHub(e, { restore: true });
    const first = await resume(h, e, session, "fork");
    expect(first.status).toBe(202);
    const spawnId = (JSON.parse(first.body) as { spawnId: string }).spawnId;
    const rec1 = await waitRecord(e, spawnId, (r) => r?.state === "live", 45_000, "live (fork)");
    e.allowPi.add(rec1.pid!);
    const forkSrcDir = webHubSpawnFiles(e.stateDir).forkSrcDir;
    expect(argvOf(e, rec1.pid!).argv[argvOf(e, rec1.pid!).argv.length - 4]).toBe("--fork"); // forked via snapshot
    const newFile = rec1.sessionFile!;
    expect(newFile.startsWith(`${forkSrcDir}/`)).toBe(false); // pi's own file, never the snapshot
    expect(newFile.endsWith(".jsonl")).toBe(true);
    expect(existsSync(newFile)).toBe(true);
    await waitUntil(
      () => !existsSync(forkSrcDir) || readdirSync(forkSrcDir).length === 0,
      15_000,
      "fork snapshot unlinked after live",
    );

    await h.hub.close("restart");
    h = await bootHub(e, { restore: true });
    const rec2 = await waitRecord(
      e,
      spawnId,
      (r) => r?.state === "live" && r?.pid !== rec1.pid,
      60_000,
      "live (restore re-fork)",
    );
    e.allowPi.add(rec2.pid!);
    expect(argvOf(e, rec2.pid!).argv.slice(-2)).toEqual(["--session", newFile]);
    expect(argvOf(e, rec2.pid!).argv).not.toContain("--fork"); // the re-fork resumes pi's file directly
  }, 180_000);

  it("RH3: restore OFF ⇒ restart ends the record exited{hub} with no new fork; a later resume from the history list still works", async () => {
    env = prepare();
    const e = env;
    const session = await createMainSession(e.agentDir, e.workdir, "rh3 restore off");

    let h = await bootHub(e, { restore: false });
    const first = await resume(h, e, session, "resume");
    expect(first.status).toBe(202);
    const spawnId = (JSON.parse(first.body) as { spawnId: string }).spawnId;
    const rec1 = await waitRecord(e, spawnId, (r) => r?.state === "live", 45_000, "live");
    e.allowPi.add(rec1.pid!);
    // only REAL pi forks matter for the "no restore fork" check — the reaper/watchdog node
    // children also carry the argv-log import hook and would pollute a raw line count
    const piForkLines = (): number =>
      readFileSync(e.argvLog, "utf8")
        .trim()
        .split("\n")
        .filter((l) => l.includes("--session") || l.includes("--fork")).length;
    const forksBefore = piForkLines();

    await h.hub.close("restart"); // restore off ⇒ terminate mode ⇒ stdin EOF ⇒ exited{hub}
    const rec = await waitRecord(e, spawnId, (r) => r?.state === "exited", 30_000, "exited{hub}");
    expect(rec.endReason).toBe("hub");
    h = await bootHub(e, { restore: false });
    await waitUntil(() => piForkLines() === forksBefore, 15_000, "no restore fork happened");

    // the session is still resumable from the list surface on the new hub
    const again = await resume(h, e, session, "resume");
    expect(again.status).toBe(202);
    const spawnId2 = (JSON.parse(again.body) as { spawnId: string }).spawnId;
    const rec2 = await waitRecord(e, spawnId2, (r) => r?.state === "live", 45_000, "live (manual re-resume)");
    expect(argvOf(e, rec2.pid!).argv.slice(-2)).toEqual(["--session", session.file]);
  }, 180_000);

  it("RH4 (documented product exception §14.1/W6: restore does not re-prove occupancy): a live comm=pi process visible to the new hub still gets the in-place --session re-fork", async () => {
    env = prepare();
    const e = env;
    const session = await createMainSession(e.agentDir, e.workdir, "rh4 restore occupancy");

    let h = await bootHub(e, { restore: true });
    const first = await resume(h, e, session, "resume");
    expect(first.status).toBe(202);
    const spawnId = (JSON.parse(first.body) as { spawnId: string }).spawnId;
    const rec1 = await waitRecord(e, spawnId, (r) => r?.state === "live", 45_000, "live");
    e.allowPi.add(rec1.pid!);

    await h.hub.close("restart");
    // between hubs: an UNCONNECTED live pi process, explicitly visible to the new hub's seam
    const stray = spawnTitleOnly(e);
    await waitUntil(
      () => {
        try {
          return readFileSync(`/proc/${stray.pid}/stat`, "utf8").includes("(pi)");
        } catch {
          return false;
        }
      },
      5_000,
      "stray comm=pi visible",
    );

    h = await bootHub(e, { restore: true });
    // W6: the restore re-fork never runs the occupancy proof — no 409, no fork snapshot, live
    const rec2 = await waitRecord(
      e,
      spawnId,
      (r) => r?.state === "live" && r?.pid !== rec1.pid,
      60_000,
      "restore re-fork despite stray pi",
    );
    expect(argvOf(e, rec2.pid!).argv.slice(-2)).toEqual(["--session", session.file]);
    const forkSrcDir = webHubSpawnFiles(e.stateDir).forkSrcDir;
    expect(!existsSync(forkSrcDir) || readdirSync(forkSrcDir).length === 0).toBe(true);
    const log2 = readFileSync(join(e.stateDir, "hub.log"), "utf8");
    expect(log2.slice(log2.lastIndexOf("hub started"))).not.toContain("session-swapped");
  }, 180_000);
});
