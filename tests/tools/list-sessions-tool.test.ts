import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createXsSender, type XsHubPort, type XsSenderDeps, type XsPortReply } from "../../src/fabric/xs/sender.js";
import { createListSessionsTool, type ListSessionsParams } from "../../src/tools/list-sessions-tool.js";
import type { XsResFrame } from "../../src/web-hub/protocol/xs.js";

const testToolContext = {} as ExtensionToolContext;

const text = (r: { content: unknown }) => (r.content as { text: string }[])[0]!.text;
const res = (over: Partial<XsResFrame> & { ok: boolean }): XsPortReply => ({
  kind: "res",
  res: { t: "xs_res", rid: "test", ...over },
});
function setup(over: Partial<XsSenderDeps> = {}) {
  const port = {
    list: vi.fn(async () => res({ ok: true, rows: [] })),
    resolve: vi.fn(),
    send: vi.fn(),
    hubChannelCap: () => true,
  } satisfies XsHubPort;
  const sender = createXsSender({
    port,
    origin: { current: () => ({ sessionId: "source-session", epoch: 1 }) },
    ...over,
  });
  return { port, tool: createListSessionsTool({ sender, channels: true }) };
}
const view = (names: string[]) => ({
  pref: () => names,
  effective: () => names,
  link: () => names,
  linkJoined: () => names.length > 0,
});

describe("list_sessions boundary guidance through real sender (#84 D2)", () => {
  it.each(["deadline", "link_lost", "off"] as const)(
    "%s is unavailable rather than an empty directory; safe reason is model-visible",
    async (kind) => {
      const h = setup();
      h.port.list.mockResolvedValueOnce({ kind });
      const result = await h.tool.execute("c", {}, undefined, undefined, testToolContext);
      expect(result.details).toEqual(
        kind === "off"
          ? { status: "off" }
          : { status: "error", reason: kind === "deadline" ? "client_deadline" : "link_lost" },
      );
      expect(text(result)).toContain("目录查询失败，不代表没有可见会话");
      if (kind !== "off")
        expect(text(result)).toContain(`reason=${kind === "deadline" ? "client_deadline" : "link_lost"}`);
      expect(text(result)).not.toContain("No other joined sessions");
      expect(h.port.list).toHaveBeenCalledTimes(1);
      expect(h.port.resolve).not.toHaveBeenCalled();
      expect(h.port.send).not.toHaveBeenCalled();
    },
  );

  it.each(["E_XS_OFF", "E_XS_BAD_FRAME", "E_XS_STALE_ORIGIN", "E_XS_INTERNAL", "FUTURE_CODE"] as const)(
    "preserves %s in details without guessing network/permissions",
    async (code) => {
      const h = setup();
      h.port.list.mockResolvedValueOnce(res({ ok: false, code }));
      const result = await h.tool.execute("c", {}, undefined, undefined, testToolContext);
      expect(result.details).toEqual({ status: "error", code });
      expect(text(result)).toContain(code === "FUTURE_CODE" ? "unknown_code" : code);
      expect(text(result)).toContain("无法确定具体故障原因");
      expect(text(result)).toContain("不要猜测网络或权限问题");
      expect(h.port.list).toHaveBeenCalledTimes(1);
    },
  );

  it("not joined is a local failure, not an instruction for the agent to join", async () => {
    const h = setup({ channels: view([]) });
    const result = await h.tool.execute("c", {}, undefined, undefined, testToolContext);
    expect(result.details).toEqual({ status: "not_joined", reason: "not_joined" });
    expect(text(result)).toContain("reason=not_joined");
    expect(text(result)).toContain("不要自行 join 或改变策略");
    expect(h.port.list).not.toHaveBeenCalled();
  });

  it.each(["", "  ", "bad name", "#other"])(
    "bad filter %j has correction guidance without join side effects",
    async (channel) => {
      const h = setup({ channels: view(["team"]) });
      const result = await h.tool.execute(
        "c",
        { channel } as ListSessionsParams,
        undefined,
        undefined,
        testToolContext,
      );
      expect(result.details).toEqual({ status: "bad_channel", reason: "bad_channel" });
      expect(text(result)).toContain("reason=bad_channel");
      expect(text(result)).toContain("不需要过滤请省略该参数");
      expect(text(result)).not.toContain("需要先加入该通道");
      expect(h.port.list).not.toHaveBeenCalled();
    },
  );

  it("unsupported channel filter is not an empty directory or a policy-changing command", async () => {
    const h = setup();
    const result = await h.tool.execute(
      "c",
      { channel: "#team" } as ListSessionsParams,
      undefined,
      undefined,
      testToolContext,
    );
    expect(result.details).toEqual({ status: "channel_unsupported", reason: "channel_unsupported" });
    expect(text(result)).toContain("不要自行改设置");
    expect(h.port.list).not.toHaveBeenCalled();
  });

  it("origin change discards rows and reports cancellation, not stale directory success", async () => {
    let epoch = 1;
    const h = setup({ origin: { current: () => ({ sessionId: "source-session", epoch }) } });
    h.port.list.mockImplementationOnce(async () => {
      epoch++;
      return res({ ok: true, rows: [] });
    });
    const result = await h.tool.execute("c", {}, undefined, undefined, testToolContext);
    expect(result.details).toEqual({ status: "origin_changed", reason: "origin_changed" });
    expect(text(result)).toContain("reason=origin_changed");
    expect(text(result)).toContain("停止本次查询");
    expect(h.port.list).toHaveBeenCalledTimes(1);
  });

  it("successful empty and non-empty directory bytes stay unchanged", async () => {
    const h = setup();
    expect((await h.tool.execute("c", {}, undefined, undefined, testToolContext)).content).toEqual([
      { type: "text", text: "No other joined sessions on this hub." },
    ]);
    h.port.list.mockResolvedValueOnce(
      res({
        ok: true,
        rows: [
          {
            ref: "peer12345678",
            cwdLabel: "~/project",
            kind: "main",
            receive: "deliver",
            busy: false,
            lastActiveAgoS: 2,
          },
        ],
      }),
    );
    expect((await h.tool.execute("c", {}, undefined, undefined, testToolContext)).content).toEqual([
      {
        type: "text",
        text: "Joined sessions on this hub:\n- peer12345678 · cwd=~/project · kind=main · receive=deliver · idle · lastActive=2s ago",
      },
    ]);
    expect(h.port.list).toHaveBeenCalledTimes(2);
  });

  it.each([new Error("SECRET_backend_error"), "SECRET_non_error"])(
    "never forwards an arbitrary port exception or its cause",
    async (error) => {
      const h = setup();
      h.port.list.mockRejectedValueOnce(error);
      const failure = await h.tool.execute("c", {}, undefined, undefined, testToolContext).then(
        () => {
          throw new Error("expected failure");
        },
        (cause: unknown) => cause,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("unexpected failure。目录查询失败，不代表没有可见会话");
      expect((failure as Error).message).not.toContain("SECRET");
      expect((failure as Error).cause).toBeUndefined();
      expect(h.port.list).toHaveBeenCalledTimes(1);
    },
  );
});
