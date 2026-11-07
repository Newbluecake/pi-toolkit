import { describe, expect, it } from "vitest";
import { createMessageSessionTool } from "../../src/tools/message-session-tool.js";
import type { XsSender } from "../../src/fabric/xs/sender.js";

/**
 * #21 包 A（约定层，plan r3 §1 D11 / §2 包 A / T14）: the reply-on `message_session` description
 * carries the intermediate-question convention sentence; the legacy description must NOT.
 * LEGACY_DESCRIPTION, the two schema instances and tests/fixtures/** are frozen — this suite pins
 * exactly that boundary.
 */

const D11_SENTENCE =
  "While working on a request that carried reply_to, send any intermediate question to its requester as a NEW message with expectReply (wake:true) — never the original replyTo (it accepts exactly one reply: your final result) — and do not block on ask_user: the requester cannot see your local dialog (the host redirects ask_user for you when it can).";

function fakeSender(): XsSender {
  return {
    message: async () => ({ status: "sent", effect: "applied" }),
    list: async () => ({ status: "ok", rows: [] }),
  } as unknown as XsSender;
}

describe("message_session reply description (#21 D11)", () => {
  it("reply-on description ends with the D11 sentence", () => {
    const tool = createMessageSessionTool({ sender: fakeSender(), reply: true });
    expect(tool.description).toContain(D11_SENTENCE);
  });

  it("legacy description (reply off) is byte-identical — no D11 sentence", () => {
    const tool = createMessageSessionTool({ sender: fakeSender() });
    expect(tool.description).not.toContain(D11_SENTENCE);
    expect(tool.description).not.toContain("ask_user");
    expect(tool.description).not.toContain("intermediate question");
  });

  it("suffix combinations keep the D11 sentence exactly once (alias / threadRebind / activation)", () => {
    for (const extra of [
      { alias: true },
      { threadRebind: true },
      { alias: true, threadRebind: true, activation: true },
    ] as const) {
      const tool = createMessageSessionTool({ sender: fakeSender(), reply: true, ...extra });
      const count = tool.description.split(D11_SENTENCE).length - 1;
      expect(count).toBe(1);
    }
  });

  it("reply-off with any suffix never gains the D11 sentence (I9 byte-parity)", () => {
    const tool = createMessageSessionTool({
      sender: fakeSender(),
      alias: true,
      threadRebind: true,
      activation: true,
    });
    expect(tool.description).not.toContain(D11_SENTENCE);
    expect(tool.description).not.toContain("ask_user");
  });
});
