// lan-plan.md §9.3 / §11 (S1-W3 LI): /webhub passwd|unlock|restart + LAN status/open lines.
// tests/commands/webhub.test.ts covers the pre-existing status/open/control-missing behavior;
// this file is scoped to what LI added on top of it.

import { describe, expect, it } from "vitest";
import type { ExtensionCommandContext, ExtensionMode } from "@earendil-works/pi-coding-agent";
import {
  createWebHubCommand,
  formatLanOpenLines,
  formatRestartOutcomeMessage,
  type WebHubCommandDeps,
} from "../../src/commands/webhub.js";
import type { LanInfoPayload } from "../../src/web-hub/protocol/messages.js";
import type { LanStatus } from "../../src/web-hub/protocol/lan.js";
import type { RestartOutcome } from "../../src/web-hub/agent/restart.js";
import type { PasswdOutcome } from "../../src/web-hub/agent/passwd-prompt.js";
import type { LanAdminResult, WebHubControl } from "../../src/web-hub/agent/index.js";

function fakeCtx(mode: ExtensionMode = "tui") {
  const notes: Array<{ message: string; level: string }> = [];
  const ctx = {
    mode,
    ui: {
      notify: (message: string, level: string) => notes.push({ message, level }),
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notes };
}

const ON_STATUS: Extract<LanStatus, { state: "on" }> = {
  state: "on",
  port: 7879,
  hosts: ["192.168.1.5", "myhost.local"],
  omitted: [],
  warnings: [],
};

function baseControl(over: Partial<WebHubControl> = {}): WebHubControl {
  return {
    status: () => ({ state: "live", attached: true, agentKey: "a1234-abcdef", hubVersion: "1.2.3", httpPort: 7878 }),
    url: () => ({ url: "http://127.0.0.1:7878/#t=secret-token" }),
    lan: {
      statusLines: () => [],
      info: async () => ({ ok: false, reason: "unavailable" }),
      unlock: async () => ({ ok: false, reason: "unavailable" }),
      changePasswordInteractive: async () => ({ ok: false, reason: "no-cap" }),
      restart: async () => ({ kind: "manual", message: "not wired in this fake" }),
    },
    ...over,
  };
}

async function run(
  args: string,
  opts: { control?: WebHubControl; mode?: ExtensionMode; deps?: Partial<WebHubCommandDeps> } = {},
): Promise<Array<{ message: string; level: string }>> {
  const { ctx, notes } = fakeCtx(opts.mode ?? "tui");
  const cmd = createWebHubCommand({ control: () => opts.control, ...opts.deps });
  await cmd.handler(args, ctx);
  return notes;
}

describe("/webhub status — LAN lines", () => {
  it("LAN off (empty statusLines, info unavailable) ⇒ status is still exactly one line", async () => {
    const notes = await run("status", { control: baseControl() });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.message).toContain("state=live");
  });

  it("LAN on ⇒ statusLines() are relayed as info, off-state lines as warning", async () => {
    const on = await run("status", {
      control: baseControl({ lan: { ...baseControl().lan, statusLines: () => ["lan=on http://192.168.1.5:7879/"] } }),
    });
    expect(on).toHaveLength(2);
    expect(on[1]).toEqual({ message: "lan=on http://192.168.1.5:7879/", level: "info" });

    const off = await run("status", {
      control: baseControl({
        lan: { ...baseControl().lan, statusLines: () => ["未开启：hub.db 无法使用（disk full）。"] },
      }),
    });
    expect(off[1]!.level).toBe("warning");
  });

  it("settings-level invalidExtraHosts / proxyMismatch are surfaced via lanSettingsWarnings", async () => {
    const notes = await run("status", {
      control: baseControl(),
      deps: {
        lanSettingsWarnings: () => ({
          invalidExtraHosts: [{ token: "dev", reason: "denylisted" }],
          proxyMismatch: true,
        }),
      },
    });
    const messages = notes.map((n) => n.message);
    expect(messages.some((m) => m.includes("dev") && m.includes("denylisted"))).toBe(true);
    expect(messages.some((m) => m.includes("trustProxyFrom"))).toBe(true);
    expect(notes.every((n) => n.level !== "error")).toBe(true);
  });

  it("no lanSettingsWarnings dep wired ⇒ no extra lines, no throw", async () => {
    const notes = await run("status", { control: baseControl() });
    expect(notes).toHaveLength(1);
  });

  it("initial password reminder only rendered in TUI mode, from lan.info()", async () => {
    const info: LanInfoPayload = {
      username: "alice",
      initialPassword: "abcde-fghij-kmnpq-rstuv",
      lan: { state: "starting" },
    };
    const control = baseControl({ lan: { ...baseControl().lan, info: async () => ({ ok: true, value: info }) } });

    const tui = await run("status", { control, mode: "tui" });
    expect(tui.some((n) => n.message.includes("abcde-fghij-kmnpq-rstuv"))).toBe(true);

    const rpc = await run("status", { control, mode: "rpc" });
    expect(rpc.some((n) => n.message.includes("abcde-fghij-kmnpq-rstuv"))).toBe(false);
    expect(rpc.some((n) => n.message.includes("仅在 TUI 中显示"))).toBe(true);
  });
});

describe("formatLanOpenLines (pure)", () => {
  it("LAN off / undefined ⇒ no lines", () => {
    expect(formatLanOpenLines(undefined)).toEqual([]);
    expect(formatLanOpenLines({ username: "a", lan: { state: "off", reason: "bad-config" } })).toEqual([]);
  });

  it("LAN on ⇒ the full, untruncated host list (unlike status's +N summary)", () => {
    const lines = formatLanOpenLines({ username: "a", lan: ON_STATUS });
    expect(lines).toEqual(["http://192.168.1.5:7879/", "http://myhost.local:7879/"]);
  });

  it("proxy configured ⇒ external origins appended", () => {
    const lines = formatLanOpenLines({
      username: "a",
      lan: { ...ON_STATUS, proxy: { trustedFrom: ["127.0.0.1"], externalOrigins: ["https://hub.example.com"] } },
    });
    expect(lines).toContain("https://hub.example.com/（经受信任代理）");
  });
});

describe("/webhub open — LAN section", () => {
  it("LAN on ⇒ full URL list printed after the loopback URL", async () => {
    const control = baseControl({
      lan: {
        ...baseControl().lan,
        info: async () => ({ ok: true, value: { username: "a", lan: ON_STATUS } }),
      },
    });
    const notes = await run("open", { control });
    expect(notes[0]!.message).toBe("http://127.0.0.1:7878/#t=secret-token");
    expect(notes.slice(1).map((n) => n.message)).toEqual(["http://192.168.1.5:7879/", "http://myhost.local:7879/"]);
  });

  it("info() unavailable ⇒ open degrades silently (no throw, no extra lines)", async () => {
    const notes = await run("open", { control: baseControl() });
    expect(notes).toHaveLength(1);
  });
});

describe("/webhub passwd", () => {
  it("rejects outside TUI mode without calling changePasswordInteractive", async () => {
    let called = false;
    const control = baseControl({
      lan: {
        ...baseControl().lan,
        changePasswordInteractive: async () => {
          called = true;
          return { ok: true };
        },
      },
    });
    const notes = await run("passwd", { control, mode: "rpc" });
    expect(called).toBe(false);
    expect(notes[0]!.level).toBe("warning");
    expect(notes[0]!.message).toContain("仅支持在 TUI");
  });

  it("rejects any extra argument without calling changePasswordInteractive", async () => {
    let called = false;
    const control = baseControl({
      lan: {
        ...baseControl().lan,
        changePasswordInteractive: async () => {
          called = true;
          return { ok: true };
        },
      },
    });
    const notes = await run("passwd extra-arg", { control, mode: "tui" });
    expect(called).toBe(false);
    expect(notes[0]!.level).toBe("warning");
    expect(notes[0]!.message).toContain("不接受任何参数");
  });

  it("TUI, no args ⇒ runs the interactive flow and reports the outcome", async () => {
    const outcomes: Array<{ outcome: PasswdOutcome; level: string; contains: string }> = [
      { outcome: { ok: true }, level: "info", contains: "已更新" },
      { outcome: { ok: false, reason: "cancelled" }, level: "warning", contains: "已取消" },
      { outcome: { ok: false, reason: "mismatch" }, level: "warning", contains: "不一致" },
      { outcome: { ok: false, reason: "invalid-length" }, level: "warning", contains: "长度" },
      {
        outcome: { ok: false, reason: "rejected", code: "E_WEAK", message: "too common" },
        level: "warning",
        contains: "too common",
      },
    ];
    for (const { outcome, level, contains } of outcomes) {
      const control = baseControl({
        lan: { ...baseControl().lan, changePasswordInteractive: async () => outcome },
      });
      const notes = await run("passwd", { control, mode: "tui" });
      expect(notes[0]!.level, JSON.stringify(outcome)).toBe(level);
      expect(notes[0]!.message, JSON.stringify(outcome)).toContain(contains);
    }
  });
});

describe("/webhub unlock", () => {
  it("ok ⇒ success message", async () => {
    const control = baseControl({
      lan: { ...baseControl().lan, unlock: async () => ({ ok: true, value: undefined }) },
    });
    const notes = await run("unlock", { control });
    expect(notes[0]!.level).toBe("info");
    expect(notes[0]!.message).toContain("已清空登录限流");
  });

  it("unavailable ⇒ warning", async () => {
    const notes = await run("unlock", { control: baseControl() });
    expect(notes[0]!.level).toBe("warning");
  });

  it("rejected ⇒ error with the hub's message", async () => {
    const res: LanAdminResult<void> = { ok: false, reason: "rejected", code: "E_INTERNAL", message: "boom" };
    const control = baseControl({ lan: { ...baseControl().lan, unlock: async () => res } });
    const notes = await run("unlock", { control });
    expect(notes[0]!.level).toBe("error");
    expect(notes[0]!.message).toContain("boom");
  });
});

describe("/webhub restart", () => {
  it.each<[RestartOutcome, "info" | "warning" | "error"]>([
    [{ kind: "restarted" }, "info"],
    [{ kind: "signalled" }, "info"],
    [{ kind: "manual", message: "please confirm by hand" }, "warning"],
    [{ kind: "failed", message: "pid never exited" }, "error"],
  ])("%o ⇒ %s", async (outcome, level) => {
    const { message, level: got } = formatRestartOutcomeMessage(outcome);
    expect(got).toBe(level);
    if (outcome.kind === "manual" || outcome.kind === "failed") expect(message).toBe(outcome.message);

    const control = baseControl({ lan: { ...baseControl().lan, restart: async () => outcome } });
    const notes = await run("restart", { control });
    expect(notes[0]!.level).toBe(level);
  });
});
