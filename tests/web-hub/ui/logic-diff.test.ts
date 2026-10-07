import { describe, expect, it } from "vitest";
import {
  buildEditDiff,
  DIFF_FOLD,
  editHunkRows,
  foldRows,
  splitLines,
} from "../../../src/web-hub/ui/src/logic/diff.js";

/**
 * `@logic/diff.js` (2026-10 edit-tool diff view): the pure half of ToolCard's unified-diff
 * presentation. Gate totality (`buildEditDiff` null ⇒ raw JSON), line alignment (prefix/suffix
 * trim + LCS), zip pairing with char prefix/suffix inline marks, the over-guard degrade, and
 * the display-fold slice. The component half (DOM, expand button) is `tool-card.test.ts`.
 */

type Row = ReturnType<typeof editHunkRows>[number];

function rowsOf(oldText: string, newText: string): Row[] {
  return editHunkRows(oldText, newText) as Row[];
}

/** Condensed row sketch for assertions: `=text` | `-{plain|marked}` | `+{plain|marked}`. */
function sketch(rows: Row[]): string[] {
  return rows.map((r) => {
    if (r.kind === "common") return `=${r.text}`;
    if (r.kind === "fold") return `…${r.count}`;
    const body = r.segs.map((s) => (s.hl ? `[${s.text}]` : s.text)).join("");
    return `${r.kind === "del" ? "-" : "+"}${body}`;
  });
}

describe("splitLines", () => {
  it("empty string is zero lines; a trailing newline keeps its trailing empty line", () => {
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a")).toEqual(["a"]);
    expect(splitLines("a\nb")).toEqual(["a", "b"]);
    expect(splitLines("a\n")).toEqual(["a", ""]);
  });
});

describe("editHunkRows — line alignment", () => {
  it("empty oldText (pure insertion): only add rows", () => {
    expect(sketch(rowsOf("", "x\ny"))).toEqual(["+x", "+y"]);
  });

  it("empty newText (pure deletion): only del rows", () => {
    expect(sketch(rowsOf("x\ny", ""))).toEqual(["-x", "-y"]);
  });

  it("both empty: no rows at all", () => {
    expect(rowsOf("", "")).toEqual([]);
  });

  it("single-line change keeps surrounding lines as context (zero-common pair ⇒ full-line marks)", () => {
    expect(sketch(rowsOf("a\nb\nc", "a\nX\nc"))).toEqual(["=a", "-[b]", "+[X]", "=c"]);
  });

  it("unequal group sizes zip-pair then leave pure rows (2 dels vs 1 add)", () => {
    expect(sketch(rowsOf("a\nb\nc", "X\nc"))).toEqual(["-[a]", "+[X]", "-b", "=c"]);
  });

  it("LCS aligns a reorder: swapped neighbours show as two single-line changes", () => {
    expect(sketch(rowsOf("p\nq\nr", "q\np\nr"))).toEqual(["-p", "=q", "+p", "=r"]);
  });

  it("multi-block middles interleave context rows between change groups", () => {
    expect(sketch(rowsOf("h\na\nmid\nb\nt", "h\nA\nmid\nB\nt"))).toEqual([
      "=h",
      "-[a]",
      "+[A]",
      "=mid",
      "-[b]",
      "+[B]",
      "=t",
    ]);
  });

  it("a trailing newline in only one side renders the empty line as a row", () => {
    expect(sketch(rowsOf("a\n", "a"))).toEqual(["=a", "-"]);
  });
});

describe("editHunkRows — inline prefix/suffix marks", () => {
  it("changed middle fragments get marked on both sides", () => {
    expect(sketch(rowsOf("foo(bar);", "foo(baz);"))).toEqual(["-foo(ba[r]);", "+foo(ba[z]);"]);
  });

  it("shared prefix keeps the suffix change marked", () => {
    expect(sketch(rowsOf("foobar", "foobaz"))).toEqual(["-fooba[r]", "+fooba[z]"]);
  });

  it("containment (pure insertion inside a line): the short side has no mark at all", () => {
    expect(sketch(rowsOf("abc", "abxc"))).toEqual(["-abc", "+ab[x]c"]);
  });

  it("empty old line vs non-empty new line: del row renders with no segments", () => {
    const rows = rowsOf("\nz", "q\nz");
    expect(sketch(rows)).toEqual(["-", "+[q]", "=z"]);
    expect((rows[0] as { segs: unknown[] }).segs).toEqual([]);
  });
});

describe("editHunkRows — LCS cost guard", () => {
  it("over the cell guard the middle degrades to pure rows (no commons, no pairing, no marks)", () => {
    const oldMid = Array.from({ length: 1001 }, (_, i) => `old ${i} x`);
    const newMid = Array.from({ length: 1001 }, (_, i) => `new ${i} y`);
    // distinct caps defeat the prefix/suffix line trim too, so the middles are the FULL
    // 1003×1003 lines — 1003·1003 > LCS_CELL_GUARD (1e6) ⇒ degrade.
    const rows = editHunkRows(`A\n${oldMid.join("\n")}\nB`, `C\n${newMid.join("\n")}\nD`);
    expect(rows).toHaveLength(2006);
    expect(rows.filter((r) => r.kind === "del")).toHaveLength(1003);
    expect(rows.filter((r) => r.kind === "add")).toHaveLength(1003);
    expect(rows.filter((r) => r.kind === "common")).toHaveLength(0);
    expect(rows.every((r) => r.kind === "fold" || r.segs.every((s) => !s.hl))).toBe(true);
  });

  it("under the guard the LCS still runs (commons detected between big-ish middles)", () => {
    const n = 500; // 500·500 = 250k cells, well under the guard
    const mid = Array.from({ length: n }, (_, i) => `line ${i}`);
    const rows = editHunkRows(`head\n${mid.join("\n")}`, `head\n${mid.join("\n")}`);
    expect(rows).toHaveLength(n + 1);
    expect(rows.every((r) => r.kind === "common")).toBe(true);
  });
});

describe("foldRows — display fold guard", () => {
  const row = (i: number): Row => ({ kind: "common", text: `r${i}` });

  it("at/below the threshold: unchanged, not folded", () => {
    const rows = Array.from({ length: DIFF_FOLD.threshold }, (_, i) => row(i));
    const out = foldRows(rows);
    expect(out.folded).toBe(false);
    expect(out.hidden).toBe(0);
    expect(out.rows).toBe(rows);
  });

  it("above the threshold: head + fold marker + tail, marker carries the hidden count", () => {
    const rows = Array.from({ length: 205 }, (_, i) => row(i));
    const out = foldRows(rows);
    expect(out.folded).toBe(true);
    expect(out.hidden).toBe(165);
    expect(out.rows).toHaveLength(DIFF_FOLD.head + 1 + DIFF_FOLD.tail);
    const marker = out.rows[DIFF_FOLD.head] as { kind: string; count: number };
    expect(marker.kind).toBe("fold");
    expect(marker.count).toBe(165);
    expect(out.rows[0]).toEqual(row(0));
    expect(out.rows[out.rows.length - 1]).toEqual(row(204));
  });

  it("custom opts are honored; a non-positive hidden count never folds", () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(i));
    expect(foldRows(rows, { threshold: 10, head: 5, tail: 5 }).folded).toBe(true);
    expect(foldRows(rows, { threshold: 10, head: 20, tail: 20 }).folded).toBe(false);
  });

  it("the input array is never mutated", () => {
    const rows = Array.from({ length: 205 }, (_, i) => row(i));
    const before = JSON.stringify(rows);
    foldRows(rows);
    expect(JSON.stringify(rows)).toBe(before);
  });
});

describe("buildEditDiff — gate totality", () => {
  it("non-edit tool names, and any malformed args shape, return null (raw JSON stays)", () => {
    const edits = [{ oldText: "a", newText: "b" }];
    expect(buildEditDiff("bash", { edits })).toBeNull();
    expect(buildEditDiff("edit", undefined)).toBeNull();
    expect(buildEditDiff("edit", "echo hi")).toBeNull();
    expect(buildEditDiff("edit", null)).toBeNull();
    expect(buildEditDiff("edit", [{ oldText: "a", newText: "b" }])).toBeNull();
    expect(buildEditDiff("edit", {})).toBeNull();
    expect(buildEditDiff("edit", { edits: [] })).toBeNull();
    expect(buildEditDiff("edit", { edits: "no" })).toBeNull();
    expect(buildEditDiff("edit", { edits: [{ oldText: "a" }] })).toBeNull();
    expect(buildEditDiff("edit", { edits: [{ oldText: 1, newText: "b" }] })).toBeNull();
    expect(buildEditDiff("edit", { edits: [{ oldText: "a", newText: "b" }, null] })).toBeNull();
    expect(buildEditDiff("edit", { edits: [{}] })).toBeNull();
  });

  it("a parseable edit yields path + one hunk per entry, in order", () => {
    const view = buildEditDiff("edit", {
      path: "/p/src/a.ts",
      edits: [
        { oldText: "a\nb", newText: "a\nB" },
        { oldText: "", newText: "new" },
      ],
    });
    expect(view).not.toBeNull();
    expect(view!.path).toBe("/p/src/a.ts");
    expect(view!.edits).toHaveLength(2);
    expect(sketch(view!.edits[0]!.rows)).toEqual(["=a", "-[b]", "+[B]"]);
    expect(sketch(view!.edits[1]!.rows)).toEqual(["+new"]);
  });

  it("path is null when missing or empty; empty-string texts are VALID edits", () => {
    expect(buildEditDiff("edit", { edits: [{ oldText: "", newText: "" }] })!.path).toBeNull();
    expect(buildEditDiff("edit", { path: "", edits: [{ oldText: "x", newText: "y" }] })!.path).toBeNull();
    expect(buildEditDiff("edit", { edits: [{ oldText: "", newText: "" }] })!.edits).toHaveLength(1);
  });
});
