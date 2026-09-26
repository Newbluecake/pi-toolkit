import { describe, expect, it } from "vitest";
import { decodeAgentFrame, decodeHubFrame } from "../../../src/web-hub/protocol/messages.js";

describe("lan_req / hub_ctl (agent→hub) round-trip and rejection (plan §8.1)", () => {
  it("lan_req info round-trips", () => {
    const frame = { t: "lan_req", rid: "r1", op: "info" };
    expect(decodeAgentFrame(frame)).toEqual(frame);
  });

  it("lan_req passwd round-trips", () => {
    const frame = { t: "lan_req", rid: "r2", op: "passwd", username: "alice", password: "s3cret-s3cret" };
    expect(decodeAgentFrame(frame)).toEqual(frame);
  });

  it("lan_req unlock round-trips", () => {
    const frame = { t: "lan_req", rid: "r3", op: "unlock" };
    expect(decodeAgentFrame(frame)).toEqual(frame);
  });

  it("lan_req with an unknown op is rejected", () => {
    expect(decodeAgentFrame({ t: "lan_req", rid: "r4", op: "bogus" })).toBeUndefined();
  });

  it("lan_req missing rid is rejected", () => {
    expect(decodeAgentFrame({ t: "lan_req", op: "info" })).toBeUndefined();
  });

  it("hub_ctl shutdown round-trips", () => {
    const frame = { t: "hub_ctl", rid: "r5", op: "shutdown", reason: "restart" };
    expect(decodeAgentFrame(frame)).toEqual(frame);
  });

  it("hub_ctl with a non-restart reason is rejected", () => {
    expect(decodeAgentFrame({ t: "hub_ctl", rid: "r6", op: "shutdown", reason: "bogus" })).toBeUndefined();
  });

  // 审查修复 #4: lan_req 改为按变体拆分的严格判别联合。
  it("lan_req passwd missing username is rejected", () => {
    expect(decodeAgentFrame({ t: "lan_req", rid: "r7", op: "passwd", password: "s3cret-s3cret" })).toBeUndefined();
  });

  it("lan_req passwd missing password is rejected", () => {
    expect(decodeAgentFrame({ t: "lan_req", rid: "r8", op: "passwd", username: "alice" })).toBeUndefined();
  });

  it("lan_req info/unlock carrying username/password is rejected (not just ignored)", () => {
    expect(decodeAgentFrame({ t: "lan_req", rid: "r9", op: "info", username: "alice" })).toBeUndefined();
    expect(
      decodeAgentFrame({ t: "lan_req", rid: "r10", op: "unlock", username: "alice", password: "x" }),
    ).toBeUndefined();
  });

  it("lan_req with an extra unknown field on any variant is rejected", () => {
    expect(decodeAgentFrame({ t: "lan_req", rid: "r11", op: "info", extra: 1 })).toBeUndefined();
    expect(
      decodeAgentFrame({ t: "lan_req", rid: "r12", op: "passwd", username: "a", password: "b", extra: 1 }),
    ).toBeUndefined();
    expect(decodeAgentFrame({ t: "lan_req", rid: "r13", op: "unlock", extra: 1 })).toBeUndefined();
  });

  it("hub_ctl with an extra unknown field is rejected", () => {
    expect(decodeAgentFrame({ t: "hub_ctl", rid: "r14", op: "shutdown", reason: "restart", extra: 1 })).toBeUndefined();
  });
});

describe("lan_res / hub_ctl_ack (hub→agent) round-trip and rejection", () => {
  it("lan_res ok:true without info round-trips", () => {
    const frame = { t: "lan_res", rid: "r1", ok: true };
    expect(decodeHubFrame(frame)).toEqual(frame);
  });

  it("lan_res ok:true with info round-trips", () => {
    const frame = {
      t: "lan_res",
      rid: "r2",
      ok: true,
      info: {
        username: "alice",
        initialPassword: "abcde-fghij",
        initialLogin: { ip: "192.168.1.10", at: 1700000000000 },
        lan: { state: "on", port: 7879, hosts: ["192.168.1.5"], omitted: [], warnings: [] },
      },
    };
    expect(decodeHubFrame(frame)).toEqual(frame);
  });

  it("lan_res ok:false round-trips", () => {
    const frame = { t: "lan_res", rid: "r3", ok: false, code: "E_AUTH", message: "invalid credentials" };
    expect(decodeHubFrame(frame)).toEqual(frame);
  });

  it("lan_res missing ok is rejected", () => {
    expect(decodeHubFrame({ t: "lan_res", rid: "r4" })).toBeUndefined();
  });

  // 审查修复 #4: ok:true 与 ok:false{code,message} 互斥。
  it("lan_res ok:true carrying code/message (the ok:false shape) is rejected", () => {
    expect(decodeHubFrame({ t: "lan_res", rid: "r5a", ok: true, code: "E_AUTH", message: "x" })).toBeUndefined();
  });

  it("lan_res ok:false missing code is rejected", () => {
    expect(decodeHubFrame({ t: "lan_res", rid: "r5b", ok: false, message: "x" })).toBeUndefined();
  });

  it("lan_res ok:false missing message is rejected", () => {
    expect(decodeHubFrame({ t: "lan_res", rid: "r5c", ok: false, code: "E_AUTH" })).toBeUndefined();
  });

  it("lan_res ok:false carrying info (the ok:true shape) is rejected", () => {
    expect(
      decodeHubFrame({ t: "lan_res", rid: "r5d", ok: false, code: "E_AUTH", message: "x", info: { username: "a" } }),
    ).toBeUndefined();
  });

  it("lan_res with an extra unknown field on either variant is rejected", () => {
    expect(decodeHubFrame({ t: "lan_res", rid: "r5e", ok: true, extra: 1 })).toBeUndefined();
    expect(
      decodeHubFrame({ t: "lan_res", rid: "r5f", ok: false, code: "E_AUTH", message: "x", extra: 1 }),
    ).toBeUndefined();
  });

  it("lan_res info with an extra unknown field is rejected", () => {
    expect(decodeHubFrame({ t: "lan_res", rid: "r5g", ok: true, info: { username: "a", extra: 1 } })).toBeUndefined();
  });

  it("hub_ctl_ack round-trips", () => {
    const frame = { t: "hub_ctl_ack", rid: "r5" };
    expect(decodeHubFrame(frame)).toEqual(frame);
  });

  it("hub_ctl_ack missing rid is rejected", () => {
    expect(decodeHubFrame({ t: "hub_ctl_ack" })).toBeUndefined();
  });

  it("hub_ctl_ack with an extra unknown field is rejected", () => {
    expect(decodeHubFrame({ t: "hub_ctl_ack", rid: "r6", extra: 1 })).toBeUndefined();
  });
});

describe("hello_ack.caps? (plan §8.1, §11 v8 revision ⑤)", () => {
  it("hello_ack without caps round-trips (P1 shape, backward compatible)", () => {
    const frame = {
      t: "hello_ack",
      hubVersion: "9.9.9",
      buildId: "b1",
      proto: { major: 1, minor: 0 },
      agentKey: "a1-nonce",
      pingMs: 10_000,
      leaseMs: 30_000,
      http: { port: 7878 },
    };
    expect(decodeHubFrame(frame)).toEqual(frame);
  });

  it("hello_ack with caps round-trips", () => {
    const frame = {
      t: "hello_ack",
      hubVersion: "9.9.9",
      buildId: "b1",
      proto: { major: 1, minor: 0 },
      agentKey: "a1-nonce",
      pingMs: 10_000,
      leaseMs: 30_000,
      http: { port: 7878 },
      caps: ["ctl.v1", "lan.v1"],
    };
    expect(decodeHubFrame(frame)).toEqual(frame);
  });
});
