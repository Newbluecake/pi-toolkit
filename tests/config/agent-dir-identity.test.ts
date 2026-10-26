import fs, { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { resolveAgentDir } from "../../src/core/agent-dir.js";
import { resolveAgentDir as hubResolve } from "../../src/web-hub/protocol/agent-dir.js";
import { defaultSettingsPath } from "../../src/config/settings.js";
import { defaultMeasureStorePath } from "../../src/cache-ttl/measure-store.js";
import { getProviderEvidenceStore, PROVIDER_EVIDENCE_KEY } from "../../src/cache-ttl/provider-evidence.js";
import { defaultAgentDir } from "../../src/traffic/dup-detect.js";
import { defaultRecordPaths } from "../../src/traffic/db.js";
import { sandboxHome } from "../integration/helpers/home-sandbox.js";

const helper = await import(new URL("../../src/secure/bin/helper.mjs", import.meta.url).href);
const sandbox = sandboxHome();
afterAll(() => sandbox.restore());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const H = join(sandbox.home, ".pi", "agent");
describe("T-ID1 P0: default-equivalent values preserve legacy literal paths", () => {
  it.each([undefined, "", "~/.pi/agent", H, `${H}/`])("identity for %s", (raw) => {
    vi.stubEnv("PI_CODING_AGENT_DIR", raw);
    expect(homedir()).toBe(sandbox.home);
    expect(resolveAgentDir(process.env, sandbox.home)).toEqual({ dir: H, home: H, source: "default" });
    expect(defaultSettingsPath()).toBe(join(sandbox.home, ".pi", "agent", "pi-subagent.json"));
    expect(defaultRecordPaths(sandbox.home)).toEqual({
      recordDir: join(H, "records"),
      dbPath: join(H, "records", "traffic.db"),
      legacyDir: join(H, "dumps"),
      legacyDbPath: join(H, "dumps", "traffic.db"),
    });
    expect(defaultMeasureStorePath()).toBe(join(H, "cache-ttl-measurements.json"));
    expect(defaultAgentDir()).toBe(H);
    expect(hubResolve(process.env, sandbox.home).dir).toBe(`${sandbox.home}/.pi/agent`);
    expect(helper.settingsFilePath(sandbox.home)).toBe(join(H, "pi-subagent.json"));
    expect(helper.settingsLockPath(sandbox.home)).toBe(join(H, ".pi-subagent.json.lock"));
    expect(helper.piAgentDir(sandbox.home)).toBe(H);

    // Exercise the actual singleton write path in sandbox HOME (no settings contents).
    const global = globalThis as Record<symbol, unknown>;
    const previous = global[PROVIDER_EVIDENCE_KEY];
    delete global[PROVIDER_EVIDENCE_KEY];
    try {
      const store = getProviderEvidenceStore();
      store.noteWrite1hLanded("test", "test", 1000);
      expect(store.hasWrite1hEvidence("test", "test", 1001)).toBe(true);
      expect(fs.statSync(join(H, "cache-provider-evidence.json")).isFile()).toBe(true);
    } finally {
      fs.rmSync(join(H, "cache-provider-evidence.json"), { force: true });
      if (previous === undefined) delete global[PROVIDER_EVIDENCE_KEY];
      else global[PROVIDER_EVIDENCE_KEY] = previous;
    }
  });

  it("keeps traffic DB defaults fixed even for custom agentDir (P3 is not part of P0)", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", join(sandbox.home, "custom"));
    expect(defaultRecordPaths(sandbox.home).dbPath).toBe(join(H, "records", "traffic.db"));
  });

  it("hub computes one resolved agentDir and all six consumers use it; convert gets the same value", () => {
    const hub = readFileSync(new URL("../../src/web-hub/hub/hub.ts", import.meta.url), "utf8");
    expect(hub.match(/const hubAgentDir = resolveAgentDir\(process.env, config.home\).dir;/g)).toHaveLength(1);
    expect(hub.match(/agentDir: hubAgentDir/g)).toHaveLength(6);
    expect(hub).not.toContain('process.env["PI_CODING_AGENT_DIR"]');
    const launcher = readFileSync(new URL("../../src/secure/bin/helper.mjs", import.meta.url), "utf8");
    expect(launcher).toContain("C.defaultConvertContext(process.env, { home, cwd, agentDir: piAgentDir(home) })");
  });

  it.each(["~/custom", "file:///tmp/custom-agent", "relative"])("consumer follows resolver for %s", (raw) => {
    vi.stubEnv("PI_CODING_AGENT_DIR", raw);
    const expected = resolveAgentDir(process.env, sandbox.home).dir;
    expect(defaultMeasureStorePath()).toBe(join(expected, "cache-ttl-measurements.json"));
    expect(defaultAgentDir()).toBe(expected);
    expect(helper.piAgentDir(sandbox.home)).toBe(expected);
  });
});
