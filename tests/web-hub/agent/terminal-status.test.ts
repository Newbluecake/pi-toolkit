import { describe, expect, it } from "vitest";
import { formatTerminalStatusLines, type TerminalStatusInput } from "../../../src/web-hub/agent/terminal-status.js";
const limits = { maxPerSession: 2, maxPerPrincipal: 2, maxTotal: 8, inputIdleMs: 3600000, maxLifetimeMs: 28800000 };
const local: TerminalStatusInput = {
  settings: { ...limits, enabled: true },
  eligibility: "eligible",
  hubIdentityVerified: true,
};
const text = (over: Partial<TerminalStatusInput> = {}) => formatTerminalStatusLines({ ...local, ...over }).join("\n");
describe("terminal status source contract (§7)", () => {
  it("off after D8 override adds zero lines", () => {
    expect(formatTerminalStatusLines({ ...local, settings: undefined })).toEqual([]);
    expect(formatTerminalStatusLines({ ...local, settings: { ...limits, enabled: false } })).toEqual([]);
  });
  it("missing record is honest unknown/off-or-legacy even when local eligible", () => {
    expect(text()).toContain("本会话符合资格；hub终端能力未知（关闭或旧版）");
    expect(text()).not.toMatch(/cap.*enabled|已登录|eligible count|physicalUsed/);
    expect(text()).toContain("浏览器需本boot真实登录");
  });
  it.each(["default", "agentDir", "inherited"])(
    "new startup snapshot ready displays scope %s and global ceilings, not browser proof",
    (source) => {
      const t = text({
        hubSnapshot: {
          mode: "per-session",
          state: "ready",
          source,
          effectiveMachineLimits: { ...limits, maxTotal: 16, maxPerPrincipal: 4 },
        },
      });
      expect(t).toContain(`per-session / ready；scope ${source}`);
      expect(t).toContain("机器上限：total 16 / principal 4");
      expect(t).toContain("非浏览器能力回执");
      expect(t).toContain("本会话限额：2");
    },
  );
  it("stale/unverified identity never adopts a prior hub's ready/denial snapshot", () => {
    for (const state of ["ready", "unavailable"])
      expect(
        text({ hubIdentityVerified: false, hubSnapshot: { mode: "per-session", state, reason: "settings-unsafe" } }),
      ).not.toMatch(/settings-unsafe|per-session/);
  });
  it("old ready knows legacy only; old fixed unavailable reasons retained", () => {
    expect(text({ hubSnapshot: { state: "ready" } })).toContain("legacy-ready；per-session 能力 unknown");
    expect(text({ hubSnapshot: { state: "unavailable", reason: "journal-missing" } })).toContain(
      "终端不可用：journal-missing",
    );
    expect(
      text({
        hubSnapshot: {
          mode: "per-session",
          state: "unavailable",
          source: "agentDir",
          reason: "startup-domain-unknown",
        },
      }),
    ).toContain("终端不可用：startup-domain-unknown");
  });
  it("unknown fields/reasons/paths cannot leak or be treated as browser cap/login/SSE evidence", () => {
    const t = text({
      hubSnapshot: {
        mode: "per-session",
        state: "ready",
        source: "/secret/cwd",
        effectiveMachineLimits: { cwd: "/secret/cwd" },
        caps: ["terminal.session.v1"],
        loggedIn: true,
        token: "secret-token",
      },
    });
    expect(t).toContain("scope unknown");
    expect(t).toContain("机器上限：unknown");
    expect(t).not.toMatch(/secret|terminal.session.v1|已登录/);
    expect(text({ hubSnapshot: { state: "unavailable", reason: "secret-token" } })).toContain("终端不可用：unknown");
    expect(text({ hubSnapshot: { state: "unavailable", reason: "/secret/cwd" } })).not.toContain("/secret");
  });
  it.each(["not-connected", "guard-denied", "owner-unavailable"] as const)(
    "current projection %s never says declaration emitted",
    (eligibility) => {
      expect(text({ eligibility })).toContain(`资格 ${eligibility}；声明 absent`);
      expect(text({ eligibility })).not.toContain("本会话符合资格");
    },
  );
});

it.each([
  "stale-authority-prev-boot",
  "stale-authority-same-boot",
  "stale-authority-prev-boot-pid-present",
  "stale-authority-prev-boot-journal-not-empty",
  "stale-authority-prev-boot-receipts-not-empty",
  "authority-proc-unavailable",
  "authority-namespace-mismatch",
  "authority-corrupt",
  "authority-recovery-not-owner",
  "authority-publication-unsettled",
  "authority-recovery-state-changed",
  "authority-archive-unsafe",
  "authority-archive-capacity",
  "authority-archive-io",
])("fixed appended cold-recovery reason is readable: %s", (reason) => {
  const t = text({ hubSnapshot: { state: "unavailable", reason } });
  expect(t).toContain(`终端不可用：${reason}`);
  expect(t).toContain("不自动重置");
});
