import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { wireMemory, type WireMemoryOpts } from "../../../src/memory/index.js";
import { DEFAULT_MEMORY_SETTINGS, type MemorySettings } from "../../../src/memory/settings.js";
import { memoryDirFor } from "../../../src/memory/paths.js";
import { runMigration } from "../../../src/memory/blocks/migrate.js";
import { createGovernanceMarkers } from "../../../src/memory/govern/markers.js";
import { createSweepRunner } from "../../../src/memory/govern/sweep.js";
import { JEV_GOVERNANCE_RELOAD_REMINDER_MARKER as RELOAD } from "../../../src/memory/jev/contracts.js";
import * as fs from "../../../src/memory/safe-fs.js";
import { blockRaw } from "../blocks/helpers.js";

let root = "",
  cwd = "",
  dir = "";
const runId = "20261108T090000000Z-123-abcdef";
function migrated(gen = 1) {
  mkdirSync(join(dir, "blocks"), { recursive: true });
  writeFileSync(join(dir, "blocks/.layout.json"), JSON.stringify({ v: 1, source: "migrate", gen, runId, files: [] }));
}
function markerPath() {
  return join(dir, "blocks/.jev/governance-markers.json");
}
type Handler = (event: any, ctx: any) => unknown;
function host(settings: Partial<MemorySettings> = {}, extra: Partial<WireMemoryOpts> = {}) {
  const handlers = new Map<string, Handler[]>();
  const sendMessage = vi.fn();
  const pi = {
    on: (name: string, fn: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    sendMessage,
  } as unknown as ExtensionAPI;
  const notify = vi.fn();
  const ctx = { cwd, hasUI: true, ui: { notify } } as unknown as ExtensionContext;
  wireMemory(pi, {
    settings: {
      ...DEFAULT_MEMORY_SETTINGS,
      layout: "blocks",
      jev: { ...DEFAULT_MEMORY_SETTINGS.jev, enabled: false },
      governance: { ...DEFAULT_MEMORY_SETTINGS.governance, enabled: false },
      migrate: { ...DEFAULT_MEMORY_SETTINGS.migrate, auto: false },
      ...settings,
    },
    isChildSession: false,
    sections: { register: vi.fn() } as unknown as WireMemoryOpts["sections"],
    ...extra,
  });
  return {
    ctx,
    notify,
    handlers,
    sendMessage,
    // First handler is wireMemory's actual migration/startup assembly, not
    // doctor.check (whose pre-notify dedup is deliberately not reused).
    start: () => handlers.get("session_start")![0]!({ type: "session_start" }, ctx),
    shutdown: () => handlers.get("session_shutdown")![0]!({ reason: "reload" }, ctx),
  };
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "markers-wire-"));
  cwd = join(root, "project");
  mkdirSync(cwd);
  vi.stubEnv("ARMORY_MEMORY_ROOT", join(root, "memory"));
  dir = memoryDirFor(cwd);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it("governance off + Jev off still delivers once; same generation resume/reload and budget/body changes do not repeat", async () => {
  migrated();
  const h = host();
  await h.start();
  expect(h.notify).toHaveBeenCalledTimes(1);
  expect(h.notify).toHaveBeenCalledWith("memory: migrated block memory — /reload to refresh memory", "warning");
  expect(JSON.parse(readFileSync(markerPath(), "utf8")).markers[RELOAD]).toBeDefined();
  expect(existsSync(join(dir, "blocks/archive"))).toBe(false); // no sweep, independent path
  await h.start();
  h.shutdown();
  writeFileSync(
    join(dir, "blocks/rule.001.md"),
    blockRaw({ id: "rule.001", authority: "user", body: "changed corpus, not a dedup key" }),
  );
  const resumed = host({ residentBytes: 1 });
  await resumed.start();
  expect(h.notify).toHaveBeenCalledTimes(1);
  expect(resumed.notify).not.toHaveBeenCalled();
  migrated(2);
  await resumed.start();
  expect(resumed.notify).toHaveBeenCalledTimes(1);
  expect(h.sendMessage).not.toHaveBeenCalled();
  expect(resumed.sendMessage).not.toHaveBeenCalled();
});

it.each([
  "headless",
  "no-ui-object",
  "no-port",
  "notify-throws",
  "notify-off",
  "memory-off",
  "child",
  "locked",
  "gate",
  "abort",
])("%s does not consume; a later eligible startup can deliver", async (mode) => {
  migrated();
  const abort = new AbortController();
  if (mode === "abort") abort.abort();
  const h = host(
    {
      ...(mode === "notify-off" ? { doctor: { ...DEFAULT_MEMORY_SETTINGS.doctor, notifyOnStart: false } } : {}),
      ...(mode === "memory-off" ? { enabled: false } : {}),
    },
    {
      ...(mode === "child" ? { isChildSession: true } : {}),
      ...(mode === "locked" ? { secureDomainKind: "locked" } : {}),
      ...(mode === "gate"
        ? { writeGate: { capture() {}, check: () => ({ ok: false as const, reason: "locked" }) } }
        : {}),
      sessionSignal: () => abort.signal,
    },
  );
  if (mode === "headless") (h.ctx as any).hasUI = false;
  if (mode === "no-ui-object") delete (h.ctx as any).ui;
  if (mode === "no-port") delete (h.ctx.ui as any).notify;
  if (mode === "notify-throws")
    h.notify.mockImplementation(() => {
      throw new Error("UI down");
    });
  await h.start();
  expect(existsSync(markerPath())).toBe(false);
  expect(existsSync(join(dir, "blocks/.jev"))).toBe(false);
  const next = host();
  await next.start();
  expect(next.notify).toHaveBeenCalledTimes(1);
  expect(existsSync(markerPath())).toBe(true);
});

it("successful auto migration delivers independent reminder after summary even with governance off", async () => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "core.md"), "# Rules\n- <!-- mem user --> keep my complete rule\n");
  const h = host({ migrate: { ...DEFAULT_MEMORY_SETTINGS.migrate, auto: true } });
  await h.start();
  expect(h.notify.mock.calls.map((c) => c[0])).toEqual([
    expect.stringContaining("memory: migrated 1 files"),
    "memory: migrated block memory — /reload to refresh memory",
  ]);
  const layout = JSON.parse(readFileSync(join(dir, "blocks/.layout.json"), "utf8"));
  expect(JSON.parse(readFileSync(markerPath(), "utf8")).migration).toEqual({ gen: layout.gen, runId: layout.runId });
  await h.start();
  expect(h.notify).toHaveBeenCalledTimes(2);
});

it("concurrent actual startup owners plus sweeps emit exactly one reload notification", async () => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "core.md"), "# Rules\n- <!-- mem user --> rule\n");
  expect((await runMigration(dir)).outcome).toBe("committed");
  const settings = { governance: { ...DEFAULT_MEMORY_SETTINGS.governance, enabled: true } };
  const a = host(settings),
    b = host(settings);
  await Promise.all([a.start(), b.start()]);
  const notices: string[] = [];
  const sweep = createSweepRunner({ enabled: true, notify: (m) => notices.push(m) });
  await sweep.runSweep(dir, "startup");
  await sweep.runSweep(dir, "reload");
  expect([...a.notify.mock.calls, ...b.notify.mock.calls].filter((c) => c[0].includes("/reload"))).toHaveLength(1);
  expect(notices.filter((m) => m.includes("reload"))).toEqual([]);
  expect((await createGovernanceMarkers(dir).deliverReloadReminder((m) => notices.push(m))).status).toBe(
    "already-delivered",
  );
});

it("notify-triggered shutdown and disk failure leave next startup eligible", async () => {
  migrated();
  const h = host();
  h.notify.mockImplementationOnce(() => {
    h.shutdown();
  });
  await h.start();
  expect(existsSync(markerPath())).toBe(false);
  vi.spyOn(fs, "replaceAtomic").mockImplementationOnce(() => {
    throw new Error("disk full");
  });
  const next = host();
  await next.start();
  expect(existsSync(markerPath())).toBe(false);
  expect(next.notify).toHaveBeenCalledTimes(1);
  await next.start();
  expect(existsSync(markerPath())).toBe(true);
  expect(next.notify).toHaveBeenCalledTimes(2);
});

it("stale startup waiting on a lock cannot consume after a session/directory switch", async () => {
  migrated();
  fs.lockCreate(dir, { pid: process.pid, host: "test-owner", token: "hold", at: Date.now() });
  const h = host();
  const pending = h.start();
  h.shutdown();
  (h.ctx as any).cwd = join(root, "other-project");
  fs.lockRelease(dir, "hold");
  await pending;
  expect(h.notify).not.toHaveBeenCalled();
  expect(existsSync(markerPath())).toBe(false);
});

it.each(["no-memory", "no-blocks", "fresh"])("%s does not create blocks/ or derived markers", async (kind) => {
  if (kind === "no-blocks") mkdirSync(dir, { recursive: true });
  if (kind === "fresh") {
    migrated();
    writeFileSync(join(dir, "blocks/.layout.json"), '{"v":1,"source":"fresh"}');
  }
  const h = host();
  await h.start();
  expect(h.notify).not.toHaveBeenCalled();
  expect(existsSync(markerPath())).toBe(false);
  if (kind !== "fresh") expect(existsSync(join(dir, "blocks"))).toBe(false);
});

it("actual migrated blocks can remind even when the configured layout remains tiered", async () => {
  migrated();
  const h = host({ layout: "tiered" });
  await h.start();
  expect(h.notify.mock.calls).toEqual([["memory: migrated block memory — /reload to refresh memory", "warning"]]);
  expect(existsSync(markerPath())).toBe(true);
  expect(existsSync(join(dir, "blocks/archive"))).toBe(false);
});
