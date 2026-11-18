import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import {
  TERMINAL_V2_HTTP_SCHEMAS,
  TERMINAL_V2_HTTP_SUCCESS_SCHEMAS,
  TERMINAL_V2_ERROR_STATUS,
  TerminalFailureV2Schema,
  TerminalViewFrameV2Schema,
} from "../../../src/web-hub/protocol/terminal-v2.js";
import {
  TERMINAL_V2_UI_SCHEMAS,
  terminalSchemaCheck,
} from "../../../src/web-hub/ui/src/components/terminal/protocol-v2.js";
const id = "A".repeat(22);
const scope = { agentKey: "agent", sessionId: "session", epoch: "epoch" };
const envelope = { scope, hubInstance: id },
  term = { ...envelope, termId: id },
  writer = { ...term, viewId: id };
const requests = {
  list: { scope },
  create: { ...envelope, requestId: id, mode: "new", cols: 80, rows: 24 },
  creation: { ...envelope, requestId: id },
  rename: { ...term, name: "工作😀" },
  close: term,
  view: { ...term, offset: 0 },
  input: { ...writer, seq: 0, bytesB64: "YQ==", kind: "terminal_response" },
  resize: { ...writer, seq: 0, cols: 80, rows: 24 },
  ack: { ...writer, offset: 0 },
};
const row = { termId: id, name: "bash", state: "live", createdAt: 0, ordinal: 1 };
const d = { used: 0, unknown: 0, limit: 2 };
const results = {
  list: {
    ok: true,
    hubInstance: id,
    revision: 0,
    rows: [row],
    unknownResources: [],
    quota: { session: d, principal: d, total: d },
  },
  create: { ok: true, requestId: id, termId: id, state: "starting" },
  creation: { ok: true, outcome: "unknown" },
  rename: { ok: true, row, revision: 1 },
  close: { ok: true, state: "closing", revision: 1 },
  input: { ok: true, acceptedThrough: 0 },
  resize: { ok: true, acceptedThrough: 0 },
  ack: { ok: true, offset: 0 },
};
function parity(schema: TSchema, projected: unknown, valid: object) {
  expect(Value.Check(schema, valid)).toBe(true); // prevent parity of two always-false validators
  expect(terminalSchemaCheck(projected, valid)).toBe(true);
  for (const sample of [valid, { ...valid, unexpected: true }, {}, null, [], "bad"])
    expect(terminalSchemaCheck(projected, sample), JSON.stringify(sample)).toBe(Value.Check(schema, sample));
  expect(terminalSchemaCheck(projected, { ...valid, unexpected: true })).toBe(false);
}
describe("T51 browser v2 JSON projection", () => {
  it("is byte-shape equivalent to authoritative schemas and fixed error table, not another protocol", () => {
    expect(TERMINAL_V2_UI_SCHEMAS).toEqual(
      JSON.parse(
        JSON.stringify({
          requests: TERMINAL_V2_HTTP_SCHEMAS,
          results: TERMINAL_V2_HTTP_SUCCESS_SCHEMAS,
          failure: TerminalFailureV2Schema,
          frame: TerminalViewFrameV2Schema,
          errorStatus: TERMINAL_V2_ERROR_STATUS,
        }),
      ),
    );
    expect("view" in TERMINAL_V2_UI_SCHEMAS.results).toBe(false); // NDJSON, never JSON success
  });
  it("agrees with TypeBox on all requests and JSON successes, including closed/nested objects", () => {
    for (const op of Object.keys(requests) as Array<keyof typeof requests>)
      parity(TERMINAL_V2_HTTP_SCHEMAS[op], TERMINAL_V2_UI_SCHEMAS.requests[op], requests[op]);
    for (const op of Object.keys(results) as Array<keyof typeof results>)
      parity(TERMINAL_V2_HTTP_SUCCESS_SCHEMAS[op], TERMINAL_V2_UI_SCHEMAS.results[op], results[op]);
    parity(TerminalFailureV2Schema, TERMINAL_V2_UI_SCHEMAS.failure, { ok: false, code: "E_DB", effect: "unknown" });
    expect(terminalSchemaCheck(TERMINAL_V2_UI_SCHEMAS.requests.list, { scope: { ...scope, cwd: "/secret" } })).toBe(
      false,
    );
  });
  it("projects query-only input as a separate branch and rejects every mixed write/query form", () => {
    const query = { ...writer, seq: 0, queryOnly: true };
    parity(TERMINAL_V2_HTTP_SCHEMAS.input, TERMINAL_V2_UI_SCHEMAS.requests.input, query);
    for (const raw of [
      { ...query, bytesB64: "" },
      { ...query, kind: "user" },
      { ...query, bytesB64: "YQ==", kind: "user" },
      { ...query, queryOnly: false },
      { ...query, queryOnly: "true" },
      { ...requests.input, queryOnly: true },
    ]) {
      expect(terminalSchemaCheck(TERMINAL_V2_UI_SCHEMAS.requests.input, raw)).toBe(false);
      expect(Value.Check(TERMINAL_V2_HTTP_SCHEMAS.input, raw)).toBe(false);
    }
    parity(TerminalFailureV2Schema, TERMINAL_V2_UI_SCHEMAS.failure, {
      ok: false,
      code: "E_INPUT_UNKNOWN",
      effect: "unknown",
    });
  });
  it("rejects E_INPUT_UNKNOWN with none in both validators and preserves every other error/effect pair", () => {
    const invalid = { ok: false, code: "E_INPUT_UNKNOWN", effect: "none" };
    expect(terminalSchemaCheck(TERMINAL_V2_UI_SCHEMAS.failure, invalid)).toBe(false);
    expect(Value.Check(TerminalFailureV2Schema, invalid)).toBe(false);
    parity(TerminalFailureV2Schema, TERMINAL_V2_UI_SCHEMAS.failure, { ...invalid, effect: "unknown" });
    for (const code of Object.keys(TERMINAL_V2_ERROR_STATUS)) {
      if (code === "E_INPUT_UNKNOWN") continue;
      for (const effect of ["none", "unknown"])
        parity(TerminalFailureV2Schema, TERMINAL_V2_UI_SCHEMAS.failure, { ok: false, code, effect });
    }
  });
  it("checks stream unions and leaves unknown schema extensions fail-closed", () => {
    parity(TerminalViewFrameV2Schema, TERMINAL_V2_UI_SCHEMAS.frame, {
      t: "attached",
      hubInstance: id,
      viewId: id,
      termId: id,
      start: 0,
      end: 0,
      metadata: { cwd: "/work", shellName: "bash", userLabel: "u", hostLabel: "h" },
    });
    parity(TerminalViewFrameV2Schema, TERMINAL_V2_UI_SCHEMAS.frame, { t: "output", offset: 0, bytesB64: "YQ==" });
    for (const raw of [
      { t: "output", offset: Number.MAX_SAFE_INTEGER + 1, bytesB64: "YQ==" },
      { t: "ping", clientId: id },
      { t: "error", code: "new-code" },
    ]) {
      expect(terminalSchemaCheck(TERMINAL_V2_UI_SCHEMAS.frame, raw)).toBe(false);
      expect(Value.Check(TerminalViewFrameV2Schema, raw)).toBe(false);
    }
    expect(terminalSchemaCheck({ ...TERMINAL_V2_UI_SCHEMAS.frame, unsupported: true }, { t: "ping" })).toBe(false);
    expect(terminalSchemaCheck({ type: "string", format: "new-format" }, "x")).toBe(false);
  });
});
