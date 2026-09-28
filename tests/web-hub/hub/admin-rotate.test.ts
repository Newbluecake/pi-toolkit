// plan §6.7.1 — handleRotateToken 完整序列 + recoverRotateIntent 崩溃注入矩阵（C8）。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAdminHandler, recoverRotateIntent, type AdminDeps } from "../../../src/web-hub/hub/admin.js";
import {
  newRotateIntentId,
  readRotateIntentSync,
  writeRotateIntentSync,
  type RotateIntent,
} from "../../../src/web-hub/protocol/rotate-intent.js";
import { readTokenFile, replaceTokenAtomic } from "../../../src/web-hub/protocol/token-file.js";
import type { Auth } from "../../../src/web-hub/hub/auth.js";
import type { HubLog } from "../../../src/web-hub/hub/ports.js";

let dir: string;
let tokenFile: string;
let rotateIntentFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "admin-rotate-"));
  tokenFile = join(dir, "token");
  rotateIntentFile = join(dir, "rotate.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeLog(): HubLog {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function fakeAuth(over: Partial<Auth> = {}): Auth {
  return {
    token: () => "initial-token",
    reload: () => "initial-token",
    rotateToken: () => ({ token: "new-hot-token", revoked: 1 }),
    revokeAllSessions: () => 0,
    authGen: () => 1,
    login: async () => ({ ok: false, code: "E_NO_USER" }) as never,
    check: () => undefined as never,
    logout: () => {},
    ...over,
  };
}

function baseAdminDeps(calls: string[], over: Partial<AdminDeps> = {}): AdminDeps {
  return {
    log: fakeLog(),
    hasLan: () => true,
    store: () => undefined,
    kdf: () => undefined,
    limiter: () => undefined,
    lan: () => undefined,
    lanStatus: () => undefined,
    shutdown: () => {},
    auth: () => fakeAuth(),
    rotateIntentFile,
    revokeLanSessions: async () => {
      calls.push("revokeLanSessions");
      return 3;
    },
    revokeLoopbackSse: () => {
      calls.push("revokeLoopbackSse");
      return 2;
    },
    revokeLanSse: () => {
      calls.push("revokeLanSse");
      return 4;
    },
    bumpLanRevokeGen: () => {
      calls.push("bumpLanRevokeGen");
    },
    ...over,
  };
}

describe("handleRotateToken: online ①-⑤ sequence and call order", () => {
  it("writes intent → rotates token → advances intent → revokes everything → deletes intent → audits", async () => {
    const calls: string[] = [];
    const auth = fakeAuth({
      rotateToken: () => {
        calls.push("auth.rotateToken");
        return { token: "new-hot-token", revoked: 1 };
      },
    });
    const deps = baseAdminDeps(calls, { auth: () => auth });
    const handler = createAdminHandler(deps);

    const result = await handler.handleRotateToken({ agentKey: "a1" });

    expect(calls).toEqual([
      "auth.rotateToken",
      "revokeLoopbackSse",
      "revokeLanSessions",
      "revokeLanSse",
      "bumpLanRevokeGen",
    ]);
    expect(result).toEqual({ token: "new-hot-token", revoked: { loopback: 1, lan: 3 } });
    // The intent file must be gone after a clean run (step ⑤).
    expect(readRotateIntentSync(rotateIntentFile)).toEqual({ state: "absent" });
  });

  it("skips LAN revoke calls entirely when hasLan() is false", async () => {
    const calls: string[] = [];
    const deps = baseAdminDeps(calls, { hasLan: () => false });
    const handler = createAdminHandler(deps);
    const result = await handler.handleRotateToken({ agentKey: "a1" });
    expect(calls).toEqual(["revokeLoopbackSse"]);
    expect(result.revoked.lan).toBe(0);
  });

  it("writes the intent file before touching auth.rotateToken() (observable via a spying write)", async () => {
    const order: string[] = [];
    const deps = baseAdminDeps(order, {
      auth: () =>
        fakeAuth({
          rotateToken: () => {
            // By the time auth.rotateToken() runs, the intent must already be on disk.
            expect(readRotateIntentSync(rotateIntentFile).state).toBe("present");
            return { token: "new-hot-token", revoked: 1 };
          },
        }),
    });
    const handler = createAdminHandler(deps);
    await handler.handleRotateToken({ agentKey: "a1" });
  });
});

// ---------------------------------------------------------------------------
// Crash-injection matrix (plan §6.7.1's 5-row crash table): construct the on-disk state a crash
// at each point would leave behind, then assert recoverRotateIntent() finishes the job.
// ---------------------------------------------------------------------------

function recoveryDeps(calls: string[], over: Partial<Parameters<typeof recoverRotateIntent>[0]> = {}) {
  return {
    paths: { tokenFile, rotateIntentFile },
    log: fakeLog(),
    hasLan: true,
    revokeLan: async () => {
      calls.push("revokeLan");
      return 5;
    },
    ...over,
  };
}

describe("recoverRotateIntent: crash-injection matrix (plan §6.7.1)", () => {
  it("row 0 — crash before ① (no intent, old token): absent ⇒ not recovered, token untouched, zero fs writes", async () => {
    writeFileSync(tokenFile, "old-token\n", { mode: 0o600 });
    const calls: string[] = [];
    const outcome = await recoverRotateIntent(recoveryDeps(calls));
    expect(outcome).toEqual({ recovered: false });
    expect(calls).toEqual([]);
    expect(readTokenFile(tokenFile)).toBe("old-token");
  });

  it("row 1 — crash between ①-②: phase:intent + old token still on disk ⇒ token re-minted, LAN revoked once, intent deleted", async () => {
    writeFileSync(tokenFile, "old-token\n", { mode: 0o600 });
    const intent: RotateIntent = {
      v: 1,
      id: newRotateIntentId(),
      at: Date.now(),
      by: "hub",
      pid: 1234,
      phase: "intent",
    };
    writeRotateIntentSync(rotateIntentFile, intent);
    const calls: string[] = [];
    const outcome = await recoverRotateIntent(recoveryDeps(calls));
    expect(outcome).toEqual({ recovered: true, lanRevoked: 5 });
    expect(calls).toEqual(["revokeLan"]);
    expect(readTokenFile(tokenFile)).not.toBe("old-token");
    expect(readRotateIntentSync(rotateIntentFile)).toEqual({ state: "absent" });
  });

  it("row 2 — crash between ②-③: phase:intent + new token already written ⇒ token re-minted again (idempotent), LAN revoked once, intent deleted", async () => {
    replaceTokenAtomic(tokenFile, "already-new-token");
    const intent: RotateIntent = {
      v: 1,
      id: newRotateIntentId(),
      at: Date.now(),
      by: "hub",
      pid: 1234,
      phase: "intent",
    };
    writeRotateIntentSync(rotateIntentFile, intent);
    const calls: string[] = [];
    const outcome = await recoverRotateIntent(recoveryDeps(calls));
    expect(outcome).toEqual({ recovered: true, lanRevoked: 5 });
    expect(calls).toEqual(["revokeLan"]);
    // Token gets swapped again — recovery cannot tell phase:"intent" apart from "not yet swapped".
    expect(readTokenFile(tokenFile)).not.toBe("already-new-token");
    expect(readRotateIntentSync(rotateIntentFile)).toEqual({ state: "absent" });
  });

  it("row 3 — crash between ③-⑤: phase:token-written ⇒ token NOT re-minted, only ④→⑤ finish, LAN revoked once, intent deleted", async () => {
    replaceTokenAtomic(tokenFile, "final-token");
    const intent: RotateIntent = {
      v: 1,
      id: newRotateIntentId(),
      at: Date.now(),
      by: "hub",
      pid: 1234,
      phase: "token-written",
    };
    writeRotateIntentSync(rotateIntentFile, intent);
    const calls: string[] = [];
    const outcome = await recoverRotateIntent(recoveryDeps(calls));
    expect(outcome).toEqual({ recovered: true, lanRevoked: 5 });
    expect(calls).toEqual(["revokeLan"]);
    expect(readTokenFile(tokenFile)).toBe("final-token");
    expect(readRotateIntentSync(rotateIntentFile)).toEqual({ state: "absent" });
  });

  it("row 4 — intent file unreadable (E_PARSE) ⇒ treated fail-closed like phase:'intent': token re-minted, LAN revoked, intent deleted", async () => {
    writeFileSync(tokenFile, "old-token\n", { mode: 0o600 });
    writeFileSync(rotateIntentFile, "{not json", { mode: 0o600 });
    const calls: string[] = [];
    const outcome = await recoverRotateIntent(recoveryDeps(calls));
    expect(outcome).toEqual({ recovered: true, lanRevoked: 5 });
    expect(calls).toEqual(["revokeLan"]);
    expect(readTokenFile(tokenFile)).not.toBe("old-token");
    expect(readRotateIntentSync(rotateIntentFile)).toEqual({ state: "absent" });
  });

  it("LAN revoke throws ⇒ { recovered: true, lanBlocked: true }, intent file is retained (not deleted) for the next pass", async () => {
    const intent: RotateIntent = {
      v: 1,
      id: newRotateIntentId(),
      at: Date.now(),
      by: "hub",
      pid: 1234,
      phase: "intent",
    };
    writeRotateIntentSync(rotateIntentFile, intent);
    const calls: string[] = [];
    const outcome = await recoverRotateIntent(
      recoveryDeps(calls, {
        revokeLan: async () => {
          calls.push("revokeLan");
          throw new Error("lan db unavailable");
        },
      }),
    );
    expect(outcome).toEqual({ recovered: true, lanBlocked: true });
    expect(calls).toEqual(["revokeLan"]);
    expect(readRotateIntentSync(rotateIntentFile).state).toBe("present");
  });

  it("LAN revoke unavailable (revokeLan undefined) ⇒ { recovered: true, lanBlocked: true }, no revoke attempted, intent retained", async () => {
    const intent: RotateIntent = {
      v: 1,
      id: newRotateIntentId(),
      at: Date.now(),
      by: "hub",
      pid: 1234,
      phase: "intent",
    };
    writeRotateIntentSync(rotateIntentFile, intent);
    const calls: string[] = [];
    const outcome = await recoverRotateIntent(recoveryDeps(calls, { revokeLan: undefined }));
    expect(outcome).toEqual({ recovered: true, lanBlocked: true });
    expect(calls).toEqual([]);
    expect(readRotateIntentSync(rotateIntentFile).state).toBe("present");
  });

  it("hasLan:false ⇒ token completed then intent deleted directly, revokeLan is never called", async () => {
    const intent: RotateIntent = {
      v: 1,
      id: newRotateIntentId(),
      at: Date.now(),
      by: "hub",
      pid: 1234,
      phase: "intent",
    };
    writeRotateIntentSync(rotateIntentFile, intent);
    const calls: string[] = [];
    const outcome = await recoverRotateIntent(recoveryDeps(calls, { hasLan: false }));
    expect(outcome).toEqual({ recovered: true });
    expect(calls).toEqual([]);
    expect(readRotateIntentSync(rotateIntentFile)).toEqual({ state: "absent" });
  });

  it("absent ⇒ { recovered: false } and zero fs writes (token file untouched byte-for-byte)", async () => {
    writeFileSync(tokenFile, "untouched-token\n", { mode: 0o600 });
    const before = readFileSync(tokenFile);
    const calls: string[] = [];
    const outcome = await recoverRotateIntent(recoveryDeps(calls));
    expect(outcome).toEqual({ recovered: false });
    expect(calls).toEqual([]);
    expect(readFileSync(tokenFile)).toEqual(before);
  });
});
