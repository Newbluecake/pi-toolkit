import { describe, expect, it } from "vitest";
import { createXsSender, type XsHubPort, type XsPortReply, type XsPortSendArgs } from "../../src/fabric/xs/sender.js";
import type { XsResFrame } from "../../src/web-hub/protocol/xs.js";
import { createListSessionsTool, formatXsSessionRows } from "../../src/tools/list-sessions-tool.js";
import { createMessageSessionTool } from "../../src/tools/message-session-tool.js";

const res = (p: Partial<XsResFrame> & { ok: boolean }): XsPortReply => ({
  kind: "res",
  res: { t: "xs_res", rid: "r", ...p } as XsResFrame,
});

const A_FULL = "0190aaaa-bbbb-7ccc-8ddd-000000000001";

function make(opts: { aliasUsable?: boolean; resolve?: XsPortReply; send?: XsPortReply }) {
  const sends: XsPortSendArgs[] = [];
  const queries: string[] = [];
  const port: XsHubPort = {
    async list() {
      return res({ ok: true, rows: [] });
    },
    async resolve(a) {
      queries.push(a.query);
      return (
        opts.resolve ?? res({ ok: true, target: { ref: "0190aaaabbbb", name: "A", alias: "前端", sessionId: A_FULL } })
      );
    },
    async send(a) {
      sends.push(a);
      return opts.send ?? res({ ok: true, effect: "applied" });
    },
    ...(opts.aliasUsable !== undefined ? { aliasUsable: () => opts.aliasUsable === true } : {}),
  };
  const sender = createXsSender({ port, origin: { current: () => ({ sessionId: "S", epoch: 1 }) } });
  return { sender, sends, queries };
}

describe("AL5a sender: alias addressing", () => {
  it("aliasUsable: resolves the alias, then sends to the FULL sessionId; result carries ref/alias/name (no sessionId)", async () => {
    const h = make({ aliasUsable: true });
    const out = await h.sender.message({ to: "前端", text: "hi" });
    expect(h.queries).toEqual(["前端"]);
    expect(h.sends.map((s) => s.to)).toEqual([A_FULL]);
    expect(out.status).toBe("sent");
    expect(out.to).toEqual({ ref: "0190aaaabbbb", name: "A", alias: "前端" });
    expect(JSON.stringify(out)).not.toContain(A_FULL);
  });

  it("same 12-char ref for two UUIDv7 sessions: the send is pinned to A's full id, never the shared ref/alias text", async () => {
    // B shares A's ref; the hub resolved A. The frame must carry A's full id so a retargeted alias cannot hit B.
    const h = make({ aliasUsable: true });
    await h.sender.message({ to: "0190aaaabbbb", text: "x" });
    expect(h.sends[0]?.to).toBe(A_FULL);
    expect(h.sends[0]?.to).not.toBe("0190aaaabbbb");
  });

  it("aliasUsable without a resolved sessionId ⇒ none{no_session_id}, no send frame", async () => {
    const h = make({ aliasUsable: true, resolve: res({ ok: true, target: { ref: "r1", name: "A" } }) });
    const out = await h.sender.message({ to: "前端", text: "x" });
    expect(h.sends).toHaveLength(0);
    expect(out).toMatchObject({ status: "error", effect: "none", reason: "no_session_id" });
  });

  it("send-stage NO_TARGET under alias ⇒ none, reason changed", async () => {
    const h = make({ aliasUsable: true, send: res({ ok: false, code: "E_XS_NO_TARGET" }) });
    const out = await h.sender.message({ to: "前端", text: "x" });
    expect(out).toMatchObject({ status: "no_target", effect: "none", code: "E_XS_NO_TARGET", reason: "changed" });
  });

  it("NO_TARGET at resolve (alias held but unreachable) surfaces as no_target, nothing sent, no name fallback", async () => {
    const h = make({ aliasUsable: true, resolve: res({ ok: false, code: "E_XS_NO_TARGET" }) });
    const out = await h.sender.message({ to: "前端", text: "x" });
    expect(h.sends).toHaveLength(0);
    expect(out).toMatchObject({ status: "no_target", effect: "none" });
  });

  it("E_XS_ALIAS_UNAVAILABLE ⇒ alias_unavailable / none", async () => {
    const h = make({ aliasUsable: true, resolve: res({ ok: false, code: "E_XS_ALIAS_UNAVAILABLE" }) });
    const out = await h.sender.message({ to: "前端", text: "x" });
    expect(out).toMatchObject({ status: "alias_unavailable", effect: "none", code: "E_XS_ALIAS_UNAVAILABLE" });
  });

  it.each([undefined, false])(
    "non-alias mode (aliasUsable=%s): frame keeps the raw `to`, send NO_TARGET has no reason",
    async (v) => {
      const h = make({
        ...(v !== undefined ? { aliasUsable: v } : {}),
        resolve: res({ ok: true, target: { ref: "r1", name: "A", sessionId: A_FULL } }),
        send: res({ ok: false, code: "E_XS_NO_TARGET" }),
      });
      const out = await h.sender.message({ to: "frontend", text: "x" });
      expect(h.sends[0]?.to).toBe("frontend");
      expect(out.reason).toBeUndefined();
      expect(out.to).toEqual({ ref: "r1", name: "A" });
    },
  );
});

describe("AL5a tools", () => {
  const sender = { list: async () => ({ status: "ok" as const, rows: [] }) } as never;

  it("legacy / non-alias instances are unchanged; alias instance only appends description", () => {
    const l0 = createListSessionsTool({ sender });
    const l1 = createListSessionsTool({ sender, alias: true });
    expect(l1.parameters).toBe(l0.parameters);
    expect(l1.description.startsWith(l0.description)).toBe(true);
    expect(l1.description).toContain("alias is a human-assigned");
    const m0 = createMessageSessionTool({ sender });
    const m1 = createMessageSessionTool({ sender, alias: true });
    const m2 = createMessageSessionTool({ sender, alias: false });
    expect(m2.description).toBe(m0.description);
    expect(m1.parameters).toBe(m0.parameters);
    expect(m1.description.startsWith(m0.description)).toBe(true);
    expect(m1.description).toContain("never guess");
    expect(m0.description).not.toContain("alias");
  });

  it("row formatting: alias token only when present; legacy rows byte-identical", () => {
    const base = {
      ref: "abc",
      cwdLabel: "~/x",
      kind: "main",
      receive: "wake",
      busy: false,
      lastActiveAgoS: 3,
    } as never;
    expect(formatXsSessionRows([base])).toEqual([
      "- abc · cwd=~/x · kind=main · receive=wake · idle · lastActive=3s ago",
    ]);
    const withAlias = { ...(base as object), alias: "前端", name: "n" } as never;
    expect(formatXsSessionRows([withAlias])[0]).toBe(
      '- abc · alias="前端" · name="n" · cwd=~/x · kind=main · receive=wake · idle · lastActive=3s ago',
    );
  });

  it("message_session alias_unavailable adds the ref hint (alias on only)", async () => {
    const s = { message: async () => ({ status: "alias_unavailable", effect: "none" }) } as never;
    const on = await createMessageSessionTool({ sender: s, alias: true }).execute(
      "id",
      { to: "x", text: "t" },
      undefined as never,
      undefined as never,
      undefined as never,
    );
    expect((on.content[0] as { text: string }).text).toContain("list_sessions");
    const off = await createMessageSessionTool({ sender: s }).execute(
      "id",
      { to: "x", text: "t" },
      undefined as never,
      undefined as never,
      undefined as never,
    );
    expect((off.content[0] as { text: string }).text).not.toContain("别名");
  });
});
