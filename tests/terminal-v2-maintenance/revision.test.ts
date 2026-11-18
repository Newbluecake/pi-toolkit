import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { checkpointTerminalV2 } from "../../scripts/web-hub/terminal-v2-checkpoint.js";
import { setup, tree, legacyLayout } from "./helpers.js";
import { rollbackTerminalV2 } from "../../scripts/web-hub/terminal-v2-rollback.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: vi.fn(actual.fsyncSync),
    writeSync: vi.fn(actual.writeSync),
    linkSync: vi.fn(actual.linkSync),
  };
});
const real = await vi.importActual<typeof import("node:fs")>("node:fs");
afterEach(() => {
  vi.mocked(fs.fsyncSync).mockImplementation(real.fsyncSync);
  vi.mocked(fs.writeSync).mockImplementation(real.writeSync);
  vi.mocked(fs.linkSync).mockImplementation(real.linkSync);
});
const io = () => Object.assign(new Error("controlled actual syscall failure"), { code: "EIO" });
const isCompleteFd = (fd: number) =>
  /\/(?:complete\.json|\.complete-prepared)$/.test(real.readlinkSync(`/proc/self/fd/${fd}`));

describe("P5 verifier counterexamples", () => {
  it("B1: completion file fsync failure must not leave a parse-only durable approval", async () => {
    const h = setup();
    let injected = false;
    vi.mocked(fs.fsyncSync).mockImplementation((fd) => {
      if (!injected && isCompleteFd(fd)) {
        injected = true;
        throw io();
      }
      real.fsyncSync(fd);
    });
    await expect(checkpointTerminalV2("fresh", h.options)).rejects.toMatchObject({ code: "io-EIO", effect: "unknown" });
    expect(injected).toBe(true);
    vi.mocked(fs.fsyncSync).mockImplementation(real.fsyncSync);
    const retained = tree(h.base);
    await expect(checkpointTerminalV2("fresh", h.options)).rejects.toMatchObject({
      code: "unknown-maintenance-evidence",
      effect: "none",
    });
    expect(tree(h.base)).toEqual(retained);
  });

  it("B2: prepared evidence changed during revalidation prevents state commit", async () => {
    const h = setup();
    let validations = 0;
    h.audit.onRevalidate = () => {
      if (++validations !== 2) return;
      const tx = real.readdirSync(h.evidenceDir)[0]!;
      real.writeFileSync(join(h.evidenceDir, tx, "prepared.json"), "broken-evidence");
    };
    await expect(checkpointTerminalV2("fresh", h.options)).rejects.toMatchObject({ code: "file-changed" });
    expect(tree(h.stateDir)).toEqual({});
  });

  it("M2: released A never revives when B owns same generation; old release cannot unlock B", async () => {
    const h = setup(),
      input = {
        stateDir: h.stateDir,
        operation: "fresh" as const,
        signal: new AbortController().signal,
        deadline: Date.now() + 1000,
      };
    const a = await h.audit.acquire(input),
      old = await a.observe();
    await a.release();
    const b = await h.audit.acquire(input),
      current = await b.observe();
    expect(a.current(old)).toBe(false);
    await expect(a.revalidate(old)).rejects.toMatchObject({ code: "snapshot-not-current" });
    await a.release();
    expect(b.current(current)).toBe(true);
    expect(h.audit.locked).toBe(true);
    await b.release();
  });

  it("M2: nested snapshots are immutable, not only their top object", async () => {
    const h = setup(),
      lease = await h.audit.acquire({
        stateDir: h.stateDir,
        operation: "fresh",
        signal: new AbortController().signal,
        deadline: Date.now() + 1000,
      });
    const snapshot = await lease.observe();
    expect(Object.isFrozen(snapshot.publisherFence)).toBe(true);
    expect(Object.isFrozen(snapshot.newVersion)).toBe(true);
    expect(() => {
      snapshot.publisherFence.state = "changed" as "disabled";
    }).toThrow(TypeError);
    await lease.release();
  });

  it("M2: current rejects an actually elapsed deadline without waiting for AbortSignal", async () => {
    const h = setup(),
      input = {
        stateDir: h.stateDir,
        operation: "fresh" as const,
        signal: new AbortController().signal,
        deadline: Date.now() + 1000,
      };
    const lease = await h.audit.acquire(input),
      snapshot = await lease.observe();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(input.deadline + 1);
      expect(lease.current(snapshot)).toBe(false);
    } finally {
      vi.useRealTimers();
      await lease.release();
    }
  });
});

describe("B1 actual syscall publication and retry durability", () => {
  const stages = ["write", "file-fsync", "publish", "transaction-fsync", "parent-fsync"] as const;
  for (const stage of stages)
    for (const phase of ["before", "after"] as const) {
      it(`${stage} ${phase} syscall failure never becomes parse-only success`, async () => {
        const h = setup();
        let injected = false;
        const atFault = (work: () => number | void) => {
          if (injected) return work();
          injected = true;
          if (phase === "before") throw io();
          work();
          throw io();
        };
        if (stage === "write")
          vi.mocked(fs.writeSync).mockImplementation((...args) => {
            if (isCompleteFd(args[0]) && !injected)
              return atFault(() => Reflect.apply(real.writeSync, undefined, args) as number) as number;
            return Reflect.apply(real.writeSync, undefined, args) as number;
          });
        if (stage === "publish")
          vi.mocked(fs.linkSync).mockImplementation((from, to) => {
            if (String(to).endsWith("/complete.json") && !injected) {
              atFault(() => real.linkSync(from, to));
              return;
            }
            real.linkSync(from, to);
          });
        if (stage.endsWith("fsync"))
          vi.mocked(fs.fsyncSync).mockImplementation((fd) => {
            const path = real.readlinkSync(`/proc/self/fd/${fd}`),
              isDir = real.fstatSync(fd).isDirectory();
            const matches =
              stage === "file-fsync"
                ? isCompleteFd(fd)
                : isDir &&
                  (stage === "parent-fsync"
                    ? path === h.evidenceDir &&
                      real
                        .readdirSync(h.evidenceDir)
                        .some((tx) => real.existsSync(join(h.evidenceDir, tx, "complete.json")))
                    : dirname(path) === h.evidenceDir && real.existsSync(join(path, "complete.json")));
            if (matches && !injected) {
              atFault(() => real.fsyncSync(fd));
              return;
            }
            real.fsyncSync(fd);
          });
        await expect(checkpointTerminalV2("fresh", h.options)).rejects.toMatchObject({
          code: "io-EIO",
          effect: "unknown",
        });
        expect(injected).toBe(true);
        vi.mocked(fs.writeSync).mockImplementation(real.writeSync);
        vi.mocked(fs.linkSync).mockImplementation(real.linkSync);
        const tx = join(h.evidenceDir, real.readdirSync(h.evidenceDir)[0]!);
        const before = tree(h.base);
        const syncPaths: string[] = [];
        vi.mocked(fs.fsyncSync).mockImplementation((fd) => {
          syncPaths.push(real.readlinkSync(`/proc/self/fd/${fd}`));
          real.fsyncSync(fd);
        });
        const published = real.existsSync(join(tx, "complete.json"));
        if (!published) {
          await expect(checkpointTerminalV2("fresh", h.options)).rejects.toMatchObject({
            code: "unknown-maintenance-evidence",
            effect: "none",
          });
          expect(syncPaths).toEqual([]);
        } else {
          expect(real.lstatSync(join(tx, "complete.json")).nlink).toBe(2);
          expect(real.lstatSync(join(tx, ".complete-prepared")).ino).toBe(
            real.lstatSync(join(tx, "complete.json")).ino,
          );
          for (let repeat = 0; repeat < 2; repeat++) {
            syncPaths.length = 0;
            expect((await checkpointTerminalV2("fresh", h.options)).outcome).toBe("already-complete");
            expect(syncPaths).toContain(join(tx, "complete.json"));
            expect(syncPaths).toContain(join(tx, ".complete-prepared"));
            expect(syncPaths).toContain(join(tx, "prepared.json"));
            expect(syncPaths).toContain(join(h.stateDir, "terminal-v2/ledger.json"));
            expect(syncPaths).toContain(tx);
            expect(syncPaths).toContain(h.evidenceDir);
            expect(syncPaths).toContain(h.stateDir);
            expect(syncPaths.indexOf(join(tx, "complete.json"))).toBeLessThan(syncPaths.indexOf(tx));
          }
        }
        expect(tree(h.base)).toEqual(before);
      });
    }
});

describe("B1 reproof failures stay unknown", () => {
  it.each(["file", "directory"])("retry %s fsync failure does not ACK an existing publication", async (stage) => {
    const h = setup();
    await checkpointTerminalV2("fresh", h.options);
    const before = tree(h.base);
    let injected = false;
    vi.mocked(fs.fsyncSync).mockImplementation((fd) => {
      const matches = stage === "file" ? isCompleteFd(fd) : real.fstatSync(fd).isDirectory();
      if (!injected && matches) {
        injected = true;
        throw io();
      }
      real.fsyncSync(fd);
    });
    await expect(checkpointTerminalV2("fresh", h.options)).rejects.toMatchObject({ code: "io-EIO", effect: "unknown" });
    expect(injected).toBe(true);
    expect(tree(h.base)).toEqual(before);
    vi.mocked(fs.fsyncSync).mockImplementation(real.fsyncSync);
    expect((await checkpointTerminalV2("fresh", h.options)).outcome).toBe("already-complete");
    expect(tree(h.base)).toEqual(before);
  });
});

function mutateEvidence(h: ReturnType<typeof setup>, transaction: string, target: string, attack: string) {
  const tx = join(h.evidenceDir, transaction),
    path = join(tx, target);
  if (attack === "bytes") real.writeFileSync(path, "broken-evidence");
  if (attack === "inode") {
    const replacement = join(h.base, "replacement");
    real.writeFileSync(replacement, real.readFileSync(path), { mode: 0o600 });
    real.renameSync(replacement, path);
  }
  if (attack === "symlink") {
    const backup = join(h.base, "evidence-backup");
    real.renameSync(path, backup);
    real.symlinkSync(backup, path);
  }
  if (attack === "directory") {
    real.renameSync(tx, join(h.base, "old-transaction"));
    real.mkdirSync(tx, { mode: 0o700 });
  }
  if (attack === "members") real.writeFileSync(join(tx, "unexpected"), "unknown", { mode: 0o600 });
  if (attack === "root") {
    real.renameSync(h.evidenceDir, join(h.base, "old-evidence"));
    real.mkdirSync(h.evidenceDir, { mode: 0o700 });
  }
}
describe("B2 evidence stays pinned through every asynchronous revalidation", () => {
  it("new evidence is pinned to its actual write fd, not a replacement inode sampled after fsync", async () => {
    const h = setup();
    let replaced = false;
    vi.mocked(fs.fsyncSync).mockImplementation((fd) => {
      real.fsyncSync(fd);
      const path = real.readlinkSync(`/proc/self/fd/${fd}`);
      if (!replaced && path.endsWith("/prepared.json")) {
        replaced = true;
        const file = join(h.base, "same-bytes-replacement");
        real.writeFileSync(file, real.readFileSync(path), { mode: 0o600 });
        real.renameSync(file, path);
      }
    });
    await expect(checkpointTerminalV2("fresh", h.options)).rejects.toMatchObject({
      code: "file-changed",
      effect: "none",
    });
    expect(replaced).toBe(true);
    expect(tree(h.stateDir)).toEqual({});
  });
  for (const mode of ["new", "retry", "rollback-original"] as const) {
    for (const attack of ["bytes", "inode", "symlink", "directory", "members", "root"]) {
      for (const target of mode === "new"
        ? ["prepared.json", "snapshot-0"]
        : ["prepared.json", "snapshot-0", "complete.json", ".complete-prepared"]) {
        it(`${mode}: ${target} ${attack} is rejected before any state mutation`, async () => {
          const h = setup();
          legacyLayout(h.stateDir);
          const checkpoint = mode === "new" ? undefined : await checkpointTerminalV2("checkpoint", h.options);
          const before = tree(h.stateDir);
          let validations = 0,
            attacked = false;
          h.audit.onRevalidate = () => {
            if (++validations !== 2) return;
            mutateEvidence(h, checkpoint?.transaction ?? real.readdirSync(h.evidenceDir)[0]!, target, attack);
            attacked = true;
          };
          const operation =
            mode === "rollback-original"
              ? rollbackTerminalV2(h.options)
              : checkpointTerminalV2("checkpoint", h.options);
          await expect(operation).rejects.toMatchObject({ effect: "none" });
          expect(attacked).toBe(true);
          expect(tree(h.stateDir)).toEqual(before);
        });
      }
    }
  }
});
describe("M2/M3 adapter and private scratch invariants", () => {
  it("deadline really elapses with signal still live; same-generation wrong proof is rejected", async () => {
    const h = setup(),
      signal = new AbortController().signal;
    const input = { stateDir: h.stateDir, operation: "fresh" as const, signal, deadline: Date.now() + 25 };
    const lease = await h.audit.acquire(input),
      snapshot = await lease.observe();
    expect(lease.current({ ...snapshot, proofId: "wrong-proof-same-generation" })).toBe(false);
    await expect(lease.revalidate({ ...snapshot, proofId: "wrong-proof-same-generation" })).rejects.toMatchObject({
      code: "snapshot-not-current",
    });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.max(1, input.deadline - Date.now() + 5));
      timer.unref();
    });
    expect(signal.aborted).toBe(false);
    expect(Date.now()).toBeGreaterThanOrEqual(input.deadline);
    expect(lease.current(snapshot)).toBe(false);
    await expect(lease.revalidate(snapshot)).rejects.toMatchObject({ code: "snapshot-not-current" });
    await lease.release();
  });
  it.each(["fresh", "checkpoint", "rollback"] as const)(
    "all nested %s evidence objects are recursively immutable",
    async (operation) => {
      const h = setup(),
        lease = await h.audit.acquire({
          stateDir: h.stateDir,
          operation,
          signal: new AbortController().signal,
          deadline: Date.now() + 1000,
        });
      const evidence = await lease.observe();
      const inspect = (value: object) => {
        expect(Object.isFrozen(value)).toBe(true);
        expect(() => Object.defineProperty(value, "forged", { value: true })).toThrow(TypeError);
        for (const child of Object.values(value)) if (child !== null && typeof child === "object") inspect(child);
      };
      inspect(evidence);
      await lease.release();
    },
  );
  it("actual engine deadline seals a pending observation and its late resolution", async () => {
    const h = setup(),
      before = tree(h.base),
      start = Date.now();
    const acquire = h.audit.acquire.bind(h.audit);
    let resolveLate!: () => void;
    const audit = {
      async acquire(input: Parameters<typeof acquire>[0]) {
        const lease = await acquire(input),
          snapshot = await lease.observe();
        lease.observe = () =>
          new Promise((resolve) => {
            resolveLate = () => resolve(snapshot);
          });
        return lease;
      },
    };
    await expect(checkpointTerminalV2("fresh", { ...h.options, audit, timeoutMs: 25 })).rejects.toMatchObject({
      code: "maintenance-deadline",
    });
    expect(Date.now()).toBeGreaterThanOrEqual(start + 25);
    expect(h.audit.locked).toBe(false);
    expect(h.audit.releaseCount).toBe(1);
    expect(resolveLate).toBeTypeOf("function");
    resolveLate();
    await Promise.resolve();
    expect(tree(h.base)).toEqual(before);
  });
  it("scratch follows caller TMPDIR and registers only the exact newly created root for cleanup", () => {
    const h = setup();
    expect(dirname(h.base)).toBe(tmpdir());
    expect(real.lstatSync(h.base).mode & 0o777).toBe(0o700);
  });
});
