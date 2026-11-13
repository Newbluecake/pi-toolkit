/** Owned local trust channel: real files/proc, no fake physical release verifier. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeTerminalStore,
  TERMINAL_LOCAL_DIR,
  TerminalLocalError,
  writePhysicalReceipt,
  localProcess,
  type TerminalReceiptContext,
} from "../../src/web-hub/protocol/terminal-local.js";
import { TERMINAL_JOURNAL_FILE } from "../../src/web-hub/protocol/terminal.js";
import { createTerminalTestBackend, type TerminalBackend } from "../../src/web-hub/agent/terminal/backend.js";
import { makeTerminalFixture } from "./web-hub-terminal-fixture.js";
const roots: string[] = [],
  backends: TerminalBackend[] = [],
  extras: Array<() => void> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const backend of backends.splice(0)) {
    backend.close();
    await backend.done;
  }
  for (const cleanup of extras.splice(0)) cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function state() {
  const dir = mkdtempSync(join(tmpdir(), "tls-"));
  chmodSync(dir, 0o700);
  roots.push(dir);
  return dir;
}
const physical = {
  outcome: "reaped" as const,
  spawnSettled: true as const,
  ptyClosed: true as const,
  helperReaped: true as const,
  managedGroupsGone: true as const,
  identitiesChecked: [],
  waited: [],
};
async function context(stateDir = state()): Promise<TerminalReceiptContext> {
  const store = await initializeTerminalStore(stateDir);
  return {
    store,
    ownerRecordId: "o".repeat(32),
    agentProcessIdentity: localProcess(process.pid),
    identity: {
      agentSessionId: "session",
      termId: "term",
      epoch: "epoch",
      ownerInstance: "owner",
      reservationId: "reservation",
    },
  };
}
describe("first-use authority is exclusive directory creation, never missing-journal inference", () => {
  it("creates exactly one owned700 store/600 journal/marker and reopens without resetting its identity", async () => {
    const dir = state(),
      first = await initializeTerminalStore(dir);
    expect(first.root).toBe(join(dir, TERMINAL_LOCAL_DIR));
    expect(statSync(first.root).mode & 0o777).toBe(0o700);
    for (const file of [
      join(first.root, "initialized"),
      join(first.root, TERMINAL_JOURNAL_FILE),
      join(dir, ".terminal-initialized-v1"),
    ]) {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(file).uid).toBe(process.getuid!());
    }
    const before = readFileSync(join(first.root, TERMINAL_JOURNAL_FILE));
    expect(await initializeTerminalStore(dir)).toEqual(first);
    expect(readFileSync(join(first.root, TERMINAL_JOURNAL_FILE))).toEqual(before);
  });
  it("concurrent first initializers cannot create two store epochs or overwrite an existing journal", async () => {
    const dir = state(),
      results = await Promise.allSettled([initializeTerminalStore(dir), initializeTerminalStore(dir)]);
    const good = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    expect(good.length).toBeGreaterThan(0);
    expect(new Set(good.map((s) => s.storeId)).size).toBe(1);
    const current = await initializeTerminalStore(dir);
    expect(current.storeId).toBe(good[0]!.storeId);
    expect(JSON.parse(readFileSync(join(current.root, TERMINAL_JOURNAL_FILE), "utf8"))).toEqual({
      v: 1,
      revision: 0,
      resources: [],
    });
  });
  it.each(["PI_SECURE_SESSION", "PI_SECURE_VAULT"])("%s refuses before creating any local state", async (key) => {
    const dir = state();
    vi.stubEnv(key, key === "PI_SECURE_SESSION" ? "1" : "fixture-vault");
    await expect(initializeTerminalStore(dir)).rejects.toMatchObject({ reason: "secure-domain" });
    expect(readdirSync(dir)).toEqual([]);
  });
  it("an existing uninitialized directory is read-only refusal, not a first-use claim", async () => {
    const dir = state();
    mkdirSync(join(dir, TERMINAL_LOCAL_DIR), { mode: 0o700 });
    await expect(initializeTerminalStore(dir)).rejects.toBeDefined();
    expect(readdirSync(dir)).toEqual([TERMINAL_LOCAL_DIR]);
    expect(readdirSync(join(dir, TERMINAL_LOCAL_DIR))).toEqual([]);
  });
  it("a legacy flat journal is prior state, never authority for a fresh local root", async () => {
    const dir = state();
    writeFileSync(join(dir, TERMINAL_JOURNAL_FILE), JSON.stringify({ v: 1, revision: 0, resources: [] }), {
      mode: 0o600,
    });
    await expect(initializeTerminalStore(dir)).rejects.toMatchObject({ reason: "legacy-journal-state" });
    expect(readdirSync(dir)).toEqual([TERMINAL_JOURNAL_FILE]);
  });
  it("removed previously initialized root cannot be minted again because the durable parent witness survives", async () => {
    const dir = state(),
      store = await initializeTerminalStore(dir),
      witness = readFileSync(join(dir, ".terminal-initialized-v1"));
    rmSync(store.root, { recursive: true });
    await expect(initializeTerminalStore(dir)).rejects.toBeDefined();
    expect(existsSync(store.root)).toBe(false);
    expect(readFileSync(join(dir, ".terminal-initialized-v1"))).toEqual(witness);
  });
  it.each([
    "missing-journal",
    "corrupt-journal",
    "unknown-version",
    "journal-symlink",
    "journal-permissions",
    "root-permissions",
    "marker-missing",
    "marker-symlink",
    "marker-version",
    "witness-version",
    "witness-mismatch",
    "authority-directory-symlink",
    "residual-authority",
    "residual-receipt",
  ])("refuses existing %s without resetting journal/marker", async (fault) => {
    const dir = state(),
      store = await initializeTerminalStore(dir),
      journal = join(store.root, TERMINAL_JOURNAL_FILE);
    const source = readFileSync(journal, "utf8");
    if (fault === "missing-journal") unlinkSync(journal);
    if (fault === "corrupt-journal") writeFileSync(journal, "corrupt");
    if (fault === "unknown-version") writeFileSync(journal, JSON.stringify({ v: 99, revision: 0, resources: [] }));
    if (fault === "journal-symlink") {
      const copy = join(dir, "copy");
      writeFileSync(copy, source, { mode: 0o600 });
      unlinkSync(journal);
      symlinkSync(copy, journal);
    }
    if (fault === "journal-permissions") chmodSync(journal, 0o644);
    if (fault === "root-permissions") chmodSync(store.root, 0o755);
    if (fault === "marker-version") {
      const f = join(store.root, "initialized"),
        m = JSON.parse(readFileSync(f, "utf8"));
      m.v = 99;
      writeFileSync(f, JSON.stringify(m));
    }
    if (fault === "witness-version") {
      const f = join(dir, ".terminal-initialized-v1"),
        m = JSON.parse(readFileSync(f, "utf8"));
      m.v = 99;
      writeFileSync(f, JSON.stringify(m));
    }
    if (fault === "marker-missing") unlinkSync(join(store.root, "initialized"));
    if (fault === "marker-symlink") {
      unlinkSync(join(store.root, "initialized"));
      symlinkSync(join(dir, ".terminal-initialized-v1"), join(store.root, "initialized"));
    }
    if (fault === "witness-mismatch")
      writeFileSync(join(dir, ".terminal-initialized-v1"), JSON.stringify({ v: 1, storeId: "x".repeat(32) }));
    if (fault === "authority-directory-symlink") {
      rmSync(join(store.root, "authority"), { recursive: true });
      symlinkSync(join(store.root, "receipts"), join(store.root, "authority"));
    }
    if (fault === "residual-authority")
      writeFileSync(join(store.root, "authority", `${"a".repeat(32)}.json`), "{}", { mode: 0o600 });
    if (fault === "residual-receipt")
      writeFileSync(join(store.root, "receipts", `${"a".repeat(32)}.json`), "{}", { mode: 0o600 });
    const snapshot = existsSync(journal) ? readFileSync(journal) : undefined;
    await expect(initializeTerminalStore(dir)).rejects.toBeDefined();
    expect(existsSync(journal)).toBe(snapshot !== undefined);
    if (snapshot) expect(readFileSync(journal)).toEqual(snapshot);
  });
});
describe("physical receipt producer barriers", () => {
  it("rejects non-reaped physical facts rather than translating booleans from a wire proof", async () => {
    const c = await context();
    await expect(writePhysicalReceipt(c, { ...physical, ptyClosed: false } as never)).rejects.toBeInstanceOf(
      TerminalLocalError,
    );
    expect(readdirSync(join(c.store.root, "receipts"))).toEqual([]);
  });
  it("a late actual file write after the IO deadline cannot publish a receipt reference or leave an authority file", async () => {
    const c = await context();
    let release!: () => void,
      entered = false;
    c.beforePublish = () => {
      entered = true;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const result = writePhysicalReceipt(c, physical).then(
      (ref) => ({ ref }),
      (error: unknown) => ({ error }),
    );
    while (!entered) await new Promise((r) => setTimeout(r, 5));
    const outcome = await result;
    expect(outcome).toHaveProperty("error");
    expect(outcome).not.toHaveProperty("ref");
    release();
    const deadline = Date.now() + 1000;
    while (readdirSync(join(c.store.root, "receipts")).length && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 5));
    expect(readdirSync(join(c.store.root, "receipts"))).toEqual([]);
  }, 5000);
  it("production backend cannot persist a receipt without the helper's genuine reaped completion barrier", async () => {
    const fixture = makeTerminalFixture();
    extras.push(fixture.cleanup);
    const c = await context();
    const backend = createTerminalTestBackend(
      {
        cwd: fixture.fixture.cwd,
        cols: 80,
        rows: 24,
        inputIdleMs: 3600000,
        maxLifetimeMs: 28800000,
        receiptContext: c,
        onData: () => {},
      },
      fixture.fixture,
    );
    backends.push(backend);
    await backend.ready;
    const result = await backend.retryReap(); // force-kill without a sealed helper completion report
    expect(result.outcome).toBe("reap_incomplete");
    expect(result.receipt).toBeUndefined();
    expect(readdirSync(join(c.store.root, "receipts"))).toEqual([]);
  }, 10000);
});

import { spawn } from "node:child_process";
import { once } from "node:events";
import { createLocalTerminalProofVerifier } from "../../src/web-hub/hub/terminal/resource-fence.js";
import { verifyLocalReceipt } from "../../src/web-hub/protocol/terminal-local.js";
import type { TerminalReapProof, TerminalResourceEntry } from "../../src/web-hub/protocol/terminal.js";
describe("hub independently checks managed groups, not only dead leader identities", () => {
  it("rejects an immutable hostile receipt for a reaped process whose actual process group still lives", async () => {
    const c = await context();
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    const exited = once(child, "exit");
    const identity = localProcess(child.pid!);
    const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8"),
      fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
    const managed = { ...identity, sid: Number(fields[3]), pgid: Number(fields[2]), role: "helper" as const };
    child.kill("SIGKILL");
    await exited;
    const receipt = await writePhysicalReceipt(c, { ...physical, identitiesChecked: [managed], waited: [child.pid!] });
    const entry: TerminalResourceEntry = {
      identity: c.identity,
      agentProcessIdentity: c.agentProcessIdentity,
      managed: [managed],
      spawnState: "settled",
      state: "closing",
    };
    const proof: TerminalReapProof = {
      ...c.identity,
      identity: c.identity,
      agentProcessIdentity: c.agentProcessIdentity,
      hubBootId: "hub",
      challengeId: "challenge",
      linkGen: 1,
      inventoryId: "inventory",
      revision: 1,
      proofId: "proof",
      receipt,
      outcome: "reaped",
      spawnSettled: true,
      ptyClosed: true,
      helperReaped: true,
      managedGroupsGone: true,
      identitiesChecked: [managed],
    };
    // Closed schema does not include duplicated tuple fields.
    for (const key of Object.keys(c.identity)) delete (proof as unknown as Record<string, unknown>)[key];
    expect(verifyLocalReceipt(c.store, proof, entry)).toBe(true); // exact immutable local witness positive control
    const verify = createLocalTerminalProofVerifier({ receipt: (p, e) => verifyLocalReceipt(c.store, p, e) });
    expect(await verify(proof, entry, new AbortController().signal)).toBe(false);
  });
});
