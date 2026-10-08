// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../../../src/web-hub/ui/src/logic/markdown.js";
import {
  checkPreviewHeaders,
  classifyPreviewError,
  clientImageBudget,
  countMdNodes,
  findPathRefs,
  isMarkdownPath,
  parsePreviewDims,
  pathRefOfCode,
  prepareMarkdownPreview,
  previewOutcomeFromResponse,
  PREVIEW_MAX_REFS_PER_NODE,
  PREVIEW_MD_NODE_MAX,
  previewScopeOf,
  scopeKeyOf,
} from "../../../src/web-hub/ui/src/logic/preview.js";
import {
  PREVIEW_CLIENT_PIXELS_COARSE,
  PREVIEW_HDR,
  PREVIEW_IMAGE_MAX_BYTES,
  PREVIEW_IMAGE_MAX_PIXELS,
  PREVIEW_TEXT_MAX_BYTES,
  PREVIEW_UPLOADS_MARKER,
  validatePreviewPath,
} from "../../../src/web-hub/protocol/preview.js";

/**
 * web-hub-preview plan v3 §4.6 (package PV4): the frozen path-recognition rules, the scope
 * truth table, the client image budget, the pre-body header gate and the error taxonomy.
 * `findPathRefs`'s segment-concat identity is property-tested (seeded, deterministic).
 */

const SCOPE = { agentKey: "A", sessionId: "s1", cwd: "/home/u/proj", uploads: true };
const UPLOAD_PATH = `/home/u${PREVIEW_UPLOADS_MARKER}s-s1/up_1.png`;

type Seg = { kind: string; text: string; path?: string; line?: number; col?: number };

const concat = (segs: readonly Seg[]): string => segs.map((s) => s.text).join("");
const refs = (segs: readonly Seg[]): Seg[] => segs.filter((s) => s.kind === "ref");

/** mulberry32 — deterministic PRNG for the property tests. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("logic/preview.js findPathRefs — start contexts (§4.6 rule 1)", () => {
  it.each([
    ["line start", "/home/u/proj/a.ts rest"],
    ["after space", "see /home/u/proj/a.ts ok"],
    ["after tab", "see\t/home/u/proj/a.ts ok"],
    ["after newline", "see\n/home/u/proj/a.ts ok"],
    ["after (", "x(/home/u/proj/a.ts)"],
    ["after [", "x[/home/u/proj/a.ts]"],
    ["after {", "x{/home/u/proj/a.ts}"],
    ["after <", "x</home/u/proj/a.ts>"],
    ['after "', 'x"/home/u/proj/a.ts"'],
    ["after '", "x'/home/u/proj/a.ts'"],
    ["after =", "path=/home/u/proj/a.ts,"],
    ["after （", "x（/home/u/proj/a.ts）"],
    ["after 「", "x「/home/u/proj/a.ts」"],
    ["after 『", "x『/home/u/proj/a.ts』"],
    ["after 【", "x【/home/u/proj/a.ts】"],
    ["after 《", "x《/home/u/proj/a.ts》"],
    ["after ：", "路径：/home/u/proj/a.ts。"],
  ])("clickable: %s", (_label, text) => {
    const segs = findPathRefs(text, SCOPE) as Seg[];
    expect(concat(segs)).toBe(text);
    expect(refs(segs).map((r) => r.path)).toEqual(["/home/u/proj/a.ts"]);
  });

  it.each([
    ["mid-word", "x/home/u/proj/a.ts"],
    ["after :", "http://example.com/home/u/proj/a.ts"],
    ["after / (double slash)", "//home/u/proj/a.ts"],
    ["after digit", "1/home/u/proj/a.ts"],
    ["after 。", "看。/home/u/proj/a.ts"],
  ])("not clickable: %s", (_label, text) => {
    const segs = findPathRefs(text, SCOPE) as Seg[];
    expect(concat(segs)).toBe(text);
    expect(refs(segs)).toEqual([]);
  });
});

describe("logic/preview.js findPathRefs — terminators & suffixes (§4.6 rules 2–3)", () => {
  it.each([
    ["space", "/home/u/proj/a.ts tail"],
    ["comma", "/home/u/proj/a.ts, tail"],
    ["semicolon", "/home/u/proj/a.ts; tail"],
    ["backtick", "/home/u/proj/a.ts`tail`"],
    ["close paren", "(/home/u/proj/a.ts)"],
    ["pipe", "/home/u/proj/a.ts|tail"],
    ["full-width 。", "/home/u/proj/a.ts。"],
    ["full-width ，", "/home/u/proj/a.ts，还有"],
    ["full-width 】", "【/home/u/proj/a.ts】"],
  ])("ends at %s", (_label, text) => {
    const segs = findPathRefs(text, SCOPE) as Seg[];
    expect(concat(segs)).toBe(text);
    expect(refs(segs).map((r) => r.path)).toEqual(["/home/u/proj/a.ts"]);
  });

  it("strips trailing sentence punctuation repeatedly (rule 2)", () => {
    const segs = findPathRefs("open /home/u/proj/a.ts.:! now", SCOPE) as Seg[];
    expect(concat(segs)).toBe("open /home/u/proj/a.ts.:! now");
    expect(refs(segs)).toEqual([{ kind: "ref", text: "/home/u/proj/a.ts", path: "/home/u/proj/a.ts" }]);
  });

  it(":line[:col] is display-only — kept in the segment text, stripped from the path (rule 3)", () => {
    const segs = findPathRefs("at /home/u/proj/a.ts:12:3 end", SCOPE) as Seg[];
    expect(concat(segs)).toBe("at /home/u/proj/a.ts:12:3 end");
    expect(refs(segs)).toEqual([
      { kind: "ref", text: "/home/u/proj/a.ts:12:3", path: "/home/u/proj/a.ts", line: 12, col: 3 },
    ]);
    const lineOnly = findPathRefs("at /home/u/proj/a.ts:12 end", SCOPE) as Seg[];
    expect(refs(lineOnly)).toEqual([
      { kind: "ref", text: "/home/u/proj/a.ts:12", path: "/home/u/proj/a.ts", line: 12 },
    ]);
  });

  it("trailing punctuation is stripped before the :line split (/a.ts:12. still parses)", () => {
    const segs = findPathRefs("/home/u/proj/a.ts:12.", SCOPE) as Seg[];
    expect(concat(segs)).toBe("/home/u/proj/a.ts:12.");
    expect(refs(segs)).toEqual([{ kind: "ref", text: "/home/u/proj/a.ts:12", path: "/home/u/proj/a.ts", line: 12 }]);
  });
});

describe("logic/preview.js findPathRefs — scope & validation (§4.6 rules 4–6)", () => {
  it("segment-aligned cwd check: /home/u/proj2 is NOT under /home/u/proj", () => {
    const segs = findPathRefs("/home/u/proj2/a.ts /home/u/proj/a.ts", SCOPE) as Seg[];
    expect(concat(segs)).toBe("/home/u/proj2/a.ts /home/u/proj/a.ts");
    expect(refs(segs).map((r) => r.path)).toEqual(["/home/u/proj/a.ts"]);
  });

  it("the cwd itself (no trailing slash) and paths outside cwd are not clickable", () => {
    expect(refs(findPathRefs("/home/u/proj", SCOPE) as Seg[])).toEqual([]);
    expect(refs(findPathRefs("/etc/passwd", SCOPE) as Seg[])).toEqual([]);
    expect(refs(findPathRefs("/home/u", SCOPE) as Seg[])).toEqual([]);
  });

  it("upload-store paths are clickable even outside cwd (rule 5)", () => {
    const segs = findPathRefs(`附件 ${UPLOAD_PATH} 好了`, SCOPE) as Seg[];
    expect(refs(segs).map((r) => r.path)).toEqual([UPLOAD_PATH]);
  });

  it("upload-store paths stay clickable with a null cwd; cwd paths do not", () => {
    const noCwd = { ...SCOPE, cwd: null };
    expect(refs(findPathRefs(UPLOAD_PATH, noCwd) as Seg[]).map((r) => r.path)).toEqual([UPLOAD_PATH]);
    expect(refs(findPathRefs("/home/u/proj/a.ts", noCwd) as Seg[])).toEqual([]);
  });

  it("cwd of '/' disables the cwd rule (root-too-broad mirror) but not the uploads marker", () => {
    const rootCwd = { ...SCOPE, cwd: "/" };
    expect(refs(findPathRefs("/home/u/proj/a.ts", rootCwd) as Seg[])).toEqual([]);
    expect(refs(findPathRefs(UPLOAD_PATH, rootCwd) as Seg[])).toHaveLength(1);
  });

  it("uploads:false scopes do not honor the uploads marker", () => {
    const noUploads = { ...SCOPE, uploads: false };
    expect(refs(findPathRefs(UPLOAD_PATH, noUploads) as Seg[])).toEqual([]);
  });

  it("protocol-invalid candidates are not clickable (single segment, empty segment, dot segments)", () => {
    expect(refs(findPathRefs("/single", SCOPE) as Seg[])).toEqual([]);
    expect(refs(findPathRefs("//home/u/proj", SCOPE) as Seg[])).toEqual([]);
    expect(refs(findPathRefs("/home/u/./a", SCOPE) as Seg[])).toEqual([]);
    expect(refs(findPathRefs("/home/u/../a", SCOPE) as Seg[])).toEqual([]);
  });

  it("stops recognizing after PREVIEW_MAX_REFS_PER_NODE refs (rule 6), rest stays text", () => {
    const many = Array.from({ length: PREVIEW_MAX_REFS_PER_NODE + 20 }, (_, i) => `/home/u/proj/f${i}.ts`).join(" ");
    const segs = findPathRefs(many, SCOPE) as Seg[];
    expect(concat(segs)).toBe(many);
    expect(refs(segs)).toHaveLength(PREVIEW_MAX_REFS_PER_NODE);
  });

  it("null / undefined scope yields one verbatim text segment (PathText DOM equivalence)", () => {
    expect(findPathRefs("/home/u/proj/a.ts", null)).toEqual([{ kind: "text", text: "/home/u/proj/a.ts" }]);
    expect(findPathRefs("/home/u/proj/a.ts", undefined)).toEqual([{ kind: "text", text: "/home/u/proj/a.ts" }]);
  });
});

describe("logic/preview.js findPathRefs — property & performance", () => {
  it("segments always concatenate back to the exact input; every ref is valid + in scope (seeded)", () => {
    const tokens = [
      "/home/u/proj/a.ts",
      "/home/u/proj/dir/b.md:7",
      "/etc/passwd",
      "http://x/y",
      "text",
      " ",
      "\n",
      "(",
      ")",
      "。",
      "，",
      "`",
      "中文",
      UPLOAD_PATH,
      ":",
      "=",
      "/",
      "x/y",
    ];
    for (let seed = 1; seed <= 40; seed++) {
      const rand = rng(seed);
      const parts: string[] = [];
      const count = 3 + Math.floor(rand() * 18);
      for (let i = 0; i < count; i++) parts.push(tokens[Math.floor(rand() * tokens.length)]!);
      const text = parts.join("");
      const segs = findPathRefs(text, SCOPE) as Seg[];
      expect(concat(segs)).toBe(text);
      expect(segs.length).toBeGreaterThan(0);
      for (const r of refs(segs)) {
        expect(validatePreviewPath(r.path!)).toBe(true);
        expect(
          r.path!.startsWith("/home/u/proj/") || r.path!.includes(PREVIEW_UPLOADS_MARKER),
          `ref ${r.path} in scope`,
        ).toBe(true);
      }
      expect(refs(segs).length).toBeLessThanOrEqual(PREVIEW_MAX_REFS_PER_NODE);
    }
  });

  it("1 MiB of path-free prose scans in linear time (loose CI-safe bound)", () => {
    const text = "这是一段没有路径的正文。lorem ipsum dolor sit amet. ".repeat(20_000);
    const t0 = Date.now();
    const segs = findPathRefs(text, SCOPE) as Seg[];
    const ms = Date.now() - t0;
    expect(refs(segs)).toEqual([]);
    expect(ms).toBeLessThan(2_000);
  });

  it("1 MiB of dense non-start slashes (worst-case rescan) also stays linear", () => {
    const text = "x/y".repeat(350_000); // every '/' fails the start-context rule
    const t0 = Date.now();
    findPathRefs(text, SCOPE);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("pathological '=/'.repeat (verifier P1: was O(n²), 25.5s at 64KB) — 64KB scans < 200ms", () => {
    // `=` and `/` are both non-terminators and `=` is a START_CHAR, so every '/' in this
    // string is a legal candidate start whose candidate runs to the end of the string —
    // the exact shape that made the pre-fix rescan quadratic (remote main-thread freeze
    // over the transcript, U3). The fix memoizes per terminator-free run.
    const text = "=/".repeat(32_768); // 65_536 chars
    const t0 = Date.now();
    const segs = findPathRefs(text, SCOPE) as Seg[];
    const ms = Date.now() - t0;
    expect(concat(segs)).toBe(text);
    expect(refs(segs)).toEqual([]); // nothing in scope — all candidates rejected
    expect(ms).toBeLessThan(200);
  });

  it("nested candidate after a rejected one is still found (why rejection can't jump to the run end)", () => {
    // `/etc=/home/u/proj/a.ts`: the whole run is one candidate (rejected — not under cwd),
    // but the `/` before `home` follows `=` (a START_CHAR), so it begins its OWN clickable
    // candidate. The frozen rules recognize it; the linear fix must preserve that.
    const text = "/etc=/home/u/proj/a.ts";
    const segs = findPathRefs(text, SCOPE) as Seg[];
    expect(concat(segs)).toBe(text);
    expect(refs(segs)).toEqual([{ kind: "ref", text: "/home/u/proj/a.ts", path: "/home/u/proj/a.ts" }]);
  });

  it("nested candidates with line:col and punctuation tails keep per-start results", () => {
    const text = "/x=/home/u/proj/a.ts:7.";
    const segs = findPathRefs(text, SCOPE) as Seg[];
    expect(concat(segs)).toBe(text);
    expect(refs(segs)).toEqual([{ kind: "ref", text: "/home/u/proj/a.ts:7", path: "/home/u/proj/a.ts", line: 7 }]);
  });
});

describe("logic/preview.js findPathRefs — relative paths (§4.6 rule 1b, 2026-10-07)", () => {
  const REL = "src/web-hub/ui/src/components/detail/DetailDock.vue";
  const REL_PATH = `${SCOPE.cwd}/${REL}`;

  it.each([
    ["after space", `see ${REL} ok`],
    ["after tab", `see\t${REL} ok`],
    ["after newline", `see\n${REL} ok`],
    ["after (", `x(${REL})`],
    ["after [", `x[${REL}]`],
    ['after "', `x"${REL}"`],
    ["after '", `x'${REL}'`],
    ["after =", `path=${REL},`],
    ["JSON-quoted tool args", `{"path": "${REL}"}`],
  ])("clickable: %s", (_label, text) => {
    const segs = findPathRefs(text, SCOPE) as Seg[];
    expect(concat(segs)).toBe(text);
    expect(refs(segs).map((r) => r.path)).toEqual([REL_PATH]);
    expect(refs(segs).map((r) => r.text)).toEqual([REL]);
  });

  it.each([
    ["bare line start (no preceding context)", REL],
    ["mid-word (preceded by a plain letter)", `x${REL}`],
    ["preceded by a digit", `1${REL}`],
  ])("not clickable (conservative line-start exclusion): %s", (_label, text) => {
    const segs = findPathRefs(text, SCOPE) as Seg[];
    expect(concat(segs)).toBe(text);
    expect(refs(segs)).toEqual([]);
  });

  it("no extension on the last segment is never recognized (accepted trade-off)", () => {
    const text = '"path": "src/components/detail"';
    const segs = findPathRefs(text, SCOPE) as Seg[];
    expect(refs(segs)).toEqual([]);
  });

  it("a leading URI scheme is rejected, not misread as a relative path", () => {
    expect(refs(findPathRefs('"url": "http://example.com/foo.ts"', SCOPE) as Seg[])).toEqual([]);
    expect(refs(findPathRefs('"url": "mailto:a@b.com/x.ts"', SCOPE) as Seg[])).toEqual([]);
  });

  it("a //-prefixed candidate is never read as relative (empty leading segment)", () => {
    expect(refs(findPathRefs(`"p": "//${REL}"`, SCOPE) as Seg[])).toEqual([]);
  });

  it("scope.cwd === null disables relative recognition entirely", () => {
    const noCwd = { ...SCOPE, cwd: null };
    expect(refs(findPathRefs(`"path": "${REL}"`, noCwd) as Seg[])).toEqual([]);
  });

  it("scope.cwd === '/' also disables relative recognition (root too broad)", () => {
    const rootCwd = { ...SCOPE, cwd: "/" };
    expect(refs(findPathRefs(`"path": "${REL}"`, rootCwd) as Seg[])).toEqual([]);
  });

  it(":line[:col] stays display-only for a relative candidate too", () => {
    const text = `at "${REL}:12:3" end`;
    const segs = findPathRefs(text, SCOPE) as Seg[];
    expect(concat(segs)).toBe(text);
    expect(refs(segs)).toEqual([{ kind: "ref", text: `${REL}:12:3`, path: REL_PATH, line: 12, col: 3 }]);
  });

  it("resolves against scope.cwd with a trailing slash the same way", () => {
    const trailing = { ...SCOPE, cwd: `${SCOPE.cwd}/` };
    const segs = findPathRefs(`"path": "${REL}"`, trailing) as Seg[];
    expect(refs(segs).map((r) => r.path)).toEqual([REL_PATH]);
  });

  it("an absolute candidate still wins over a would-be relative reading at the same run", () => {
    // `/home/u/proj/a.ts` starts with `/` so the absolute rule applies; the relative rule
    // never even gets a chance (there is no non-empty leading segment before this slash).
    const segs = findPathRefs('"path": "/home/u/proj/a.ts"', SCOPE) as Seg[];
    expect(refs(segs)).toEqual([{ kind: "ref", text: "/home/u/proj/a.ts", path: "/home/u/proj/a.ts" }]);
  });

  it("segments concatenate back to the exact input across mixed absolute+relative text (seeded)", () => {
    const tokens = [REL, "/home/u/proj/a.ts", '"', ":", " ", "=", "text", "http://x/y.ts", "src/components"];
    for (let seed = 1; seed <= 20; seed++) {
      const rand = rng(seed);
      const parts: string[] = [];
      const count = 3 + Math.floor(rand() * 12);
      for (let i = 0; i < count; i++) parts.push(tokens[Math.floor(rand() * tokens.length)]!);
      const text = parts.join("");
      const segs = findPathRefs(text, SCOPE) as Seg[];
      expect(concat(segs)).toBe(text);
    }
  });
});

describe("logic/preview.js pathRefOfCode (inline-code twin)", () => {
  it("a whole-code path is clickable with the same scope rules", () => {
    expect(pathRefOfCode("/home/u/proj/a.ts", SCOPE)).toEqual({ text: "/home/u/proj/a.ts", path: "/home/u/proj/a.ts" });
    expect(pathRefOfCode("/home/u/proj/a.ts:9:2", SCOPE)).toEqual({
      text: "/home/u/proj/a.ts:9:2",
      path: "/home/u/proj/a.ts",
      line: 9,
      col: 2,
    });
    expect(pathRefOfCode(UPLOAD_PATH, SCOPE)?.path).toBe(UPLOAD_PATH);
  });

  it("rejects code spans with whitespace/terminators, out-of-scope or invalid paths, null scope", () => {
    expect(pathRefOfCode("/home/u/proj/a.ts /home/u/proj/b.ts", SCOPE)).toBeNull();
    expect(pathRefOfCode("/home/u/proj/(a.ts)", SCOPE)).toBeNull();
    expect(pathRefOfCode("/etc/passwd", SCOPE)).toBeNull();
    expect(pathRefOfCode("/single", SCOPE)).toBeNull();
    expect(pathRefOfCode("", SCOPE)).toBeNull();
    expect(pathRefOfCode("/home/u/proj/a.ts", null)).toBeNull();
  });

  it("code content is verbatim: trailing punctuation is NOT stripped (unlike prose)", () => {
    expect(pathRefOfCode("/home/u/proj/a.ts.", SCOPE)?.path).toBe("/home/u/proj/a.ts.");
  });

  it("a relative code span resolves against scope.cwd (rule 1b) — display text stays relative", () => {
    expect(pathRefOfCode("src/web-hub/ui/src/components/detail/DetailDock.vue", SCOPE)).toEqual({
      text: "src/web-hub/ui/src/components/detail/DetailDock.vue",
      path: "/home/u/proj/src/web-hub/ui/src/components/detail/DetailDock.vue",
    });
    expect(pathRefOfCode("src/foo.ts:5", SCOPE)).toEqual({
      text: "src/foo.ts:5",
      path: "/home/u/proj/src/foo.ts",
      line: 5,
    });
  });

  it("rejects relative code spans with no extension, a URI scheme, or a null/root cwd", () => {
    expect(pathRefOfCode("src/components/detail", SCOPE)).toBeNull();
    expect(pathRefOfCode("http://example.com/foo.ts", SCOPE)).toBeNull();
    expect(pathRefOfCode("src/foo.ts", { ...SCOPE, cwd: null })).toBeNull();
    expect(pathRefOfCode("src/foo.ts", { ...SCOPE, cwd: "/" })).toBeNull();
  });
});

describe("logic/preview.js scopeKeyOf / clientImageBudget (v3-2, §0)", () => {
  it("scopeKeyOf carries agentKey|sessionId|cwd; null cwd ⇒ empty third field; null scope ⇒ ''", () => {
    expect(scopeKeyOf(SCOPE)).toBe("A|s1|/home/u/proj");
    expect(scopeKeyOf({ ...SCOPE, cwd: null })).toBe("A|s1|");
    expect(scopeKeyOf({ ...SCOPE, cwd: "/other" })).not.toBe(scopeKeyOf(SCOPE));
    expect(scopeKeyOf(null)).toBe("");
    expect(scopeKeyOf(undefined)).toBe("");
  });

  it("clientImageBudget: coarse (touch) ⇒ 20MP, otherwise the server's 40MP", () => {
    expect(clientImageBudget({ coarse: true })).toBe(PREVIEW_CLIENT_PIXELS_COARSE);
    expect(clientImageBudget({ coarse: false })).toBe(PREVIEW_IMAGE_MAX_PIXELS);
    expect(clientImageBudget()).toBe(PREVIEW_IMAGE_MAX_PIXELS);
    expect(PREVIEW_CLIENT_PIXELS_COARSE).toBe(20_000_000);
  });
});

describe("logic/preview.js previewScopeOf — the §4.6 truth table", () => {
  const session = { sessionId: "s1", cwd: "/home/u/proj" };
  it("token mode needs preview.v1; password mode needs preview.lan.v1", () => {
    expect(
      previewScopeOf({ mode: "token", hubCaps: ["preview.v1"], hasTransport: true, agentKey: "A", session }),
    ).toEqual({
      agentKey: "A",
      sessionId: "s1",
      cwd: "/home/u/proj",
      uploads: true,
    });
    expect(
      previewScopeOf({ mode: "token", hubCaps: ["preview.lan.v1"], hasTransport: true, agentKey: "A", session }),
    ).toBeNull();
    // 默认 on (U1) declares BOTH caps ⇒ a LAN (password) browser gets a scope:
    expect(
      previewScopeOf({
        mode: "password",
        hubCaps: ["preview.v1", "preview.lan.v1"],
        hasTransport: true,
        agentKey: "A",
        session,
      }),
    ).toEqual({ agentKey: "A", sessionId: "s1", cwd: "/home/u/proj", uploads: true });
    expect(
      previewScopeOf({ mode: "password", hubCaps: ["preview.v1"], hasTransport: true, agentKey: "A", session }),
    ).toBeNull();
  });

  it("no transport / no caps / no agent / no session ⇒ null", () => {
    expect(
      previewScopeOf({ mode: "token", hubCaps: ["preview.v1"], hasTransport: false, agentKey: "A", session }),
    ).toBeNull();
    expect(previewScopeOf({ mode: "token", hasTransport: true, agentKey: "A", session })).toBeNull();
    expect(
      previewScopeOf({ mode: "token", hubCaps: ["preview.v1"], hasTransport: true, agentKey: null, session }),
    ).toBeNull();
    expect(
      previewScopeOf({ mode: "token", hubCaps: ["preview.v1"], hasTransport: true, agentKey: "A", session: null }),
    ).toBeNull();
    expect(
      previewScopeOf({
        mode: "token",
        hubCaps: ["preview.v1"],
        hasTransport: true,
        agentKey: "A",
        session: { cwd: "/x" },
      }),
    ).toBeNull();
  });

  it("a non-string session.cwd degrades to cwd:null (uploads-marker paths stay clickable)", () => {
    expect(
      previewScopeOf({
        mode: "token",
        hubCaps: ["preview.v1"],
        hasTransport: true,
        agentKey: "A",
        session: { sessionId: "s1" },
      }),
    ).toEqual({ agentKey: "A", sessionId: "s1", cwd: null, uploads: true });
  });
});

describe("logic/preview.js parsePreviewDims / checkPreviewHeaders (pre-body gate, §4.6 transport)", () => {
  const hdrs = (m: Record<string, string>) => ({ get: (n: string) => m[n] ?? null });

  it("parsePreviewDims", () => {
    expect(parsePreviewDims("800x600")).toEqual({ w: 800, h: 600 });
    expect(parsePreviewDims("0x10")).toBeNull();
    expect(parsePreviewDims("axb")).toBeNull();
    expect(parsePreviewDims(null)).toBeNull();
  });

  it("gzip text: the completeness oracle reads X-PWH-Preview-Bytes, not the compressed Content-Length", () => {
    // 2026-10-07 regression: preview-text gzip made Content-Length name the COMPRESSED length
    // while fetch transparently decompresses — keying the oracle on Content-Length mis-judged
    // every ≥2KiB text preview as E_PREVIEW_CHANGED.
    const r = checkPreviewHeaders(
      hdrs({
        [PREVIEW_HDR.kind]: "text",
        [PREVIEW_HDR.size]: "7000",
        [PREVIEW_HDR.bytes]: "7000",
        [PREVIEW_HDR.truncated]: "0",
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": "912", // compressed
        "Content-Encoding": "gzip",
      }),
      { maxPixels: 40_000_000, imageMaxBytes: PREVIEW_IMAGE_MAX_BYTES.loopback },
    );
    expect(r).toEqual({ ok: true, kind: "text", size: 7000, totalSize: 7000, truncated: false });
  });

  it("gzip text without X-PWH-Preview-Bytes ⇒ E_BAD_RESPONSE (never fall back to the compressed length)", () => {
    const r = checkPreviewHeaders(
      hdrs({
        [PREVIEW_HDR.kind]: "text",
        [PREVIEW_HDR.size]: "7000",
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": "912",
        "Content-Encoding": "gzip",
      }),
      { maxPixels: 40_000_000, imageMaxBytes: PREVIEW_IMAGE_MAX_BYTES.loopback },
    );
    expect(r).toEqual({ ok: false, error: "E_BAD_RESPONSE" });
  });

  it("gzip truncated text: bytes (body) stays below size (total)", () => {
    const r = checkPreviewHeaders(
      hdrs({
        [PREVIEW_HDR.kind]: "text",
        [PREVIEW_HDR.size]: "999999",
        [PREVIEW_HDR.bytes]: "262140",
        [PREVIEW_HDR.truncated]: "1",
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": "31000",
        "Content-Encoding": "gzip",
      }),
      { maxPixels: 40_000_000, imageMaxBytes: PREVIEW_IMAGE_MAX_BYTES.loopback },
    );
    expect(r).toEqual({ ok: true, kind: "text", size: 262140, totalSize: 999999, truncated: true });
  });

  it("image ok: kind/mime/size/dims from the headers", () => {
    const r = checkPreviewHeaders(
      hdrs({
        [PREVIEW_HDR.kind]: "image",
        [PREVIEW_HDR.size]: "1234",
        [PREVIEW_HDR.dims]: "800x600",
        "Content-Type": "image/png",
        "Content-Length": "1234",
      }),
      { maxPixels: 40_000_000, imageMaxBytes: PREVIEW_IMAGE_MAX_BYTES.loopback },
    );
    expect(r).toEqual({
      ok: true,
      kind: "image",
      mime: "image/png",
      size: 1234,
      totalSize: 1234,
      dims: { w: 800, h: 600 },
      truncated: false,
    });
  });

  it("image dims over maxPixels ⇒ E_PREVIEW_TOO_LARGE pixels (decided BEFORE the body)", () => {
    const r = checkPreviewHeaders(
      hdrs({
        [PREVIEW_HDR.kind]: "image",
        [PREVIEW_HDR.dims]: "8000x4000", // 32MP
        "Content-Type": "image/jpeg",
        "Content-Length": "100",
      }),
      { maxPixels: PREVIEW_CLIENT_PIXELS_COARSE, imageMaxBytes: PREVIEW_IMAGE_MAX_BYTES.loopback },
    );
    expect(r).toEqual({
      ok: false,
      error: "E_PREVIEW_TOO_LARGE",
      reason: "pixels",
      size: 100,
      max: 20_000_000,
      dims: { w: 8000, h: 4000 },
    });
  });

  it("image Content-Length over the listener byte cap ⇒ E_PREVIEW_TOO_LARGE bytes", () => {
    const r = checkPreviewHeaders(
      hdrs({
        [PREVIEW_HDR.kind]: "image",
        [PREVIEW_HDR.dims]: "10x10",
        "Content-Type": "image/png",
        "Content-Length": String(PREVIEW_IMAGE_MAX_BYTES.lan + 1),
      }),
      { maxPixels: 40_000_000, imageMaxBytes: PREVIEW_IMAGE_MAX_BYTES.lan },
    );
    expect(r).toMatchObject({
      ok: false,
      error: "E_PREVIEW_TOO_LARGE",
      reason: "bytes",
      max: PREVIEW_IMAGE_MAX_BYTES.lan,
    });
  });

  it("image dims missing/unparseable ⇒ E_PREVIEW_UNSUPPORTED dims-unknown", () => {
    for (const dims of [undefined, "garbage"]) {
      const r = checkPreviewHeaders(
        hdrs({
          [PREVIEW_HDR.kind]: "image",
          ...(dims === undefined ? {} : { [PREVIEW_HDR.dims]: dims }),
          "Content-Type": "image/png",
          "Content-Length": "10",
        }),
        { maxPixels: 40_000_000 },
      );
      expect(r).toMatchObject({ ok: false, error: "E_PREVIEW_UNSUPPORTED", reason: "dims-unknown" });
    }
  });

  it("text ok: truncated flag, display size from X-PWH-Preview-Size (> Content-Length when truncated)", () => {
    const r = checkPreviewHeaders(
      hdrs({
        [PREVIEW_HDR.kind]: "text",
        [PREVIEW_HDR.size]: "300000",
        [PREVIEW_HDR.truncated]: "1",
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": String(PREVIEW_TEXT_MAX_BYTES),
      }),
      {},
    );
    expect(r).toEqual({ ok: true, kind: "text", size: PREVIEW_TEXT_MAX_BYTES, totalSize: 300000, truncated: true });
  });

  it("text body over the 256KiB cap ⇒ E_PREVIEW_TOO_LARGE bytes", () => {
    const r = checkPreviewHeaders(
      hdrs({
        [PREVIEW_HDR.kind]: "text",
        "Content-Type": "text/plain",
        "Content-Length": String(PREVIEW_TEXT_MAX_BYTES + 1),
      }),
      {},
    );
    expect(r).toMatchObject({ ok: false, error: "E_PREVIEW_TOO_LARGE", reason: "bytes", max: PREVIEW_TEXT_MAX_BYTES });
  });

  it("out-of-contract headers ⇒ E_BAD_RESPONSE (kind / Content-Length / Content-Type)", () => {
    expect(checkPreviewHeaders(hdrs({ "Content-Length": "1" }), {})).toMatchObject({
      ok: false,
      error: "E_BAD_RESPONSE",
    });
    expect(checkPreviewHeaders(hdrs({ [PREVIEW_HDR.kind]: "text", "Content-Type": "text/plain" }), {})).toMatchObject({
      ok: false,
      error: "E_BAD_RESPONSE",
    });
    expect(
      checkPreviewHeaders(hdrs({ [PREVIEW_HDR.kind]: "text", "Content-Type": "text/html", "Content-Length": "1" }), {}),
    ).toMatchObject({ ok: false, error: "E_BAD_RESPONSE" });
    expect(
      checkPreviewHeaders(
        hdrs({
          [PREVIEW_HDR.kind]: "image",
          [PREVIEW_HDR.dims]: "1x1",
          "Content-Type": "image/svg+xml",
          "Content-Length": "1",
        }),
        {},
      ),
    ).toMatchObject({ ok: false, error: "E_BAD_RESPONSE" });
    expect(checkPreviewHeaders(undefined, {})).toMatchObject({ ok: false, error: "E_BAD_RESPONSE" });
  });
});

describe("logic/preview.js previewOutcomeFromResponse (shared non-200 mapping)", () => {
  const resp = (status: number, body: unknown, headers: Record<string, string> = {}, jsonThrows = false) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => headers[n] ?? null },
    json: async () => {
      if (jsonThrows) throw new Error("not json");
      return body;
    },
  });

  it("carries the wire body's reason/size/max/dims and folds Retry-After (header wins over body)", async () => {
    const out = await previewOutcomeFromResponse(
      resp(
        413,
        {
          error: "E_PREVIEW_TOO_LARGE",
          reason: "pixels",
          size: 9,
          max: 40_000_000,
          dims: { w: 8000, h: 6000 },
          retryAfterS: 9,
        },
        { "Retry-After": "3" },
      ),
    );
    expect(out).toEqual({
      ok: false,
      status: 413,
      error: "E_PREVIEW_TOO_LARGE",
      reason: "pixels",
      size: 9,
      max: 40_000_000,
      dims: { w: 8000, h: 6000 },
      retryAfterS: 3,
    });
  });

  it("401 without a body ⇒ E_AUTH; other statuses without a body ⇒ HTTP <status>", async () => {
    expect(await previewOutcomeFromResponse(resp(401, undefined, {}, true))).toEqual({
      ok: false,
      status: 401,
      error: "E_AUTH",
    });
    expect(await previewOutcomeFromResponse(resp(500, undefined, {}, true))).toEqual({
      ok: false,
      status: 500,
      error: "HTTP 500",
    });
  });
});

describe("logic/preview.js classifyPreviewError (§3.2 phase taxonomy)", () => {
  it("415 E_PREVIEW_UNSUPPORTED ⇒ unsupported (reason/size ride through)", () => {
    expect(classifyPreviewError(415, { error: "E_PREVIEW_UNSUPPORTED", reason: "binary", size: 42 })).toEqual({
      kind: "unsupported",
      error: "E_PREVIEW_UNSUPPORTED",
      status: 415,
      reason: "binary",
      size: 42,
    });
  });

  it("413 E_PREVIEW_TOO_LARGE ⇒ tooLarge (dims parsed)", () => {
    expect(
      classifyPreviewError(413, {
        error: "E_PREVIEW_TOO_LARGE",
        reason: "pixels",
        size: 1,
        max: 40_000_000,
        dims: { w: 8, h: 6 },
      }),
    ).toEqual({
      kind: "tooLarge",
      error: "E_PREVIEW_TOO_LARGE",
      status: 413,
      reason: "pixels",
      size: 1,
      max: 40_000_000,
      dims: { w: 8, h: 6 },
    });
  });

  it("409 E_SESSION_CHANGED ⇒ session-changed (usePreview closes directly)", () => {
    expect(classifyPreviewError(409, { error: "E_SESSION_CHANGED" })).toEqual({
      kind: "session-changed",
      error: "E_SESSION_CHANGED",
      status: 409,
    });
  });

  it.each([
    ["E_DEADLINE", 0, true],
    ["E_NETWORK", 0, true],
    ["E_RATE", 429, true],
    ["E_BUSY", 503, true],
    ["E_HUB_RESTARTING", 503, true],
    ["E_ABORT", 0, false],
    ["E_AUTH", 401, false],
    ["E_PREVIEW_DENIED", 403, false],
    ["E_BAD_RESPONSE", 0, false],
    ["E_PREVIEW_CHANGED", 409, false],
    ["E_NOT_FOUND", 404, false],
  ])("%s (status %i) ⇒ error, retryable=%s", (error, status, retryable) => {
    expect(classifyPreviewError(status, { error })).toMatchObject({ kind: "error", error, status, retryable });
  });

  it("retryAfterS rides error outcomes; a bare status synthesizes the code", () => {
    expect(classifyPreviewError(429, { error: "E_RATE", retryAfterS: 2 })).toMatchObject({ retryAfterS: 2 });
    expect(classifyPreviewError(401, undefined)).toMatchObject({ kind: "error", error: "E_AUTH", retryable: false });
    expect(classifyPreviewError(500, null)).toMatchObject({ error: "HTTP 500", retryable: true });
    expect(classifyPreviewError(0, null)).toMatchObject({ error: "E_NETWORK", retryable: true });
  });
});

describe("logic/preview.js markdown pure functions (dir-plan §4.1/§4.3, PM package)", () => {
  describe("isMarkdownPath (B1: extension check, client-side)", () => {
    it.each([
      ["/home/u/proj/README.md", true],
      ["/home/u/proj/notes.MARKDOWN", true], // case-insensitive
      ["a.md", true], // bare basename works too (path or basename)
      ["dir/x.markdown", true],
      ["dir/x.mdx", false], // .mdx deliberately excluded
      ["dir/x.md.txt", false],
      ["dir/x.markdown/", false], // a trailing slash is not an md file
      ["dir/markdown", false],
      ["dir/.md", true], // dotfile whose whole name is the extension
      ["", false],
      [null, false],
      [42, false],
      [undefined, false],
    ])("%j ⇒ %s", (path, expected) => {
      expect(isMarkdownPath(path as unknown)).toBe(expected);
    });
  });

  describe("prepareMarkdownPreview (B5: drop the truncated tail's incomplete last line)", () => {
    it("non-truncated bodies pass through byte-identical", () => {
      expect(prepareMarkdownPreview("# Hi\nhalf", false)).toBe("# Hi\nhalf");
      expect(prepareMarkdownPreview("# Hi\nhalf", undefined)).toBe("# Hi\nhalf");
    });
    it("truncated: everything after the LAST newline is dropped (the possibly-half line)", () => {
      expect(prepareMarkdownPreview("a\nb\nchopped li", true)).toBe("a\nb");
      expect(prepareMarkdownPreview("a\nb\n", true)).toBe("a\nb");
      expect(prepareMarkdownPreview("\nonly-half", true)).toBe("");
    });
    it("truncated with NO newline returns the input as-is (it IS the one incomplete line)", () => {
      expect(prepareMarkdownPreview("chopped heading", true)).toBe("chopped heading");
    });
    it('non-string inputs degrade to "" instead of throwing', () => {
      expect(prepareMarkdownPreview(undefined, true)).toBe("");
      expect(prepareMarkdownPreview(7, true)).toBe("");
    });
  });

  describe("countMdNodes (§4.3/B7: AST budget count with early stop)", () => {
    it("counts every block and inline node exactly", () => {
      // paragraph + em + text = 3
      expect(countMdNodes(parseMarkdown("*a*"))).toBe(3);
      // code_block = 1; heading + text = 2; list + item-inline(text) = 2
      expect(countMdNodes(parseMarkdown("```\nx```"))).toBe(1);
      expect(countMdNodes(parseMarkdown("# h"))).toBe(2);
      expect(countMdNodes(parseMarkdown("- a\n- b"))).toBe(3);
      // table: table + one inline per header cell (2) + one per row cell (2) = 5
      expect(countMdNodes(parseMarkdown("| a | b |\n|---|---|\n| 1 | 2 |"))).toBe(5);
    });

    it("early-stops exactly at cap (exact up to cap, ≥ cap beyond)", () => {
      const nodes = parseMarkdown("*a*"); // 3 nodes total
      expect(countMdNodes(nodes, 1)).toBe(1);
      expect(countMdNodes(nodes, 2)).toBe(2);
      expect(countMdNodes(nodes, 3)).toBe(3);
      expect(countMdNodes(nodes, 99)).toBe(3);
    });

    it("the budget boolean `count > PREVIEW_MD_NODE_MAX` is exact at the boundary", () => {
      expect(PREVIEW_MD_NODE_MAX).toBe(20_000);
      const small = parseMarkdown("*a* ".repeat(3000)); // 3000 × (em + text) = 6000 ≤ 20000
      expect(countMdNodes(small) > PREVIEW_MD_NODE_MAX).toBe(false);
      const big = parseMarkdown("*a* ".repeat(30000)); // 60000 > 20000
      expect(countMdNodes(big) > PREVIEW_MD_NODE_MAX).toBe(true);
      // and the early stop means the pathological walk never finishes: it returns ≤ MAX + 1
      expect(countMdNodes(big)).toBeLessThanOrEqual(PREVIEW_MD_NODE_MAX + 1);
    });

    it("non-array input degrades to 0 (never throws)", () => {
      expect(countMdNodes(undefined)).toBe(0);
      expect(countMdNodes(null)).toBe(0);
      expect(countMdNodes([{ type: "paragraph", children: [] }], 0)).toBe(0); // cap ≤ 0 ⇒ 0
    });
  });
});
