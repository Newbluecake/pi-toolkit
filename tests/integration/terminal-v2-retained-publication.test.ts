/** Publication/SDK loading over explicit old-disk fixtures; live ordinary O history
 * and actual N PTY are separate gates, never inferred from this fixture. */
import { runRetainedFixtureCli } from "./helpers/terminal-retained-cli.js";
import { execFileSync, spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolveHubPaths } from "../../src/web-hub/protocol/paths.js";
import { oldLauncherBytes } from "../../scripts/web-hub/terminal-v2-retained/entries.js";
import type { InstallationProfile } from "../../scripts/web-hub/terminal-v2-retained/installation.js";
import { legacyLayout, put, setup, tree } from "../terminal-v2-maintenance/helpers.js";
it("durable publication loads actual selected SDK package; independent off rollback keeps generation floor and state/auth bytes", () => {
  const h = setup(),
    repo = resolve("."),
    cli = join(repo, "dist/maintenance/cli.mjs"),
    home = join(h.base, "h"),
    agentDir = join(home, ".pi/agent"),
    state = join(agentDir, "web-hub"),
    old = join(h.base, "old"),
    bin = join(h.base, "bin"),
    evidence = join(h.base, "migration");
  for (const dir of [home, join(home, ".pi"), agentDir, state, old, bin, evidence]) mkdirSync(dir, { mode: 0o700 });
  const source = execFileSync(
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
  execFileSync("/usr/bin/tar", ["-xf", "-", "-C", old], { input: source, timeout: 30000 });
  legacyLayout(state);
  const paths = resolveHubPaths({ home, uid: process.getuid!() });
  if (paths.socketDir !== state) throw new Error("fixture socket too long");
  const profile: InstallationProfile = {
    v: 1,
    kind: "terminal-retained-O7239",
    home,
    agentDir,
    stateDir: state,
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
  // Auth-domain sentinels are deliberately not valid DBs: these commands must not
  // open/copy/repair them. SDK model auth is a different normal installed path.
  put(join(state, "hub.db"), "ordinary auth state not for terminal migration");
  put(join(state, "token"), "ordinary-token-sentinel");
  const originals = tree(join(state, "terminal-v1")),
    auth = readFileSync(join(state, "hub.db")),
    token = readFileSync(join(state, "token"));
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, NODE_OPTIONS: "" };
  const run = (command: string, extra: string[] = [], stateFlag = true) =>
    runRetainedFixtureCli(
      cli,
      [command, "--installation", h.evidenceDir, ...(stateFlag ? ["--state", state] : []), ...extra],
      { cwd: h.base, env },
    );
  const initialized = run("retained-initialize", ["--evidence", evidence]);
  const wrapper = join(h.base, "exit-before-probe.mjs");
  writeFileSync(
    wrapper,
    `import {retainedCli} from ${JSON.stringify(pathToFileURL(cli).href)};\nconst result=await retainedCli(process.argv.slice(2),{beforePackageLoad(){process.exit(75)}});\nconsole.log(result.message);process.exitCode=result.exitCode;\n`,
    { mode: 0o600 },
  );
  const exited = spawnSync(
    process.execPath,
    [wrapper, "publish-new", "--installation", h.evidenceDir, "--expect-operation", initialized.operationId],
    { cwd: h.base, env, timeout: 30000, encoding: "utf8" },
  );
  expect(exited.status).toBe(75);
  expect(exited.signal).toBeNull();
  expect(existsSync(join(h.evidenceDir, "publication-0001-prepared.json"))).toBe(true);
  expect(existsSync(join(h.evidenceDir, "publication-0001-complete.json"))).toBe(false);
  const blocked = spawnSync(profile.launchers[0]!, ["--version"], {
    cwd: h.base,
    env,
    timeout: 30000,
    encoding: "utf8",
  });
  expect(blocked.status).not.toBe(0);
  expect(JSON.parse(blocked.stdout).error).toBe("E_RETAINED_PUBLICATION_NOT_COMPLETE");
  expect(run("resume", ["--operation", initialized.operationId])).toMatchObject({
    phase: "publication-complete",
    mode: "new",
    sequence: 1,
    outcome: "committed",
  });
  const floor = readFileSync(join(h.evidenceDir, "floor.json")),
    ledger = readFileSync(join(state, "terminal-v2/ledger.json"));
  expect(run("resume", ["--operation", initialized.operationId])).toMatchObject({
    phase: "publication-complete",
    mode: "new",
    sequence: 1,
    outcome: "already-complete",
  });
  expect(run("rollback-inspect")).toMatchObject({ oldTerminalOnAllowed: false, permittedPublication: "old-off-only" });
  expect(run("publish-old-off", ["--expect-operation", initialized.operationId], false)).toMatchObject({
    phase: "publication-complete",
    mode: "old-off",
    sequence: 2,
  });
  expect(JSON.parse(readFileSync(join(agentDir, "pi-toolkit.json"), "utf8")).webHub.terminal.enabled).toBe(false);
  expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).packages).toEqual([old]);
  expect(readFileSync(join(h.evidenceDir, "floor.json"))).toEqual(floor);
  expect(readFileSync(join(state, "terminal-v2/ledger.json"))).toEqual(ledger);
  expect(readFileSync(join(state, "hub.db"))).toEqual(auth);
  expect(readFileSync(join(state, "token"))).toEqual(token);
  expect(tree(join(state, "terminal-v1"))).toEqual(originals);
  const version = execFileSync(profile.launchers[0]!, ["--version"], {
    cwd: h.base,
    env,
    timeout: 30000,
    encoding: "utf8",
  });
  expect(version.trim()).toBe("1.5.0");
}, 90000);
