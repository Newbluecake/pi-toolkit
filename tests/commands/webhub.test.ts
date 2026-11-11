// web-hub plan §包 I: /webhub command — status/open 文案 + control 缺失时的提示。

import { describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createWebHubCommand, formatStatus } from "../../src/commands/webhub.js";
import { resolveCommandPolicy } from "../../src/web-hub/agent/command-policy.js";
import type { WebHubControl, WebHubStatusView } from "../../src/web-hub/agent/index.js";

function fakeCtx() {
  const notes: Array<{ message: string; level: string }> = [];
  const ctx = {
    ui: {
      notify: (message: string, level: string) => notes.push({ message, level }),
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notes };
}

function control(over: Partial<WebHubControl> = {}): WebHubControl {
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
    ui: {
      statusLines: () => [],
    },
    privacy: {
      statusLines: () => [],
    },
    admin: {
      stop: async () => ({ kind: "stopped" }),
      start: async () => ({ kind: "started" }),
      clearStopMarker: async () => ({ kind: "cleared" }),
      rotateToken: async () => ({ kind: "offline" }),
    },
    ...over,
  };
}

async function run(
  args: string,
  deps: { control?: WebHubControl; open?: (url: string) => void } = {},
): Promise<Array<{ message: string; level: string }>> {
  const { ctx, notes } = fakeCtx();
  const cmd = createWebHubCommand({
    control: () => deps.control,
    ...(deps.open !== undefined ? { open: deps.open } : {}),
  });
  await cmd.handler(args, ctx);
  return notes;
}

describe("formatStatus", () => {
  it("shows state/agentKey/hub version and a token-less URL", () => {
    const line = formatStatus(control().status(), { url: "http://127.0.0.1:7878/#t=secret-token" });
    expect(line).toContain("state=live");
    expect(line).toContain("agentKey=a1234-abcdef");
    expect(line).toContain("hub=1.2.3");
    expect(line).toContain("url=http://127.0.0.1:7878/");
    expect(line).not.toContain("secret-token");
  });

  it("falls back to the hint when no URL is available", () => {
    const view: WebHubStatusView = { state: "backoff", attached: true, lastError: "ENOENT" };
    const line = formatStatus(view, { hint: "hub 未运行：state=backoff，见 /tmp/hub.log" });
    expect(line).toContain("state=backoff");
    expect(line).toContain("lastError=ENOENT");
    expect(line).toContain("hub 未运行：state=backoff，见 /tmp/hub.log");
  });

  it("stopMarker:'stopped' (acc32-B8) appends a resume hint", () => {
    const view: WebHubStatusView = { state: "off", attached: false, stopMarker: "stopped" };
    const line = formatStatus(view, { hint: "hub 未运行" });
    expect(line).toContain("stopped · /webhub start to resume");
  });

  it("stopMarker:'stopped' + stopMarkerAt (acc32-B8 revised per verifier r_29729WTC, plan §6.7.2) renders 'hub stopped since <time> · /webhub start to resume'", () => {
    const view: WebHubStatusView = {
      state: "off",
      attached: false,
      stopMarker: "stopped",
      stopMarkerAt: Date.parse("2026-01-02T03:04:05.000Z"),
    };
    const line = formatStatus(view, { hint: "hub 未运行" });
    expect(line).toContain("hub stopped since 2026-01-02T03:04:05.000Z · /webhub start to resume");
  });

  it("stopMarker:'unknown' (acc32-B8) appends an unreadable-marker hint", () => {
    const view: WebHubStatusView = { state: "off", attached: false, stopMarker: "unknown" };
    const line = formatStatus(view, { hint: "hub 未运行" });
    expect(line).toContain("autostart blocked");
    expect(line).toContain("stop marker unreadable");
  });

  it("stopMarker:'unknown' + code/path (acc32-B8 revised per verifier r_29729WTC, plan §6.7.2) renders the full 'unreadable (<code>) · check <path>, then /webhub start' text", () => {
    const view: WebHubStatusView = {
      state: "off",
      attached: false,
      stopMarker: "unknown",
      stopMarkerCode: "EACCES",
      stopMarkerPath: "/tmp/wh/stopped",
    };
    const line = formatStatus(view, { hint: "hub 未运行" });
    expect(line).toContain(
      "autostart blocked · stop marker unreadable (EACCES) · check /tmp/wh/stopped, then /webhub start",
    );
  });

  it("stopMarker:'absent' (or unset) adds no extra text", () => {
    const base = formatStatus({ state: "off", attached: false }, { hint: "hub 未运行" });
    const withAbsent = formatStatus({ state: "off", attached: false, stopMarker: "absent" }, { hint: "hub 未运行" });
    expect(withAbsent).toBe(base);
    expect(base).not.toContain("/webhub start");
  });
});

describe("/webhub command", () => {
  it("default (no args) is status", async () => {
    const notes = await run("", { control: control() });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.level).toBe("info");
    expect(notes[0]!.message).toContain("state=live");
    expect(notes[0]!.message).not.toContain("secret-token");
  });

  it("status subcommand prints the status line", async () => {
    const notes = await run("status", { control: control({ status: () => ({ state: "off", attached: false }) }) });
    expect(notes[0]!.message).toContain("state=off");
  });

  it("open prints the full URL (with #t=) and invokes the opener", async () => {
    const opened: string[] = [];
    const notes = await run("open", { control: control(), open: (u) => opened.push(u) });
    expect(notes[0]!.message).toBe("http://127.0.0.1:7878/#t=secret-token");
    expect(opened).toEqual(["http://127.0.0.1:7878/#t=secret-token"]);
  });

  it("open surfaces the hint verbatim when the hub is not running (no opener call)", async () => {
    const opened: string[] = [];
    const hint = "hub 未运行：state=backoff，见 ~/.pi/agent/web-hub/hub.log";
    const notes = await run("open", {
      control: control({ url: () => ({ hint }) }),
      open: (u) => opened.push(u),
    });
    expect(notes[0]!.level).toBe("warning");
    expect(notes[0]!.message).toBe(hint);
    expect(opened).toEqual([]);
  });

  it("control undefined ⇒ guidance message, status and open alike", async () => {
    for (const args of ["", "status", "open"]) {
      const opened: string[] = [];
      const notes = await run(args, { open: (u) => opened.push(u) });
      expect(notes, args).toHaveLength(1);
      expect(notes[0]!.level).toBe("warning");
      expect(notes[0]!.message).toContain("web-hub 未启用");
      expect(opened).toEqual([]);
    }
  });

  it("unknown subcommand ⇒ usage warning", async () => {
    const notes = await run("bogus", { control: control() });
    expect(notes[0]!.level).toBe("warning");
    expect(notes[0]!.message).toContain(
      "/webhub [status|open|passwd|unlock|restart|stop|start|token rotate|feishu <op>|2fa <op>|user list|user delete <username>]",
    );
  });
});

describe("/webhub __exec (plan §4.6, acc32-B4)", () => {
  it("a successful internalExec is silent (no warning notify)", async () => {
    const notes = await run("__exec new deadbeef", {
      control: control({ internalExec: async () => ({ ok: true }) }),
    });
    expect(notes).toHaveLength(0);
  });

  it("a failed internalExec (invalid/expired nonce) warns", async () => {
    const notes = await run("__exec new deadbeef", {
      control: control({ internalExec: async () => ({ ok: false, code: "E_UNSUPPORTED" }) }),
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.level).toBe("warning");
  });

  it("control undefined ⇒ guidance message, internalExec never called", async () => {
    const notes = await run("__exec new deadbeef", {});
    expect(notes).toHaveLength(1);
    expect(notes[0]!.level).toBe("warning");
    expect(notes[0]!.message).toContain("web-hub 未启用");
  });
});

describe("/webhub stop|start|token rotate (plan §6.7.1/§6.7.2, C8)", () => {
  it("stop: delegates to control.admin.stop() and formats every outcome kind", async () => {
    const calls: string[] = [];
    const c = control({
      admin: {
        stop: async () => {
          calls.push("stop");
          return { kind: "stopped" };
        },
        start: async () => ({ kind: "started" }),
        rotateToken: async () => ({ kind: "offline" }),
      },
    });
    const notes = await run("stop", { control: c });
    expect(calls).toEqual(["stop"]);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.level).toBe("info");
    expect(notes[0]!.message).toContain("已停止");
  });

  it("stop: marker-write-failed ⇒ error level, hub message says it was NOT stopped", async () => {
    const c = control({
      admin: {
        stop: async () => ({ kind: "marker-write-failed", message: "EACCES" }),
        start: async () => ({ kind: "started" }),
        rotateToken: async () => ({ kind: "offline" }),
      },
    });
    const notes = await run("stop", { control: c });
    expect(notes[0]!.level).toBe("error");
    expect(notes[0]!.message).toContain("未停止");
    expect(notes[0]!.message).toContain("EACCES");
  });

  it("start: delegates to control.admin.start()", async () => {
    const calls: string[] = [];
    const c = control({
      admin: {
        stop: async () => ({ kind: "stopped" }),
        start: async () => {
          calls.push("start");
          return { kind: "started" };
        },
        rotateToken: async () => ({ kind: "offline" }),
      },
    });
    const notes = await run("start", { control: c });
    expect(calls).toEqual(["start"]);
    expect(notes[0]!.level).toBe("info");
    expect(notes[0]!.message).toContain("删除");
  });

  it("start: marker-remove-failed ⇒ warning, mentions the code and that it still spawned once", async () => {
    const c = control({
      admin: {
        stop: async () => ({ kind: "stopped" }),
        start: async () => ({ kind: "started-marker-remove-failed", code: "EACCES" }),
        rotateToken: async () => ({ kind: "offline" }),
      },
    });
    const notes = await run("start", { control: c });
    expect(notes[0]!.level).toBe("warning");
    expect(notes[0]!.message).toContain("EACCES");
  });

  it("token rotate: delegates to control.admin.rotateToken() and reports revoked counts", async () => {
    const calls: string[] = [];
    const c = control({
      admin: {
        stop: async () => ({ kind: "stopped" }),
        start: async () => ({ kind: "started" }),
        rotateToken: async () => {
          calls.push("rotate");
          return { kind: "rotated", path: "online", revoked: { loopback: 2, lan: 3 } };
        },
      },
    });
    const notes = await run("token rotate", { control: c });
    expect(calls).toEqual(["rotate"]);
    expect(notes[0]!.level).toBe("info");
    expect(notes[0]!.message).toContain("revoked 5 sessions");
    expect(notes[0]!.message).toContain("loopback 2");
    expect(notes[0]!.message).toContain("lan 3");
  });

  it("token rotate: offline / unknown / stale-hub / error outcomes each format distinctly", async () => {
    const outcomes = ["offline", "unknown", "stale-hub", "error"] as const;
    for (const kind of outcomes) {
      const c = control({
        admin: {
          stop: async () => ({ kind: "stopped" }),
          start: async () => ({ kind: "started" }),
          rotateToken: async () =>
            kind === "error" ? { kind: "error", message: "boom" } : ({ kind } as { kind: typeof kind }),
        },
      });
      const notes = await run("token rotate", { control: c });
      expect(notes, kind).toHaveLength(1);
      if (kind === "offline") expect(notes[0]!.message).toContain("offline");
      if (kind === "unknown") expect(notes[0]!.level).toBe("warning");
      if (kind === "stale-hub") expect(notes[0]!.message).toContain("过旧");
      if (kind === "error") {
        expect(notes[0]!.level).toBe("error");
        expect(notes[0]!.message).toContain("boom");
      }
    }
  });

  it("token without 'rotate' ⇒ usage warning, never calls rotateToken()", async () => {
    const calls: string[] = [];
    const c = control({
      admin: {
        stop: async () => ({ kind: "stopped" }),
        start: async () => ({ kind: "started" }),
        rotateToken: async () => {
          calls.push("rotate");
          return { kind: "offline" };
        },
      },
    });
    const notes = await run("token", { control: c });
    expect(calls).toEqual([]);
    expect(notes[0]!.level).toBe("warning");
    expect(notes[0]!.message).toContain("/webhub token rotate");
  });
});

describe("getArgumentCompletions", () => {
  const cmd = () => createWebHubCommand({ control: () => undefined });

  it("returns all subcommands for an empty prefix", () => {
    const items = cmd().getArgumentCompletions!("")!;
    expect(items!.map((i) => i.value).sort()).toEqual([
      "2fa",
      "feishu",
      "open",
      "passwd",
      "restart",
      "start",
      "status",
      "stop",
      "token",
      "unlock",
      "user",
    ]);
    expect(items!.every((i) => typeof i.description === "string" && i.description.length > 0)).toBe(true);
  });

  it("filters by prefix", () => {
    const items = cmd().getArgumentCompletions!(" un")!;
    expect(items!.map((i) => i.value)).toEqual(["unlock"]);
    // Single-token first argument: applying it yields `/webhub unlock` byte-for-byte
    // (applyCompletion replaces the whole argument prefix with value).
    expect(`/webhub ${items![0]!.value}`).toBe("/webhub unlock");
  });

  it("completes only the static admin grammar with accurate destructive descriptions", () => {
    const complete = cmd().getArgumentCompletions!;
    const values = (s: string) => complete(s)!.map((item) => item.value);
    expect(values("token r")).toEqual(["token rotate"]);
    expect(values("2fa ")).toEqual([
      "2fa status",
      "2fa enroll",
      "2fa feishu",
      "2fa recovery",
      "2fa reset",
      "2fa forget-ips",
      "2fa repair",
    ]);
    expect(values("2fa f")).toEqual(["2fa feishu", "2fa forget-ips"]);
    expect(values("2fa\tfeishu\to")).toEqual(["2fa feishu on", "2fa feishu off"]);
    expect(values("2fa enroll --r")).toEqual(["2fa enroll --replace"]);
    for (const s of [
      "2fa reset ",
      "2fa repair --",
      "2fa recovery code",
      "2fa feishu on ",
      "token rotate ",
      "2fa\n",
      "2fa \u007f",
      "2fa " + "x".repeat(1025),
    ]) {
      expect(values(s)).toEqual([]);
    }
    const items = complete("2fa ")!;
    expect(items.find((i) => i.label === "recovery")!.description).toContain("作废旧恢复码");
    expect(items.find((i) => i.label === "reset")!.description).toContain("清除二次验证因子");
    expect(items.find((i) => i.label === "forget-ips")!.description).toContain("清除 IP");
    expect(items.find((i) => i.label === "repair")!.description).toContain("破坏性");
    expect(
      items.every(
        (i) => Buffer.byteLength(i.value) <= 512 && i.label.length <= 120 && (i.description?.length ?? 0) <= 200,
      ),
    ).toBe(true);
  });

  it("keeps default Web policy denial on every sensitive candidate", () => {
    const complete = cmd().getArgumentCompletions!;
    const candidates = [
      ...complete("")!.filter((item) => item.value === "2fa" || item.value === "token"),
      ...complete("2fa ")!,
      ...complete("token ")!,
      ...complete("2fa enroll ")!,
      ...complete("2fa feishu ")!,
    ];
    expect(candidates).toHaveLength(13);
    for (const { value } of candidates) {
      expect(resolveCommandPolicy({ name: "webhub", args: value, kind: "extension" }).policy).toBe("deny");
      expect(
        resolveCommandPolicy({ name: "webhub", args: value, kind: "extension", overrides: { webhub: "allow" } }).policy,
      ).toBe("allow");
    }
  });

  it("does not consult any admin dependencies when completing", () => {
    const probe = vi.fn(() => {
      throw new Error("unexpected read");
    });
    const command = createWebHubCommand({
      control: probe,
      twofaPort: probe,
      usersPort: probe,
      feishuPort: probe,
      privateNs: probe,
      open: probe,
      now: probe,
    });
    for (const prefix of ["", "token ", "2fa ", "2fa enroll ", "2fa feishu ", "feishu ", "user "]) {
      expect(command.getArgumentCompletions!(prefix)).not.toEqual([]);
    }
    expect(probe).not.toHaveBeenCalled();
  });

  it("returns an empty array for an unknown prefix and never throws", () => {
    expect(cmd().getArgumentCompletions!("bogus")).toEqual([]);
    expect(cmd().getArgumentCompletions!(undefined as unknown as string)).toEqual([]);
  });
});
