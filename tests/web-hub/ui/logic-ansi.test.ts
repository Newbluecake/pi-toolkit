// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ANSI_STRING_MAX, createAnsiStripper, stripAnsi } from "../../../src/web-hub/ui/src/logic/ansi.js";
import { createSourceSegmenter } from "../../../src/web-hub/ui/src/logic/previewStream.js";

/**
 * `@logic/ansi.js` (web-hub-preview L1 fix): the strip grammar + the chunk-boundary carry.
 *
 * Pinned properties:
 * - `stripAnsi` strips CSI/OSC/DCS/two-byte/nF sequences, keeps CJK + ASCII verbatim, and
 *   returns ESC-free input UNCHANGED (same reference);
 * - for EVERY split point of a text containing escapes, `createAnsiStripper` fed both halves
 *   (then flushed) yields exactly `stripAnsi(whole)` — a sequence truncated across a chunk
 *   boundary never leaves `[36m`-style residue;
 * - feeding the stripped chunks through `createSourceSegmenter` (PreviewText's stream path)
 *   keeps the segmenter's own invariant over the stripped stream: the concatenated segments
 *   equal `stripAnsi(whole)`.
 */

const E = "\u001b";

const SAMPLES = [
  `${E}[36m==>${E}[0m 正在安装依赖…\n${E}[1;32mOK${E}[0m 完成\n`,
  `${E}]0;build log\u0007step 1\n${E}]2;tail${E}\\ done\n`,
  `no escapes at all — 纯中文一行\n`,
  `${E}[3`, // incomplete at EOF
  `x${E}]0;unterminated`, // unterminated OSC at EOF
  `a${E}[36\nb`, // CSI aborted by a newline
  `a${E}P1;2q+dcs${E}\\b`, // DCS
  `a${E}M b${E} F c`, // two-byte RI + nF
];

describe("stripAnsi", () => {
  it("returns ESC-free input unchanged (same reference)", () => {
    const s = "plain 中文 text\nline 2";
    expect(stripAnsi(s)).toBe(s);
    expect(stripAnsi("")).toBe("");
  });

  it("strips SGR color codes, keeps CJK + ASCII verbatim", () => {
    expect(stripAnsi(`${E}[36m==>${E}[0m 正在安装`)).toBe("==> 正在安装");
    expect(stripAnsi(`${E}[1;32mOK${E}[0m`)).toBe("OK");
    expect(stripAnsi(`pre${E}[38;5;196mred${E}[0mpost`)).toBe("preredpost");
  });

  it("strips OSC (BEL- and ST-terminated), DCS, two-byte and nF sequences", () => {
    expect(stripAnsi(`${E}]0;title\u0007after`)).toBe("after");
    expect(stripAnsi(`${E}]2;t${E}\\after`)).toBe("after");
    expect(stripAnsi(`a${E}P+dcs${E}\\b`)).toBe("ab");
    expect(stripAnsi(`a${E}Mb`)).toBe("ab"); // two-byte (RI)
    expect(stripAnsi(`a${E} Fb`)).toBe("ab"); // nF: ESC SP F
  });

  it("a sequence aborted by an out-of-grammar byte stops before it (newline kept)", () => {
    expect(stripAnsi(`a${E}[36\nb`)).toBe("a\nb");
    expect(stripAnsi(`a${E}[3${E}[0mb`)).toBe("ab"); // aborted CSI, then a complete one
  });

  it("an incomplete trailing sequence is dropped at EOF", () => {
    expect(stripAnsi(`done${E}[3`)).toBe("done");
    expect(stripAnsi(`done${E}`)).toBe("done");
    expect(stripAnsi(`done${E}]0;tit`)).toBe("done");
  });

  it("an unterminated string sequence is capped, never swallowing the rest of the file", () => {
    const overflow = 10;
    const s = `a${E}]${"x".repeat(ANSI_STRING_MAX + overflow)}rest stays`;
    // the first ANSI_STRING_MAX payload chars are dropped, the overflow RESUMES as text —
    // a stray `ESC ]` must never hide everything after it
    expect(stripAnsi(s)).toBe(`a${"x".repeat(overflow)}rest stays`);
  });

  it("is idempotent", () => {
    for (const s of SAMPLES) expect(stripAnsi(stripAnsi(s))).toBe(stripAnsi(s));
  });
});

describe("createAnsiStripper — chunk-boundary carry", () => {
  it("every split point: push+push+flush ≡ stripAnsi(whole) (no residue)", () => {
    for (const s of SAMPLES) {
      const whole = stripAnsi(s);
      for (let cut = 0; cut <= s.length; cut += 1) {
        const st = createAnsiStripper();
        const out = st.push(s.slice(0, cut)) + st.push(s.slice(cut)) + st.flush();
        expect(out).toBe(whole);
      }
    }
  });

  it("random multi-chunk splits keep the same identity (seeded)", () => {
    let a = 0x2f6e2b1 >>> 0;
    const rng = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const s = SAMPLES.join("");
    const whole = stripAnsi(s);
    for (let round = 0; round < 200; round += 1) {
      const st = createAnsiStripper();
      let out = "";
      let rest = s;
      while (rest.length > 0) {
        const take = 1 + Math.floor(rng() * 40);
        out += st.push(rest.slice(0, take));
        rest = rest.slice(take);
      }
      out += st.flush();
      expect(out).toBe(whole);
    }
  });

  it("pendingLength exposes the held incomplete sequence", () => {
    const st = createAnsiStripper();
    expect(st.push(`line\n${E}[3`)).toBe("line\n");
    expect(st.pendingLength).toBe(3);
    expect(st.push("6mred" + E + "[0m\n")).toBe("red\n");
    expect(st.pendingLength).toBe(0);
  });

  it("through createSourceSegmenter: concatenated segments ≡ stripAnsi(whole)", () => {
    for (const s of SAMPLES) {
      const whole = stripAnsi(s);
      for (let cut = 0; cut <= s.length; cut += 1) {
        const st = createAnsiStripper();
        const seg = createSourceSegmenter();
        const parts = [...seg.push(st.push(s.slice(0, cut))), ...seg.push(st.push(s.slice(cut)))];
        st.flush();
        parts.push(...seg.flush("eof"));
        expect(parts.map((x) => x.text + x.sep).join("")).toBe(whole);
      }
    }
  });
});
