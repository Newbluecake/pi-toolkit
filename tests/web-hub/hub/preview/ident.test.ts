/**
 * web-hub content-preview — chunked-mode identity token tests (`hub/preview/ident.ts`,
 * chunked-plan §2.1 D3 / §3.1 / §6.1).
 *
 * Pins: determinism (the same Identity ⇒ the same token), the exact sha256/base64url/22-char
 * derivation, `PREVIEW_IDENT_RE` format conformance, and that ANY of dev/ino/size/ctimeMs
 * drifting changes the token (the «绝不拼接» guarantee rides this — D5/D12).
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { previewIdentOf } from "../../../../src/web-hub/hub/preview/ident.js";
import type { Identity } from "../../../../src/web-hub/hub/preview/verify.js";
import { PREVIEW_IDENT_RE } from "../../../../src/web-hub/protocol/preview.js";

const base: Identity = { dev: 65024, ino: 1234567, size: 1_310_720, ctimeMs: 1728900000123.4567 };

describe("previewIdentOf (chunked-plan §2.1 D3)", () => {
  it("is deterministic for the same Identity", () => {
    expect(previewIdentOf(base)).toBe(previewIdentOf({ ...base }));
  });

  it('derives exactly `i1.` + first 22 base64url chars of sha256("dev:ino:size:ctimeMs")', () => {
    const digest = createHash("sha256")
      .update(`${base.dev}:${base.ino}:${base.size}:${base.ctimeMs}`)
      .digest("base64url");
    expect(previewIdentOf(base)).toBe(`i1.${digest.slice(0, 22)}`);
    // 22 base64url chars = 128 bits of the digest (D3)
    expect(previewIdentOf(base)).toMatch(/^i1\.[A-Za-z0-9_-]{22}$/);
  });

  it("matches PREVIEW_IDENT_RE (the wire format the protocol validates)", () => {
    expect(PREVIEW_IDENT_RE.test(previewIdentOf(base))).toBe(true);
    // spot-check variety across a few identities — every one stays in format
    for (let i = 0; i < 20; i += 1) {
      expect(PREVIEW_IDENT_RE.test(previewIdentOf({ ...base, ino: base.ino + i }))).toBe(true);
    }
  });

  it("changes when ANY of dev/ino/size/ctimeMs drifts (never-stitch guarantee)", () => {
    const ref = previewIdentOf(base);
    const variants: Identity[] = [
      { ...base, dev: base.dev + 1 },
      { ...base, ino: base.ino + 1 },
      { ...base, size: base.size + 1 },
      { ...base, ctimeMs: base.ctimeMs + 0.001 },
    ];
    for (const v of variants) {
      const tok = previewIdentOf(v);
      expect(tok).not.toBe(ref);
      expect(PREVIEW_IDENT_RE.test(tok)).toBe(true);
    }
  });

  it("is keyless/hub-restart-stable: same stat, two invocations, equal tokens", () => {
    // two independent calls over freshly-parsed equal numbers (a hub restart re-stats the
    // same unchanged file and must hand back the SAME token the client kept)
    const again: Identity = JSON.parse(
      JSON.stringify({ dev: base.dev, ino: base.ino, size: base.size, ctimeMs: base.ctimeMs }),
    ) as Identity;
    expect(previewIdentOf(again)).toBe(previewIdentOf(base));
  });

  it("degrades safely on fake stats (upload adapters may report ctimeMs 0)", () => {
    const tok = previewIdentOf({ dev: 0, ino: 0, size: 0, ctimeMs: 0 });
    expect(PREVIEW_IDENT_RE.test(tok)).toBe(true);
  });
});
