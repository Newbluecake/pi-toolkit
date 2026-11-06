/** Real gocryptfs gate tests. No mount is detached unless this fixture owns it. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireGocryptfsTestLock } from "./gocryptfs-test-lock.js";
import { secureMemoryWriteGate } from "../../src/secure/memory-gate.js";
import type { SecureDomain } from "../../src/secure/domain.js";
import { runMigration, rollbackMigration } from "../../src/memory/blocks/migrate.js";
import { dirFormat } from "../../src/memory/blocks/naming.js";
import { createMemCommand } from "../../src/memory/command.js";
import { parseMemorySettings } from "../../src/memory/settings.js";
const available =
  process.platform === "linux" &&
  spawnSync("sh", ["-c", "command -v gocryptfs && command -v fusermount3 && test -r /dev/fuse && test -w /dev/fuse"], {
    timeout: 5000,
  }).status === 0;
describe.skipIf(!available)("memory gate on real encrypted mount", () => {
  let root = "",
    mnt = "",
    dir = "",
    release: (() => void) | undefined;
  const mounted = () =>
    readFileSync("/proc/self/mountinfo", "utf8")
      .split("\n")
      .some((l) => l.split(" ")[4] === mnt && l.includes(" - fuse.gocryptfs "));
  const unmount = () => {
    if (mounted()) {
      const r = spawnSync("fusermount3", ["-u", mnt], { encoding: "utf8", timeout: 20000 });
      expect(r.status, r.stderr).toBe(0);
    }
    expect(mounted()).toBe(false);
  };
  beforeEach(async () => {
    release = await acquireGocryptfsTestLock();
    root = mkdtempSync(join(tmpdir(), "real-memory-gate-"));
    mnt = join(root, "mnt");
    mkdirSync(mnt);
    mkdirSync(join(root, "cipher"));
    writeFileSync(join(root, "pass"), "TESTONLY-memory-gate-password\n", { mode: 0o600 });
    let r = spawnSync("gocryptfs", ["-q", "-init", "-passfile", join(root, "pass"), join(root, "cipher")], {
      encoding: "utf8",
      timeout: 30000,
    });
    expect(r.status, r.stderr).toBe(0);
    r = spawnSync("gocryptfs", ["-q", "-passfile", join(root, "pass"), join(root, "cipher"), mnt], {
      encoding: "utf8",
      timeout: 30000,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(mounted()).toBe(true);
    dir = join(mnt, "state/memory/project");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "core.md"), "---\nsource: agent\n---\n- one\n- two\n");
  }, 250000);
  afterEach(() => {
    try {
      unmount();
      rmSync(root, { recursive: true, force: true });
    } finally {
      release?.();
      release = undefined;
    }
  }, 30000);
  function gate() {
    const domain = {
      kind: "secure",
      vault: { root, mntReal: mnt, vault: { name: "test" } },
      vaults: [],
      config: {},
      via: "env",
    } as unknown as SecureDomain;
    const g = secureMemoryWriteGate(domain);
    g.capture(dir);
    return g;
  }
  it("gocryptfs directory commit and rollback succeed with immutable root bytes", async () => {
    const g = gate(),
      raw = readFileSync(join(dir, "core.md"), "utf8");
    expect((await runMigration(dir, { gate: g, explicit: true })).outcome).toBe("committed");
    expect(dirFormat(dir)).toBe("blocks");
    await rollbackMigration(dir, { gate: g });
    expect(dirFormat(dir)).toBe("held");
    expect(readFileSync(join(dir, "core.md"), "utf8")).toBe(raw);
  });
  it("mount loss during staging halts at next safe primitive; no plaintext replacement directories", async () => {
    const g = gate();
    let stopped = false;
    const result = await runMigration(dir, {
      gate: g,
      explicit: true,
      phase: (phase) => {
        if (phase === "building" && !stopped) {
          unmount();
          stopped = true;
        }
      },
    });
    expect(stopped).toBe(true);
    expect(result.outcome).toBe("aborted");
    expect(result.reason).toContain("unmounted");
    expect(existsSync(join(mnt, "state"))).toBe(false);
    expect(existsSync(join(mnt, "blocks"))).toBe(false);
  });
  it("automatic write loop refuses every primitive after unmount; no new plaintext directories", () => {
    const g = gate();
    let writes = 0;
    for (let i = 0; i < 3; i++) {
      if (i === 1) unmount();
      if (!g.check(dir).ok) break;
      writeFileSync(join(dir, `auto-${i}.json`), "derived");
      writes++;
    }
    expect(writes).toBe(1);
    expect(g.check(dir)).toEqual({ ok: false, reason: "unmounted" });
    expect(existsSync(join(mnt, "state"))).toBe(false);
  });
  it("--all traverses only the effective encrypted memory root", async () => {
    const g = gate(),
      outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "core.md"), "- outside must remain untouched\n");
    const command = createMemCommand({
      paths: { memoryRoot: join(mnt, "state/memory"), ccProjectsRoot: join(root, "cc") },
      settings: parseMemorySettings({ layout: "blocks", jev: { enabled: false } }),
      writeGate: g,
    });
    const notes: string[] = [];
    await command.handler("migrate --all", {
      cwd: "project",
      hasUI: true,
      mode: "tui",
      ui: { notify: (t: string) => notes.push(t) },
    } as any);
    expect(notes.join("\n")).toContain("committed");
    expect(dirFormat(dir)).toBe("blocks");
    expect(existsSync(join(outside, "blocks"))).toBe(false);
    expect(readFileSync(join(outside, "core.md"), "utf8")).toContain("untouched");
  });
  it("locked path has no disk effects", async () => {
    const g = secureMemoryWriteGate({ kind: "locked" } as SecureDomain);
    expect((await runMigration(dir, { gate: g })).outcome).toBe("aborted");
    expect(dirFormat(dir)).toBe("files");
  });
});
