/**
 * web-hub-slash-args plan §8 (P0 protocol freeze): accept/reject parity for the frozen
 * surface — `CommandInfoSchema.args` (§3.1, append-only + cap-gated), the `complete_req` /
 * `complete_reply` frame pair (§4.1, closed schemas, routed through messages.ts's two
 * registries), the budget block, the cap constants (r1 评审 #2: NO PROTO bump) and the
 * browser-facing path constant (§4.2). Style follows messages-cmd.test.ts.
 */
import { describe, expect, it } from "vitest";
import { decodeAgentFrame, decodeHubFrame } from "../../../src/web-hub/protocol/messages.js";
import {
  CMD_ARGS_AGENT_CAPS,
  CMD_ARGS_HUB_CAP,
  CMD_ARGS_HUB_CAPS,
  PROTO,
} from "../../../src/web-hub/protocol/version.js";
import { CMD_ARGS, CMD_ARGS_REPLY_CODES, COMMAND_NAME_PATTERN } from "../../../src/web-hub/protocol/command-args.js";
import { COMMAND_COMPLETE_PATH } from "../../../src/web-hub/protocol/http-contract.js";

const commandsFrame = (item: Record<string, unknown>) => ({
  t: "commands",
  epoch: "e1",
  items: [{ name: "mem", kind: "extension", description: "memory", policy: "allow", ...item }],
});

describe("CommandInfoSchema.args (§3.1 append-only)", () => {
  it("accepts args with usage and/or complete", () => {
    for (const args of [
      { usage: "<name> [section]", complete: true },
      { usage: "x".repeat(CMD_ARGS.usageMaxChars) },
      { complete: true },
      {},
    ]) {
      expect(decodeAgentFrame(commandsFrame({ args }))).toMatchObject({ t: "commands" });
    }
  });
  it("keeps pre-feature frames (no args) byte-accepted", () => {
    expect(decodeAgentFrame(commandsFrame({}))).toEqual(commandsFrame({}));
  });
  it("rejects usage over the cap (r1 #3: 200), complete:false and unknown keys", () => {
    for (const args of [
      { usage: "x".repeat(CMD_ARGS.usageMaxChars + 1) },
      { complete: false },
      { complete: true, extra: 1 },
      { usage: "ok", hint: "nope" },
      "usage",
    ]) {
      expect(decodeAgentFrame(commandsFrame({ args }))).toBeUndefined();
    }
  });
});

describe("complete_req (hub→agent)", () => {
  const req = {
    t: "complete_req",
    rid: "req-1",
    name: "cache-ttl",
    prefix: "keepalive ",
    deadlineMs: 2000,
    origin: { listener: "loopback" },
  };
  it("round-trips a well-formed request (both listeners)", () => {
    expect(decodeHubFrame(req)).toEqual(req);
    expect(decodeHubFrame({ ...req, origin: { listener: "lan" } })).toMatchObject({
      origin: { listener: "lan" },
    });
  });
  it("rejects unknown fields, bad names, over-cap prefixes and extra origin keys", () => {
    for (const bad of [
      { ...req, extra: 1 },
      { ...req, name: "bad name!" },
      { ...req, name: "" },
      { ...req, prefix: "x".repeat(CMD_ARGS.prefixMaxBytes + 1) },
      // §4.1: origin is policy-only — carrying ip/user must NOT decode (never widens the wire)
      { ...req, origin: { listener: "loopback", ip: "10.0.0.1" } },
      { ...req, origin: "loopback" },
      { ...req, deadlineMs: "2000" },
    ]) {
      expect(decodeHubFrame(bad)).toBeUndefined();
    }
  });
});

describe("complete_reply (agent→hub)", () => {
  const item = (i: number) => ({ value: `arg${i}`, label: `L${i}`, description: `d${i}` });
  it("round-trips the ok branch, with/without truncated, confirm policy items", () => {
    const ok = {
      t: "complete_reply",
      rid: "req-1",
      ok: true,
      items: [item(1), { ...item(2), policy: "confirm" }],
      truncated: true,
      source: "own",
    };
    expect(decodeAgentFrame(ok)).toEqual(ok);
    expect(decodeAgentFrame({ t: "complete_reply", rid: "r", ok: true, items: [], source: "tui" })).toMatchObject({
      items: [],
      source: "tui",
    });
  });
  it("round-trips every frozen error code", () => {
    for (const code of CMD_ARGS_REPLY_CODES) {
      const err = { t: "complete_reply", rid: "r", ok: false, code, retryable: code === "E_RATE" };
      expect(decodeAgentFrame(err)).toEqual(err);
    }
  });
  it("rejects branch mixing, unknown codes, over-cap items and per-item overflows", () => {
    for (const bad of [
      { t: "complete_reply", rid: "r", ok: true, items: [], code: "E_RATE", source: "own" },
      { t: "complete_reply", rid: "r", ok: false, code: "E_NOPE", retryable: false },
      { t: "complete_reply", rid: "r", ok: false, code: "E_RATE" },
      {
        t: "complete_reply",
        rid: "r",
        ok: true,
        items: Array.from({ length: CMD_ARGS.itemMax + 1 }, (_, i) => item(i)),
        source: "own",
      },
      { t: "complete_reply", rid: "r", ok: true, items: [{ ...item(1), policy: "deny" }], source: "own" },
      {
        t: "complete_reply",
        rid: "r",
        ok: true,
        items: [{ ...item(1), label: "y".repeat(CMD_ARGS.itemLabelMaxChars + 1) }],
        source: "own",
      },
      {
        t: "complete_reply",
        rid: "r",
        ok: true,
        items: [{ ...item(1), description: "d".repeat(CMD_ARGS.itemDescMaxChars + 1) }],
        source: "own",
      },
      {
        t: "complete_reply",
        rid: "r",
        ok: true,
        items: [{ ...item(1), value: "v".repeat(CMD_ARGS.itemValueMaxBytes + 1) }],
        source: "own",
      },
      { t: "complete_reply", rid: "r", ok: true, items: [], truncated: false, source: "own" },
      { t: "complete_reply", rid: "r", ok: true, items: [], source: "both" },
    ]) {
      expect(decodeAgentFrame(bad), JSON.stringify(bad).slice(0, 80)).toBeUndefined();
    }
  });
});

describe("P0 frozen constants (§4.1/§4.2)", () => {
  it("caps are cmd.args.v1 on both surfaces, and PROTO is NOT bumped (r1 评审 #2)", () => {
    expect(CMD_ARGS_HUB_CAP).toBe("cmd.args.v1");
    expect([...CMD_ARGS_HUB_CAPS]).toEqual(["cmd.args.v1"]);
    expect([...CMD_ARGS_AGENT_CAPS]).toEqual(["cmd.args.v1"]);
    expect(PROTO).toEqual({ major: 1, minor: 2 });
  });
  it("budget block pins the plan §4/§6 numbers", () => {
    expect(CMD_ARGS.usageMaxChars).toBe(200); // r1 #3
    expect(CMD_ARGS.prefixMaxBytes).toBe(1024);
    expect(CMD_ARGS.itemMax).toBe(50);
    expect(CMD_ARGS.itemValueMaxBytes).toBe(512);
    expect(CMD_ARGS.itemLabelMaxChars).toBe(120);
    expect(CMD_ARGS.itemDescMaxChars).toBe(200);
    expect(CMD_ARGS.itemsTotalMaxBytes).toBe(16 * 1024);
    expect(CMD_ARGS.routeDeadlineMs).toBe(4000);
    expect(CMD_ARGS.frameDeadlineMaxMs).toBe(2000);
    expect(CMD_ARGS.deadlineMarginMs).toBe(300);
    expect(CMD_ARGS.ackSlackMs).toBe(500);
    expect(CMD_ARGS.agentCallTimeoutMs).toBe(1500);
    expect(CMD_ARGS.agentInflightMax).toBe(2);
    expect(CMD_ARGS.hubRate).toEqual({
      cprePerSecond: 20,
      completeCapacity: 8,
      completeRefillMs: 200,
      lanIpPer2s: 20,
      agentPerSecond: 15,
    });
    expect(CMD_ARGS.hubInflight).toEqual({ globalMax: 8, perPrincipalMax: 3 });
    expect(CMD_ARGS.clientTimeoutMs).toBe(3000);
    expect(CMD_ARGS.debounceMs).toBe(150);
    expect(CMD_ARGS.cacheTtlMs).toBe(30_000);
    expect(CMD_ARGS.cacheMax).toBe(64);
  });
  it("COMMAND_NAME_PATTERN mirrors hub COMMAND_NAME_RE (accept/reject spot checks)", () => {
    const re = new RegExp(COMMAND_NAME_PATTERN);
    for (const ok of ["mem", "cache-ttl", "webhub", "task:watch", "a.b_c-d", "x".repeat(64)]) {
      expect(re.test(ok), ok).toBe(true);
    }
    for (const bad of ["", "bad name!", "/mem", "x".repeat(65), "tab\tkey"]) {
      expect(re.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });
  it("browser path is /api/command/complete", () => {
    expect(COMMAND_COMPLETE_PATH).toBe("/api/command/complete");
  });
});
