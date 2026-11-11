/** P1 integration seam only: the consumer below is TEST-OWNED. Production
 * memory/index.ts is deliberately not wired by this package. Real natural
 * session_start + actual SDK manager + existing scopes owner + original D/C/lock
 * prove the callable boundary, NOT that startup diagnostics have shipped. */
import * as fs from "node:fs";
import { join } from "node:path";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { fakePi, emitAll } from "./helpers/schedule-activate.js";
import { startupFixture, startupTree } from "../memory/govern/revision-startup-helpers.js";
import { loadSettings } from "../../src/config/settings.js";
import { wireMemoryScopes } from "../../src/memory/scopes/wire.js";
import { runRevisionStartupDiagnostics } from "../../src/memory/govern/revision-startup-diagnostics.js";
import type {
  RevisionStartupDiagnosticsInput,
  RevisionStartupDiagnosticsResult,
} from "../../src/memory/govern/revision-startup-diagnostics.js";
import * as auditModule from "../../src/memory/govern/revision-audit.js";
import * as safeFs from "../../src/memory/safe-fs.js";
import * as lockModule from "../../src/memory/lock.js";

const closes: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of closes.splice(0)) close();
});
function naturalHost(
  dir: string,
  options: {
    domain?: "plain" | "secure" | "locked";
    child?: boolean;
    enabled?: boolean;
    scopesOff?: boolean;
    noOwner?: boolean;
    hubOnly?: boolean;
  } = {},
) {
  const f = fakePi(),
    lifecycle = new AbortController();
  const settings = loadSettings({
    memory: {
      enabled: options.enabled ?? true,
      scopes: { session: !options.scopesOff && !options.hubOnly, hub: options.hubOnly ?? false },
      governance: { enabled: false },
      jev: { enabled: false },
      incremental: { enabled: false, auto: false, jobCostCapUsd: 0 },
    },
  }).memory;
  const domain = options.domain ?? "plain",
    child = options.child ?? false;
  const manager = SessionManager.inMemory("/");
  const notify = vi.fn(),
    append = vi.spyOn(f.pi, "appendEntry"),
    remote = vi.fn(() => undefined);
  const ctx = {
    cwd: "/",
    mode: "tui",
    hasUI: true,
    ui: { notify },
    sessionManager: manager,
    isIdle: () => true,
    hasPendingMessages: () => false,
  } as unknown as ExtensionContext;
  // Real owner is created by ITS existing natural session_start, not by P1.
  const scopes = options.noOwner
    ? undefined
    : wireMemoryScopes(f.pi, {
        settings,
        domain,
        child,
        gate: { check: () => ({ ok: true }) },
        locked: () => false,
        remote,
        hubPaths: () => ({ stateDir: join(dir, "absent-hub-state") }),
      });
  if (scopes) closes.push(() => scopes.dispose());
  closes.push(() => lifecycle.abort());
  const gate = { capture: vi.fn(), check: vi.fn(() => ({ ok: true as const })) };
  const results: RevisionStartupDiagnosticsResult[] = [];
  const inputs: RevisionStartupDiagnosticsInput[] = [];
  // I1 alone will decide the actual insertion into memory/index. This temporary
  // test consumer is NOT part of activate/wireMemory and adds no production hook.
  f.pi.on("session_start", async (_event, actualContext) => {
    const input: RevisionStartupDiagnosticsInput = {
      memoryDir: dir,
      actualContext,
      settings,
      domain,
      isChildSession: child,
      ...(scopes ? { scopes } : {}),
      gate,
      signal: lifecycle.signal,
      isCurrent: () => !lifecycle.signal.aborted,
      warn: (text) => actualContext.ui.notify(text, "warning"),
    };
    inputs.push(input);
    results.push(await runRevisionStartupDiagnostics(input));
  });
  Object.defineProperty(ctx, "modelRegistry", {
    get() {
      throw Error("provider must not be consulted by startup");
    },
  });
  return {
    ...f,
    ctx,
    manager,
    settings,
    scopes,
    lifecycle,
    notify,
    gate,
    append,
    remote,
    results,
    inputs,
    start: () => emitAll(f, "session_start", { type: "session_start", reason: "startup" }, ctx),
  };
}
function scanObserver(onScanned?: () => void) {
  const original = auditModule.createRevisionAuditPort;
  const scans = vi.fn();
  const factory = vi.spyOn(auditModule, "createRevisionAuditPort").mockImplementation((dir, deps) => {
    const c = original(dir, deps);
    return {
      ...c,
      scanPendingLocked: () => {
        expect(fs.existsSync(join(dir, ".lock"))).toBe(true);
        scans();
        const rows = c.scanPendingLocked();
        onScanned?.();
        return rows;
      },
    };
  });
  return { scans, factory };
}

it("natural start consumes actual owner/manager once, independent of disabled Jev/P50/auto/cap; no content or namespace writes", async () => {
  const f = await startupFixture(["prepared", "proposed", "marker-missing", "unknown", "corrupt", "missing"]);
  const before = startupTree(f.dir),
    h = naturalHost(f.dir);
  expect(h.scopes?.current()).toBeUndefined();
  const { scans } = scanObserver();
  await h.start();
  expect(h.inputs).toHaveLength(1);
  expect(h.inputs[0]!.actualContext).toBe(h.ctx);
  expect(h.scopes?.current()?.manager).toBe(h.manager);
  expect(h.scopes?.current()?.owner.sessionEpoch).toBe(1);
  expect(scans).toHaveBeenCalledTimes(1);
  expect(h.results).toMatchObject([
    {
      kind: "scanned",
      warned: true,
      summary: {
        counts: { skipped: 2, "commit-unknown": 2, corrupted: 2 },
      },
    },
  ]);
  expect(h.notify).toHaveBeenCalledTimes(1);
  expect(h.notify.mock.calls[0]?.[1]).toBe("warning");
  const text = String(h.notify.mock.calls[0]?.[0]);
  expect(text).toContain(f.records[2]!.frozen.actionId);
  expect(text).not.toContain(f.dir);
  expect(text).not.toContain("PRIVATE_TEST_BODY");
  expect(text).not.toContain("SECRET_REASON");
  expect(text).toContain("committed=0"); // expected-after is NOT a commit marker
  expect(h.settings.incremental).toMatchObject({ enabled: false, auto: false, jobCostCapUsd: 0 });
  expect(h.append).not.toHaveBeenCalled();
  // Existing scopes owner construction resolves its remote port once; P1 never opens a dialog.
  expect(h.remote).toHaveBeenCalledTimes(1);
  expect(h.gate.capture).not.toHaveBeenCalled();
  expect(h.manager.getBranch()).toEqual([]);
  expect(startupTree(f.dir)).toEqual(before); // bytes + EVERY namespace/file inode
});

it.each(["off", "child", "rpc", "web", "secure", "locked", "scopes-off", "missing-owner", "wrong-manager"])(
  "actual natural %s path: zero C discovery/scan/lock and warning",
  async (mode) => {
    const f = await startupFixture(["unknown"]);
    const h = naturalHost(f.dir, {
      enabled: mode !== "off",
      child: mode === "child",
      scopesOff: mode === "scopes-off",
      noOwner: mode === "missing-owner",
      ...(mode === "secure" || mode === "locked" ? { domain: mode } : {}),
    });
    if (mode === "rpc") Object.assign(h.ctx, { mode: "rpc", hasUI: true });
    if (mode === "web") Object.assign(h.ctx, { webInvocation: true });
    if (mode === "wrong-manager") {
      // Scopes sees the actual manager first, then a deliberately mismatched
      // context in the test consumer; do not manufacture a second owner.
      const current = h.scopes!.current;
      vi.spyOn(h.scopes!, "current").mockImplementation(() => {
        const runtime = current();
        if (runtime) return { ...runtime, manager: SessionManager.inMemory("/") };
        return undefined;
      });
    }
    const before = startupTree(f.dir),
      { scans, factory } = scanObserver();
    const lock = vi.spyOn(lockModule, "withMemoryDirLock");
    const discovery = vi.spyOn(safeFs, "canonicalDir");
    await h.start();
    expect(h.results).toEqual([{ kind: "skipped" }]);
    expect(scans).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
    expect(lock).not.toHaveBeenCalled();
    expect(discovery).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.append).not.toHaveBeenCalled();
    expect(startupTree(f.dir)).toEqual(before);
  },
);

it.each(["manager", "sid", "tree", "shutdown", "host-after-unlock"])(
  "%s revokes actual lifetime during/after the original lock; zero late warning",
  async (mode) => {
    const f = await startupFixture(["marker-missing"]),
      h = naturalHost(f.dir),
      before = startupTree(f.dir);
    const { scans } = scanObserver(() => {
      const owner = h.scopes!.current()!;
      if (mode === "manager") h.scopes!.context({ ...h.ctx, sessionManager: SessionManager.inMemory("/") });
      if (mode === "sid") h.manager.newSession();
      if (mode === "tree" || mode === "shutdown") {
        const event = mode === "tree" ? "session_tree" : "session_shutdown";
        // Run the ORIGINAL synchronous scopes/proof lifecycle handlers, so
        // tree creates a new actual owner and shutdown disposes the old one.
        for (const handler of h.handlers.get(event) ?? []) handler({ type: event }, h.ctx);
      }
      if (mode !== "host-after-unlock") expect(owner.current()).toBe(false);
    });
    const lock = lockModule.withMemoryDirLock;
    if (mode === "host-after-unlock")
      vi.spyOn(lockModule, "withMemoryDirLock").mockImplementation(async (dir, body, opts) => {
        const result = await lock(dir, body, opts);
        h.lifecycle.abort();
        return result;
      });
    await h.start();
    expect(scans).toHaveBeenCalledTimes(1);
    expect(h.results).toEqual([{ kind: "skipped" }]);
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.append).not.toHaveBeenCalled();
    expect(startupTree(f.dir)).toEqual(before);
  },
);

it("actual hub-only owner also scans: no session store requirement, absent Hub namespace stays absent", async () => {
  const f = await startupFixture(["unknown"]),
    before = startupTree(f.dir);
  const h = naturalHost(f.dir, { hubOnly: true }),
    { scans } = scanObserver();
  await h.start();
  expect(h.scopes?.current()?.session).toBeUndefined();
  expect(h.scopes?.current()?.manager).toBe(h.manager);
  expect(h.settings.scopes).toEqual({ session: false, hub: true });
  expect(scans).toHaveBeenCalledTimes(1);
  expect(h.results).toMatchObject([{ kind: "scanned", warned: true }]);
  expect(h.notify).toHaveBeenCalledTimes(1);
  expect(fs.existsSync(join(f.dir, "absent-hub-state"))).toBe(false);
  expect(startupTree(f.dir)).toEqual(before);
});
