import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sandboxHome } from "./helpers/home-sandbox.js";

/**
 * workflow-worktree plan §3 (P4 wt-orphans, test #26): the startup discovery +
 * once-per-process notify wired into `buildSessionStack`, plus §3 acceptance
 * (b) and (g). The pure scanner itself (§3 (a)-(f),(h)-(k)) is already fully
 * covered by tests/extensions/worktree-orphans.test.ts (P1) — this file only
 * exercises the STACK WIRING: does it call the scanner, does it notify at
 * most once per process, and does a child session ever get near it at all.
 *
 * `scanWorktreeOrphans`/`scanWorktreeOrphansAsync`/`worktreeRoot` are mocked so the wiring
 * test never touches the real shared `<tmpdir>/pi-subagent-worktrees` directory (which other
 * concurrently-running pi sessions on this machine may be actively writing to). A REAL,
 * unmocked-scanner exercise of the same wiring (real mkdtemp root, real fs/promises calls,
 * read-only assertion, and the hung-fs timeout path) lives in
 * `worktree-orphans-real-fs.test.ts` (P4 fix, 2026 review).
 *
 * P4 fix (2026 review): the startup scan is now fire-and-forget
 * (`void runOrphanStartupScan(...)`, never awaited from `buildSessionStack`) instead of a
 * synchronous call inline in session_start's critical path — every assertion below that
 * depends on the notify having fired now goes through `vi.waitFor` instead of asserting
 * immediately after `buildAndStop` returns.
 */

type OrphanEntry = { path: string; repo?: string; reason: string; notAWorktree?: boolean };
type OrphanScanResult = { root: string; count: number; capped: boolean; entries: OrphanEntry[] };

const harness = vi.hoisted(() => ({
  root: "/fake/pi-subagent-worktrees",
  scanResult: { root: "/fake/pi-subagent-worktrees", count: 0, capped: false, entries: [] } as OrphanScanResult,
}));

vi.mock("../../src/extensions/worktree-orphans.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/extensions/worktree-orphans.js")>();
  return {
    ...original,
    worktreeRoot: () => harness.root,
    scanWorktreeOrphans: () => harness.scanResult,
    scanWorktreeOrphansAsync: async () => harness.scanResult,
  };
});

// Imported AFTER the mock is registered (vi.mock calls are hoisted by vitest
// regardless of import order, but keeping them below documents the intent).
const { buildSessionStack } = await import("../../src/stack.js");
const { DEFAULT_SETTINGS } = await import("../../src/config/settings.js");
const activateModule = await import("../../src/index.js");
const activate = activateModule.default;

const WORKTREE_ORPHANS_NOTIFIED_KEY = Symbol.for("pi-subagent:worktree-orphans-notified");
const HOST_KEY = Symbol.for("pi-subagent:host");

let homeSandbox: ReturnType<typeof sandboxHome> | undefined;
beforeEach(() => {
  homeSandbox = sandboxHome();
  delete (globalThis as Record<symbol, unknown>)[WORKTREE_ORPHANS_NOTIFIED_KEY];
  delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  harness.root = "/fake/pi-subagent-worktrees";
  harness.scanResult = { root: harness.root, count: 0, capped: false, entries: [] };
});
afterEach(() => {
  homeSandbox?.restore();
  homeSandbox = undefined;
  delete (globalThis as Record<symbol, unknown>)[WORKTREE_ORPHANS_NOTIFIED_KEY];
  delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
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

function makeCtx(cwd: string, hasUI: boolean) {
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    cwd,
    hasUI,
    mode: hasUI ? "tui" : "print",
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: {
      getEntries: () => [],
      getBranch: () => [],
      getSessionId: () => "worktree-orphans-notify-test",
    },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    ui: hasUI ? { notify: (message: string, level: string) => notifications.push({ message, level }) } : undefined,
  } as never;
  return { ctx, notifications };
}

function buildAndStop(cwd: string, hasUI: boolean) {
  const env = makeCtx(cwd, hasUI);
  const stack = buildSessionStack(fakePi(), env.ctx, testSettings(), emptyTypes, []);
  stack.scheduler.stop();
  stack.rpc.close();
  return { stack, notifications: env.notifications };
}

/** The startup scan is fire-and-forget (never awaited by `buildSessionStack`): give its
 *  microtask chain (mocked scanner resolves instantly, but still async) a chance to settle
 *  before asserting on `notifications`. */
async function settleStartupScan(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("workflow-worktree plan §3 (P4): startup orphan notify wiring", () => {
  it("(a) no leftovers: does not notify and does not display anything", async () => {
    harness.scanResult = { root: harness.root, count: 0, capped: false, entries: [] };
    const { notifications } = buildAndStop("/tmp/wt-notify-a", true);
    await settleStartupScan();
    expect(notifications).toHaveLength(0);
    expect((globalThis as Record<symbol, unknown>)[WORKTREE_ORPHANS_NOTIFIED_KEY]).toBeUndefined();
  });

  it("(b) leftovers + hasUI: notifies exactly once per PROCESS, with count/root/paths/commands", async () => {
    harness.scanResult = {
      root: harness.root,
      count: 3,
      capped: false,
      entries: [
        { path: `${harness.root}/wt-1`, reason: "owner-dead" },
        { path: `${harness.root}/wt-2`, reason: "no-owner" },
        { path: `${harness.root}/wt-3`, reason: "creating-abandoned" },
      ],
    };
    const first = buildAndStop("/tmp/wt-notify-b1", true);
    await vi.waitFor(() => expect(first.notifications).toHaveLength(1), { timeout: 2000, interval: 10 });
    const text = first.notifications[0]!.message;
    expect(text).toContain("3");
    expect(text).toContain(harness.root);
    expect(text).toContain(`${harness.root}/wt-1`);
    expect(text).toContain("owner-dead");
    expect(text).toContain("worktree remove --force");
    expect(text).toContain("worktree prune");
    expect(first.notifications[0]!.level).toBe("warning");

    // Same process, another session_start (e.g. /reload, or resume): must NOT
    // notify a second time even though the leftovers are still there.
    const second = buildAndStop("/tmp/wt-notify-b2", true);
    await settleStartupScan();
    expect(second.notifications).toHaveLength(0);
  });

  it("a headless/print session_start does not consume the one-time flag", async () => {
    harness.scanResult = {
      root: harness.root,
      count: 1,
      capped: false,
      entries: [{ path: `${harness.root}/wt-1`, reason: "owner-dead" }],
    };
    const headless = buildAndStop("/tmp/wt-notify-headless", false);
    await settleStartupScan();
    expect(headless.notifications).toHaveLength(0);
    expect((globalThis as Record<symbol, unknown>)[WORKTREE_ORPHANS_NOTIFIED_KEY]).toBeUndefined();

    // A LATER TUI session in the same process still gets its one notify.
    const tui = buildAndStop("/tmp/wt-notify-tui", true);
    await vi.waitFor(() => expect(tui.notifications).toHaveLength(1), { timeout: 2000, interval: 10 });
  });

  it("(k) an 'abandoned' entry (D12 compensation failure) shows up in the notice", async () => {
    harness.scanResult = {
      root: harness.root,
      count: 1,
      capped: false,
      entries: [{ path: `${harness.root}/wt-stuck`, reason: "abandoned" }],
    };
    const { notifications } = buildAndStop("/tmp/wt-notify-k", true);
    await vi.waitFor(() => expect(notifications).toHaveLength(1), { timeout: 2000, interval: 10 });
    expect(notifications[0]!.message).toContain(`${harness.root}/wt-stuck`);
    expect(notifications[0]!.message).toContain("abandoned");
  });

  it("Stack.worktreeOrphans() rescans live — it is not a snapshot of the startup scan", () => {
    harness.scanResult = { root: harness.root, count: 0, capped: false, entries: [] };
    const env = makeCtx("/tmp/wt-notify-live", true);
    const stack = buildSessionStack(fakePi(), env.ctx, testSettings(), emptyTypes, []);
    expect(stack.worktreeOrphans().count).toBe(0);
    harness.scanResult = {
      root: harness.root,
      count: 2,
      capped: false,
      entries: [
        { path: `${harness.root}/wt-a`, reason: "no-owner" },
        { path: `${harness.root}/wt-b`, reason: "no-owner" },
      ],
    };
    expect(stack.worktreeOrphans().count).toBe(2);
    stack.scheduler.stop();
    stack.rpc.close();
  });

  it("does not depend on worktree.enabled — leftovers still get discovered and notified when the feature is off", async () => {
    harness.scanResult = {
      root: harness.root,
      count: 1,
      capped: false,
      entries: [{ path: `${harness.root}/wt-off`, reason: "owner-dead" }],
    };
    const env = makeCtx("/tmp/wt-notify-disabled", true);
    const settings = { ...testSettings(), worktree: { ...DEFAULT_SETTINGS.worktree, enabled: false } };
    const stack = buildSessionStack(fakePi(), env.ctx, settings, emptyTypes, []);
    await vi.waitFor(() => expect(env.notifications).toHaveLength(1), { timeout: 2000, interval: 10 });
    expect(stack.worktreeOrphans().count).toBe(1);
    stack.scheduler.stop();
    stack.rpc.close();
  });
});

describe("workflow-worktree plan §3 (g): child sessions never scan", () => {
  it("a child session (HOST_KEY pre-claimed) never registers /agent status (and so never reaches the orphan scan/notify wiring)", () => {
    (globalThis as Record<symbol, unknown>)[HOST_KEY] = { activatedAt: Date.now() };
    const commands = new Map<string, unknown>();
    const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const pi = {
      registerTool: () => undefined,
      registerCommand: (name: string, cmd: unknown) => commands.set(name, cmd),
      on: (event: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      sendMessage: () => undefined,
      appendEntry: () => undefined,
      events: { on: () => () => undefined, emit: () => undefined },
      exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
    } as never;
    activate(pi);
    // Both the worktree-orphans wiring's entry points — the main-session
    // session_start handler that calls buildSessionStack (which does the
    // startup scan+notify) and the `/agent status` command (which re-scans
    // on every call via `holder.current?.worktreeOrphans()`) — sit strictly
    // after the HOST_KEY guard. A child activation returns before either is
    // ever registered, so a child session structurally cannot reach the
    // scanner (the pre-guard handlers that DO register, e.g. memory/sysprompt,
    // are unrelated to worktree orphans and never call it).
    expect(commands.has("agent")).toBe(false);
  });
});
