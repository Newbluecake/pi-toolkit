/**
 * web-hub-preview plan v3 §4.1 (PV1 验收): `protocol/preview.ts` — `validatePreviewPath`
 * 正反例、`API_ERRORS` 尾部四个 `E_PREVIEW_*`、`PREVIEW_HDR`、`PREVIEW_DEFAULT_MODE`、
 * 预算常量之间的关系（ADMIT + STREAM.lan < CLIENT_TIMEOUT，VERIFY ≤ STREAM.lan）、
 * `normalizeHubPreviewMode`（hub/main.ts 丢弃非法值的判定核心）。
 *
 * `API_ERRORS` 的四个码必须接在 `E_LAUNCHER` 之后（§2.3 热点文件规则：只允许尾部追加、
 * 不许重排）；`PREVIEW_UPLOADS_MARKER` 与 upload 线的落盘根（`~/.pi/agent/web-hub/uploads/`）
 * 对齐，但那是 PV2b 的文件域，这里只钉字面值。
 */
import { describe, expect, it } from "vitest";
import { API_ERRORS } from "../../../src/web-hub/protocol/http-contract.js";
import {
  normalizeHubPreviewMode,
  parsePreviewDirListing,
  PREVIEW_ADMIT_TOTAL_MS,
  PREVIEW_CLIENT_PIXELS_COARSE,
  PREVIEW_CLIENT_TIMEOUT_MS,
  PREVIEW_DEFAULT_MODE,
  PREVIEW_DIR_BODY_MAX_BYTES,
  PREVIEW_DIR_CLOSE_MS,
  PREVIEW_DIR_ENTRIES_MAX,
  PREVIEW_DIR_LAN_TRANSFER_RESERVE_MS,
  PREVIEW_DIR_LIST_MS,
  PREVIEW_DIR_NAME_MAX_BYTES,
  PREVIEW_DIR_QUERY,
  PREVIEW_DIR_SCAN_MAX,
  PREVIEW_DIR_STAT_CONCURRENCY,
  PREVIEW_HDR,
  PREVIEW_IMAGE_MAX_BYTES,
  PREVIEW_IMAGE_MAX_PIXELS,
  PREVIEW_JPEG_SCAN_MAX_BYTES,
  PREVIEW_PATH,
  PREVIEW_PATH_MAX_BYTES,
  PREVIEW_PROBE_KINDS,
  PREVIEW_SAMPLE_BYTES,
  PREVIEW_SNIFF_TEXT_BYTES,
  PREVIEW_STREAM_MS,
  PREVIEW_TEXT_MAX_BYTES,
  PREVIEW_UPLOADS_MARKER,
  PREVIEW_VERIFY_MS,
  validatePreviewPath,
} from "../../../src/web-hub/protocol/preview.js";

describe("protocol/preview — constants (§4.1)", () => {
  it('pins the endpoint path and the tri-value default (U1: default "on")', () => {
    expect(PREVIEW_PATH).toBe("/api/preview");
    expect(PREVIEW_DEFAULT_MODE).toBe("on");
  });

  it("pins the content caps (§0 上限)", () => {
    expect(PREVIEW_TEXT_MAX_BYTES).toBe(256 * 1024);
    expect(PREVIEW_IMAGE_MAX_BYTES).toEqual({ loopback: 16 * 1024 * 1024, lan: 4 * 1024 * 1024 });
    expect(PREVIEW_IMAGE_MAX_PIXELS).toBe(40_000_000);
    expect(PREVIEW_CLIENT_PIXELS_COARSE).toBe(20_000_000);
    expect(PREVIEW_PATH_MAX_BYTES).toBe(4096);
    expect(PREVIEW_SNIFF_TEXT_BYTES).toBe(8 * 1024);
    expect(PREVIEW_SAMPLE_BYTES).toBe(64 * 1024);
    expect(PREVIEW_JPEG_SCAN_MAX_BYTES).toBe(256 * 1024);
    expect(PREVIEW_UPLOADS_MARKER).toBe("/.pi/agent/web-hub/uploads/");
  });

  it("pins the X-PWH-Preview-* response header names", () => {
    expect(PREVIEW_HDR).toEqual({
      kind: "X-PWH-Preview-Kind",
      size: "X-PWH-Preview-Size",
      bytes: "X-PWH-Preview-Bytes",
      truncated: "X-PWH-Preview-Truncated",
      dims: "X-PWH-Preview-Dims",
    });
  });

  it("pins the budget relation: ADMIT + STREAM.lan < CLIENT_TIMEOUT and VERIFY ≤ STREAM.lan (§0 预算)", () => {
    expect(PREVIEW_ADMIT_TOTAL_MS).toBe(8_000);
    expect(PREVIEW_STREAM_MS).toEqual({ loopback: 15_000, lan: 30_000 });
    expect(PREVIEW_VERIFY_MS).toBe(30_000);
    expect(PREVIEW_CLIENT_TIMEOUT_MS).toBe(40_000);
    // the named relations — a LAN stream started at the admit deadline must still finish
    // inside the client's own timeout, and a single-flight verify never outlives the LAN write-out
    expect(PREVIEW_ADMIT_TOTAL_MS + PREVIEW_STREAM_MS.lan).toBeLessThan(PREVIEW_CLIENT_TIMEOUT_MS);
    expect(PREVIEW_VERIFY_MS).toBeLessThanOrEqual(PREVIEW_STREAM_MS.lan);
    // the loopback variant is strictly tighter (same relation, smaller stream budget)
    expect(PREVIEW_ADMIT_TOTAL_MS + PREVIEW_STREAM_MS.loopback).toBeLessThan(PREVIEW_CLIENT_TIMEOUT_MS);
  });
});

describe("protocol/preview — API_ERRORS tail (§4.1: four E_PREVIEW_* after E_LAUNCHER)", () => {
  it("appends exactly the four codes, in order, right after E_LAUNCHER", () => {
    const launcher = API_ERRORS.indexOf("E_LAUNCHER");
    expect(launcher).toBeGreaterThan(-1);
    expect(API_ERRORS[launcher + 1]).toBe("E_PREVIEW_DENIED");
    expect(API_ERRORS[launcher + 2]).toBe("E_PREVIEW_UNSUPPORTED");
    expect(API_ERRORS[launcher + 3]).toBe("E_PREVIEW_TOO_LARGE");
    expect(API_ERRORS[launcher + 4]).toBe("E_PREVIEW_CHANGED");
    // web-hub-delete-session plan v2 §4.3: E_AGENT_ONLINE is tail-appended right after the
    // four E_PREVIEW_* codes (append-only — this file's job is just to keep that tail honest).
    expect(API_ERRORS[launcher + 5]).toBe("E_AGENT_ONLINE");
    expect(API_ERRORS[launcher + 6]).toBeUndefined(); // nothing sneaks in after them
  });

  it("contains each preview code exactly once (no reordering, no duplicates)", () => {
    for (const code of ["E_PREVIEW_DENIED", "E_PREVIEW_UNSUPPORTED", "E_PREVIEW_TOO_LARGE", "E_PREVIEW_CHANGED"]) {
      expect(API_ERRORS.filter((c) => c === code)).toHaveLength(1);
    }
  });
});

describe("validatePreviewPath (§4.1)", () => {
  it("accepts ordinary absolute paths with >= 2 non-empty segments", () => {
    expect(validatePreviewPath("/a/b")).toBe(true);
    expect(validatePreviewPath("/home/u/notes.txt")).toBe(true);
    expect(validatePreviewPath("/home/u/dir.with.dots/file-1_v2.png")).toBe(true);
    expect(validatePreviewPath("/.pi/agent/web-hub/uploads/abc123/img.png")).toBe(true);
    expect(validatePreviewPath("/tmp/中文目录/文件.md")).toBe(true);
  });

  it("requires a leading slash and at least two segments", () => {
    expect(validatePreviewPath("a/b")).toBe(false);
    expect(validatePreviewPath("relative/path.txt")).toBe(false);
    expect(validatePreviewPath("/")).toBe(false);
    expect(validatePreviewPath("/only")).toBe(false); // 1 segment
    expect(validatePreviewPath("")).toBe(false);
  });

  it("rejects empty segments (double slashes, trailing slash)", () => {
    expect(validatePreviewPath("/a//b")).toBe(false);
    expect(validatePreviewPath("//a/b")).toBe(false);
    expect(validatePreviewPath("/a/b/")).toBe(false);
  });

  it("rejects '.' and '..' segments anywhere", () => {
    expect(validatePreviewPath("/a/./b")).toBe(false);
    expect(validatePreviewPath("/a/../b")).toBe(false);
    expect(validatePreviewPath("/a/b/..")).toBe(false);
    expect(validatePreviewPath("/a/.")).toBe(false);
    // a dot that is merely PART of a segment stays legal
    expect(validatePreviewPath("/a/.hidden")).toBe(true);
    expect(validatePreviewPath("/a/..hidden")).toBe(true);
    expect(validatePreviewPath("/a/b...")).toBe(true);
  });

  it("rejects NUL, CR and LF anywhere in the path", () => {
    expect(validatePreviewPath("/a/b\0c")).toBe(false);
    expect(validatePreviewPath("/a/b\rc")).toBe(false);
    expect(validatePreviewPath("/a/b\nc")).toBe(false);
    expect(validatePreviewPath("/a/bc\0")).toBe(false);
  });

  it("caps at 4096 UTF-8 BYTES (not UTF-16 units / code points)", () => {
    // exactly at the cap: "/a/" + 4093 'x' = 4096 bytes
    const atCap = `/a/${"x".repeat(PREVIEW_PATH_MAX_BYTES - 3)}`;
    expect(Buffer.byteLength(atCap)).toBe(PREVIEW_PATH_MAX_BYTES);
    expect(validatePreviewPath(atCap)).toBe(true);
    // one byte over
    const overCap = `/a/${"x".repeat(PREVIEW_PATH_MAX_BYTES - 2)}`;
    expect(Buffer.byteLength(overCap)).toBe(PREVIEW_PATH_MAX_BYTES + 1);
    expect(validatePreviewPath(overCap)).toBe(false);
    // multibyte: 1400 CJK chars (4200 UTF-8 bytes) are only 1400 UTF-16 units / code points —
    // the cap must count bytes and reject it
    const cjk = `/a/${"漢".repeat(1400)}`;
    expect(cjk.length).toBeLessThan(PREVIEW_PATH_MAX_BYTES);
    expect(Buffer.byteLength(cjk)).toBeGreaterThan(PREVIEW_PATH_MAX_BYTES);
    expect(validatePreviewPath(cjk)).toBe(false);
    // ... while a byte-legal multibyte path passes
    const cjkOk = `/a/${"漢".repeat(1000)}`;
    expect(Buffer.byteLength(cjkOk)).toBeLessThanOrEqual(PREVIEW_PATH_MAX_BYTES);
    expect(validatePreviewPath(cjkOk)).toBe(true);
  });

  it("never throws on non-string input", () => {
    for (const garbage of [undefined, null, 0, true, {}, []] as unknown as string[]) {
      expect(() => validatePreviewPath(garbage)).not.toThrow();
      expect(validatePreviewPath(garbage)).toBe(false);
    }
  });
});

// dir-plan §1.1 (P0): the ONLY loosening validatePreviewPath gains is the segment-count rule.
// The default (2) is the recognition layer's frozen rule — pinned here so a future accidental
// default change cannot slip in unnoticed.
describe("validatePreviewPath minSegments (dir-plan §1.1)", () => {
  it("DEFAULT is unchanged: no-arg and {} both keep the frozen 2-segment rule", () => {
    // single-segment paths stay NON-paths without an explicit opt-in (so /help, /reload etc.
    // never become click candidates)
    expect(validatePreviewPath("/only")).toBe(false);
    expect(validatePreviewPath("/a")).toBe(false);
    expect(validatePreviewPath("/only", {})).toBe(false);
    expect(validatePreviewPath("/", {})).toBe(false);
    expect(validatePreviewPath("/a/b")).toBe(true);
    expect(validatePreviewPath("/a/b", {})).toBe(true);
  });

  it("minSegments: 1 admits single-segment absolute paths — and NOTHING else changes", () => {
    expect(validatePreviewPath("/only", { minSegments: 1 })).toBe(true);
    expect(validatePreviewPath("/home", { minSegments: 1 })).toBe(true);
    expect(validatePreviewPath("/a/b", { minSegments: 1 })).toBe(true);
    // every other rule is untouched by the loosening:
    expect(validatePreviewPath("/", { minSegments: 1 })).toBe(false); // empty segment
    expect(validatePreviewPath("", { minSegments: 1 })).toBe(false); // no leading slash
    expect(validatePreviewPath("a", { minSegments: 1 })).toBe(false);
    expect(validatePreviewPath("a/b", { minSegments: 1 })).toBe(false);
    expect(validatePreviewPath("/a//b", { minSegments: 1 })).toBe(false); // empty segment
    expect(validatePreviewPath("/a/b/", { minSegments: 1 })).toBe(false); // trailing slash
    expect(validatePreviewPath("/a/.", { minSegments: 1 })).toBe(false); // dot segment
    expect(validatePreviewPath("/a/..", { minSegments: 1 })).toBe(false);
    expect(validatePreviewPath("/a/b\0", { minSegments: 1 })).toBe(false); // NUL
    expect(validatePreviewPath("/a/b\r", { minSegments: 1 })).toBe(false);
    expect(validatePreviewPath("/a/b\n", { minSegments: 1 })).toBe(false);
    const overCap = `/a/${"x".repeat(PREVIEW_PATH_MAX_BYTES - 2)}`; // byte cap still holds
    expect(validatePreviewPath(overCap, { minSegments: 1 })).toBe(false);
  });

  it("minSegments: 2 explicitly equals the default", () => {
    for (const p of ["/only", "/a", "/a/b", "/", "/a/b/", "/a/./b"]) {
      expect(validatePreviewPath(p, { minSegments: 2 })).toBe(validatePreviewPath(p));
    }
  });
});

describe("normalizeHubPreviewMode (§4.1: HubConfig.preview wire re-validation)", () => {
  it("accepts exactly the two wire-legal modes", () => {
    expect(normalizeHubPreviewMode("on")).toBe("on");
    expect(normalizeHubPreviewMode("loopback")).toBe("loopback");
  });

  it('rejects "off" (the wire form of off is the key\'s ABSENCE) and everything else', () => {
    expect(normalizeHubPreviewMode("off")).toBeUndefined();
    expect(normalizeHubPreviewMode("ON")).toBeUndefined();
    expect(normalizeHubPreviewMode("Loopback")).toBeUndefined();
    expect(normalizeHubPreviewMode("lan")).toBeUndefined();
    expect(normalizeHubPreviewMode("")).toBeUndefined();
    expect(normalizeHubPreviewMode(undefined)).toBeUndefined();
    expect(normalizeHubPreviewMode(null)).toBeUndefined();
    expect(normalizeHubPreviewMode(1)).toBeUndefined();
    expect(normalizeHubPreviewMode(true)).toBeUndefined();
    expect(normalizeHubPreviewMode({ mode: "on" })).toBeUndefined();
    expect(normalizeHubPreviewMode(["on"])).toBeUndefined();
  });
});

// dir-plan §1.1/§3.2–§3.4 (P0): the directory-listing wire caps, phase budgets and their
// pinned relations.
describe("protocol/preview — dir listing constants (dir-plan §1.1/§3.4)", () => {
  it("pins the query flag, the three-layer caps and the phase budgets", () => {
    expect(PREVIEW_DIR_QUERY).toBe("dir");
    expect(PREVIEW_DIR_SCAN_MAX).toBe(10_000);
    expect(PREVIEW_DIR_ENTRIES_MAX).toBe(1_000);
    expect(PREVIEW_DIR_BODY_MAX_BYTES).toBe(512 * 1024);
    expect(PREVIEW_DIR_NAME_MAX_BYTES).toBe(1_024);
    expect(PREVIEW_DIR_LIST_MS).toBe(5_000);
    expect(PREVIEW_DIR_STAT_CONCURRENCY).toBe(8);
    expect(PREVIEW_DIR_CLOSE_MS).toBe(1_000);
    expect(PREVIEW_DIR_LAN_TRANSFER_RESERVE_MS).toBe(20_000);
  });

  it("ENTRIES_MAX ≤ SCAN_MAX (§5 P0: the entries cap never exceeds the scan cap)", () => {
    expect(PREVIEW_DIR_ENTRIES_MAX).toBeGreaterThan(0);
    expect(PREVIEW_DIR_SCAN_MAX).toBeGreaterThan(0);
    expect(PREVIEW_DIR_ENTRIES_MAX).toBeLessThanOrEqual(PREVIEW_DIR_SCAN_MAX);
  });

  it("pins the §3.4 dir budget relation: ADMIT + LIST + LAN reserve ≤ CLIENT_TIMEOUT", () => {
    // concrete anchor: 8 s admit + 5 s listing + 20 s LAN-transfer reserve ≤ 40 s client timeout
    expect(PREVIEW_ADMIT_TOTAL_MS).toBe(8_000);
    expect(PREVIEW_DIR_LIST_MS).toBe(5_000);
    expect(PREVIEW_DIR_LAN_TRANSFER_RESERVE_MS).toBe(20_000);
    expect(PREVIEW_CLIENT_TIMEOUT_MS).toBe(40_000);
    expect(PREVIEW_ADMIT_TOTAL_MS + PREVIEW_DIR_LIST_MS + PREVIEW_DIR_LAN_TRANSFER_RESERVE_MS).toBeLessThanOrEqual(
      PREVIEW_CLIENT_TIMEOUT_MS,
    );
  });

  it("pins PREVIEW_PROBE_KINDS — the single enum source (§1.3), dir included, no extras", () => {
    expect([...PREVIEW_PROBE_KINDS]).toEqual(["text", "image", "dir", "missing"]);
    expect(new Set(PREVIEW_PROBE_KINDS).size).toBe(4); // all distinct
  });
});

// dir-plan §1.1 (P0): the defensive parser for `dir=1` listing bodies — one example per
// rejection condition, plus the §5 P0 boundary/consistency cases.
describe("parsePreviewDirListing (dir-plan §1.1)", () => {
  const valid = (): Record<string, unknown> => ({
    entries: [
      { name: "src", type: "dir" },
      { name: "中文.md", type: "file", size: 12, mtimeMs: 1_700_000_000_000 },
      { name: "broken\ufffd", type: "symlink", lossy: true },
    ],
    total: 3,
    scanned: 3,
    complete: true,
    truncated: false,
    limits: { scan: false, entries: false, bytes: false },
    vanished: 0,
    dropped: 0,
  });

  /** A listing whose entries array is exactly `[entry]`, with total/truncated kept consistent. */
  const oneEntry = (entry: Record<string, unknown>): Record<string, unknown> => ({
    ...valid(),
    entries: [entry],
    total: 1,
  });

  const byteLen = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));

  it("accepts a well-formed listing; unknown fields are ignored (forward-compat)", () => {
    const raw: Record<string, unknown> = {
      entries: [
        { name: "src", type: "dir", futureEntry: 1 },
        { name: "中文.md", type: "file", size: 12, mtimeMs: 1_700_000_000_000 },
        { name: "broken\ufffd", type: "symlink", lossy: true },
      ],
      total: 3,
      scanned: 3,
      complete: true,
      truncated: false,
      limits: { scan: false, entries: false, bytes: false, futureLimit: "x" },
      vanished: 0,
      dropped: 0,
      futureTop: { nested: true },
    };
    expect(parsePreviewDirListing(raw, byteLen(raw))).toEqual({
      entries: [
        { name: "src", type: "dir" },
        { name: "中文.md", type: "file", size: 12, mtimeMs: 1_700_000_000_000 },
        { name: "broken\ufffd", type: "symlink", lossy: true },
      ],
      total: 3,
      scanned: 3,
      complete: true,
      truncated: false,
      limits: { scan: false, entries: false, bytes: false },
      vanished: 0,
      dropped: 0,
    });
  });

  it("accepts the minimal empty listing", () => {
    const raw: Record<string, unknown> = {
      entries: [],
      total: 0,
      scanned: 0,
      complete: true,
      truncated: false,
      limits: { scan: false, entries: false, bytes: false },
      vanished: 0,
      dropped: 0,
    };
    expect(parsePreviewDirListing(raw, byteLen(raw))).toEqual({
      entries: [],
      total: 0,
      scanned: 0,
      complete: true,
      truncated: false,
      limits: { scan: false, entries: false, bytes: false },
      vanished: 0,
      dropped: 0,
    });
  });

  it("size/mtimeMs accept any non-negative FINITE number (fractional mtimeMs is legal, §1.1)", () => {
    const raw = oneEntry({ name: "a", type: "file", size: 0, mtimeMs: 1.5 });
    const out = parsePreviewDirListing(raw, byteLen(raw));
    expect(out?.entries[0]).toEqual({ name: "a", type: "file", size: 0, mtimeMs: 1.5 });
  });

  it("statPartial is accepted only as the literal true (absent or true, never false)", () => {
    const withTrue = { ...valid(), statPartial: true };
    expect(parsePreviewDirListing(withTrue, byteLen(withTrue))?.statPartial).toBe(true);
    const absent = parsePreviewDirListing(valid(), 512);
    expect(absent !== null && "statPartial" in absent).toBe(false);
    const bad = { ...valid(), statPartial: false };
    expect(parsePreviewDirListing(bad, byteLen(bad))).toBeNull();
  });

  it("512 KiB byteLength boundary ±1 (§1.1: the aggregate cap is judged on the decoded body)", () => {
    const raw = valid();
    expect(parsePreviewDirListing(raw, PREVIEW_DIR_BODY_MAX_BYTES)).not.toBeNull();
    expect(parsePreviewDirListing(raw, PREVIEW_DIR_BODY_MAX_BYTES + 1)).toBeNull();
  });

  it("1 024-byte name boundary ±1 (ASCII)", () => {
    const at = oneEntry({ name: "x".repeat(PREVIEW_DIR_NAME_MAX_BYTES), type: "file" });
    expect(parsePreviewDirListing(at, byteLen(at))).not.toBeNull();
    const over = oneEntry({ name: "x".repeat(PREVIEW_DIR_NAME_MAX_BYTES + 1), type: "file" });
    expect(parsePreviewDirListing(over, byteLen(over))).toBeNull();
  });

  it("multibyte names count UTF-8 BYTES, not UTF-16 units/code points", () => {
    // é = 2 UTF-8 bytes: 512 × é = exactly 1024 bytes — legal
    expect(Buffer.byteLength("é".repeat(512))).toBe(PREVIEW_DIR_NAME_MAX_BYTES);
    const twoByte = oneEntry({ name: "é".repeat(512), type: "file" });
    expect(parsePreviewDirListing(twoByte, byteLen(twoByte))).not.toBeNull();
    // 漢 = 3 UTF-8 bytes: 341 × 漢 + 'a' = exactly 1024 bytes — legal
    const threeByteAt = "漢".repeat(341) + "a";
    expect(Buffer.byteLength(threeByteAt)).toBe(PREVIEW_DIR_NAME_MAX_BYTES);
    const at = oneEntry({ name: threeByteAt, type: "file" });
    expect(parsePreviewDirListing(at, byteLen(at))).not.toBeNull();
    // 漢 × 342 = 1026 bytes — over the cap
    const threeByteOver = "漢".repeat(342);
    expect(Buffer.byteLength(threeByteOver)).toBeGreaterThan(PREVIEW_DIR_NAME_MAX_BYTES);
    const over = oneEntry({ name: threeByteOver, type: "file" });
    expect(parsePreviewDirListing(over, byteLen(over))).toBeNull();
  });

  it("ENTRIES_MAX boundary: exactly 1 000 entries parse, 1 001 reject", () => {
    const mk = (n: number): Record<string, unknown> => ({
      ...valid(),
      entries: Array.from({ length: n }, (_, i) => ({ name: `f${i}`, type: "file" })),
      total: n,
    });
    const at = mk(PREVIEW_DIR_ENTRIES_MAX);
    expect(parsePreviewDirListing(at, byteLen(at))?.entries).toHaveLength(PREVIEW_DIR_ENTRIES_MAX);
    const over = mk(PREVIEW_DIR_ENTRIES_MAX + 1);
    expect(parsePreviewDirListing(over, byteLen(over))).toBeNull();
  });

  it("SCAN_MAX boundary: scanned = 10 000 parses, 10 001 rejects", () => {
    // the honest shape at the cap: complete:false + truncated:true + limits.scan
    const at = {
      ...valid(),
      scanned: PREVIEW_DIR_SCAN_MAX,
      complete: false,
      truncated: true,
      limits: { scan: true, entries: false, bytes: false },
    };
    expect(parsePreviewDirListing(at, byteLen(at))?.scanned).toBe(PREVIEW_DIR_SCAN_MAX);
    const over = {
      ...valid(),
      scanned: PREVIEW_DIR_SCAN_MAX + 1,
      complete: false,
      truncated: true,
      limits: { scan: true, entries: false, bytes: false },
    };
    expect(parsePreviewDirListing(over, byteLen(over))).toBeNull();
  });

  it("rejects truncated inconsistencies in BOTH directions (truncated ≡ entries<total || !complete)", () => {
    // entries.length < total but truncated:false
    const underreported = { ...valid(), total: 5 };
    expect(parsePreviewDirListing(underreported, byteLen(underreported))).toBeNull();
    // complete:false but truncated:false (entries === total)
    const incomplete = { ...valid(), complete: false, truncated: false };
    expect(parsePreviewDirListing(incomplete, byteLen(incomplete))).toBeNull();
    // truncated:true while entries === total && complete — claiming a cut that did not happen
    const overreported = { ...valid(), truncated: true, limits: { scan: true, entries: false, bytes: false } };
    expect(parsePreviewDirListing(overreported, byteLen(overreported))).toBeNull();
    // ...while both honest truncated:true shapes parse
    const honestTotal = {
      ...valid(),
      total: 5,
      truncated: true,
      limits: { scan: false, entries: true, bytes: false },
    };
    expect(parsePreviewDirListing(honestTotal, byteLen(honestTotal))?.truncated).toBe(true);
    const honestScan = {
      ...valid(),
      complete: false,
      truncated: true,
      limits: { scan: true, entries: false, bytes: false },
    };
    expect(parsePreviewDirListing(honestScan, byteLen(honestScan))?.truncated).toBe(true);
  });

  it("rejects nonsensical byteLength arguments (never trusts the caller's arithmetic)", () => {
    const raw = valid();
    expect(parsePreviewDirListing(raw, Number.NaN)).toBeNull();
    expect(parsePreviewDirListing(raw, -1)).toBeNull();
    expect(parsePreviewDirListing(raw, 512.5)).toBeNull();
    expect(parsePreviewDirListing(raw, "512" as unknown as number)).toBeNull();
  });

  // One example per §1.1 rejection condition (the boundary conditions — BODY/NAME/ENTRIES/SCAN
  // over-cap — are covered ±1 by the dedicated its above).
  it.each<[string, unknown]>([
    // — top level —
    ["raw is null", null],
    ["raw is an array", []],
    ["raw is a string", '{"entries":[]}'],
    ["raw is a number", 7],
    ["raw is a boolean", true],
    [
      "entries is missing",
      (() => {
        const v = valid();
        delete v.entries;
        return v;
      })(),
    ],
    ["entries is not an array", { ...valid(), entries: "nope" }],
    ["an entry is null", { ...valid(), entries: [null] }],
    ["an entry is a string", { ...valid(), entries: ["file"] }],
    // — entry shape —
    ["name is missing", oneEntry({ type: "file" })],
    ["name is not a string", oneEntry({ name: 42, type: "file" })],
    ["name is empty", oneEntry({ name: "", type: "file" })],
    ['name contains "/"', oneEntry({ name: "a/b", type: "file" })],
    ["name contains NUL", oneEntry({ name: "a\0b", type: "file" })],
    ["type is missing", oneEntry({ name: "a" })],
    ['type is not in the enum ("fifo")', oneEntry({ name: "a", type: "fifo" })],
    ["type is not in the enum (case-sensitive)", oneEntry({ name: "a", type: "Dir" })],
    ["size is negative", oneEntry({ name: "a", type: "file", size: -1 })],
    ["size is a string", oneEntry({ name: "a", type: "file", size: "12" })],
    ["size is Infinity", oneEntry({ name: "a", type: "file", size: Number.POSITIVE_INFINITY })],
    ["size is NaN", oneEntry({ name: "a", type: "file", size: Number.NaN })],
    ["mtimeMs is negative", oneEntry({ name: "a", type: "file", mtimeMs: -0.5 })],
    ["mtimeMs is null", oneEntry({ name: "a", type: "file", mtimeMs: null })],
    ["mtimeMs is a string", oneEntry({ name: "a", type: "file", mtimeMs: "1.7e12" })],
    ["lossy is false (must be literal true)", oneEntry({ name: "a", type: "file", lossy: false })],
    ["lossy is a string", oneEntry({ name: "a", type: "file", lossy: "true" })],
    // — listing counters / flags —
    [
      "total is missing",
      (() => {
        const v = valid();
        delete v.total;
        return v;
      })(),
    ],
    ["total is fractional", { ...valid(), total: 3.5 }],
    ["total is negative", { ...valid(), total: -1 }],
    ["total < entries.length", { ...valid(), total: 2 }],
    [
      "scanned is missing",
      (() => {
        const v = valid();
        delete v.scanned;
        return v;
      })(),
    ],
    ["scanned is NaN", { ...valid(), scanned: Number.NaN }],
    [
      "complete is missing",
      (() => {
        const v = valid();
        delete v.complete;
        return v;
      })(),
    ],
    ["complete is not a boolean", { ...valid(), complete: 1 }],
    [
      "truncated is missing",
      (() => {
        const v = valid();
        delete v.truncated;
        return v;
      })(),
    ],
    ['truncated is the string "false"', { ...valid(), truncated: "false" }],
    [
      "limits is missing",
      (() => {
        const v = valid();
        delete v.limits;
        return v;
      })(),
    ],
    ["limits is a string", { ...valid(), limits: "nope" }],
    ["limits.scan is a string", { ...valid(), limits: { scan: "false", entries: false, bytes: false } }],
    [
      "limits.entries is missing",
      {
        ...valid(),
        limits: { scan: false, bytes: false },
      },
    ],
    ["limits.bytes is 0", { ...valid(), limits: { scan: false, entries: false, bytes: 0 } }],
    ["vanished is negative", { ...valid(), vanished: -1 }],
    ["vanished is fractional", { ...valid(), vanished: 1.5 }],
    [
      "dropped is missing",
      (() => {
        const v = valid();
        delete v.dropped;
        return v;
      })(),
    ],
    ["dropped is NaN", { ...valid(), dropped: Number.NaN }],
  ])("rejects: %s", (_label, raw) => {
    expect(parsePreviewDirListing(raw, byteLen(raw))).toBeNull();
  });
});
