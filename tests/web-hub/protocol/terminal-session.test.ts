import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { decodeAgentFrame, type StatusInfo } from "../../../src/web-hub/protocol/messages.js";
import {
  parseTerminalSession,
  TerminalSessionSchema,
  TERMINAL_SESSION_MAX_BYTES,
  type TerminalSession,
} from "../../../src/web-hub/protocol/terminal-session.js";
import { parseTerminalPolicy } from "../../../src/web-hub/protocol/terminal-policy.js";
import {
  PROTO,
  P1_CAPS,
  P2_AGENT_CAPS,
  P2_HUB_CAPS,
  TERMINAL_SESSION_CAP,
} from "../../../src/web-hub/protocol/version.js";

const machine = parseTerminalPolicy({ webHub: { terminal: { enabled: true } } });
if (machine.state !== "enabled") throw new Error("fixture policy");
const valid: TerminalSession = {
  v: 1,
  enabled: true,
  sessionId: "session-1",
  epoch: "epoch_1",
  limits: machine.policy,
};

it("accepts a closed, bounded non-secret positive declaration with matching identity", () => {
  expect(Value.Check(TerminalSessionSchema, valid)).toBe(true);
  expect(parseTerminalSession(valid, { sessionId: valid.sessionId, epoch: valid.epoch })).toEqual(valid);
  expect(new TextEncoder().encode(JSON.stringify(valid)).byteLength).toBeLessThanOrEqual(TERMINAL_SESSION_MAX_BYTES);
  expect(Object.keys(valid)).toEqual(["v", "enabled", "sessionId", "epoch", "limits"]);
});
it("binds BOTH session and epoch; absence is not legacy permission", () => {
  expect(parseTerminalSession(valid, { sessionId: "other", epoch: valid.epoch })).toBeUndefined();
  expect(parseTerminalSession(valid, { sessionId: valid.sessionId, epoch: "other" })).toBeUndefined();
  expect(parseTerminalSession(undefined)).toBeUndefined();
});
const invalid = [
  null,
  [],
  {},
  { ...valid, v: 2 },
  { ...valid, enabled: false },
  { ...valid, sessionId: "" },
  { ...valid, epoch: "bad/path" },
  { ...valid, sessionId: "a".repeat(129) },
  { ...valid, limits: { ...valid.limits, maxTotal: 33 } },
  { ...valid, limits: { ...valid.limits, maxPerSession: 1.5 } },
  { ...valid, limits: { ...valid.limits, cwd: "/private" } },
  ...["cwd", "path", "nonce", "grant", "lease", "ownerCapability", "reason"].map((key) => ({
    ...valid,
    [key]: "secret",
  })),
  { ...valid, extra: "中".repeat(1024) },
];
describe("terminal read point is fail-closed while ordinary status remains open", () => {
  it.each(invalid)("invalid declaration %# never loses ordinary status", (terminalSession) => {
    expect(parseTerminalSession(terminalSession)).toBeUndefined();
    const raw = { t: "status", leafId: null, busy: false, pending: false, terminalSession };
    expect(decodeAgentFrame(raw)).toEqual(raw);
  });
  it("off bytes and a valid appended field round-trip without normalizing old keys", () => {
    const raw = { t: "status", leafId: null, busy: true, pending: false };
    expect(JSON.stringify(decodeAgentFrame(raw))).toBe(JSON.stringify(raw));
    const status: StatusInfo = { leafId: null, busy: false, pending: false, terminalSession: valid };
    expect(decodeAgentFrame({ t: "status", ...status })).toEqual({ t: "status", ...status });
  });
});
it("catches unserializable inputs and does not mutate the declaration", () => {
  const cyclic: Record<string, unknown> = { ...valid };
  cyclic.self = cyclic;
  expect(parseTerminalSession(cyclic)).toBeUndefined();
  expect(parseTerminalSession({ ...valid, v: 1n })).toBeUndefined();
  expect(parseTerminalSession(Object.freeze({ ...valid, limits: Object.freeze({ ...valid.limits }) }))).toEqual(valid);
});
it("new capability is browser-only and PROTO/existing negotiation arrays are unchanged", () => {
  expect(TERMINAL_SESSION_CAP).toBe("terminal.session.v1");
  expect(PROTO).toEqual({ major: 1, minor: 2 });
  expect(P1_CAPS).toEqual(["ev.v1", "fleet.v1", "snapshot.v1", "branch.v1"]);
  expect(P2_AGENT_CAPS).toEqual(["cmd.v1", "dialog.v1", "command.v1"]);
  expect(P2_HUB_CAPS).toEqual(["cmd.v1", "dialog.v1", "command.v1", "ctl.v2"]);
});
