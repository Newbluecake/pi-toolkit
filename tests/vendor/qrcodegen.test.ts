// feishu-bot plan v2 §9 (F9): the vendored Nayuki QR encoder (src/vendor/qrcodegen.ts).
//
// Verification strategy: (a) an INDEPENDENT cross-check of the ECC-L/mask-0 format info against
// the published QR-spec constant (111011111000100) plus the spec's dark module; (b) structural
// invariants (finder patterns, timing patterns, alignment centers); (c) version-selection
// boundaries pinned at the byte-mode ECC-L capacities; (d) golden matrix digests as regression
// pins — the matrix output of this exact adaptation was verified to decode with OpenCV during
// the F-probe (P1), so a digest match preserves that verification.

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { qrMatrix } from "../../src/vendor/qrcodegen.js";

function digest(text: string): string {
  const m = qrMatrix(text);
  return createHash("sha256")
    .update(m.map((row) => row.map((b) => (b ? "1" : "0")).join("")).join("\n"))
    .digest("hex");
}

describe("qrMatrix structure", () => {
  it("picks version 1 for 17 bytes and version 2 for 18 (byte-mode ECC-L capacity boundary)", () => {
    expect(qrMatrix("x".repeat(17)).length).toBe(21); // v1
    expect(qrMatrix("x".repeat(18)).length).toBe(25); // v2
  });

  it("throws qr-too-large beyond the byte-mode ECC-L capacity (2953 bytes)", () => {
    expect(() => qrMatrix("x".repeat(2_954))).toThrow("qr-too-large");
    expect(() => qrMatrix("x".repeat(2_953))).not.toThrow();
  });

  it("renders the three 7×7 finder patterns with light separators", () => {
    const m = qrMatrix("HELLO");
    const size = m.length;
    const finder = (cx: number, cy: number) => {
      for (let dy = -3; dy <= 3; dy++)
        for (let dx = -3; dx <= 3; dx++) {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          expect(m[cy + dy]![cx + dx], `finder(${cx},${cy}) at +${dx},${dy}`).toBe(d !== 2);
        }
    };
    finder(3, 3);
    finder(size - 4, 3);
    finder(3, size - 4);
    // separator ring (d=4) is light around each finder
    expect(m[7]!.slice(0, 8).every((b) => b === false)).toBe(true);
  });

  it("keeps the timing patterns alternating on row/column 6 between the finders", () => {
    const m = qrMatrix("HELLO");
    const size = m.length;
    for (let i = 8; i <= size - 9; i++) {
      expect(m[6]![i], `timing row col ${i}`).toBe(i % 2 === 0);
      expect(m[i]![6], `timing col row ${i}`).toBe(i % 2 === 0);
    }
  });

  it("places the published ECC-L / mask-0 format info (independent constant) and the dark module", () => {
    const m = qrMatrix("HELLO");
    const size = m.length;
    const bit = (i: number) => ((0b111011111000100 >>> i) & 1) !== 0; // published L + mask 0
    const at = (x: number, y: number) => m[y]![x]!;
    expect(at(8, 0)).toBe(bit(0));
    for (let i = 0; i <= 5; i++) expect(at(8, i), `format bit ${i}`).toBe(bit(i));
    expect(at(8, 7)).toBe(bit(6));
    expect(at(8, 8)).toBe(bit(7));
    expect(at(7, 8)).toBe(bit(8));
    for (let i = 9; i <= 14; i++) expect(at(14 - i, 8), `format bit ${i}`).toBe(bit(i));
    // spec dark module
    expect(at(8, size - 8)).toBe(true);
  });

  it("places alignment patterns at the Nayuki-computed centers (v8 ⇒ 6/24/42; only non-corner ones)", () => {
    const m = qrMatrix("x".repeat(160)); // 160 bytes ⇒ v8 (size 49), positions [6, 24, 42]
    expect(m.length).toBe(49);
    const align = (cx: number, cy: number) => {
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          expect(m[cy + dy]![cx + dx], `align(${cx},${cy}) +${dx},${dy}`).toBe(d !== 1);
        }
    };
    // the (6,24)/(24,6) neighbors of the finders are skipped by the corner-index rule, same as
    // Nayuki's reference; the center pattern is drawn unconditionally
    align(24, 24);
    align(42, 24);
    align(24, 42);
    align(42, 42);
  });

  it("is deterministic", () => {
    expect(digest("determinism")).toBe(digest("determinism"));
  });
});

describe("qrMatrix golden digests (OpenCV-verified adaptation, F-probe P1)", () => {
  it("pins known matrices", () => {
    expect(digest("HELLO")).toBe("d51e6b3d78d8b096ca2040e60a6b738e6d61f498c4cb0c3b63f035650114d050");
    expect(digest("https://open.feishu.cn/page/launcher?user_code=ABCDEF1234")).toBe(
      "2131999977ee940895dd500a087f7a49e755960161e3f568bbe24c67b9403f02",
    );
    expect(digest("ou_9f3c-test-payload")).toBe("eb7ebca958f05f94f5d47e03a67ce3fc0ac96c40dae84e3a967e1241516db62a");
    expect(digest("x".repeat(17))).toBe("714ce3d4a6c70750b8877fe7de584f0071b6eb80e6aac66073fe1fe7210f4703");
    expect(digest("x".repeat(18))).toBe("c55aa81be6fbc2ab405bb6c1500795f0dace05b1aa91a545f429cd2da91828d3");
  });

  it("renders a realistic Feishu verification URL inside v6 (size 41)", () => {
    const url =
      "https://open.larksuite.com/page/launcher?user_code=abcdefghijk&from=sdk&tp=sdk&source=pi-toolkit&name=pi%40host";
    expect(url.length).toBeGreaterThan(100);
    const m = qrMatrix(url);
    expect(m.length).toBe(41);
  });
});
