import { describe, expect, it } from "vitest";
import { cleanTerminalEnvironment, validTerminalPath } from "../../../src/web-hub/agent/terminal/environment.js";
import { TerminalTail } from "../../../src/web-hub/agent/terminal/owner.js";
import { TERMINAL_LIMITS as L } from "../../../src/web-hub/protocol/terminal.js";
import { resolveCommandPolicy } from "../../../src/web-hub/agent/command-policy.js";
import { createBuiltinBridge } from "../../../src/web-hub/agent/builtin-bridge.js";

describe("terminal inheritance §5.3", () => {
  it("hard-denies names and drops every non-allowlisted field without modifying the original", () => {
    const source = Object.freeze({
      PATH: "/usr/bin:/bin",
      HOME: "/not-uid-home",
      USER: "wrong",
      LOGNAME: "wrong",
      LANG: "C.UTF-8",
      LC_MESSAGES: "C",
      TZ: "UTC",
      API_KEY: "fake-key",
      apiKey: "fake-key",
      MixedCase_TOKEN: "fake-token",
      AWS_ACCESS_KEY_ID: "fake-access",
      AWS_SECRET_ACCESS_KEY: "fake-secret",
      AWS_SESSION_TOKEN: "fake-token",
      GOOGLE_APPLICATION_CREDENTIALS: "/fake",
      MY_PROVIDER_KEY: "unrecognized-secret",
      PI_SECRET: "fake",
      ARMORY_ROOT: "/fake",
      "BASH_FUNC_echo%%": "() { fake; }",
      LD_PRELOAD: "/fake",
      PYTHONPATH: "/fake",
      NODE_OPTIONS: "fake",
      SSH_AUTH_SOCK: "/fake",
      HTTP_PROXY: "https://user:token@example.test",
      ZDOTDIR: "/fake",
      ENV: "/fake",
      BASH_ENV: "/fake",
      SHELLOPTS: "fake",
      PROMPT_COMMAND: "fake",
      XDG_CONFIG_HOME: "/fake",
      PASSWORD: "fake",
      Cookie: "fake",
      BEARER: "fake",
      "bad-key": "fake",
      NUMBER: 2,
    });
    const out = cleanTerminalEnvironment(source);
    expect(out).toEqual({
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      LC_MESSAGES: "C",
      TZ: "UTC",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    });
    expect(source.HOME).toBe("/not-uid-home");
    expect(source.API_KEY).toBe("fake-key");
  });
  it.each(["LANG", "PATH", "HOME"])("allowlisted %s never bypasses value rejection", (key) => {
    for (const value of [
      "https://user:pass@example.test",
      "-----BEGIN PRIVATE KEY-----",
      "sk-abcdefghijklmnop",
      "a\0b",
      "x".repeat(8193),
    ])
      expect(() => cleanTerminalEnvironment({ [key]: value })).toThrow("E_BAD_REQUEST");
  });
  it("caps the actual key+value byte budget; rejects unsafe PATH, retains safe locale", () => {
    expect(cleanTerminalEnvironment({ LANG: "a".repeat(8192) }).LANG).toHaveLength(8192);
    const exact = {
      LANG: "a".repeat(8192),
      LANGUAGE: "a".repeat(8192),
      LC_TIME: "a".repeat(8192),
      LC_ALL: "a".repeat(8159),
    };
    expect(Object.entries(exact).reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(v) + 2, 0)).toBe(
      32768,
    );
    expect(cleanTerminalEnvironment(exact).LC_ALL).toHaveLength(8159);
    expect(() => cleanTerminalEnvironment({ ...exact, LC_ALL: exact.LC_ALL + "a" })).toThrow("E_BAD_REQUEST");
    expect(() =>
      cleanTerminalEnvironment({
        LANG: "a".repeat(8192),
        LANGUAGE: "a".repeat(8192),
        LC_TIME: "a".repeat(8192),
        LC_ALL: "a".repeat(8192),
      }),
    ).toThrow("E_BAD_REQUEST");
    expect(validTerminalPath("/usr/bin:/bin")).toBe(true);
    for (const PATH of ["", ":/bin", "/bin:", "/bin:.", "/bin:../local", "/bin:/tmp/../bin"])
      expect(() => cleanTerminalEnvironment({ PATH })).toThrow("E_BAD_REQUEST");
    expect(cleanTerminalEnvironment({})).toMatchObject({ PATH: "/usr/local/bin:/usr/bin:/bin" });
    const inherited = Object.create({ LANG: "not-own" }) as Record<string, string>;
    expect(cleanTerminalEnvironment(inherited)).not.toHaveProperty("LANG");
  });
});
describe("terminal bounded byte tail §6.2", () => {
  it("wraps at 1MiB, exact offsets/gap, copies only ≤16KiB, and wipes on revoke", () => {
    const tail = new TerminalTail();
    const all = Buffer.alloc(L.ringBytes + 4097);
    for (let i = 0; i < all.length; i++) all[i] = i % 251;
    for (let i = 0; i < all.length; i += 8192) expect(tail.append(all.subarray(i, i + 8192))).toBe(i);
    expect(tail.base).toBe(4097);
    expect(tail.next).toBe(all.length);
    expect(tail.droppedBytes).toBe(4097);
    const replay = tail.suffix();
    expect(replay.S).toBe(all.length - L.replayBytes);
    expect(replay.N0).toBe(all.length);
    expect(replay.bytes.equals(all.subarray(-L.replayBytes))).toBe(true);
    replay.bytes.fill(0);
    expect(tail.suffix().bytes.equals(all.subarray(-L.replayBytes))).toBe(true);
    tail.clear();
    expect(tail.suffix().bytes.length).toBe(0);
    expect(tail.base).toBe(all.length);
  });
  it("handles a single oversized chunk without growing capacity", () => {
    const t = new TerminalTail();
    const data = Buffer.alloc(L.ringBytes * 3 + 5, 9);
    t.append(data);
    expect(t.base).toBe(data.length - L.ringBytes);
    expect(t.suffix().bytes).toEqual(data.subarray(-L.replayBytes));
  });
});
it("reserved terminal bridge/policy cannot be enabled by a user allow override or capture", () => {
  expect(
    resolveCommandPolicy({
      name: "webhub",
      args: "__terminal anything",
      kind: "extension",
      overrides: { webhub: "allow" },
    }),
  ).toEqual({ policy: "deny" });
  const frame = {
    t: "cmd" as const,
    rid: "r",
    id: "i",
    deadlineMs: 3000,
    origin: { listener: "loopback" as const, ip: "127.0.0.1", reqId: "r" },
    cmd: { op: "command" as const, name: "webhub", args: "__terminal anything" },
  };
  const b = createBuiltinBridge();
  expect(b.execute(frame)).toEqual({ ok: false, code: "E_UNSUPPORTED", retryable: false, effect: "none" });
  expect(b.isQuiet(frame)).toBe(true);
});

it("optional panel metadata rejects unsafe/overlong labels without truncating paths or leaking them into facts", async () => {
  const { terminalDisplayMetadata } = await import("../../../src/web-hub/agent/terminal/environment.js");
  expect(
    terminalDisplayMetadata({ shellName: "bash", userLabel: "正常用户", hostLabel: "node-1.local" }, "/work"),
  ).toEqual({
    shellName: "bash",
    userLabel: "正常用户",
    hostLabel: "node-1.local",
    cwd: "/work",
  });
  expect(
    terminalDisplayMetadata({ shellName: "/bin/bash", userLabel: "hidden\u202E", hostLabel: "<bad>" }, "/bad\npath"),
  ).toEqual({});
  expect(
    terminalDisplayMetadata(
      { shellName: "x".repeat(65), userLabel: "x".repeat(129), hostLabel: "x".repeat(254) },
      "relative",
    ),
  ).toEqual({});
});
