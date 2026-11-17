/** Private real filesystem/proc/startHub recovery. No production state or fake proof. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync, fork } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startHub, type StartHubDeps } from "../../src/web-hub/hub/hub.js";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import { resolveHubPaths } from "../../src/web-hub/protocol/paths.js";
import {
  createLocalAuthority,
  initializeTerminalStore,
  localProcess,
  processNamespaces,
  writePhysicalReceipt,
  type TerminalPublicationTestHooks,
} from "../../src/web-hub/protocol/terminal-local.js";
import {
  prepareTerminalStore,
  scanAuthorityArchive,
  type RecoveryStage,
  type AuthorityRecoveryTestDeps,
} from "../../src/web-hub/hub/terminal/authority-recovery.js";
import { TERMINAL_JOURNAL_FILE } from "../../src/web-hub/protocol/terminal.js";
import { config, connectClient, hello } from "../web-hub/hub/helpers.js";
import { login, openSse, postJson } from "../web-hub/http/helpers.js";
import { waitUntil } from "../web-hub/agent/helpers.js";
import { isolatedMachine, cardFor, drained } from "./web-hub-terminal-compat-baseline.js";
const worker = fileURLToPath(new URL("./fixtures/terminal-authority-recovery.ts", import.meta.url));
const archive = ".terminal-authority-archive-v1";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
  vi.unstubAllEnvs();
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ar-"));
  chmodSync(home, 0o700);
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const paths = resolveHubPaths({ home, uid: process.getuid!() });
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".pi/agent/pi-toolkit.json"), JSON.stringify({ webHub: { terminal: { enabled: true } } }), {
    mode: 0o600,
  });
  vi.stubEnv("PI_WEBHUB_TERMINAL_SOURCE", "plain");
  return {
    home,
    paths,
    root: join(paths.stateDir, "terminal-v1"),
    auth: join(paths.stateDir, "terminal-v1/authority"),
  };
}
type Fixture = ReturnType<typeof fixture>;
function seed(f: Pick<Fixture, "paths" | "root" | "auth">, previous = true) {
  const ids: string[] = JSON.parse(
    execFileSync(process.execPath, ["--import", "tsx", worker, "seed", f.paths.stateDir], {
      encoding: "utf8",
      timeout: 10000,
    }),
  );
  for (const id of ids) {
    const path = join(f.auth, `${id}.json`),
      raw = JSON.parse(readFileSync(path, "utf8"));
    expect(existsSync(`/proc/${raw.process.pid}`)).toBe(false); // child exited AND was waited
    if (previous) raw.process.bootId = "00000000-0000-4000-8000-000000000000";
    writeFileSync(path, JSON.stringify(raw));
  }
  return ids.map((id) => `${id}.json`).sort();
}
const input = () => ({
  process: localProcess(process.pid),
  namespaces: processNamespaces(process.pid),
  agentNonce: "current-agent",
  sessionId: "current-session",
  epoch: "current-epoch",
  ownerInstance: "current-owner",
  domain: "plain" as const,
  main: true,
  active: true,
});
async function start(f: Fixture, test?: AuthorityRecoveryTestDeps, deps: StartHubDeps = {}) {
  const h = await startHub(config({ home: f.home, control: true, privacy: true }), createHttpFrontend, {
    ...deps,
    ...(test ? { terminalAuthorityRecoveryTestDeps: test } : {}),
  });
  if ("exists" in h) throw new Error("expected running singleton");
  cleanup.push(() => h.close("test"));
  return h;
}
const status = (f: Fixture) => JSON.parse(readFileSync(f.paths.hubJson, "utf8")).terminal;
function immutable(f: Fixture) {
  return [
    join(f.paths.stateDir, ".terminal-initialized-v1"),
    join(f.root, "initialized"),
    join(f.root, TERMINAL_JOURNAL_FILE),
  ].map((path) => ({ path, bytes: readFileSync(path), ino: statSync(path).ino }));
}
function assertImmutable(before: ReturnType<typeof immutable>) {
  for (const x of before) {
    expect(readFileSync(x.path)).toEqual(x.bytes);
    expect(statSync(x.path).ino).toBe(x.ino);
  }
}
const files = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);
function transactions(f: Fixture) {
  return files(join(f.paths.stateDir, archive)).map((n) => join(f.paths.stateDir, archive, n));
}
function snapshotFiles(f: Fixture) {
  return files(f.auth).map((name) => ({
    name,
    bytes: readFileSync(join(f.auth, name)),
    ino: statSync(join(f.auth, name)).ino,
  }));
}
function assertRetirement(f: Fixture, old: ReturnType<typeof snapshotFiles>) {
  const [tx] = transactions(f);
  expect(transactions(f)).toHaveLength(1);
  expect(files(join(tx!, "retired"))).toEqual(old.map((x) => x.name).sort());
  expect(files(join(tx!, "snapshots"))).toEqual(old.map((x) => x.name).sort());
  for (const x of old) {
    for (const kind of ["retired", "snapshots"]) {
      const path = join(tx!, kind, x.name);
      expect(readFileSync(path)).toEqual(x.bytes);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(path).uid).toBe(process.getuid!());
      if (kind === "retired") expect(statSync(path).ino).toBe(x.ino);
      else expect(statSync(path).ino).not.toBe(x.ino);
    }
  }
}

describe("#49 singleton-owned conservative authority retirement", () => {
  it("recovers the private same-shape previous-boot empty store; preserves public SSE and exact state", async () => {
    const f = fixture();
    seed(f);
    const old = snapshotFiles(f),
      before = immutable(f);
    const h = await start(f);
    expect(status(f).state).toBe("ready");
    expect(files(f.auth)).toEqual([]);
    assertRetirement(f, old);
    assertImmutable(before);
    const cookie = await login(h.httpPort, h.paths.tokenFile),
      sse = await openSse(h.httpPort, { cookie });
    cleanup.push(() => sse.close());
    const helloFrame = await sse.waitFor((e) => e.event === "hello");
    const peer = await connectClient(h.paths.socketPath);
    cleanup.push(() => peer.sock.destroy());
    peer.send(hello());
    const ack = await peer.waitFrame((x) => x.t === "hello_ack");
    expect(
      (
        await postJson(
          h.httpPort,
          "/api/subscribe",
          { clientId: helloFrame.data.clientId, agentKey: ack.agentKey },
          { Cookie: cookie },
        )
      ).status,
    ).toBe(202);
    expect(sse.events.some((e) => e.event === "terminal_connection")).toBe(true);
  });
  it("current + stale mixed set: only exact old entries retire, current inode/bytes remain", async () => {
    const f = fixture();
    const current = await createLocalAuthority(f.paths.stateDir, input(), () => true);
    seed(f); // seed child sees a valid exact current authority
    const all = snapshotFiles(f),
      old = all.filter((x) => !x.name.startsWith(current.recordId)),
      live = all.find((x) => x.name.startsWith(current.recordId))!,
      before = immutable(f);
    await start(f);
    assertRetirement(f, old);
    assertImmutable(before);
    expect(files(f.auth)).toEqual([live.name]);
    expect(readFileSync(join(f.auth, live.name))).toEqual(live.bytes);
    expect(statSync(join(f.auth, live.name)).ino).toBe(live.ino);
  });
  it.each(["same-dead", "same-reuse", "previous-present", "corrupt", "permissions", "symlink", "hardlink", "pending"])(
    "refuses %s with fixed diagnosis and zero retirement",
    async (kind) => {
      const f = fixture();
      seed(f, kind !== "same-dead" && kind !== "same-reuse");
      const name = files(f.auth)[0]!,
        path = join(f.auth, name),
        raw = JSON.parse(readFileSync(path, "utf8"));
      if (kind === "same-reuse" || kind === "previous-present") {
        raw.process.pid = process.pid;
        raw.process.starttime = "0";
        writeFileSync(path, JSON.stringify(raw));
      }
      if (kind === "corrupt") writeFileSync(path, "{");
      if (kind === "permissions") chmodSync(path, 0o644);
      const sentinel = join(f.home, "sentinel");
      writeFileSync(sentinel, "unchanged", { mode: 0o600 });
      if (kind === "symlink") {
        rmSync(path);
        symlinkSync(sentinel, path);
      }
      if (kind === "hardlink") linkSync(path, join(f.home, "hardlink"));
      if (kind === "pending") writeFileSync(join(f.auth, ".pending-" + "p".repeat(32)), "", { mode: 0o600 });
      const expected: Record<string, string> = {
        "same-dead": "stale-authority-same-boot",
        "same-reuse": "stale-authority-same-boot",
        "previous-present": "stale-authority-prev-boot-pid-present",
        corrupt: "authority-corrupt",
        permissions: "unsafe-file",
        symlink: "unsafe-file",
        hardlink: "unsafe-file",
        pending: "unresolved-local-state",
      };
      const before = immutable(f);
      await start(f);
      expect(status(f)).toMatchObject({ state: "unavailable", reason: expected[kind] });
      expect(transactions(f)).toEqual([]);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(sentinel, "utf8")).toBe("unchanged");
      assertImmutable(before);
    },
  );
  it("normal exact live authority is retained, with no archive IO", async () => {
    const f = fixture();
    await createLocalAuthority(f.paths.stateDir, input(), () => true);
    const before = snapshotFiles(f);
    await start(f);
    expect(status(f).state).toBe("ready");
    expect(snapshotFiles(f)).toEqual(before);
    expect(transactions(f)).toEqual([]);
  });
  it("missing ownership rejects before even creating a store", async () => {
    const f = fixture();
    await expect(
      prepareTerminalStore({
        paths: f.paths,
        startup: new AbortController(),
        isClosing: () => false,
        log: { info() {}, warn() {}, error() {}, close() {} },
      }),
    ).rejects.toMatchObject({ reason: "authority-recovery-not-owner" });
    expect(existsSync(f.root)).toBe(false);
    expect(transactions(f)).toEqual([]);
  });
  it.each(["snapshot-fsync", "manifest-fsync", "rename", "source-dir-fsync", "target-dir-fsync"] as const)(
    "injected-sync-fs-fault: %s never adopts local/service",
    async (op) => {
      const f = fixture();
      seed(f);
      const before = immutable(f);
      const completed: string[] = [];
      await start(f, {
        beforeSyscall(current) {
          completed.push(current);
          if (current === op) throw Object.assign(new Error("private IO"), { code: "ENOSPC" });
        },
      });
      expect(status(f)).toMatchObject({ state: "unavailable", reason: "authority-archive-io" });
      expect(completed.at(-1)).toBe(op);
      if (op === "snapshot-fsync" || op === "manifest-fsync" || op === "rename") expect(files(f.auth)).toHaveLength(2);
      assertImmutable(before);
    },
  );
  it.each(["receipt", "journal", "inode", "directory", "abort", "current-socket"])(
    "revalidates %s immediately before mutation",
    async (kind) => {
      const f = fixture();
      seed(f);
      const old = snapshotFiles(f);
      await start(f, {
        async stage(event) {
          if (event.stage !== "prepared-durable-before-rename") return;
          if (kind === "receipt")
            writeFileSync(join(f.root, "receipts", "r".repeat(32) + ".json"), "{}", { mode: 0o600 });
          if (kind === "journal") {
            const p = join(f.root, TERMINAL_JOURNAL_FILE);
            const raw = JSON.parse(readFileSync(p, "utf8"));
            raw.revision++;
            writeFileSync(p, JSON.stringify(raw));
          }
          if (kind === "inode") {
            const p = join(f.auth, old[0]!.name);
            rmSync(p);
            writeFileSync(p, old[0]!.bytes, { mode: 0o600 });
          }
          if (kind === "directory") {
            chmodSync(f.auth, 0o755);
          }
          if (kind === "current-socket") {
            rmSync(f.paths.socketPath);
            writeFileSync(f.paths.socketPath, "sentinel");
          }
          if (kind === "abort") {
            throw new Error("abort injection");
          }
        },
      });
      expect(status(f).state).toBe("unavailable");
      expect(files(f.auth)).toEqual(old.map((x) => x.name));
      expect(transactions(f).flatMap((tx) => files(join(tx, "retired")))).toEqual([]);
    },
  );
  it.each(["pending", "linked", "stalled", "bad-final", "receipt-change", "journal-change"])(
    "last rename publish window: %s",
    async (mode) => {
      const f = fixture();
      seed(f);
      const old = snapshotFiles(f),
        before = immutable(f);
      let release!: () => void, reached!: () => void;
      const barrier = new Promise<void>((r) => {
          reached = r;
        }),
        hold = new Promise<void>((r) => {
          release = r;
        });
      let publisher: ReturnType<typeof createLocalAuthority> | undefined,
        attempts = 0,
        transient = 0;
      const hook = async () => {
        reached();
        await hold;
      };
      const hooks: TerminalPublicationTestHooks =
        mode === "linked" ? { afterLinkBeforeTempUnlink: hook } : { afterTempDurable: hook };
      await start(f, {
        async afterLastRenameBeforeFinalCheck() {
          publisher = createLocalAuthority(f.paths.stateDir, input(), () => true, hooks);
          await barrier;
        },
        onFinalValidationAttempt() {
          attempts++;
        },
        onPublicationPending() {
          transient++;
          if (mode !== "stalled") release();
          if (mode === "bad-final") writeFileSync(join(f.auth, "b".repeat(32) + ".json"), "{}", { mode: 0o600 });
          if (mode === "receipt-change")
            writeFileSync(join(f.root, "receipts", "r".repeat(32) + ".json"), "{}", { mode: 0o600 });
          if (mode === "journal-change") {
            const p = join(f.root, TERMINAL_JOURNAL_FILE);
            const raw = JSON.parse(readFileSync(p, "utf8"));
            raw.revision++;
            writeFileSync(p, JSON.stringify(raw));
          }
        },
      });
      release();
      await publisher;
      expect(transient).toBeGreaterThan(0);
      if (!["receipt-change", "journal-change"].includes(mode)) expect(attempts).toBeGreaterThan(1);
      assertRetirement(f, old);
      if (["pending", "linked"].includes(mode)) {
        expect(status(f).state).toBe("ready");
        await expect(initializeTerminalStore(f.paths.stateDir)).resolves.toBeDefined();
        assertImmutable(before);
      } else {
        expect(status(f).state).toBe("unavailable");
        if (mode === "stalled") {
          expect(status(f).reason).toBe("authority-publication-unsettled");
          expect(attempts).toBe(9);
        }
      }
    },
  );
  it("two real startHub calls have only one owner and retirement", async () => {
    const f = fixture();
    seed(f);
    const results = await Promise.all([
      startHub(config({ home: f.home, control: true, privacy: true }), createHttpFrontend),
      startHub(config({ home: f.home, control: true, privacy: true }), createHttpFrontend),
    ]);
    const owners = results.filter((x) => !("exists" in x));
    expect(owners).toHaveLength(1);
    for (const h of owners) if (!("exists" in h)) cleanup.push(() => h.close("test"));
    expect(transactions(f)).toHaveLength(1);
    expect(files(join(transactions(f)[0]!, "retired"))).toHaveLength(2);
  });
});

describe("archive safety, capacity, resource and crash evidence", () => {
  it.each([63, 64, 65])("real partial archive transaction boundary %s", async (count) => {
    const f = fixture();
    seed(f);
    const before = snapshotFiles(f);
    const parent = join(f.paths.stateDir, archive);
    mkdirSync(parent, { mode: 0o700 });
    for (let i = 0; i < count; i++) mkdirSync(join(parent, String(i).padStart(32, "0")), { mode: 0o700 });
    await start(f);
    expect(status(f).state).toBe(count === 63 ? "ready" : "unavailable");
    if (count !== 63) {
      expect(status(f).reason).toBe("authority-archive-capacity");
      expect(snapshotFiles(f)).toEqual(before);
    }
    expect(transactions(f)).toHaveLength(count === 63 ? 64 : count);
  });
  it("real accounting includes partial snapshot/temp manifest/retired/completion; unsafe files are not ignored", () => {
    const f = fixture(),
      parent = join(f.paths.stateDir, archive),
      tx = join(parent, "t".repeat(32));
    mkdirSync(tx, { recursive: true, mode: 0o700 });
    mkdirSync(join(tx, "snapshots"), { mode: 0o700 });
    mkdirSync(join(tx, "retired"), { mode: 0o700 });
    const paths = [
      join(tx, "snapshots", "a".repeat(32) + ".json"),
      join(tx, "retired", "b".repeat(32) + ".json"),
      join(tx, "manifest.json"),
      join(tx, ".pending-manifest.json"),
      join(tx, "complete.json"),
    ];
    for (const [i, p] of paths.entries()) writeFileSync(p, Buffer.alloc(i + 1), { mode: 0o600 });
    expect(scanAuthorityArchive(parent)).toEqual({ transactions: 1, bytes: 15 });
    writeFileSync(join(tx, "unknown"), "x", { mode: 0o600 });
    expect(() => scanAuthorityArchive(parent)).toThrowError("authority-archive-unsafe");
  });
  it.each(["parent-symlink", "entry-symlink", "hardlink", "permissions", "unknown"])(
    "unsafe archive %s refuses without following/deleting evidence",
    async (kind) => {
      const f = fixture();
      seed(f);
      const before = snapshotFiles(f),
        parent = join(f.paths.stateDir, archive);
      const sentinel = join(f.home, "sentinel");
      mkdirSync(sentinel, { mode: 0o700 });
      writeFileSync(join(sentinel, "keep"), "private-sentinel", { mode: 0o600 });
      if (kind === "parent-symlink") symlinkSync(sentinel, parent);
      else {
        const tx = join(parent, "t".repeat(32));
        mkdirSync(tx, { recursive: true, mode: 0o700 });
        if (kind === "entry-symlink") symlinkSync(join(sentinel, "keep"), join(tx, "manifest.json"));
        if (kind === "hardlink") linkSync(join(sentinel, "keep"), join(tx, "manifest.json"));
        if (kind === "permissions") chmodSync(parent, 0o755);
        if (kind === "unknown") writeFileSync(join(tx, "unknown"), "x", { mode: 0o600 });
      }
      await start(f);
      expect(status(f)).toMatchObject({ state: "unavailable", reason: "authority-archive-unsafe" });
      expect(snapshotFiles(f)).toEqual(before);
      expect(readFileSync(join(sentinel, "keep"), "utf8")).toBe("private-sentinel");
    },
  );
  it.each(["unresolved", "resolved", "receipt", "bad-receipt", "nonzero-empty"])(
    "never releases physical metadata for %s",
    async (kind) => {
      const f = fixture();
      seed(f);
      const path = join(f.root, TERMINAL_JOURNAL_FILE),
        storeId = JSON.parse(readFileSync(join(f.root, "initialized"), "utf8")).storeId;
      const identity = { agentSessionId: "s", termId: "t", epoch: "e", ownerInstance: "o", reservationId: "r" },
        agentProcessIdentity = localProcess(process.pid);
      const entry = { identity, agentProcessIdentity, managed: [], spawnState: "pending", state: "reserved" };
      const physical = {
        outcome: "reaped" as const,
        spawnSettled: true as const,
        ptyClosed: true as const,
        helperReaped: true as const,
        managedGroupsGone: true as const,
        identitiesChecked: [],
        waited: [],
      };
      if (kind === "receipt")
        await writePhysicalReceipt(
          { store: { root: f.root, storeId }, ownerRecordId: "o".repeat(32), identity, agentProcessIdentity },
          physical,
        );
      if (kind === "bad-receipt")
        writeFileSync(join(f.root, "receipts", "b".repeat(32) + ".json"), "{}", { mode: 0o600 });
      const proof = {
        ...physical,
        waited: undefined,
        hubBootId: "b",
        challengeId: "c",
        linkGen: 1,
        inventoryId: "i",
        revision: 1,
        identity,
        agentProcessIdentity,
        proofId: "p",
      };
      delete proof.waited;
      writeFileSync(
        path,
        JSON.stringify({
          v: 1,
          revision: 7,
          resources: ["unresolved", "resolved"].includes(kind)
            ? [{ entry, status: kind, ...(kind === "resolved" ? { proof } : {}) }]
            : [],
        }),
      );
      const before = immutable(f),
        receipts = files(join(f.root, "receipts"));
      await start(f);
      assertImmutable(before);
      expect(files(join(f.root, "receipts"))).toEqual(receipts);
      if (kind === "nonzero-empty") expect(status(f).state).toBe("ready");
      else {
        expect(status(f)).toMatchObject({
          state: "unavailable",
          reason:
            kind === "receipt"
              ? "stale-authority-prev-boot-receipts-not-empty"
              : kind === "bad-receipt"
                ? "residual-receipt-state"
                : "stale-authority-prev-boot-journal-not-empty",
        });
        expect(transactions(f)).toEqual([]);
      }
    },
  );
  it.each([
    "snapshot-written-not-durable",
    "prepared-durable-before-rename",
    "renamed-before-dir-fsync",
    "renamed-before-completion-marker",
  ] as RecoveryStage[])(
    "process-SIGKILL exact sets after %s (NOT power-cut evidence)",
    async (stage) => {
      const f = fixture();
      const live = await createLocalAuthority(f.paths.stateDir, input(), () => true);
      seed(f);
      const all = snapshotFiles(f),
        stale = all.filter((x) => !x.name.startsWith(live.recordId)),
        current = all.filter((x) => x.name.startsWith(live.recordId)),
        before = immutable(f);
      const child = fork(worker, ["hub", f.home, stage], {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      cleanup.push(() => {
        child.kill("SIGKILL");
      });
      const event = await new Promise<{ stage: string; ordinal: number; completed: string[] }>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("crash barrier deadline")), 10000);
        t.unref();
        child.once("error", reject);
        child.on("message", (message) => {
          if ((message as any).type === "barrier") {
            clearTimeout(t);
            resolve(message as any);
          }
        });
      });
      expect(event.stage).toBe(stage);
      expect(event.completed.length).toBeGreaterThan(0);
      const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exit;
      const [tx] = transactions(f);
      expect(tx).toBeDefined();
      const moved =
        stage === "renamed-before-dir-fsync" ? 1 : stage === "renamed-before-completion-marker" ? stale.length : 0;
      expect(files(f.auth)).toEqual([...current.map((x) => x.name), ...stale.slice(moved).map((x) => x.name)].sort());
      expect(files(join(tx!, "retired"))).toEqual(
        stale
          .slice(0, moved)
          .map((x) => x.name)
          .sort(),
      );
      expect(files(join(tx!, "snapshots"))).toEqual(
        (stage === "snapshot-written-not-durable" ? stale.slice(0, 1) : stale).map((x) => x.name).sort(),
      );
      for (const x of stale.slice(0, moved)) {
        expect(statSync(join(tx!, "retired", x.name)).ino).toBe(x.ino);
        expect(readFileSync(join(tx!, "retired", x.name))).toEqual(x.bytes);
      }
      for (const x of stage === "snapshot-written-not-durable" ? stale.slice(0, 1) : stale) {
        expect(readFileSync(join(tx!, "snapshots", x.name))).toEqual(x.bytes);
        expect(statSync(join(tx!, "snapshots", x.name)).ino).not.toBe(x.ino);
      }
      expect(existsSync(join(tx!, "complete.json"))).toBe(false);
      assertImmutable(before);
      // An obsolete/malicious manifest reference is NEVER replayed as removal authority.
      if (existsSync(join(tx!, "manifest.json")))
        writeFileSync(join(tx!, "manifest.json"), JSON.stringify({ candidate: current[0]!.name }));
      const priorNames = files(tx!);
      await start(f);
      expect(status(f).state).toBe("ready");
      expect(snapshotFiles(f)).toEqual(current);
      expect(files(tx!)).toEqual(priorNames);
      assertImmutable(before);
      expect(transactions(f)).toHaveLength(moved === stale.length ? 1 : 2);
    },
    20000,
  );
});

describe("real guarded producer and PTY after retirement", () => {
  it.each([false, true])(
    "private scene-shaped store, real login/open/reap/prune/ACK (agent-first=%s)",
    async (agentFirst) => {
      const m = isolatedMachine();
      cleanup.push(() => m.close());
      const paths = resolveHubPaths({ home: m.home, uid: process.getuid!() });
      mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
      const f = {
        paths,
        root: join(paths.stateDir, "terminal-v1"),
        auth: join(paths.stateDir, "terminal-v1/authority"),
      };
      seed(f);
      const before = immutable(f as Fixture),
        old = snapshotFiles(f as Fixture);
      const pendingAgent = agentFirst ? m.agent(undefined, { sessionId: "agent-first" }) : undefined;
      if (agentFirst)
        await waitUntil(
          () =>
            m.peers[0]!.messages.some(
              (x) => x.event === "terminal-owner-failed" && x.reason === "stale-authority-prev-boot",
            ),
          10000,
          "initial agent failed before hub recovery",
        );
      const h = await m.hub(undefined, { source: "plain" });
      const a = pendingAgent ? await pendingAgent : await m.agent();
      const card = await cardFor(h, a.sessionId),
        b = await m.browser(h);
      const initial = await a.peer.command("snapshot");
      expect(initial.ownerAttempts).toBe(agentFirst ? 2 : 1);
      expect(initial.backendCount).toBe(0); // NO auto shell
      assertRetirement(f as Fixture, old);
      assertImmutable(before);
      const t = await b.open(card);
      await b.input(card, t, "printf 'P1_PID=%s\n' \"$$\"\n");
      await waitUntil(() => /P1_PID=\d+\r?\n/.test(b.output(t.termId)), 5000, "real PTY echo");
      const pid = Number(/P1_PID=(\d+)/.exec(b.output(t.termId))![1]);
      expect(existsSync(`/proc/${pid}/stat`)).toBe(true);
      const revision = JSON.parse(readFileSync(join(f.root, TERMINAL_JOURNAL_FILE), "utf8")).revision;
      await b.close(card, t);
      await drained(h, revision + 2);
      expect(existsSync(`/proc/${pid}/stat`)).toBe(false);
      expect(files(join(f.root, "receipts"))).toEqual([]);
      expect((await a.peer.command("snapshot")).ownerAttempts).toBe(agentFirst ? 2 : 1);
    },
    120000,
  );
});
