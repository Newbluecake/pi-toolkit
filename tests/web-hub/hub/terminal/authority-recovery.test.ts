import { describe, expect, it } from "vitest";
import {
  authorityArchiveBudget,
  TERMINAL_AUTHORITY_ARCHIVE_MAX_BYTES as MAX,
} from "../../../../src/web-hub/hub/terminal/authority-recovery.js";
const base = {
  transactions: 0,
  existingBytes: 0,
  snapshotBytes: 1,
  candidates: 1,
  manifestBytes: 2,
  completionBytes: 3,
};
describe("single authority archive accounting", () => {
  it.each([63, 64, 65])("transaction count %s: never GC to make room", (transactions) => {
    if (transactions === 63) expect(authorityArchiveBudget({ ...base, transactions })).toBe(7);
    else expect(() => authorityArchiveBudget({ ...base, transactions })).toThrowError("authority-archive-capacity");
  });
  it.each([-1, 0, 1])("exact total logical bytes boundary %+d", (delta) => {
    const input = { ...base, existingBytes: MAX - 7 + delta };
    if (delta <= 0) expect(authorityArchiveBudget(input)).toBe(7);
    else expect(() => authorityArchiveBudget(input)).toThrowError("authority-archive-capacity");
  });
  it.each([-1, 0, 1])("snapshot 2 MiB boundary %+d (retired is charged again)", (delta) => {
    const snapshotBytes = 2 * 1024 * 1024 + delta;
    if (delta <= 0) expect(authorityArchiveBudget({ ...base, snapshotBytes })).toBe(snapshotBytes * 2 + 5);
    else expect(() => authorityArchiveBudget({ ...base, snapshotBytes })).toThrowError("authority-archive-capacity");
  });
  it("all planned files including retained inode, manifest and completion are charged", () => {
    expect(authorityArchiveBudget(base)).toBe(7);
    for (const key of ["snapshotBytes", "manifestBytes", "completionBytes"] as const)
      expect(() => authorityArchiveBudget({ ...base, existingBytes: MAX - 7, [key]: base[key] + 1 })).toThrowError(
        "authority-archive-capacity",
      );
    expect(() => authorityArchiveBudget({ ...base, candidates: 257 })).toThrowError("authority-archive-capacity");
  });
});
