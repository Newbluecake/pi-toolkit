/** Node-only avatar validation. Structural PNG validation lives in the frozen protocol module;
 * this file adds the hub-only proof that IDAT is exactly one zlib stream with an exact scanline
 * payload. It intentionally has no filesystem imports. */
import { inflateSync } from "node:zlib";
import { validateAvatarPng as validateStructuralPng } from "../../protocol/avatar-png.js";
import type { AvatarPngValidation, AvatarRejectReason } from "../../protocol/avatar.js";

export type AvatarValidation = AvatarPngValidation;

/** Validate an avatar PNG, including bounded, exact IDAT inflation. Never throws. */
export function validateAvatar(bytes: Uint8Array): AvatarValidation {
  const structural = validateStructuralPng(bytes);
  if (!structural.ok) return structural;
  try {
    const idat = collectIdat(bytes);
    if (idat === undefined) return { ok: false, reason: "idat" };
    const channels = colorChannels(bytes);
    if (channels === undefined) return { ok: false, reason: "idat" };
    const expected = structural.side * (1 + structural.side * channels);
    const inflated = inflateSync(idat, { info: true, maxOutputLength: expected }) as unknown as {
      buffer?: Buffer;
      engine?: { bytesWritten?: number };
    };
    const output = inflated.buffer;
    const consumed = inflated.engine?.bytesWritten;
    if (output === undefined || consumed !== idat.length || output.length !== expected) {
      return { ok: false, reason: "idat" };
    }
    for (let row = 0; row < structural.side; row += 1) {
      if (output[row * (1 + structural.side * channels)]! > 4) return { ok: false, reason: "idat" };
    }
    return structural;
  } catch {
    return { ok: false, reason: "idat" };
  }
}
export const validateAvatarPng = validateAvatar;

function colorChannels(bytes: Uint8Array): 3 | 4 | undefined {
  if (bytes.length < 26) return undefined;
  const color = bytes[25];
  return color === 2 ? 3 : color === 6 ? 4 : undefined;
}

function collectIdat(bytes: Uint8Array): Uint8Array | undefined {
  const pieces: Uint8Array[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = readU32(bytes, offset);
    if (length > bytes.length - offset - 12) return undefined;
    const type = String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!);
    if (type === "IDAT") pieces.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
    if (type === "IEND") break;
  }
  if (pieces.length === 0) return undefined;
  const total = pieces.reduce((n, p) => n + p.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const p of pieces) {
    joined.set(p, at);
    at += p.length;
  }
  return joined;
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
