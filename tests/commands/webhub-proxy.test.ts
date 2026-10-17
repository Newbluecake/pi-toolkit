// web-hub-proxy X1c: `/webhub status` prints the port-proxy lines (and stays byte-identical without them).
import { describe, expect, it } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createWebHubCommand } from "../../src/commands/webhub.js";
import type { WebHubControl } from "../../src/web-hub/agent/index.js";

function fakeCtx() {
  const notes: Array<{ message: string; level: string }> = [];
  const ctx = {
    ui: { notify: (message: string, level: string) => notes.push({ message, level }) },
  } as unknown as ExtensionCommandContext;
  return { ctx, notes };
}

function control(proxy?: { statusLines(): string[] }): WebHubControl {
  return {
    status: () => ({ state: "live", attached: true, agentKey: "a1-abcdef", hubVersion: "1.2.3", httpPort: 7878 }),
    url: () => ({ url: "http://127.0.0.1:7878/#t=secret-token" }),
    lan: {
      statusLines: () => [],
      info: async () => ({ ok: false, reason: "unavailable" }),
      unlock: async () => ({ ok: false, reason: "unavailable" }),
      changePasswordInteractive: async () => ({ ok: false, reason: "no-cap" }),
      restart: async () => ({ kind: "manual", message: "x" }),
    },
    ui: { statusLines: () => [] },
    privacy: { statusLines: () => [] },
    ...(proxy === undefined ? {} : { proxy }),
    admin: {
      stop: async () => ({ kind: "stopped" }),
      start: async () => ({ kind: "started" }),
      clearStopMarker: async () => ({ kind: "cleared" }),
      rotateToken: async () => ({ kind: "offline" }),
    },
  } as unknown as WebHubControl;
}

async function status(c: WebHubControl) {
  const { ctx, notes } = fakeCtx();
  await createWebHubCommand({ control: () => c }).handler("status", ctx);
  return notes;
}

describe("/webhub status — proxy lines", () => {
  it("absent / empty ⇒ only the main status line (byte-identical to before)", async () => {
    expect(await status(control())).toHaveLength(1);
    expect(await status(control({ statusLines: () => [] }))).toHaveLength(1);
  });

  it("`proxy: on …` ⇒ info; any other first line ⇒ warning; every line is printed in order", async () => {
    const info = await status(control({ statusLines: () => ["proxy: on · lan · 7900-7949 · max 8"] }));
    expect(info[1]).toEqual({ message: "proxy: on · lan · 7900-7949 · max 8", level: "info" });
    const warn = await status(control({ statusLines: () => ["warning：x", "second"] }));
    expect(warn.slice(1).map((n) => [n.message, n.level])).toEqual([
      ["warning：x", "warning"],
      ["second", "warning"],
    ]);
  });
});
