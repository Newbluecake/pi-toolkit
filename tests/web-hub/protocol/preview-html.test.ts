/**
 * web-hub-html-preview plan v2 §6 P0 验收: `protocol/preview-html.ts` —
 * - `PV_SANDBOX` 精确令牌集（D1：恰含 allow-scripts/allow-forms/allow-popups；绝无
 *   allow-same-origin / top-navigation / modals / downloads / popups-to-escape-sandbox）；
 * - `PV_CAP_RE` 恰为 43 个 base64url 字符（`randomBytes(32).toString("base64url")` 的全域）；
 * - TTL 关系：idle < hard（activity 永不延长绝对上限，D4）；
 * - 排队关系：active ≤ queue（per-cap 与 global 两侧，§2.3-④）；
 * - `PV_IO_SLOTS ≥ 1`（§2.5：槽位死锁只降级 /pv 为 busy，绝不锁死 hub）；
 * - `isHtmlEntryPath` 的 .html/.htm 大小写变体与 .xhtml 拒绝（§2.1-②/§0 non-goals）；
 * - 以及 §2 每个冻结数值的字面钉（P1a/P1b/P2 依赖的 compile-time 契约在此全部落地）。
 */
import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  isHtmlEntryPath,
  PREVIEW_HTML_CAP_PATH,
  PV_ACTIVE_GLOBAL,
  PV_ACTIVE_PER_CAP,
  PV_ADMIT_TOTAL_MS,
  PV_BUCKET_CAPACITY,
  PV_BUCKET_REFILL_MS,
  PV_CAP_RE,
  PV_CAPS_GLOBAL,
  PV_CAPS_PER_PRINCIPAL,
  PV_CAP_TOTAL_MAX_BYTES,
  PV_DENY_AUDIT_THROTTLE_MS,
  PV_FILE_MAX_BYTES,
  PV_HARD_TTL_MS,
  PV_IDLE_TTL_MS,
  PV_IO_OP_TIMEOUT_MS,
  PV_IO_SLOTS,
  PV_LIFETIME_MAX_REQS,
  PV_MINT_MAX_BODY_BYTES,
  PV_PREFIX,
  PV_QUEUE_GLOBAL,
  PV_QUEUE_PER_CAP,
  PV_QUEUE_WAIT_MS,
  PV_REL_MAX_BYTES,
  PV_REL_MAX_SEGMENTS,
  PV_SANDBOX,
  PV_SEGMENT_MAX_BYTES,
  PV_STREAM_MS,
  PV_TOMBSTONE_RING,
  PVW_PREFIX,
} from "../../../src/web-hub/protocol/preview-html.js";

describe("protocol/preview-html — frozen surface (plan v2 §6 P0)", () => {
  it("pins the capability-URL prefixes and the mint endpoint (§1/§2.1)", () => {
    expect(PV_PREFIX).toBe("/pv/");
    expect(PVW_PREFIX).toBe("/pvw/");
    expect(PREVIEW_HTML_CAP_PATH).toBe("/api/preview/html-cap");
  });

  it("PV_SANDBOX is EXACTLY allow-scripts allow-forms allow-popups (D1)", () => {
    // the exact frozen byte string — the hub's CSP header text and the UI's iframe attribute
    // both embed this verbatim, so the order is pinned too.
    expect(PV_SANDBOX).toBe("allow-scripts allow-forms allow-popups");
    const tokens = PV_SANDBOX.trim().split(/\s+/);
    expect(new Set(tokens).size).toBe(tokens.length); // no duplicated token
    expect([...tokens].sort()).toEqual(["allow-forms", "allow-popups", "allow-scripts"]);
    // the forbidden families — checked as substrings so the longer spellings
    // (allow-top-navigation-by-user-activation) are covered by their prefix.
    for (const banned of [
      "allow-same-origin",
      "allow-top-navigation",
      "allow-modals",
      "allow-downloads",
      "allow-popups-to-escape-sandbox",
    ]) {
      expect(PV_SANDBOX).not.toContain(banned);
    }
  });

  it("PV_CAP_RE matches EXACTLY 43 base64url chars — every cap a store can mint (§2.2)", () => {
    // cap = randomBytes(32).toString("base64url") — always exactly 43 chars over the
    // base64url alphabet; sample broadly, including all-0x00 / all-0xff edge encodings.
    const caps = [
      randomBytes(32),
      randomBytes(32),
      randomBytes(32),
      randomBytes(32),
      Buffer.alloc(32, 0x00),
      Buffer.alloc(32, 0xff),
    ].map((b) => b.toString("base64url"));
    for (const cap of caps) {
      expect(cap).toMatch(/^[A-Za-z0-9_-]{43}$/); // the base64url(32B) invariant itself
      expect(cap).toMatch(PV_CAP_RE);
    }
    // length edges: 42 and 44 chars of the same alphabet are OUT
    const base = "A".repeat(43);
    expect(PV_CAP_RE.test(base)).toBe(true);
    expect(PV_CAP_RE.test(base.slice(1))).toBe(false);
    expect(PV_CAP_RE.test(`${base}A`)).toBe(false);
    // non-alphabet chars are OUT even at 43 chars (standard base64 '+', '/', '=' included)
    expect(PV_CAP_RE.test(`${"A".repeat(42)}+`)).toBe(false);
    expect(PV_CAP_RE.test(`${"A".repeat(42)}/`)).toBe(false);
    expect(PV_CAP_RE.test(`${"A".repeat(42)}=`)).toBe(false);
    expect(PV_CAP_RE.test(`${"a".repeat(43)} `)).toBe(false); // anchored both ends
  });

  it("pins the D4 TTLs and their relation: idle < hard (activity never extends the absolute cap)", () => {
    expect(PV_IDLE_TTL_MS).toBe(15 * 60_000);
    expect(PV_HARD_TTL_MS).toBe(60 * 60_000);
    expect(PV_IDLE_TTL_MS).toBeLessThan(PV_HARD_TTL_MS);
  });

  it("pins the §2.3-④ queue widths and their relation: active ≤ queue (per-cap AND global)", () => {
    expect(PV_ACTIVE_PER_CAP).toBe(6);
    expect(PV_ACTIVE_GLOBAL).toBe(16);
    expect(PV_QUEUE_PER_CAP).toBe(64);
    expect(PV_QUEUE_GLOBAL).toBe(256);
    expect(PV_QUEUE_WAIT_MS).toBe(10_000);
    expect(PV_ACTIVE_PER_CAP).toBeLessThanOrEqual(PV_QUEUE_PER_CAP);
    expect(PV_ACTIVE_GLOBAL).toBeLessThanOrEqual(PV_QUEUE_GLOBAL);
  });

  it("pins PV_IO_SLOTS ≥ 1 (a wedged op degrades /pv to busy — it must never lock the hub)", () => {
    expect(PV_IO_SLOTS).toBe(2);
    expect(PV_IO_SLOTS).toBeGreaterThanOrEqual(1);
  });

  it("isHtmlEntryPath: .html/.htm in every case variant; .xhtml and friends rejected (§2.1-②)", () => {
    for (const p of [
      "/home/u/report.html",
      "/home/u/report.htm",
      "/home/u/REPORT.HTML",
      "/home/u/Report.HtM",
      "/a/b/c.html",
      "/a/图 表.htm",
      "/a/b.html", // single trailing segment is the entry itself
    ]) {
      expect(isHtmlEntryPath(p), p).toBe(true);
    }
    for (const p of [
      "/home/u/report.xhtml", // explicitly out (§0 non-goals)
      "/home/u/report.HTML.bak", // suffix must be the very end
      "/home/u/reportxhtml", // no separating dot
      "/home/u/html", // 'html' without the dot is not an entry
      "/home/u/x.htm/y", // .htm must be the final segment
      "/home/u/report.html/", // trailing slash ≠ entry (validatePreviewPath normalizes first)
      "",
    ]) {
      expect(isHtmlEntryPath(p), p).toBe(false);
    }
  });

  it("pins every remaining §2 limit/TTL literal (the numbers P1a/P1b/P2 compile against)", () => {
    // §2.1 mint
    expect(PV_MINT_MAX_BODY_BYTES).toBe(8 * 1024);
    // §2.1-⑧ / §2.2 store occupancy + tombstones
    expect(PV_CAPS_PER_PRINCIPAL).toBe(8);
    expect(PV_CAPS_GLOBAL).toBe(64);
    expect(PV_TOMBSTONE_RING).toBe(256);
    // §2.3-② rel-path parse caps
    expect(PV_REL_MAX_SEGMENTS).toBe(64);
    expect(PV_SEGMENT_MAX_BYTES).toBe(255);
    expect(PV_REL_MAX_BYTES).toBe(4096);
    // §2.3-③ rate bucket + lifetime
    expect(PV_BUCKET_CAPACITY).toBe(200);
    expect(PV_BUCKET_REFILL_MS).toBe(20);
    expect(PV_LIFETIME_MAX_REQS).toBe(10_000);
    // §2.3-⑤/⑥/⑦ admission + sizes + stream
    expect(PV_ADMIT_TOTAL_MS).toBe(4_000);
    expect(PV_FILE_MAX_BYTES).toBe(32 * 1024 * 1024);
    expect(PV_CAP_TOTAL_MAX_BYTES).toBe(512 * 1024 * 1024);
    expect(PV_STREAM_MS).toEqual({ loopback: 30_000, lan: 60_000 });
    // §2.5 IO quota / §2.3-⑧ denial accounting
    expect(PV_IO_OP_TIMEOUT_MS).toBe(2_000);
    expect(PV_DENY_AUDIT_THROTTLE_MS).toBe(100);
  });
});
