/**
 * private-plan §4.1-3 (N3): `/webhub` inside a private mount ns.
 *
 *   - restart: refused BEFORE any hub interaction (no marker clear, no shutdown);
 *   - open: prints the URL, never calls the browser opener;
 *   - start: clears the marker as usual + explains 「本会话不会自行拉起」;
 *   - stop: deliberately untouched.
 * Non-ns parity is pinned by tests/commands/webhub.test.ts (unchanged behavior there).
 */
import { describe, expect, it, vi } from "vitest";
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

function control(spy: { clearStopMarker: () => void; restart: () => void; start: () => void; stop: () => void }) {
  return {
    status: () => ({ state: "live", attached: true, agentKey: "a1234-abcdef", httpPort: 7878 }),
    url: () => ({ url: "http://127.0.0.1:7878/#t=secret-token" }),
    lan: {
      statusLines: () => [],
      info: async () => ({ ok: false, reason: "unavailable" }),
      unlock: async () => ({ ok: false, reason: "unavailable" }),
      changePasswordInteractive: async () => ({ ok: false, reason: "no-cap" }),
      restart: async () => {
        spy.restart();
        return { kind: "restarted" as const };
      },
    },
    ui: { statusLines: () => [] },
    privacy: { statusLines: () => [] },
    admin: {
      stop: async () => {
        spy.stop();
        return { kind: "stopped" as const };
      },
      start: async () => {
        spy.start();
        return { kind: "started" as const };
      },
      clearStopMarker: async () => {
        spy.clearStopMarker();
        return { kind: "cleared" as const };
      },
      rotateToken: async () => ({ kind: "offline" as const }),
    },
  } as unknown as WebHubControl;
}

type Gate = "in-ns" | "not-ns" | "unknown";

async function run(
  args: string,
  opts: { privateNs?: Gate; open?: (url: string) => void } = {},
): Promise<{ notes: Array<{ message: string; level: string }>; calls: Record<string, number> }> {
  const calls = { clearStopMarker: 0, restart: 0, start: 0, stop: 0 } as Record<string, number>;
  const counting = {
    clearStopMarker: () => {
      calls.clearStopMarker += 1;
    },
    restart: () => {
      calls.restart += 1;
    },
    start: () => {
      calls.start += 1;
    },
    stop: () => {
      calls.stop += 1;
    },
  };
  const { ctx, notes } = fakeCtx();
  const cmd = createWebHubCommand({
    control: () => control(counting),
    ...(opts.privateNs !== undefined
      ? {
          privateNs: () => ({
            gate: opts.privateNs!,
            ...(opts.privateNs === "unknown" ? { reason: "保险库 acme 的 private.json 损坏（json）" } : {}),
          }),
        }
      : {}),
    ...(opts.open !== undefined ? { open: opts.open } : {}),
  });
  await cmd.handler(args, ctx);
  return { notes, calls };
}

describe("/webhub inside a private mount ns (private-plan §4.1-3)", () => {
  it("restart (in-ns): refused BEFORE any hub interaction — no marker clear, no restart call", async () => {
    const open = vi.fn();
    const { notes, calls } = await run("restart", { privateNs: "in-ns", open });
    expect(calls).toEqual({ clearStopMarker: 0, restart: 0, start: 0, stop: 0 });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.message).toContain("私有挂载命名空间");
    expect(notes[0]!.message).toContain("/webhub restart");
    expect(notes[0]!.level).toBe("warning");
    expect(open).not.toHaveBeenCalled();
  });

  it("restart (unknown, review N3 #1): refused identically, with the diagnostic copy", async () => {
    const { notes, calls } = await run("restart", { privateNs: "unknown" });
    expect(calls).toEqual({ clearStopMarker: 0, restart: 0, start: 0, stop: 0 });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.message).toContain("无法确认");
    expect(notes[0]!.message).toContain("private.json 损坏");
    expect(notes[0]!.message).toContain("pi-secure status");
    expect(notes[0]!.level).toBe("warning");
  });

  it("open (in-ns AND unknown): prints the URL, never calls the opener, explains why", async () => {
    const open = vi.fn();
    const nsNotes = await run("open", { privateNs: "in-ns", open });
    expect(open).not.toHaveBeenCalled();
    expect(nsNotes.notes.some((n) => n.message.includes("不在此打开浏览器"))).toBe(true);
    const { notes } = await run("open", { privateNs: "unknown", open });
    expect(open).not.toHaveBeenCalled();
    const urls = notes.filter((n) => n.message.includes("http://127.0.0.1:7878/"));
    expect(urls).toHaveLength(1); // the full URL (token included — same as the non-ns open)
    expect(notes.some((n) => n.message.includes("不在此打开浏览器"))).toBe(true);
  });

  it("start (in-ns AND unknown): marker cleared as usual + the 「不会自行拉起」 note", async () => {
    const { notes, calls } = await run("start", { privateNs: "unknown" });
    expect(calls.start).toBe(1);
    expect(notes.some((n) => n.message.includes("stop 标记已删除"))).toBe(true);
    expect(notes.some((n) => n.message.includes("本会话不会自行拉起"))).toBe(true);
  });

  it("stop: untouched by the ns verdict (still stops, no ns note)", async () => {
    const { notes, calls } = await run("stop", { privateNs: "in-ns" });
    expect(calls.stop).toBe(1);
    expect(notes.some((n) => n.message.includes("hub 已停止"))).toBe(true);
    expect(notes.some((n) => n.message.includes("命名空间"))).toBe(false);
  });

  it("not-ns restart: proceeds exactly as before (marker clear + restart)", async () => {
    const { notes, calls } = await run("restart", { privateNs: "not-ns" });
    expect(calls.clearStopMarker).toBe(1);
    expect(calls.restart).toBe(1);
    expect(notes.some((n) => n.message.includes("命名空间"))).toBe(false);
  });

  it("not-ns open: still calls the opener (existing behavior)", async () => {
    const open = vi.fn();
    await run("open", { privateNs: "not-ns", open });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("http://127.0.0.1:7878/#t=secret-token");
  });
});
