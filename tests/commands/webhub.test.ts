// web-hub plan §包 I: /webhub command — status/open 文案 + control 缺失时的提示。

import { describe, expect, it } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createWebHubCommand, formatStatus } from "../../src/commands/webhub.js";
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
    expect(notes[0]!.message).toContain("/webhub [status|open|passwd|unlock|restart]");
  });
});
