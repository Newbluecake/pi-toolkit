// web-hub-cmd-history A1 (M1 verify fix): `/webhub status` prints the cmd-history line
// through the control's `cmdHistory` slot — always, including `cmd-history: off` (§4.9), with
// the slot's own levelOf deciding info/warning. Byte-identical status output without the slot.
import { describe, expect, it } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createWebHubCommand } from "../../src/commands/webhub.js";
import type { WebHubControl } from "../../src/web-hub/agent/index.js";
import { cmdHistoryStatusLevel } from "../../src/web-hub/agent/cmd-history-status.js";

function fakeCtx() {
  const notes: Array<{ message: string; level: string }> = [];
  const ctx = {
    ui: { notify: (message: string, level: string) => notes.push({ message, level }) },
  } as unknown as ExtensionCommandContext;
  return { ctx, notes };
}

function control(cmdHistory?: {
  statusLines(): string[];
  levelOf(line: string | undefined): "info" | "warning";
}): WebHubControl {
  return {
    status: () => ({ state: "live", attached: true, agentKey: "a1-abcdef", hubVersion: "1.2.3", httpPort: 7878 }),
    url: () => ({ url: "http://127.0.0.1:7878/#t=secret-token" }),
    lan: {
      statusLines: () => [],
      info: async () => ({ ok: false, reason: "unavailable" }),
      unlock: async () => ({ ok: false, reason: "unavailable" }),
      changePasswordInteractive: async () => ({ kind: "manual", message: "x" }),
      restart: async () => ({ kind: "manual", message: "x" }),
    },
    ui: { statusLines: () => [] },
    privacy: { statusLines: () => [] },
    ...(cmdHistory === undefined ? {} : { cmdHistory }),
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

describe("/webhub status — cmd-history line (§4.9)", () => {
  it("no slot (older control double) ⇒ only the main status line, byte-identical", async () => {
    expect(await status(control())).toHaveLength(1);
  });

  it("`cmd-history: on · hub-cap on · …` ⇒ info; `cmd-history: off` ⇒ info too (operator confirmation)", async () => {
    const on = await status(
      control({
        statusLines: () => ["cmd-history: on · hub-cap on · appended 3 · skipped 1 · failed 0"],
        levelOf: cmdHistoryStatusLevel,
      }),
    );
    expect(on[1]).toEqual({
      message: "cmd-history: on · hub-cap on · appended 3 · skipped 1 · failed 0",
      level: "info",
    });
    const off = await status(control({ statusLines: () => ["cmd-history: off"], levelOf: cmdHistoryStatusLevel }));
    expect(off[1]).toEqual({ message: "cmd-history: off", level: "info" });
  });

  it("a live link lacking the cap ⇒ the line carries the warning level", async () => {
    const line =
      "cmd-history: on · hub-cap off (old hub, or /webhub restart pending) · appended 0 · skipped 0 · failed 0";
    const notes = await status(control({ statusLines: () => [line], levelOf: cmdHistoryStatusLevel }));
    expect(notes[1]).toEqual({ message: line, level: "warning" });
  });
});
