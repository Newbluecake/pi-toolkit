import { describe, it, expect } from "vitest";
import {
  cleanTerminalEnvironment,
  terminalDisplayMetadata,
  validTerminalPath,
} from "../../../../../src/web-hub/hub/terminal/v2/environment.js";
import { createTerminalBackend } from "../../../../../src/web-hub/hub/terminal/v2/backend.js";
describe("relocated backend pre-spawn safety", () => {
  it("allowlist never forwards parent HOME/user/PI/secret/loader/rc/proxy variables", () => {
    const env = cleanTerminalEnvironment({
      HOME: "/never-real-home",
      USER: "old",
      LOGNAME: "old",
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      PI_SECRET: "fake",
      API_KEY: "fake",
      LD_PRELOAD: "/tmp/fake",
      BASH_ENV: "/tmp/fake",
      ZDOTDIR: "/tmp/fake",
      PYTHONPATH: "/tmp/fake",
      HTTP_PROXY: "http://fake",
      NODE_OPTIONS: "fake",
    });
    expect(env).toEqual({ PATH: "/usr/bin:/bin", LANG: "C.UTF-8", TERM: "xterm-256color", COLORTERM: "truecolor" });
  });
  it("bad allowed values fail closed without leaking contents", () => {
    for (const source of [
      { LANG: "bad\0value" },
      { LANG: "Bearer fake" },
      { PATH: "/usr/bin:relative" },
      { LANG: "a".repeat(8193) },
    ])
      expect(() => cleanTerminalEnvironment(source)).toThrow("E_BAD_REQUEST");
    expect(validTerminalPath("/usr/bin:../bin")).toBe(false);
    expect(validTerminalPath("/bin/../usr/bin")).toBe(false);
  });
  it("metadata does not consume OSC/output, accepts only bounded labels and trusted cwd", () => {
    expect(
      terminalDisplayMetadata(
        { shellName: "bash", userLabel: "\u001b]0;evil", hostLabel: "host", cwd: "/evil", output: "ignored" },
        "/trusted",
      ),
    ).toEqual({ shellName: "bash", hostLabel: "host", cwd: "/trusted" });
  });
  it("invalid cwd/dimensions reject before helper construction, no fallback", () => {
    for (const cwd of ["relative", "/missing-v2-fixture-directory", ""])
      expect(() =>
        createTerminalBackend({
          cwd,
          cols: 80,
          rows: 24,
          inputIdleMs: 300000,
          maxLifetimeMs: 900000,
          onData: () => {},
        }),
      ).toThrow("E_BAD_REQUEST");
  });
});
