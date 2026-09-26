import { describe, expect, it } from "vitest";
import {
  formatInitialPasswordLines,
  formatInvalidExtraHostsLine,
  formatLanOffLine,
  formatLanOnLines,
  formatLanStatusLines,
  formatProxyMismatchLine,
  type LanStatusPaths,
} from "../../../src/web-hub/agent/lan-status.js";
import type { LanStatus } from "../../../src/web-hub/protocol/lan.js";
import type { LanInfoPayload } from "../../../src/web-hub/protocol/messages.js";

const PATHS: LanStatusPaths = { dbFile: "/home/u/.pi/agent/web-hub/hub.db", lanPortSetting: 7879 };

describe("formatLanOnLines (plan §9.3 on-state rows)", () => {
  it("main line: address + count + plaintext warning folded in", () => {
    const status: Extract<LanStatus, { state: "on" }> = {
      state: "on",
      port: 7879,
      hosts: ["192.168.31.25", "202507220006.local"],
      omitted: [],
      warnings: ["plaintext"],
    };
    const [line] = formatLanOnLines(status);
    expect(line).toContain("lan=on http://192.168.31.25:7879/");
    expect(line).toContain("+1");
    expect(line).toMatch(/⚠ 直连为 HTTP 明文/);
  });

  it("numeric hostname omission gets its own explanatory line (L16 契约)", () => {
    const status: Extract<LanStatus, { state: "on" }> = {
      state: "on",
      port: 7879,
      hosts: ["192.168.31.25"],
      omitted: [{ host: "202507220006", reason: "numeric" }],
      warnings: [],
    };
    const lines = formatLanOnLines(status);
    expect(lines).toContainEqual(expect.stringContaining("主机名「202507220006」是纯数字"));
    expect(lines.find((l) => l.includes("202507220006"))).toMatch(/202507220006\.local/);
  });

  it("denylisted/syntax/too-long/ipv6 omissions render distinct messages", () => {
    const status: Extract<LanStatus, { state: "on" }> = {
      state: "on",
      port: 1,
      hosts: ["1.2.3.4"],
      omitted: [
        { host: "dev", reason: "denylisted" },
        { host: "a_b", reason: "syntax" },
        { host: "x".repeat(300), reason: "too-long" },
        { host: "::1", reason: "ipv6" },
      ],
      warnings: [],
    };
    const lines = formatLanOnLines(status);
    expect(lines.some((l) => l.includes("dev") && l.includes("denylisted"))).toBe(true);
    expect(lines.some((l) => l.includes("a_b") && l.includes("syntax"))).toBe(true);
    expect(lines.some((l) => l.includes("too-long"))).toBe(true);
    expect(lines.some((l) => l.includes("ipv6"))).toBe(true);
  });

  it("proxy row: trustedFrom + externalOrigins + the compromise warning", () => {
    const status: Extract<LanStatus, { state: "on" }> = {
      state: "on",
      port: 7879,
      hosts: ["192.168.31.25"],
      omitted: [],
      proxy: { trustedFrom: ["127.0.0.1"], externalOrigins: ["https://hub.example.com"] },
      warnings: [],
    };
    const lines = formatLanOnLines(status);
    const proxyLine = lines.find((l) => l.startsWith("代理："));
    expect(proxyLine).toBeDefined();
    expect(proxyLine).toContain("127.0.0.1");
    expect(proxyLine).toContain("https://hub.example.com");
    expect(proxyLine).toContain("受信任代理若失陷");
  });

  it("login-saturated warning renders the red-flag saturation line", () => {
    const status: Extract<LanStatus, { state: "on" }> = {
      state: "on",
      port: 7879,
      hosts: ["1.2.3.4"],
      omitted: [],
      warnings: ["login-saturated"],
    };
    const lines = formatLanOnLines(status);
    expect(lines.some((l) => l.includes("饱和") && l.includes("/webhub unlock"))).toBe(true);
  });

  it("login-tightened without counts still renders a generic line; with counts embeds them", () => {
    const status: Extract<LanStatus, { state: "on" }> = {
      state: "on",
      port: 7879,
      hosts: ["1.2.3.4"],
      omitted: [],
      warnings: ["login-tightened"],
    };
    expect(formatLanOnLines(status).some((l) => l.includes("收紧模式"))).toBe(true);
    const withCounts = formatLanOnLines(status, { tightenedFailures: 7, tightenedAddresses: 3 });
    expect(withCounts.some((l) => l.includes("7 次失败") && l.includes("3 个地址"))).toBe(true);
  });

  it("no host at all still renders a line, never crashes", () => {
    const status: Extract<LanStatus, { state: "on" }> = {
      state: "on",
      port: 7879,
      hosts: [],
      omitted: [],
      warnings: [],
    };
    expect(() => formatLanOnLines(status)).not.toThrow();
  });

  it("unknown/forward-compat warning tokens are silently ignored", () => {
    const status: Extract<LanStatus, { state: "on" }> = {
      state: "on",
      port: 7879,
      hosts: ["1.2.3.4"],
      omitted: [],
      warnings: ["some-future-warning" as unknown as string],
    };
    expect(() => formatLanOnLines(status)).not.toThrow();
  });
});

describe("formatLanOffLine (plan §9.3 off/* rows)", () => {
  it("sqlite-unavailable", () => {
    expect(formatLanOffLine({ state: "off", reason: "sqlite-unavailable" }, PATHS)).toMatch(/node:sqlite/);
  });
  it("db-invalid includes detail and dbFile path", () => {
    const line = formatLanOffLine({ state: "off", reason: "db-invalid", detail: "corrupt" }, PATHS);
    expect(line).toContain("corrupt");
    expect(line).toContain(PATHS.dbFile);
  });
  it("db-too-large includes detail and dbFile path", () => {
    const line = formatLanOffLine({ state: "off", reason: "db-too-large", detail: "500MB" }, PATHS);
    expect(line).toContain("500MB");
    expect(line).toContain(PATHS.dbFile);
  });
  it("listen-failed includes the configured lan port and detail", () => {
    const line = formatLanOffLine({ state: "off", reason: "listen-failed", detail: "EADDRINUSE" }, PATHS);
    expect(line).toContain("7879");
    expect(line).toContain("EADDRINUSE");
  });
  it("bad-config includes detail", () => {
    expect(formatLanOffLine({ state: "off", reason: "bad-config", detail: "extraHosts[0]" }, PATHS)).toContain(
      "extraHosts[0]",
    );
  });
  it("db-unavailable / db-timeout / timeout have fixed text", () => {
    expect(formatLanOffLine({ state: "off", reason: "db-unavailable" }, PATHS)).toMatch(/连续失败 4 次/);
    expect(formatLanOffLine({ state: "off", reason: "db-timeout" }, PATHS)).toMatch(/5s/);
    expect(formatLanOffLine({ state: "off", reason: "timeout" }, PATHS)).toMatch(/30s/);
  });
});

describe("formatLanStatusLines (top-level composition + mismatch detection)", () => {
  it("settings on, hub.json has no lan key at all ⇒ 未生效 mismatch line", () => {
    const lines = formatLanStatusLines(undefined, { settingsEnabled: true, hubPid: 999, paths: PATHS });
    expect(lines).toEqual([expect.stringContaining("未生效")]);
    expect(lines[0]).toContain("999");
  });

  it("settings off but hub is still listening (lan=on) ⇒ 注意 mismatch line", () => {
    const status: LanStatus = { state: "on", port: 7879, hosts: ["1.2.3.4"], omitted: [], warnings: [] };
    const lines = formatLanStatusLines(status, { settingsEnabled: false, paths: PATHS });
    expect(lines).toEqual([expect.stringContaining("注意")]);
  });

  it("settings on, hub.json.lan present ⇒ normal on/off rendering, no mismatch text", () => {
    const status: LanStatus = { state: "on", port: 7879, hosts: ["1.2.3.4"], omitted: [], warnings: [] };
    const lines = formatLanStatusLines(status, { settingsEnabled: true, hubPid: 1, paths: PATHS });
    expect(lines.some((l) => l.includes("未生效"))).toBe(false);
    expect(lines[0]).toContain("lan=on");
  });

  it("settings off and status undefined ⇒ no lines at all", () => {
    expect(formatLanStatusLines(undefined, { settingsEnabled: false, paths: PATHS })).toEqual([]);
  });

  it("state starting ⇒ a single starting line", () => {
    const lines = formatLanStatusLines({ state: "starting" }, { settingsEnabled: true, paths: PATHS });
    expect(lines).toEqual([expect.stringContaining("starting")]);
  });
});

describe("formatInvalidExtraHostsLine / formatProxyMismatchLine (settings-level, plan §9.1)", () => {
  it("combines multiple invalid tokens into one line", () => {
    const line = formatInvalidExtraHostsLine([
      { token: "foo_bar", reason: "syntax" },
      { token: "dev", reason: "denylisted" },
    ]);
    expect(line).toContain("foo_bar");
    expect(line).toContain("dev");
  });
  it("empty list ⇒ undefined (no line to render)", () => {
    expect(formatInvalidExtraHostsLine([])).toBeUndefined();
  });
  it("proxy mismatch has fixed text", () => {
    expect(formatProxyMismatchLine()).toContain("trustProxyFrom");
  });
});

describe("formatInitialPasswordLines (plan §5.2 展示规则 + §9.3; L17 持续提醒)", () => {
  const payload: LanInfoPayload = {
    username: "alice",
    initialPassword: "abcde-fghij-kmnpq-rstuv",
    lan: { state: "starting" },
  };

  it("TUI: shows the plaintext password", () => {
    const lines = formatInitialPasswordLines(payload, "tui");
    expect(lines.some((l) => l.includes("abcde-fghij-kmnpq-rstuv"))).toBe(true);
    expect(lines.some((l) => l.includes("alice"))).toBe(true);
  });

  it.each(["rpc", "print", "json"] as const)("%s mode: never renders the plaintext, only the reminder", (mode) => {
    const lines = formatInitialPasswordLines(payload, mode);
    expect(lines.join("\n")).not.toContain("abcde-fghij-kmnpq-rstuv");
    expect(lines.some((l) => l.includes("初始密码"))).toBe(true);
  });

  it("password already changed (no initialPassword) ⇒ no lines in any mode", () => {
    const changed: LanInfoPayload = { username: "alice", lan: { state: "starting" } };
    for (const mode of ["tui", "rpc", "print", "json"] as const) {
      expect(formatInitialPasswordLines(changed, mode)).toEqual([]);
    }
    expect(formatInitialPasswordLines(undefined, "tui")).toEqual([]);
  });

  it("initialLogin fact adds an extra line with ip + formatted time, doesn't restrict login (no such wording)", () => {
    const withLogin: LanInfoPayload = {
      ...payload,
      initialLogin: { ip: "192.168.31.40", at: Date.UTC(2026, 8, 26, 21, 3) },
    };
    const lines = formatInitialPasswordLines(withLogin, "tui");
    expect(lines.some((l) => l.includes("192.168.31.40") && l.includes("用初始密码登录过"))).toBe(true);
  });

  it("persists regardless of mode even long after generation (L17: only reminds, never expires)", () => {
    // No time is consulted at all — presence of initialPassword is the only signal.
    const lines = formatInitialPasswordLines(payload, "rpc");
    expect(lines.some((l) => l.includes("请尽快修改初始密码"))).toBe(true);
  });
});
