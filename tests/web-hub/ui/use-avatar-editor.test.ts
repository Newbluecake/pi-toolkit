// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createAvatarEditor } from "../../../src/web-hub/ui/src/composables/useAvatarEditor.js";

const png = new Uint8Array(readFileSync("tests/fixtures/web-hub-avatar/chrome-canvas.png"));
const file = (size: number, header = png): { size: number; slice: () => { arrayBuffer(): Promise<ArrayBuffer> } } => ({
  size,
  slice: () => ({
    arrayBuffer: async () => header.buffer.slice(header.byteOffset, header.byteOffset + header.byteLength),
  }),
});

function declaredHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([
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
    (width >>> 24) & 0xff,
    (width >>> 16) & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    (height >>> 24) & 0xff,
    (height >>> 16) & 0xff,
    (height >>> 8) & 0xff,
    height & 0xff,
  ]);
}

describe("useAvatarEditor", () => {
  it("checks source dimensions before createImageBitmap", async () => {
    let decoded = false;
    const result = await createAvatarEditor({
      createBitmap: async () => {
        decoded = true;
        throw new Error("must not decode");
      },
      readSlice: async () =>
        new Uint8Array([
          ...new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
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
        ]),
    }).process(file(10));
    expect(result).toMatchObject({ ok: false, error: "source-dims" });
    expect(decoded).toBe(false);
  });

  it("rejects a decoded bitmap whose actual size differs from the declared header", async () => {
    let closed = false;
    const result = await createAvatarEditor({
      readSlice: async () => declaredHeader(256, 128),
      createBitmap: async () => ({
        width: 128,
        height: 128,
        close: () => {
          closed = true;
        },
      }),
    }).process(file(100));
    expect(result).toMatchObject({ ok: false, error: "source-dims" });
    expect(closed).toBe(true);
  });

  it("closes the bitmap when the source square is below the avatar minimum", async () => {
    let closed = false;
    const result = await createAvatarEditor({
      readSlice: async () => declaredHeader(10, 10),
      createBitmap: async () => ({
        width: 10,
        height: 10,
        close: () => {
          closed = true;
        },
      }),
    }).process(file(100));
    expect(result).toMatchObject({ ok: false, error: "source-dims" });
    expect(closed).toBe(true);
  });

  it("closes the bitmap on canvas, context, encode, and self-check exits", async () => {
    const exits: Array<"canvas" | "context" | "encode" | "self-check"> = ["canvas", "context", "encode", "self-check"];
    for (const exit of exits) {
      let closed = false;
      const result = await createAvatarEditor({
        readSlice: async () => declaredHeader(256, 128),
        createBitmap: async () => ({
          width: 256,
          height: 128,
          close: () => {
            closed = true;
          },
        }),
        createCanvas: () => ({
          width: 256,
          height: 256,
          getContext: () => (exit === "canvas" ? null : exit === "context" ? null : { drawImage: () => {} }),
          toDataURL: () => {
            if (exit === "encode") throw new Error("encode");
            return exit === "self-check"
              ? "data:image/png;base64,AA=="
              : `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
          },
        }),
      }).process(file(100));
      expect(result.ok).toBe(false);
      expect(closed).toBe(true);
    }
  });

  it("crops through canvas and self-validates the generated PNG", async () => {
    let closed = false;
    const result = await createAvatarEditor({
      readSlice: async () =>
        new Uint8Array([
          ...new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
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
          1,
          0,
          0,
          0,
          0,
          0x80,
        ]),
      createBitmap: async () => ({
        width: 256,
        height: 128,
        close: () => {
          closed = true;
        },
      }),
      createCanvas: () => ({
        width: 256,
        height: 256,
        getContext: () => ({ drawImage: () => {} }),
        toDataURL: () => `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
      }),
    }).process(file(100, png));
    expect(result.ok).toBe(true);
    expect(closed).toBe(true);
  });
});
