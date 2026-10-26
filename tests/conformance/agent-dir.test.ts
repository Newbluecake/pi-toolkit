import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAgentDir } from "../../src/core/agent-dir.js";
import { sandboxHome } from "../integration/helpers/home-sandbox.js";

const sandbox = sandboxHome();
afterEach(() => vi.unstubAllEnvs());
// A sandbox HOME prevents the real pi public API from ever resolving developer paths.
import { afterAll } from "vitest";
afterAll(() => sandbox.restore());

describe("T-AD2 public pi agentDir contract (peer bump gate)", () => {
  it("pins config directory and probes the public environment variable", () => {
    expect(CONFIG_DIR_NAME).toBe(".pi");
    const dir = join(sandbox.home, "custom-agent");
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    expect(getAgentDir()).toBe(dir);
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
    expect(getAgentDir()).toBe(join(homedir(), CONFIG_DIR_NAME, "agent"));
  });

  it.each([
    undefined,
    "",
    "~",
    "~/x",
    "~/.pi/agent",
    join(sandbox.home, "agent"),
    `${join(sandbox.home, "agent")}/`,
    join(sandbox.home, ".pi", "agent"),
    `${join(sandbox.home, ".pi", "agent")}/`,
    pathToFileURL(join(sandbox.home, "url agent")).href,
  ])("agrees with public getAgentDir for %s (relative values deliberately excluded)", (raw) => {
    vi.stubEnv("PI_CODING_AGENT_DIR", raw);
    expect(join(resolveAgentDir(process.env, homedir()).dir, "x")).toBe(join(getAgentDir(), "x"));
  });
});
