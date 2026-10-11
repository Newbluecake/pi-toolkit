import { AVATAR_MAX_BYTES, AVATAR_MAX_SIDE, AVATAR_MIN_SIDE, type AvatarPngValidation } from "./avatar.js";

/** PNG's fixed eight-byte signature. Exported for hub-side validators/tests. */
export const AVATAR_PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const MAX_CHUNKS = 64;
const IHDR_LENGTH = 13;
const IEND_LENGTH = 0;
const APNG_CHUNKS = new Set(["acTL", "fcTL", "fdAT"]);
const AUX_LENGTHS: Readonly<Record<string, readonly number[]>> = {
  sRGB: [1],
  gAMA: [4],
  cHRM: [32],
  pHYs: [9],
  sBIT: [3, 4],
  bKGD: [6],
  tRNS: [6],
};

/**
 * Validate the structural PNG subset accepted by the avatar protocol.
 *
 * This is intentionally a chunk walk only.  The hub's Node-only validator is
 * responsible for inflating IDAT and proving that exactly one zlib stream is
 * fully consumed and has the expected output length.
 */
export function validateAvatarPng(bytes: Uint8Array): AvatarPngValidation {
  try {
    if (bytes.length > AVATAR_MAX_BYTES) return { ok: false, reason: "size" };
    if (bytes.length < AVATAR_PNG_SIGNATURE.length || !matchesSignature(bytes)) {
      return { ok: false, reason: "signature" };
    }

    let offset = AVATAR_PNG_SIGNATURE.length;
    let chunks = 0;
    let sawIhdr = false;
    let sawIdat = false;
    let idatClosed = false;
    let sawIend = false;
    let side = 0;
    let colorType: number | undefined;
    const seenAux = new Set<string>();

    while (offset < bytes.length) {
      // IEND is a semantic terminator.  A complete chunk after it is an order
      // violation; arbitrary bytes after it are trailing bytes.
      if (sawIend) {
        return isCompleteChunkAt(bytes, offset) ? { ok: false, reason: "order" } : { ok: false, reason: "trailing" };
      }

      if (bytes.length - offset < 12) return { ok: false, reason: "chunk" };
      const length = readU32(bytes, offset);
      if (length > 0x7fffffff || length > bytes.length - offset - 12) {
        return { ok: false, reason: "chunk" };
      }

      const typeOffset = offset + 4;
      if (!isAsciiChunkType(bytes, typeOffset)) return { ok: false, reason: "chunk" };
      const type = chunkType(bytes, typeOffset);
      const dataOffset = typeOffset + 4;
      const crcOffset = dataOffset + length;
      const data = bytes.subarray(dataOffset, crcOffset);
      const expectedCrc = readU32(bytes, crcOffset);
      if (crc32(bytes, typeOffset, 4 + length) !== expectedCrc) {
        return { ok: false, reason: "crc" };
      }
      offset = crcOffset + 4;
      chunks += 1;
      if (chunks > MAX_CHUNKS) return { ok: false, reason: "chunk" };

      if (!sawIhdr) {
        if (type !== "IHDR") return { ok: false, reason: "ihdr" };
        if (length !== IHDR_LENGTH) return { ok: false, reason: "ihdr" };
        const width = readU32(data, 0);
        const height = readU32(data, 4);
        if (width !== height || width < AVATAR_MIN_SIDE || width > AVATAR_MAX_SIDE) {
          return { ok: false, reason: "dims" };
        }
        side = width;
        colorType = data[9];
        if (
          data[8] !== 8 ||
          (colorType !== 2 && colorType !== 6) ||
          data[10] !== 0 ||
          data[11] !== 0 ||
          data[12] !== 0
        ) {
          return { ok: false, reason: "color" };
        }
        sawIhdr = true;
        continue;
      }

      if (type === "IHDR") return { ok: false, reason: "ihdr" };
      if (APNG_CHUNKS.has(type)) return { ok: false, reason: "animated" };

      if (type === "IDAT") {
        if (idatClosed) return { ok: false, reason: "order" };
        sawIdat = true;
        continue;
      }

      if (type === "IEND") {
        if (length !== IEND_LENGTH) return { ok: false, reason: "chunk" };
        // A terminal IEND with no IDAT is the syntactically complete "no
        // image data" case.  If anything follows it, however, IEND occurred
        // before the required IDAT and is an ordering violation.
        if (!sawIdat && offset < bytes.length) return { ok: false, reason: "order" };
        sawIend = true;
        continue;
      }

      if (sawIdat) {
        idatClosed = true;
        // Any non-IDAT chunk after the first IDAT closes the IDAT run.  An
        // auxiliary chunk after it is specifically an ordering error; all
        // other names are outside the whitelist.
        if (Object.prototype.hasOwnProperty.call(AUX_LENGTHS, type)) {
          return { ok: false, reason: "order" };
        }
      }

      const lengths = AUX_LENGTHS[type];
      if (lengths === undefined) return { ok: false, reason: "chunk" };
      if (seenAux.has(type) || !lengths.includes(length)) return { ok: false, reason: "chunk" };
      if (type === "tRNS" && colorType !== 2) return { ok: false, reason: "chunk" };
      seenAux.add(type);
    }

    if (!sawIend) return { ok: false, reason: "order" };
    if (!sawIdat) return { ok: false, reason: "idat" };
    return { ok: true, side };
  } catch {
    // The browser and hub both call this on untrusted bytes.  Detached buffers,
    // hostile array-like objects, and malformed fuzz inputs must never escape.
    return { ok: false, reason: "chunk" };
  }
}

function matchesSignature(bytes: Uint8Array): boolean {
  for (let i = 0; i < AVATAR_PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== AVATAR_PNG_SIGNATURE[i]) return false;
  }
  return true;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      (bytes[offset + 1] ?? 0) * 0x10000 +
      (bytes[offset + 2] ?? 0) * 0x100 +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function isAsciiChunkType(bytes: Uint8Array, offset: number): boolean {
  for (let i = 0; i < 4; i += 1) {
    const c = bytes[offset + i] ?? -1;
    if (!((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a))) return false;
  }
  return true;
}

function chunkType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  );
}

function isCompleteChunkAt(bytes: Uint8Array, offset: number): boolean {
  if (bytes.length - offset < 12) return false;
  const length = readU32(bytes, offset);
  return length <= 0x7fffffff && length <= bytes.length - offset - 12 && isAsciiChunkType(bytes, offset + 4);
}

// PNG uses CRC-32/ISO-HDLC over the chunk type and data.  Keeping the table
// here avoids a Node zlib dependency and makes this module browser-safe.
const CRC_TABLE = makeCrcTable();

function crc32(bytes: Uint8Array, offset: number, length: number): number {
  let crc = 0xffffffff;
  for (let i = 0; i < length; i += 1) {
    crc = (CRC_TABLE[(crc ^ (bytes[offset + i] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeCrcTable(): readonly number[] {
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 0 ? c >>> 1 : 0xedb88320 ^ (c >>> 1);
    table.push(c >>> 0);
  }
  return table;
}
