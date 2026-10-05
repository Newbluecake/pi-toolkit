/**
 * web-hub content-preview — content sniffing (web-hub-preview plan v3 §4.4, PV2a).
 *
 * Pure, `node:*`-free: the caller (PV3 routes, §3.1 ⑧) reads the `min(size, 64 KiB)` sample —
 * continuing up to `PREVIEW_JPEG_SCAN_MAX_BYTES` while `needsMoreForDims` says so — and this
 * module turns those bytes into the kind/mime/dims decision. Magic numbers ONLY: file
 * extensions and any recorded `meta.mime` never participate (a ".png" of HTML text is text; a
 * ".txt" starting with the PNG magic is an image; a GIF+JS polyglot is an image). Dims come
 * from the format's own header structures; `dims === null` means the caller must reject with
 * 415 `dims-unknown` (P1-6: an image whose size cannot be parsed is never streamed).
 */

import {
  PREVIEW_JPEG_SCAN_MAX_BYTES,
  PREVIEW_SNIFF_TEXT_BYTES,
  type PreviewImageMime,
} from "../../protocol/preview.js";

export type SniffResult =
  | { kind: "image"; mime: PreviewImageMime; dims: { w: number; h: number } | null }
  | { kind: "text" }
  | { kind: "binary" };

// ---------------------------------------------------------------------------
// magic numbers
// ---------------------------------------------------------------------------

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_MAGIC = [0xff, 0xd8, 0xff] as const;
const GIF87_MAGIC = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] as const; // "GIF87a"
const GIF89_MAGIC = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] as const; // "GIF89a"

function startsWith(b: Uint8Array, magic: readonly number[]): boolean {
  if (b.length < magic.length) return false;
  for (let i = 0; i < magic.length; i += 1) {
    if (b[i] !== magic[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// little/big-endian readers
// ---------------------------------------------------------------------------

function u16le(b: Uint8Array, off: number): number | undefined {
  if (off + 2 > b.length) return undefined;
  return b[off]! | (b[off + 1]! << 8);
}

function u24le(b: Uint8Array, off: number): number | undefined {
  if (off + 3 > b.length) return undefined;
  return b[off]! | (b[off + 1]! << 8) | (b[off + 2]! << 16);
}

function u16be(b: Uint8Array, off: number): number | undefined {
  if (off + 2 > b.length) return undefined;
  return (b[off]! << 8) | b[off + 1]!;
}

function u32be(b: Uint8Array, off: number): number | undefined {
  if (off + 4 > b.length) return undefined;
  return ((b[off]! << 24) | (b[off + 1]! << 16) | (b[off + 2]! << 8) | b[off + 3]!) >>> 0;
}

/** `0`-sized dimensions mean a corrupt header — treat exactly like unparseable (`null`). */
function dimsOrNull(w: number | undefined, h: number | undefined): { w: number; h: number } | null {
  if (w === undefined || h === undefined || w <= 0 || h <= 0) return null;
  return { w, h };
}

// ---------------------------------------------------------------------------
// per-format dimension parsing
// ---------------------------------------------------------------------------

/** PNG: IHDR is the mandatory first chunk — width/height at fixed offsets 16/20. */
function pngDims(b: Uint8Array): { w: number; h: number } | null {
  return dimsOrNull(u32be(b, 16), u32be(b, 20));
}

/** GIF: logical screen descriptor, width/height u16le at offsets 6/8. */
function gifDims(b: Uint8Array): { w: number; h: number } | null {
  return dimsOrNull(u16le(b, 6), u16le(b, 8));
}

/** WebP: first chunk after the 12-byte RIFF/WEBP header is `VP8X`/`VP8 `/`VP8L`. */
function webpDims(b: Uint8Array): { w: number; h: number } | null {
  const chunkAt = 12;
  if (b.length < chunkAt + 8) return null;
  const fourcc = String.fromCharCode(b[chunkAt]!, b[chunkAt + 1]!, b[chunkAt + 2]!, b[chunkAt + 3]!);
  const payload = chunkAt + 8;
  if (fourcc === "VP8X") {
    // 4 bytes flags/reserved, then canvas width-1 / height-1 as 24-bit LE
    const w = u24le(b, payload + 4);
    const h = u24le(b, payload + 7);
    return dimsOrNull(w === undefined ? undefined : w + 1, h === undefined ? undefined : h + 1);
  }
  if (fourcc === "VP8L") {
    // 1-byte 0x2F signature, then width-1 (14 bits) | height-1 (14 bits) | alpha | version
    if (b[payload] !== 0x2f) return null;
    const bits = u24le(b, payload + 1);
    const bitsHi = b[payload + 4];
    if (bits === undefined || bitsHi === undefined) return null;
    const w1 = bits & 0x3fff;
    const h1 = (bits >>> 14) | ((bitsHi & 0x0f) << 10); // 14 bits starting at bit 14
    return dimsOrNull(w1 + 1, h1 + 1);
  }
  if (fourcc === "VP8 ") {
    // lossy: 3-byte frame tag, 3-byte start code, then 14-bit width / height
    const w = u16le(b, payload + 6);
    const h = u16le(b, payload + 8);
    if (w === undefined || h === undefined) return null;
    return dimsOrNull(w & 0x3fff, h & 0x3fff);
  }
  return null;
}

/** SOF0–SOF15 markers, minus the non-SOF residents of the C0–CF range (C4/C8/CC). */
function isSofMarker(m: number): boolean {
  return m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
}

/**
 * JPEG: walk the marker stream from offset 2 — FF (padding FFs allowed) marker, 2-byte BE
 * segment length, skip — until a SOF marker yields height/width, or EOI/truncation gives up.
 * This is the scan `needsMoreForDims` drives: a SOF past the current sample simply reads as
 * "not found yet" and the caller keeps reading (up to `PREVIEW_JPEG_SCAN_MAX_BYTES`).
 */
function jpegDims(b: Uint8Array): { w: number; h: number } | null {
  let i = 2;
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) {
      i += 1;
      continue;
    }
    let m = b[i + 1]!;
    let segAt = i + 2;
    while (m === 0xff && segAt < b.length) {
      // fill bytes: FF FF <marker>
      m = b[segAt]!;
      segAt += 1;
    }
    if (m === 0x00 || m === 0xff) {
      // stuffed byte or trailing fill — not a marker boundary
      i += m === 0xff ? 1 : 2;
      continue;
    }
    if (m === 0xd8 || m === 0xd9) {
      return null; // SOI again / EOI before any SOF — corrupt or dimension-less stream
    }
    if (m >= 0xd0 && m <= 0xd7) {
      i = segAt; // RST: standalone, no length payload
      continue;
    }
    const len = u16be(b, segAt);
    if (len === undefined) return null; // truncated length — caller may extend the sample
    if (isSofMarker(m)) {
      const h = u16be(b, segAt + 3);
      const w = u16be(b, segAt + 5);
      return dimsOrNull(w, h);
    }
    i = segAt + len;
  }
  return null;
}

// ---------------------------------------------------------------------------
// text decision (§4.4: first 8 KiB; empty file IS text; UTF-16 is binary; SVG is text)
// ---------------------------------------------------------------------------

const utf8DecoderFactory = () => new TextDecoder("utf-8", { fatal: true });

function looksLikeText(sample: Uint8Array, totalSize: number): boolean {
  if (totalSize === 0) return true; // 空文件视为文本
  const headEnd = Math.min(sample.length, PREVIEW_SNIFF_TEXT_BYTES);
  let start = 0;
  if (headEnd >= 2 && sample[0] === 0xff && sample[1] === 0xfe) return false; // UTF-16LE BOM
  if (headEnd >= 2 && sample[0] === 0xfe && sample[1] === 0xff) return false; // UTF-16BE BOM
  if (headEnd >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) start = 3; // UTF-8 BOM
  const head = sample.subarray(start, headEnd);
  for (let i = 0; i < head.length; i += 1) {
    if (head[i] === 0x00) return false; // NUL ⇒ binary (also catches unmarked UTF-16 ASCII)
  }
  let text: string;
  try {
    // `stream: true` so a multi-byte character straddling the 8 KiB head boundary is carried
    // over instead of fatally failing the decode (fresh decoder per call — stream state must
    // never leak between calls)
    text = utf8DecoderFactory().decode(head, { stream: true });
  } catch {
    return false; // invalid UTF-8 ⇒ binary
  }
  let controls = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    const isControl = (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f || (c >= 0x80 && c <= 0x9f);
    if (isControl) controls += 1;
  }
  return text.length === 0 || controls / text.length <= 0.02;
}

// ---------------------------------------------------------------------------
// public surface
// ---------------------------------------------------------------------------

export function sniff(sample: Uint8Array, totalSize: number): SniffResult {
  if (startsWith(sample, PNG_MAGIC)) return { kind: "image", mime: "image/png", dims: pngDims(sample) };
  if (startsWith(sample, JPEG_MAGIC)) return { kind: "image", mime: "image/jpeg", dims: jpegDims(sample) };
  if (startsWith(sample, GIF87_MAGIC) || startsWith(sample, GIF89_MAGIC)) {
    return { kind: "image", mime: "image/gif", dims: gifDims(sample) };
  }
  if (
    sample.length >= 12 &&
    String.fromCharCode(sample[0]!, sample[1]!, sample[2]!, sample[3]!) === "RIFF" &&
    String.fromCharCode(sample[8]!, sample[9]!, sample[10]!, sample[11]!) === "WEBP"
  ) {
    return { kind: "image", mime: "image/webp", dims: webpDims(sample) };
  }
  return looksLikeText(sample, totalSize) ? { kind: "text" } : { kind: "binary" };
}

/**
 * §3.1 ⑧'s JPEG continuation rule: keep reading only while the sample is a JPEG whose SOF has
 * not appeared yet AND the scan cap has not been reached. Every other format resolves (or
 * permanently fails) within the initial 64 KiB sample — a JPEG with its SOF past 256 KiB stays
 * `dims: null` and the caller rejects with `dims-unknown`.
 */
export function needsMoreForDims(sample: Uint8Array): boolean {
  if (!startsWith(sample, JPEG_MAGIC)) return false;
  if (sample.length >= PREVIEW_JPEG_SCAN_MAX_BYTES) return false;
  return jpegDims(sample) === null;
}

/**
 * Largest cut `<= maxLen` that never splits a UTF-8 multi-byte sequence (§0: text truncation
 * happens on a CHARACTER boundary). Walks back over continuation bytes (`10xxxxxx`); then,
 * if the last INCLUDED byte is itself a lead byte (`11xxxxxx`) whose continuations lie at or
 * after the cut — the case where the read itself truncated the character mid-sequence — the
 * dangling lead is dropped too, so the served prefix is always valid UTF-8 on its own.
 */
export function utf8SafeCut(buf: Uint8Array, maxLen: number): number {
  const limit = Math.min(maxLen, buf.length);
  if (limit <= 0) return 0;
  let cut = limit;
  while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut -= 1;
  if (cut > 0 && (buf[cut - 1]! & 0xc0) === 0xc0) cut -= 1;
  return cut;
}
