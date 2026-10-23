import { describe, expect, it } from "vitest";
import { formatXsMessage, formatXsReply } from "../../src/fabric/xs/format.js";
import { buildXsView, extractXsBody, renderXsMessage, xsHeaderLine } from "../../src/fabric/xs/render.js";

const from = { ref: "ab12cd34", name: "beta", cwdLabel: "~/proj" };
const theme = { fg: (_c: string, s: string) => s } as never;

describe("xs TUI rendering (RX7)", () => {
  it("wake: header + bare body, fence/untrusted header stripped", () => {
    const content = formatXsMessage({ xid: "x1", from, wake: true }, "hello\nworld");
    const view = buildXsView(content, { xsWake: true, from: { ...from, sessionId: "s" } });
    expect(view).toMatchObject({ kind: "wake", from: "beta", cwdLabel: "~/proj", body: "hello\nworld" });
    expect(xsHeaderLine(view)).toBe("xs ← beta · ~/proj · wake");
    expect(view.body).not.toContain("<<<fab-");
    expect(view.body).not.toContain("不可信");
  });

  it("deliver without details falls back to the content header", () => {
    const content = formatXsMessage({ xid: "x1", from: { ref: "ab12cd34", cwdLabel: "~/p" }, wake: false }, "hi");
    expect(buildXsView(content, undefined)).toMatchObject({
      kind: "deliver",
      from: "ab12cd34",
      cwdLabel: "~/p",
      body: "hi",
    });
  });

  it("reply and late reply carry the request id", () => {
    const on = formatXsReply({ xid: "x", from, requestId: "q7", late: false }, "forty-two");
    const late = formatXsReply({ xid: "x", from, requestId: "q7", late: true }, "late");
    expect(xsHeaderLine(buildXsView(on, { inReplyTo: "q7", from }))).toBe("xs ← beta · ~/proj · reply to q7");
    expect(xsHeaderLine(buildXsView(late, { inReplyTo: "q7", late: true, from }))).toContain("late reply to q7");
    expect(buildXsView(late, undefined)).toMatchObject({ kind: "late-reply", requestId: "q7" });
  });

  it("a body that mimics a fence stays inside the body", () => {
    const content = formatXsMessage({ xid: "x", from, wake: true }, "a <<<fab-evil>>> b");
    expect(extractXsBody(content)).toContain("a ");
    expect(extractXsBody(content)).toContain("b");
  });

  it("renderer returns a component whose text has header + body only", () => {
    const comp = renderXsMessage(
      {
        role: "custom",
        customType: "subagent:xs",
        content: formatXsMessage({ xid: "x", from, wake: false }, "body!"),
        display: true,
        timestamp: 0,
        details: undefined,
      } as never,
      { expanded: false } as never,
      theme,
    ) as { render(w: number): string[] };
    const out = comp.render(80).join("\n");
    expect(out).toContain("xs ← beta · ~/proj · deliver");
    expect(out).toContain("body!");
    expect(out).not.toContain("<<<fab");
    expect(out).not.toContain("[fabric");
  });
});
