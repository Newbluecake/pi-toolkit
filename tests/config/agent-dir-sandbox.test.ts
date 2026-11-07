import fs, { openSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sandboxHome } from "../integration/helpers/home-sandbox.js";
import {
  REAL_AGENT_DIR,
  REAL_HOME,
  clearSandboxHomeViolations,
  sandboxHomeViolations,
  withRealHomeAllowed,
} from "../setup/sandbox-home.js";

afterEach(() => {
  clearSandboxHomeViolations();
  vi.unstubAllEnvs();
});

function blocked(fn: () => unknown, operation: string): void {
  expect(fn).toThrow(/sandbox-home guard/);
  expect(sandboxHomeViolations().at(-1)?.operation).toBe(operation);
  clearSandboxHomeViolations();
}

describe("T-SB1 test-process write/spawn guard", () => {
  it("setup clears the inherited override", () => {
    expect(process.env.PI_CODING_AGENT_DIR).toBeUndefined();
  });

  it.each([...new Set([REAL_AGENT_DIR, join(REAL_HOME, ".pi", "agent")])])(
    "guards settings, locks and records under %s",
    (root) => {
      for (const suffix of [
        "pi-toolkit.json",
        "pi-toolkit.json.tmp",
        "pi-subagent.json",
        "pi-subagent.json.123.lnk",
        ".pi-subagent.json.lock",
        "records/traffic.db",
        "records/traffic.db-wal",
      ]) {
        const target = join(root, suffix);
        blocked(() => writeFileSync(target, "must not reach filesystem"), "fs.writeFileSync");
        blocked(() => fs.rmSync(target, { force: true }), "fs.rmSync");
        blocked(() => fs.unlinkSync(target), "fs.unlinkSync");
        blocked(() => fs.renameSync("/tmp/nonexistent-p0-source", target), "fs.renameSync");
        blocked(() => fs.renameSync(target, "/tmp/nonexistent-p0-target"), "fs.renameSync");
        blocked(() => fs.linkSync("/tmp/nonexistent-p0-source", target), "fs.linkSync");
        blocked(() => fs.linkSync(target, "/tmp/nonexistent-p0-target"), "fs.linkSync");
        blocked(() => fs.symlinkSync("relative-target", target), "fs.symlinkSync");
        blocked(() => fs.symlinkSync(target, "/tmp/nonexistent-p0-target"), "fs.symlinkSync");
        for (const flags of ["w", "a", "r+", fs.constants.O_RDWR, fs.constants.O_CREAT | fs.constants.O_RDONLY]) {
          blocked(() => openSync(target, flags), "fs.openSync");
        }
      }
      blocked(() => writeFileSync(pathToFileURL(join(root, "pi-toolkit.json")), "no"), "fs.writeFileSync");
      blocked(() => writeFileSync(Buffer.from(join(root, "pi-subagent.json")), "no"), "fs.writeFileSync");
    },
  );

  it("allows sandbox writes and read-only opens; sandboxHome restores absent and present overrides", () => {
    for (const previous of [undefined, "~/saved-override", ""]) {
      vi.stubEnv("PI_CODING_AGENT_DIR", previous);
      const sb = sandboxHome();
      try {
        expect(process.env.PI_CODING_AGENT_DIR).toBeUndefined();
        expect(process.env.HOME).toBe(sb.home);
        const file = join(sb.home, "pi-toolkit.json");
        writeFileSync(file, "sandbox-marker");
        const fd = openSync(file, "r");
        fs.closeSync(fd);
        expect(fs.statSync(file).size).toBe(Buffer.byteLength("sandbox-marker"));
        expect(sandboxHomeViolations()).toEqual([]);
      } finally {
        sb.restore();
      }
      expect(process.env.PI_CODING_AGENT_DIR).toBe(previous);
    }
  });

  it("rejects both explicit and inherited real agentDir envs, including tilde and file URLs", () => {
    for (const raw of [REAL_AGENT_DIR, `${REAL_AGENT_DIR}/`, pathToFileURL(REAL_AGENT_DIR).href]) {
      blocked(
        () => spawnSync(process.execPath, ["-e", ""], { env: { HOME: REAL_HOME, PI_CODING_AGENT_DIR: raw } }),
        "child_process.spawnSync",
      );
      vi.stubEnv("PI_CODING_AGENT_DIR", raw);
      blocked(() => spawnSync(process.execPath, ["-e", ""]), "child_process.spawnSync");
    }
    if (REAL_AGENT_DIR === join(REAL_HOME, ".pi", "agent")) {
      blocked(
        () => spawnSync(process.execPath, ["-e", ""], { env: { HOME: REAL_HOME, PI_CODING_AGENT_DIR: "~/.pi/agent" } }),
        "child_process.spawnSync",
      );
    }
  });

  it("escape hatch bypasses write guarding without modifying real files", async () => {
    const nonexistent = join(REAL_AGENT_DIR, "records", "p0-nonexistent-read-probe");
    await withRealHomeAllowed(() => {
      // A rename of a nonexistent source fails before it can change the protected destination.
      expect(() => fs.renameSync("/p0-nonexistent-source", nonexistent)).toThrow(/ENOENT/);
    });
    expect(sandboxHomeViolations()).toEqual([]);
  });
});
