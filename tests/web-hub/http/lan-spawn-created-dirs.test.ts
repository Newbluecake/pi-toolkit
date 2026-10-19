/**
 * created-dirs plan r2 §6 (P2): the LAN face of "hub-created folders are known spawn dirs".
 * REAL `createDirService` + REAL created-dirs store + REAL mkdir service (real tmp fs) behind the
 * REAL `createSpawnRoutes` through the REAL plaintext LAN listener; only the supervisor / first
 * prompt are spawn-kit fakes. This file deliberately lives OUTSIDE the F5 golden include globs
 * (`*headless*.test.ts`) — new cases here never need a golden fixture entry.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCreatedDirsStore } from "../../../src/web-hub/hub/spawn/created-dirs.js";
import { createDirService } from "../../../src/web-hub/hub/spawn/dirs.js";
import { createMkdirService } from "../../../src/web-hub/hub/spawn/mkdir.js";
import { denyCtxOf } from "../../../src/web-hub/hub/preview/admit.js";
import { createPreviewIoTracker } from "../../../src/web-hub/hub/preview/fs.js";
import type { HubSpawnConfig, SpawnPolicyWire } from "../../../src/web-hub/protocol/spawn.js";
import { fakeClock, lanPostJson, lanRequest, seedLanUser, startLan, type LanHarness } from "./lan-helpers.js";
import { makeTmp } from "./helpers.js";
import { ALLOWED_POLICY, spawnKit, type SpawnKit } from "./spawn-kit.js";

let tmp: ReturnType<typeof makeTmp>;
let root: string;
let outside: string;
let h: LanHarness | undefined;

beforeEach(() => {
  tmp = makeTmp("pwh-created-lan-");
  root = join(tmp.dir, "root");
  outside = join(tmp.dir, "outside");
  mkdirSync(root);
  mkdirSync(outside);
});
afterEach(async () => {
  if (h !== undefined) await h.cleanup();
  h = undefined;
  tmp.cleanup();
});

/** The real supervisor's scope expression (pre-refactor spelling), so the fake answers truthfully. */
function policyFor(lan: HubSpawnConfig["lan"]) {
  return (args: { scheme: "http" | "https"; viaTrustedProxy: boolean }): SpawnPolicyWire => ({
    ...ALLOWED_POLICY,
    confirm: "always",
    scope: lan === "roots" && !(args.scheme === "http" && !args.viaTrustedProxy) ? "roots" : "known",
  });
}

interface Rig {
  kit: SpawnKit;
  storeFile: string;
  cookie: string;
  now: { t: number };
}

async function rig(
  lan: HubSpawnConfig["lan"],
  lanCfg: Parameters<typeof startLan>[0]["cfg"] = {},
  proxied = false,
): Promise<Rig> {
  const now = { t: Date.now() };
  const clockFn = (): number => now.t;
  const log = spawnKit({}, fakeClock()).log;
  const storeFile = join(tmp.dir, "state", "spawn", "created-dirs.json");
  const store = createCreatedDirsStore({ file: storeFile, log, now: clockFn });
  const dirs = createDirService({
    home: tmp.dir,
    agentDir: join(tmp.dir, ".pi/agent"),
    roots: [root],
    registry: { list: () => [] },
    spawnHistory: () => [],
    now: clockFn,
    createdDirs: () => store.list(),
  });
  const mkdir = createMkdirService({
    denyCtx: denyCtxOf(tmp.dir, join(tmp.dir, ".pi/agent")),
    tracker: createPreviewIoTracker(),
    log,
    now: clockFn,
    identify: true,
  });
  const kit = spawnKit({ lan, roots: [root] }, fakeClock(), undefined, undefined, mkdir, undefined, {
    dirs,
    createdDirs: store,
  });
  kit.supervisor.setPolicy(policyFor(lan));
  h = await startLan({ spawn: kit.spawn, cfg: lanCfg });
  seedLanUser(h.store, { id: 1, username: "alice", password: "correct-horse-battery" });
  const login = await lanPostJson(
    h.port,
    "/api/login",
    { username: "alice", password: "correct-horse-battery" },
    proxied ? { Host: `127.0.0.1:${h.port}`, ...PROXY_HEADERS } : {},
  );
  expect(login.status).toBe(200);
  return { kit, storeFile, cookie: (login.headers["set-cookie"]?.[0] ?? "").split(";")[0]!, now };
}

const PROXY_HEADERS = {
  Origin: "https://hub.example.test",
  "X-Forwarded-Proto": "https",
  "X-Forwarded-Host": "hub.example.test",
};

function post(r: Rig, path: string, body: unknown, extra: Record<string, string> = {}) {
  return lanPostJson(h!.port, path, body, { Cookie: r.cookie, ...extra });
}
const mkdirOn = (r: Rig, parent: string, name: string, extra: Record<string, string> = {}) =>
  post(r, "/api/headless/mkdir", { path: parent, name }, extra);

let seq = 0;
const spawnBody = (cwd: string, more: Record<string, unknown> = {}) => {
  seq += 1;
  return { id: `created-lan-${String(seq).padStart(8, "0")}`, cwd, ...more };
};

describe("LAN plaintext: mkdir inside roots ⇒ known ⇒ spawn (confirm still always)", () => {
  it("mkdir ⇒ known:true + audit + 0600 store; spawn ⇒ 409 always ⇒ confirm ⇒ 202 with viaCreated", async () => {
    const r = await rig("roots");
    const m = await mkdirOn(r, root, "fresh");
    expect(m.status).toBe(200);
    const created = join(root, "fresh");
    expect(JSON.parse(m.body)).toEqual({ ok: true, path: created, known: true });
    expect(existsSync(created)).toBe(true);
    // persisted, 0600, provenance only
    expect(statSync(r.storeFile).mode & 0o777).toBe(0o600);
    const disk = JSON.parse(readFileSync(r.storeFile, "utf8"));
    expect(disk.v).toBe(1);
    expect(disk.entries).toHaveLength(1);
    expect(disk.entries[0]).toMatchObject({ path: created, by: { listener: "lan", user: "u1" } });
    // the audit line carries known:true and still no path
    const audit = r.kit.log.lines.filter(
      (l) => l.msg === "spawn" && (l.data as { endpoint?: string } | undefined)?.endpoint === "mkdir",
    );
    expect(audit.at(-1)?.data).toMatchObject({ phase: "request", endpoint: "mkdir", known: true });
    expect(JSON.stringify(audit)).not.toContain(created);

    // the display list (GET /dirs) shows it and it is admissible below
    const list = await lanRequest(h!.port, {
      method: "GET",
      path: "/api/headless/dirs",
      headers: { Cookie: r.cookie, "X-PWH": "1" },
    });
    expect(list.status).toBe(200);
    expect(JSON.parse(list.body).recent.map((e: { cwd: string }) => e.cwd)).toContain(created);

    // plaintext LAN ⇒ scope known; the created dir is admitted (the real scan was triggered by
    // the invalidate + this admit — never raced), confirm:"always" is unchanged.
    const body = spawnBody(created);
    const first = await post(r, "/api/headless", body);
    expect(first.status).toBe(409);
    expect(JSON.parse(first.body)).toEqual({ error: "E_CONFIRM_REQUIRED", resolvedCwd: created, reason: "always" });
    const second = await post(r, "/api/headless", { ...body, confirm: true, expectCwd: created });
    expect(second.status).toBe(202);
    expect(r.kit.supervisor.startCalls).toHaveLength(1);
    expect(r.kit.supervisor.startCalls[0]!.admitted).toMatchObject({
      realpath: created,
      known: true,
      viaCreated: true,
    });
  });

  it("mkdir OUTSIDE roots ⇒ plain {ok,path} (no known), nothing recorded, spawn there ⇒ 400 detail plaintext-lan", async () => {
    const r = await rig("roots");
    const m = await mkdirOn(r, outside, "elsewhere");
    expect(m.status).toBe(200);
    const created = join(outside, "elsewhere");
    expect(JSON.parse(m.body)).toEqual({ ok: true, path: created });
    expect(existsSync(r.storeFile)).toBe(false);
    const res = await post(r, "/api/headless", spawnBody(created));
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "E_DIR", reason: "not-allowed", detail: "plaintext-lan" });
    expect(r.kit.supervisor.startCalls).toHaveLength(0);
  });

  it("replaced dir (new inode, same path) ⇒ not-allowed, on a fresh scan AND on a cached scan", async () => {
    const r = await rig("roots");
    const created = join(root, "swap");
    expect((await mkdirOn(r, root, "swap")).status).toBe(200);
    // warm the created cache with a good admit
    const warm = await post(r, "/api/headless", spawnBody(created));
    expect(warm.status).toBe(409);
    // replace the directory under the SAME path (cached scan still holds the old inode)
    // (rename, not rm: a freed inode number is routinely reused by the next mkdir on tmpfs)
    renameSync(created, join(outside, "swap-old"));
    mkdirSync(created);
    expect(statSync(created).ino).not.toBe(statSync(join(outside, "swap-old")).ino);
    const cached = await post(r, "/api/headless", spawnBody(created));
    expect(cached.status).toBe(400);
    expect(JSON.parse(cached.body)).toMatchObject({ reason: "not-allowed", detail: "plaintext-lan" });
    // …and after a clock jump past the 60 s cache a fresh scan reaches the same verdict
    r.now.t += 61_000;
    const fresh = await post(r, "/api/headless", spawnBody(created));
    expect(fresh.status).toBe(400);
    expect(JSON.parse(fresh.body)).toMatchObject({ reason: "not-allowed", detail: "plaintext-lan" });
    expect(r.kit.supervisor.startCalls).toHaveLength(0);
  });

  it("a created dir moved out of the root with a symlink planted back is refused (identity alone is not enough)", async () => {
    const r = await rig("roots");
    const created = join(root, "mv");
    expect((await mkdirOn(r, root, "mv")).status).toBe(200);
    renameSync(created, join(outside, "mv-moved"));
    symlinkSync(join(outside, "mv-moved"), created);
    const res = await post(r, "/api/headless", spawnBody(created));
    // realpath(created) now lives outside the root ⇒ the created record (path-keyed) no longer matches
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: "E_DIR", reason: "not-allowed", detail: "plaintext-lan" });
  });

  it("expired record (30 d + 1 s later) is no longer known", async () => {
    const r = await rig("roots");
    const created = join(root, "old");
    expect((await mkdirOn(r, root, "old")).status).toBe(200);
    expect((await post(r, "/api/headless", spawnBody(created))).status).toBe(409);
    r.now.t += 30 * 24 * 3600 * 1000 + 1000;
    const res = await post(r, "/api/headless", spawnBody(created));
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ reason: "not-allowed", detail: "plaintext-lan" });
  });
});

describe("LAN E_DIR detail by cap", () => {
  it("lan:known ⇒ detail lan-known for an unknown directory", async () => {
    const r = await rig("known");
    const res = await post(r, "/api/headless", spawnBody(outside));
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "E_DIR", reason: "not-allowed", detail: "lan-known" });
  });

  it("other E_DIR reasons never carry detail (LAN)", async () => {
    const r = await rig("known");
    const res = await post(r, "/api/headless", spawnBody(join(tmp.dir, "does-not-exist")));
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "E_DIR", reason: "not-found" });
  });

  it("lan:roots via a trusted https proxy ⇒ roots scope ⇒ a root miss is outside-roots; a root hit is admitted", async () => {
    const r = await rig(
      "roots",
      { trustProxyFrom: ["127.0.0.1"], externalOrigins: ["https://hub.example.test"] },
      true,
    );
    const via = { Host: `127.0.0.1:${h!.port}`, ...PROXY_HEADERS };
    const miss = await post(r, "/api/headless", spawnBody(outside), via);
    expect(miss.status).toBe(400);
    expect(JSON.parse(miss.body)).toEqual({ error: "E_DIR", reason: "not-allowed", detail: "outside-roots" });
    // a directory inside a root needs no created record at all under the roots scope
    const inside = join(root, "plain");
    mkdirSync(inside);
    const hit = await post(r, "/api/headless", spawnBody(inside), via);
    expect(hit.status).toBe(409); // confirm:"always" — admitted
    expect(JSON.parse(hit.body)).toMatchObject({ resolvedCwd: inside, reason: "always" });
  });
});
