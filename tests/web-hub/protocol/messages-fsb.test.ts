// feishu-bot plan §9 (F0): `fsb_req` (agent→hub) / `fsb_res` (hub→agent) decode tables.
import { describe, expect, it } from "vitest";
import { decodeAgentFrame, decodeHubFrame } from "../../../src/web-hub/protocol/messages.js";
import { FSB_OPS } from "../../../src/web-hub/protocol/feishu.js";

const OPEN_ID = "ou_0123456789abcdef";

const REQS: Array<Record<string, unknown>> = [
  { t: "fsb_req", rid: "r1", op: "info" },
  { t: "fsb_req", rid: "r2", op: "setup_begin" },
  { t: "fsb_req", rid: "r3", op: "setup_begin", replace: true, confirm: true },
  { t: "fsb_req", rid: "r4", op: "setup_status" },
  { t: "fsb_req", rid: "r5", op: "setup_cancel" },
  { t: "fsb_req", rid: "r6", op: "allow", openId: OPEN_ID },
  { t: "fsb_req", rid: "r7", op: "deny", openId: OPEN_ID },
  { t: "fsb_req", rid: "r8", op: "repair", confirm: true },
  { t: "fsb_req", rid: "r9", op: "reset", confirm: true },
];

const INFO = {
  status: "open",
  gen: 3,
  uptimeMs: 1234,
  reconnects: 2,
  lastClose: { at: 1_700_000_000_000, reason: "liveness", code: 1006 },
  counters: { in: 10, dup: 1, dropped: { "bad-frame": 2 } },
  outbox: { ok: 5, failed: 0 },
  bindings: { total: 3, offline: 1, ambiguous: 0 },
  caps: { cards: "ok", reactions: "ok", files: "unknown", cardCallback: "denied" },
  keepalive: true,
  owner: "ou_…9f3c",
  allow: ["ou_…9f3c"],
};

describe("fsb_req (agent→hub)", () => {
  it("covers exactly the FSB_OPS vocabulary", () => {
    expect(REQS.map((r) => r.op).filter((op, i, a) => a.indexOf(op) === i)).toEqual([...FSB_OPS]);
  });

  it.each(REQS)("round-trips %o", (frame) => {
    expect(decodeAgentFrame(frame)).toEqual(frame);
  });

  it("is agent→hub only (the hub decoder ignores it)", () => {
    for (const frame of REQS) expect(decodeHubFrame(frame)).toBeUndefined();
  });

  it.each([
    ["unknown op", { t: "fsb_req", rid: "r", op: "bogus" }],
    ["missing rid", { t: "fsb_req", op: "info" }],
    ["empty rid", { t: "fsb_req", rid: "", op: "info" }],
    ["oversized rid", { t: "fsb_req", rid: "x".repeat(65), op: "info" }],
    ["info with params", { t: "fsb_req", rid: "r", op: "info", confirm: true }],
    ["extra key on setup_status", { t: "fsb_req", rid: "r", op: "setup_status", x: 1 }],
    ["allow without openId", { t: "fsb_req", rid: "r", op: "allow" }],
    ["allow with a non-open_id", { t: "fsb_req", rid: "r", op: "allow", openId: "alice" }],
    ["allow with a path-ish openId", { t: "fsb_req", rid: "r", op: "deny", openId: "ou_../etc" }],
    ["allow openId over 64 chars", { t: "fsb_req", rid: "r", op: "allow", openId: `ou_${"a".repeat(65)}` }],
    ["repair without confirm", { t: "fsb_req", rid: "r", op: "repair" }],
    ["reset with confirm:false", { t: "fsb_req", rid: "r", op: "reset", confirm: false }],
    ["setup_begin replace:false", { t: "fsb_req", rid: "r", op: "setup_begin", replace: false }],
    ["allow carrying confirm", { t: "fsb_req", rid: "r", op: "allow", openId: OPEN_ID, confirm: true }],
  ])("rejects %s", (_name, frame) => {
    expect(decodeAgentFrame(frame)).toBeUndefined();
  });
});

describe("fsb_res (hub→agent)", () => {
  const OK_FRAMES: Array<Record<string, unknown>> = [
    { t: "fsb_res", rid: "r", ok: true },
    { t: "fsb_res", rid: "r", ok: true, data: INFO },
    {
      t: "fsb_res",
      rid: "r",
      ok: true,
      data: {
        status: "unconfigured",
        gen: 0,
        reconnects: 0,
        counters: { in: 0, dup: 0, dropped: {} },
        outbox: { ok: 0, failed: 0 },
        bindings: { total: 0, offline: 0, ambiguous: 0 },
        caps: { cards: "unknown", reactions: "unknown", files: "unknown", cardCallback: "unknown" },
        keepalive: false,
        allow: [],
      },
    },
    {
      t: "fsb_res",
      rid: "r",
      ok: true,
      data: {
        phase: "pending",
        qrUrl: "https://open.feishu.cn/page/launcher?user_code=ABCD",
        expiresAt: 1_700_000_600_000,
      },
    },
    { t: "fsb_res", rid: "r", ok: true, data: { phase: "done" } },
    { t: "fsb_res", rid: "r", ok: true, data: { changed: true, count: 2 } },
    { t: "fsb_res", rid: "r", ok: false, code: "E_FSB_CAP", message: "allow-list full (32)" },
    { t: "fsb_res", rid: "r", ok: false, code: "E_FSB_SOMETHING_NEW", message: "forward compat" },
  ];

  it.each(OK_FRAMES)("round-trips %o", (frame) => {
    expect(decodeHubFrame(frame)).toEqual(frame);
  });

  it("is hub→agent only (the agent decoder ignores it)", () => {
    for (const frame of OK_FRAMES) expect(decodeAgentFrame(frame)).toBeUndefined();
  });

  it.each([
    ["ok:true carrying code", { t: "fsb_res", rid: "r", ok: true, code: "E_FSB_CAP" }],
    ["ok:false without message", { t: "fsb_res", rid: "r", ok: false, code: "E_FSB_CAP" }],
    ["ok:false with a non-E_FSB code", { t: "fsb_res", rid: "r", ok: false, code: "E_OTHER", message: "x" }],
    [
      "setup view with device_code (must never leave the hub)",
      { t: "fsb_res", rid: "r", ok: true, data: { phase: "pending", device_code: "secret" } },
    ],
    ["setup view with an unknown phase", { t: "fsb_res", rid: "r", ok: true, data: { phase: "weird" } }],
    ["info with a secret field", { t: "fsb_res", rid: "r", ok: true, data: { ...INFO, appSecret: "x" } }],
    ["info with an unknown status", { t: "fsb_res", rid: "r", ok: true, data: { ...INFO, status: "wat" } }],
    [
      "info with >32 allow entries",
      { t: "fsb_res", rid: "r", ok: true, data: { ...INFO, allow: Array.from({ length: 33 }, () => "x") } },
    ],
    ["info with a negative counter", { t: "fsb_res", rid: "r", ok: true, data: { ...INFO, reconnects: -1 } }],
    [
      "info with a bad capability state",
      { t: "fsb_res", rid: "r", ok: true, data: { ...INFO, caps: { ...INFO.caps, files: "maybe" } } },
    ],
    ["unknown data shape", { t: "fsb_res", rid: "r", ok: true, data: { hello: 1 } }],
  ])("rejects %s", (_name, frame) => {
    expect(decodeHubFrame(frame)).toBeUndefined();
  });
});
