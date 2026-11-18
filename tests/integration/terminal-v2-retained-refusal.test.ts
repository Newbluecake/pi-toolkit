/** Real standalone CLI/owned FS/singleton refusals over EXPLICIT O disk fixtures.
 * These are fault/layout counterexamples, never ordinary O history evidence. */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { acquireSingleton } from "../../src/web-hub/hub/singleton.js";
import { resolveHubPaths } from "../../src/web-hub/protocol/paths.js";
import { oldLauncherBytes } from "../../scripts/web-hub/terminal-v2-retained/entries.js";
import type { InstallationProfile } from "../../scripts/web-hub/terminal-v2-retained/installation.js";
import { legacyLayout, put, setup } from "../terminal-v2-maintenance/helpers.js";
function fixture() {
  const h = setup(),
    repo = resolve("."),
    home = join(h.base, "h"),
    agentDir = join(home, ".pi/agent"),
    old = join(h.base, "old"),
    bin = join(h.base, "bin"),
    evidence = join(h.base, "migration");
  for (const dir of [home, join(home, ".pi"), agentDir, join(agentDir, "web-hub"), old, bin, evidence])
    mkdirSync(dir, { mode: 0o700 });
  const archive = execFileSync(
    "/usr/bin/git",
    [
      "archive",
      "7239dd115ac66039e2c4f80308ea5d08520aa6af",
      "src",
      "package.json",
      "index.ts",
      "index.js",
      "bundle-bridge.cjs",
    ],
    { cwd: repo, timeout: 30000, maxBuffer: 64 * 1024 * 1024 },
  );
  execFileSync("/usr/bin/tar", ["-xf", "-", "-C", old], { input: archive, timeout: 30000 });
  const paths = resolveHubPaths({ home, uid: process.getuid!() });
  if (paths.socketDir !== paths.stateDir) throw new Error("fixture socket path");
  legacyLayout(paths.stateDir);
  const profile: InstallationProfile = {
    v: 1,
    kind: "terminal-retained-O7239",
    home,
    agentDir,
    stateDir: paths.stateDir,
    socketPath: paths.socketPath,
    piCli: realpathSync(join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js")),
    oldPackageRoot: old,
    newPackageRoot: repo,
    launchers: [join(bin, "pi")],
    autostartFiles: [],
  };
  put(join(h.evidenceDir, "profile.json"), profile);
  writeFileSync(profile.launchers[0]!, oldLauncherBytes(profile), { mode: 0o700 });
  put(join(agentDir, "settings.json"), { packages: [old] });
  put(join(agentDir, "pi-toolkit.json"), { webHub: { enabled: true, autoStart: false, terminal: { enabled: true } } });
  put(join(paths.stateDir, "hub.db"), "auth-original-sentinel");
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, NODE_OPTIONS: "" },
    cli = join(repo, "dist/maintenance/cli.mjs");
  const run = (command: string, extra: string[] = []) => {
    const result = spawnSync(
      process.execPath,
      [cli, command, "--installation", h.evidenceDir, "--state", paths.stateDir, ...extra],
      { cwd: h.base, env, timeout: 30000, encoding: "utf8" },
    );
    expect(result.signal).toBeNull();
    return { status: result.status, body: JSON.parse(result.stdout) };
  };
  return { ...h, paths, profile, agentDir, evidence, run };
}
it("a real original singleton/socket is never unlinked/adopted even with an empty valid journal", async () => {
  const h = fixture(),
    owner = await acquireSingleton(h.paths);
  if (owner.kind !== "owner") throw new Error("owned singleton fixture");
  const before = lstatSync(h.paths.socketPath);
  try {
    const result = h.run("retained-preflight");
    expect(result.status).toBe(1);
    expect(result.body.error).toBe("E_RETAINED_ORIGINAL_SOCKET_PRESENT");
    expect(owner.server.listening).toBe(true);
    expect(lstatSync(h.paths.socketPath).ino).toBe(before.ino);
    expect(existsSync(join(h.paths.stateDir, "terminal-v2"))).toBe(false);
  } finally {
    await owner.release();
  }
});
it.each(["journal", "extra-package", "fifo"])("refuses %s without terminal init/auth rewrite", (fault) => {
  const h = fixture(),
    journal = join(h.paths.stateDir, "terminal-v1/terminal-resource-fence-v1.json");
  if (fault === "journal") put(journal, { v: 1, revision: 3, resources: [{}] });
  if (fault === "extra-package")
    put(join(h.agentDir, "settings.json"), { packages: [h.profile.oldPackageRoot, "/unmeasured/source"] });
  if (fault === "fifo")
    execFileSync("/usr/bin/mkfifo", [join(h.paths.stateDir, "terminal-v1/opaque-special")], { timeout: 3000 });
  const before = readFileSync(journal),
    result = h.run("retained-initialize", ["--evidence", h.evidence]);
  expect(result.status).toBe(1);
  expect(result.body.error).toBe(
    fault === "journal"
      ? "E_LEGACY_SOURCE_SHAPE"
      : fault === "extra-package"
        ? "E_RETAINED_SOURCE_BINDING_UNKNOWN"
        : "E_SOURCE_SPECIAL",
  );
  expect(readFileSync(journal)).toEqual(before);
  expect(readFileSync(join(h.paths.stateDir, "hub.db"), "utf8")).toBe("auth-original-sentinel");
  expect(existsSync(join(h.paths.stateDir, "terminal-v2"))).toBe(false);
  expect(readFileSync(h.profile.launchers[0]!)).toEqual(oldLauncherBytes(h.profile));
});
it("valid opaque regular is backed up; independent changed-source retry refuses without resetting ledger", () => {
  const h = fixture(),
    opaque = join(h.paths.stateDir, "terminal-v1/notes 中文.txt");
  writeFileSync(opaque, "opaque-not-authority", { mode: 0o644 });
  const initialized = h.run("retained-initialize", ["--evidence", h.evidence]);
  expect(initialized.status).toBe(0);
  const index = JSON.parse(readFileSync(join(h.evidence, "backup/backup-index.json"), "utf8")),
    entry = index.files.find((f: any) => f.source.endsWith("notes 中文.txt"));
  expect(entry).toBeDefined();
  expect(readFileSync(join(h.evidence, "backup", entry.backup), "utf8")).toBe("opaque-not-authority");
  const ledgerPath = join(h.paths.stateDir, "terminal-v2/ledger.json"),
    before = readFileSync(ledgerPath);
  put(join(h.paths.stateDir, "terminal-v1/terminal-resource-fence-v1.json"), { v: 1, revision: 99, resources: [] });
  const result = h.run("resume", ["--operation", initialized.body.operationId]);
  expect(result.status).toBe(1);
  expect(result.body.error).toBe("E_RETAINED_PREPARATION_CHANGED");
  expect(readFileSync(ledgerPath)).toEqual(before);
  expect(readFileSync(join(h.paths.stateDir, "hub.db"), "utf8")).toBe("auth-original-sentinel");
});
