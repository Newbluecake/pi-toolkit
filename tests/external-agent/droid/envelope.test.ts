import { describe, expect, it } from "vitest";
import {
  DROID_API_VERSION,
  DROID_AUTO_REJECT_PERMISSIONS,
  DROID_AUTONOMY_FULL,
  DROID_CHILD_ENV,
  DROID_CUMULATIVE_INCLUDES_CHILD,
  DROID_EXITS_ON_STDIN_EOF,
  DROID_PERMISSION_ACK_TIMEOUT_MS,
  DROID_PERMISSION_REPLY,
  DROID_PROTOCOL_VERSION,
  DROID_TESTED_VERSIONS,
  DROID_THINKING_IN_OUTPUT,
} from "../../../src/external-agent/droid/protocol.js";
import { createDroidEnvelope } from "../../../src/external-agent/droid/envelope.js";

describe("droid/protocol constants（plan §6.2 P3 冻结值）", () => {
  it("冻结取值", () => {
    expect(DROID_PROTOCOL_VERSION).toBe("1.264.0");
    expect(DROID_API_VERSION).toBe("1.0.0");
    expect(DROID_TESTED_VERSIONS).toEqual(["0.241.1"]);
    expect(DROID_AUTONOMY_FULL).toBe("high");
    expect(DROID_AUTO_REJECT_PERMISSIONS).toBe(false);
    expect(DROID_PERMISSION_REPLY).toEqual({ selectedOption: "proceed_once" });
    expect(DROID_PERMISSION_ACK_TIMEOUT_MS).toBe(10_000);
    expect(DROID_CHILD_ENV).toEqual({ DISABLE_AUTO_UPDATE: "1", FACTORYD_DISABLE_AUTO_UPDATE: "1" });
    expect(DROID_EXITS_ON_STDIN_EOF).toBe(true);
    expect(DROID_THINKING_IN_OUTPUT).toBe(true);
    expect(DROID_CUMULATIVE_INCLUDES_CHILD).toBe(false);
  });
});

describe("droid/envelope", () => {
  it("decorate：已有 type 保留 / 含 result 或 error ⇒ response / 否则 request", () => {
    const env = createDroidEnvelope();
    expect(env.decorate({ id: "1", method: "droid.initialize_session", params: {} })).toEqual({
      id: "1",
      method: "droid.initialize_session",
      params: {},
      type: "request",
      factoryApiVersion: "1.0.0",
      factoryProtocolVersion: "1.264.0",
    });
    expect(env.decorate({ id: "x", result: { selectedOption: "proceed_once" } }).type).toBe("response");
    expect(env.decorate({ id: "x", error: { code: -32601, message: "m" } }).type).toBe("response");
    expect(env.decorate({ id: "x", type: "notification", method: "m" }).type).toBe("notification");
  });

  it("check：版本相符 ok；不符/缺失 ⇒ drift；记录 lastSeen", () => {
    const env = createDroidEnvelope();
    expect(env.check({ factoryProtocolVersion: "1.264.0", factoryApiVersion: "1.0.0" })).toEqual({ ok: true });
    expect(env.lastSeenProtocolVersion()).toBe("1.264.0");
    expect(env.lastSeenApiVersion()).toBe("1.0.0");
    const drift = env.check({ factoryProtocolVersion: "9.9.9", factoryApiVersion: "1.0.0" });
    expect(drift).toEqual({ ok: false, drift: { expected: "1.264.0", actual: "9.9.9" } });
    expect(env.check({ factoryProtocolVersion: "1.264.0", factoryApiVersion: "2.0.0" })).toEqual({
      ok: false,
      drift: { expected: "1.0.0", actual: "2.0.0" },
    });
    expect(env.check({})).toEqual({ ok: false, drift: { expected: "1.264.0", actual: "<missing>" } });
  });

  it("check：id:null -32700（信封被拒）不是版本漂移（§4.2④，客户端另按协议致命 internal 处理）", () => {
    const env = createDroidEnvelope();
    expect(env.check({ id: null, error: { code: -32700, message: "Invalid JSON-RPC message" } })).toEqual({ ok: true });
    // 普通错误响应仍走版本比对
    expect(env.check({ id: "7", error: { code: -32602, message: "Unknown model: x" } })).toEqual({
      ok: false,
      drift: { expected: "1.264.0", actual: "<missing>" },
    });
  });
});
