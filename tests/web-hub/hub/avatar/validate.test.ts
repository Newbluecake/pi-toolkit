import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateAvatar } from "../../../../src/web-hub/hub/avatar/validate.js";

const dir = new URL("../../../fixtures/web-hub-avatar/", import.meta.url);
const read = (name: string) => new Uint8Array(readFileSync(new URL(name, dir)));

describe("hub avatar validator", () => {
  it("accepts a real canvas PNG", () =>
    expect(validateAvatar(read("chrome-canvas.png"))).toEqual({ ok: true, side: 64 }));
  it.each(["idat-deflate-trailing.png", "idat-two-zlib-streams.png", "idat-split-trailing.png"])(
    "rejects %s because the zlib input is not exactly consumed",
    (name) => expect(validateAvatar(read(name))).toEqual({ ok: false, reason: "idat" }),
  );
  it.each([
    ["svg", '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ["jpeg", "\xff\xd8\xff\xe0"],
    ["webp", "RIFFxxxxWEBP"],
    ["gif", "GIF89a"],
  ])("rejects a non-PNG %s signature", (_name, text) => {
    expect(validateAvatar(new Uint8Array(Buffer.from(text, "binary")))).toEqual({ ok: false, reason: "signature" });
  });
});
