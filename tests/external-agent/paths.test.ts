import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  EXTERNAL_AGENT_DIRNAME,
  catalogCachePath,
  externalAgentRoot,
  externalSessionPath,
  externalSessionsDir,
  isExternalSessionPath,
  probeCwd,
} from "../../src/external-agent/paths.js";

describe("external-agent paths (plan §2.10)", () => {
  const agentDir = join("/home", "u", ".pi", "agent");

  it("root / sessions dir shapes", () => {
    expect(EXTERNAL_AGENT_DIRNAME).toBe("external-agent");
    expect(externalAgentRoot(agentDir)).toBe(join(agentDir, "external-agent"));
    expect(externalSessionsDir(agentDir, "droid")).toBe(join(agentDir, "external-agent", "droid", "sessions"));
  });

  it("session path shape and the sessionId guard", () => {
    expect(externalSessionPath(agentDir, "droid", "abcd1234")).toBe(
      join(agentDir, "external-agent", "droid", "sessions", "abcd1234.jsonl"),
    );
    // 8 chars min, [A-Za-z0-9-]
    expect(() => externalSessionPath(agentDir, "droid", "short")).toThrow();
    expect(() => externalSessionPath(agentDir, "droid", "has_underscore")).toThrow();
    expect(() => externalSessionPath(agentDir, "droid", "has/slash")).toThrow();
    expect(() => externalSessionPath(agentDir, "droid", "x".repeat(65))).toThrow();
    expect(() => externalSessionPath(agentDir, "droid", "")).toThrow();
    // 64 chars max passes
    expect(() => externalSessionPath(agentDir, "droid", "x".repeat(64))).not.toThrow();
  });

  it("isExternalSessionPath: resolved prefix check, sep-guarded", () => {
    const file = externalSessionPath(agentDir, "droid", "abcd1234");
    expect(isExternalSessionPath(file, agentDir)).toBe(true);
    expect(isExternalSessionPath(join(file, "..", "abcd1234.jsonl"), agentDir)).toBe(true);
    // sibling directory sharing the prefix does not match (…/external-agent-x/…)
    expect(isExternalSessionPath(join(agentDir, "external-agent-x", "f"), agentDir)).toBe(false);
    expect(isExternalSessionPath(join(agentDir, "sessions", "abcd1234.jsonl"), agentDir)).toBe(false);
    expect(isExternalSessionPath(undefined, agentDir)).toBe(false);
    expect(isExternalSessionPath("", agentDir)).toBe(false);
  });

  it("catalog cache and probe cwd shapes", () => {
    expect(catalogCachePath(agentDir, "droid")).toBe(join(agentDir, "cache", "external-agent", "droid-catalog.json"));
    expect(probeCwd(agentDir)).toBe(join(agentDir, "cache", "external-agent", "probe-cwd"));
  });
});
