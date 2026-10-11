// @vitest-environment node
import { describe, expect, it } from "vitest";
import { sourceDims } from "../../../src/web-hub/ui/src/logic/avatarSource.js";

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

describe("avatarSource header dimensions", () => {
  it("reads PNG, GIF, WebP VP8X and JPEG SOF headers", () => {
    const png = new Uint8Array(24);
    png.set(
      bytes(
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        0,
        0,
        0,
        0,
        0x49,
        0x48,
        0x44,
        0x52,
        0,
        0,
        0,
        32,
        0,
        0,
        0,
        16,
      ),
    );
    expect(sourceDims(png)).toMatchObject({ ok: true, width: 32, height: 16, format: "png" });
    expect(sourceDims(bytes(71, 73, 70, 56, 57, 97, 32, 0, 16, 0))).toMatchObject({
      ok: true,
      width: 32,
      height: 16,
      format: "gif",
    });
    const webp = new Uint8Array(30);
    webp.set(
      bytes(82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 88, 10, 0, 0, 0, 0, 0, 0, 0, 31, 0, 0, 15, 0),
    );
    expect(sourceDims(webp)).toMatchObject({ ok: true, width: 32, height: 16, format: "webp" });
    const jpeg = bytes(0xff, 0xd8, 0xff, 0xc0, 0, 7, 8, 0, 16, 0, 32);
    expect(sourceDims(jpeg)).toMatchObject({ ok: true, width: 32, height: 16, format: "jpeg" });
  });

  it("rejects truncated recognised headers for every supported format", () => {
    expect(sourceDims(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toEqual({
      ok: false,
      reason: "truncated",
    });
    expect(sourceDims(bytes(71, 73, 70, 56, 57, 97))).toEqual({ ok: false, reason: "truncated" });
    const webp = (type: number[], payload: number[]): Uint8Array =>
      bytes(82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80, ...type, payload.length, 0, 0, 0, ...payload);
    expect(sourceDims(webp([86, 80, 56, 88], [0, 0]))).toEqual({ ok: false, reason: "truncated" });
    expect(sourceDims(webp([86, 80, 56, 76], [0x2f]))).toEqual({ ok: false, reason: "truncated" });
    expect(sourceDims(webp([86, 80, 56, 32], [0, 0, 0, 0, 0]))).toEqual({ ok: false, reason: "truncated" });
    expect(sourceDims(bytes(0xff, 0xd8, 0xff, 0xc0))).toEqual({ ok: false, reason: "truncated" });
  });

  it("does not decode a JPEG whose first SOF lies beyond the one-megabyte scan window", () => {
    const prefix = new Uint8Array(1024 * 1024);
    prefix[0] = 0xff;
    prefix[1] = 0xd8;
    for (let at = 2; at + 3 < prefix.length; at += 4) {
      prefix[at] = 0xff;
      prefix[at + 1] = 0xe0;
      prefix[at + 2] = 0;
      prefix[at + 3] = 2;
    }
    prefix[prefix.length - 2] = 0xff;
    prefix[prefix.length - 1] = 0xd9;
    expect(sourceDims(prefix)).toEqual({ ok: false, reason: "unknown" });
  });

  it("rejects truncated/unknown headers and dimensions over the decode budget", () => {
    expect(sourceDims(bytes(0x89, 0x50))).toEqual({ ok: false, reason: "unknown" });
    const huge = new Uint8Array(24);
    huge.set(
      bytes(
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        0,
        0,
        0,
        0,
        0x49,
        0x48,
        0x44,
        0x52,
        0,
        0,
        0x20,
        1,
        0,
        0,
        0x20,
        1,
      ),
    );
    expect(sourceDims(huge)).toEqual({ ok: false, reason: "dims" });
    expect(sourceDims(bytes(1, 2, 3))).toEqual({ ok: false, reason: "unknown" });
  });
});
