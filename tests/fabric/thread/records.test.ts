import { describe, expect, it } from "vitest";
import { EventRecordTable, THREAD_EVENT_RECORDS_MAX } from "../../../src/fabric/thread/records.js";

const H = "fs:handle00001";
const HOUR = 3_600_000;

function makeJudgedNone(table: EventRecordTable, id: string, now: number) {
  const r = table.insert(id, H, now, now + 4000, now);
  if (!r) throw new Error("insert failed");
  r.perSub.set("s1", "none");
  // EventRecordTable.refreshJudged is static — outcomes set directly here mirror the engine
  expect(EventRecordTable.refreshJudged(r)).toBe(true);
  return r;
}

describe("EventRecordTable (§6.5 dedup / §6.7 retention ≤64)", () => {
  it("insert creates the dedup slot; a duplicate id is refused", () => {
    const table = new EventRecordTable();
    const r = table.insert("ev1", H, 0, 4000, 0);
    expect(r?.eventId).toBe("ev1");
    expect(r?.receivedAt).toBe(0);
    expect(r?.deadlineAt).toBe(4000);
    expect(r?.judged).toBe(false);
    expect(table.has("ev1")).toBe(true);
    expect(table.insert("ev1", H, 1, 5000, 1)).toBeUndefined();
    expect(table.size).toBe(1);
  });

  it("fills to 64; full with nothing evictable ⇒ canInsert false (new events go R5)", () => {
    const table = new EventRecordTable();
    for (let i = 0; i < THREAD_EVENT_RECORDS_MAX; i++) {
      const r = table.insert(`ev${i}`, H, i, i + 4000, i);
      expect(r).toBeDefined();
      r!.perSub.set("s1", "unknown"); // judged (determined) — but give it a live deliveredAt…
      r!.replyKind = "routed";
      r!.deliveredAt = i; // …inside the handback window ⇒ NOT evictable
    }
    expect(table.size).toBe(THREAD_EVENT_RECORDS_MAX);
    expect(table.canInsert(1000)).toBe(false);
    expect(table.insert("ev-new", H, 1000, 5000, 1000)).toBeUndefined();
  });

  it("UNDETERMINED records are never evicted even under capacity pressure", () => {
    const table = new EventRecordTable(4, HOUR);
    for (let i = 0; i < 4; i++) {
      const r = table.insert(`ev${i}`, H, i, i + 4000, i);
      r!.perSub.set("s1", "buffered"); // pending — undetermined
    }
    expect(table.canInsert(100)).toBe(false);
    expect(table.insert("ev-new", H, 100, 4100, 100)).toBeUndefined();
    expect(table.size).toBe(4);
  });

  it("judged + handback-window-passed records evict oldest-first to make room", () => {
    const table = new EventRecordTable(4, 10 * 60_000);
    // two judged+aged-out (routed) records, two undetermined
    const aged1 = makeJudgedNone(table, "aged1", 0);
    aged1.deliveredAt = 0;
    const aged2 = makeJudgedNone(table, "aged2", 1);
    aged2.deliveredAt = 1;
    const r3 = table.insert("ev3", H, 2, 4002, 2);
    r3!.perSub.set("s1", "unknown"); // judged (determined) but window not passed once routed… no deliveredAt yet
    const r4 = table.insert("ev4", H, 3, 4003, 3);
    r4!.perSub.set("s1", "buffered"); // undetermined
    expect(table.canInsert(20 * 60_000)).toBe(true);
    const fresh = table.insert("fresh", H, 20 * 60_000, 20 * 60_000 + 4000, 20 * 60_000);
    expect(fresh).toBeDefined();
    expect(table.has("aged1")).toBe(false); // oldest evictable removed
    expect(table.has("aged2")).toBe(true); // only one slot was needed
    expect(table.has("ev4")).toBe(true); // undetermined survives
  });

  it("judged-but-inside-window routed records are NOT evictable (H retention)", () => {
    const table = new EventRecordTable(2, 10 * 60_000);
    const r1 = makeJudgedNone(table, "ev1", 0);
    r1.replyKind = "routed";
    r1.deliveredAt = 0; // routed 0 ms ago — window (10 min) far from passed
    const r2 = makeJudgedNone(table, "ev2", 1);
    r2.replyKind = "routed";
    r2.deliveredAt = 1;
    expect(table.canInsert(5 * 60_000)).toBe(false);
    expect(table.canInsert(10 * 60_000)).toBe(true); // window exactly passed
  });

  it("judged fallback records (never routed, no deliveredAt) evict immediately", () => {
    const table = new EventRecordTable(1, 10 * 60_000);
    makeJudgedNone(table, "ev1", 0); // judged, no deliveredAt
    expect(table.canInsert(1)).toBe(true);
    expect(table.insert("ev2", H, 1, 4001, 1)).toBeDefined();
    expect(table.has("ev1")).toBe(false);
  });

  it("refreshJudged: empty perSub is never judged; any pending outcome un-judges", () => {
    const table = new EventRecordTable();
    const r = table.insert("ev1", H, 0, 4000, 0)!;
    expect(EventRecordTable.refreshJudged(r)).toBe(false);
    r.perSub.set("s1", "none");
    r.perSub.set("s2", "queued");
    expect(EventRecordTable.refreshJudged(r)).toBe(true); // both determined
    r.perSub.set("s3", "buffered");
    expect(EventRecordTable.refreshJudged(r)).toBe(false);
  });
});
