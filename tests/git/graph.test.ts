import { describe, expect, it } from "vitest";

import {
  WTGRAPH_AUTHOR_MAX_BYTES,
  WTGRAPH_PARENTS_MAX,
  WTGRAPH_REFNAME_MAX_BYTES,
  WTGRAPH_SUBJECT_MAX_BYTES,
  WTGRAPH_TIPS_MAX,
  WTGRAPH_WT_HEADS_MAX,
  classifyGraphExit,
  parseForEachRefZ,
  parseGraphLogZ,
  tipsFromRefs,
  truncateText,
  wtGraphArgs,
  type ForEachRefRow,
} from "../../src/git/graph.js";
import { WT_PINNED_PREFIX } from "../../src/git/diff.js";

const SHA1_A = "a".repeat(40);
const SHA1_B = "b".repeat(40);
const SHA1_C = "c".repeat(40);
const SHA256_A = "a".repeat(64);
const SHA256_B = "b".repeat(64);

function row(
  partial: Partial<ForEachRefRow> & Pick<ForEachRefRow, "objectType" | "objectName" | "refname">,
): ForEachRefRow {
  return {
    derefType: "",
    derefName: "",
    upstream: "",
    symref: "",
    ...partial,
  };
}

function commitRow(oid: string, refname: string, extra: Partial<ForEachRefRow> = {}): ForEachRefRow {
  return row({ objectType: "commit", objectName: oid, refname, ...extra });
}

describe("wtGraphArgs byte-exact snapshots (§2.2)", () => {
  const P = [...WT_PINNED_PREFIX];
  const GB = [...P, "--no-lazy-fetch", "--no-replace-objects", "--no-pager", "-c", "core.hooksPath=/dev/null"];

  it("refs() is the frozen Gr argv — every hardening flag present, no --all/--branches/HEAD", () => {
    const argv = wtGraphArgs.refs();
    expect(argv).toEqual([
      ...GB,
      "for-each-ref",
      "--count=2001",
      "--format=%(objecttype)%00%(objectname)%00%(*objecttype)%00%(*objectname)%00%(refname)%00%(upstream:short)%00%(symref)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ]);
    expect(argv).toContain("--no-lazy-fetch");
    expect(argv).not.toContain("--all");
    expect(argv).not.toContain("--branches");
    expect(argv).not.toContain("HEAD");
  });

  it("log(tips) is the frozen Gl argv — exact format string, tips as bare positional args before --", () => {
    const argv = wtGraphArgs.log([SHA1_A, SHA1_B]);
    expect(argv).toEqual([
      ...GB,
      "-c",
      "log.showSignature=false",
      "-c",
      "log.mailmap=false",
      "-c",
      "i18n.logOutputEncoding=UTF-8",
      "log",
      "--no-show-signature",
      "--no-use-mailmap",
      "--no-notes",
      "--no-decorate",
      "--no-color",
      "--date-order",
      "-z",
      "--max-count=201",
      "--format=%H%x1f%P%x1f%an%x1f%at%x1f%s",
      SHA1_A,
      SHA1_B,
      "--",
    ]);
    expect(argv).not.toContain("--all");
    expect(argv).not.toContain("--branches");
    expect(argv).not.toContain("HEAD");
    // every tip sits strictly between the format arg and the "--" terminator
    const formatIndex = argv.indexOf("--format=%H%x1f%P%x1f%an%x1f%at%x1f%s");
    const dashIndex = argv.lastIndexOf("--");
    for (const tip of [SHA1_A, SHA1_B]) {
      const idx = argv.indexOf(tip);
      expect(idx).toBeGreaterThan(formatIndex);
      expect(idx).toBeLessThan(dashIndex);
    }
  });

  it("log([]) still carries the trailing -- terminator with zero tips", () => {
    const argv = wtGraphArgs.log([]);
    expect(argv.slice(-1)).toEqual(["--"]);
    expect(argv.filter((a) => /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(a))).toEqual([]);
  });

  it("tips only ever contain hex — a hostile caller passing a flag-shaped string is not special-cased by the builder (tipsFromRefs is the real gate)", () => {
    const argv = wtGraphArgs.log(["--upload-pack=evil"]);
    expect(argv.slice(-2)).toEqual(["--upload-pack=evil", "--"]);
  });
});

describe("parseForEachRefZ", () => {
  it("parses a full line-per-ref, NUL-field record", () => {
    const stdout = `commit\0${SHA1_A}\0\0\0refs/heads/main\0\0\n`;
    expect(parseForEachRefZ(stdout, false)).toEqual([
      {
        objectType: "commit",
        objectName: SHA1_A,
        derefType: "",
        derefName: "",
        refname: "refs/heads/main",
        upstream: "",
        symref: "",
      },
    ]);
  });

  it("parses an annotated tag row with deref fields and a symref row", () => {
    const stdout =
      [
        `tag\0${SHA1_B}\0commit\0${SHA1_A}\0refs/tags/v1\0\0`,
        `commit\0${SHA1_A}\0\0\0refs/remotes/origin/HEAD\0\0refs/remotes/origin/main`,
      ].join("\n") + "\n";
    const rows = parseForEachRefZ(stdout, false);
    expect(rows).toEqual([
      {
        objectType: "tag",
        objectName: SHA1_B,
        derefType: "commit",
        derefName: SHA1_A,
        refname: "refs/tags/v1",
        upstream: "",
        symref: "",
      },
      {
        objectType: "commit",
        objectName: SHA1_A,
        derefType: "",
        derefName: "",
        refname: "refs/remotes/origin/HEAD",
        upstream: "",
        symref: "refs/remotes/origin/main",
      },
    ]);
  });

  it("drops the trailing partial line when capped", () => {
    const full =
      [`commit\0${SHA1_A}\0\0\0refs/heads/main\0\0`, `commit\0${SHA1_B}\0\0\0refs/heads/b\0\0`].join("\n") + "\n";
    const cut = full.slice(0, -5); // cut inside the second record's final field
    expect(parseForEachRefZ(cut, true)).toEqual([
      {
        objectType: "commit",
        objectName: SHA1_A,
        derefType: "",
        derefName: "",
        refname: "refs/heads/main",
        upstream: "",
        symref: "",
      },
    ]);
    // cap landing exactly on the trailing "\n": the lost trailing "" is harmless, both complete records survive
    expect(parseForEachRefZ(full, true)).toHaveLength(2);
  });

  it("silently drops a malformed interior line (wrong field count)", () => {
    const stdout = ["not-the-right-shape", `commit\0${SHA1_A}\0\0\0refs/heads/main\0\0`].join("\n") + "\n";
    expect(parseForEachRefZ(stdout, false)).toHaveLength(1);
  });

  it("handles a Unicode replacement character already present in a field (what Node's utf8 decode produces for invalid bytes) without crashing", () => {
    const stdout = `commit\0${SHA1_A}\0\0\0refs/heads/\uFFFD\0\0\n`;
    const rows = parseForEachRefZ(stdout, false);
    expect(rows[0]!.refname).toBe("refs/heads/\uFFFD");
  });

  it("empty stdout (no refs at all, e.g. unborn repo) parses to zero rows", () => {
    expect(parseForEachRefZ("", false)).toEqual([]);
  });
});

describe("tipsFromRefs", () => {
  it("includes a plain commit ref and a nested-tag row already fully dereferenced by git to its commit", () => {
    const rows = [
      commitRow(SHA1_A, "refs/heads/main"),
      row({
        objectType: "tag",
        objectName: SHA1_B,
        derefType: "commit",
        derefName: SHA1_C,
        refname: "refs/tags/nested",
      }),
    ];
    const result = tipsFromRefs(rows, []);
    expect(result.format).toBe("sha1");
    expect(new Set(result.tips)).toEqual(new Set([SHA1_A, SHA1_C]));
    expect(result.refsSkipped).toBe(0);
    expect(result.wtHeadsCapped).toBe(false);
  });

  it("a tag pointing to a tree (not a commit) is excluded and counted in refsSkipped", () => {
    const rows = [
      row({
        objectType: "tag",
        objectName: SHA1_A,
        derefType: "tree",
        derefName: SHA1_B,
        refname: "refs/tags/tree-tag",
      }),
    ];
    const result = tipsFromRefs(rows, []);
    expect(result.tips).toEqual([]);
    expect(result.refsSkipped).toBe(1);
  });

  it("a lightweight tag pointing directly at a blob (objecttype=blob) is excluded and counted", () => {
    const rows = [row({ objectType: "blob", objectName: SHA1_A, refname: "refs/tags/blob-tag" })];
    const result = tipsFromRefs(rows, []);
    expect(result.tips).toEqual([]);
    expect(result.refsSkipped).toBe(1);
  });

  it("a symref row (origin/HEAD) is excluded WITHOUT being counted as skipped", () => {
    const rows = [
      commitRow(SHA1_A, "refs/remotes/origin/main"),
      commitRow(SHA1_A, "refs/remotes/origin/HEAD", { symref: "refs/remotes/origin/main" }),
    ];
    const result = tipsFromRefs(rows, []);
    expect(result.tips).toEqual([SHA1_A]);
    expect(result.refsSkipped).toBe(0);
  });

  it("an oversized refname (> 200 bytes) excludes an otherwise-valid tip and counts it", () => {
    const longName = `refs/heads/${"x".repeat(WTGRAPH_REFNAME_MAX_BYTES)}`;
    expect(Buffer.byteLength(longName, "utf8")).toBeGreaterThan(WTGRAPH_REFNAME_MAX_BYTES);
    const rows = [commitRow(SHA1_A, longName)];
    const result = tipsFromRefs(rows, []);
    expect(result.tips).toEqual([]);
    expect(result.refsSkipped).toBe(1);
  });

  it("a malformed oid (bad hex / bad length) is excluded and counted", () => {
    const rows = [
      commitRow("not-hex-at-all", "refs/heads/bad1"),
      commitRow("abc123", "refs/heads/bad2"), // too short
    ];
    const result = tipsFromRefs(rows, []);
    expect(result.tips).toEqual([]);
    expect(result.refsSkipped).toBe(2);
    expect(result.format).toBeUndefined();
  });

  it("mixed-length oids: majority format wins, minority is dropped and counted (refsSkipped)", () => {
    const rows = [
      commitRow(SHA1_A, "refs/heads/a"),
      commitRow(SHA1_B, "refs/heads/b"),
      commitRow(SHA256_A, "refs/heads/sha256-minority"), // minority length
    ];
    const result = tipsFromRefs(rows, []);
    expect(result.format).toBe("sha1");
    expect(new Set(result.tips)).toEqual(new Set([SHA1_A, SHA1_B]));
    expect(result.refsSkipped).toBe(1);
  });

  it("mixed-length oids where sha256 is the majority picks sha256 and drops the sha1 minority", () => {
    const rows = [
      commitRow(SHA256_A, "refs/heads/a"),
      commitRow(SHA256_B, "refs/heads/b"),
      commitRow(SHA1_A, "refs/heads/minority"),
    ];
    const result = tipsFromRefs(rows, []);
    expect(result.format).toBe("sha256");
    expect(new Set(result.tips)).toEqual(new Set([SHA256_A, SHA256_B]));
    expect(result.refsSkipped).toBe(1);
  });

  it("dedupes identical oids reachable via multiple refs (e.g. local + remote-tracking)", () => {
    const rows = [commitRow(SHA1_A, "refs/heads/main"), commitRow(SHA1_A, "refs/remotes/origin/main")];
    const result = tipsFromRefs(rows, []);
    expect(result.tips).toEqual([SHA1_A]);
  });

  it(`caps at WTGRAPH_TIPS_MAX (${WTGRAPH_TIPS_MAX}) even when more distinct valid tips are supplied`, () => {
    const rows = Array.from({ length: WTGRAPH_TIPS_MAX + 50 }, (_, i) =>
      commitRow(i.toString(16).padStart(40, "0"), `refs/heads/b${i}`),
    );
    const result = tipsFromRefs(rows, []);
    expect(result.tips).toHaveLength(WTGRAPH_TIPS_MAX);
  });

  it("extraHeads: drops an all-zero (unborn) oid without counting it against refsSkipped", () => {
    const result = tipsFromRefs([commitRow(SHA1_A, "refs/heads/main")], ["0".repeat(40)]);
    expect(result.tips).toEqual([SHA1_A]);
    expect(result.refsSkipped).toBe(0);
    expect(result.wtHeadsCapped).toBe(false);
  });

  it("extraHeads: a detached worktree HEAD unreachable via any ref still becomes a tip", () => {
    const result = tipsFromRefs([commitRow(SHA1_A, "refs/heads/main")], [SHA1_B]);
    expect(new Set(result.tips)).toEqual(new Set([SHA1_A, SHA1_B]));
  });

  it(`extraHeads beyond WTGRAPH_WT_HEADS_MAX (${WTGRAPH_WT_HEADS_MAX}) are capped (first-N) and flagged`, () => {
    const heads = Array.from({ length: WTGRAPH_WT_HEADS_MAX + 5 }, (_, i) => (i + 1).toString(16).padStart(40, "0"));
    const result = tipsFromRefs([], heads);
    expect(result.wtHeadsCapped).toBe(true);
    expect(result.tips).toHaveLength(WTGRAPH_WT_HEADS_MAX);
    expect(new Set(result.tips)).toEqual(new Set(heads.slice(0, WTGRAPH_WT_HEADS_MAX)));
  });

  it("no refs and no heads at all (unborn repo) yields an empty, format-undefined result", () => {
    const result = tipsFromRefs([], []);
    expect(result).toEqual({ tips: [], format: undefined, refsSkipped: 0, wtHeadsCapped: false });
  });
});

describe("parseGraphLogZ", () => {
  function rec(h: string, p: string[], an: string, at: number, s: string): string {
    return [h, p.join(" "), an, String(at), s].join("\x1f");
  }

  it("parses a root commit (empty parent list) and a normal commit", () => {
    const stdout =
      [rec(SHA1_A, [], "Alice", 1700000000, "root"), rec(SHA1_B, [SHA1_A], "Bob", 1700000100, "second")].join("\0") +
      "\0";
    const result = parseGraphLogZ(stdout, false, "sha1");
    expect(result.badRecords).toBe(0);
    expect(result.commits).toEqual([
      { h: SHA1_A, p: [], a: "Alice", t: 1700000000, s: "root" },
      { h: SHA1_B, p: [SHA1_A], a: "Bob", t: 1700000100, s: "second" },
    ]);
  });

  it("parses an octopus merge with multiple parents, order preserved", () => {
    const stdout = rec(SHA1_C, [SHA1_A, SHA1_B], "Carol", 1700000200, "octopus") + "\0";
    const result = parseGraphLogZ(stdout, false, "sha1");
    expect(result.commits[0]!.p).toEqual([SHA1_A, SHA1_B]);
  });

  it("drops the trailing partial record when capped, keeping the complete ones (§2.3 capped-first)", () => {
    const full =
      [rec(SHA1_A, [], "Alice", 1700000000, "root"), rec(SHA1_B, [SHA1_A], "Bob", 1700000100, "second")].join("\0") +
      "\0";
    const cut = full.slice(0, -5); // cut inside the second record's subject field
    const result = parseGraphLogZ(cut, true, "sha1");
    expect(result.commits).toEqual([{ h: SHA1_A, p: [], a: "Alice", t: 1700000000, s: "root" }]);
    expect(result.badRecords).toBe(0); // the cut record is excluded, not counted as bad
  });

  it(`truncates a parent list longer than WTGRAPH_PARENTS_MAX (${WTGRAPH_PARENTS_MAX}) and flags pT`, () => {
    const parents = Array.from({ length: WTGRAPH_PARENTS_MAX + 3 }, (_, i) => (i + 1).toString(16).padStart(40, "0"));
    const stdout = rec(SHA1_A, parents, "Author", 1700000000, "huge octopus") + "\0";
    const result = parseGraphLogZ(stdout, false, "sha1");
    expect(result.commits).toHaveLength(1);
    expect(result.commits[0]!.p).toEqual(parents.slice(0, WTGRAPH_PARENTS_MAX));
    expect(result.commits[0]!.pT).toBe(true);
    expect(result.parentsTruncated).toBe(1);
  });

  it("drops a record with a malformed hash, parent, or timestamp and counts badRecords", () => {
    // rec() stringifies -1/NaN as "-1"/"NaN", which the digits-only timestamp regex rejects.
    const bad = [
      rec("not-hex", [], "A", 1700000000, "bad hash"),
      rec(SHA1_A, ["not-hex-parent"], "A", 1700000000, "bad parent"),
      rec(SHA1_B, [], "A", -1, "negative timestamp"),
      rec(SHA1_C, [], "A", NaN, "nan timestamp"),
    ];
    const stdout = bad.join("\0") + "\0";
    const result = parseGraphLogZ(stdout, false, "sha1");
    expect(result.commits).toEqual([]);
    expect(result.badRecords).toBe(4);
  });

  it("a record with fewer than 5 \\x1f-separated fields (missing subject entirely) is dropped", () => {
    const stdout = `${SHA1_A}\x1f\x1fAlice\x1f1700000000` + "\0"; // only 4 fields
    const result = parseGraphLogZ(stdout, false, "sha1");
    expect(result.commits).toEqual([]);
    expect(result.badRecords).toBe(1);
  });

  it("rejects a hash/parent of the wrong length for the requested format", () => {
    const stdout = rec(SHA256_A, [], "Alice", 1700000000, "wrong format") + "\0";
    const result = parseGraphLogZ(stdout, false, "sha1");
    expect(result.commits).toEqual([]);
    expect(result.badRecords).toBe(1);
  });

  it("sanitizes C0 control characters in author/subject to U+FFFD", () => {
    const stdout = rec(SHA1_A, [], "A\x01lice", 1700000000, "line\twith\x07control") + "\0";
    const result = parseGraphLogZ(stdout, false, "sha1");
    expect(result.commits[0]!.a).toBe("A\uFFFDlice");
    expect(result.commits[0]!.s).toBe("line\uFFFDwith\uFFFDcontrol");
  });

  it(`truncates the subject to WTGRAPH_SUBJECT_MAX_BYTES (${WTGRAPH_SUBJECT_MAX_BYTES}) and author to WTGRAPH_AUTHOR_MAX_BYTES (${WTGRAPH_AUTHOR_MAX_BYTES})`, () => {
    const longSubject = "s".repeat(WTGRAPH_SUBJECT_MAX_BYTES + 50);
    const longAuthor = "a".repeat(WTGRAPH_AUTHOR_MAX_BYTES + 20);
    const stdout = rec(SHA1_A, [], longAuthor, 1700000000, longSubject) + "\0";
    const result = parseGraphLogZ(stdout, false, "sha1");
    expect(Buffer.byteLength(result.commits[0]!.s, "utf8")).toBeLessThanOrEqual(WTGRAPH_SUBJECT_MAX_BYTES);
    expect(Buffer.byteLength(result.commits[0]!.a, "utf8")).toBeLessThanOrEqual(WTGRAPH_AUTHOR_MAX_BYTES);
  });

  it("works for sha256-format commits", () => {
    const stdout = rec(SHA256_A, [SHA256_B], "Alice", 1700000000, "sha256 commit") + "\0";
    const result = parseGraphLogZ(stdout, false, "sha256");
    expect(result.commits).toEqual([{ h: SHA256_A, p: [SHA256_B], a: "Alice", t: 1700000000, s: "sha256 commit" }]);
  });

  it("empty stdout (tips produced zero commits, which should not happen since empty tips skip Gl — defensive) parses to zero commits", () => {
    expect(parseGraphLogZ("", false, "sha1")).toEqual({ commits: [], badRecords: 0, parentsTruncated: 0 });
  });
});

describe("truncateText", () => {
  it("replaces every C0 control character and DEL with U+FFFD", () => {
    expect(truncateText("a\x00b\x1fc\x7fd\nE", 100)).toBe("a\uFFFDb\uFFFDc\uFFFDd\uFFFDE");
  });

  it("truncates at a byte budget without splitting a multi-byte UTF-8 character", () => {
    const text = "€".repeat(10); // each € is 3 bytes in UTF-8
    const truncated = truncateText(text, 10); // 10 bytes = 3 whole € (9 bytes) + 1 stray byte dropped
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(10);
    expect(truncated).toBe("€".repeat(3));
  });

  it("leaves short text untouched", () => {
    expect(truncateText("hello", 200)).toBe("hello");
  });
});

describe("classifyGraphExit (§2.3 结果分类顺序 — called only on a completed, non-capped run)", () => {
  it("code 0 is not an error", () => {
    expect(classifyGraphExit(0, "")).toBeNull();
  });

  it("code 129 is always git-too-old, regardless of stderr content (the --no-lazy-fetch fail-closed path)", () => {
    expect(classifyGraphExit(129, "unknown option: --no-lazy-fetch\nusage: git ...")).toBe("git-too-old");
    expect(classifyGraphExit(129, "")).toBe("git-too-old");
  });

  it("missing-object stderr markers classify as missing-object", () => {
    expect(classifyGraphExit(128, "fatal: bad tag\n")).toBe("missing-object");
    expect(classifyGraphExit(128, "error: Could not read deadbeef\nfatal: revision walk setup failed\n")).toBe(
      "missing-object",
    );
    expect(classifyGraphExit(128, "fatal: bad object HEAD\n")).toBe("missing-object");
    // a PACKED (peeled) tag's deleted target reports a differently-worded fatal (git 2.53,
    // field-verified against a real `git pack-refs --all` repo — see the integration suite).
    expect(classifyGraphExit(128, "fatal: missing object deadbeefcafe for refs/tags/vok\n")).toBe("missing-object");
  });

  it("any other non-zero exit with unrelated stderr is git-failed", () => {
    expect(classifyGraphExit(1, "fatal: something else entirely\n")).toBe("git-failed");
    expect(classifyGraphExit(128, "")).toBe("git-failed");
  });

  it("fails closed: code -1 (the hub's capped sentinel, §2.5) still classifies as git-failed if the capped-first gate is ever skipped", () => {
    expect(classifyGraphExit(-1, "")).toBe("git-failed");
  });

  it("a negative code classifies as git-failed BEFORE stderr matching, even when stderr happens to look like a missing-object message", () => {
    expect(classifyGraphExit(-1, "fatal: bad tag\n")).toBe("git-failed");
    expect(classifyGraphExit(-1, "error: Could not read deadbeef\n")).toBe("git-failed");
  });
});

describe("mirrored protocol constants stay in lockstep with src/web-hub/protocol/worktree-graph.ts (P0) — test-only import, never from production graph.ts", async () => {
  // Deliberately dynamic + test-scoped: graph.ts itself must stay protocol-free (closure
  // discipline, see the file header), so this drift gate imports P0's frozen file ONLY here.
  const protocol = await import("../../src/web-hub/protocol/worktree-graph.js");

  it("every WTGRAPH_* constant graph.ts mirrors is byte-identical to the protocol's own export", () => {
    expect(WTGRAPH_PARENTS_MAX).toBe(protocol.WTGRAPH_PARENTS_MAX);
    expect(WTGRAPH_SUBJECT_MAX_BYTES).toBe(protocol.WTGRAPH_SUBJECT_MAX_BYTES);
    expect(WTGRAPH_AUTHOR_MAX_BYTES).toBe(protocol.WTGRAPH_AUTHOR_MAX_BYTES);
    expect(WTGRAPH_REFNAME_MAX_BYTES).toBe(protocol.WTGRAPH_REFNAME_MAX_BYTES);
    expect(WTGRAPH_TIPS_MAX).toBe(protocol.WTGRAPH_TIPS_MAX);
    expect(WTGRAPH_WT_HEADS_MAX).toBe(protocol.WTGRAPH_WT_HEADS_MAX);
  });
});

describe("robustness probes (non-UTF-8 bytes, embedded \\x1f in subject, invalid/mixed-length extraHeads)", () => {
  it("a real invalid-UTF-8 byte sequence, decoded the way run.ts decodes stdout (Buffer→utf8, replacement chars), parses without throwing", () => {
    // Simulate exactly what run.ts hands parsers: Buffer.concat(chunks).toString("utf8") on
    // bytes that are NOT valid UTF-8 (a lone continuation byte, an overlong sequence).
    const invalidBytes = Buffer.from([0xff, 0xfe, 0x80, 0x81]);
    const decoded = invalidBytes.toString("utf8"); // Node replaces with U+FFFD per invalid byte
    expect(decoded).toContain("\uFFFD");
    const stdout = `${SHA1_A}\x1f\x1f${decoded}\x1f1700000000\x1fsubject\0`;
    expect(() => parseGraphLogZ(stdout, false, "sha1")).not.toThrow();
    const result = parseGraphLogZ(stdout, false, "sha1");
    expect(result.commits).toHaveLength(1);
    expect(result.commits[0]!.a).toContain("\uFFFD");

    const refStdout = `commit\0${SHA1_A}\0\0\0refs/heads/${decoded}\0\0\n`;
    expect(() => parseForEachRefZ(refStdout, false)).not.toThrow();
  });

  it("a subject containing a literal \\x1f byte is swallowed into the subject field, not mis-split (the subject is the verbatim remainder)", () => {
    const stdout = `${SHA1_A}\x1f\x1fAuthor\x1f1700000000\x1fline one\x1fline two (not a 6th field)\0`;
    const result = parseGraphLogZ(stdout, false, "sha1");
    expect(result.commits).toHaveLength(1);
    expect(result.commits[0]!.s).toBe("line one\x1fline two (not a 6th field)".replace(/[\x00-\x1f\x7f]/g, "\uFFFD"));
  });

  it("tipsFromRefs: invalid and mixed-length extraHeads are rejected without throwing or corrupting the format vote", () => {
    const extraHeads = [
      "not-hex-at-all",
      "abc123", // too short
      SHA256_A, // wrong format relative to the sha1 majority below
      "0".repeat(40), // unborn
      "", // empty
      SHA1_B, // the only genuinely valid, additive head
    ];
    const rows = [commitRow(SHA1_A, "refs/heads/main")];
    expect(() => tipsFromRefs(rows, extraHeads)).not.toThrow();
    const result = tipsFromRefs(rows, extraHeads);
    expect(result.format).toBe("sha1");
    expect(new Set(result.tips)).toEqual(new Set([SHA1_A, SHA1_B]));
    expect(result.wtHeadsCapped).toBe(false);
  });

  it(`parse budget: max-sized realistic inputs (~256 KiB refs, ~512 KiB log) parse well within a generous bound (median ≤ 50ms over 5 runs)`, () => {
    const refLines: string[] = [];
    for (let i = 0; i < 1800; i++) {
      refLines.push(`commit\0${i.toString(16).padStart(40, "0")}\0\0\0refs/heads/branch-${i}\0\0`);
    }
    let refStdout = refLines.join("\n") + "\n";
    refStdout = refStdout.padEnd(256 * 1024, "\n"); // pad toward the real WTGRAPH_REFS_MAX_BYTES cap
    const logLines: string[] = [];
    for (let i = 0; i < 1800; i++) {
      const h = i.toString(16).padStart(40, "0");
      const p = i === 0 ? "" : (i - 1).toString(16).padStart(40, "0");
      logLines.push(`${h}\x1f${p}\x1fAuthor Name\x1f170000${String(i).padStart(4, "0")}\x1fsubject line number ${i}`);
    }
    let logStdout = logLines.join("\0") + "\0";
    logStdout = logStdout.padEnd(512 * 1024, "\0");

    const refSamples: number[] = [];
    const logSamples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const rows = parseForEachRefZ(refStdout, false);
      refSamples.push(performance.now() - t0);
      expect(rows.length).toBeGreaterThan(0);
      const t1 = performance.now();
      const result = parseGraphLogZ(logStdout, false, "sha1");
      logSamples.push(performance.now() - t1);
      expect(result.commits.length).toBeGreaterThan(0);
    }
    const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    // Generous bound to avoid CI flakiness (plan §2.4 only requires "not counted against the
    // deadline budget"; this pins it stays comfortably fast, not a tight perf SLA).
    expect(median(refSamples)).toBeLessThanOrEqual(50);
    expect(median(logSamples)).toBeLessThanOrEqual(50);
    for (const s of [...refSamples, ...logSamples]) expect(s).toBeLessThanOrEqual(200); // worst-of-5 ceiling
  });
});

describe("argv execution whitelist (§2.3: no pathspec/content/diff-producing options anywhere in the frozen argv)", () => {
  const FORBIDDEN = [
    "-p",
    "--patch",
    "--stat",
    "--name-only",
    "--name-status",
    "-S",
    "-G",
    "--follow",
    "--pickaxe-regex",
  ];

  it("wtGraphArgs.refs() and wtGraphArgs.log() contain none of the forbidden content/diff-producing options", () => {
    const refsArgv = wtGraphArgs.refs();
    const logArgv = wtGraphArgs.log([SHA1_A]);
    for (const forbidden of FORBIDDEN) {
      expect(refsArgv).not.toContain(forbidden);
      expect(logArgv).not.toContain(forbidden);
    }
  });
});
