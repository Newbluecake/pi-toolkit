/** F1 §7.1: `scheduleReceipts` table — strict schema, backward-compatible, omitted when empty. */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FEISHU_SCHEDULE_RECEIPT_CAP,
  FEISHU_SCHEDULE_RECEIPT_TTL_MS,
  FEISHU_STATE_FILE,
  createFeishuState,
  type FeishuState,
} from "../../../../src/web-hub/hub/feishu/state.js";
import { FEISHU_ACK } from "../../../../src/web-hub/protocol/feishu.js";
import { createFakeClock, type FakeClock } from "../../../fixtures/feishu/fake-http.js";

let root: string;
let dir: string;
const open: FeishuState[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "feishu-sched-state-"));
  dir = join(root, "feishu-bot");
});
afterEach(async () => {
  const all = open.splice(0);
  for (const s of all) s.dispose();
  await Promise.all(all.map((s) => s.whenIdle()));
  rmSync(root, { recursive: true, force: true });
});
const rid = (n: number | string) => createHash("sha256").update(String(n)).digest("hex");
async function mk(clock: FakeClock = createFakeClock(1_760_000_000_000)) {
  const s = createFeishuState({ dir, clock });
  open.push(s);
  await s.load();
  return { s, clock };
}
async function durable(r: { s: FeishuState; clock: FakeClock }) {
  const p = r.s.commit();
  r.clock.advance(FEISHU_ACK.groupCommitMs);
  return p;
}
const file = () => JSON.parse(readFileSync(join(dir, FEISHU_STATE_FILE), "utf8")) as Record<string, unknown>;

describe("scheduleReceipts", () => {
  it("round-trips set/get/list through disk and a reload", async () => {
    const r = await mk();
    const set = r.s.scheduleReceipts.set(rid(1), { sid: "sess-a", state: "accepted" });
    expect(set.ok).toBe(true);
    const at = set.ok ? set.value.at : -1;
    expect(await durable(r)).toBe(true);
    expect(file()["scheduleReceipts"]).toEqual({ [rid(1)]: { sid: "sess-a", state: "accepted", at } });
    r.s.dispose();
    await r.s.whenIdle();
    const again = await mk(r.clock);
    expect(again.s.scheduleReceipts.get(rid(1))).toEqual({ sid: "sess-a", state: "accepted", at });
    expect(again.s.scheduleReceipts.list({ sid: "sess-a" })).toHaveLength(1);
    expect(again.s.scheduleReceipts.list({ sid: "other" })).toHaveLength(0);
  });

  it("the key is ABSENT from the file while the table is empty (feature-off byte identity)", async () => {
    const r = await mk();
    r.s.allowList.add("ou_owner0123456789");
    expect(await durable(r)).toBe(true);
    expect("scheduleReceipts" in file()).toBe(false);
  });

  it("an old state file without the key loads; unknown/ill-formed receipts mark the file corrupt", async () => {
    const r = await mk();
    r.s.allowList.add("ou_owner0123456789");
    expect(await durable(r)).toBe(true);
    r.s.dispose();
    await r.s.whenIdle();
    const bad = { ...file(), scheduleReceipts: { [rid(1)]: { sid: "s", state: "bogus", at: 1 } } };
    writeFileSync(join(dir, FEISHU_STATE_FILE), JSON.stringify(bad));
    const s2 = createFeishuState({ dir, clock: createFakeClock(1_760_000_000_000) });
    open.push(s2);
    expect((await s2.load()).kind).toBe("corrupt");
    const extra = { ...file(), scheduleReceipts: { [rid(1)]: { sid: "s", state: "sent", at: 1, junk: 1 } } };
    writeFileSync(join(dir, FEISHU_STATE_FILE), JSON.stringify(extra));
    const s3 = createFeishuState({ dir, clock: createFakeClock(1_760_000_000_000) });
    open.push(s3);
    expect((await s3.load()).kind).toBe("corrupt");
  });

  it("stamps `at` on every transition and validates input", async () => {
    const r = await mk();
    r.s.scheduleReceipts.set(rid(1), { sid: "s1", state: "accepted" });
    const t0 = r.clock.now();
    r.clock.advance(5_000);
    r.s.scheduleReceipts.set(rid(1), { sid: "s1", state: "refused", code: "budget" });
    expect(r.s.scheduleReceipts.get(rid(1))).toEqual({ sid: "s1", state: "refused", code: "budget", at: t0 + 5_000 });
    expect(r.s.scheduleReceipts.set("not-hex", { sid: "s1", state: "sent" })).toEqual({
      ok: false,
      refused: "invalid",
    });
    expect(r.s.scheduleReceipts.set(rid(2), { sid: "bad sid!", state: "sent" })).toEqual({
      ok: false,
      refused: "invalid",
    });
  });

  it("expires after 7 days and enforces the 4096 cap", async () => {
    const r = await mk();
    r.s.scheduleReceipts.set(rid("old"), { sid: "s", state: "sent" });
    r.clock.advance(FEISHU_SCHEDULE_RECEIPT_TTL_MS + 1);
    expect(r.s.sweep()).toBeGreaterThan(0);
    expect(r.s.scheduleReceipts.size).toBe(0);
    for (let i = 0; i < FEISHU_SCHEDULE_RECEIPT_CAP; i++) {
      const res = r.s.scheduleReceipts.set(rid(i), { sid: "s", state: "sent" });
      if (!res.ok) throw new Error(`refused at ${i}: ${res.refused}`);
    }
    expect(r.s.scheduleReceipts.set(rid("over"), { sid: "s", state: "sent" })).toEqual({ ok: false, refused: "cap" });
    // an update of an existing key is never refused by the cap
    expect(r.s.scheduleReceipts.set(rid(0), { sid: "s", state: "failed", code: "x" }).ok).toBe(true);
  });

  it("adoptInstall to a different app wipes receipts (open_ids / delivery are per app)", async () => {
    const r = await mk();
    const first = r.s.adoptInstall({ appId: "cli_a1b2c3d4e5f6", ownerOpenId: "ou_owner0123456789" });
    r.clock.advance(FEISHU_ACK.groupCommitMs);
    await first;
    r.s.scheduleReceipts.set(rid(1), { sid: "s", state: "sent" });
    expect(r.s.scheduleReceipts.size).toBe(1);
    const p = r.s.adoptInstall({ appId: "cli_other0123456", ownerOpenId: "ou_owner0123456789" });
    r.clock.advance(FEISHU_ACK.groupCommitMs);
    await p;
    expect(r.s.scheduleReceipts.size).toBe(0);
  });
});
