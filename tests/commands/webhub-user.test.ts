import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createWebHubCommand } from "../../src/commands/webhub.js";
import { createCommandCaptureEngine, wrapCommandApi } from "../../src/commands/capture.js";
import type { LanReqFrame } from "../../src/web-hub/protocol/messages.js";

function harness(confirmed = true) {
  const notify = vi.fn(),
    confirm = vi.fn(async () => confirmed);
  const ctx = { mode: "tui", ui: { notify, confirm } } as unknown as ExtensionCommandContext;
  const request = vi.fn(async (frame: LanReqFrame) => ({
    t: "lan_res" as const,
    rid: frame.rid,
    ok: true as const,
    ...(frame.op === "users"
      ? {
          users: [
            { username: "bluecake", primary: true, twofa: true, liveSessions: 2 },
            { username: "admin", primary: false, twofa: false, liveSessions: 1 },
          ],
        }
      : {}),
  }));
  const command = createWebHubCommand({
    control: () => ({}) as never,
    usersPort: () => ({ hasCap: () => true, request }),
  });
  return { notify, confirm, ctx, request, command };
}

describe("/webhub user", () => {
  it("list shows primary, per-user 2FA and live sessions without a confirmation", async () => {
    const h = harness();
    await h.command.handler("user list", h.ctx);
    expect(h.request).toHaveBeenCalledWith(expect.objectContaining({ op: "users" }), "lan.v1");
    expect(h.notify).toHaveBeenCalledWith("bluecake（主账号）  2FA on  在线会话 2\nadmin  2FA off  在线会话 1", "info");
    expect(h.confirm).not.toHaveBeenCalled();
  });
  it.each([false, true])("delete requires explicit TUI confirmation: %s", async (confirmed) => {
    const h = harness(confirmed);
    await h.command.handler("user delete admin", h.ctx);
    expect(h.confirm).toHaveBeenCalledWith("删除局域网账号", expect.stringContaining("admin"));
    if (confirmed) {
      expect(h.request).toHaveBeenCalledWith(
        expect.objectContaining({ op: "user_delete", username: "admin" }),
        "lan.v1",
      );
      expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("已删除"), "info");
    } else {
      expect(h.request).not.toHaveBeenCalled();
      expect(h.notify).toHaveBeenCalledWith("已取消。", "info");
    }
  });
  it.each(["rpc", "print", "json"])("refuses non-TUI %s before request or confirmation", async (mode) => {
    const h = harness();
    await h.command.handler("user delete admin", { ...h.ctx, mode } as ExtensionCommandContext);
    expect(h.request).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("仅允许在本地 TUI"), "warning");
  });
  it.each(["list", "delete admin"])("real web capture refuses %s regardless of command policy", async (op) => {
    const h = harness();
    const capture = createCommandCaptureEngine();
    let registered!: Omit<RegisteredCommand, "name" | "sourceInfo">;
    const pi = wrapCommandApi(
      {
        registerCommand: (_name: string, cmd: typeof registered) => {
          registered = cmd;
        },
      } as unknown as ExtensionAPI,
      () => capture,
    );
    pi.registerCommand("webhub", h.command);
    capture.registerOwned("webhub");
    capture.arm({
      cmdId: "c",
      reqId: "r",
      name: "webhub",
      args: `user ${op}`,
      origin: { listener: "lan", ip: "192.0.2.1", reqId: "r" },
      deadlineAt: Date.now() + 8000,
    });
    await registered.handler(`user ${op}`, h.ctx);
    expect(h.request).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
    expect(JSON.stringify(capture.outputFor("c"))).toContain("仅允许在本地 TUI");
  });
  it("completes user operations and rejects malformed args", async () => {
    const h = harness();
    expect(h.command.getArgumentCompletions!("user ")?.map((x) => x.value)).toEqual(["user list ", "user delete "]);
    expect(h.command.getArgumentCompletions!("user d")?.map((x) => x.value)).toEqual(["user delete "]);
    for (const args of ["user", "user delete", "user list extra", "user delete admin extra"])
      await h.command.handler(args, h.ctx);
    expect(h.request).not.toHaveBeenCalled();
    expect(h.notify.mock.calls.every(([text]) => text.includes("用法"))).toBe(true);
  });
});
