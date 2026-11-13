import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  TerminalConnectionEventSchema,
  TerminalSseEventSchema,
  TERMINAL_HTTP_SCHEMAS,
  TERMINAL_HTTP_SUCCESS_SCHEMAS,
  TERMINAL_OP_ERROR_CODES,
} from "../../../src/web-hub/protocol/terminal.js";
import { TERMINAL_UI_SCHEMAS } from "../../../src/web-hub/ui/src/components/terminal/protocol-schema.js";
import { terminalSchemaCheck } from "../../../src/web-hub/ui/src/components/terminal/schema-check.js";
const facts = {
  termId: "term",
  reservationId: "reservation",
  revision: 1,
  state: "live",
  nextInputSeq: 0,
  baseOffset: 0,
  nextOffset: 0,
  deadlines: { inputIdleAt: 70000, lifetimeAt: 90000, parentExpiresAt: 80000 },
};
const envelope = { agentKey: "agent", attachmentId: "attachment", connectionInstance: "instance" };
const event = { v: 1, sessionId: "session", epoch: "epoch", ownerInstance: "owner", termId: "term", revision: 1 };
const scope = {
  agentKey: "agent",
  expect: { sessionId: "session", epoch: "epoch" },
  clientId: "client",
  connectionInstance: "instance",
  connectionToken: "token",
};
function parity(schema: any, samples: unknown[]) {
  for (const value of samples)
    expect(terminalSchemaCheck(schema, value), JSON.stringify(value)).toBe(Value.Check(schema, value));
}
describe("browser JSON-only terminal contract projection", () => {
  it("is exactly the frozen shared schema, not a hand-maintained/widened contract", () => {
    expect(TERMINAL_UI_SCHEMAS).toEqual(
      JSON.parse(
        JSON.stringify({
          connection: TerminalConnectionEventSchema,
          event: TerminalSseEventSchema,
          requests: TERMINAL_HTTP_SCHEMAS,
          results: TERMINAL_HTTP_SUCCESS_SCHEMAS,
          errors: Object.fromEntries(
            (Object.keys(TERMINAL_HTTP_SCHEMAS) as Array<keyof typeof TERMINAL_HTTP_SCHEMAS>).map((op) => [
              op,
              TERMINAL_OP_ERROR_CODES[op],
            ]),
          ),
        }),
      ),
    );
  });
  it("agrees with the owner validator on all consumed request families and rejects unknown keys and malformed identity", () => {
    for (const [op, schema] of Object.entries(TERMINAL_HTTP_SCHEMAS)) {
      const fields =
        op === "prepare"
          ? { cols: 80, rows: 24 }
          : op === "attach"
            ? { cols: 80, rows: 24, termId: "term", attachId: "attach", tabId: "tab" }
            : op === "state"
              ? { target: { termId: "term" } }
              : op === "close"
                ? { termId: "term", closeId: "close", expectedRevision: 1 }
                : op === "list"
                  ? {}
                  : {
                      termId: "term",
                      attachmentId: "attachment",
                      writerLease: "lease",
                      ...(op === "input"
                        ? { inputSeq: 1, bytesB64: "YQ==", inputKind: "user", streamEpoch: "live" }
                        : op === "resize"
                          ? { resizeSeq: 1, cols: 80, rows: 24 }
                          : op === "ack"
                            ? { ack: { phase: "live", renderedThrough: 0 } }
                            : {}),
                    };
      const valid = { ...scope, ...fields };
      parity(schema, [
        valid,
        { ...valid, command: "forbidden" },
        { ...valid, connectionToken: null },
        { ...valid, expect: { sessionId: "session", epoch: 2 } },
        null,
        [],
        {},
        "bad",
      ]);
    }
  });
  it("agrees on SSE unions, optional metadata, safe integers/base64 and closed result objects", () => {
    const output = {
      ...envelope,
      event: { ...event, kind: "output", offset: 0, bytesB64: "5Lit", streamEpoch: "live" },
    };
    parity(TerminalSseEventSchema, [
      output,
      { ...output, extra: true },
      { ...output, event: { ...output.event, offset: Number.MAX_SAFE_INTEGER + 1 } },
      { ...output, event: { ...output.event, bytesB64: "bad!" } },
      {
        ...output,
        event: {
          ...event,
          kind: "replay_begin",
          attemptId: "attempt",
          replayEpoch: "replay",
          S: 0,
          N0: 10,
          deadlineAt: 13000,
        },
      },
      {
        ...output,
        event: {
          ...event,
          kind: "cutover",
          attemptId: "attempt",
          newLiveEpoch: "live",
          replayEnd: 0,
          liveFrom: 10,
          gap: { from: 0, to: 10 },
          resetParser: true,
        },
      },
    ]);
    const valid = {
      ok: true,
      ...facts,
      attachmentId: "attachment",
      writerLease: "lease",
      replayMode: "cold",
      sessionOrdinal: 1,
      createdAt: 0,
      ownerLabel: "<owner>",
      userLabel: "user",
      hostLabel: "host",
      cwd: "/",
      shellName: "bash",
    };
    parity(TERMINAL_HTTP_SUCCESS_SCHEMAS.attach, [
      valid,
      { ...valid, cwd: "../bad" },
      { ...valid, userLabel: "user\nsecret" },
      { ...valid, ownerLabel: "x".repeat(129) },
      { ...valid, inputSeq: 1 },
      { ...valid, sessionOrdinal: 0 },
      { ...valid, writerPresent: false },
    ]);
    parity(TERMINAL_HTTP_SUCCESS_SCHEMAS.list, [
      { ok: true, revision: 1, rows: [facts] },
      { ok: true, revision: 1, rows: [{ ...facts, cwd: "/forbidden-in-list" }] },
      { ok: true, revision: 1, rows: Array.from({ length: 33 }, () => facts) },
    ]);
  });
  it("fails closed on unsupported schema keywords and arbitrary schema extensions", () => {
    expect(terminalSchemaCheck({ type: "string", format: "new-format" }, "x")).toBe(false);
    expect(terminalSchemaCheck({ anyOf: [{ type: "string" }], maxLength: 0 }, "x")).toBe(false);
    expect(terminalSchemaCheck({ type: "object", properties: {}, required: [] }, {})).toBe(false);
  });
});
