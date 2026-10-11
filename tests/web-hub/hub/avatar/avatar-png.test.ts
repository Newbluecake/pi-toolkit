import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AVATAR_MAX_BYTES, type AvatarRejectReason } from "../../../../src/web-hub/protocol/avatar.js";
import { AVATAR_PNG_SIGNATURE, validateAvatarPng } from "../../../../src/web-hub/protocol/avatar-png.js";

const FIXTURES = new URL("../../../fixtures/web-hub-avatar/", import.meta.url);

function chunk(type: string, data: Uint8Array): Uint8Array {
  if (type.length !== 4) throw new Error("chunk type must be four bytes");
  const typeBytes = new TextEncoder().encode(type);
  const crcInput = new Uint8Array(typeBytes.length + data.length);
  crcInput.set(typeBytes);
  crcInput.set(data, typeBytes.length);
  const out = new Uint8Array(12 + data.length);
  writeU32(out, 0, data.length);
  out.set(crcInput, 4);
  writeU32(out, 8 + data.length, crc32(crcInput));
  return out;
}

function png(...chunks: Uint8Array[]): Uint8Array {
  const length = AVATAR_PNG_SIGNATURE.length + chunks.reduce((sum, value) => sum + value.length, 0);
  const out = new Uint8Array(length);
  out.set(AVATAR_PNG_SIGNATURE);
  let offset = AVATAR_PNG_SIGNATURE.length;
  for (const value of chunks) {
    out.set(value, offset);
    offset += value.length;
  }
  return out;
}

function ihdr(side = 32, colorType = 6, bitDepth = 8, interlace = 0, height = side): Uint8Array {
  const data = new Uint8Array(13);
  writeU32(data, 0, side);
  writeU32(data, 4, height);
  data[8] = bitDepth;
  data[9] = colorType;
  data[12] = interlace;
  return chunk("IHDR", data);
}

function validPng(...extra: Uint8Array[]): Uint8Array {
  return png(ihdr(), ...extra, chunk("IDAT", new Uint8Array([0x78, 0x9c])), chunk("IEND", new Uint8Array()));
}

function readFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(name, FIXTURES)));
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc & 1) === 0 ? crc >>> 1 : 0xedb88320 ^ (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function expectReason(bytes: Uint8Array, reason: AvatarRejectReason): void {
  expect(validateAvatarPng(bytes)).toEqual({ ok: false, reason });
}

describe("validateAvatarPng", () => {
  it("accepts the real Chrome canvas PNG fixture", () => {
    expect(validateAvatarPng(readFixture("chrome-canvas.png"))).toEqual({ ok: true, side: 64 });
  });

  it("covers every structural rejection reason in the frozen corpus", () => {
    expectReason(new Uint8Array(), "signature");
    expectReason(new Uint8Array([...AVATAR_PNG_SIGNATURE, 0x50, 0x4b, 0x03, 0x04]), "chunk");
    expectReason(new Uint8Array(AVATAR_MAX_BYTES + 1), "size");

    // IHDR must be the first chunk, unique, and exactly 13 bytes.
    expectReason(
      png(chunk("tEXt", new Uint8Array()), ihdr(), chunk("IDAT", new Uint8Array([1])), chunk("IEND", new Uint8Array())),
      "ihdr",
    );
    expectReason(
      png(chunk("IHDR", new Uint8Array(12)), chunk("IDAT", new Uint8Array([1])), chunk("IEND", new Uint8Array())),
      "ihdr",
    );
    expectReason(png(ihdr(), ihdr(), chunk("IDAT", new Uint8Array([1])), chunk("IEND", new Uint8Array())), "ihdr");

    // Dimensions and the whitelist's color model.
    expectReason(
      png(ihdr(31, 6, 8, 0, 32), chunk("IDAT", new Uint8Array([1])), chunk("IEND", new Uint8Array())),
      "dims",
    );
    expectReason(png(ihdr(15), chunk("IDAT", new Uint8Array([1])), chunk("IEND", new Uint8Array())), "dims");
    expectReason(png(ihdr(257), chunk("IDAT", new Uint8Array([1])), chunk("IEND", new Uint8Array())), "dims");
    expectReason(png(ihdr(32, 6, 16), chunk("IDAT", new Uint8Array([1])), chunk("IEND", new Uint8Array())), "color");
    expectReason(png(ihdr(32, 3), chunk("IDAT", new Uint8Array([1])), chunk("IEND", new Uint8Array())), "color");
    expectReason(png(ihdr(32, 0), chunk("IDAT", new Uint8Array([1])), chunk("IEND", new Uint8Array())), "color");
    expectReason(png(ihdr(32, 6, 8, 1), chunk("IDAT", new Uint8Array([1])), chunk("IEND", new Uint8Array())), "color");

    // CRC, bounds, unknown/text/ICC chunks, and APNG are all rejected.
    const badCrc = chunk("IDAT", new Uint8Array([1]));
    badCrc[badCrc.length - 1] ^= 1;
    expectReason(png(ihdr(), badCrc, chunk("IEND", new Uint8Array())), "crc");
    const overrun = new Uint8Array([...AVATAR_PNG_SIGNATURE, 0, 0, 0, 20, 73, 68, 65, 84]);
    expectReason(overrun, "chunk");
    expectReason(validPng(chunk("zzzz", new Uint8Array())), "chunk");
    for (const type of ["tEXt", "zTXt", "iTXt", "eXIf", "iCCP"]) {
      expectReason(validPng(chunk(type, new Uint8Array([1]))), "chunk");
    }
    for (const type of ["acTL", "fcTL", "fdAT"]) {
      expectReason(validPng(chunk(type, new Uint8Array())), "animated");
    }

    // IDAT must be one contiguous run, followed only by IEND.
    expectReason(png(ihdr(), chunk("IEND", new Uint8Array())), "idat");
    expectReason(png(ihdr(), chunk("IEND", new Uint8Array()), chunk("IDAT", new Uint8Array([1]))), "order");
    expectReason(
      png(
        ihdr(),
        chunk("IDAT", new Uint8Array([1])),
        chunk("sRGB", new Uint8Array([0])),
        chunk("IDAT", new Uint8Array([1])),
        chunk("IEND", new Uint8Array()),
      ),
      "order",
    );
    expectReason(
      png(
        ihdr(),
        chunk("IDAT", new Uint8Array([1])),
        chunk("sRGB", new Uint8Array([0])),
        chunk("IEND", new Uint8Array()),
      ),
      "order",
    );
    expectReason(png(ihdr(), chunk("IDAT", new Uint8Array([1])), chunk("IEND", new Uint8Array([0]))), "chunk");
    expectReason(png(ihdr(), chunk("IEND", new Uint8Array()), chunk("IDAT", new Uint8Array([1]))), "order");
    expectReason(
      png(ihdr(), chunk("IDAT", new Uint8Array([1])), chunk("IEND", new Uint8Array()), chunk("IEND", new Uint8Array())),
      "order",
    );
    expectReason(
      png(ihdr(), chunk("IDAT", new Uint8Array([1])), chunk("IEND", new Uint8Array()), chunk("tEXt", new Uint8Array())),
      "order",
    );
    expectReason(
      png(ihdr(), chunk("IDAT", new Uint8Array([1])), chunk("IEND", new Uint8Array()), new Uint8Array([0])),
      "trailing",
    );
    expectReason(new Uint8Array([...validPng(), 0x50, 0x4b, 0x03, 0x04]), "trailing");
    expectReason(new Uint8Array([...validPng(), ...new TextEncoder().encode("<html>")]), "trailing");

    // Fixed-length auxiliaries are accepted before IDAT, but not duplicated or malformed.
    expect(
      validateAvatarPng(
        png(
          ihdr(32, 2),
          chunk("sRGB", new Uint8Array([0])),
          chunk("gAMA", new Uint8Array(4)),
          chunk("cHRM", new Uint8Array(32)),
          chunk("pHYs", new Uint8Array(9)),
          chunk("sBIT", new Uint8Array(4)),
          chunk("bKGD", new Uint8Array(6)),
          chunk("tRNS", new Uint8Array(6)),
          chunk("IDAT", new Uint8Array([1])),
          chunk("IEND", new Uint8Array()),
        ),
      ),
    ).toEqual({ ok: true, side: 32 });
    expectReason(validPng(chunk("sRGB", new Uint8Array([0])), chunk("sRGB", new Uint8Array([0]))), "chunk");
    expectReason(
      png(ihdr(), chunk("sRGB", new Uint8Array()), chunk("IDAT", new Uint8Array([1])), chunk("IEND", new Uint8Array())),
      "chunk",
    );
    expectReason(
      png(
        ihdr(32, 6),
        chunk("tRNS", new Uint8Array(6)),
        chunk("IDAT", new Uint8Array([1])),
        chunk("IEND", new Uint8Array()),
      ),
      "chunk",
    );

    const manyIdat = Array.from({ length: 65 }, () => chunk("IDAT", new Uint8Array([1])));
    expectReason(png(ihdr(), ...manyIdat, chunk("IEND", new Uint8Array())), "chunk");
  });

  it("keeps the hub's zlib rejection corpus structurally parseable (H owns inflate)", () => {
    for (const name of ["idat-deflate-trailing.png", "idat-two-zlib-streams.png", "idat-split-trailing.png"]) {
      // Package H must reject these with reason `idat` after checking
      // engine.bytesWritten === idat.length. A0 intentionally accepts the
      // structural PNG because it cannot synchronously inflate in the browser.
      expect(validateAvatarPng(readFixture(name))).toEqual({ ok: true, side: 16 });
    }
  });

  it("never throws or admits deterministic random garbage", () => {
    let state = 0x41c64e6d;
    for (let sample = 0; sample < 2_000; sample += 1) {
      const length = (nextRandom(() => (state = (state * 1664525 + 1013904223) >>> 0)) % 900) + 1;
      const bytes = new Uint8Array(length);
      for (let i = 0; i < bytes.length; i += 1)
        bytes[i] = nextRandom(() => (state = (state * 1664525 + 1013904223) >>> 0));
      expect(() => validateAvatarPng(bytes)).not.toThrow();
      expect(validateAvatarPng(bytes).ok).toBe(false);
    }
  });
});

function nextRandom(next: () => number): number {
  return next() & 0xff;
}
