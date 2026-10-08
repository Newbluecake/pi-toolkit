// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildSplitRows,
  buildUnifiedRows,
  clipLine,
  displayPath,
  formatStat,
  rowDiffable,
  rowSig,
  statusBadge,
  WTDIFF_LINE_DISPLAY_MAX,
  WTDIFF_RENDER_PAGE_ROWS,
  wtdiffScopeOf,
} from "../../../src/web-hub/ui/src/logic/wtdiff.js";
import { parseUnifiedPatch, WTDIFF_STATUSES } from "../../../src/web-hub/protocol/worktree-diff.js";
import { PREVIEW_LAN_HUB_CAP, WTDIFF_HUB_CAP } from "../../../src/web-hub/protocol/version.js";

/**
 * worktree-diff plan v3.1 §5 D2（UI 纯逻辑验收）：`logic/wtdiff.js` 的全部导出 —
 * `wtdiffScopeOf` 真值表（§4.1，password 额外要求 `preview.lan.v1`）、`rowDiffable` 行资格、
 * `rowSig` 签名、`buildSplitRows`（§3.4：mockup FILES 数据转成真实 unified patch 后过 D0
 * `parseUnifiedPatch`，逐行快照 + 配对/空位/行号性质）、`buildUnifiedRows` 行数守恒（§3.5）、
 * `clipLine` 边界（§3.7，代理对不切半）、`displayPath` 对 CR/LF/TAB 的可见化（§4.2）、
 * `statusBadge` / `formatStat` / 两个渲染常量。
 *
 * fixture 来源：用户批准的 mockup `/home/bluecake/shots/diff-mockup.html` 的 FILES 数据
 * （真实 diff 节选），见 `MOCK_FILES` 头注释。
 */

// ---------------------------------------------------------------------------
// fixture: mockup FILES → real unified patch
// ---------------------------------------------------------------------------

/**
 * Mockup FILES lines, normalized to CONTENT level: `["ctx"|"del"|"add", oldLn, newLn,
 * content]` where content is the git diff line MINUS its leading " "/"-"/"+" (the mockup
 * kept that prefix inconsistently across lines). `["hunk"]` markers only delimit runs —
 * the mockup's hunk headers carry no usable counts (two are pure decoration), so `toPatch`
 * re-derives REAL `@@ -a,b +c,d @@` headers from the line data. What survives verbatim from
 * the mockup: the texts, the line-number labels (used for hunk starts) and the run ORDER.
 */
type MockLine = ["ctx" | "del" | "add", number | null, number | null, string];
type MockEntry = ["hunk"] | MockLine;
interface MockFile {
  title: string;
  newFile?: boolean;
  lines: MockEntry[];
}

/** ThinkingBlock.vue hunk 2's added block — 29 add lines, new-side n = 53..81. */
const THINKING_ADDS: readonly string[] = [
  "",
  "/* --- streaming follow (2026-10-08 user request) ---",
  " * While the block is live, keep the scroll-capped `.thinking-text` panel pinned to the",
  " * latest line. Any USER scroll inside the panel flips `sticky` by position: scrolled up",
  " * ⇒ stop following (the model can't fight the reader); scrolled back to the bottom ⇒",
  " * resume — the same near-bottom semantics as the transcript's own follow scroll. */",
  "const FOLLOW_THRESHOLD_PX = 24;",
  "const body = ref<HTMLElement | null>(null);",
  "const sticky = ref(true);",
  "let suppressScroll = false;",
  "",
  "function onBodyScroll(): void {",
  "  const el = body.value;",
  "  if (!el) return;",
  "  if (suppressScroll) { suppressScroll = false; return; }",
  "  sticky.value = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD_PX;",
  "}",
  "",
  "watch(",
  "  () => [props.text, isOpen.value] as const,",
  "  () => {",
  "    if (props.live !== true || !sticky.value || !isOpen.value) return;",
  "    const el = body.value;",
  "    if (!el) return;",
  "    suppressScroll = true;",
  "    el.scrollTop = el.scrollHeight;",
  "  },",
  '  { immediate: true, flush: "post" },',
  ");",
];

/** thinking-block.test.ts — 12 add lines, new-side n = 1..12 (new file ⇒ old side empty). */
const TESTFILE_ADDS: readonly string[] = [
  "  /* --- streaming follow: live blocks pin the capped panel to the newest line;",
  "   * a USER scroll away stops the follow, scrolling back resumes it. */",
  "  function stubBox(el: Element, box: {...}): void {",
  '    Object.defineProperty(el, "scrollHeight", { get: () => box.scrollHeight });',
  "    ...",
  "  }",
  "",
  '  it("follows the newest line while live and near the bottom", async () => {',
  "    const wrapper = mount(ThinkingBlock, { props: { text: SHORT_TEXT, live: true } });",
  "    ...",
  "    expect(box.scrollTop).toBe(1000); // pinned to the bottom",
  "  });",
];

const MOCK_FILES: readonly MockFile[] = [
  {
    title: "src/web-hub/ui/src/components/transcript/ThinkingBlock.vue",
    lines: [
      ["hunk"],
      ["ctx", 14, 14, " user already made."],
      ["ctx", 15, 15, "-->"],
      ["ctx", 16, 16, '<script setup lang="ts">'],
      ["del", 17, null, 'import { computed, ref } from "vue";'],
      ["add", null, 17, 'import { computed, ref, watch } from "vue";'],
      ["ctx", 18, 18, 'import { useI18n } from "../../composables/useI18n.js";'],
      ["ctx", 19, 19, ""],
      ["hunk"],
      ["ctx", 50, 50, "  e.preventDefault();"],
      ["ctx", 51, 51, "  manualOverride.value = !isOpen.value;"],
      ["ctx", 52, 52, "}"],
      ...THINKING_ADDS.map((text, i) => ["add", null, 53 + i, text] as MockLine),
      ["ctx", 53, 82, "</script>"],
      ["hunk"],
      ["ctx", 92, 93, '    <summary @click="onSummaryClick">'],
      ["ctx", 93, 94, '      <span>{{ t("transcript.thinking", { n: lineCount }) }}</span>'],
      ["ctx", 94, 95, "    </summary>"],
      ["del", 95, null, '    <div class="thinking-text">{{ shown }}</div>'],
      ["add", null, 96, '    <div ref="body" class="thinking-text" @scroll.passive="onBodyScroll">{{ shown }}</div>'],
      ["ctx", 96, 97, "  </details>"],
      ["ctx", 97, 98, "</template>"],
    ],
  },
  {
    title: "src/web-hub/ui/src/styles/fleet.css",
    lines: [
      ["hunk"],
      ["ctx", 358, 358, "@media (min-width: 1025px) {"],
      ["ctx", 359, 359, " .run {"],
      ["add", null, 360, "    /* identity wins over prose: name floor 220px, fr flips to 1.5:1 */"],
      ["del", 360, null, "    grid-template-columns: 18px 20px minmax(120px, 1.2fr) minmax(0, 2fr) auto auto;"],
      ["add", null, 361, "    grid-template-columns: 18px 20px minmax(220px, 1.5fr) minmax(0, 1fr) auto auto;"],
      ["ctx", 362, 362, '   grid-template-areas: "chev icon name activity nums toggle";'],
      ["hunk"],
      ["del", 388, null, "@container (max-width: 559px) {"],
      ["add", null, 391, "@container (max-width: 599px) {"],
      ["ctx", 389, 392, " .run {"],
      ["ctx", 390, 393, "  grid-template-columns: 18px 20px minmax(0, 1fr) auto auto;"],
    ],
  },
  {
    title: "tests/web-hub/ui/thinking-block.test.ts",
    newFile: true,
    lines: [["hunk"], ...TESTFILE_ADDS.map((text, i) => ["add", null, 1 + i, text] as MockLine)],
  },
];

/** Encode the mock data as a real unified patch: prefixes re-attached, hunk headers derived. */
function toPatch(files: readonly MockFile[]): string {
  const out: string[] = [];
  for (const f of files) {
    out.push(`diff --git a/${f.title} b/${f.title}`);
    if (f.newFile) out.push("new file mode 100644");
    let i = 0;
    while (i < f.lines.length) {
      while (i < f.lines.length && f.lines[i]![0] === "hunk") i++;
      if (i >= f.lines.length) break;
      let oldStart: number | null = null;
      let newStart: number | null = null;
      let oldN = 0;
      let newN = 0;
      const body: string[] = [];
      while (i < f.lines.length && f.lines[i]![0] !== "hunk") {
        const [k, o, n, text] = f.lines[i]! as MockLine;
        if (k === "ctx") {
          if (oldStart === null && o !== null) oldStart = o;
          if (newStart === null && n !== null) newStart = n;
          oldN++;
          newN++;
          body.push(` ${text}`);
        } else if (k === "del") {
          if (oldStart === null && o !== null) oldStart = o;
          oldN++;
          body.push(`-${text}`);
        } else {
          if (newStart === null && n !== null) newStart = n;
          newN++;
          body.push(`+${text}`);
        }
        i++;
      }
      out.push(`@@ -${oldStart ?? 0},${oldN} +${newStart ?? 0},${newN} @@`);
      out.push(...body);
    }
  }
  return `${out.join("\n")}\n`;
}

/** The parsed form of the full 3-file mockup patch, shared by the split/unified suites. */
const MOCK_PARSED = parseUnifiedPatch(toPatch(MOCK_FILES));

// ---------------------------------------------------------------------------
// shared local shapes (the .js module is untyped from TS's perspective — these document
// the contract under assertion)
// ---------------------------------------------------------------------------

interface PLine {
  k: "ctx" | "del" | "add";
  o: number | null;
  n: number | null;
  text: string;
  noEol?: true;
}
type SplitRow =
  | { t: "file"; meta: Record<string, unknown> }
  | { t: "hunk"; text: string }
  | { t: "ctx"; o: number; n: number; text: string; noEol?: true }
  | { t: "pair"; l: PLine | null; r: PLine | null };

/** Build a PatchLine literal; the `noEol` key is only present when true. */
function line(k: "ctx" | "del" | "add", o: number | null, n: number | null, text: string, noEol = false): PLine {
  return noEol ? { k, o, n, text, noEol: true } : { k, o, n, text };
}

const SCOPE = { agentKey: "A", sessionId: "s1" };

// ---------------------------------------------------------------------------
// wtdiffScopeOf — §4.1 truth table
// ---------------------------------------------------------------------------

describe("wtdiffScopeOf", () => {
  const BASE = {
    mode: "token",
    hubCaps: [WTDIFF_HUB_CAP],
    hasTransport: true,
    agentKey: "A",
    session: { sessionId: "s1" },
  };

  it("happy path: transport + wtdiff.v1 + agentKey + live session", () => {
    expect(wtdiffScopeOf(BASE)).toEqual({ agentKey: "A", sessionId: "s1" });
  });

  it("no worktreeDiff transport ⇒ null", () => {
    expect(wtdiffScopeOf({ ...BASE, hasTransport: false })).toBeNull();
    expect(wtdiffScopeOf({ ...BASE, hasTransport: undefined })).toBeNull();
  });

  it("missing wtdiff.v1 cap ⇒ null (feature off / hub without /proc/self/fd)", () => {
    expect(wtdiffScopeOf({ ...BASE, hubCaps: [PREVIEW_LAN_HUB_CAP, "preview.v1"] })).toBeNull();
    expect(wtdiffScopeOf({ ...BASE, hubCaps: [] })).toBeNull();
  });

  it("password (LAN) mode additionally requires preview.lan.v1 (D6)", () => {
    expect(wtdiffScopeOf({ ...BASE, mode: "password" })).toBeNull();
    expect(wtdiffScopeOf({ ...BASE, mode: "password", hubCaps: [WTDIFF_HUB_CAP, PREVIEW_LAN_HUB_CAP] })).toEqual({
      agentKey: "A",
      sessionId: "s1",
    });
  });

  it("loopback-mode hub never declares preview.lan.v1 — a loopback browser still scopes", () => {
    expect(wtdiffScopeOf({ ...BASE, mode: "loopback", hubCaps: [WTDIFF_HUB_CAP] })).toEqual({
      agentKey: "A",
      sessionId: "s1",
    });
  });

  it("undefined mode (unknown auth modes) is treated as non-password", () => {
    expect(wtdiffScopeOf({ ...BASE, mode: undefined })).toEqual({ agentKey: "A", sessionId: "s1" });
  });

  it("non-array hubCaps is treated as no caps ⇒ null", () => {
    expect(wtdiffScopeOf({ ...BASE, hubCaps: "wtdiff.v1" })).toBeNull();
    expect(wtdiffScopeOf({ ...BASE, hubCaps: undefined })).toBeNull();
  });

  it("agentKey must be a non-empty string", () => {
    expect(wtdiffScopeOf({ ...BASE, agentKey: "" })).toBeNull();
    expect(wtdiffScopeOf({ ...BASE, agentKey: 5 })).toBeNull();
    expect(wtdiffScopeOf({ ...BASE, agentKey: undefined })).toBeNull();
  });

  it("session must be an object with a non-empty string sessionId", () => {
    expect(wtdiffScopeOf({ ...BASE, session: null })).toBeNull();
    expect(wtdiffScopeOf({ ...BASE, session: undefined })).toBeNull();
    expect(wtdiffScopeOf({ ...BASE, session: "s1" })).toBeNull();
    expect(wtdiffScopeOf({ ...BASE, session: {} })).toBeNull();
    expect(wtdiffScopeOf({ ...BASE, session: { sessionId: "" } })).toBeNull();
    expect(wtdiffScopeOf({ ...BASE, session: { sessionId: 7 } })).toBeNull();
  });

  it("the scope carries exactly { agentKey, sessionId } — no cwd (the wt path comes from the row)", () => {
    const scope = wtdiffScopeOf(BASE);
    expect(Object.keys(scope ?? {}).sort()).toEqual(["agentKey", "sessionId"]);
  });
});

// ---------------------------------------------------------------------------
// rowDiffable — §4.1 row eligibility
// ---------------------------------------------------------------------------

describe("rowDiffable", () => {
  const DIRTY = { label: "~/x", path: "/w/x", head: "aaa", dirty: 3 };

  it("scope ∧ path ∧ non-bare/prunable ∧ dirty > 0", () => {
    expect(rowDiffable(SCOPE, DIRTY)).toBe(true);
  });

  it("scope null ⇒ false regardless of the row", () => {
    expect(rowDiffable(null, DIRTY)).toBe(false);
    expect(rowDiffable(undefined, DIRTY)).toBe(false);
  });

  it("null/non-object rows ⇒ false", () => {
    expect(rowDiffable(SCOPE, null)).toBe(false);
    expect(rowDiffable(SCOPE, undefined)).toBe(false);
  });

  it("path must be a non-empty string (dropped under projection pressure ⇒ inert row)", () => {
    expect(rowDiffable(SCOPE, { ...DIRTY, path: undefined })).toBe(false);
    expect(rowDiffable(SCOPE, { ...DIRTY, path: 42 })).toBe(false);
    expect(rowDiffable(SCOPE, { ...DIRTY, path: "" })).toBe(false);
  });

  it("bare / prunable rows never expand (git cannot diff them)", () => {
    expect(rowDiffable(SCOPE, { ...DIRTY, bare: true })).toBe(false);
    expect(rowDiffable(SCOPE, { ...DIRTY, prunable: true })).toBe(false);
  });

  it("clean rows (dirty 0/absent, no flags) ⇒ false — keeps today's inert span (I8)", () => {
    expect(rowDiffable(SCOPE, { ...DIRTY, dirty: 0 })).toBe(false);
    expect(rowDiffable(SCOPE, { ...DIRTY, dirty: undefined })).toBe(false);
    expect(rowDiffable(SCOPE, { label: "~/x", path: "/w/x" })).toBe(false);
  });

  it("dirtyCapped alone qualifies (the count is a LOWER bound)", () => {
    expect(rowDiffable(SCOPE, { ...DIRTY, dirty: 0, dirtyCapped: true })).toBe(true);
    expect(rowDiffable(SCOPE, { label: "~/x", path: "/w/x", dirtyCapped: true })).toBe(true);
  });

  it("each unprobed reason qualifies (dirty state unknown)", () => {
    for (const unprobed of ["cap", "timeout", "error"] as const) {
      expect(rowDiffable(SCOPE, { label: "~/x", path: "/w/x", unprobed })).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// rowSig — §4.5 refresh signature
// ---------------------------------------------------------------------------

describe("rowSig", () => {
  it("format: head|dirty|dirtyCapped|untrackedSkipped", () => {
    expect(rowSig({ label: "x", path: "/x", head: "da52e17", dirty: 3 })).toBe("da52e17|3|0|0");
    expect(rowSig({ label: "x", path: "/x", head: "da52e17", dirty: 3, dirtyCapped: true })).toBe("da52e17|3|1|0");
    expect(rowSig({ label: "x", path: "/x", head: "da52e17", dirty: 3, untrackedSkipped: true })).toBe("da52e17|3|0|1");
    expect(
      rowSig({ label: "x", path: "/x", head: "da52e17", dirty: 0, dirtyCapped: true, untrackedSkipped: true }),
    ).toBe("da52e17|0|1|1");
  });

  it("absent fields render empty so undefined-dirty never collides with dirty 0", () => {
    expect(rowSig({ label: "x", path: "/x" })).toBe("||0|0");
    expect(rowSig(null)).toBe("");
    expect(rowSig(undefined)).toBe("");
  });

  it("any watched-field change flips the signature (the only thing consumers test)", () => {
    const a = rowSig({ label: "x", path: "/x", head: "aaaaaaa", dirty: 1 });
    expect(rowSig({ label: "x", path: "/x", head: "bbbbbbb", dirty: 1 })).not.toBe(a);
    expect(rowSig({ label: "x", path: "/x", head: "aaaaaaa", dirty: 2 })).not.toBe(a);
    expect(rowSig({ label: "x", path: "/x", head: "aaaaaaa", dirty: 1, dirtyCapped: true })).not.toBe(a);
    expect(rowSig({ label: "x", path: "/x", head: "aaaaaaa", dirty: 1, untrackedSkipped: true })).not.toBe(a);
    expect(rowSig({ label: "x", path: "/x", head: "aaaaaaa", dirty: 1 })).toBe(a);
  });
});

// ---------------------------------------------------------------------------
// statusBadge / formatStat / constants
// ---------------------------------------------------------------------------

describe("statusBadge", () => {
  it("maps every protocol status to { cls: lowercase, label: status }", () => {
    for (const s of WTDIFF_STATUSES) {
      expect(statusBadge(s)).toEqual({ cls: s === "?" ? "q" : s.toLowerCase(), label: s });
    }
  });

  it("unknown input (defensive — the D0 parser enforces the enum) degrades to the generic badge", () => {
    expect(statusBadge("Z")).toEqual({ cls: "q", label: "?" });
    expect(statusBadge(undefined)).toEqual({ cls: "q", label: "?" });
  });
});

describe("formatStat", () => {
  it("renders the mockup's +a −d with the typographic minus (U+2212)", () => {
    expect(formatStat(38, 1)).toEqual({ plus: "+38", minus: "\u22121" });
    expect(formatStat(4, 2)).toEqual({ plus: "+4", minus: "\u22122" });
  });

  it("a present 0 stays visible (+0 −0, e.g. mode-only changes)", () => {
    expect(formatStat(0, 0)).toEqual({ plus: "+0", minus: "\u22120" });
    expect(formatStat(68, 0)).toEqual({ plus: "+68", minus: "\u22120" });
  });

  it("absent counts render as empty strings (binary / untracked / numstat-missing)", () => {
    expect(formatStat(undefined, 2)).toEqual({ plus: "", minus: "\u22122" });
    expect(formatStat(undefined, undefined)).toEqual({ plus: "", minus: "" });
  });
});

describe("render constants (§3.7)", () => {
  it("page size and per-line cap are both 2 000", () => {
    expect(WTDIFF_RENDER_PAGE_ROWS).toBe(2_000);
    expect(WTDIFF_LINE_DISPLAY_MAX).toBe(2_000);
  });
});

// ---------------------------------------------------------------------------
// displayPath — §4.2 control-character visualization
// ---------------------------------------------------------------------------

describe("displayPath", () => {
  it("CR / LF / TAB become their control-picture glyphs ␍ ␊ ␉", () => {
    expect(displayPath("a\rb.ts")).toBe("a\u240Db.ts");
    expect(displayPath("a\nb.ts")).toBe("a\u240Ab.ts");
    expect(displayPath("a\tb.ts")).toBe("a\u2409b.ts");
    expect(displayPath("we\rird\nname\t.txt")).toBe("we\u240Dird\u240Aname\u2409.txt");
  });

  it("every other C0 control and DEL are visualized too (1:1 per character)", () => {
    expect(displayPath("\u0001\u0002")).toBe("\u2401\u2402");
    expect(displayPath("\u0000")).toBe("\u2400");
    expect(displayPath("\u007f")).toBe("\u2421");
    expect(displayPath("a\u000bb").length).toBe(3);
  });

  it("everything else — U+FFFD included — passes through unchanged", () => {
    expect(displayPath("src/web-hub/ui/x.vue")).toBe("src/web-hub/ui/x.vue");
    expect(displayPath("a\uFFFDb")).toBe("a\uFFFDb");
    expect(displayPath("\u4e2d\u6587/\u30c6\u30b9\u30c8.ts")).toBe("\u4e2d\u6587/\u30c6\u30b9\u30c8.ts");
  });

  it("non-string input degrades to the empty string", () => {
    expect(displayPath(undefined)).toBe("");
    expect(displayPath(42)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// clipLine — §3.7 per-line display cap (surrogate pairs never split)
// ---------------------------------------------------------------------------

describe("clipLine", () => {
  it("at or under the limit: the ORIGINAL string, clipped 0", () => {
    expect(clipLine("abc", 5)).toEqual({ text: "abc", clipped: 0 });
    expect(clipLine("abc", 3)).toEqual({ text: "abc", clipped: 0 });
    expect(clipLine("", 3)).toEqual({ text: "", clipped: 0 });
  });

  it("over the limit: prefix + …(+N) with the omitted code-point count", () => {
    expect(clipLine("abcd", 3)).toEqual({ text: "abc…(+1)", clipped: 1 });
    expect(clipLine("abcdefghij", 4)).toEqual({ text: "abcd…(+6)", clipped: 6 });
  });

  it("a surrogate pair straddling the cut is kept or dropped WHOLE and counts as one", () => {
    expect(clipLine("a😀b", 2)).toEqual({ text: "a😀…(+1)", clipped: 1 });
    expect(clipLine("a😀b", 1)).toEqual({ text: "a…(+2)", clipped: 2 });
    expect(clipLine("😀😀😀", 1)).toEqual({ text: "😀…(+2)", clipped: 2 });
    expect(clipLine("x😀y😀", 3)).toEqual({ text: "x😀y…(+1)", clipped: 1 });
  });

  it("default cap is WTDIFF_LINE_DISPLAY_MAX code points", () => {
    expect(clipLine("a".repeat(2_000))).toEqual({ text: "a".repeat(2_000), clipped: 0 });
    expect(clipLine("a".repeat(2_001))).toEqual({ text: `${"a".repeat(2_000)}…(+1)`, clipped: 1 });
    // the pair starting exactly at the cap boundary stays whole: 2000 kept cps, "b" omitted
    const s = `${"a".repeat(1_999)}😀b`;
    expect(clipLine(s)).toEqual({ text: `${"a".repeat(1_999)}😀…(+1)`, clipped: 1 });
  });

  it("max 0 clips everything; non-finite/negative max falls back to the default", () => {
    expect(clipLine("ab", 0)).toEqual({ text: "…(+2)", clipped: 2 });
    expect(clipLine("abc", -1)).toEqual({ text: "abc", clipped: 0 });
    expect(clipLine("abcd", Number.POSITIVE_INFINITY)).toEqual({ text: "abcd", clipped: 0 });
  });

  it("non-string input degrades to the empty string", () => {
    expect(clipLine(undefined, 5)).toEqual({ text: "", clipped: 0 });
    expect(clipLine(42)).toEqual({ text: "", clipped: 0 });
  });
});

// ---------------------------------------------------------------------------
// buildSplitRows — §3.4 (mockup fixture, line-by-line snapshot)
// ---------------------------------------------------------------------------

describe("buildSplitRows", () => {
  it("fixture integrity: the derived patch parses clean and complete", () => {
    expect(MOCK_PARSED.files.length).toBe(3);
    expect(MOCK_PARSED.complete).toBe(true);
    expect(MOCK_PARSED.malformed).toBe(false);
    expect(MOCK_PARSED.lineCap).toBe(false);
    expect(MOCK_PARSED.hunkCap).toBe(false);
    expect(MOCK_PARSED.files[2]!.meta).toEqual({ newFile: true, newMode: "100644" });
  });

  it("line-by-line snapshot of the full 3-file mockup fixture (74 rows)", () => {
    const rows = buildSplitRows(MOCK_PARSED) as SplitRow[];
    const expected: SplitRow[] = [
      { t: "file", meta: {} },
      { t: "hunk", text: "@@ -14,6 +14,6 @@" },
      { t: "ctx", o: 14, n: 14, text: " user already made." },
      { t: "ctx", o: 15, n: 15, text: "-->" },
      { t: "ctx", o: 16, n: 16, text: '<script setup lang="ts">' },
      {
        t: "pair",
        l: line("del", 17, null, 'import { computed, ref } from "vue";'),
        r: line("add", null, 17, 'import { computed, ref, watch } from "vue";'),
      },
      { t: "ctx", o: 18, n: 18, text: 'import { useI18n } from "../../composables/useI18n.js";' },
      { t: "ctx", o: 19, n: 19, text: "" },
      { t: "hunk", text: "@@ -50,4 +50,33 @@" },
      { t: "ctx", o: 50, n: 50, text: "  e.preventDefault();" },
      { t: "ctx", o: 51, n: 51, text: "  manualOverride.value = !isOpen.value;" },
      { t: "ctx", o: 52, n: 52, text: "}" },
      ...THINKING_ADDS.map((text, i) => ({ t: "pair", l: null, r: line("add", null, 53 + i, text) }) as SplitRow),
      { t: "ctx", o: 53, n: 82, text: "</script>" },
      { t: "hunk", text: "@@ -92,6 +93,6 @@" },
      { t: "ctx", o: 92, n: 93, text: '    <summary @click="onSummaryClick">' },
      { t: "ctx", o: 93, n: 94, text: '      <span>{{ t("transcript.thinking", { n: lineCount }) }}</span>' },
      { t: "ctx", o: 94, n: 95, text: "    </summary>" },
      {
        t: "pair",
        l: line("del", 95, null, '    <div class="thinking-text">{{ shown }}</div>'),
        r: line(
          "add",
          null,
          96,
          '    <div ref="body" class="thinking-text" @scroll.passive="onBodyScroll">{{ shown }}</div>',
        ),
      },
      { t: "ctx", o: 96, n: 97, text: "  </details>" },
      { t: "ctx", o: 97, n: 98, text: "</template>" },
      { t: "file", meta: {} },
      { t: "hunk", text: "@@ -358,4 +358,5 @@" },
      { t: "ctx", o: 358, n: 358, text: "@media (min-width: 1025px) {" },
      { t: "ctx", o: 359, n: 359, text: " .run {" },
      {
        t: "pair",
        // zip by index within the run: the del pairs with the FIRST add (the comment),
        // the second add (grid-template-columns) rides alone — the mockup's exact pairing.
        l: line(
          "del",
          360,
          null,
          "    grid-template-columns: 18px 20px minmax(120px, 1.2fr) minmax(0, 2fr) auto auto;",
        ),
        r: line("add", null, 360, "    /* identity wins over prose: name floor 220px, fr flips to 1.5:1 */"),
      },
      {
        t: "pair",
        l: null,
        r: line(
          "add",
          null,
          361,
          "    grid-template-columns: 18px 20px minmax(220px, 1.5fr) minmax(0, 1fr) auto auto;",
        ),
      },
      { t: "ctx", o: 361, n: 362, text: '   grid-template-areas: "chev icon name activity nums toggle";' },
      { t: "hunk", text: "@@ -388,3 +391,3 @@" },
      {
        t: "pair",
        l: line("del", 388, null, "@container (max-width: 559px) {"),
        r: line("add", null, 391, "@container (max-width: 599px) {"),
      },
      { t: "ctx", o: 389, n: 392, text: " .run {" },
      { t: "ctx", o: 390, n: 393, text: "  grid-template-columns: 18px 20px minmax(0, 1fr) auto auto;" },
      { t: "file", meta: { newFile: true, newMode: "100644" } },
      { t: "hunk", text: "@@ -0,0 +1,12 @@" },
      ...TESTFILE_ADDS.map((text, i) => ({ t: "pair", l: null, r: line("add", null, 1 + i, text) }) as SplitRow),
    ];
    expect(rows.length).toBe(74);
    expect(rows).toEqual(expected);
  });

  it("property: a pair never has both sides null", () => {
    const rows = buildSplitRows(MOCK_PARSED) as SplitRow[];
    const pairs = rows.filter((r) => r.t === "pair") as Extract<SplitRow, { t: "pair" }>[];
    expect(pairs.length).toBeGreaterThan(0);
    for (const p of pairs) expect(p.l !== null || p.r !== null).toBe(true);
  });

  it("property: both columns' non-null line numbers are exactly the parsed (ctx+del)/(ctx+add) sequences, strictly increasing per file", () => {
    const rows = buildSplitRows(MOCK_PARSED) as SplitRow[];
    const left: number[] = [];
    const right: number[] = [];
    for (const r of rows) {
      if (r.t === "ctx") {
        left.push(r.o);
        right.push(r.n);
      } else if (r.t === "pair") {
        if (r.l !== null) left.push(r.l.o as number);
        if (r.r !== null) right.push(r.r.n as number);
      }
    }
    const oldSeq: number[] = [];
    const newSeq: number[] = [];
    let ctx = 0;
    let del = 0;
    let add = 0;
    for (const f of MOCK_PARSED.files) {
      const fileOld: number[] = [];
      const fileNew: number[] = [];
      for (const h of f.hunks) {
        for (const l of h.lines) {
          if (l.o !== null) fileOld.push(l.o);
          if (l.n !== null) fileNew.push(l.n);
          if (l.k === "ctx") ctx++;
          else if (l.k === "del") del++;
          else add++;
        }
      }
      // git-like fixture: numbering restarts per file and increases strictly inside one
      for (let i = 1; i < fileOld.length; i++) expect(fileOld[i]).toBeGreaterThan(fileOld[i - 1]!);
      for (let i = 1; i < fileNew.length; i++) expect(fileNew[i]).toBeGreaterThan(fileNew[i - 1]!);
      oldSeq.push(...fileOld);
      newSeq.push(...fileNew);
    }
    expect(left).toEqual(oldSeq);
    expect(right).toEqual(newSeq);
    // 左栏非空格数 = del+ctx（右栏 = add+ctx）
    expect(left.length).toBe(del + ctx);
    expect(right.length).toBe(add + ctx);
  });

  it("property: zip padding arithmetic — empty left cells = pairs − dels, empty right = pairs − adds", () => {
    const rows = buildSplitRows(MOCK_PARSED) as SplitRow[];
    const pairs = rows.filter((r) => r.t === "pair") as Extract<SplitRow, { t: "pair" }>[];
    let del = 0;
    let add = 0;
    for (const f of MOCK_PARSED.files)
      for (const h of f.hunks) for (const l of h.lines) l.k === "del" ? del++ : l.k === "add" ? add++ : undefined;
    expect(pairs.filter((p) => p.l === null).length).toBe(pairs.length - del);
    expect(pairs.filter((p) => p.r === null).length).toBe(pairs.length - add);
  });

  it("single-file patch carries no file rows (§3.4)", () => {
    const parsed = parseUnifiedPatch(toPatch([MOCK_FILES[2]!]));
    const rows = buildSplitRows(parsed) as SplitRow[];
    expect(rows.length).toBe(13);
    expect(rows[0]).toEqual({ t: "hunk", text: "@@ -0,0 +1,12 @@" });
    expect(rows.slice(0, 2).every((r) => r.t !== "file")).toBe(true);
  });

  it("zip pairing: 2 dels vs 1 add ⇒ (del,add) + (del,null) — right-side empty cell", () => {
    const parsed = parseUnifiedPatch(
      [
        "diff --git a/seg.txt b/seg.txt",
        "--- a/seg.txt",
        "+++ b/seg.txt",
        "@@ -1,4 +1,3 @@",
        " keep1",
        "-delA",
        "-delB",
        "+addX",
        " keep2",
      ].join("\n"),
    );
    expect(buildSplitRows(parsed)).toEqual([
      { t: "hunk", text: "@@ -1,4 +1,3 @@" },
      { t: "ctx", o: 1, n: 1, text: "keep1" },
      { t: "pair", l: line("del", 2, null, "delA"), r: line("add", null, 2, "addX") },
      { t: "pair", l: line("del", 3, null, "delB"), r: null },
      { t: "ctx", o: 4, n: 3, text: "keep2" },
    ]);
  });

  it("`\\ No newline` reaches the ctx row via noEol (pair sides keep it inside their PatchLine)", () => {
    const parsed = parseUnifiedPatch(
      [
        "diff --git a/d.txt b/d.txt",
        "--- a/d.txt",
        "+++ b/d.txt",
        "@@ -1,2 +1,2 @@",
        "-old",
        "+new",
        " tail",
        "\\ No newline at end of file",
      ].join("\n"),
    );
    expect(buildSplitRows(parsed)).toEqual([
      { t: "hunk", text: "@@ -1,2 +1,2 @@" },
      { t: "pair", l: line("del", 1, null, "old"), r: line("add", null, 1, "new") },
      { t: "ctx", o: 2, n: 2, text: "tail", noEol: true },
    ]);
  });

  it("empty / null / malformed inputs ⇒ []", () => {
    expect(buildSplitRows(parseUnifiedPatch(""))).toEqual([]);
    expect(buildSplitRows(null)).toEqual([]);
    expect(buildSplitRows(undefined)).toEqual([]);
    expect(buildSplitRows({})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildUnifiedRows — §3.5 (row-count conservation + line identity)
// ---------------------------------------------------------------------------

describe("buildUnifiedRows", () => {
  it("row-count conservation: file rows (multi only) + one hunk row + one line row per PatchLine", () => {
    const rows = buildUnifiedRows(MOCK_PARSED) as { t: string }[];
    let hunks = 0;
    let lines = 0;
    for (const f of MOCK_PARSED.files)
      for (const h of f.hunks) {
        hunks++;
        lines += h.lines.length;
      }
    expect(rows.length).toBe(MOCK_PARSED.files.length + hunks + lines);
    expect(rows.length).toBe(3 + 6 + 69);
    expect(rows.filter((r) => r.t === "file").length).toBe(3);
    expect(rows.filter((r) => r.t === "hunk").length).toBe(6);
  });

  it("every line row mirrors its source PatchLine (o/n/text/noEol) with the mockup's sign column", () => {
    const rows = buildUnifiedRows(MOCK_PARSED) as Array<{
      t: string;
      o: unknown;
      n: unknown;
      sign?: string;
      text?: string;
      noEol?: true;
    }>;
    const flat = MOCK_PARSED.files.flatMap((f) => f.hunks.flatMap((h) => h.lines));
    const lineRows = rows.filter((r) => r.t === "ctx" || r.t === "del" || r.t === "add");
    expect(lineRows.length).toBe(flat.length);
    for (let i = 0; i < flat.length; i++) {
      const src = flat[i]!;
      const row = lineRows[i]!;
      expect(row.t).toBe(src.k);
      expect(row.o).toBe(src.o);
      expect(row.n).toBe(src.n);
      expect(row.text).toBe(src.text);
      expect(row.sign).toBe(src.k === "add" ? "+" : src.k === "del" ? "\u2212" : "");
      if (src.noEol === true) expect(row.noEol).toBe(true);
      else expect(row.noEol).toBeUndefined();
    }
  });

  it("file 2 slice keeps the ORIGINAL line interleave (only split re-pairs); exact rows", () => {
    const rows = buildUnifiedRows(MOCK_PARSED) as unknown[];
    expect(rows.slice(51, 64)).toEqual([
      { t: "file", meta: {} },
      { t: "hunk", text: "@@ -358,4 +358,5 @@" },
      { t: "ctx", o: 358, n: 358, sign: "", text: "@media (min-width: 1025px) {" },
      { t: "ctx", o: 359, n: 359, sign: "", text: " .run {" },
      {
        t: "add",
        o: null,
        n: 360,
        sign: "+",
        text: "    /* identity wins over prose: name floor 220px, fr flips to 1.5:1 */",
      },
      {
        t: "del",
        o: 360,
        n: null,
        sign: "\u2212",
        text: "    grid-template-columns: 18px 20px minmax(120px, 1.2fr) minmax(0, 2fr) auto auto;",
      },
      {
        t: "add",
        o: null,
        n: 361,
        sign: "+",
        text: "    grid-template-columns: 18px 20px minmax(220px, 1.5fr) minmax(0, 1fr) auto auto;",
      },
      { t: "ctx", o: 361, n: 362, sign: "", text: '   grid-template-areas: "chev icon name activity nums toggle";' },
      { t: "hunk", text: "@@ -388,3 +391,3 @@" },
      { t: "del", o: 388, n: null, sign: "\u2212", text: "@container (max-width: 559px) {" },
      { t: "add", o: null, n: 391, sign: "+", text: "@container (max-width: 599px) {" },
      { t: "ctx", o: 389, n: 392, sign: "", text: " .run {" },
      { t: "ctx", o: 390, n: 393, sign: "", text: "  grid-template-columns: 18px 20px minmax(0, 1fr) auto auto;" },
    ]);
  });

  it("noEol lands on the unified line row; single-file patch has no file rows", () => {
    const parsed = parseUnifiedPatch(
      ["diff --git a/d.txt b/d.txt", "@@ -1,2 +1,2 @@", "-old", "+new", " tail", "\\ No newline at end of file"].join(
        "\n",
      ),
    );
    expect(buildUnifiedRows(parsed)).toEqual([
      { t: "hunk", text: "@@ -1,2 +1,2 @@" },
      { t: "del", o: 1, n: null, sign: "\u2212", text: "old" },
      { t: "add", o: null, n: 1, sign: "+", text: "new" },
      { t: "ctx", o: 2, n: 2, sign: "", text: "tail", noEol: true },
    ]);
  });

  it("empty / null / malformed inputs ⇒ []", () => {
    expect(buildUnifiedRows(parseUnifiedPatch(""))).toEqual([]);
    expect(buildUnifiedRows(null)).toEqual([]);
    expect(buildUnifiedRows(undefined)).toEqual([]);
    expect(buildUnifiedRows({})).toEqual([]);
  });
});
