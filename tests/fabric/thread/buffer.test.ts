import { describe, expect, it } from "vitest";
import {
  BufferPushResult,
  ThreadBuffer,
  THREAD_BUFFER_MAX_BYTES,
  THREAD_BUFFER_MAX_EVENTS,
} from "../../../src/fabric/thread/buffer.js";

describe("ThreadBuffer (§6.5 缓冲: ≤4 events / ≤32 KiB / FIFO)", () => {
  it("caps at 4 events; the 5th push fails events_full (caller records none)", () => {
    const buf = new ThreadBuffer();
    for (let i = 0; i < THREAD_BUFFER_MAX_EVENTS; i++) {
      expect(buf.push(`ev${i}`, "fs:h", 0, `text-${i}`)).toEqual({ ok: true });
    }
    const fifth: BufferPushResult = buf.push("ev4", "fs:h", 0, "text-4");
    expect(fifth).toEqual({ ok: false, reason: "events_full" });
    expect(buf.length).toBe(4);
  });

  it("caps at 32 KiB of encapsulated bytes — UTF-8 precise (multibyte counts 3/4)", () => {
    const buf = new ThreadBuffer();
    // 3 events × 8192 ASCII bytes = 24576; a 4th of 8193 overflows, of 8192 lands exactly on the cap
    expect(buf.push("ev1", "fs:h", 0, "x".repeat(8192))).toEqual({ ok: true });
    expect(buf.push("ev2", "fs:h", 0, "x".repeat(8192))).toEqual({ ok: true });
    expect(buf.push("ev3", "fs:h", 0, "x".repeat(8192))).toEqual({ ok: true });
    expect(buf.bytes).toBe(3 * 8192);
    expect(buf.push("ev4", "fs:h", 0, "x".repeat(8193))).toEqual({ ok: false, reason: "bytes_full" });
    expect(buf.push("ev4", "fs:h", 0, "x".repeat(8192))).toEqual({ ok: true }); // exactly to the cap
    expect(buf.bytes).toBe(THREAD_BUFFER_MAX_BYTES);
    // multibyte precision: 10922 × '€' = 32766 bytes fits; 10923 × 3 = 32769 does not (a UTF-16
    // unit count would have allowed 32768 of them = 98304 real bytes)
    const fresh = new ThreadBuffer();
    expect(fresh.push("ev1", "fs:h", 0, "€".repeat(10922))).toEqual({ ok: true });
    expect(fresh.push("ev2", "fs:h", 0, "€".repeat(3))).toEqual({ ok: false, reason: "bytes_full" });
  });

  it("drains FIFO and resets the byte accounting", () => {
    const buf = new ThreadBuffer();
    buf.push("ev1", "fs:h", 1, "aaa");
    buf.push("ev2", "fs:h", 2, "bbbb");
    const drained = buf.drain();
    expect(drained.map((e) => e.eventId)).toEqual(["ev1", "ev2"]);
    expect(buf.length).toBe(0);
    expect(buf.bytes).toBe(0);
    expect(buf.drain()).toEqual([]);
  });

  it("deliveredAt anchors land undefined and are patched per event (§8.2 S)", () => {
    const buf = new ThreadBuffer();
    buf.push("ev1", "fs:h", 1, "a");
    buf.push("ev2", "fs:h", 2, "b");
    expect(buf.earliestDeliveredAt()).toBeUndefined();
    buf.setDeliveredAt("ev2", 500);
    expect(buf.earliestDeliveredAt()).toBe(500);
    buf.setDeliveredAt("ev1", 300);
    expect(buf.earliestDeliveredAt()).toBe(300);
  });

  it("expiryAt: earliest anchor + TTL; undefined while any entry lacks its anchor", () => {
    const buf = new ThreadBuffer();
    expect(buf.expiryAt(8 * 60_000)).toBeUndefined(); // empty
    buf.push("ev1", "fs:h", 1, "a");
    expect(buf.expiryAt(8 * 60_000)).toBeUndefined(); // anchored to nothing yet
    buf.setDeliveredAt("ev1", 1000);
    expect(buf.expiryAt(8 * 60_000)).toBe(1000 + 8 * 60_000);
    buf.push("ev2", "fs:h", 2, "b"); // no anchor yet — blocks the timer (re-armed when patched)
    expect(buf.expiryAt(8 * 60_000)).toBeUndefined();
    buf.setDeliveredAt("ev2", 2000);
    expect(buf.expiryAt(8 * 60_000)).toBe(1000 + 8 * 60_000); // earliest wins
  });
});
