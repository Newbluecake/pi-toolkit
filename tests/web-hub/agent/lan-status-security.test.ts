/** LAN security §2.4/§6 + P0 addendum 2 (pkg A): allowlist / db-invalid / login_ips / 2fa status rendering. */
import { describe, expect, it } from "vitest";
import {
  formatInvalidAllowClientsLine,
  formatLanOffLine,
  formatLanOnLines,
  formatLanStatusLines,
  formatTfaSegment,
  type LanStatusPaths,
  type TfaStatus,
} from "../../../src/web-hub/agent/lan-status.js";
import type { LanStatus } from "../../../src/web-hub/protocol/lan.js";

type On = Extract<LanStatus, { state: "on" }>;
const PATHS: LanStatusPaths = { dbFile: "/h/hub.db", lanPortSetting: 7879 };
const on = (extra: Partial<On> = {}): On => ({
  state: "on",
  port: 7879,
  hosts: ["192.168.31.25"],
  omitted: [],
  warnings: [],
  ...extra,
});
const tfa = (o: Partial<TfaStatus> = {}): TfaStatus => ({
  kind: "status",
  state: "enrolled",
  totp: true,
  feishu: false,
  recoveryLeft: 10,
  knownIps: 2,
  ...o,
});

describe("allowlist lines", () => {
  it("no allowClients slot ⇒ output unchanged (byte-identical to the legacy rendering)", () => {
    expect(formatLanOnLines(on())).toEqual(["lan=on http://192.168.31.25:7879/"]);
  });

  it("entries without denials: one compact English marker line", () => {
    const lines = formatLanOnLines(on({ allowClients: { entries: ["192.168.32.38/32", "10.0.0.0/24"] } }));
    expect(lines).toEqual(["lan=on http://192.168.31.25:7879/", "allowlist: 192.168.32.38/32, 10.0.0.0/24"]);
  });

  it("denials add total / last time / last ip and the silent-drop explanation", () => {
    const at = new Date(2026, 9, 19, 23, 5, 0).getTime();
    const lines = formatLanOnLines(
      on({ allowClients: { entries: ["10.0.0.0/8"], denied: { total: 42, lastAt: at, lastIp: "203.0.113.7" } } }),
    );
    expect(lines[1]).toBe("allowlist: 10.0.0.0/8 · denied 42 · last 2026-10-19 23:05 203.0.113.7");
    expect(lines[2]).toMatch(/静默断开/);
  });

  it("deny-all gets an explicit warning (never reads as 'unrestricted')", () => {
    const lines = formatLanOnLines(on({ allowClients: { entries: [], denyAll: true } }));
    expect(lines[1]).toBe("allowlist: deny-all");
    expect(lines[2]).toMatch(/deny-all/);
    expect(lines[2]).toMatch(/没有任何有效项/);
  });

  it("long lists are truncated with a count; a hostile lastIp stays on one bounded line", () => {
    const entries = Array.from({ length: 20 }, (_, i) => `10.0.${i}.0/24`);
    const l = formatLanOnLines(
      on({ allowClients: { entries, denied: { total: 1, lastAt: 1, lastIp: `x\n${"y".repeat(200)}` } } }),
    )[1]!;
    expect(l).toContain("(+12)");
    expect(l).not.toContain("\n");
    expect(l.length).toBeLessThan(400);
  });

  it("invalid allowClients tokens render in the settings warning line", () => {
    expect(formatInvalidAllowClientsLine([])).toBeUndefined();
    const line = formatInvalidAllowClientsLine([
      { token: "300.1.1.1", reason: "syntax" },
      { token: "10.9.9.9", reason: "limit" },
      { token: "a\nb", reason: "syntax" },
    ])!;
    expect(line).toContain("300.1.1.1（格式无效）");
    expect(line).toContain("10.9.9.9（超出 64 项上限）");
    expect(line).not.toContain("\n");
  });
});

describe("db-invalid 2FA refusal (LAN off)", () => {
  it.each(["2fa-at-v1", "2fa-schema", "2fa-missing-row", "db-invalid:2fa-schema"])(
    "detail %s ⇒ reason + repair hint, and never suggests moving hub.db",
    (detail) => {
      const line = formatLanOffLine({ state: "off", reason: "db-invalid", detail }, PATHS);
      expect(line).toContain(`db-invalid:${detail.replace(/^db-invalid:/, "")}`);
      expect(line).toContain("/webhub 2fa repair --confirm");
      expect(line).not.toContain("/h/hub.db");
    },
  );

  it("other db-invalid details keep the legacy move-the-file message", () => {
    const line = formatLanOffLine({ state: "off", reason: "db-invalid", detail: "schema" }, PATHS);
    expect(line).toContain("/h/hub.db");
    expect(line).not.toContain("2fa repair");
  });

  it("reaches the top-level entry", () => {
    const lines = formatLanStatusLines(
      { state: "off", reason: "db-invalid", detail: "2fa-missing-row" },
      { settingsEnabled: true, paths: PATHS },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("/webhub 2fa repair --confirm");
  });
});

describe("login_ips rebuilt notice", () => {
  it("shown only when loginIpsRebuiltAt is set", () => {
    expect(formatLanOnLines(on()).some((l) => l.includes("login_ips"))).toBe(false);
    const at = new Date(2026, 9, 19, 8, 3, 0).getTime();
    const lines = formatLanOnLines(on({ loginIpsRebuiltAt: at }));
    const notice = lines.find((l) => l.includes("login_ips"))!;
    expect(notice).toContain("2026-10-19 08:03");
    expect(notice).toMatch(/已迁移或重建/);
  });
});

describe("2fa segment (optional TfaStatus)", () => {
  it("absent argument ⇒ no segment at all", () => {
    expect(formatTfaSegment(undefined)).toBeUndefined();
    expect(formatLanOnLines(on())[0]).not.toContain("2fa=");
  });
  it.each([
    [tfa({ totp: true, feishu: true, recoveryLeft: 7 }), "2fa=totp+feishu（恢复码剩 7）"],
    [tfa({ totp: true, feishu: false, recoveryLeft: 10 }), "2fa=totp（恢复码剩 10）"],
    [tfa({ totp: false, feishu: true, recoveryLeft: 0 }), "2fa=feishu（恢复码剩 0）"],
    [tfa({ state: "none", totp: false, feishu: false, recoveryLeft: 0 }), "2fa=off"],
    [tfa({ state: "inconsistent", totp: false, feishu: false, recoveryLeft: 0 }), "2fa=inconsistent"],
  ])("%j ⇒ %s on the main line", (status, text) => {
    expect(formatTfaSegment(status)).toBe(text);
    expect(formatLanOnLines(on(), undefined, status)[0]).toBe(`lan=on http://192.168.31.25:7879/ ${text}`);
  });
  it("sits before the plaintext warning and flows through formatLanStatusLines opts.tfa", () => {
    const lines = formatLanStatusLines(on({ warnings: ["plaintext"] }), {
      settingsEnabled: true,
      paths: PATHS,
      tfa: tfa(),
    });
    expect(lines[0]).toMatch(/^lan=on http:\/\/192\.168\.31\.25:7879\/ 2fa=totp（恢复码剩 10）  ⚠ 直连为 HTTP 明文/);
  });
  it("repairNeeded and inconsistent add the repair hint line; a healthy status adds none", () => {
    const healthy = formatLanOnLines(on(), undefined, tfa());
    expect(healthy.join("\n")).not.toContain("repair");
    const needs = formatLanOnLines(on(), undefined, tfa({ repairNeeded: "twofa row\nmissing" }));
    const hint = needs.find((l) => l.includes("repair"))!;
    expect(hint).toContain("/webhub 2fa repair --confirm");
    expect(hint).toContain("twofa row missing");
    expect(hint).not.toContain("\n");
    const incons = formatLanOnLines(on(), undefined, tfa({ state: "inconsistent" }));
    expect(incons.some((l) => l.includes("2FA 数据不一致") && l.includes("repair --confirm"))).toBe(true);
  });
  it("never renders secrets: only the fields of the status shape are used", () => {
    const status = { ...tfa(), otpauthUri: "otpauth://totp/x", secretB32: "JBSWY3DPEHPK3PXP" } as TfaStatus;
    expect(formatLanOnLines(on(), undefined, status).join("\n")).not.toMatch(/otpauth|JBSWY3/);
  });
});
