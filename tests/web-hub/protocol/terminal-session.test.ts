import { expect, it } from "vitest";
import { decodeAgentFrame } from "../../../src/web-hub/protocol/messages.js";
import * as retired from "../../../src/web-hub/protocol/terminal-session.js";
import { parseTerminalSessionV2 } from "../../../src/web-hub/protocol/terminal-v2.js";

it("opaque v1 status cannot become a positive v2 candidate or break ordinary status", () => {
  for (const terminalSession of [
    undefined,
    null,
    {},
    { v: 1, enabled: true, sessionId: "session", epoch: "epoch", limits: { maxTotal: 8 } },
    { v: 1, cwd: "/private" },
  ]) {
    const raw = { t: "status", leafId: null, busy: false, pending: false, terminalSession };
    expect(decodeAgentFrame(raw)).toEqual(raw);
    expect(parseTerminalSessionV2(terminalSession)).toBeUndefined();
  }
});

it("frozen I8 anchor exports no v1 schema/type decoder runtime", () => {
  expect(Object.keys(retired)).toEqual([]);
});
