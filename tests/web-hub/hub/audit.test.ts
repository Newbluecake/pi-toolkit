import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  auditAdmin,
  auditControl,
  auditUpload,
  createUploadHttpMetrics,
  uploadStatsFields,
  type UploadAuditRecord,
} from "../../../src/web-hub/hub/audit.js";
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

describe("auditUpload (web-hub-upload plan §5.4, #11/#17, U3)", () => {
  it("writes a single structured line tagged audit:upload with whitelisted fields preserved", () => {
    const log = memLog();
    auditUpload(log, {
      phase: "request",
      op: "commit",
      reqId: "r".repeat(16),
      listener: "lan",
      ip: "192.168.1.20",
      user: "u3",
      principal: "lan:u3",
      agentKey: "a1",
      uploadId: "u".repeat(24),
      bucket: "s-sess1",
      ok: true,
      bytes: 182344,
      chunks: 3,
      dupChunks: 1,
      ext: "png",
      mimeClass: "image",
      ms: 42,
    });
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toMatchObject({
      level: "info",
      msg: "upload",
      data: {
        audit: "upload",
        phase: "request",
        op: "commit",
        principal: "lan:u3", // store-side subject identity survives (plan-author-approved key)
        user: "u3",
        bytes: 182344,
        chunks: 3,
        dupChunks: 1,
        ext: "png",
        mimeClass: "image",
      },
    });
  });

  it("runtime whitelist: name/safeName/sha256/text/path/content and any other non-listed key are stripped even when passed", () => {
    const log = memLog();
    const record = {
      phase: "request",
      op: "begin",
      ok: true,
      bytes: 10,
      // non-whitelisted, must be dropped:
      name: "../../secret.png",
      safeName: "secret.png",
      sha256: "a".repeat(64),
      text: "prompt body must never be logged",
      path: "/home/u/.pi/agent/web-hub/uploads/s-x/y/secret.png",
      content: "file bytes",
      createdAt: 1790000000000, // arbitrary unknown key
    } as unknown as UploadAuditRecord;
    auditUpload(log, record);
    const data = log.lines[0]!.data as Record<string, unknown>;
    expect(data).toEqual({ audit: "upload", phase: "request", op: "begin", ok: true, bytes: 10 });
    const dump = JSON.stringify(log.lines);
    expect(dump).not.toContain("secret.png");
    expect(dump).not.toContain("prompt body");
    expect(dump).not.toContain("file bytes");
    expect(/\b[0-9a-f]{64}\b/.test(dump)).toBe(false); // no sha256-shaped token anywhere
  });

  it("covers every §5.4 phase/op and the reason vocabulary (incl. note:null placeholder)", () => {
    const log = memLog();
    const phases = ["request", "reject", "evict", "recover"] as const;
    const ops = ["begin", "chunk", "commit", "abort", "reference", "sweep"] as const;
    for (const phase of phases) for (const op of ops) auditUpload(log, { phase, op, ok: phase !== "reject" });
    auditUpload(log, {
      phase: "evict",
      op: "sweep",
      ok: true,
      reason: "ttl",
      referenced: true,
      ageS: 90000,
      note: null,
    });
    auditUpload(log, { phase: "recover", op: "sweep", ok: true, reason: "orphan-part" });
    auditUpload(log, { phase: "reject", op: "begin", ok: false, code: "E_UPLOAD_QUOTA", retryAfterS: 2 });
    expect(log.lines).toHaveLength(phases.length * ops.length + 3);
    expect(log.lines.every((l) => l.msg === "upload")).toBe(true);
    expect(log.lines.at(-3)).toMatchObject({
      data: { audit: "upload", reason: "ttl", referenced: true, ageS: 90000, note: null },
    });
    expect(log.lines.at(-1)).toMatchObject({ data: { code: "E_UPLOAD_QUOTA", retryAfterS: 2 } });
  });

  it("type-level: UploadAuditRecord has no field for raw name/sha256/text (compile-time whitelist)", () => {
    const log = memLog();
    // @ts-expect-error -- "safeName" is intentionally not part of the whitelisted record shape
    auditUpload(log, { phase: "request", op: "begin", ok: true, safeName: "x.png" });
  });

  it("uploadStatsFields renders the full §5.4 periodic aggregate row schema (store + HTTP-layer merge)", () => {
    const log = memLog();
    const fields = uploadStatsFields(
      {
        ready: true,
        disabled: false,
        disabledReason: null,
        scanning: false,
        closing: false,
        inflight: 2,
        inflightBytes: 4096,
        committedFiles: 7,
        committedBytes: 1_000_000,
        referencedFiles: 3,
        buckets: 2,
        rejectsByCode: { E_UPLOAD_QUOTA: 2, E_DEADLINE: 1 },
        p50Ms: 12,
        p95Ms: 840,
        counters: {
          requests: 30,
          rejects: 4,
          poisoned: 1,
          evicted: 2,
          dedupHits: 5,
          timeouts: 1,
          lateOps: 0,
          rateLimited: 3,
          maxRetryAfterS: 2,
        },
      },
      { rejectsByCode: { E_CSRF: 5, E_RATE: 9 }, rateLimited: 9, maxRetryAfterS: 3 },
    );
    log.info("upload stats", { audit: "upload-stats", ...fields });
    // §5.4 field table, one by one: active/inflightBytes/committedFiles/committedBytes/
    // referencedFiles/requests/rejects{per-code}/rateLimited/maxRetryAfterS/timeouts/poisoned/
    // evicted/p50Ms/p95Ms
    expect(log.lines[0]).toMatchObject({
      msg: "upload stats",
      data: {
        audit: "upload-stats",
        active: 2,
        inflightBytes: 4096,
        committedFiles: 7,
        committedBytes: 1_000_000,
        referencedFiles: 3,
        requests: 30,
        rejects: { E_UPLOAD_QUOTA: 2, E_DEADLINE: 1, E_CSRF: 5, E_RATE: 9 }, // store + HTTP merged
        rateLimited: 12, // 3 (store) + 9 (HTTP)
        maxRetryAfterS: 3,
        timeouts: 1,
        poisoned: 1,
        evicted: 2,
        dedupHits: 5,
        p50Ms: 12,
        p95Ms: 840,
      },
    });
  });

  it("createUploadHttpMetrics counts rejects by code and tracks rateLimited/maxRetryAfterS", () => {
    const m = createUploadHttpMetrics();
    m.reject("E_CSRF");
    m.reject("E_RATE", 1);
    m.reject("E_RATE", 4);
    m.reject("E_CSRF");
    expect(m.snapshot()).toEqual({
      rejectsByCode: { E_CSRF: 2, E_RATE: 2 },
      rateLimited: 2,
      maxRetryAfterS: 4,
    });
  });
});
