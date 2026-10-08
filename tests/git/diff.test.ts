import { describe, expect, it } from "vitest";

import {
  WTDIFF_DRIVER_NAME_RE,
  WTDIFF_DRIVER_SCAN_MAX,
  WTDIFF_EMPTY_TREE,
  WTDIFF_GIT_PATH,
  WT_PINNED_PREFIX,
  attrSourceArgs,
  combinedStatus,
  driverNamesFromAttributes,
  neutralizeArgs,
  parseCheckAttrZ,
  parseDriverScan,
  parseHeadProbe,
  parseNumstatZ,
  parseStatusV2Z,
  wtDiffArgs,
  type StatusV2ZEntry,
} from "../../src/git/diff.js";
import { PINNED_PREFIX } from "../../src/git/run.js";

const OID = "f1520b13e98facc95210c56627784ac87f36840f";

function statusEntry(partial: Partial<StatusV2ZEntry> & Pick<StatusV2ZEntry, "path" | "xy" | "kind">): StatusV2ZEntry {
  return partial;
}

describe("constants", () => {
  it("WT_PINNED_PREFIX mirrors run.ts's PINNED_PREFIX byte-for-byte", () => {
    expect([...WT_PINNED_PREFIX]).toEqual([...PINNED_PREFIX]);
    expect(WTDIFF_GIT_PATH).toBe("/usr/bin:/bin");
    expect(WTDIFF_EMPTY_TREE.sha1).toMatch(/^[0-9a-f]{40}$/);
    expect(WTDIFF_EMPTY_TREE.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("parseStatusV2Z", () => {
  it("parses all four record kinds, headers and renames from real -z byte shapes", () => {
    const stdout =
      [
        "# branch.oid abcdef0123456789abcdef0123456789abcdef0123",
        "# branch.head main",
        `1 .M N... 100644 100644 100644 ${OID} ${OID} a.txt`,
        `2 R. N... 100644 100644 100644 ${OID} ${OID} R100 new.txt`,
        "old.txt",
        `u UU N... 100644 100644 100644 ${OID} ${OID} ${OID} ${OID} conflicted.txt`,
        "? untracked.txt",
        "! ignored.txt",
      ].join("\0") + "\0";
    const parsed = parseStatusV2Z(stdout, false);
    expect(parsed.oid).toBe("abcdef0123456789abcdef0123456789abcdef0123");
    expect(parsed.capped).toBe(false);
    expect(parsed.entries).toEqual([
      { path: "a.txt", xy: ".M", kind: "1" },
      { path: "new.txt", orig: "old.txt", xy: "R.", kind: "2" },
      { path: "conflicted.txt", xy: "UU", kind: "u" },
      { path: "untracked.txt", xy: "?", kind: "?" },
    ]);
  });

  it("keeps paths containing spaces, CR, LF, TAB and leading spaces verbatim", () => {
    const stdout =
      [
        `1 .M N... 100644 100644 100644 ${OID} ${OID} a b c.txt`,
        "? with\ttab",
        "? with\ncr\r\n",
        `u UU N... 1 2 3 w ${OID} ${OID} ${OID} sp ace`,
        `1 .M N... 100644 100644 100644 ${OID} ${OID}  lead-space`,
      ].join("\0") + "\0";
    const parsed = parseStatusV2Z(stdout, false);
    expect(parsed.entries.map((e) => e.path)).toEqual([
      "a b c.txt",
      "with\ttab",
      "with\ncr\r\n",
      "sp ace",
      " lead-space",
    ]);
  });

  it("accepts (initial) and absent branch.oid", () => {
    expect(parseStatusV2Z("# branch.oid (initial)\0# branch.head main\0", false).oid).toBe("(initial)");
    expect(parseStatusV2Z("? x\0", false).oid).toBeUndefined();
  });

  it("drops the trailing partial record when capped", () => {
    const full = [`1 .M N... 100644 100644 100644 ${OID} ${OID} a.txt`, "? b.txt"].join("\0") + "\0";
    const cut = full.slice(0, -3); // cut inside the second record
    expect(parseStatusV2Z(cut, true).entries.map((e) => e.path)).toEqual(["a.txt"]);
    // cap landing exactly on a NUL: the lost trailing "" is harmless
    expect(parseStatusV2Z(full, true).entries.map((e) => e.path)).toEqual(["a.txt", "b.txt"]);
  });

  it("drops a 2 record whose orig field was cut off by the cap", () => {
    const stdout = `2 R. N... 100644 100644 100644 ${OID} ${OID} R100 new.txt\0old`;
    const parsed = parseStatusV2Z(stdout, true);
    expect(parsed.entries).toEqual([]);
  });

  it("drops a defensive ? record ending with /", () => {
    const parsed = parseStatusV2Z("? dir/\0? file\0", false);
    expect(parsed.entries.map((e) => e.path)).toEqual(["file"]);
  });

  it("ignores unknown record kinds and malformed records", () => {
    const parsed = parseStatusV2Z(["3 XY whatever", "1 .M", `u UU short`].join("\0") + "\0", false);
    expect(parsed.entries).toEqual([]);
  });
});

describe("parseNumstatZ", () => {
  it("parses plain, binary and rename entries (real -z byte shapes)", () => {
    const stdout = [`12\t3\tplain.txt`, `-\t-\tbinary.bin`, `0\t0\t`, "OLDFILE.txt", "NEWFILE.txt"].join("\0") + "\0";
    expect(parseNumstatZ(stdout, false)).toEqual([
      { path: "plain.txt", add: 12, del: 3 },
      { path: "binary.bin", add: null, del: null },
      { path: "NEWFILE.txt", orig: "OLDFILE.txt", add: 0, del: 0 },
    ]);
  });

  it("drops the trailing partial entry when capped, including a rename cut mid-orig", () => {
    expect(parseNumstatZ("1\t2\tplain.txt\0-\t-\tbin", true)).toEqual([{ path: "plain.txt", add: 1, del: 2 }]);
    expect(parseNumstatZ("0\t0\t\0OLD", true)).toEqual([]);
    expect(parseNumstatZ("0\t0\t\0OLD\0NE", true)).toEqual([]);
  });

  it("keeps paths with spaces, tabs and newlines", () => {
    expect(parseNumstatZ("1\t2\ta b\tc.txt\0", false)).toEqual([{ path: "a b\tc.txt", add: 1, del: 2 }]);
  });
});

describe("combinedStatus", () => {
  it("maps the full truth table", () => {
    const cases: Array<[StatusV2ZEntry, string | null]> = [
      [statusEntry({ path: "u", xy: "?", kind: "?" }), "?"],
      [statusEntry({ path: "u", xy: "UU", kind: "u" }), "U"],
      [statusEntry({ path: "r", orig: "o", xy: "R.", kind: "2" }), "R"],
      [statusEntry({ path: "c", orig: "o", xy: "C.", kind: "2" }), "C"],
      [statusEntry({ path: "x", xy: "A.", kind: "1" }), "A"],
      [statusEntry({ path: "x", xy: "AD", kind: "1" }), null],
      [statusEntry({ path: "x", xy: ".D", kind: "1" }), "D"],
      [statusEntry({ path: "x", xy: "D.", kind: "1" }), "D"],
      [statusEntry({ path: "x", xy: "T.", kind: "1" }), "T"],
      [statusEntry({ path: "x", xy: ".T", kind: "1" }), "T"],
      [statusEntry({ path: "x", xy: ".M", kind: "1" }), "M"],
      [statusEntry({ path: "x", xy: "MM", kind: "1" }), "M"],
    ];
    for (const [entry, expected] of cases) expect(combinedStatus(entry), JSON.stringify(entry)).toBe(expected);
  });

  it("falls back to the 1-ladder for a non-R/C 2 record and rejects bad xy", () => {
    expect(combinedStatus(statusEntry({ path: "x", orig: "o", xy: "A.", kind: "2" }))).toBe("A");
    expect(combinedStatus(statusEntry({ path: "x", xy: ".M", kind: "?" }))).toBe("?");
    expect(combinedStatus(statusEntry({ path: "x", xy: "M", kind: "1" }))).toBeNull();
  });
});

describe("parseHeadProbe", () => {
  it("parses sha1 and sha256 two-line output", () => {
    expect(parseHeadProbe(`sha1\n${OID}\n`)).toEqual({ format: "sha1", oid: OID });
    const oid256 = "f2af861a0299dc74b3467c1f5ccc501562894cf93baa2676e17eb54f20ecbd91";
    expect(parseHeadProbe(`sha256\n${oid256}`)).toEqual({ format: "sha256", oid: oid256 });
  });

  it("rejects mismatched lengths, garbage and stderr-style output", () => {
    expect(parseHeadProbe(`sha1\n${"a".repeat(64)}\n`)).toBeNull();
    expect(parseHeadProbe(`sha256\n${OID}\n`)).toBeNull();
    expect(parseHeadProbe("sha1\nHEAD\n")).toBeNull(); // unborn: rev-parse echoes the arg
    expect(parseHeadProbe("")).toBeNull();
    expect(parseHeadProbe("sha3\nabcdef\n")).toBeNull();
  });
});

describe("parseDriverScan", () => {
  it("extracts filter and diff driver names (key\\nvalue\\0 records), deduped and sorted", () => {
    const stdout =
      [
        "filter.myflt.clean\necho hi",
        "filter.lfs.smudge\necho lfs",
        "diff.myconv.textconv\ncat",
        "filter.lfs.clean\ndup",
      ].join("\0") + "\0";
    expect(parseDriverScan(stdout, false)).toEqual({ names: ["lfs", "myconv", "myflt"] });
  });

  it("keeps dotted subsection names (filter.a.b.required → a.b)", () => {
    expect(parseDriverScan("filter.a.b.required\ntrue\0", false)).toEqual({ names: ["a.b"] });
  });

  it("ignores non-driver keys", () => {
    expect(parseDriverScan("core.autocrlf\ntrue\0filter.x.clean\nx\0", false)).toEqual({ names: ["x"] });
  });

  it("returns unsafe for a name with =, whitespace, leading dot or >64 chars; empty subsections are non-matches", () => {
    expect(parseDriverScan("filter.a=b.clean\nx\0", false)).toEqual({ unsafe: true }); // [filter "a=b"]
    expect(parseDriverScan("filter. .clean\nx\0", false)).toEqual({ unsafe: true });
    expect(parseDriverScan("filter..clean\nx\0", false)).toEqual({ names: [] }); // no (.)+ subsection — not a driver key
    expect(parseDriverScan(`filter.${"a".repeat(65)}.clean\nx\0`, false)).toEqual({ unsafe: true });
    expect(parseDriverScan("filter.-lead.clean\nx\0", false)).toEqual({ unsafe: true });
  });

  it(`returns unsafe above ${WTDIFF_DRIVER_SCAN_MAX} names and on capped output`, () => {
    const many =
      Array.from({ length: WTDIFF_DRIVER_SCAN_MAX + 1 }, (_, i) => `filter.d${i}.clean\nx`).join("\0") + "\0";
    expect(parseDriverScan(many, false)).toEqual({ unsafe: true });
    const exactly = Array.from({ length: WTDIFF_DRIVER_SCAN_MAX }, (_, i) => `filter.d${i}.clean\nx`).join("\0") + "\0";
    expect(parseDriverScan(exactly, false).unsafe).toBeUndefined();
    expect(parseDriverScan("filter.x.clean\nx", true)).toEqual({ unsafe: true });
  });

  it("empty output (git exit 1 = no match) parses to no names", () => {
    expect(parseDriverScan("", false)).toEqual({ names: [] });
  });
});

describe("driverNamesFromAttributes", () => {
  it("extracts from plain lines, macro definitions and negated/unset attrs, deduped", () => {
    const text = [
      "*.txt filter=p",
      "*.png diff=img",
      "[attr]m filter=r",
      "*.md m",
      "*.log -filter=s",
      "*.tmp !filter=t",
      "\tfilter=p\t",
    ].join("\n");
    expect(driverNamesFromAttributes(text)).toEqual({ names: ["img", "p", "r", "s", "t"] });
  });

  it("matches case-insensitively on the attribute word but keeps driver-name case", () => {
    expect(driverNamesFromAttributes("*.txt FILTER=Lfs\n")).toEqual({ names: ["Lfs"] });
  });

  it("returns unsafe on filter=a=b style names; blank values bind nothing", () => {
    expect(driverNamesFromAttributes("*.txt filter=a=b\n")).toEqual({ unsafe: true });
    expect(driverNamesFromAttributes("*.txt filter= x\n")).toEqual({ names: [] }); // `filter=` with a blank value matches no driver binding
  });

  it("empty text yields no names", () => {
    expect(driverNamesFromAttributes("*.txt text=auto\n# comment\n")).toEqual({ names: [] });
  });
});

describe("neutralizeArgs", () => {
  it("blanks all six command slots for every name, including unconfigured ones", () => {
    expect(neutralizeArgs(["lfs"])).toEqual([
      "-c",
      "filter.lfs.clean=",
      "-c",
      "filter.lfs.smudge=",
      "-c",
      "filter.lfs.process=",
      "-c",
      "filter.lfs.required=false",
      "-c",
      "diff.lfs.textconv=",
      "-c",
      "diff.lfs.command=",
    ]);
    expect(neutralizeArgs(["a", "b"])).toEqual([...neutralizeArgs(["a"]), ...neutralizeArgs(["b"])]);
    expect(neutralizeArgs([])).toEqual([]);
  });

  it("skips names failing WTDIFF_DRIVER_NAME_RE (callers validate first)", () => {
    expect(neutralizeArgs(["a=b", "ok"])).toEqual(neutralizeArgs(["ok"]));
    expect(WTDIFF_DRIVER_NAME_RE.test("lfs")).toBe(true);
    expect(WTDIFF_DRIVER_NAME_RE.test("a=b")).toBe(false);
  });
});

describe("attrSourceArgs", () => {
  it("uses the empty tree per object format plus /dev/null attributes file", () => {
    expect(attrSourceArgs("sha1")).toEqual([
      `--attr-source=${WTDIFF_EMPTY_TREE.sha1}`,
      "-c",
      "core.attributesFile=/dev/null",
    ]);
    expect(attrSourceArgs("sha256")).toEqual([
      `--attr-source=${WTDIFF_EMPTY_TREE.sha256}`,
      "-c",
      "core.attributesFile=/dev/null",
    ]);
  });
});

describe("parseCheckAttrZ", () => {
  it("maps path → filter value from path\\0attr\\0value\\0 triples", () => {
    expect(parseCheckAttrZ("a.txt\0filter\0unspecified\0b.txt\0filter\0lfs\0")).toEqual(
      new Map([
        ["a.txt", "unspecified"],
        ["b.txt", "lfs"],
      ]),
    );
  });

  it("skips a truncated trailing triple and non-filter attributes", () => {
    expect(parseCheckAttrZ("a.txt\0filter\0unset\0partial\0filter")).toEqual(new Map([["a.txt", "unset"]]));
    expect(parseCheckAttrZ("a.txt\0diff\0set\0")).toEqual(new Map());
  });
});

describe("wtDiffArgs byte-exact snapshots", () => {
  const l1 = attrSourceArgs("sha1");
  const n = neutralizeArgs(["lfs"]);
  const B = ["--literal-pathspecs", "-c", "core.hooksPath=/dev/null", "-c", "core.quotePath=true"];
  const X = ["-c", "core.bigFileThreshold=16m", "-c", "diff.suppressBlankEmpty=false"];
  const P = [...WT_PINNED_PREFIX];

  it("commonDir / worktreeList (unpinned, admission phase)", () => {
    expect(wtDiffArgs.commonDir("/repo")).toEqual([
      "-C",
      "/repo",
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    expect(wtDiffArgs.worktreeList("/repo")).toEqual(["-C", "/repo", "worktree", "list", "--porcelain"]);
  });

  it("head / driverScan", () => {
    expect(wtDiffArgs.head()).toEqual([...P, ...B, "rev-parse", "--show-object-format", "HEAD"]);
    expect(wtDiffArgs.driverScan()).toEqual([
      ...P,
      ...B,
      "config",
      "--null",
      "--get-regexp",
      "^(filter|diff)\\..+\\.(clean|smudge|process|required|textconv|command)$",
    ]);
  });

  it("status", () => {
    expect(wtDiffArgs.status(l1, n, "all")).toEqual([
      ...P,
      ...B,
      ...l1,
      ...X,
      ...n,
      "-c",
      "status.renames=true",
      "status",
      "--porcelain=v2",
      "-z",
      "--branch",
      "--untracked-files=all",
      "--ignore-submodules=all",
    ]);
    expect(wtDiffArgs.status(l1, [], "no")).toContain("--untracked-files=no");
  });

  it("numstat puts the oid in the explicit-rev slot", () => {
    expect(wtDiffArgs.numstat(l1, n, OID)).toEqual([
      ...P,
      ...B,
      ...l1,
      ...X,
      ...n,
      "diff-index",
      "--numstat",
      "-z",
      "-M",
      "--no-textconv",
      "--no-ext-diff",
      "--ignore-submodules=all",
      OID,
    ]);
  });

  it("diff places request-derived paths strictly after --", () => {
    expect(wtDiffArgs.diff(l1, n, OID, "plain.txt")).toEqual([
      ...P,
      ...B,
      ...l1,
      ...X,
      ...n,
      "diff-index",
      "-p",
      "-M",
      "--unified=3",
      "--no-color",
      "--no-textconv",
      "--no-ext-diff",
      "--ignore-submodules=all",
      OID,
      "--",
      "plain.txt",
    ]);
    const rename = wtDiffArgs.diff(l1, n, OID, "new.txt", "old.txt");
    expect(rename.slice(-3)).toEqual(["--", "old.txt", "new.txt"]);
    // A path that looks like an option stays a pathspec: it only ever appears after "--".
    const hostile = wtDiffArgs.diff(l1, n, OID, "--output=/tmp/x");
    expect(hostile[hostile.length - 1]).toBe("--output=/tmp/x");
    expect(hostile.indexOf("--output=/tmp/x")).toBeGreaterThan(hostile.indexOf("--"));
  });

  it("checkAttr batches ≤200 paths, ≤128 KiB argv, ≤5 batches", () => {
    const single = wtDiffArgs.checkAttr(OID, ["a.txt"]);
    expect(single).toEqual([[...P, ...B, "check-attr", "-z", `--source=${OID}`, "filter", "--", "a.txt"]]);
    // 450 paths → 3 batches of 200/200/50; per-batch argv length derives from the single-path batch
    const many = wtDiffArgs.checkAttr(
      OID,
      Array.from({ length: 450 }, (_, i) => `f${i}.txt`),
    );
    expect(many).toHaveLength(3);
    const singleBaseLen = wtDiffArgs.checkAttr(OID, ["z"])[0]!.length;
    expect(many[0]).toHaveLength(singleBaseLen + 199);
    expect(many[0]!.slice(-1)).toEqual(["f199.txt"]);
    expect(many[1]!.slice(-1)).toEqual(["f399.txt"]);
    expect(many[2]!.slice(-2)).toEqual(["f448.txt", "f449.txt"]);
    // 1200 paths → capped at 5 batches (250 uncovered; the caller marks them filtered)
    const capped = wtDiffArgs.checkAttr(
      OID,
      Array.from({ length: 1200 }, (_, i) => `f${i}.txt`),
    );
    expect(capped).toHaveLength(5);
    const covered = new Set(capped.flatMap((argv) => argv.slice(argv.indexOf("--") + 1)));
    expect(covered.size).toBe(1000);
    // byte budget: long paths split before 128 KiB
    const long = Array.from({ length: 400 }, () => "x".repeat(3000));
    const byteBatches = wtDiffArgs.checkAttr(OID, long);
    expect(byteBatches).toHaveLength(5);
    for (const argv of byteBatches) {
      const bytes = argv.reduce((total, a) => total + Buffer.byteLength(a, "utf8"), 0);
      expect(bytes).toBeLessThanOrEqual(128 * 1024);
    }
  });
});
