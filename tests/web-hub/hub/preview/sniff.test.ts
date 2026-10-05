/**
 * web-hub-preview plan v3 §4.4 / PV2a acceptance — `hub/preview/sniff.ts` (pure functions).
 *
 * Covers: magic numbers, truncation, RIFF-but-not-WEBP, empty file, BOMs, multi-byte chars
 * straddling the 8 KiB sniff boundary, NUL, control-char ratio 1.9%/2.1%, UTF-16, SVG, dims
 * for all four formats, JPEG SOF at 200 KiB (found via continued read) and 300 KiB+ (never
 * found), and the four masquerade cases (magic wins; extensions/meta.mime never consulted).
 */

import { describe, expect, it } from "vitest";
import { needsMoreForDims, sniff, utf8SafeCut } from "../../../../src/web-hub/hub/preview/sniff.js";
import { PREVIEW_JPEG_SCAN_MAX_BYTES, PREVIEW_SNIFF_TEXT_BYTES } from "../../../../src/web-hub/protocol/preview.js";

const KIB = 1024;

// ---------------------------------------------------------------------------
// fixture builders
// ---------------------------------------------------------------------------

function pngFixture(w: number, h: number, pad = 0): Buffer {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25); // 4 len + 4 "IHDR" + 13 data + 4 crc
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(w, 8); // IHDR data starts at buffer offset 8
  ihdr.writeUInt32BE(h, 12);
  return Buffer.concat([head, ihdr, Buffer.alloc(pad)]);
}

function gifFixture(w: number, h: number, version: "87a" | "89a" = "89a", tail = ""): Buffer {
  const b = Buffer.from(`GIF${version}`, "ascii");
  const dims = Buffer.alloc(4);
  dims.writeUInt16LE(w, 0);
  dims.writeUInt16LE(h, 2);
  return Buffer.concat([b, dims, Buffer.from(tail, "utf8")]);
}

function riffWebp(payload: Buffer, fourcc: string): Buffer {
  const riffLen = Buffer.alloc(4);
  riffLen.writeUInt32LE(4 + 8 + payload.length, 0);
  const chunkHeader = Buffer.from(fourcc, "ascii");
  const chunkLen = Buffer.alloc(4);
  chunkLen.writeUInt32LE(payload.length, 0);
  return Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    riffLen,
    Buffer.from("WEBP", "ascii"),
    chunkHeader,
    chunkLen,
    payload,
  ]);
}

function webpLossless(w: number, h: number): Buffer {
  const payload = Buffer.alloc(5);
  payload[0] = 0x2f;
  const bits = (w - 1) | ((h - 1) << 14);
  payload.writeUIntLE(bits, 1, 4); // 14+14 bits fit in 4 LE bytes
  return riffWebp(payload, "VP8L");
}

function webpExtended(w: number, h: number): Buffer {
  const payload = Buffer.alloc(10);
  payload.writeUIntLE(w - 1, 4, 3);
  payload.writeUIntLE(h - 1, 7, 3);
  return riffWebp(payload, "VP8X");
}

function webpLossy(w: number, h: number): Buffer {
  const payload = Buffer.alloc(10);
  payload[0] = 0x00; // keyframe frame tag
  payload[3] = 0x9d;
  payload[4] = 0x01;
  payload[5] = 0x2a;
  payload.writeUInt16LE(w, 6);
  payload.writeUInt16LE(h, 8);
  return riffWebp(payload, "VP8 ");
}

/** JPEG whose SOF0 lands at ~`sofAtBytes` (padded with APP1 segments), plus optional C4/C8/CC
 * decoys before the SOF. */
function jpegFixture(sofAtBytes: number, decoys = false): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8, 0xff])];
  let pos = 3;
  if (decoys) {
    for (const marker of [0xc4, 0xc8, 0xcc]) {
      const seg = Buffer.alloc(6);
      seg[0] = 0xff;
      seg[1] = marker;
      seg.writeUInt16BE(6, 2); // len includes itself
      parts.push(seg);
      pos += 6;
    }
  }
  while (pos < sofAtBytes) {
    const room = Math.min(65535, sofAtBytes - pos);
    const seg = Buffer.alloc(room);
    seg[0] = 0xff;
    seg[1] = 0xe1; // APP1
    seg.writeUInt16BE(room, 2);
    parts.push(seg);
    pos += room;
  }
  const sof = Buffer.alloc(11); // FF C0 len(2) prec(1) h(2) w(2)
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(11, 2);
  sof[4] = 8;
  sof.writeUInt16BE(4321, 5); // height
  sof.writeUInt16BE(1234, 7); // width
  parts.push(sof, Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

function textHead(len: number, controls: number, controlByte = 0x01): Buffer {
  const b = Buffer.alloc(len, 0x61);
  for (let i = 0; i < controls; i += 1) b[i] = controlByte;
  return b;
}

// ---------------------------------------------------------------------------
// magic numbers & dims
// ---------------------------------------------------------------------------

describe("sniff: image magic + dims", () => {
  it("PNG magic → image/png with IHDR dims", () => {
    expect(sniff(pngFixture(640, 480), 100)).toEqual({ kind: "image", mime: "image/png", dims: { w: 640, h: 480 } });
  });

  it("GIF87a and GIF89a → image/gif with logical-screen dims", () => {
    expect(sniff(gifFixture(800, 600, "87a"), 100)).toEqual({
      kind: "image",
      mime: "image/gif",
      dims: { w: 800, h: 600 },
    });
    expect(sniff(gifFixture(8, 8, "89a", "//payload"), 100)).toEqual({
      kind: "image",
      mime: "image/gif",
      dims: { w: 8, h: 8 },
    });
  });

  it("WebP VP8L/VP8X/VP8 all parse dims", () => {
    expect(sniff(webpLossless(385, 210), 100)).toEqual({ kind: "image", mime: "image/webp", dims: { w: 385, h: 210 } });
    expect(sniff(webpExtended(4096, 2160), 100)).toEqual({
      kind: "image",
      mime: "image/webp",
      dims: { w: 4096, h: 2160 },
    });
    expect(sniff(webpLossy(320, 240), 100)).toEqual({ kind: "image", mime: "image/webp", dims: { w: 320, h: 240 } });
  });

  it("JPEG magic → image/jpeg with SOF dims (C4/C8/CC skipped)", () => {
    const buf = jpegFixture(64, true);
    expect(sniff(buf, buf.length)).toEqual({ kind: "image", mime: "image/jpeg", dims: { w: 1234, h: 4321 } });
  });

  it("truncated magic → no image match (falls through to text/binary)", () => {
    expect(sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 4)).toEqual({ kind: "binary" });
    expect(sniff(Buffer.from("GIF", "ascii"), 3)).toEqual({ kind: "text" }); // "GIF" is plain text
  });

  it("image magic with truncated dims header → dims null (caller rejects dims-unknown)", () => {
    expect(sniff(pngFixture(1, 1).subarray(0, 12), 12)).toEqual({ kind: "image", mime: "image/png", dims: null });
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff]), 3)).toEqual({ kind: "image", mime: "image/jpeg", dims: null });
  });

  it("RIFF but not WEBP → not an image (WAV head is binary)", () => {
    const wav = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.alloc(4),
      Buffer.from("WAVEfmt ", "ascii"),
      Buffer.from([0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00]),
    ]);
    expect(sniff(wav, wav.length)).toEqual({ kind: "binary" });
  });

  it("zero dims parse as null (corrupt header = dims-unknown, never served)", () => {
    expect(sniff(gifFixture(0, 5), 10)).toEqual({ kind: "image", mime: "image/gif", dims: null });
    expect(sniff(pngFixture(0, 4).subarray(0, 33), 33)).toEqual({ kind: "image", mime: "image/png", dims: null });
  });
});

// ---------------------------------------------------------------------------
// JPEG continuation tiers (200 KiB / 300 KiB+)
// ---------------------------------------------------------------------------

describe("sniff: JPEG SOF scan tiers", () => {
  it("SOF at ~200 KiB: dims not in the 64 KiB sample, found at the 256 KiB scan cap", () => {
    const buf = jpegFixture(200 * KIB);
    const firstSample = buf.subarray(0, 64 * KIB);
    expect(sniff(firstSample, buf.length)).toEqual({ kind: "image", mime: "image/jpeg", dims: null });
    expect(needsMoreForDims(firstSample)).toBe(true);
    const fullScan = buf.subarray(0, Math.min(buf.length, PREVIEW_JPEG_SCAN_MAX_BYTES));
    expect(fullScan.length).toBeGreaterThanOrEqual(200 * KIB + 11);
    const res = sniff(fullScan, buf.length);
    expect(res).toEqual({ kind: "image", mime: "image/jpeg", dims: { w: 1234, h: 4321 } });
    expect(needsMoreForDims(fullScan)).toBe(false);
  });

  it("SOF beyond 300 KiB: the scan cap gives up — dims stay null, no more reads requested", () => {
    const buf = jpegFixture(300 * KIB + 1234);
    const scan = buf.subarray(0, PREVIEW_JPEG_SCAN_MAX_BYTES);
    const res = sniff(scan, buf.length);
    expect(res.kind === "image" && res.mime === "image/jpeg").toBe(true);
    if (res.kind === "image") expect(res.dims).toBeNull();
    expect(needsMoreForDims(scan)).toBe(false); // cap reached — caller must reject dims-unknown
  });
});

// ---------------------------------------------------------------------------
// text decision
// ---------------------------------------------------------------------------

describe("sniff: text decision", () => {
  it("empty file is text", () => {
    expect(sniff(Buffer.alloc(0), 0)).toEqual({ kind: "text" });
  });

  it("plain ASCII / UTF-8 text is text; SVG is text (D8: not an image format)", () => {
    expect(sniff(Buffer.from("hello, world\n"), 13)).toEqual({ kind: "text" });
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>', "utf8");
    expect(sniff(svg, svg.length)).toEqual({ kind: "text" });
  });

  it("UTF-8 BOM is stripped and still text", () => {
    const b = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("héllo", "utf8")]);
    expect(sniff(b, b.length)).toEqual({ kind: "text" });
  });

  it("UTF-16 (BOM both orders, or NUL-bearing) is binary", () => {
    const le = Buffer.from([0xff, 0xfe, 0x61, 0x00, 0x62, 0x00]);
    const be = Buffer.from([0xfe, 0xff, 0x00, 0x61, 0x00, 0x62]);
    const noBom = Buffer.from([0x61, 0x00, 0x62, 0x00]);
    for (const b of [le, be, noBom]) expect(sniff(b, b.length)).toEqual({ kind: "binary" });
  });

  it("a multi-byte char straddling the 8 KiB head boundary stays text (stream decode)", () => {
    const b = Buffer.concat([Buffer.alloc(PREVIEW_SNIFF_TEXT_BYTES - 1, 0x61), Buffer.from("ébc", "utf8")]);
    expect(b[PREVIEW_SNIFF_TEXT_BYTES - 1]).toBe(0xc3); // é straddles the boundary
    expect(sniff(b, b.length + 100)).toEqual({ kind: "text" });
  });

  it("invalid UTF-8 is binary", () => {
    const b = Buffer.concat([Buffer.alloc(100, 0x61), Buffer.from([0xc3, 0x28])]);
    expect(sniff(b, b.length)).toEqual({ kind: "binary" });
  });

  it("NUL anywhere in the head is binary", () => {
    const b = Buffer.alloc(100, 0x61);
    b[50] = 0x00;
    expect(sniff(b, b.length)).toEqual({ kind: "binary" });
  });

  it("control-char ratio: 1.9% is text, 2.1% is binary (tab/LF/CR exempt)", () => {
    const okHead = textHead(PREVIEW_SNIFF_TEXT_BYTES, Math.floor(PREVIEW_SNIFF_TEXT_BYTES * 0.019));
    const badHead = textHead(PREVIEW_SNIFF_TEXT_BYTES, Math.ceil(PREVIEW_SNIFF_TEXT_BYTES * 0.021));
    expect(sniff(okHead, okHead.length + 500)).toEqual({ kind: "text" });
    expect(sniff(badHead, badHead.length + 500)).toEqual({ kind: "binary" });
    const withWhitespaceControls = textHead(8 * KIB, Math.floor(8 * KIB * 0.019), 0x0a);
    expect(sniff(withWhitespaceControls, 16 * KIB)).toEqual({ kind: "text" }); // LF never counts
  });
});

// ---------------------------------------------------------------------------
// masquerades — magic only, extensions never consulted
// ---------------------------------------------------------------------------

describe("sniff: masquerades (伪装)", () => {
  it("text masquerading as PNG (PNG magic + ASCII payload) → image/png", () => {
    const b = Buffer.concat([pngFixture(2, 3).subarray(0, 25), Buffer.from("just text pretending", "utf8")]);
    expect(sniff(b, b.length)).toEqual({ kind: "image", mime: "image/png", dims: { w: 2, h: 3 } });
  });

  it("PNG bytes are an image regardless of what the caller calls the file", () => {
    const b = pngFixture(10, 10);
    expect(sniff(b, b.length)?.kind).toBe("image");
  });

  it("HTML masquerading as an image (no image magic) → text", () => {
    const html = Buffer.from("<!doctype html><html><body>hi</body></html>", "utf8");
    expect(sniff(html, html.length)).toEqual({ kind: "text" });
  });

  it("GIF+JS polyglot → image/gif (magic wins; the JS is just payload)", () => {
    const b = Buffer.concat([gifFixture(1, 1), Buffer.from("//alert(1)\nGIF89a", "utf8")]);
    expect(sniff(b, b.length)).toEqual({ kind: "image", mime: "image/gif", dims: { w: 1, h: 1 } });
  });
});

// ---------------------------------------------------------------------------
// utf8SafeCut
// ---------------------------------------------------------------------------

describe("utf8SafeCut", () => {
  it("cuts never split multi-byte sequences", () => {
    expect(utf8SafeCut(Buffer.from("aé", "utf8"), 2)).toBe(1); // é starts at 1, needs 2 bytes
    expect(utf8SafeCut(Buffer.from("aé", "utf8"), 3)).toBe(3);
    expect(utf8SafeCut(Buffer.from("aé", "utf8"), 100)).toBe(3);
    expect(utf8SafeCut(Buffer.from("ab", "utf8"), 1)).toBe(1);
  });

  it("a 4-byte emoji at the boundary is dropped whole", () => {
    const b = Buffer.from("😀b", "utf8"); // 4 + 1 bytes
    expect(b.length).toBe(5);
    expect(utf8SafeCut(b, 4)).toBe(4);
    expect(utf8SafeCut(b, 3)).toBe(0);
    expect(utf8SafeCut(b, 5)).toBe(5);
  });

  it("degenerate inputs", () => {
    expect(utf8SafeCut(Buffer.alloc(0), 10)).toBe(0);
    expect(utf8SafeCut(Buffer.from("abc"), 0)).toBe(0);
  });
});
