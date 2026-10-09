/**
 * web-hub session-history plan §4.8 step 3 (P-int) — the HH integration suite: REAL in-process
 * hub assembly (`startHub` + `createHttpFrontend`) × REAL fake-pi children, REAL /proc identity,
 * REAL signals, REAL fd-anchored fs — only the occupancy scan's two /proc views are narrowed
 * through the PD22 seams (a dev machine's live pi processes would otherwise force every resume
 * into a fork; see helpers/history-seam.ts — the SYNC re-stat is scoped the same way, or a
 * saturated farm's foreign pid churn surfaces as environmental 409s).
 *
 * HH7 (byte-identity with the feature off, through real main.ts/jiti hub processes) lives in
 * web-hub-headless.test.ts; HH13/HH14 (continuable enumeration over a 5 616-file tree, symlinked
 * dir never followed) live in web-hub-history-enum.test.ts; the libuv starvation suite lives in
 * web-hub-history-starvation.test.ts.
 */
import { spawn as spawnChild, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import { startHub, type RunningHub } from "../../src/web-hub/hub/hub.js";
import type { HistoryService } from "../../src/web-hub/hub/spawn/history/ports.js";
import type { HubConfig, HubSpawnConfig } from "../../src/web-hub/hub/ports.js";
import type { HistoryItemWire, HistoryPage } from "../../src/web-hub/protocol/session-history.js";
import { RESTORE_SESSION_ID_RE } from "../../src/web-hub/protocol/spawn.js";
import { webHubSpawnFiles } from "../../src/web-hub/protocol/paths.js";
import { login, openSse, postJson, rawRequest, type SseConn } from "../web-hub/http/helpers.js";
import { waitUntil } from "../web-hub/agent/helpers.js";
import { sandboxHome } from "./helpers/home-sandbox.js";
import { createHistoryProcSeam, type HistoryProcSeamOptions } from "./helpers/history-seam.js";

const FAKE_PI = resolve("tests/integration/fixtures/fake-rpc-pi.mjs");
const IS_LINUX = process.platform === "linux";

// ---------------------------------------------------------------------------
// local helpers (mode-B shape from web-hub-headless.test.ts, narrowed for history)
// ---------------------------------------------------------------------------

let idCounter = 0;
function spawnReqId(): string {
  idCounter += 1;
  return `hh${Date.now().toString(36)}${idCounter.toString(36).padStart(8, "0")}`;
}

function mkfifo(path: string): void {
  const res = spawnSync("mkfifo", [path], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`mkfifo failed: ${res.stderr}`);
}

function pidAlive(pid: number | undefined): boolean {
  if (pid === undefined || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: unknown }).code === "EPERM";
  }
}

function kill9(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/** Fixture launcher tree satisfying SP7's version chain (same shape as the headless suite). */
function fakeLauncher(root: string): readonly [string, string] {
  const pkgDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.0.2" }),
  );
  const entry = join(pkgDir, "pi.mjs");
  copyFileSync(FAKE_PI, entry);
  return [process.execPath, entry];
}

interface StoredRecord {
  spawnId: string;
  state?: string;
  pid?: number;
  endReason?: string;
  hint?: string;
  sessionId?: string;
  sessionFile?: string;
  from?: unknown;
  [k: string]: unknown;
}

function readSpawnsJson(stateDir: string): StoredRecord[] {
  const file = webHubSpawnFiles(stateDir).spawnsJson;
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { records?: StoredRecord[] };
  return parsed.records ?? [];
}

function recordOf(stateDir: string, spawnId: string): StoredRecord | undefined {
  return readSpawnsJson(stateDir).find((r) => r.spawnId === spawnId);
}

export interface HistSession {
  key: string;
  abs: string;
  id: string;
}

/**
 * A minimal REAL session file: pi's header line shape (the same `checkSessionHeader` validates),
 * the H0/P0 kind markers exactly as `head.ts` matches them, and a first user message in pi's
 * jsonl message shape (`"role":"user"` inside the first 256 bytes — the parser's requirement).
 */
export function writeSessionFile(
  agentDir: string,
  spec: {
    dirName: string;
    id: string;
    cwd: string;
    kind: "main" | "sub" | "unknown";
    firstMessage?: string;
    bigBytes?: number;
  },
): HistSession {
  const root = join(agentDir, "sessions");
  mkdirSync(join(root, spec.dirName), { recursive: true });
  const lines: string[] = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: spec.id,
      timestamp: new Date().toISOString(),
      cwd: spec.cwd,
    }),
  ];
  if (spec.kind === "main") {
    lines.push(JSON.stringify({ type: "custom", customType: "subagent:web-origin", v: 1 }));
  } else if (spec.kind === "sub") {
    lines.push(JSON.stringify({ type: "custom", customType: "subagent:child", v: 1 }));
  }
  if (spec.firstMessage !== undefined) {
    lines.push(
      JSON.stringify({
        type: "message",
        id: `m-${spec.id}`,
        timestamp: Date.now(),
        message: { role: "user", content: [{ type: "text", text: spec.firstMessage }] },
      }),
    );
  }
  if (spec.bigBytes !== undefined && spec.bigBytes > 0) {
    // filler message lines to give a fork snapshot real bulk (HH11/F13)
    const filler = JSON.stringify({
      type: "message",
      id: `m-${spec.id}-f`,
      timestamp: Date.now(),
      message: { role: "user", content: [{ type: "text", text: "x".repeat(32 * 1024) }] },
    });
    while (lines.join("\n").length < spec.bigBytes) lines.push(filler);
  }
  const fileName = `${spec.id}.jsonl`;
  const abs = join(root, spec.dirName, fileName);
  writeFileSync(abs, `${lines.join("\n")}\n`);
  return { key: `${spec.dirName}/${fileName}`, abs, id: spec.id };
}

interface HistHub {
  hub: RunningHub;
  port: number;
  stateDir: string;
  cookie: string;
  home: string;
  agentDir: string;
  allowPi: Set<number>;
  commOverride: Map<number, string>;
}

const histHubs: RunningHub[] = [];
const extraPids = new Set<number>();
const sseConns: SseConn[] = [];

async function bootHistoryHub(
  home: string,
  opts: { restore?: boolean; seam?: HistoryProcSeamOptions; registerTimeoutS?: number } = {},
): Promise<HistHub> {
  const allowPi = opts.seam?.allowPi ?? new Set<number>();
  const commOverride = opts.seam?.commOverride ?? new Map<number, string>();
  const spawn: HubSpawnConfig = {
    roots: [home],
    maxProcesses: 8,
    maxPerPrincipal: 8,
    ratePerMinute: 60,
    maxLifetimeMinutes: 720,
    // 3s is the H6-style sub-floor hook; tests whose fake pi deliberately sleeps BEFORE hello
    // (HH10/HH10b's --delay-open/--delay-session ≈ 1s, plus node boot under a loaded machine)
    // need more headroom or the register timer kills the child before the session frame.
    registerTimeoutS: opts.registerTimeoutS ?? 3,
    lan: "off",
    history: true,
    ...(opts.restore === true ? { restore: true } : {}),
  };
  const cfg: HubConfig = {
    v: 1,
    home,
    port: 0,
    idleExitMinutes: 10,
    pluginVersion: "1.2.3",
    buildId: "1.2.3@hh",
    launcher: fakeLauncher(home),
    spawn,
  };
  const seam = createHistoryProcSeam({ allowPi, commOverride });
  const started = await startHub(cfg, createHttpFrontend, {
    uid: process.getuid?.() ?? 0,
    childUmask: 0o022,
    spawnSeams: { historyProcFs: seam.procFs, historyProcSyncFs: seam.procSyncFs },
  });
  if ("exists" in started) throw new Error("unexpected singleton collision");
  histHubs.push(started);
  const cookie = await login(started.httpPort, started.paths.tokenFile);
  return {
    hub: started,
    port: started.httpPort,
    stateDir: started.paths.stateDir,
    cookie,
    home,
    agentDir: join(home, ".pi", "agent"),
    allowPi,
    commOverride,
  };
}

function origin(h: HistHub): string {
  return `http://127.0.0.1:${h.port}`;
}

async function listHistory(h: HistHub, query: string): Promise<HistoryPage> {
  const res = await rawRequest(h.port, {
    path: `/api/headless/history${query}`,
    headers: { Cookie: h.cookie, Origin: origin(h), "X-PWH": "1" },
  });
  expect(res.status).toBe(200);
  return JSON.parse(res.body) as HistoryPage;
}

async function headlessGet(h: HistHub): Promise<{ items?: Array<Record<string, unknown>> }> {
  const res = await rawRequest(h.port, {
    path: "/api/headless",
    headers: { Cookie: h.cookie, Origin: origin(h), "X-PWH": "1" },
  });
  expect(res.status).toBe(200);
  return JSON.parse(res.body) as { items?: Array<Record<string, unknown>> };
}

interface SessionOpen409 {
  error: string;
  reason: string;
  forkReason?: string;
  proofGap?: string;
  live?: { state?: string; by?: string; pid?: number };
  [k: string]: unknown;
}

async function postSpawn(h: HistHub, body: Record<string, unknown>): Promise<{ status: number; body: string }> {
  const res = await postJson(h.port, "/api/headless", body, { Cookie: h.cookie, Origin: origin(h) });
  return { status: res.status, body: res.body };
}

/** The standard resume/fork POST body for one session (kind must be `main` for resume to pass). */
function sessionBody(cwd: string, s: HistSession, mode: "resume" | "fork"): Record<string, unknown> {
  return { id: spawnReqId(), cwd, session: { key: s.key, id: s.id, mode } };
}

async function waitRecordLive(h: HistHub, spawnId: string, ms = 15_000): Promise<void> {
  await waitUntil(() => recordOf(h.stateDir, spawnId)?.state === "live", ms, `record ${spawnId} live`);
}

async function waitRecordTerminal(h: HistHub, spawnId: string, what: string): Promise<StoredRecord> {
  await waitUntil(
    () => ["exited", "failed"].includes(recordOf(h.stateDir, spawnId)?.state ?? ""),
    20_000,
    `record ${spawnId} terminal (${what})`,
  );
  return recordOf(h.stateDir, spawnId)!;
}

async function childPidOf(h: HistHub, spawnId: string): Promise<number> {
  await waitUntil(() => recordOf(h.stateDir, spawnId)?.pid !== undefined, 15_000, "record carries pid");
  return recordOf(h.stateDir, spawnId)!.pid!;
}

/** `<cwd>/.fake-pi-argv.log` — the fixture appends `{pid, argv}` per fork; argv is slice(2). */
function argvOf(cwd: string, pid: number): string[] {
  const file = join(cwd, ".fake-pi-argv.log");
  const raw = readFileSync(file, "utf8");
  for (const line of raw.trim().split("\n").reverse()) {
    if (line.length === 0) continue;
    const parsed = JSON.parse(line) as { pid: number; argv: string[] };
    if (parsed.pid === pid) return parsed.argv;
  }
  throw new Error(`no argv line for pid ${pid} in ${file}`);
}

function sha(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function waitChildrenGone(deadlineMs = 8_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (extraPids.size > 0 && Date.now() < deadline) {
    for (const pid of [...extraPids]) if (!pidAlive(pid)) extraPids.delete(pid);
    if (extraPids.size > 0) await new Promise((r) => setTimeout(r, 200));
  }
  for (const pid of [...extraPids]) kill9(pid);
  extraPids.clear();
}

describe.skipIf(!IS_LINUX)("web-hub session history — HH integration (in-process hub × fake pi)", () => {
  let sandbox: ReturnType<typeof sandboxHome> | undefined;

  afterEach(async () => {
    for (const c of sseConns.splice(0)) c.close();
    for (const h of histHubs.splice(0)) await h.close("test-teardown").catch(() => undefined);
    await waitChildrenGone();
    if (sandbox !== undefined) {
      sandbox.restore();
      if (process.env.KEEP_SANDBOX === undefined) {
        rmSync(sandbox.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
    sandbox = undefined;
  });

  function fresh(): { home: string; agentDir: string } {
    if (sandbox === undefined) sandbox = sandboxHome();
    return { home: sandbox.home, agentDir: join(sandbox.home, ".pi", "agent") };
  }

  it("HH1: list — kinds, grayed gone, kind filter, q search; enum complete", async () => {
    const { home, agentDir } = fresh();
    const workA = join(home, "workA");
    const workB = join(home, "workB");
    const workC = join(home, "workC");
    const workGone = join(home, "workGone");
    for (const d of [workA, workB, workC, workGone]) mkdirSync(d, { recursive: true });
    const needle = `hh1-needle-${Date.now().toString(36)}`;
    writeSessionFile(agentDir, { dirName: "d1", id: "hh1main0", cwd: workA, kind: "main", firstMessage: needle });
    writeSessionFile(agentDir, { dirName: "d1", id: "hh1sub000", cwd: workB, kind: "sub", firstMessage: "sub msg" });
    writeSessionFile(agentDir, { dirName: "d2", id: "hh1unk000", cwd: workC, kind: "unknown" });
    writeSessionFile(agentDir, { dirName: "d2", id: "hh1gone00", cwd: workGone, kind: "main", firstMessage: "gone" });
    rmSync(workGone, { recursive: true, force: true });

    const h = await bootHistoryHub(home);
    const all = await listHistory(h, "?kind=all");
    expect(all.stats.enum.complete).toBe(true);
    expect(all.stats.files).toBe(4);
    expect(all.incomplete).toBeUndefined();
    const byId = new Map(all.items.map((i) => [i.id, i]));
    expect(byId.get("hh1main0")?.cwdState).toBe("ok");
    expect(byId.get("hh1main0")?.startable).toBe(true);
    expect(byId.get("hh1main0")?.kind).toBe("main");
    const sub = byId.get("hh1sub000");
    expect(sub?.kind).toBe("sub");
    expect(sub?.forkOnly).toBe("subagent");
    expect(sub?.startable).toBe(true);
    const unk = byId.get("hh1unk000");
    expect(unk?.forkOnly).toBe("unverified");
    expect(unk?.proofGap).toBe("kind");
    const gone = byId.get("hh1gone00");
    expect(gone?.cwdState).toBe("gone");
    expect(gone?.blocked).toBe("gone");
    expect(gone?.startable).toBe(false);

    const mainOnly = await listHistory(h, "?kind=main");
    expect(mainOnly.items.map((i) => i.id).sort()).toEqual(["hh1gone00", "hh1main0", "hh1unk000"]);

    const found = await listHistory(h, `?kind=all&q=${encodeURIComponent(needle)}`);
    expect(found.items.map((i) => i.id)).toEqual(["hh1main0"]);
  }, 60_000);

  it('HH2: resume argv tail is exactly ["--session", abs]; live; from "history"; spawns.json carries no `from`', async () => {
    const { home, agentDir } = fresh();
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    const s = writeSessionFile(agentDir, { dirName: "d1", id: "hh2main00", cwd: work, kind: "main" });
    const h = await bootHistoryHub(home);

    const res = await postSpawn(h, sessionBody(work, s, "resume"));
    expect(res.status).toBe(202);
    const spawnId = (JSON.parse(res.body) as { spawnId: string }).spawnId;
    await waitRecordLive(h, spawnId);
    const pid = await childPidOf(h, spawnId);
    extraPids.add(pid);
    h.allowPi.add(pid);

    const argv = argvOf(work, pid);
    expect(argv[argv.length - 2]).toBe("--session");
    expect(argv[argv.length - 1]).toBe(s.abs); // byte-exact literal path
    expect(argv).not.toContain("--model");

    const list = await headlessGet(h);
    const item = list.items?.find((i) => i["spawnId"] === spawnId);
    expect(item?.["from"]).toBe("history");
    const stored = recordOf(h.stateDir, spawnId);
    expect(stored).toBeDefined();
    expect(Object.keys(stored!)).not.toContain("from");
    expect((stored as { sessionFile?: string }).sessionFile).toBeUndefined(); // restore off ⇒ never persisted
  }, 60_000);

  it("HH3: live card on the same session ⇒ 409 open/card ⇒ fork's argv tail is [--fork <snap> --session-id <uuid>]; source sha unchanged; snapshot unlinked after live", async () => {
    const { home, agentDir } = fresh();
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    const s = writeSessionFile(agentDir, {
      dirName: "d1",
      id: "hh3main00",
      cwd: work,
      kind: "main",
      firstMessage: "hh3 source",
    });
    const sourceSha = sha(s.abs);
    const h = await bootHistoryHub(home);

    // a fake TUI holding the SAME session id as a live registry card (C1)
    const tui = spawnChild(process.execPath, [FAKE_PI, "--mode", "rpc", "--session-id", s.id], {
      cwd: work,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    extraPids.add(tui.pid!);
    h.allowPi.add(tui.pid!);
    const sse = await openSse(h.port, { cookie: h.cookie });
    sseConns.push(sse);
    // the registry broadcasts `agents` on register (before the session slot lands) and a
    // `session` frame once the card reports — the latter is the observable "card holds sid"
    await sse.waitFor((e) => e.event === "session" && JSON.stringify(e.data).includes(s.id), 15_000, "card session");

    const open = await postSpawn(h, sessionBody(work, s, "resume"));
    expect(open.status).toBe(409);
    const openBody = JSON.parse(open.body) as SessionOpen409;
    expect(openBody.reason).toBe("session-open");
    expect(openBody.forkReason).toBe("open");
    expect(openBody.live?.by).toBe("card");
    expect(openBody.live?.pid).toBe(tui.pid);

    const fork = await postSpawn(h, sessionBody(work, s, "fork"));
    expect(fork.status).toBe(202);
    const spawnId = (JSON.parse(fork.body) as { spawnId: string }).spawnId;
    await waitRecordLive(h, spawnId);
    const pid = await childPidOf(h, spawnId);
    extraPids.add(pid);
    h.allowPi.add(pid);

    const argv = argvOf(work, pid);
    const forkSrcDir = webHubSpawnFiles(h.stateDir).forkSrcDir;
    expect(argv[argv.length - 4]).toBe("--fork");
    const snapPath = argv[argv.length - 3]!;
    expect(snapPath.startsWith(`${forkSrcDir}/`)).toBe(true);
    expect(argv[argv.length - 2]).toBe("--session-id");
    const newId = argv[argv.length - 1]!;
    expect(RESTORE_SESSION_ID_RE.test(newId)).toBe(true);

    expect(sha(s.abs)).toBe(sourceSha); // fork never touched the source
    await waitUntil(() => !existsSync(snapPath), 10_000, "fork snapshot unlinked after live");
    expect(readdirSync(forkSrcDir)).toEqual([]); // the whole dir is empty again
    // the fake wrote the new session file (outside forkSrcDir), parentSession dangling at the snapshot
    const newFile = join(h.agentDir, "sessions", "fake", `${newId}.jsonl`);
    expect(existsSync(newFile)).toBe(true);
    const header = JSON.parse(readFileSync(newFile, "utf8").split("\n", 1)[0]!) as {
      id?: string;
      parentSession?: string;
    };
    expect(header.id).toBe(newId);
    expect(header.parentSession).toBe(snapPath);

    const list = await headlessGet(h);
    const item = list.items?.find((i) => i["spawnId"] === spawnId);
    expect(item?.["from"]).toBe("fork");
    tui.kill("SIGKILL");
  }, 90_000);
  it("HH4: a second resume while the first record is starting ⇒ 409 open/managed", async () => {
    const { home, agentDir } = fresh();
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    const s = writeSessionFile(agentDir, { dirName: "d1", id: "hh4main00", cwd: work, kind: "main" });
    const h = await bootHistoryHub(home);

    const first = await postSpawn(h, sessionBody(work, s, "resume"));
    expect(first.status).toBe(202);
    const spawnId = (JSON.parse(first.body) as { spawnId: string }).spawnId;
    const pid = await childPidOf(h, spawnId);
    extraPids.add(pid);
    h.allowPi.add(pid);

    const second = await postSpawn(h, sessionBody(work, s, "resume"));
    expect(second.status).toBe(409);
    const body = JSON.parse(second.body) as SessionOpen409;
    expect(body.reason).toBe("session-open");
    expect(body.forkReason).toBe("open");
    expect(body.live?.by).toBe("managed");
    await waitRecordLive(h, spawnId);
  }, 60_000);

  it("HH5: deleted source file ⇒ 400 session-missing; no fork happened", async () => {
    const { home, agentDir } = fresh();
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    const s = writeSessionFile(agentDir, { dirName: "d1", id: "hh5main00", cwd: work, kind: "main" });
    const h = await bootHistoryHub(home);
    rmSync(s.abs);

    const res = await postSpawn(h, sessionBody(work, s, "resume"));
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: "E_DIR", reason: "session-missing" });
    expect(readSpawnsJson(h.stateDir)).toEqual([]);
    expect(existsSync(webHubSpawnFiles(h.stateDir).forkSrcDir)).toBe(false);
  }, 30_000);

  it("HH6: header cwd turned into a symlink ⇒ row shows moved + blocked; POST ⇒ 400 moved", async () => {
    const { home, agentDir } = fresh();
    const work = join(home, "work");
    const real = join(home, "work-real");
    mkdirSync(work, { recursive: true });
    const s = writeSessionFile(agentDir, { dirName: "d1", id: "hh6main00", cwd: work, kind: "main" });
    const h = await bootHistoryHub(home);
    renameSync(work, real);
    symlinkSync(real, work);

    const page = await listHistory(h, `?kind=all&q=${encodeURIComponent("hh6")}`);
    // q matches cwd — the symlinked path is still searchable, just not startable
    const items = page.items.length > 0 ? page.items : (await listHistory(h, "?kind=all")).items;
    const row = items.find((i) => i.id === "hh6main00");
    expect(row).toBeDefined();
    expect(row!.cwdState).toBe("moved");
    expect(row!.blocked).toBe("moved");
    expect(row!.startable).toBe(false);

    const res = await postSpawn(h, sessionBody(work, s, "resume"));
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: "E_DIR", reason: "moved" });
  }, 30_000);

  it("HH9: unconnected comm=pi process (—-title-only) ⇒ 409 maybe/unconnected-pi with its pid; killing it unblocks the resume", async () => {
    const { home, agentDir } = fresh();
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    const s = writeSessionFile(agentDir, { dirName: "d1", id: "hh9main00", cwd: work, kind: "main" });
    const h = await bootHistoryHub(home);

    const stray = spawnChild(process.execPath, [FAKE_PI, "--mode", "rpc", "--title-only"], {
      cwd: work,
      env: { ...process.env },
      stdio: ["ignore", "ignore", "ignore"],
    });
    extraPids.add(stray.pid!);
    h.allowPi.add(stray.pid!); // visible to the scan on purpose — no card/record will match it
    await waitUntil(
      () => {
        try {
          return readFileSync(`/proc/${stray.pid}/stat`, "utf8").includes("(pi)");
        } catch {
          return false;
        }
      },
      5_000,
      "stray pi title visible in /proc",
    );

    const blocked = await postSpawn(h, sessionBody(work, s, "resume"));
    expect(blocked.status).toBe(409);
    const body = JSON.parse(blocked.body) as SessionOpen409;
    expect(body.reason).toBe("session-open");
    expect(body.forkReason).toBe("maybe");
    expect(body.proofGap).toBe("unconnected-pi");
    expect(body.live?.pid).toBe(stray.pid);

    kill9(stray.pid);
    extraPids.delete(stray.pid);
    // SIGKILL delivery is fast but not instantaneous — the next prove must not see it dying
    await waitUntil(() => !pidAlive(stray.pid), 5_000, "stray fully gone");
    const okRes = await postSpawn(h, sessionBody(work, s, "resume"));
    expect(okRes.status).toBe(202);
    const spawnId = (JSON.parse(okRes.body) as { spawnId: string }).spawnId;
    const pid = await childPidOf(h, spawnId);
    extraPids.add(pid);
    h.allowPi.add(pid);
    await waitRecordLive(h, spawnId);
  }, 60_000);

  it("HH9b (PID reuse shape): prove saw pid P as bash, the sync re-prove sees its real comm ⇒ 409 new-process, start never called", async () => {
    const { home, agentDir } = fresh();
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    const s = writeSessionFile(agentDir, { dirName: "d1", id: "hh9bmain0", cwd: work, kind: "main" });
    const h = await bootHistoryHub(home);

    // a real same-uid process the async scan will MIS-report as bash; the sync re-stat reads
    // the true comm (node*) ⇒ reused-pid shape ⇒ new-process with exactly this pid
    const p = spawnChild(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], {
      cwd: work,
      env: { ...process.env },
      stdio: ["ignore", "ignore", "ignore"],
    });
    extraPids.add(p.pid!);
    h.commOverride.set(p.pid!, "bash");

    const res = await postSpawn(h, sessionBody(work, s, "resume"));
    expect(res.status).toBe(409);
    const body = JSON.parse(res.body) as SessionOpen409;
    expect(body.reason).toBe("session-open");
    expect(body.proofGap).toBe("new-process");
    expect(body.live?.state).toBe("maybe");
    expect(body.live?.pid).toBe(p.pid);
    // the sync stretch rejected BEFORE supervisor.start(): no record, no fork, no snapshot
    expect(readSpawnsJson(h.stateDir)).toEqual([]);
    expect(existsSync(webHubSpawnFiles(h.stateDir).forkSrcDir)).toBe(false);
  }, 60_000);

  it("HH10: session file swapped away and NOT restored ⇒ stopping/terminal with session-swapped; the stand-in only ever gets the touch line; spawns.json never adopts it", async () => {
    const { home, agentDir } = fresh();
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, ".fake-pi-switches"), "--delay-open\n500\n"); // one argv element per line
    const s = writeSessionFile(agentDir, {
      dirName: "d1",
      id: "hh10main0",
      cwd: work,
      kind: "main",
      firstMessage: "hh10 original",
    });
    const originalSha = sha(s.abs);
    const h = await bootHistoryHub(home, { restore: true, registerTimeoutS: 10 });

    const res = await postSpawn(h, sessionBody(work, s, "resume"));
    expect(res.status).toBe(202);
    const spawnId = (JSON.parse(res.body) as { spawnId: string }).spawnId;
    const pid = await childPidOf(h, spawnId);
    extraPids.add(pid);
    h.allowPi.add(pid);

    // swap the file under the child during its --delay-open window
    const stash = join(home, "stash", "original.jsonl");
    mkdirSync(dirname(stash), { recursive: true });
    renameSync(s.abs, stash);
    const standIn = writeSessionFile(agentDir, {
      dirName: "d1",
      id: s.id,
      cwd: work,
      kind: "main",
      firstMessage: "hh10 STAND-IN",
    });
    expect(standIn.abs).toBe(s.abs);

    const rec = await waitRecordTerminal(h, spawnId, "session-swapped stop");
    expect(rec.endReason).toBe("protocol_error");
    // the ORIGINAL is byte-identical (moved away before the fake ever opened anything)
    expect(sha(stash)).toBe(originalSha);
    // the stand-in got exactly one touch line beyond its own content — nothing else was written
    const standInText = readFileSync(standIn.abs, "utf8");
    expect(standInText).toContain("fake-pi:touch");
    expect(standInText).toContain("hh10 STAND-IN");
    expect(standInText).not.toContain("hh10 original");
    // audit carries the non-persisted code; spawns.json never adopted the stand-in coordinates
    const log = readFileSync(join(h.stateDir, "hub.log"), "utf8");
    expect(log).toContain("session-swapped");
    expect((recordOf(h.stateDir, spawnId) as { sessionFile?: string }).sessionFile).toBeUndefined();
    expect(readSpawnsJson(h.stateDir).some((r) => (r.sessionFile ?? "") === standIn.abs)).toBe(false);
  }, 90_000);

  it("HH10b: documented limitation (W7): swap-and-restore is undetectable — the record goes live with NO hintDetail", async () => {
    const { home, agentDir } = fresh();
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, ".fake-pi-switches"), "--delay-open\n300\n--delay-session\n2500\n"); // one argv element per line
    const s = writeSessionFile(agentDir, {
      dirName: "d1",
      id: "hh10bmain",
      cwd: work,
      kind: "main",
      firstMessage: "hh10b original",
    });
    const originalSha = sha(s.abs);
    const h = await bootHistoryHub(home, { restore: true, registerTimeoutS: 15 });

    const res = await postSpawn(h, sessionBody(work, s, "resume"));
    expect(res.status).toBe(202);
    const spawnId = (JSON.parse(res.body) as { spawnId: string }).spawnId;
    const pid = await childPidOf(h, spawnId);
    extraPids.add(pid);
    h.allowPi.add(pid);

    const stash = join(home, "stash", "original.jsonl");
    const standInPath = join(home, "stash", "stand-in.jsonl");
    mkdirSync(dirname(stash), { recursive: true });
    renameSync(s.abs, stash);
    const standIn = writeSessionFile(agentDir, {
      dirName: "d1",
      id: s.id,
      cwd: work,
      kind: "main",
      firstMessage: "hh10b STAND-IN",
    });
    expect(standIn.abs).toBe(s.abs);

    // wait for the fake to open + touch the stand-in, then restore the original BEFORE the
    // session frame goes out — the 2.5 s --delay-session window tolerates event-loop lag on a
    // loaded machine (a lost race would end the record failed{protocol_error} instead of live)
    await waitUntil(
      () => {
        try {
          return readFileSync(standIn.abs, "utf8").includes("fake-pi:touch");
        } catch {
          return false;
        }
      },
      10_000,
      "fake touched stand-in",
    );
    renameSync(standIn.abs, standInPath);
    renameSync(stash, s.abs); // original back at the pinned path

    try {
      await waitRecordLive(h, spawnId, 40_000);
    } catch (err) {
      // flake forensics: dump what the record, the owner view, the hub log and both files
      // actually did before rethrowing (hintDetail names the exact failing check)
      const owner = await headlessGet(h).catch(() => ({}) as { items?: Array<Record<string, unknown>> });
      console.error(
        "HH10b live-timeout forensics:",
        JSON.stringify({
          record: recordOf(h.stateDir, spawnId),
          ownerItem: owner.items?.find((i) => i["spawnId"] === spawnId),
          log: readFileSync(join(h.stateDir, "hub.log"), "utf8").slice(-2_000),
          standInHasTouch: existsSync(standInPath) && readFileSync(standInPath, "utf8").includes("fake-pi:touch"),
          originalBack: existsSync(s.abs) && !readFileSync(s.abs, "utf8").includes("fake-pi:touch"),
          argv: existsSync(join(work, ".fake-pi-argv.log"))
            ? readFileSync(join(work, ".fake-pi-argv.log"), "utf8").trim()
            : "none",
          switches: existsSync(join(work, ".fake-pi-switches"))
            ? readFileSync(join(work, ".fake-pi-switches"), "utf8")
            : "none",
          childStderr: existsSync(join(webHubSpawnFiles(h.stateDir).logDir, `${spawnId}.stderr.log`))
            ? readFileSync(join(webHubSpawnFiles(h.stateDir).logDir, `${spawnId}.stderr.log`), "utf8").slice(0, 500)
            : "none",
        }),
      );
      throw err;
    }
    const list = await headlessGet(h);
    const item = list.items?.find((i) => i["spawnId"] === spawnId);
    expect(item?.["hintDetail"]).toBeUndefined(); // W7: undetectable — no false positive either
    expect(item?.["state"]).toBe("live");
    // inode evidence: the original (restored) was never written; the stand-in carries the touch
    expect(sha(s.abs)).toBe(originalSha);
    expect(readFileSync(s.abs, "utf8")).not.toContain("fake-pi:touch");
    expect(readFileSync(standInPath, "utf8")).toContain("fake-pi:touch");
  }, 90_000);

  it("HH11: --no-hello child on a bulky source ⇒ failed{register_timeout}, no surviving process, fork snapshot cleaned", async () => {
    const { home, agentDir } = fresh();
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, ".fake-pi-switches"), "--no-hello\n");
    const s = writeSessionFile(agentDir, {
      dirName: "d1",
      id: "hh11main0",
      cwd: work,
      kind: "main",
      bigBytes: 4 * 1024 * 1024,
    });
    const h = await bootHistoryHub(home);

    const res = await postSpawn(h, sessionBody(work, s, "fork"));
    expect(res.status).toBe(202);
    const spawnId = (JSON.parse(res.body) as { spawnId: string }).spawnId;
    const pid = await childPidOf(h, spawnId);
    extraPids.add(pid);

    const rec = await waitRecordTerminal(h, spawnId, "register timeout");
    expect(rec.state).toBe("failed");
    expect(rec.endReason).toBe("register_timeout");
    await waitUntil(() => !pidAlive(pid), 10_000, "no surviving child process");
    const forkSrcDir = webHubSpawnFiles(h.stateDir).forkSrcDir;
    await waitUntil(() => !existsSync(forkSrcDir) || readdirSync(forkSrcDir).length === 0, 10_000, "snapshot cleaned");
  }, 90_000);

  it("HH12: a session file replaced by a FIFO after the gen was built ⇒ the list still answers in budget, the file counts invalid, the hub stays responsive", async () => {
    const { home, agentDir } = fresh();
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    const first = writeSessionFile(agentDir, { dirName: "d1", id: "hh12main0", cwd: work, kind: "main" });
    const second = writeSessionFile(agentDir, { dirName: "d1", id: "hh12sec00", cwd: work, kind: "main" });
    // HH12's F20 premise is deterministic only when the swapped file's header was NEVER read:
    // the service-scoped header index (PD8) would otherwise still hold the pre-swap entry, and
    // the fd-anchored page walk compares against the ENUMERATED identity — so limit the first
    // list to ONE item, leaving exactly one file with no cached header to poison the walk.
    // one file with no cached header (see the comment above)
    const h = await bootHistoryHub(home);
    const page1 = await listHistory(h, "?kind=all&limit=1");
    expect(page1.stats.enum.complete).toBe(true);
    expect(page1.items).toHaveLength(1);
    const listedId = page1.items[0]!.id;
    const target = listedId === first.id ? second : first;

    renameSync(target.abs, `${target.abs}.real`);
    mkfifo(target.abs);

    const t0 = Date.now();
    const page2 = await listHistory(h, "?kind=all");
    expect(Date.now() - t0).toBeLessThan(5_000); // HISTORY_REQ_TOTAL_MS-shaped bound; never a hang
    expect(page2.items.map((i) => i.id)).not.toContain(target.id);
    expect(page2.stats.invalid ?? 0).toBeGreaterThanOrEqual(1);

    // the hub's request loop is still healthy (plan names /api/hub; this build's equivalent
    // always-on surface is GET /api/headless — same loopback auth pipeline)
    const alive = await rawRequest(h.port, {
      path: "/api/headless",
      headers: { Cookie: h.cookie, Origin: origin(h), "X-PWH": "1" },
    });
    expect(alive.status).toBe(200);
  }, 60_000);
});
