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
    // #54 P2: with no settings file the plugin side resolves to the NEW name in the same directory (plan §3.3 S0).
    expect(defaultSettingsPath()).toBe(join(sandbox.home, ".pi", "agent", "pi-toolkit.json"));
    expect(defaultRecordPaths({ home: sandbox.home })).toEqual({
      root: H,
      source: "default",
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

  it("traffic DB follows the agentDir root rules (#54 P3): fresh custom agentDir ⇒ root at P", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", join(sandbox.home, "custom"));
    // P 与 H 都没有库 ⇒ 新建在 P（继承/五分支细节见 tests/traffic/root-select.test.ts）。
    expect(defaultRecordPaths({ home: sandbox.home })).toMatchObject({
      root: join(sandbox.home, "custom"),
      source: "agentDir",
      dbPath: join(sandbox.home, "custom", "records", "traffic.db"),
    });
  });

  it("hub computes one resolved agentDir and all six consumers use it; convert gets the same value", () => {
    const read = (f: string): string => readFileSync(new URL(`../../src/web-hub/hub/${f}`, import.meta.url), "utf8");
    const hub = read("hub.ts");
    expect(hub.match(/const hubAgentDir = resolveAgentDir\(process.env, config.home\).dir;/g)).toHaveLength(1);
    // ⑨-H3 moved the consumers into assembly-*.ts; each takes the one value from the HubAssembly ctx.
    const parts = ["assembly-feishu.ts", "assembly-preview.ts", "assembly-spawn.ts"].map(read);
    for (const p of parts) expect(p).toContain("const hubAgentDir = ctx.hubAgentDir;");
    expect(hub).toMatch(/^\s+hubAgentDir,$/m);
    // P4 为 hub.json 的 agentDir 写入加了第 7 处消费（仍共用同一个 hubAgentDir）。
    const uses = [hub, ...parts].reduce((n, src) => n + (src.match(/agentDir: hubAgentDir/g)?.length ?? 0), 0);
    expect(uses).toBe(7);
    for (const src of [hub, ...parts]) expect(src).not.toContain('process.env["PI_CODING_AGENT_DIR"]');
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
