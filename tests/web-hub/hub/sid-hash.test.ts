/**
 * plan §6.4 "库中只存 sha256(sid)"; LC review fix (lan-plan.md §15.9 item 5 — the sid-hash
 * duplication finding): `hub/sid-hash.ts` is the single shared implementation `hub/lan-auth.ts`
 * (re-exported to `hub/http.ts`) and `hub/lan-store.ts` both now delegate to. `skipIf(!hasNodeSqlite)`
 * for the cross-module integration half (needs the real SQLite-backed store).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashSid } from "../../../src/web-hub/hub/sid-hash.js";
import { hashSid as hashSidFromLanAuth } from "../../../src/web-hub/hub/lan-auth.js";
import { createLanStore, type LanStore } from "../../../src/web-hub/hub/lan-store.js";
import { hasNodeSqlite } from "../../../src/web-hub/hub/db.js";
import { memLog } from "./helpers.js";

describe("hashSid (hub/sid-hash.ts, plan §6.4)", () => {
  it("is deterministic for the same input", () => {
    expect(hashSid("abc")).toBe(hashSid("abc"));
  });

  it("different inputs hash differently", () => {
    expect(hashSid("abc")).not.toBe(hashSid("abd"));
  });

  it("is base64url (no '+', '/', or '=' padding)", () => {
    const h = hashSid("some-raw-session-id-value");
    expect(h).not.toMatch(/[+/=]/);
  });

  it("hub/lan-auth.ts re-exports the exact same function (not a second implementation)", () => {
    expect(hashSidFromLanAuth).toBe(hashSid);
    expect(hashSidFromLanAuth("xyz")).toBe(hashSid("xyz"));
  });
});

const skipIfNoSqlite = (await hasNodeSqlite()) ? describe : describe.skip;

function tmp(): { dir: string; dbFile: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "wh-sid-hash-"));
  return { dir, dbFile: join(dir, "hub.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

skipIfNoSqlite("cross-module consistency: hub/lan-auth.ts's hashSid vs. lan-store.ts's internal hashing", () => {
  let dir: { dir: string; dbFile: string; cleanup: () => void };
  let store: LanStore;

  beforeEach(async () => {
    dir = tmp();
    const res = await createLanStore({ dbFile: dir.dbFile, log: memLog(), test: true });
    if (!res.ok) throw new Error(`createLanStore failed: ${res.reason} ${res.detail ?? ""}`);
    store = res.store;
  });

  afterEach(async () => {
    await store.close();
    dir.cleanup();
  });

  it("a session created by the store is found by touchSession keyed on hub/sid-hash.ts's hashSid(rawSid)", async () => {
    const now = Date.now();
    const session = await store.createSession({
      userId: 1,
      epoch: 1,
      boundOrigin: "http://192.168.1.1:7879",
      createdIp: "192.168.1.50",
      now,
    });
    // If lan-auth.ts/http.ts's hashSid and lan-store.ts's own internal hash ever diverged, this
    // lookup (the same one every LAN request performs on a cookie) would return undefined even
    // though the session genuinely exists.
    const rec = await store.touchSession(hashSid(session.sid), now);
    expect(rec).toEqual({
      userId: 1,
      epoch: 1,
      boundOrigin: "http://192.168.1.1:7879",
      expiresAt: expect.any(Number),
      absoluteExpiresAt: expect.any(Number),
    });
  });
});
