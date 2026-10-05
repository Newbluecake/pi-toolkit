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
  PREVIEW_ADMIT_TOTAL_MS,
  PREVIEW_CLIENT_PIXELS_COARSE,
  PREVIEW_CLIENT_TIMEOUT_MS,
  PREVIEW_DEFAULT_MODE,
  PREVIEW_HDR,
  PREVIEW_IMAGE_MAX_BYTES,
  PREVIEW_IMAGE_MAX_PIXELS,
  PREVIEW_JPEG_SCAN_MAX_BYTES,
  PREVIEW_PATH,
  PREVIEW_PATH_MAX_BYTES,
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
