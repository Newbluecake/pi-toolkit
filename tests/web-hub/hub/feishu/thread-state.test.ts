import { afterEach, describe, expect, it } from "vitest";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { createFeishuState } from "../../../../src/web-hub/hub/feishu/state.js";
import { createFakeClock } from "../../../fixtures/feishu/fake-http.js";
import { systemFeishuClock } from "../../../../src/web-hub/hub/feishu/http.js";
import { OWNER } from "../../../fixtures/feishu/f6.js";

/**
 * fabric-thread §8.4 ② (T-state governance pin): P2 writes `accepted{thr:routed}` /
 * `replied{thread-*}` records through the SAME closed state vocabulary as before — no new
 * states, top-level keys, request keys or id shapes. The exported constants are pinned against
 * the pre-P2 literals (transcribed from the 2007d494 state.ts, which P2 never touched); the
 * PRIVATE REQUEST_KEYS/TOP_KEYS vocabularies are pinned behaviourally (unknown key ⇒ refused /
 * state-corrupt, exactly as before).
 */
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0).reverse()) await rm(d, { recursive: true, force: true });
});
async function freshState() {
  const dir = await mkdtemp(join(tmpdir(), "feishu-thr-pin-"));
  dirs.push(dir);
  const clock = createFakeClock(1_790_000_000_000);
  const state = createFeishuState({ dir, clock: { ...systemFeishuClock, now: clock.now } });
  await state.load();
  return { dir, clock, state };
}
const goodRequest = (id: string) => ({
  id,
  batchId: "b".repeat(64),
  state: "accepted",
  createdAt: 1,
  stateAt: 1,
  sessionId: "session-1",
  bindingKey: "grp:c1:t1",
  bindingRev: 1,
  senderOpenId: OWNER,
  senderDisplay: "Owner",
  chatLabel: "P",
  chatId: "c1",
  chatType: "group",
  threadId: "t1",
  triggerMessageId: "m1",
  textDigest: "d".repeat(64),
  payload: { body: "hello", messageIds: ["m1"], uploadIds: [] },
  code: "thr:routed",
  sourceCreatedAt: 1,
  installGen: 1,
  tenantKey: "tenant",
});

describe("T-state pin (§8.4②)", () => {
  it("REQUEST_STATES / REQUEST_TRANSITIONS / FEISHU_CMD_ID_RE are byte-identical to pre-P2", async () => {
    const stateMod = await import("../../../../src/web-hub/hub/feishu/state.js");
    expect([...stateMod.REQUEST_STATES]).toEqual([
      "received",
      "dispatching",
      "accepted",
      "rejected",
      "uncertain",
      "replied",
      "reply-failed",
      "unattributed",
      "revoked",
      "expired",
      "merged",
    ]);
    expect(stateMod.REQUEST_TRANSITIONS).toEqual({
      received: ["dispatching", "rejected", "revoked", "expired", "merged"],
      dispatching: ["accepted", "rejected", "uncertain"],
      accepted: ["replied", "reply-failed", "unattributed", "expired", "rejected"],
      uncertain: ["accepted", "rejected", "replied", "reply-failed", "unattributed", "expired"],
      rejected: [],
      replied: [],
      "reply-failed": [],
      unattributed: [],
      revoked: [],
      expired: [],
      merged: [],
    });
    const feishuMod = await import("../../../../src/web-hub/protocol/feishu.js");
    expect(feishuMod.FEISHU_CMD_ID_RE.source).toBe("^fs[A-Za-z0-9_-]{30}$");
  });

  it("a thr:routed record uses ONLY the pre-existing request-key vocabulary (① replay through parseState)", async () => {
    const { dir, clock } = await freshState();
    const seeded = createFeishuState({ dir, clock: { ...systemFeishuClock, now: clock.now } });
    await seeded.load();
    await seeded.adoptInstall({ appId: "cli_test", ownerOpenId: OWNER });
    seeded.tenant.pin("tenant");
    expect(seeded.requests.receive(goodRequest("fs" + "a".repeat(30))).ok).toBe(true);
    seeded.requests.transition("fs" + "a".repeat(30), "dispatching");
    seeded.requests.transition("fs" + "a".repeat(30), "accepted", { code: "thr:routed" });
    expect(await seeded.commit()).toBe(true);
    seeded.dispose();
    // The exact persisted shape — every key pre-exists P2 (no thread field, no new ids).
    const doc = JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as Record<string, unknown>;
    // Every persisted top-level key is inside the pre-P2 TOP_KEYS vocabulary (empty sections
    // are simply not written — `outbox` appears, `scheduleReceipts` does not).
    const allowed = new Set([
      "v",
      "appId",
      "tenantKey",
      "revSeq",
      "allowList",
      "dedup",
      "requests",
      "bindings",
      "dialogCards",
      "nonces",
      "approvals",
      "outbox",
      "scheduleReceipts",
      "undecodable",
    ]);
    for (const key of Object.keys(doc)) expect(allowed.has(key)).toBe(true);
    const reload = createFeishuState({ dir, clock: { ...systemFeishuClock, now: clock.now } });
    expect(await reload.load()).toMatchObject({ kind: "loaded" });
    expect(reload.requests.get("fs" + "a".repeat(30))).toMatchObject({
      state: "accepted",
      code: "thr:routed",
    });
    reload.dispose();
  });

  it("the closed vocabularies still refuse unknown keys (behavioural REQUEST_KEYS/TOP_KEYS pin)", async () => {
    const { dir, clock } = await freshState();
    const seeded = createFeishuState({ dir, clock: { ...systemFeishuClock, now: clock.now } });
    await seeded.load();
    await seeded.adoptInstall({ appId: "cli_test", ownerOpenId: OWNER });
    seeded.tenant.pin("tenant");
    expect(seeded.requests.receive(goodRequest("fs" + "b".repeat(30))).ok).toBe(true);
    expect(await seeded.commit()).toBe(true);
    seeded.dispose();
    const file = join(dir, "state.json");
    const doc = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    // Unknown REQUEST key ⇒ the whole file is refused by the (unmodified) parser (state-corrupt).
    const requests = doc["requests"] as Record<string, unknown>;
    requests["fs" + "b".repeat(30)] = { ...goodRequest("fs" + "b".repeat(30)), threadMeta: { h: "x" } };
    await writeFile(file, JSON.stringify(doc));
    let reload = createFeishuState({ dir, clock: { ...systemFeishuClock, now: clock.now } });
    const refused = await reload.load();
    expect(refused.kind).toBe("corrupt");
    reload.dispose();
    // Unknown TOP-LEVEL key ⇒ state-corrupt (unchanged refusal).
    const doc2 = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    delete doc2["requests"]["fs" + "b".repeat(30)]; // restore the parsable request first
    doc2["threads"] = {};
    await writeFile(file, JSON.stringify(doc2));
    reload = createFeishuState({ dir, clock: { ...systemFeishuClock, now: clock.now } });
    const outcome = await reload.load();
    expect(outcome.kind).toBe("corrupt");
    reload.dispose();
  });

  it("retention TTL math stays inside the clamped window params (§8.2 defensive re-clamp)", async () => {
    const { clampThreadWindowParams, THREAD_WINDOW_DEFAULTS } =
      await import("../../../../src/web-hub/protocol/thread.js");
    // The hub re-clamps the config with the same pure function: defaults pass unchanged.
    expect(clampThreadWindowParams(THREAD_WINDOW_DEFAULTS)).toEqual({ value: THREAD_WINDOW_DEFAULTS, changes: [] });
  });
});
