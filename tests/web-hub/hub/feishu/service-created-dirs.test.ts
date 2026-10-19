/**
 * created-dirs plan r2 §6 (P2): the Feishu bot widens with hub-created dirs exactly like the
 * web. REAL `createDirService` + REAL created-dirs store (tmp fs) behind the bot's `deps.spawn`
 * port (fake supervisor, same `spawnPort()` shape as service.test.ts), `spawnScope:"known"`:
 * a created dir starts without any confirm/unknown-dir notice; expired / replaced / out-of-roots
 * records stay unknown (notice, zero starts).
 */
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eventually, f8Rig, sentContent } from "../../../fixtures/feishu/f8.js";
import { messageEnvelope } from "../../../fixtures/feishu/f6.js";
import { createCreatedDirsStore, CREATED_DIRS_TTL_MS } from "../../../../src/web-hub/hub/spawn/created-dirs.js";
import { createDirService } from "../../../../src/web-hub/hub/spawn/dirs.js";
import { fakeFirstPrompt, fakeSpawnPrefs, fakeSpawnSupervisor } from "../../http/spawn-kit.js";
import { memLog } from "../helpers.js";

const cleanups: Array<() => Promise<void>> = [];
let tmp: string;
let root: string;
let outside: string;
const clock = { t: Date.now() };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "feishu-created-"));
  root = join(tmp, "root");
  outside = join(tmp, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  clock.t = Date.now();
});
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function realSpawnPort() {
  const store = createCreatedDirsStore({
    file: join(tmp, "state", "created-dirs.json"),
    log: memLog(),
    now: () => clock.t,
  });
  const dirs = createDirService({
    home: tmp,
    agentDir: join(tmp, ".pi/agent"),
    roots: [root],
    registry: { list: () => [] },
    spawnHistory: () => [],
    now: () => clock.t,
    createdDirs: () => store.list(),
  });
  const supervisor = fakeSpawnSupervisor();
  const port = {
    supervisor,
    dirs,
    firstPrompt: fakeFirstPrompt(),
    prefs: fakeSpawnPrefs(),
    registerTimeoutS: 30,
    restore: true,
    relaunch: supervisor.relaunch,
    lookup: () => undefined,
  };
  const record = (path: string) => {
    const st = statSync(path);
    expect(store.add({ path, dev: st.dev, ino: st.ino }, { listener: "lan" })).toEqual({ ok: true });
  };
  return { port, record, supervisor };
}

async function rig(port: ReturnType<typeof realSpawnPort>["port"]) {
  const r = await f8Rig({ spawn: port }, { spawnScope: "known" });
  cleanups.push(() => r.close());
  await r.ready();
  return r;
}
const UNKNOWN_NOTICE = "该目录不在已知目录中";

describe("Feishu spawnScope:known × hub-created dirs (real DirService + real store)", () => {
  it("a created dir inside the root starts directly — no confirm card, no unknown-dir notice", async () => {
    const { port, record, supervisor } = realSpawnPort();
    const dir = join(root, "made");
    mkdirSync(dir);
    record(dir);
    const r = await rig(port);
    r.send(messageEnvelope("created", `/new ${dir} first task`));
    await eventually(() => expect(supervisor.startCalls).toHaveLength(1));
    expect(supervisor.startCalls[0]!.admitted).toMatchObject({ realpath: dir, known: true, viaCreated: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sentContent(r)).not.toContain(UNKNOWN_NOTICE);
  });

  it("an unrecorded directory under the same root is still unknown (control)", async () => {
    const { port, supervisor } = realSpawnPort();
    const dir = join(root, "never-recorded");
    mkdirSync(dir);
    const r = await rig(port);
    r.send(messageEnvelope("control", `/new ${dir} x`));
    await eventually(() => expect(sentContent(r)).toContain(UNKNOWN_NOTICE));
    expect(supervisor.startCalls).toHaveLength(0);
  });

  it("expired record (clock +31 d) ⇒ unknown-dir notice, zero starts", async () => {
    const { port, record, supervisor } = realSpawnPort();
    const dir = join(root, "stale");
    mkdirSync(dir);
    record(dir);
    clock.t += CREATED_DIRS_TTL_MS + 24 * 3600 * 1000;
    const r = await rig(port);
    r.send(messageEnvelope("expired", `/new ${dir} x`));
    await eventually(() => expect(sentContent(r)).toContain(UNKNOWN_NOTICE));
    expect(supervisor.startCalls).toHaveLength(0);
  });

  it("replaced directory (new inode at the recorded path) ⇒ unknown-dir notice, zero starts", async () => {
    const { port, record, supervisor } = realSpawnPort();
    const dir = join(root, "swapped");
    mkdirSync(dir);
    record(dir);
    renameSync(dir, join(outside, "swapped-old")); // keep the old inode alive so the new one differs
    mkdirSync(dir);
    const r = await rig(port);
    r.send(messageEnvelope("replaced", `/new ${dir} x`));
    await eventually(() => expect(sentContent(r)).toContain(UNKNOWN_NOTICE));
    expect(supervisor.startCalls).toHaveLength(0);
  });

  it("a record whose path is outside every root ⇒ unknown-dir notice, zero starts", async () => {
    const { port, record, supervisor } = realSpawnPort();
    const dir = join(outside, "foreign");
    mkdirSync(dir);
    record(dir); // the store itself is path-agnostic; DirService's roots check is what refuses
    const r = await rig(port);
    r.send(messageEnvelope("outside", `/new ${dir} x`));
    await eventually(() => expect(sentContent(r)).toContain(UNKNOWN_NOTICE));
    expect(supervisor.startCalls).toHaveLength(0);
  });
});
