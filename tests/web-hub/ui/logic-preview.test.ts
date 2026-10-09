// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../../../src/web-hub/ui/src/logic/markdown.js";
import { findPathRefsRef } from "./fixtures/preview-findpathrefs-ref.js";
import {
  __previewScanStats,
  __resetPreviewScanStats,
  checkPreviewHeaders,
  childPreviewPath,
  classifyPreviewError,
  clientImageBudget,
  countMdNodes,
  findPathRefs,
  formatPreviewBytes,
  isMarkdownPath,
  parentPreviewPath,
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

/* ===========================================================================
 * dir-plan v3.1 §2.5/§5 P2 additions — every block above this marker is FROZEN (旧用例一条
 * 不改). New groups: abs scope, dirs scope (A5 a/b/c), §2.5.3 backticks, navigation truth
 * tables, the header gate, formatPreviewBytes, the §2.5.2 operation-count performance gate
 * and the differential correctness gates (legacy vs the frozen pre-P2 reference in
 * fixtures/preview-findpathrefs-ref.js; abs/dirs/abs+dirs vs the naive in-file oracle).
 * ======================================================================== */

const ABS_SCOPE = { ...SCOPE, abs: true } as typeof SCOPE & { abs: true };
const DIRS_SCOPE = { ...SCOPE, dirs: true } as typeof SCOPE & { dirs: true };
const BOTH_SCOPE = { ...SCOPE, abs: true, dirs: true } as typeof SCOPE & { abs: true; dirs: true };

describe("logic/preview.js findPathRefs — abs scope (dir-plan §2.5.1 C4, U4)", () => {
  it("cwd-external absolute paths become clickable; protocol shape still required (≥2 segments)", () => {
    const segs = findPathRefs("see /etc/hostname now", ABS_SCOPE) as Seg[];
    expect(concat(segs)).toBe("see /etc/hostname now");
    expect(refs(segs)).toEqual([{ kind: "ref", text: "/etc/hostname", path: "/etc/hostname" }]);
    const segs2 = findPathRefs("/tmp/x.log done", ABS_SCOPE) as Seg[];
    expect(refs(segs2).map((r) => r.path)).toEqual(["/tmp/x.log"]);
  });

  it("one-segment paths stay unclickable even under abs (/help, /reload never become candidates)", () => {
    expect(refs(findPathRefs("see /single now", ABS_SCOPE) as Seg[])).toEqual([]);
    expect(refs(findPathRefs("/help /reload", ABS_SCOPE) as Seg[])).toEqual([]);
  });

  it("invalid segments (empty / . / ..) and NUL stay unclickable under abs", () => {
    expect(refs(findPathRefs("x /a/../b y", ABS_SCOPE) as Seg[])).toEqual([]);
    expect(refs(findPathRefs("x //a/b y", ABS_SCOPE) as Seg[])).toEqual([]);
    expect(refs(findPathRefs("x /a/./b y", ABS_SCOPE) as Seg[])).toEqual([]);
  });

  it("cwd === null: absolute paths clickable, relative recognition stays off", () => {
    const noCwd = { ...ABS_SCOPE, cwd: null };
    expect(refs(findPathRefs("/etc/hostname", noCwd) as Seg[]).map((r) => r.path)).toEqual(["/etc/hostname"]);
    expect(refs(findPathRefs('"path": "src/foo.ts"', noCwd) as Seg[])).toEqual([]);
  });

  it("the marker/cwd rules become moot but keep working; uploads:false does not narrow abs", () => {
    const noUploads = { ...ABS_SCOPE, uploads: false };
    expect(refs(findPathRefs(UPLOAD_PATH, noUploads) as Seg[]).map((r) => r.path)).toEqual([UPLOAD_PATH]);
    // legacy + uploads:false keeps the cwd route (only the marker route is disabled)
    expect(refs(findPathRefs("/home/u/proj/a.ts", { ...SCOPE, uploads: false }) as Seg[]).map((r) => r.path)).toEqual([
      "/home/u/proj/a.ts",
    ]);
    expect(refs(findPathRefs(UPLOAD_PATH, { ...SCOPE, uploads: false }) as Seg[])).toEqual([]);
  });

  it("start contexts unchanged: mid-word still rejected, = and ( still openers", () => {
    expect(refs(findPathRefs("x/etc/hostname", ABS_SCOPE) as Seg[])).toEqual([]);
    expect(refs(findPathRefs("open=/etc/hostname,", ABS_SCOPE) as Seg[]).map((r) => r.path)).toEqual(["/etc/hostname"]);
    expect(refs(findPathRefs("(/etc/hostname)", ABS_SCOPE) as Seg[]).map((r) => r.path)).toEqual(["/etc/hostname"]);
  });

  it("pathRefOfCode: any protocol-valid absolute code span is clickable under abs", () => {
    expect(pathRefOfCode("/etc/hostname", ABS_SCOPE)).toEqual({ text: "/etc/hostname", path: "/etc/hostname" });
    expect(pathRefOfCode("/etc/hostname:4", ABS_SCOPE)).toEqual({
      text: "/etc/hostname:4",
      path: "/etc/hostname",
      line: 4,
    });
    // the trailing-slash form is a dirs (A5) rule, not an abs rule — stays rejected here
    expect(pathRefOfCode("/etc/dir/", ABS_SCOPE)).toBeNull();
  });
});

describe("logic/preview.js findPathRefs — dirs scope (dir-plan A5 (a)/(b)/(c))", () => {
  it("(a) an absolute path with ONE trailing slash loses it in the request path, keeps it in the display", () => {
    const segs = findPathRefs("/home/u/proj/dir/", DIRS_SCOPE) as Seg[];
    expect(concat(segs)).toBe("/home/u/proj/dir/");
    expect(refs(segs)).toEqual([{ kind: "ref", text: "/home/u/proj/dir/", path: "/home/u/proj/dir" }]);
  });

  it("(a) trailing slash also works outside cwd under abs+dirs", () => {
    const segs = findPathRefs("see /etc/nginx/ now", BOTH_SCOPE) as Seg[];
    expect(refs(segs)).toEqual([{ kind: "ref", text: "/etc/nginx/", path: "/etc/nginx" }]);
  });

  it("(a) more than one trailing slash is NOT folded — the second stays in the (invalid) path", () => {
    expect(refs(findPathRefs("/home/u/proj/dir//", DIRS_SCOPE) as Seg[])).toEqual([]);
  });

  it("(a) a slash-only tail right after the first segment never yields an empty/1-segment path", () => {
    expect(refs(findPathRefs("x /home/ y", DIRS_SCOPE) as Seg[])).toEqual([]); // "/home/" → "/home" = 1 segment
  });

  it("(b) a relative path ENDING with a slash resolves without it; display keeps the slash", () => {
    const segs = findPathRefs('"src/components/"', DIRS_SCOPE) as Seg[];
    expect(concat(segs)).toBe('"src/components/"');
    expect(refs(segs)).toEqual([{ kind: "ref", text: "src/components/", path: "/home/u/proj/src/components" }]);
    const single = findPathRefs('"src/"', DIRS_SCOPE) as Seg[]; // guard case: the slash IS s0
    expect(refs(single)).toEqual([{ kind: "ref", text: "src/", path: "/home/u/proj/src" }]);
  });

  it("(c) paired-quote no-extension relative paths resolve (double, single, backtick)", () => {
    expect(refs(findPathRefs('"src/components"', DIRS_SCOPE) as Seg[])).toEqual([
      { kind: "ref", text: "src/components", path: "/home/u/proj/src/components" },
    ]);
    expect(refs(findPathRefs("'src/components'", DIRS_SCOPE) as Seg[])).toEqual([
      { kind: "ref", text: "src/components", path: "/home/u/proj/src/components" },
    ]);
    expect(refs(findPathRefs("`src/components`", DIRS_SCOPE) as Seg[])).toEqual([
      { kind: "ref", text: "src/components", path: "/home/u/proj/src/components" },
    ]);
  });

  it("(c) the pair must CLOSE at the run's stripped end — mismatched quotes do not count", () => {
    expect(refs(findPathRefs("\"src/components'", DIRS_SCOPE) as Seg[])).toEqual([]);
    expect(refs(findPathRefs('"src/components x"', DIRS_SCOPE) as Seg[])).toEqual([]);
  });

  it("bare no-extension relative paths are STILL not recognized (A5: 裸写 src/components 不识别)", () => {
    expect(refs(findPathRefs("bare src/components here", DIRS_SCOPE) as Seg[])).toEqual([]);
    expect(refs(findPathRefs("bare src/components here", BOTH_SCOPE) as Seg[])).toEqual([]);
  });

  it("extension-shaped relative paths keep their pre-dirs behavior under dirs", () => {
    const segs = findPathRefs(`"path": "src/foo.ts"`, DIRS_SCOPE) as Seg[];
    expect(refs(segs).map((r) => r.path)).toEqual(["/home/u/proj/src/foo.ts"]);
  });

  it(":line[:col] stays display-only for dirs candidates too (b) and (c)", () => {
    const b = findPathRefs('"src/components/:12"', DIRS_SCOPE) as Seg[];
    expect(refs(b)).toEqual([
      { kind: "ref", text: "src/components/:12", path: "/home/u/proj/src/components", line: 12 },
    ]);
    const c = findPathRefs("`src/foo.ts:12:3`", DIRS_SCOPE) as Seg[];
    expect(refs(c)).toEqual([
      { kind: "ref", text: "src/foo.ts:12:3", path: "/home/u/proj/src/foo.ts", line: 12, col: 3 },
    ]);
  });

  it("dirs alone does NOT make cwd-external absolute paths clickable (that is the abs cap)", () => {
    expect(refs(findPathRefs("see /etc/hostname now", DIRS_SCOPE) as Seg[])).toEqual([]);
  });

  it("pathRefOfCode under dirs: no-extension + trailing-slash relative code spans resolve", () => {
    expect(pathRefOfCode("src/components", DIRS_SCOPE)).toEqual({
      text: "src/components",
      path: "/home/u/proj/src/components",
    });
    expect(pathRefOfCode("src/a/", DIRS_SCOPE)).toEqual({ text: "src/a/", path: "/home/u/proj/src/a" });
    expect(pathRefOfCode("src/", DIRS_SCOPE)).toEqual({ text: "src/", path: "/home/u/proj/src" });
    expect(pathRefOfCode("src/components:5", DIRS_SCOPE)).toEqual({
      text: "src/components:5",
      path: "/home/u/proj/src/components",
      line: 5,
    });
    // guards: no slash, a URI scheme, a null cwd — all still rejected
    expect(pathRefOfCode("components", DIRS_SCOPE)).toBeNull();
    expect(pathRefOfCode("http://example.com/x", DIRS_SCOPE)).toBeNull();
    expect(pathRefOfCode("src/components", { ...DIRS_SCOPE, cwd: null })).toBeNull();
    expect(pathRefOfCode("src/components", { ...DIRS_SCOPE, cwd: "/" })).toBeNull();
    // legacy scopes are untouched by the dirs rules
    expect(pathRefOfCode("src/components", SCOPE)).toBeNull();
    expect(pathRefOfCode("src/a/", SCOPE)).toBeNull();
  });

  it("pathRefOfCode under dirs: absolute code spans may carry one trailing slash", () => {
    expect(pathRefOfCode("/home/u/proj/dir/", DIRS_SCOPE)).toEqual({
      text: "/home/u/proj/dir/",
      path: "/home/u/proj/dir",
    });
    expect(pathRefOfCode("/etc/dir/", BOTH_SCOPE)).toEqual({ text: "/etc/dir/", path: "/etc/dir" });
  });
});

describe("logic/preview.js findPathRefs — §2.5.3 backticks (extended start set)", () => {
  it("a backtick opens an ABSOLUTE candidate under abs/dirs (and still terminates it)", () => {
    expect(refs(findPathRefs("`/etc/hostname`", ABS_SCOPE) as Seg[]).map((r) => r.path)).toEqual(["/etc/hostname"]);
    expect(refs(findPathRefs("`/home/u/proj/dir/`", BOTH_SCOPE) as Seg[])).toEqual([
      { kind: "ref", text: "/home/u/proj/dir/", path: "/home/u/proj/dir" },
    ]);
  });

  it("prose `and/or` becomes a candidate (accepted cost — the probe answers missing)", () => {
    expect(refs(findPathRefs("`and/or`", DIRS_SCOPE) as Seg[])).toEqual([
      { kind: "ref", text: "and/or", path: "/home/u/proj/and/or" },
    ]);
  });

  it("an UNPAIRED backtick does not recognize a relative candidate (foo`bar/baz)", () => {
    expect(refs(findPathRefs("foo`bar/baz qux", DIRS_SCOPE) as Seg[])).toEqual([]);
  });

  it("`src/foo.ts:12` keeps :12 in the display and drops it from the request path", () => {
    const segs = findPathRefs("`src/foo.ts:12`", DIRS_SCOPE) as Seg[];
    expect(refs(segs)).toEqual([{ kind: "ref", text: "src/foo.ts:12", path: "/home/u/proj/src/foo.ts", line: 12 }]);
  });

  it("legacy scopes: a backtick is NOT a start char — behavior identical to today", () => {
    expect(refs(findPathRefs("`/home/u/proj/a.ts`", SCOPE) as Seg[])).toEqual([]);
    expect(refs(findPathRefs("`src/components`", SCOPE) as Seg[])).toEqual([]);
  });
});

describe("logic/preview.js findPathRefs — full-width/CJK punctuation terminators (2026-10-09 fix)", () => {
  /** The user report: `预览图：/tmp/cmdprev/cmd-badge-options.png（点开）` used to absorb `（点开`
   * into the ref because `（` sat only in START_CHARS. Now EVERY full-width/CJK punctuation
   * char in the §4.6 rule-2 set terminates the candidate in BOTH directions — openers too,
   * exactly like the ASCII `(`/`)` pair — while non-punctuation CJK (中文目录名) never
   * terminates, so CJK dir names stay clickable. */
  const P = "/home/u/proj/a.ts";
  it.each([
    [
      "（ opener absorbs following prose — the exact report shape",
      "预览图：/tmp/cmdprev/cmd-badge-options.png（点开）",
      "/tmp/cmdprev/cmd-badge-options.png",
    ],
    ["（", `${P}（点开）`, P],
    ["【", `${P}【注】`, P],
    ["「", `${P}「注」`, P],
    ["『", `${P}『注』`, P],
    ["《", `${P}《书》`, P],
    ["〈", `${P}〈注〉`, P],
    ["〉 (space-started path — 〉 is a pure closer, not an opener)", `see ${P}〉好`, P],
    ["…", `${P}…`, P],
  ])("ends at full-width opener/punct %s", (_label, text, expected) => {
    const segs = findPathRefs(text, ABS_SCOPE) as Seg[];
    expect(concat(segs)).toBe(text);
    expect(refs(segs).map((r) => r.path)).toEqual([expected]);
    expect(refs(segs).map((r) => r.text)).toEqual([expected]);
  });

  it.each([
    ["，", `${P}，好`],
    ["。", `${P}。`],
    ["、", `${P}、好`],
    ["；", `${P}；好`],
    ["：", `${P}：好`],
    ["！", `${P}！好`],
    ["？", `${P}？好`],
    ["）", `（${P}）`],
    ["】", `【${P}】`],
    ["」", `「${P}」`],
    ["』", `『${P}』`],
    ["》", `《${P}》`],
  ])("already-terminator full-width punct %s keeps terminating (cwd scope)", (_label, text) => {
    const segs = findPathRefs(text, SCOPE) as Seg[];
    expect(concat(segs)).toBe(text);
    expect(refs(segs).map((r) => r.path)).toEqual([P]);
  });

  it.each([
    ["（…）", `看（${P}）好`],
    ["「…」", `看「${P}」好`],
    ["『…』", `看『${P}』好`],
    ["【…】", `看【${P}】好`],
    ["《…》", `看《${P}》好`],
  ])("a path wrapped in full-width brackets %s stays a single clean ref", (_label, text) => {
    const segs = findPathRefs(text, SCOPE) as Seg[];
    expect(concat(segs)).toBe(text);
    expect(refs(segs).map((r) => r.path)).toEqual([P]);
    expect(refs(segs).map((r) => r.text)).toEqual([P]);
  });

  it("the new openers still OPEN a candidate (dual role, like ASCII `(`): mid-text after CJK prose", () => {
    // `（` right after prose used to be start-only; it now ALSO ends the previous run —
    // the path after it must still start cleanly.
    for (const opener of ["（", "【", "「", "『", "《"]) {
      const segs = findPathRefs(`看这${opener}${P}）好`, SCOPE) as Seg[];
      expect(concat(segs)).toBe(`看这${opener}${P}）好`);
      expect(refs(segs).map((r) => r.path)).toEqual([P]);
    }
  });

  it("non-punctuation CJK inside a path does NOT terminate (中文目录名 stays clickable)", () => {
    const cjk = "/home/u/proj/中文目录/图.png";
    const segs = findPathRefs(`图在 ${cjk}（点开）`, SCOPE) as Seg[];
    expect(concat(segs)).toBe(`图在 ${cjk}（点开）`);
    expect(refs(segs)).toEqual([{ kind: "ref", text: cjk, path: cjk }]);
    const absCjk = findPathRefs(`预览图：/tmp/cmdprev/中文图.png（点开）`, ABS_SCOPE) as Seg[];
    expect(refs(absCjk).map((r) => r.path)).toEqual(["/tmp/cmdprev/中文图.png"]);
  });

  it("a relative candidate with CJK segments ends at full-width punctuation too", () => {
    const segs = findPathRefs('"src/中文/foo.ts"，好', SCOPE) as Seg[];
    expect(concat(segs)).toBe('"src/中文/foo.ts"，好');
    expect(refs(segs)).toEqual([{ kind: "ref", text: "src/中文/foo.ts", path: "/home/u/proj/src/中文/foo.ts" }]);
  });

  it("pathRefOfCode keeps rejecting code spans with the new terminators (verbatim code content)", () => {
    expect(pathRefOfCode(`${P}（点开）`, SCOPE)).toBeNull();
    expect(pathRefOfCode(`${P}…`, SCOPE)).toBeNull();
    expect(pathRefOfCode(`${P}〈注〉`, SCOPE)).toBeNull();
  });
});

describe("logic/preview.js previewScopeOf / scopeKeyOf — §2.5.1 abs/dirs caps", () => {
  const session = { sessionId: "s1", cwd: "/home/u/proj" };
  const base = { mode: "token" as const, hubCaps: ["preview.v1"], hasTransport: true, agentKey: "A", session };

  it("previewScopeOf adds abs/dirs keys ONLY when the hub declares the caps", () => {
    expect(previewScopeOf(base)).toEqual({ agentKey: "A", sessionId: "s1", cwd: "/home/u/proj", uploads: true });
    expect(previewScopeOf({ ...base, hubCaps: ["preview.v1", "preview.abs.v1"] })).toEqual({
      agentKey: "A",
      sessionId: "s1",
      cwd: "/home/u/proj",
      uploads: true,
      abs: true,
    });
    expect(previewScopeOf({ ...base, hubCaps: ["preview.v1", "preview.dir.v1"] })).toEqual({
      agentKey: "A",
      sessionId: "s1",
      cwd: "/home/u/proj",
      uploads: true,
      dirs: true,
    });
    expect(previewScopeOf({ ...base, hubCaps: ["preview.v1", "preview.abs.v1", "preview.dir.v1"] })).toEqual({
      agentKey: "A",
      sessionId: "s1",
      cwd: "/home/u/proj",
      uploads: true,
      abs: true,
      dirs: true,
    });
  });

  it("scopeKeyOf appends |abs / |dir for the flags — format unchanged when absent", () => {
    expect(scopeKeyOf(SCOPE)).toBe("A|s1|/home/u/proj");
    expect(scopeKeyOf(ABS_SCOPE)).toBe("A|s1|/home/u/proj|abs");
    expect(scopeKeyOf(DIRS_SCOPE)).toBe("A|s1|/home/u/proj|dir");
    expect(scopeKeyOf(BOTH_SCOPE)).toBe("A|s1|/home/u/proj|abs|dir");
    // a cap change invalidates the key — the probe LRU partitions naturally
    expect(scopeKeyOf(ABS_SCOPE)).not.toBe(scopeKeyOf(SCOPE));
  });
});

describe("logic/preview.js checkPreviewHeaders — dir gate (dir-plan §1.3 fetch path)", () => {
  const hdrs = (m: Record<string, string>) => ({ get: (n: string) => m[n] ?? null });

  it("Kind: dir WITHOUT the opt-in ⇒ E_BAD_RESPONSE (a single-response contract violation)", () => {
    expect(checkPreviewHeaders(hdrs({ [PREVIEW_HDR.kind]: "dir" }), {})).toEqual({
      ok: false,
      error: "E_BAD_RESPONSE",
    });
  });

  it("Kind: dir WITH dir:true ⇒ ok dir — the body gate moves to the capped read + parser", () => {
    expect(checkPreviewHeaders(hdrs({ [PREVIEW_HDR.kind]: "dir" }), { dir: true })).toEqual({
      ok: true,
      kind: "dir",
    });
  });

  it("the dir flag never loosens the text/image paths (dir:true + Kind: text behaves as before)", () => {
    const r = checkPreviewHeaders(
      hdrs({
        [PREVIEW_HDR.kind]: "text",
        [PREVIEW_HDR.size]: "10",
        [PREVIEW_HDR.truncated]: "0",
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": "10",
      }),
      { dir: true },
    );
    expect(r).toEqual({ ok: true, kind: "text", size: 10, totalSize: 10, truncated: false });
  });
});

describe("logic/preview.js childPreviewPath / parentPreviewPath — A3 navigation truth tables", () => {
  it("childPreviewPath: joins one legal segment, normalizes the parent's trailing slash", () => {
    expect(childPreviewPath("/home/u/proj", "a.ts")).toBe("/home/u/proj/a.ts");
    expect(childPreviewPath("/home/u/proj/", "a.ts")).toBe("/home/u/proj/a.ts");
    expect(childPreviewPath("/home", "u")).toBe("/home/u"); // one-segment parents are legal
  });

  it("childPreviewPath: rejects illegal names and non-absolute parents", () => {
    for (const name of ["", ".", "..", "a/b", "a\0b"]) {
      expect(childPreviewPath("/home/u", name)).toBeNull();
    }
    expect(childPreviewPath("home/u", "a")).toBeNull();
    expect(childPreviewPath("/", "a")).toBeNull(); // "/" is never a listing parent
    expect(childPreviewPath(undefined, "a")).toBeNull();
    expect(childPreviewPath("/home/u", undefined)).toBeNull();
  });

  it('parentPreviewPath: walks up to ONE segment and stops ("/" itself is not listable)', () => {
    expect(parentPreviewPath("/home/u/proj")).toBe("/home/u");
    expect(parentPreviewPath("/home/u")).toBe("/home");
    expect(parentPreviewPath("/home/u/proj/")).toBe("/home/u"); // trailing slash normalized
    expect(parentPreviewPath("/home")).toBeNull(); // up would be "/"
    expect(parentPreviewPath("/")).toBeNull();
    expect(parentPreviewPath("home/u")).toBeNull();
    expect(parentPreviewPath(42)).toBeNull();
  });
});

describe("logic/preview.js formatPreviewBytes — A1 size column", () => {
  it.each([
    [0, "0 B"],
    [1, "1 B"],
    [512, "512 B"],
    [1023, "1023 B"],
    [1024, "1.0 KiB"],
    [1536, "1.5 KiB"],
    [2048, "2.0 KiB"],
    [5 * 1024 * 1024, "5.0 MiB"],
    [3 * 1024 ** 3, "3.0 GiB"],
    [5 * 1024 ** 4, "5120.0 GiB"], // caps at GiB — a directory listing never reaches this anyway
  ])("%i ⇒ %s", (n, expected) => {
    expect(formatPreviewBytes(n)).toBe(expected);
  });

  it('non-finite / negative / non-number input degrades to "" (statPartial rows render nothing)', () => {
    expect(formatPreviewBytes(undefined)).toBe("");
    expect(formatPreviewBytes(null)).toBe("");
    expect(formatPreviewBytes(-1)).toBe("");
    expect(formatPreviewBytes(Number.NaN)).toBe("");
    expect(formatPreviewBytes(Number.POSITIVE_INFINITY)).toBe("");
    expect(formatPreviewBytes("12")).toBe("");
  });
});

/* ---------------------------------------------------------------------------
 * §2.5.2's naive oracle (I3): an independent per-candidate reimplementation — every
 * candidate's end P, validation and scope routing are recomputed from scratch with the
 * protocol's own validatePreviewPath; nothing is memoized across candidates. It shares NO
 * code with the live implementation except the protocol constants.
 * ------------------------------------------------------------------------- */

const O_TERMINATORS = new Set([
  '"',
  "'",
  "<",
  ">",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "|",
  ",",
  ";",
  "`",
  "，",
  "。",
  "；",
  "：",
  "！",
  "？",
  "、",
  "（", // 2026-10-09 fix: full-width/CJK punctuation terminates BOTH directions — kept in
  "）", // lockstep with the live TERMINATOR_CHARS and the re-frozen reference fixture.
  "【",
  "】",
  "「",
  "」",
  "『",
  "』",
  "《",
  "》",
  "〈",
  "〉",
  "…",
]);
const O_WS = /\s/;
const O_START = new Set(["(", "[", "{", "<", '"', "'", "=", "（", "「", "『", "【", "《", "："]);
const O_START_EXT = new Set([...O_START, "`"]);
const O_TRAILING = /[.:!?]$/;
const O_LINECOL = /:(\d+)(?::(\d+))?$/;
const O_EXT_RE = /\.[A-Za-z0-9_-]{1,10}$/;
const oTerm = (ch: string | undefined) => ch === undefined || O_WS.test(ch) || O_TERMINATORS.has(ch);
const oWb = (ch: string | undefined, ss: Set<string>) => oTerm(ch) || (ch !== undefined && ss.has(ch));
const oStartCtx = (t: string, i: number, ss: Set<string>) =>
  i === 0 || (t[i - 1] !== undefined && (O_WS.test(t[i - 1]!) || ss.has(t[i - 1]!)));
const oRelStartCtx = (t: string, i: number, ss: Set<string>) =>
  i > 0 && t[i - 1] !== undefined && (O_WS.test(t[i - 1]!) || ss.has(t[i - 1]!));
const oLooksLikeRelative = (cand: string) => {
  const slash = cand.indexOf("/");
  if (slash <= 0) return false;
  if (cand.slice(0, slash).includes(":")) return false;
  const lastSeg = cand.slice(cand.lastIndexOf("/") + 1);
  const m = O_EXT_RE.exec(lastSeg);
  return m !== null && lastSeg.length > m[0].length;
};
const oClickable = (path: string, scope: { abs?: true; dirs?: true; cwd: string | null; uploads: boolean }) => {
  if (!validatePreviewPath(path)) return false;
  if (scope.abs === true) return true;
  if (scope.uploads === true && path.includes(PREVIEW_UPLOADS_MARKER)) return true;
  const cwd = scope.cwd;
  if (typeof cwd !== "string" || cwd === "" || cwd === "/") return false;
  const base = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  return base !== "" && base !== "/" && path.startsWith(`${base}/`);
};
/** the relative route's absolute-part prune (the impl's `lastBad < s0`), slow-scanned. */
const oHasBadSeg = (t: string, s0: number, P: number) => {
  let q = s0;
  while (q < P) {
    if (t[q] !== "/") {
      q++;
      continue;
    }
    let e = q + 1;
    while (e < P && t[e] !== "/") e++;
    const seg = t.slice(q + 1, e);
    if (seg === "" || seg === "." || seg === "..") return true;
    q = e;
  }
  return false;
};

function oracleFindPathRefs(text: string, scope: typeof SCOPE & { abs?: true; dirs?: true }): Seg[] {
  const abs = scope.abs === true;
  const dirs = scope.dirs === true;
  const ss = abs || dirs ? O_START_EXT : O_START;
  const cwd = scope.cwd;
  const cwdPrefix =
    typeof cwd === "string" && cwd !== "" && cwd !== "/" ? `${cwd.endsWith("/") ? cwd.slice(0, -1) : cwd}/` : null;
  const cwdBase = cwdPrefix !== null ? cwdPrefix.slice(0, -1) : null;
  const segments: Seg[] = [];
  let refs = 0;
  let textStart = 0;
  let i = 0;
  const n = text.length;
  // per-run structure (terminator-free spans) — every candidate-level FACT is recomputed below
  let spanEnd = -1;
  let spanStrippedEnd = -1;
  let spanLineColStart = -1;
  let spanLine: number | undefined;
  let spanCol: number | undefined;
  let spanFirstSlash = -1;
  let spanWordStart = -1;
  while (i < n && refs < PREVIEW_MAX_REFS_PER_NODE) {
    const slash = text.indexOf("/", i);
    if (slash === -1) break;
    if (slash >= spanEnd) {
      let end = slash + 1;
      while (end < n && !oTerm(text[end])) end++;
      spanEnd = end;
      let stripped = end;
      while (stripped > slash + 1 && O_TRAILING.test(text[stripped - 1]!)) stripped--;
      spanStrippedEnd = Math.max(slash + 1, stripped);
      const m = O_LINECOL.exec(text.slice(slash, spanStrippedEnd));
      if (m !== null && m.index > 0) {
        spanLineColStart = slash + m.index;
        spanLine = Number(m[1]);
        spanCol = m[2] !== undefined ? Number(m[2]) : undefined;
      } else {
        spanLineColStart = -1;
        spanLine = undefined;
        spanCol = undefined;
      }
      spanFirstSlash = slash;
      if (cwdPrefix !== null) {
        let ws = slash;
        while (ws > 0 && !oWb(text[ws - 1], ss)) ws--;
        spanWordStart = ws;
      } else {
        spanWordStart = slash;
      }
    }
    const strippedEnd = Math.max(spanStrippedEnd, slash + 1);
    const hasLineCol = spanLineColStart !== -1 && slash < spanLineColStart;
    // §2.5.2 ② — recomputed INDEPENDENTLY for THIS candidate (no shared run constants)
    const p0 = hasLineCol ? spanLineColStart : strippedEnd;
    const trailing = text[p0 - 1] === "/";
    const P = dirs && !hasLineCol && p0 - 1 > slash && trailing ? p0 - 1 : p0;
    if (oStartCtx(text, slash, ss) && slash < P && P - slash <= 4096) {
      const path = text.slice(slash, P);
      if (oClickable(path, scope)) {
        if (textStart < slash) segments.push({ kind: "text", text: text.slice(textStart, slash) });
        const seg = { kind: "ref", text: text.slice(slash, strippedEnd), path } as Seg;
        if (hasLineCol) {
          seg.line = spanLine;
          if (spanCol !== undefined) seg.col = spanCol;
        }
        segments.push(seg);
        refs++;
        textStart = strippedEnd;
        i = strippedEnd;
        continue;
      }
    }
    if (slash === spanFirstSlash && cwdPrefix !== null) {
      const ws = spanWordStart;
      if (ws < slash && oRelStartCtx(text, ws, ss) && P - ws <= 4096) {
        const seg0 = text.slice(ws, slash);
        // strip-aware prune: a trailing "/" that resolve strips never counts (window artifact)
        const pruneEnd = dirs && text[P - 1] === "/" ? P - 1 : P;
        const seg0ok =
          seg0 !== "" &&
          seg0 !== "." &&
          seg0 !== ".." &&
          !seg0.includes(":") &&
          !seg0.includes("\0") &&
          !oHasBadSeg(text, slash, pruneEnd);
        const shape = oLooksLikeRelative(text.slice(ws, P));
        const opener = text[ws - 1];
        const dirsEx =
          dirs && (trailing || ((opener === '"' || opener === "'" || opener === "`") && text[strippedEnd] === opener));
        if (seg0ok && (shape || dirsEx)) {
          const rel0 = text.slice(ws, P);
          const rel = rel0.endsWith("/") ? rel0.slice(0, -1) : rel0;
          const resolved = `${cwdBase}/${rel}`;
          if (oClickable(resolved, scope)) {
            if (textStart < ws) segments.push({ kind: "text", text: text.slice(textStart, ws) });
            const seg = { kind: "ref", text: text.slice(ws, strippedEnd), path: resolved } as Seg;
            if (hasLineCol) {
              seg.line = spanLine;
              if (spanCol !== undefined) seg.col = spanCol;
            }
            segments.push(seg);
            refs++;
            textStart = strippedEnd;
            i = strippedEnd;
            continue;
          }
        }
      }
    }
    i = slash + 1;
  }
  if (textStart < n) segments.push({ kind: "text", text: text.slice(textStart) });
  if (segments.length === 0) segments.push({ kind: "text", text });
  return segments;
}

describe("logic/preview.js findPathRefs — §2.5.2 differential correctness gates", () => {
  /** dir-plan's fuzz alphabet (length 0–200), fixed seed, 2 000 cases. 2026-10-09: the
   * full-width opener `（`, bracket `「`, ellipsis `…` and a CJK ideograph `中` join so the
   * differential gates actually exercise the new terminator rule (and pin that
   * non-punctuation CJK still never terminates) — same fixed seed, still deterministic. */
  const ALPHABET = ["/", ".", "a", "1", ":", "=", " ", '"', "'", "`", "é", "😀", "\0", "（", "「", "…", "中"];
  const fuzzCases = (seed: number, count: number): string[] => {
    const rand = rng(seed);
    const out: string[] = [];
    for (let c = 0; c < count; c++) {
      const len = Math.floor(rand() * 201);
      let s = "";
      for (let k = 0; k < len; k++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
      out.push(s);
    }
    return out;
  };
  const FUZZ = fuzzCases(20261008, 2000);
  /** every frozen fixture input from the pre-P2 suites (start contexts, terminators, scopes). */
  const FROZEN_INPUTS = [
    "/home/u/proj/a.ts rest",
    "see /home/u/proj/a.ts ok",
    "see\t/home/u/proj/a.ts ok",
    "see\n/home/u/proj/a.ts ok",
    "x(/home/u/proj/a.ts)",
    "x[/home/u/proj/a.ts]",
    "x{/home/u/proj/a.ts}",
    "x</home/u/proj/a.ts>",
    'x"/home/u/proj/a.ts"',
    "x'/home/u/proj/a.ts'",
    "path=/home/u/proj/a.ts,",
    "x（/home/u/proj/a.ts）",
    "x「/home/u/proj/a.ts」",
    "x『/home/u/proj/a.ts』",
    "x【/home/u/proj/a.ts】",
    "x《/home/u/proj/a.ts》",
    "路径：/home/u/proj/a.ts。",
    "x/home/u/proj/a.ts",
    "http://example.com/home/u/proj/a.ts",
    "//home/u/proj/a.ts",
    "1/home/u/proj/a.ts",
    "看。/home/u/proj/a.ts",
    "/home/u/proj/a.ts tail",
    "/home/u/proj/a.ts, tail",
    "/home/u/proj/a.ts; tail",
    "/home/u/proj/a.ts`tail`",
    "(/home/u/proj/a.ts)",
    "/home/u/proj/a.ts|tail",
    "/home/u/proj/a.ts。",
    "/home/u/proj/a.ts，还有",
    "【/home/u/proj/a.ts】",
    "open /home/u/proj/a.ts.:! now",
    "at /home/u/proj/a.ts:12:3 end",
    "at /home/u/proj/a.ts:12 end",
    "/home/u/proj/a.ts:12.",
    "/home/u/proj2/a.ts /home/u/proj/a.ts",
    "/home/u/proj",
    "/etc/passwd",
    "/home/u",
    `附件 ${UPLOAD_PATH} 好了`,
    "/single",
    "//home/u/proj",
    "/home/u/./a",
    "/home/u/../a",
    "src/web-hub/ui/src/components/detail/DetailDock.vue",
    `see src/web-hub/ui/src/components/detail/DetailDock.vue ok`,
    `x(src/web-hub/ui/src/components/detail/DetailDock.vue)`,
    `{"path": "src/foo.ts"}`,
    '"path": "src/components/detail"',
    '"url": "http://example.com/foo.ts"',
    '"url": "mailto:a@b.com/x.ts"',
    `"p": "//src/foo.ts"`,
    `at "src/foo.ts:12:3" end`,
    `{"path": "/home/u/proj/a.ts"}`,
    "/etc=/home/u/proj/a.ts",
    "/x=/home/u/proj/a.ts:7.",
    // 2026-10-09 full-width/CJK punctuation terminator fix (the user-report shape + the new
    // terminator adjacency cases + non-punctuation CJK paths). Added WITH the lockstep
    // re-freeze of fixtures/preview-findpathrefs-ref.js and the O_TERMINATORS oracle above,
    // so both differential gates pin the NEW rule instead of the old bug.
    "预览图：/tmp/cmdprev/cmd-badge-options.png（点开）",
    "/home/u/proj/a.ts（点开）",
    "/home/u/proj/a.ts【注】",
    "/home/u/proj/a.ts「注」",
    "/home/u/proj/a.ts『注』",
    "/home/u/proj/a.ts《书》",
    "/home/u/proj/a.ts〈注〉",
    "/home/u/proj/a.ts…",
    "看这（/home/u/proj/a.ts）好",
    "「/home/u/proj/a.ts」",
    "/home/u/proj/中文目录/图.png（好）",
    '"src/中文/foo.ts"，好',
  ];

  const LEGACY_SCOPES: Array<[string, typeof SCOPE]> = [
    ["cwd+uploads", SCOPE],
    ["cwd=null", { ...SCOPE, cwd: null }],
    ["uploads=false", { ...SCOPE, uploads: false }],
    ["cwd=/", { ...SCOPE, cwd: "/" }],
  ];

  it("legacy scopes: deep-equal to the FROZEN pre-P2 reference on every frozen input + 2 000 fuzz cases", () => {
    for (const [label, scope] of LEGACY_SCOPES) {
      for (const text of [...FROZEN_INPUTS, ...FUZZ]) {
        const live = findPathRefs(text, scope) as Seg[];
        const ref = findPathRefsRef(text, scope) as Seg[];
        expect(live, `scope=${label} text=${JSON.stringify(text)}`).toEqual(ref);
      }
    }
  });

  it.each([
    ["abs", ABS_SCOPE],
    ["dirs", DIRS_SCOPE],
    ["abs+dirs", BOTH_SCOPE],
  ] as Array<[string, typeof SCOPE & { abs?: true; dirs?: true }]>)(
    "%s scope: deep-equal to the naive per-candidate oracle on every frozen input + 2 000 fuzz cases",
    (_label, scope) => {
      for (const text of [...FROZEN_INPUTS, ...FUZZ]) {
        const live = findPathRefs(text, scope) as Seg[];
        const want = oracleFindPathRefs(text, scope);
        expect(live, `text=${JSON.stringify(text)}`).toEqual(want);
      }
    },
  );

  it("I1: segments concatenate back to the exact input in all four scopes (2 000 fuzz cases)", () => {
    for (const scope of [SCOPE, ABS_SCOPE, DIRS_SCOPE, BOTH_SCOPE]) {
      for (const text of FUZZ) {
        expect(concat(findPathRefs(text, scope) as Seg[])).toBe(text);
      }
    }
  });

  it("I2: every emitted ref satisfies validatePreviewPath and its scope's routing rule", () => {
    for (const scope of [SCOPE, ABS_SCOPE, DIRS_SCOPE, BOTH_SCOPE]) {
      for (const text of FUZZ) {
        for (const r of refs(findPathRefs(text, scope) as Seg[])) {
          expect(validatePreviewPath(r.path!), `path=${r.path}`).toBe(true);
          if (scope.abs === true) continue; // abs: any valid path
          expect(r.path!.startsWith("/home/u/proj/") || r.path!.includes(PREVIEW_UPLOADS_MARKER)).toBe(true);
        }
      }
    }
  });
});

describe("logic/preview.js findPathRefs — §2.5.2 operation-count performance gate (machine-independent)", () => {
  const PERF_SCOPES: Array<[string, typeof SCOPE & { abs?: true; dirs?: true }]> = [
    ["legacy", SCOPE],
    ["abs", ABS_SCOPE],
    ["dirs", DIRS_SCOPE],
    ["abs+dirs", BOTH_SCOPE],
  ];
  const PERF_INPUTS: Array<[string, string]> = [
    ['"=/./".repeat(16384) — 64 KiB', "=/./".repeat(16_384)],
    ['"/".repeat(1<<20)', "/".repeat(1 << 20)],
    ['"=/".repeat(1<<19)', "=/".repeat(1 << 19)],
    ['"/a".repeat(1<<19)', "/a".repeat(1 << 19)],
    ['"é/".repeat(1<<19)', "é/".repeat(1 << 19)],
    ['"😀=/".repeat(1<<18) — 1 Mi code units', "😀=/".repeat(1 << 18)],
  ];

  it.each(PERF_INPUTS.map(([label, text]) => [label, text] as const))(
    "%s: charScans ≤ 10·n + 10 000 in all four scopes",
    (_label, text) => {
      for (const [scopeLabel, scope] of PERF_SCOPES) {
        __resetPreviewScanStats();
        findPathRefs(text, scope);
        const bound = 10 * text.length + 10_000;
        expect(
          __previewScanStats.charScans,
          `scope=${scopeLabel} scans=${__previewScanStats.charScans} n=${text.length} bound=${bound}`,
        ).toBeLessThanOrEqual(bound);
      }
    },
  );

  it('growth ratio: charScans("=/./" 1 MiB) / charScans("=/./" 64 KiB) ∈ [8, 24] (linear ≈ 16)', () => {
    const scan = (text: string): number => {
      __resetPreviewScanStats();
      findPathRefs(text, SCOPE);
      return __previewScanStats.charScans;
    };
    const small = scan("=/./".repeat(16_384));
    const big = scan("=/./".repeat(262_144));
    expect(small).toBeGreaterThan(0);
    const ratio = big / small;
    expect(ratio).toBeGreaterThanOrEqual(8);
    expect(ratio).toBeLessThanOrEqual(24);
  });

  it("5 s wall-clock hang sentinel: the whole input × scope matrix completes (guards exponential regressions only)", () => {
    const t0 = Date.now();
    for (const [, text] of PERF_INPUTS) {
      for (const [, scope] of PERF_SCOPES) findPathRefs(text, scope);
    }
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});
