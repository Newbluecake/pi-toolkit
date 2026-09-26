import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sandboxHome } from "./helpers/home-sandbox.js";

/**
 * workflow-worktree plan §3 (P4 fix, 2026 review acceptance turn-back): unlike
 * `worktree-orphans-notify.test.ts` (which mocks `scanWorktreeOrphans`/`scanWorktreeOrphansAsync`
 * themselves so it never touches disk), this file exercises the REAL scanner against a REAL
 * mkdtemp temp root — only `worktreeRoot()` is overridden (the existing test seam) to point at
 * it, so the fire-and-forget startup scan wired into `buildSessionStack` runs genuine
 * `node:fs/promises` calls end to end.
 *
 * Covers the two properties the synchronous-scan bug report flagged:
 *  - the scan is read-only (no write/unlink call ever reaches the real fs module during a scan)
 *  - a hung root (readdir that never resolves — the NFS/slow-disk case) does not block
 *    `buildSessionStack`'s return, its overall timeout is unref'd, and past that timeout the
 *    scan is abandoned silently (no notify, no crash).
 */

const fsHarness = vi.hoisted(() => ({ hang: false, writeCalls: 0, unlinkCalls: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readdir: (...args: Parameters<typeof original.readdir>) => {
      if (fsHarness.hang) return new Promise(() => {}); // simulates a hung NFS-backed root — never settles
      return original.readdir(...(args as Parameters<typeof original.readdir>));
    },
    writeFile: (...args: Parameters<typeof original.writeFile>) => {
      fsHarness.writeCalls += 1;
      return original.writeFile(...args);
    },
    unlink: (...args: Parameters<typeof original.unlink>) => {
      fsHarness.unlinkCalls += 1;
      return original.unlink(...args);
    },
    rm: (...args: Parameters<typeof original.rm>) => {
      fsHarness.unlinkCalls += 1;
      return original.rm(...args);
    },
    rmdir: (...args: Parameters<typeof original.rmdir>) => {
      fsHarness.unlinkCalls += 1;
      return original.rmdir(...args);
    },
  };
});

const rootHarness = vi.hoisted(() => ({ root: "" }));
vi.mock("../../src/extensions/worktree-orphans.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/extensions/worktree-orphans.js")>();
  return { ...original, worktreeRoot: () => rootHarness.root };
});

// Imported AFTER the mocks are registered (vi.mock calls are hoisted by vitest regardless).
const { buildSessionStack } = await import("../../src/stack.js");
const { DEFAULT_SETTINGS } = await import("../../src/config/settings.js");

const WORKTREE_ORPHANS_NOTIFIED_KEY = Symbol.for("pi-subagent:worktree-orphans-notified");

let homeSandbox: ReturnType<typeof sandboxHome> | undefined;
const dirs: string[] = [];

function makeRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "pi-subagent-orphans-realfs-"));
  dirs.push(d);
  return d;
}

/** A worktree dir with a marker whose owner pid is (almost certainly) dead, so the real
 *  scanner classifies it as `owner-dead` without needing to fake `isPidAlive`. */
function makeDeadOwnerDir(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".git"), `gitdir: /repo/.git/worktrees/${name}\n`);
  mkdirSync(join(root, ".owners"), { recursive: true });
  writeFileSync(
    join(root, ".owners", `${name}.json`),
    JSON.stringify({
      v: 1,
      state: "active",
      owner: { pid: 999_999, procStartedAt: 0, instanceId: "dead" },
      runId: name,
      repo: "/repo",
      path: dir,
      createdAt: Date.now(),
    }),
  );
  return dir;
}

beforeEach(() => {
  homeSandbox = sandboxHome();
  fsHarness.hang = false;
  fsHarness.writeCalls = 0;
  fsHarness.unlinkCalls = 0;
  delete (globalThis as Record<symbol, unknown>)[WORKTREE_ORPHANS_NOTIFIED_KEY];
});
afterEach(() => {
  vi.unstubAllGlobals();
  homeSandbox?.restore();
  homeSandbox = undefined;
  delete (globalThis as Record<symbol, unknown>)[WORKTREE_ORPHANS_NOTIFIED_KEY];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const emptyTypes = { get: () => undefined, list: () => [], reload: async () => ({ types: [], errors: [] }) } as never;

function testSettings() {
  return {
    ...DEFAULT_SETTINGS,
    fleetWidget: false,
    bashJobs: { ...DEFAULT_SETTINGS.bashJobs, autoBackgroundMs: 0 },
  };
}

function fakePi() {
  return {
    sendMessage: () => undefined,
    sendUserMessage: () => undefined,
    appendEntry: () => undefined,
    exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
    events: { emit: () => undefined, on: () => () => undefined },
  } as never;
}

function makeCtx(cwd: string) {
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    cwd,
    hasUI: true,
    mode: "tui",
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: {
      getEntries: () => [],
      getBranch: () => [],
      getSessionId: () => "worktree-orphans-real-fs-test",
    },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
  } as never;
  return { ctx, notifications };
}

describe("workflow-worktree plan §3 (P4 fix): real-fs startup scan wiring", () => {
  it("scans a real mkdtemp root read-only and still notifies (no scanner mocking)", async () => {
    const root = makeRoot();
    rootHarness.root = root;
    makeDeadOwnerDir(root, "wt-dead-1");
    makeDeadOwnerDir(root, "wt-dead-2");

    const env = makeCtx("/tmp/wt-realfs-a");
    const stack = buildSessionStack(fakePi(), env.ctx, testSettings(), emptyTypes, []);
    try {
      await vi.waitFor(() => expect(env.notifications).toHaveLength(1), { timeout: 3000, interval: 20 });
      const message = env.notifications[0]!.message;
      expect(message).toContain(root);
      expect(message).toContain("owner-dead");
      expect(message).toContain(join(root, "wt-dead-1"));
      // Read-only: the scan never writes or unlinks anything on a real filesystem.
      expect(fsHarness.writeCalls).toBe(0);
      expect(fsHarness.unlinkCalls).toBe(0);
    } finally {
      stack.scheduler.stop();
      stack.rpc.close();
    }
  });

  it("a hung root (readdir never resolves) does not block buildSessionStack and abandons without notifying", async () => {
    const root = makeRoot();
    rootHarness.root = root;
    makeDeadOwnerDir(root, "wt-dead-1");
    fsHarness.hang = true;

    // Spy on the global setTimeout WITHOUT changing its behavior for any caller — only
    // record whether `.unref()` gets called on the specific 5000ms timer the startup scan's
    // overall budget creates (stack.ts's runOrphanStartupScan default). Every other timer in
    // the stack (schedulers, watchdogs, etc.) passes through completely unaffected.
    const realSetTimeout = globalThis.setTimeout;
    let sawUnrefFor5s = false;
    const setTimeoutSpy = vi.fn(((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
      const timer = realSetTimeout(handler as never, ms, ...args);
      if (ms === 5000) {
        const originalUnref = timer.unref?.bind(timer);
        timer.unref = (() => {
          sawUnrefFor5s = true;
          return originalUnref?.();
        }) as typeof timer.unref;
      }
      return timer;
    }) as typeof setTimeout);
    vi.stubGlobal("setTimeout", setTimeoutSpy);

    const env = makeCtx("/tmp/wt-realfs-b");
    const startedAt = Date.now();
    const stack = buildSessionStack(fakePi(), env.ctx, testSettings(), emptyTypes, []);
    const elapsedMs = Date.now() - startedAt;
    try {
      // The hung readdir() never resolves, yet buildSessionStack returned immediately —
      // the startup scan is fire-and-forget and never awaited from session_start's path.
      expect(elapsedMs).toBeLessThan(500);
      expect(sawUnrefFor5s).toBe(true);

      // Real-time wait past the 5s overall budget: the scan must abandon silently — no
      // notify, no thrown error, no crash — once its timeout elapses.
      await new Promise((resolve) => realSetTimeout(resolve, 5200));
      expect(env.notifications).toHaveLength(0);
      expect((globalThis as Record<symbol, unknown>)[WORKTREE_ORPHANS_NOTIFIED_KEY]).toBeUndefined();
    } finally {
      stack.scheduler.stop();
      stack.rpc.close();
    }
  }, 10_000);
});
