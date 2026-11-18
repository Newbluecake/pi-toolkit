/** Real ledger IO with barriers around its actual FileHandle.read / rename phases.
 * Guards are invalidated without aborting, so AbortSignal-only checks cannot pass. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, readdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTerminalAllocationLedgerV2 } from "../../../../../src/web-hub/hub/terminal/v2/ledger.js";
import { retireOldKernelAllocationsV2 } from "../../../../../src/web-hub/hub/terminal/v2/retirement.js";
import type { TerminalAllocationLedgerPortV2 } from "../../../../../src/web-hub/hub/terminal-v2-ports.js";
import type { AllocationV2, LedgerV2 } from "../../../../../src/web-hub/protocol/terminal-v2.js";
const hooks = vi.hoisted(() => ({
  afterWitnessRead: undefined as undefined | (() => void | Promise<void>),
  afterDirectoryClose: undefined as undefined | ((path: string) => void),
  failSyscall: undefined as
    | undefined
    | "file-sync"
    | "rename"
    | "parent-sync"
    | "completion-file-sync"
    | "completion-rename"
    | "completion-dir-sync",
  completionPublished: false,
  failedSyscallCalls: 0,
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const h = await fs.open(...args);
      const path = String(args[0]),
        sync = h.sync;
      Object.defineProperty(h, "sync", {
        configurable: true,
        value: async () => {
          if (
            (hooks.failSyscall === "file-sync" && path.includes("/.ledger-")) ||
            (hooks.failSyscall === "parent-sync" && path.endsWith("/terminal-v2")) ||
            (hooks.failSyscall === "completion-file-sync" && path.endsWith("/.completion-prepared")) ||
            (hooks.failSyscall === "completion-dir-sync" && hooks.completionPublished && /\/[a-f0-9]{32}$/.test(path))
          ) {
            hooks.failedSyscallCalls++;
            throw new Error("injected actual sync rejection");
          }
          return Reflect.apply(sync, h, []);
        },
      });
      const close = h.close;
      Object.defineProperty(h, "close", {
        configurable: true,
        value: async () => {
          await Reflect.apply(close, h, []);
          hooks.afterDirectoryClose?.(path);
        },
      });
      if (String(args[0]).endsWith("/.terminal-initialized-v2")) {
        const read = h.read;
        Object.defineProperty(h, "read", {
          configurable: true,
          value: async (...readArgs: unknown[]) => {
            const result: unknown = await Reflect.apply(read, h, readArgs);
            await hooks.afterWitnessRead?.();
            return result;
          },
        });
      }
      return h;
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      if (hooks.failSyscall === "rename") {
        hooks.failedSyscallCalls++;
        throw new Error("injected actual rename rejection");
      }
      if (String(args[1]).endsWith("/completion.json")) {
        if (hooks.failSyscall === "completion-rename") {
          hooks.failedSyscallCalls++;
          throw new Error("injected actual completion rename rejection");
        }
        await fs.rename(...args);
        hooks.completionPublished = true;
        return;
      }
      return fs.rename(...args);
    },
  };
});
const roots: string[] = [];
const boot = "11111111-1111-4111-8111-111111111111",
  old = "22222222-2222-4222-8222-222222222222";
const signal = () => new AbortController().signal;
const row: AllocationV2 = {
  allocationId: "a".repeat(24),
  termId: "t".repeat(24),
  kernelBootId: old,
  hubInstance: "h".repeat(24),
  scope: { agentKey: "a", sessionId: "s", epoch: "e" },
  quotaSessionKey: "s",
  principalKey: "lan:u1",
  creatorSidTag: "a".repeat(43),
};
async function fixture(allocations: AllocationV2[] = []) {
  const root = await mkdtemp(join(tmpdir(), "v2-await-"));
  roots.push(root);
  await chmod(root, 0o700);
  await mkdir(join(root, "terminal-v2"), { mode: 0o700 });
  const marker = { v: 2, storeId: "s".repeat(24), initialization: "fresh", checkpointId: "c".repeat(24) };
  const ledger: LedgerV2 = { v: 2, storeId: marker.storeId, revision: 0, allocations };
  const path = join(root, "terminal-v2/ledger.json");
  await writeFile(path, JSON.stringify(ledger), { mode: 0o600 });
  await writeFile(join(root, "terminal-v2/marker.json"), JSON.stringify(marker), { mode: 0o600 });
  await writeFile(join(root, ".terminal-initialized-v2"), JSON.stringify(marker), { mode: 0o600 });
  return { root, path, ledger };
}
const kernelEvidence = async () => ({
  bootId: boot,
  pidNamespace: "pid:[1]",
  mountNamespace: "mnt:[2]",
  userNamespace: "user:[3]",
});
async function evidencePath(root: string) {
  const archive = join(root, ".terminal-allocation-archive-v2");
  const entries = await readdir(archive);
  expect(entries).toHaveLength(1);
  return join(archive, entries[0]!, "evidence.json");
}
afterEach(async () => {
  hooks.afterWitnessRead = undefined;
  hooks.afterDirectoryClose = undefined;
  hooks.failSyscall = undefined;
  hooks.failedSyscallCalls = 0;
  hooks.completionPublished = false;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe("P1 verifier B1/B2 await-boundary regressions", () => {
  it("B1 evidence changed at the real ledger before-rename barrier MUST retain the exact rows", async () => {
    const f = await fixture([row]);
    let attacked = false;
    const ledger = createTerminalAllocationLedgerV2({
      stateDir: f.root,
      current: () => true,
      stage: async (stage) => {
        if (stage === "before-rename") {
          await writeFile(await evidencePath(f.root), "BROKEN EVIDENCE");
          attacked = true;
        }
      },
    });
    expect(
      await retireOldKernelAllocationsV2({ stateDir: f.root, ledger, current: () => true, kernelEvidence }, signal()),
    ).toEqual({ kind: "retained", count: 1 });
    expect(attacked).toBe(true);
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(f.ledger);
    expect((await ledger.load(signal())).kind).toBe("loaded");
  });
  it.each(["same-length-bytes", "file-inode", "transaction-dir", "archive-dir"] as const)(
    "B1 before-rename %s swap cannot retire",
    async (attack) => {
      const f = await fixture([row]);
      let attacked = false;
      const ledger = createTerminalAllocationLedgerV2({
        stateDir: f.root,
        current: () => true,
        stage: async (stage) => {
          if (stage !== "before-rename") return;
          const path = await evidencePath(f.root),
            bytes = await readFile(path),
            tx = path.slice(0, path.lastIndexOf("/")),
            archive = tx.slice(0, tx.lastIndexOf("/"));
          if (attack === "same-length-bytes") await writeFile(path, Buffer.alloc(bytes.length, 88));
          if (attack === "file-inode") {
            await writeFile(`${path}.replacement`, bytes, { mode: 0o600 });
            await rename(`${path}.replacement`, path);
          }
          if (attack === "transaction-dir") {
            await rename(tx, `${tx}-old`);
            await mkdir(tx, { mode: 0o700 });
            await writeFile(path, bytes, { mode: 0o600 });
          }
          if (attack === "archive-dir") {
            await rename(archive, `${archive}-old`);
            await mkdir(archive, { mode: 0o700 });
            await mkdir(tx, { mode: 0o700 });
            await writeFile(path, bytes, { mode: 0o600 });
          }
          attacked = true;
        },
      });
      expect(
        await retireOldKernelAllocationsV2({ stateDir: f.root, ledger, current: () => true, kernelEvidence }, signal()),
      ).toEqual({ kind: "retained", count: 1 });
      expect(attacked).toBe(true);
      expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(f.ledger);
      expect((await ledger.load(signal())).kind).toBe("loaded");
    },
  );
  it("B1 synchronous pre-rename guard throw is none, old bytes exact, ledger remains usable", async () => {
    const f = await fixture();
    const ledger = createTerminalAllocationLedgerV2({ stateDir: f.root, current: () => true });
    await ledger.load(signal());
    let guards = 0;
    expect(
      await ledger.commitGuarded(0, { ...f.ledger, revision: 1, allocations: [row] }, signal(), () => {
        guards++;
        throw new Error("evidence invalid");
      }),
    ).toEqual({ kind: "unavailable", effect: "none" });
    expect(guards).toBe(1);
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(f.ledger);
    expect(await ledger.commit(0, { ...f.ledger, revision: 1 }, signal())).toEqual({ kind: "committed", revision: 1 });
  });
  it("B1 post-rename guard failure is unknown, never a successful retirement/admission fact", async () => {
    const f = await fixture();
    const ledger = createTerminalAllocationLedgerV2({ stateDir: f.root, current: () => true });
    await ledger.load(signal());
    let guards = 0;
    const next = { ...f.ledger, revision: 1, allocations: [row] };
    expect(
      await ledger.commitGuarded(0, next, signal(), () => {
        if (++guards === 2) throw new Error("evidence lost");
      }),
    ).toEqual({ kind: "unavailable", effect: "unknown" });
    expect(guards).toBe(2);
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(next);
    expect(await ledger.load(signal())).toEqual({ kind: "unavailable" });
  });
  it("B1 retirement evidence lost during the final post-rename witness read is unknown", async () => {
    const f = await fixture([row]);
    let afterRename = false,
      attacked = false;
    const ledger = createTerminalAllocationLedgerV2({
      stateDir: f.root,
      current: () => true,
      stage: async (stage) => {
        if (stage === "after-rename") afterRename = true;
      },
    });
    hooks.afterWitnessRead = async () => {
      if (afterRename) {
        await writeFile(await evidencePath(f.root), "BROKEN EVIDENCE");
        attacked = true;
      }
    };
    expect(
      await retireOldKernelAllocationsV2({ stateDir: f.root, ledger, current: () => true, kernelEvidence }, signal()),
    ).toEqual({ kind: "unavailable" });
    expect(attacked).toBe(true);
    expect(JSON.parse(await readFile(f.path, "utf8")).allocations).toEqual([]);
    expect(await ledger.load(signal())).toEqual({ kind: "unavailable" });
  });
  it("B1 a plain P0 port cannot silently fall back to unguarded retirement", async () => {
    const f = await fixture([row]);
    let calls = 0;
    const ledger: TerminalAllocationLedgerPortV2 = {
      load: async () => {
        calls++;
        return { kind: "loaded", ledger: f.ledger };
      },
      commit: async () => {
        calls++;
        return { kind: "committed", revision: 1 };
      },
    };
    // @ts-expect-error P1 retirement requires the local guarded capability, not only P0.
    expect(
      await retireOldKernelAllocationsV2({ stateDir: f.root, ledger, current: () => true, kernelEvidence }, signal()),
    ).toEqual({ kind: "unavailable" });
    expect(calls).toBe(0);
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(f.ledger);
  });
  it.each(["file-sync", "rename", "parent-sync"] as const)(
    "actual %s syscall rejection retains the none/unknown boundary",
    async (syscall) => {
      const f = await fixture();
      const ledger = createTerminalAllocationLedgerV2({ stateDir: f.root, current: () => true });
      await ledger.load(signal());
      hooks.failSyscall = syscall;
      const next = { ...f.ledger, revision: 1, allocations: [row] };
      expect(await ledger.commit(0, next, signal())).toEqual({
        kind: "unavailable",
        effect: syscall === "file-sync" ? "none" : "unknown",
      });
      expect(hooks.failedSyscallCalls).toBe(1);
      expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(syscall === "parent-sync" ? next : f.ledger);
      hooks.failSyscall = undefined;
      if (syscall === "file-sync")
        expect(await ledger.commit(0, next, signal())).toEqual({ kind: "committed", revision: 1 });
      else expect(await ledger.load(signal())).toEqual({ kind: "unavailable" });
    },
  );
  it("B2 final descriptor cleanup await also cannot return success to a retired owner", async () => {
    const f = await fixture();
    let current = true,
      afterRename = false,
      closed = false;
    const ledger = createTerminalAllocationLedgerV2({
      stateDir: f.root,
      current: () => current,
      stage: async (stage) => {
        if (stage === "after-rename") afterRename = true;
      },
    });
    await ledger.load(signal());
    hooks.afterDirectoryClose = (path) => {
      if (afterRename && path === f.root) {
        current = false;
        closed = true;
      }
    };
    expect(await ledger.commit(0, { ...f.ledger, revision: 1, allocations: [row] }, signal())).toEqual({
      kind: "unavailable",
      effect: "unknown",
    });
    expect(closed).toBe(true);
  });
  it("B2 deadline crossed during final witness IO cannot adopt/return committed without an abort", async () => {
    const f = await fixture();
    let afterRename = false,
      late = false;
    const ledger = createTerminalAllocationLedgerV2({
      stateDir: f.root,
      current: () => true,
      stage: async (stage) => {
        if (stage === "after-rename") afterRename = true;
      },
    });
    await ledger.load(signal());
    const now = Date.now(),
      clock = vi.spyOn(Date, "now");
    hooks.afterWitnessRead = () => {
      if (afterRename) {
        clock.mockReturnValue(now + 10000);
        late = true;
      }
    };
    const sig = signal();
    expect(await ledger.commit(0, { ...f.ledger, revision: 1, allocations: [row] }, sig)).toEqual({
      kind: "unavailable",
      effect: "unknown",
    });
    expect(late).toBe(true);
    expect(sig.aborted).toBe(false);
    clock.mockRestore();
    expect(await ledger.load(signal())).toEqual({ kind: "unavailable" });
  });
  it("guarded capability rejects an accidentally async guard instead of silently ignoring its Promise", async () => {
    const f = await fixture();
    const ledger = createTerminalAllocationLedgerV2({ stateDir: f.root, current: () => true });
    await ledger.load(signal());
    // @ts-expect-error A guarded mutation requires undefined synchronously, never Promise<void>.
    expect(
      await ledger.commitGuarded(0, { ...f.ledger, revision: 1, allocations: [row] }, signal(), async () => {}),
    ).toEqual({ kind: "unavailable", effect: "none" });
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(f.ledger);
  });
  it("B2 current-only invalidation during the final witness read cannot publish committed", async () => {
    const f = await fixture();
    let current = true,
      afterRename = false,
      invalidated = false;
    const ledger = createTerminalAllocationLedgerV2({
      stateDir: f.root,
      current: () => current,
      stage: async (stage) => {
        if (stage === "after-rename") afterRename = true;
      },
    });
    expect((await ledger.load(signal())).kind).toBe("loaded");
    hooks.afterWitnessRead = () => {
      if (afterRename) {
        current = false;
        invalidated = true;
      }
    };
    const sig = signal();
    const next = { ...f.ledger, revision: 1, allocations: [row] };
    expect(await ledger.commit(0, next, sig)).toEqual({ kind: "unavailable", effect: "unknown" });
    expect(invalidated).toBe(true);
    expect(sig.aborted).toBe(false);
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(next);
    current = true;
    expect(await ledger.load(signal())).toEqual({ kind: "unavailable" });
  });
  it("B2 delayed IO from an old generation never adopts its final read after the owner changes", async () => {
    const f = await fixture();
    let generation = 1,
      afterRename = false;
    let entered!: () => void, release!: () => void;
    const entry = new Promise<void>((r) => {
        entered = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    const captured = generation;
    const ledger = createTerminalAllocationLedgerV2({
      stateDir: f.root,
      current: () => generation === captured,
      stage: async (stage) => {
        if (stage === "after-rename") afterRename = true;
      },
    });
    await ledger.load(signal());
    hooks.afterWitnessRead = async () => {
      if (afterRename) {
        entered();
        await gate;
      }
    };
    const sig = signal(),
      work = ledger.commit(0, { ...f.ledger, revision: 1, allocations: [row] }, sig);
    await entry;
    generation++;
    release();
    expect(await work).toEqual({ kind: "unavailable", effect: "unknown" });
    expect(sig.aborted).toBe(false);
    expect(await ledger.commit(1, { ...f.ledger, revision: 2 }, signal())).toEqual({
      kind: "unavailable",
      effect: "none",
    });
  });
});

describe("P6 completion publication is downstream of real committed prune", () => {
  it.each(["completion-file-sync", "completion-rename", "completion-dir-sync"] as const)(
    "%s failure preserves partials and cannot report retired",
    async (fault) => {
      const f = await fixture([row]);
      const ledger = createTerminalAllocationLedgerV2({ stateDir: f.root, current: () => true });
      hooks.failSyscall = fault;
      expect(
        await retireOldKernelAllocationsV2({ stateDir: f.root, ledger, current: () => true, kernelEvidence }, signal()),
      ).toEqual({ kind: "unavailable" });
      expect(hooks.failedSyscallCalls).toBe(1);
      expect(JSON.parse(await readFile(f.path, "utf8")).allocations).toEqual([]);
      const evidence = await evidencePath(f.root);
      expect((await readdir(evidence.slice(0, evidence.lastIndexOf("/")))).sort()).toEqual(
        fault === "completion-dir-sync"
          ? ["completion.json", "evidence.json"]
          : [".completion-prepared", "evidence.json"],
      );
      // A publication fault does not invent a failed prune or resurrect physical rows.
      expect(await ledger.load(signal())).toMatchObject({ kind: "loaded", ledger: { revision: 1, allocations: [] } });
    },
  );
  it("unknown prune never begins completion publication", async () => {
    const f = await fixture([row]);
    const ledger = createTerminalAllocationLedgerV2({
      stateDir: f.root,
      current: () => true,
      stage: async (stage) => {
        if (stage === "parent-sync") throw new Error("actual ledger barrier failure");
      },
    });
    expect(
      await retireOldKernelAllocationsV2({ stateDir: f.root, ledger, current: () => true, kernelEvidence }, signal()),
    ).toEqual({ kind: "unavailable" });
    const evidence = await evidencePath(f.root);
    expect(await readdir(evidence.slice(0, evidence.lastIndexOf("/")))).toEqual(["evidence.json"]);
  });
});
