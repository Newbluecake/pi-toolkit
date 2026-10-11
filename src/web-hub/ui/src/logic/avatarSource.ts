/** Pure, allocation-light image header parser used before browser decoding.
 *
 * It deliberately only reads a bounded prefix.  The result is a claim from the
 * container header, not proof that the image is decodable; useAvatarEditor checks
 * the decoded bitmap again before it draws anything.
 */

export const AVATAR_SOURCE_HEADER_BYTES = 1024 * 1024;
export const AVATAR_SOURCE_MAX_SIDE = 8192;
export const AVATAR_SOURCE_MAX_PIXELS = 16_000_000;
export const AVATAR_SOURCE_MAX_FILE_BYTES = 20 * 1024 * 1024;

export type AvatarSourceFormat = "png" | "gif" | "webp" | "jpeg";
export interface AvatarSourceDims {
  readonly ok: true;
  readonly width: number;
  readonly height: number;
  readonly format: AvatarSourceFormat;
}
export interface AvatarSourceError {
  readonly ok: false;
  readonly reason: "unknown" | "truncated" | "dims";
}
export type AvatarSourceResult = AvatarSourceDims | AvatarSourceError;

function u16(b: Uint8Array, at: number): number {
  return ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
}
function u16le(b: Uint8Array, at: number): number {
  return (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
}
function u24le(b: Uint8Array, at: number): number {
  return (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16);
}
function u32le(b: Uint8Array, at: number): number {
  return ((b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16) | ((b[at + 3] ?? 0) << 24)) >>> 0;
}
function u32be(b: Uint8Array, at: number): number {
  return ((b[at] ?? 0) * 0x1000000 + (b[at + 1] ?? 0) * 0x10000 + (b[at + 2] ?? 0) * 0x100 + (b[at + 3] ?? 0)) >>> 0;
}
function ascii(b: Uint8Array, at: number, text: string): boolean {
  for (let i = 0; i < text.length; i += 1) if (b[at + i] !== text.charCodeAt(i)) return false;
  return true;
}
function checked(format: AvatarSourceFormat, width: number, height: number): AvatarSourceResult {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
    return { ok: false, reason: "dims" };
  if (width > AVATAR_SOURCE_MAX_SIDE || height > AVATAR_SOURCE_MAX_SIDE || width * height > AVATAR_SOURCE_MAX_PIXELS) {
    return { ok: false, reason: "dims" };
  }
  return { ok: true, width, height, format };
}

function png(b: Uint8Array): AvatarSourceResult {
  if (b.length < 24) return { ok: false, reason: "truncated" };
  return checked("png", u32be(b, 16), u32be(b, 20));
}
function gif(b: Uint8Array): AvatarSourceResult {
  if (b.length < 10) return { ok: false, reason: "truncated" };
  return checked("gif", u16le(b, 6), u16le(b, 8));
}
function webp(b: Uint8Array): AvatarSourceResult {
  if (b.length < 16) return { ok: false, reason: "truncated" };
  // Walk chunks.  VP8X is the preferred, fixed-width header.  The other two
  // forms are supported because camera software still emits them frequently.
  let at = 12;
  while (at + 8 <= b.length) {
    const size = u32le(b, at + 4);
    const data = at + 8;
    if (size > b.length - data) return { ok: false, reason: "truncated" };
    if (ascii(b, at, "VP8X")) {
      if (size < 10) return { ok: false, reason: "truncated" };
      return checked("webp", 1 + u24le(b, data + 4), 1 + u24le(b, data + 7));
    }
    if (ascii(b, at, "VP8 ")) {
      if (size < 10 || data + 10 > b.length) return { ok: false, reason: "truncated" };
      // Key-frame start code ff 01 2a, followed by little-endian dimensions.
      if (b[data + 3] !== 0x9d || b[data + 4] !== 0x01 || b[data + 5] !== 0x2a) return { ok: false, reason: "unknown" };
      return checked("webp", u16le(b, data + 6) & 0x3fff, u16le(b, data + 8) & 0x3fff);
    }
    if (ascii(b, at, "VP8L")) {
      if (size < 5) return { ok: false, reason: "truncated" };
      if (b[data] !== 0x2f) return { ok: false, reason: "unknown" };
      const bits =
        (b[data + 1] ?? 0) | ((b[data + 2] ?? 0) << 8) | ((b[data + 3] ?? 0) << 16) | ((b[data + 4] ?? 0) << 24);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >>> 14) & 0x3fff) + 1;
      return checked("webp", width, height);
    }
    at += 8 + size + (size & 1);
  }
  return { ok: false, reason: "unknown" };
}

function jpeg(b: Uint8Array): AvatarSourceResult {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return { ok: false, reason: "unknown" };
  let at = 2;
  while (at < b.length) {
    while (at < b.length && b[at] === 0xff) at += 1;
    if (at >= b.length) return { ok: false, reason: "truncated" };
    const marker = b[at++] ?? 0;
    if (marker === 0xd9 || marker === 0xda) return { ok: false, reason: "unknown" };
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (at + 2 > b.length) return { ok: false, reason: "truncated" };
    const length = u16(b, at);
    if (length < 2 || at + length > b.length) return { ok: false, reason: "truncated" };
    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15.
    const sof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (sof) {
      if (length < 7) return { ok: false, reason: "truncated" };
      return checked("jpeg", u16(b, at + 5), u16(b, at + 3));
    }
    at += length;
  }
  return { ok: false, reason: "unknown" };
}

/** Parse dimensions from at most the supplied header prefix. */
export function sourceDims(bytes: Uint8Array): AvatarSourceResult {
  try {
    if (bytes.length >= 8 && ascii(bytes, 0, "\x89PNG\r\n\x1a\n")) return png(bytes);
    if (bytes.length >= 6 && (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a"))) return gif(bytes);
    if (bytes.length >= 12 && ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return webp(bytes);
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpeg(bytes);
    return { ok: false, reason: bytes.length < 2 ? "truncated" : "unknown" };
  } catch {
    return { ok: false, reason: "truncated" };
  }
}

export function sourceFileAccepted(file: { readonly size: number }): boolean {
  return Number.isFinite(file.size) && file.size >= 0 && file.size <= AVATAR_SOURCE_MAX_FILE_BYTES;
}
