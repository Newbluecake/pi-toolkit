import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  auditAdmin,
  auditControl,
  auditPreview,
  auditRemove,
  auditSpawn,
  auditUpload,
  createUploadHttpMetrics,
  PREVIEW_AUDIT_KEYS,
  REMOVE_AUDIT_KEYS,
  SPAWN_AUDIT_KEYS,
  uploadStatsFields,
  type SpawnAuditRecord,
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

// ---------------------------------------------------------------------------
// web-hub-spawn plan §SP9 (arch §6.6): the spawn audit channel
// ---------------------------------------------------------------------------

describe("auditSpawn (web-hub-spawn plan §SP9, arch §6.6)", () => {
  it("writes a single structured line tagged audit:spawn, preserving whitelisted fields", () => {
    const log = memLog();
    auditSpawn(log, {
      audit: "spawn",
      phase: "reject",
      endpoint: "spawn",
      reqId: "reqid-0000-aaaaaaaa",
      listener: "lan",
      ip: "10.0.0.9",
      user: "u3",
      code: "E_CONFIRM_REQUIRED",
      cwd: "/srv/real/proj",
      known: false,
      confirmed: false,
    });
    auditSpawn(log, {
      audit: "spawn",
      phase: "request",
      endpoint: "stop",
      spawnId: "stopme00-0000-0001",
      state: "stopping",
      limit: "global",
      active: 4,
      max: 4,
      firstPrompt: "pending",
      textLen: 128,
      attempts: 2,
    });
    expect(log.lines).toHaveLength(2);
    expect(log.lines[0]!.msg).toBe("spawn");
    expect(log.lines[0]!.data).toEqual({
      audit: "spawn",
      phase: "reject",
      endpoint: "spawn",
      reqId: "reqid-0000-aaaaaaaa",
      listener: "lan",
      ip: "10.0.0.9",
      user: "u3",
      code: "E_CONFIRM_REQUIRED",
      cwd: "/srv/real/proj",
      known: false,
      confirmed: false,
    });
    expect(log.lines[1]!.data).toMatchObject({
      phase: "request",
      endpoint: "stop",
      state: "stopping",
      limit: "global",
      active: 4,
      max: 4,
    });
  });

  it("runtime whitelist: any non-listed key is stripped even when passed (same discipline as UPLOAD_AUDIT_KEYS)", () => {
    const log = memLog();
    const rec: SpawnAuditRecord & { text?: string; stderr?: string; title?: string } = {
      audit: "spawn",
      phase: "state",
      spawnId: "s1",
      state: "failed",
      text: "FIRST PROMPT BODY",
      stderr: "some stderr blob",
      title: "Dialog Title",
    };
    auditSpawn(log, rec);
    const line = log.lines[0]!.data as Record<string, unknown>;
    expect(Object.keys(line).sort()).toEqual(["audit", "phase", "spawnId", "state"].sort());
    expect(line["text"]).toBeUndefined();
    expect(line["stderr"]).toBeUndefined();
    expect(line["title"]).toBeUndefined();
  });

  it("SPAWN_AUDIT_KEYS is exactly arch §6.6's field set — no text/stderr/title column exists", () => {
    expect(SPAWN_AUDIT_KEYS).toEqual([
      "phase",
      "endpoint",
      "reqId",
      "listener",
      "ip",
      "user",
      "spawnId",
      "cwd",
      "known",
      "confirmed",
      "dup",
      "pid",
      "state",
      "code",
      "endReason",
      "exitCode",
      "signal",
      "ms",
      "limit",
      "active",
      "max",
      "firstPrompt",
      "textLen",
      "attempts",
      "identity",
      "reaper",
      "model",
      "from",
      "to",
      // web-hub-spawn-restore plan §10.6
      "restore",
      "restoreFailure",
      "attempt",
    ]);
    // web-hub-spawn-restore §10.6: session coordinates are never audit columns
    expect(SPAWN_AUDIT_KEYS).not.toContain("sessionId");
    expect(SPAWN_AUDIT_KEYS).not.toContain("sessionFile");
    // negative (U7): neither the keys nor the audit source may carry raw text/stderr writers
    expect(SPAWN_AUDIT_KEYS).not.toContain("text");
    expect(SPAWN_AUDIT_KEYS.filter((k) => k.startsWith("stderr"))).toEqual([]);
    const src = readFileSync(new URL("../../../src/web-hub/hub/audit.ts", import.meta.url), "utf8");
    expect(src).not.toContain("firstPrompt.text");
    expect(src).not.toContain("stderrTail");
    const routesSrc = readFileSync(new URL("../../../src/web-hub/hub/spawn/routes.ts", import.meta.url), "utf8");
    expect(routesSrc).not.toContain("stderr"); // stderr never flows through the route layer at all
    expect(routesSrc).not.toMatch(/\btext:\s*intent\.firstPrompt\.text/); // only LENGTHS may be fed in
  });
});

describe("auditPreview (web-hub-preview plan v3 §4.5, PV3)", () => {
  it('writes the whitelisted key set under audit:"preview" and drops unknown keys', () => {
    const log = memLog();
    auditPreview(log, {
      phase: "request",
      listener: "lan",
      ip: "192.168.1.9",
      user: "u2",
      agentKey: "a1",
      cls: "upload",
      kind: "image",
      ok: true,
      verify: "joined",
      shared: true,
      bytes: 1024,
      total: 1024,
      truncated: false,
      ms: 12,
      ext: "png",
      pathTag: "abc123def456",
      // a deliberately smuggled extra field — must be dropped by the whitelist
      ...({ path: "/home/user/secret.png", content: "raw" } as unknown as Record<string, never>),
    } as never);
    expect(log.lines).toHaveLength(1);
    const line = log.lines[0]!;
    expect(line.msg).toBe("preview");
    const data = line.data as Record<string, unknown>;
    expect(data["audit"]).toBe("preview");
    expect(Object.keys(data).sort()).toEqual(
      [
        "audit",
        "phase",
        "listener",
        "ip",
        "user",
        "agentKey",
        "cls",
        "kind",
        "ok",
        "verify",
        "shared",
        "bytes",
        "total",
        "truncated",
        "ms",
        "ext",
        "pathTag",
      ].sort(),
    );
    expect(data["path"]).toBeUndefined();
    expect(data["content"]).toBeUndefined();
  });

  it("PREVIEW_AUDIT_KEYS carries no path/filename/content-bearing key (§4.5 永不记录路径原文)", () => {
    expect(PREVIEW_AUDIT_KEYS).not.toContain("path");
    expect(PREVIEW_AUDIT_KEYS).not.toContain("name");
    expect(PREVIEW_AUDIT_KEYS).not.toContain("safeName");
    expect(PREVIEW_AUDIT_KEYS).not.toContain("sha256");
    const src = readFileSync(new URL("../../../src/web-hub/hub/preview/routes.ts", import.meta.url), "utf8");
    // the routes only ever feed pathTag (HMAC-12) / ext into the audit accumulator
    expect(src).toMatch(/acc\.pathTag = pathTagOf\(path\)/);
    expect(src).not.toMatch(/acc\.(path|name|content)\b/);
  });
});

describe("auditRemove (web-hub-delete-session plan v2 §4.2, A13)", () => {
  it('writes the whitelisted key set under audit:"remove" and drops unknown keys', () => {
    const log = memLog();
    auditRemove(log, {
      phase: "request",
      listener: "loopback",
      ip: "127.0.0.1",
      user: "u1",
      agentKey: "a4242-abcdef",
      spawnId: "sp_0123456789abcdef",
      outcome: "removed",
      code: "E_AGENT_ONLINE",
      reason: "exit-unconfirmed",
      // a deliberately smuggled extra field — must be dropped by the whitelist
      ...({ cwd: "/home/user/project", text: "secret" } as unknown as Record<string, never>),
    } as never);
    expect(log.lines).toHaveLength(1);
    const line = log.lines[0]!;
    expect(line.msg).toBe("remove");
    const data = line.data as Record<string, unknown>;
    expect(data["audit"]).toBe("remove");
    expect(Object.keys(data).sort()).toEqual(
      ["audit", "phase", "listener", "ip", "user", "agentKey", "spawnId", "outcome", "code", "reason"].sort(),
    );
    expect(data["cwd"]).toBeUndefined();
    expect(data["text"]).toBeUndefined();
  });

  it("omits absent optional fields entirely (no null/undefined keys land in the log line)", () => {
    const log = memLog();
    auditRemove(log, { phase: "reject", listener: "lan", ip: "10.0.0.5", code: "E_CSRF" });
    const data = log.lines[0]!.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(["audit", "phase", "listener", "ip", "code"].sort());
  });

  it("REMOVE_AUDIT_KEYS never carries a prompt/text-bearing key (U7 discipline)", () => {
    expect(REMOVE_AUDIT_KEYS).not.toContain("cwd");
    expect(REMOVE_AUDIT_KEYS).not.toContain("text");
    expect(REMOVE_AUDIT_KEYS).not.toContain("textLen");
  });
});
