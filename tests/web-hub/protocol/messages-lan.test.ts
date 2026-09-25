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

  it("hub_ctl_ack round-trips", () => {
    const frame = { t: "hub_ctl_ack", rid: "r5" };
    expect(decodeHubFrame(frame)).toEqual(frame);
  });

  it("hub_ctl_ack missing rid is rejected", () => {
    expect(decodeHubFrame({ t: "hub_ctl_ack" })).toBeUndefined();
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
