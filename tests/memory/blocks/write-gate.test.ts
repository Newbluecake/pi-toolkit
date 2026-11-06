import { mkdirSync, mkdtempSync, rmSync, renameSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { secureMemoryWriteGate } from "../../../src/secure/memory-gate.js";
import type { SecureDomain } from "../../../src/secure/domain.js";
import { runMigration } from "../../../src/memory/blocks/migrate.js";
import { wireMemory } from "../../../src/memory/index.js";
import { createMemCommand } from "../../../src/memory/command.js";
import { parseMemorySettings } from "../../../src/memory/settings.js";
import { memoryDirFor } from "../../../src/memory/paths.js";
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "memory-gate-"));
  roots.push(root);
  const mnt = join(root, "mnt"),
    dir = join(mnt, "state/memory/project");
  mkdirSync(dir, { recursive: true });
  let mount = `40 25 0:40 / ${mnt} rw - fuse.gocryptfs ${root}/cipher rw\n`;
  const domain = {
    kind: "secure",
    vault: { mntReal: mnt, root, vault: { name: "test" } },
    vaults: [],
    config: {},
    via: "env",
  } as unknown as SecureDomain;
  return {
    root,
    dir,
    gate: secureMemoryWriteGate(domain, { readMountinfo: () => mount }),
    unmount: () => {
      mount = "";
    },
  };
}
it("plain allows; locked rejects even a missing path with no writes", async () => {
  const p = fixture();
  expect(secureMemoryWriteGate({ kind: "plain" } as SecureDomain).check("/missing")).toEqual({ ok: true });
  const gate = secureMemoryWriteGate({ kind: "locked" } as SecureDomain);
  expect(gate.check(p.dir)).toEqual({ ok: false, reason: "locked" });
  const missing = join(p.root, "not-created");
  expect((await runMigration(missing, { gate })).outcome).toBe("aborted");
  expect(existsSync(missing)).toBe(false);
});
it("secure requires capture, enforces write zone and dev/ino identity, checks every mount", () => {
  const p = fixture();
  expect(p.gate.check(p.dir)).toEqual({ ok: false, reason: "identity-changed" });
  p.gate.capture(p.dir);
  expect(p.gate.check(p.dir)).toEqual({ ok: true });
  expect(p.gate.check(p.root)).toEqual({ ok: false, reason: "path-escaped" });
  renameSync(p.dir, p.dir + "-old");
  mkdirSync(p.dir);
  expect(p.gate.check(p.dir)).toEqual({ ok: false, reason: "identity-changed" });
  p.gate.capture(p.dir);
  expect(p.gate.check(p.dir)).toEqual({ ok: true });
  p.unmount();
  expect(p.gate.check(p.dir)).toEqual({ ok: false, reason: "unmounted" });
});
it("new explicit directory is untrusted until immediate capture", () => {
  const p = fixture(),
    newDir = join(p.dir, "new");
  p.gate.capture(newDir);
  mkdirSync(newDir);
  expect(p.gate.check(newDir)).toEqual({ ok: false, reason: "identity-changed" });
  p.gate.capture(newDir);
  expect(p.gate.check(newDir)).toEqual({ ok: true });
});

it("production session_start migrates only main+blocks+auto; locked does not capture or check", async () => {
  const p = fixture(),
    memoryRoot = join(p.root, "project-memory");
  vi.stubEnv("ARMORY_MEMORY_ROOT", memoryRoot);
  for (const [child, layout, auto, locked] of [
    [false, "blocks", true, false],
    [true, "blocks", true, false],
    [false, "tiered", true, false],
    [false, "blocks", false, false],
    [false, "blocks", true, true],
  ] as const) {
    const cwd = `/case-${child}-${layout}-${auto}-${locked}`,
      dir = memoryDirFor(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "core.md"), "- rule\n");
    const handlers: ((event: unknown, ctx: unknown) => unknown)[] = [];
    const gate = { check: vi.fn(() => ({ ok: true as const })), capture: vi.fn(() => {}) };
    const api = {
      on: (name: string, fn: any) => {
        if (name === "session_start") handlers.push(fn);
      },
      registerTool: () => {},
      registerCommand: () => {},
    };
    wireMemory(api as any, {
      settings: parseMemorySettings({ layout, migrate: { auto }, jev: { enabled: false } }),
      isChildSession: child,
      sections: { register: () => {} } as any,
      writeGate: gate,
      secureDomainKind: locked ? "locked" : "plain",
    });
    await handlers[0]!({}, { cwd, hasUI: false });
    expect(existsSync(join(dir, "blocks"))).toBe(!child && layout === "blocks" && auto && !locked);
    if (locked) {
      expect(gate.check).not.toHaveBeenCalled();
      expect(gate.capture).not.toHaveBeenCalled();
    }
  }
});
it("migrate commands dry-run/status and effective-root --all leave unrelated directories untouched", async () => {
  const p = fixture(),
    root = join(p.root, "root"),
    paths = { memoryRoot: root, ccProjectsRoot: join(root, "cc") },
    cwd = "/test",
    dir = memoryDirFor(cwd, paths);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "core.md"), "- rule\n");
  const other = join(root, "other");
  mkdirSync(other);
  writeFileSync(join(other, "core.md"), "- other\n");
  const empty = join(root, "empty");
  mkdirSync(empty);
  const notes: string[] = [];
  const ctx = { cwd, hasUI: true, mode: "tui", ui: { notify: (t: string) => notes.push(t) } } as any;
  const command = createMemCommand({
    paths,
    settings: parseMemorySettings({ layout: "blocks", jev: { enabled: false } }),
  });
  const before = readdirSync(dir);
  await command.handler("migrate --dry-run", ctx);
  expect(readdirSync(dir)).toEqual(before);
  expect(notes.at(-1)).toContain('"files"');
  await command.handler("migrate --status", ctx);
  expect(notes.at(-1)).toContain('"gen": 0');
  await command.handler("migrate --all", ctx);
  expect(existsSync(join(dir, "blocks"))).toBe(true);
  expect(existsSync(join(other, "blocks"))).toBe(true);
  expect(readdirSync(empty)).toEqual([]);
  const old = createMemCommand({ paths, settings: parseMemorySettings({ layout: "tiered", jev: { enabled: false } }) });
  expect(old.description).not.toContain("migrate");
});
