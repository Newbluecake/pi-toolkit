import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { decodeAgentFrame, decodeHubFrame } from "../../../src/web-hub/protocol/messages.js";
import {
  XS_AGENT_CAPS,
  XS_ALIAS_AGENT_CAP,
  XS_ALIAS_HUB_CAP,
  XS_ALIAS_TAKE_PREVIEW,
  XS_HUB_CAP,
  XS_REQ_DEADLINE_MS,
  XsDeliverSchema,
  XsReqSchema,
  XsResSchema,
  XsStatusSchema,
  xsReqDeadlineMs,
} from "../../../src/web-hub/protocol/xs.js";
import { XS_ALIAS_MAX_BYTES, XS_ALIAS_TAKE_TOKEN_RE } from "../../../src/web-hub/protocol/xs-alias.js";
import * as legacy from "../../fixtures/legacy-xs-v071/src/web-hub/protocol/xs.js";

const SID = "01993f4e-6c9e-7ccf-9f0f-4f4a9c11a11a";
const SID2 = "01994410-3d3e-7ccf-8f1f-2b2c8d22b22b";
const origin = { sessionId: SID, epoch: 2 };
const req = { t: "xs_req", rid: "r1", op: "alias", origin };

describe("alias-plan AL0b: constants", () => {
  it("cap + deadline", () => {
    expect(XS_ALIAS_HUB_CAP).toBe("xs.alias.v1");
    expect(XS_ALIAS_AGENT_CAP).toBe("xs.alias.v1");
    expect(XS_REQ_DEADLINE_MS.alias).toBe(5_000);
    expect(xsReqDeadlineMs("alias")).toBe(5_000);
    expect(XS_ALIAS_TAKE_PREVIEW).toBe("preview");
  });
  it("frozen cap lists and legacy deadlines are untouched", () => {
    expect(XS_AGENT_CAPS).toEqual(["xs.v1"]);
    expect(XS_HUB_CAP).toBe("xs.v1");
    for (const op of ["list", "resolve", "info", "send"] as const) {
      expect(XS_REQ_DEADLINE_MS[op]).toBe(legacy.XS_REQ_DEADLINE_MS[op]);
    }
  });
});

describe("alias-plan AL0b: xs_req op alias", () => {
  it("accepts get / set / clear / take preview / take token", () => {
    for (const extra of [
      {},
      { alias: "前端" },
      { clear: true },
      { alias: "前端", take: XS_ALIAS_TAKE_PREVIEW },
      { alias: "前端", take: "k0123456789abcdef" },
    ]) {
      const f = { ...req, ...extra };
      expect(decodeAgentFrame(f)).toEqual(f);
    }
    expect(XS_ALIAS_TAKE_TOKEN_RE.test("k0123456789abcdef")).toBe(true);
  });
  it("rejects malformed alias fields (silent drop on the agent decoder)", () => {
    expect(decodeAgentFrame({ ...req, clear: false })).toBeUndefined();
    expect(decodeAgentFrame({ ...req, alias: "" })).toBeUndefined();
    expect(decodeAgentFrame({ ...req, alias: "x".repeat(129) })).toBeUndefined();
    expect(decodeAgentFrame({ ...req, take: "k".repeat(65) })).toBeUndefined();
    expect(decodeAgentFrame({ ...req, alias: 5 })).toBeUndefined();
    expect(decodeAgentFrame({ ...req, bogus: 1 })).toBeUndefined();
  });
  it("a legacy decoder (v0.7.1 schema) rejects the alias op and fields — hence cap-gating", () => {
    expect(Value.Check(legacy.XsReqSchema, req)).toBe(false);
    expect(Value.Check(legacy.XsReqSchema, { ...req, op: "list", alias: "a" })).toBe(false);
  });
  it("old frame shapes are unchanged", () => {
    const old = { t: "xs_req", rid: "r2", op: "send", origin, to: SID2, text: "hi" };
    expect(Value.Check(XsReqSchema, old)).toBe(true);
    expect(Value.Check(legacy.XsReqSchema, old)).toBe(true);
  });
});

describe("alias-plan AL0b: xs_res.alias / rows / candidates / target", () => {
  const base = { t: "xs_res", rid: "r1", ok: true };
  it("alias bodies (state, lost, take preview) decode", () => {
    const bodies = [
      { state: "none" },
      { alias: "前端", state: "held" },
      { state: "none", lost: { alias: "前端", reason: "taken", at: 1 } },
      { take: { cwdLabel: "~/ai/foo", offlineForS: 3600, token: "k0123456789abcdef", expiresAt: 5 } },
    ];
    for (const alias of bodies) {
      const f = { ...base, alias };
      expect(decodeHubFrame(f)).toEqual(f);
    }
  });
  it("rows/candidates/target accept an optional alias (open objects) and error codes pass through", () => {
    const f = {
      ...base,
      rows: [{ ref: "a", alias: "前端", cwdLabel: "~" }],
      candidates: [{ ref: "a", alias: "web" }],
      target: { ref: "a", alias: "web", sessionId: SID },
    };
    expect(decodeHubFrame(f)).toEqual(f);
    for (const code of [
      "E_XS_ALIAS_INVALID{reserved}",
      "E_XS_ALIAS_TAKEN{confusable}",
      "E_XS_ALIAS_TAKE{recent}",
      "E_XS_ALIAS_FULL",
      "E_XS_ALIAS_BUSY{queue}",
      "E_XS_ALIAS_UNKNOWN",
      "E_XS_ALIAS_UNAVAILABLE",
    ]) {
      const e = { t: "xs_res", rid: "r1", ok: false, code };
      expect(Value.Check(XsResSchema, e)).toBe(true);
    }
    expect(Value.Check(legacy.XsResSchema, { ...base, alias: { state: "none" } })).toBe(false);
  });
});

describe("alias-plan AL0b: xs_deliver.from.alias (independent field)", () => {
  const deliver = {
    t: "xs_deliver",
    rid: "d1",
    xid: "x1",
    to: { sessionId: SID2, epoch: 1 },
    from: { sessionId: SID, ref: "r", name: "n", cwdLabel: "~", agentId: "a" },
    text: "hi",
    wake: false,
    expiresAt: 10,
  };
  it("optional, ≤48, non-empty; absent keeps the legacy shape", () => {
    expect(decodeHubFrame(deliver)).toEqual(deliver);
    const withAlias = { ...deliver, from: { ...deliver.from, alias: "前端" } };
    expect(decodeHubFrame(withAlias)).toEqual(withAlias);
    expect(Value.Check(XsDeliverSchema, { ...deliver, from: { ...deliver.from, alias: "" } })).toBe(false);
    expect(
      Value.Check(XsDeliverSchema, {
        ...deliver,
        from: { ...deliver.from, alias: "a".repeat(XS_ALIAS_MAX_BYTES + 1) },
      }),
    ).toBe(false);
    expect(
      Value.Check(XsDeliverSchema, { ...deliver, from: { ...deliver.from, alias: "a".repeat(XS_ALIAS_MAX_BYTES) } }),
    ).toBe(true);
    expect(Value.Check(legacy.XsDeliverSchema, withAlias)).toBe(false);
  });
});

describe("alias-plan AL0b: StatusInfo.xs.alias", () => {
  const st = { joined: true, receive: "wake", blocked: 0 };
  it("optional bounded string", () => {
    expect(Value.Check(XsStatusSchema, st)).toBe(true);
    expect(Value.Check(XsStatusSchema, { ...st, alias: "前端" })).toBe(true);
    expect(Value.Check(XsStatusSchema, { ...st, alias: "" })).toBe(false);
    expect(Value.Check(XsStatusSchema, { ...st, alias: "a".repeat(49) })).toBe(false);
    expect(Value.Check(legacy.XsStatusSchema, { ...st, alias: "x" })).toBe(false);
  });
});
