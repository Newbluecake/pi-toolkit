import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { auditAdmin, auditControl } from "../../../src/web-hub/hub/audit.js";
import { memLog } from "./helpers.js";

describe("auditControl / auditAdmin (plan §6.4, U7)", () => {
  it("writes a single structured line tagged audit:control, preserving whitelisted fields", () => {
    const log = memLog();
    auditControl(log, {
      phase: "request",
      reqId: "r".repeat(16),
      id: "a".repeat(16),
      op: "prompt",
      listener: "loopback",
      ip: "127.0.0.1",
      agentKey: "a1",
      ok: true,
      textLen: 5,
    });
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toMatchObject({
      level: "info",
      data: { audit: "control", phase: "request", op: "prompt", ok: true, textLen: 5 },
    });
  });

  it("auditAdmin tags audit:admin", () => {
    const log = memLog();
    auditAdmin(log, { op: "rotate_token", ok: true });
    expect(log.lines[0]).toMatchObject({ data: { audit: "admin", op: "rotate_token", ok: true } });
  });

  it("negative: never logs message/steer/answer/args text, nor any hash of it (U7)", () => {
    const log = memLog();
    const secret = "the quick brown fox - this must never appear in hub.log";
    auditControl(log, {
      phase: "request",
      id: "a".repeat(16),
      op: "prompt",
      ok: true,
      textLen: Buffer.byteLength(secret, "utf8"), // only the length is ever recorded
    });
    auditControl(log, {
      phase: "request",
      id: "b".repeat(16),
      op: "command",
      ok: true,
      argsLen: 3,
      name: "compact",
    });
    const dump = JSON.stringify(log.lines);
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain("quick brown fox");
    const sha256hex = createHash("sha256").update(secret, "utf8").digest("hex");
    expect(dump).not.toContain(sha256hex);
    // no bare 64-hex-char token anywhere (a sha256 digest's shape) - catches any hash of any field
    expect(/\b[0-9a-f]{64}\b/i.test(dump)).toBe(false);
  });

  it("ControlAuditRecord has no field named for raw text/answers (type-level whitelist, not just a runtime check)", () => {
    const log = memLog();
    // @ts-expect-error -- "text" is intentionally not part of the whitelisted record shape
    auditControl(log, { phase: "request", ok: true, text: "nope" });
  });
});
