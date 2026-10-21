import { describe, expect, it, vi } from "vitest";
import { createListSessionsTool, formatXsSessionRows } from "../../src/tools/list-sessions-tool.js";
import { createMessageSessionTool, XS_UNKNOWN_HINT } from "../../src/tools/message-session-tool.js";
import {
  xsTargetFormallyRejected,
  type XsListOutcome,
  type XsSendOutcome,
  type XsSender,
} from "../../src/fabric/xs/sender.js";
import type { XsSessionRowWire } from "../../src/web-hub/protocol/xs.js";

/**
 * fabric phase-2 X3 anchor (phase2-plan §11.2): the two main-session tools — reserved addresses,
 * omitted wake, the `scope` parameter, result shapes and the S3 unknown hint. The sender core is
 * faked (its own behaviour is pinned by tests/fabric/xs-sender.test.ts).
 */

function fakeSender() {
  const message = vi.fn(async (args: { to: string }): Promise<XsSendOutcome> =>
    // the fake mirrors the sender contract's local pre-check (real behaviour is pinned in xs-sender.test.ts)
    xsTargetFormallyRejected(args.to)
      ? { status: "bad_target", effect: "none", reason: "bad_target" }
      : { status: "sent", effect: "applied" },
  );
  const list = vi.fn(async (): Promise<XsListOutcome> => ({ status: "ok", rows: [] }));
  return { sender: { message, list } as unknown as XsSender, message, list };
}

describe("tools/message_session", () => {
  it("rejects reserved address forms locally — no sender round trip", async () => {
    for (const to of ["root", "system", "main", "r_PARENT01", "@label", "wf_123456"]) {
      const h = fakeSender();
      const tool = createMessageSessionTool({ sender: h.sender });
      const result = await tool.execute("c", { to, text: "hi" });
      expect(result.details).toMatchObject({ status: "bad_target", effect: "none", reason: "bad_target" });
      // "no hub frame leaves" is the sender-core contract (pinned in xs-sender.test.ts); at the tool
      // seam only the surfaced outcome matters.
    }
  });

  it("omitted wake never reaches the sender as true (Q1: omitted = false)", async () => {
    const h = fakeSender();
    const tool = createMessageSessionTool({ sender: h.sender });
    await tool.execute("c", { to: "abcdefgh1234", text: "hi" });
    expect(h.message).toHaveBeenCalledWith({ to: "abcdefgh1234", text: "hi" });
    expect(h.message.mock.calls[0]![0]!.wake).toBeUndefined();
  });

  it("passes an explicit wake through and returns the sender outcome as details + JSON text", async () => {
    const h = fakeSender();
    h.message.mockResolvedValueOnce({
      status: "sent",
      effect: "applied",
      to: { ref: "abcdefgh1234", name: "frontend rework" },
      woke: true,
    });
    const tool = createMessageSessionTool({ sender: h.sender });
    const result = await tool.execute("c", { to: "abcdefgh1234", text: "hi", wake: true });
    expect(h.message).toHaveBeenCalledWith({ to: "abcdefgh1234", text: "hi", wake: true });
    expect(result.details).toEqual({
      status: "sent",
      effect: "applied",
      to: { ref: "abcdefgh1234", name: "frontend rework" },
      woke: true,
    });
    expect(JSON.parse((result.content as { type: "text"; text: string }[])[0]!.text)).toEqual(result.details);
  });

  it("appends the S3 do-not-resend hint exactly on unknown verdicts", async () => {
    const h = fakeSender();
    h.message.mockResolvedValueOnce({ status: "sent", effect: "unknown", reason: "queued" });
    const tool = createMessageSessionTool({ sender: h.sender });
    const unknown = await tool.execute("c", { to: "abcdefgh1234", text: "hi" });
    const unknownText = (unknown.content as { type: "text"; text: string }[])[0]!.text;
    expect(unknownText).toContain(XS_UNKNOWN_HINT);
    expect(unknownText).toContain("不要重发");

    h.message.mockResolvedValueOnce({ status: "sent", effect: "none", reason: "rejected" });
    const none = await tool.execute("c", { to: "abcdefgh1234", text: "hi" });
    expect((none.content as { type: "text"; text: string }[])[0]!.text).not.toContain(XS_UNKNOWN_HINT);
  });

  it("carries wakeDowngraded and candidates verbatim in the result shape (§4.3)", async () => {
    const h = fakeSender();
    h.message.mockResolvedValueOnce({
      status: "sent",
      effect: "applied",
      wakeDowngraded: "busy",
      to: { ref: "abcdefgh1234" },
    });
    const tool = createMessageSessionTool({ sender: h.sender });
    const out = await tool.execute("c", { to: "abcdefgh1234", text: "hi", wake: true });
    expect(out.details).toMatchObject({ effect: "applied", wakeDowngraded: "busy", to: { ref: "abcdefgh1234" } });

    h.message.mockResolvedValueOnce({
      status: "ambiguous",
      effect: "none",
      candidates: [{ ref: "aaaaaaaaaaaa" }, { ref: "bbbbbbbbbbbb", name: "n" }],
    });
    const amb = await tool.execute("c", { to: "dup", text: "hi" });
    expect(amb.details).toMatchObject({ status: "ambiguous", effect: "none" });
    expect((amb.details as { candidates?: unknown[] }).candidates).toHaveLength(2);
  });
});

describe("tools/list_sessions", () => {
  const row = (over: Partial<XsSessionRowWire> = {}): XsSessionRowWire => ({
    ref: "abcdefgh1234",
    name: "frontend rework",
    cwdLabel: "~/ai/pi-toolkit",
    kind: "main",
    receive: "wake",
    busy: false,
    lastActiveAgoS: 42,
    ...over,
  });

  it("passes query and scope through to the sender", async () => {
    const h = fakeSender();
    h.list.mockResolvedValueOnce({ status: "ok", rows: [row()] });
    const tool = createListSessionsTool({ sender: h.sender });
    await tool.execute("c", { query: "front", scope: "cwd" });
    expect(h.list).toHaveBeenCalledWith({ query: "front", scope: "cwd" });
    await tool.execute("c", {});
    expect(h.list).toHaveBeenLastCalledWith({});
  });

  it("renders rows with compact English tokens and reports empty listings", async () => {
    const h = fakeSender();
    h.list.mockResolvedValueOnce({
      status: "ok",
      rows: [row(), row({ name: undefined, busy: true, receive: "deliver" })],
    });
    const tool = createListSessionsTool({ sender: h.sender });
    const result = await tool.execute("c", {});
    const text = (result.content as { type: "text"; text: string }[])[0]!.text;
    expect(text).toContain("abcdefgh1234");
    expect(text).toContain('name="frontend rework"');
    expect(text).toContain("receive=wake");
    expect(text).toContain("idle");
    expect(text).toContain("lastActive=42s ago");
    expect(text).toContain("busy");
    expect(result.details).toMatchObject({ status: "ok" });

    h.list.mockResolvedValueOnce({ status: "ok", rows: [] });
    const empty = await tool.execute("c", {});
    expect((empty.content as { type: "text"; text: string }[])[0]!.text).toContain("No other joined sessions");
  });

  it("maps non-ok statuses to a single unavailable line with the code", async () => {
    const h = fakeSender();
    h.list.mockResolvedValueOnce({ status: "off", code: "E_XS_OFF" });
    const tool = createListSessionsTool({ sender: h.sender });
    const result = await tool.execute("c", {});
    const text = (result.content as { type: "text"; text: string }[])[0]!.text;
    expect(text).toContain("list_sessions unavailable: off (E_XS_OFF)");
    expect(result.details).toMatchObject({ status: "off", code: "E_XS_OFF" });
  });

  it("formatXsSessionRows stays token-only (UI-language split)", () => {
    const [line] = formatXsSessionRows([row()]);
    expect(line).toBe(
      '- abcdefgh1234 · name="frontend rework" · cwd=~/ai/pi-toolkit · kind=main · receive=wake · idle · lastActive=42s ago',
    );
  });
});
