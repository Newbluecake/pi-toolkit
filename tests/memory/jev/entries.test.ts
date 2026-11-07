// J1 (jev-plan §4 J1 / arch §4.1–§4.2): entry splitting rules 1–5, the two
// hashes, inline authority parsing (incl. a ≥500-case seeded property run),
// default authority, expiry predicates and the EntryIndex fingerprint cache.

import { describe, expect, it } from "vitest";
import {
  EntryIndex,
  type EntryIndexFs,
  type EntryIndexStat,
  expiredEntries,
  entryHash,
  normalizeBody,
  parseInlineMeta,
  splitEntries,
  stripInlineMeta,
  untilEntries,
} from "../../../src/memory/jev/entries.js";

const HAND = { status: "active" as const, handWritten: true };
const AGENT = { status: "active" as const, handWritten: false };

function split(raw: string, info = HAND) {
  return splitEntries("core.md", raw, info);
}

describe("rule 3 — list items and continuation lines", () => {
  it("one item per column-0 bullet, indented lines and inner blanks continue", () => {
    const raw = [
      "# Title",
      "",
      "## 发版",
      "",
      "- first item",
      "  continued line",
      "",
      "  after blank still first",
      "- second item",
    ].join("\n");
    const entries = split(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.body).toContain("first item");
    expect(entries[0]!.body).toContain("after blank still first");
    expect(entries[0]!.body).not.toContain("second item");
    expect(entries[1]!.body).toContain("second item");
    expect(entries[0]!.lineStart).toBe(5);
    expect(entries[0]!.lineEnd).toBe(8);
    expect(entries[1]!.lineStart).toBe(9);
  });

  it("supports *, + and numbered markers; nested indented lists are continuation", () => {
    const raw = "* a\n+ b\n3. c\n  - nested";
    const entries = split(raw);
    expect(entries).toHaveLength(3);
    expect(entries[2]!.body).toContain("nested");
  });

  it("a fenced block under an item is its continuation; a stray fence alone is not an entry", () => {
    const raw = "- item\n```\nnot a list item\n## not a heading\n```\n- next";
    const entries = split(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.body).toContain("not a list item");
    expect(entries[0]!.body).toContain("## not a heading");
  });

  it("a non-indented ordinary paragraph ends the entry", () => {
    const raw = "- item\nplain paragraph text follows immediately";
    const entries = split(raw);
    expect(entries).toHaveLength(2);
    expect(entries[1]!.body).toContain("plain paragraph");
  });

  it("a col-0 table/quote/HTML start ends the open list entry", () => {
    const raw = "- item\n| a | b |\n| - | - |\n> quoted";
    const entries = split(raw);
    expect(entries.map((e) => e.body.split("\n")[0])).toEqual(["- item", "| a | b |", "> quoted"]);
  });

  it("an indented table inside a list is continuation (rule 3)", () => {
    const raw = "- item\n  | x | y |\n  | - | - |";
    const entries = split(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.body).toContain("| x | y |");
  });
});

describe("rule 2 — headings, section and heading labels", () => {
  it("`### ` is appended as A › B; section records the `## ` title", () => {
    const raw = "## A\n- one\n### B\n- two\n";
    const entries = split(raw);
    expect(entries[0]!.section).toBe("A");
    expect(entries[0]!.heading).toBe("A");
    expect(entries[1]!.section).toBe("A");
    expect(entries[1]!.heading).toBe("A › B");
  });

  it('file head before any ## has section "" and undefined heading', () => {
    const raw = "- head item\n## S\n- section item";
    const entries = split(raw);
    expect(entries[0]!.section).toBe("");
    expect(entries[0]!.heading).toBeUndefined();
    expect(entries[1]!.section).toBe("S");
  });

  it("`# ` H1 is the file title, never an entry", () => {
    const entries = split("# Just a title\n");
    expect(entries).toHaveLength(0);
  });

  it("H1 after sections closes the region; following content is a fresh head region", () => {
    const raw = "## S\n- a\n# Trailing\n- b";
    const entries = split(raw);
    expect(entries).toHaveLength(2);
    expect(entries[1]!.section).toBe("");
  });
});

describe("rule 4 — list-less section is one entry", () => {
  it("whole body becomes one entry (heading excluded, tables included)", () => {
    const raw = "## 发版进行中禁止动 git 状态\n\nrelease.sh 运行期间禁止 commit/tag/切分支。\n\n| a | b |\n| - | - |\n";
    const entries = split(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.section).toBe("发版进行中禁止动 git 状态");
    expect(entries[0]!.heading).toBe("发版进行中禁止动 git 状态");
    expect(entries[0]!.body).toContain("release.sh");
    expect(entries[0]!.body).toContain("| a | b |");
    expect(entries[0]!.body).not.toContain("## ");
    expect(entries[0]!.lineStart).toBe(3);
  });

  it("a paragraph-only file head is one entry", () => {
    const entries = split("just one paragraph with no lists at all\nsecond line\n");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.section).toBe("");
  });
});

describe("rule 5 — block-level structures outside lists", () => {
  it("a col-0 GFM table is ONE entry (region containing a list)", () => {
    const raw = "- intro item\n\n| h1 | h2 |\n| -- | -- |\n| a | b |\n| c | d |\n";
    const entries = split(raw);
    expect(entries).toHaveLength(2);
    expect(entries[1]!.body.split("\n")).toHaveLength(4);
    expect(entries[1]!.lineStart).toBe(3);
  });

  it("a col-0 quote block is one entry", () => {
    const raw = "> line1\n> line2\n\nnot a quote";
    const entries = split(raw);
    expect(entries.filter((e) => e.body.startsWith(">"))).toHaveLength(1);
  });

  it("an HTML block runs from the <tag line to the next blank line", () => {
    const long = "after the blank line this prose paragraph is long enough to stand alone";
    const raw = `- item\n\n<div>\nspan text still html\n</div>\n\n${long}`;
    const entries = split(raw);
    const html = entries.find((e) => e.body.startsWith("<div>"))!;
    expect(html.body).toContain("</div>");
    expect(html.body).not.toContain("after the blank");
    expect(entries.at(-1)!.body).toBe(long);
  });

  it("a ≥40-code-point paragraph is its own entry; a short one merges into the NEXT entry", () => {
    const long = "这一段足够长，超过四十个码点，应该独立成为一个条目，绝不应该并入任何相邻的条目里去。";
    expect(Array.from(long).length).toBeGreaterThanOrEqual(40);
    const raw = `shorty\n\n- item one\n\n${long}\n`;
    const entries = split(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.body).toContain("shorty");
    expect(entries[0]!.body).toContain("item one");
    expect(entries[1]!.body).toBe(long);
  });

  it("a trailing short paragraph with no next entry merges into the PREVIOUS one (J1 default)", () => {
    const raw = "- item one\n- item two\n\ntail";
    const entries = split(raw);
    expect(entries).toHaveLength(2);
    expect(entries[1]!.body).toContain("item two");
    expect(entries[1]!.body).toContain("tail");
  });
});

describe("frontmatter / drift banner", () => {
  it("entries start after the frontmatter; line numbers stay raw-file-true", () => {
    const raw = "---\ntopic: t\n---\n\n- item\n";
    const entries = split(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.lineStart).toBe(5);
    expect(entries[0]!.lineEnd).toBe(5);
  });
  it("a leading drift banner is skipped too", () => {
    const raw = "> **pi copy** x\n\n---\nstatus: active\n---\n- item\n";
    const entries = split(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.lineStart).toBe(6);
  });
});

describe("hashes", () => {
  const base = "- rule text here <!-- mem user -->";
  it("hash covers body only — editing the inline comment keeps the sidecar hash", () => {
    const a = split(base)[0]!;
    const b = split("- rule text here <!-- mem user gate -->")[0]!;
    const c = split("- rule text here")[0]!;
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toBe(c.hash);
  });

  it("guardHash covers raw — editing the user marker changes it", () => {
    const a = split(base)[0]!;
    const b = split("- rule text here <!-- mem lesson -->")[0]!;
    const c = split("- rule text here")[0]!;
    expect(a.guardHash).not.toBe(b.guardHash);
    expect(a.guardHash).not.toBe(c.guardHash);
  });

  it("a body edit changes both hashes", () => {
    const a = split(base)[0]!;
    const b = split("- rule text here! <!-- mem user -->")[0]!;
    expect(a.hash).not.toBe(b.hash);
    expect(a.guardHash).not.toBe(b.guardHash);
  });

  it("normalizeBody: trailing whitespace, CRLF and blank runs collapse; leading/trailing blanks trim", () => {
    expect(normalizeBody("a  \nb\r\n\r\n\r\nc\n\n")).toBe("a\nb\n\nc");
    expect(entryHash("a\nb")).toBe(entryHash("a \nb"));
  });
});

describe("inline authority comment (§4.2)", () => {
  it("sits at the end of the entry's first line (list item)", () => {
    const e = split("- 发版前确认 CI 绿 <!-- mem user expires=2026-10-21 -->")[0]!;
    expect(e.inline.present).toBe(true);
    expect(e.inline.authority).toBe("user");
    expect(e.inline.expires).toBe("2026-10-21");
    expect(e.inlineErrors).toEqual([]);
    expect(e.authority).toBe("user");
  });

  it("for whole-section entries it sits on the first non-empty line under the heading", () => {
    const raw = "## S\n\n<!-- mem user gate=hold tags=+release,+git-commit -->\n\nbody line\n";
    const e = split(raw)[0]!;
    expect(e.inline.present).toBe(true);
    expect(e.inline.gate).toBe("hold");
    expect(e.inline.tagsAdd).toEqual(["release", "git-commit"]);
    expect(e.body).not.toContain("mem user");
  });

  it("default authority: hand-written ⇒ user, agent file ⇒ agent, inline overrides", () => {
    expect(split("- x")[0]!.authority).toBe("user");
    expect(split("- x", AGENT)[0]!.authority).toBe("agent");
    expect(split("- x <!-- mem user -->", AGENT)[0]!.authority).toBe("user");
    expect(split("- x <!-- mem lesson -->")[0]!.authority).toBe("agent");
  });

  it("private / nogate / until parse", () => {
    const { meta, errors } = parseInlineMeta('x <!-- mem private nogate until="发版结束" -->');
    expect(errors).toEqual([]);
    expect(meta.isPrivate).toBe(true);
    expect(meta.gate).toBe("nogate");
    expect(meta.until).toBe("发版结束");
  });

  it("unknown key, duplicate key, bad expires and >200B all land in errors (never thrown)", () => {
    expect(parseInlineMeta("x <!-- mem bogus=1 -->").errors[0]).toContain("unknown key");
    expect(parseInlineMeta("x <!-- mem user user -->").errors[0]).toContain("duplicate key");
    expect(parseInlineMeta("x <!-- mem expires=2026-13-40 -->").errors[0]).toContain("not a valid");
    const long = `<!-- mem user ${"a".repeat(200)} -->`;
    expect(parseInlineMeta(long).errors).toContainEqual(expect.stringContaining("exceeds 200B"));
    expect(parseInlineMeta("x <!-- mem gate=always -->").errors[0]).toContain("not a valid value");
    expect(parseInlineMeta("x <!-- mem tags=+Bad_Id,-ok -->").errors[0]).toContain("invalid tag item");
    expect(parseInlineMeta("x <!-- mem user expires").errors).toEqual(["unterminated inline comment (missing -->)"]);
    expect(parseInlineMeta("x <!-- mem a --> <!-- mem b -->").errors[0]).toContain("multiple inline comments");
    expect(parseInlineMeta("plain line").meta.present).toBe(false);
  });

  it("stripInlineMeta is idempotent and removes every comment", () => {
    const text = "- a <!-- mem user -->\n<!-- mem private -->\n- b";
    const once = stripInlineMeta(text);
    expect(once).toBe(stripInlineMeta(once));
    expect(once).not.toContain("mem");
  });

  it("seeded property run: 600 random-ish inputs never throw and stay total", () => {
    let seed = 0x2f6e2b1;
    const rand = (): number => {
      // LCG (numerical recipes) — deterministic across runs/machines.
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const alphabet = [..."abcXYZ019 \t=-+,\"'<>!/-_memuserlessonexpiresuntilgatenogprivatags"];
    for (let i = 0; i < 600; i++) {
      const len = 1 + Math.floor(rand() * 60);
      let s = "";
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(rand() * alphabet.length)]!;
      const { meta, errors } = parseInlineMeta(s);
      expect(Array.isArray(errors)).toBe(true);
      expect(typeof meta.present).toBe("boolean");
      const { meta: m2 } = parseInlineMeta(`x <!-- mem ${s} -->`);
      expect(m2.present).toBe(true);
    }
  });
});

describe("expiry predicates (§6.3.5)", () => {
  const raw = [
    "- a <!-- mem user expires=2026-10-20 -->", // 1: expired (day before)
    "- b <!-- mem user expires=2026-10-30 -->", // 2: same day — valid
    "- c <!-- mem user expires=2026-10-31 -->", // 3: later — valid
    "- d <!-- mem expires=2026-13-40 -->", // 4: invalid date — never expires
    '- e <!-- mem until="release done" -->', // 5: until only
    '- f <!-- mem until="x" expires=2026-10-01 -->', // 6: both ⇒ dated path
    "- g <!-- mem user -->", // 7: nothing
  ].join("\n");
  const entries = split(raw);
  const body = (e: { body: string }) => e.body[2]!;
  it("expiredEntries: strictly earlier only; same day valid; invalid date never expires", () => {
    expect(expiredEntries(entries, "2026-10-30").map(body)).toEqual(["a", "f"]);
  });
  it("untilEntries: until without expires only", () => {
    expect(untilEntries(entries).map(body)).toEqual(["e"]);
  });
});

describe("derived entry fields", () => {
  it("secret: body hitting the loose kv rule marks the entry", () => {
    const e = split("- export TOKEN=ghs_9f8e7d6c5b4a39281706 before push")[0]!;
    expect(e.secret).toBe(true);
    const clean = split("- export http_proxy=http://127.0.0.1:7890 first")[0]!;
    expect(clean.secret).toBe(false);
  });

  it("namedPrograms: scripts named in backticks or by suffix; generic programs dropped", () => {
    const e = split("- run `release.sh --dry-run` after `gh release create`; see run.sh and deploy.py")[0]!;
    expect(e.namedPrograms).toEqual(["release.sh", "run.sh", "deploy.py"]);
  });

  it("stale files carry fileStatus stale", () => {
    const e = splitEntries("a.md", "- x", { status: "stale", handWritten: true })[0]!;
    expect(e.fileStatus).toBe("stale");
  });
});

describe("EntryIndex fingerprint cache", () => {
  function fakeFs(files: Record<string, string>): EntryIndexFs & {
    reads: Record<string, number>;
    setStat(name: string, stat: Partial<EntryIndexStat>): void;
    drop(name: string): void;
  } {
    const stats = new Map<string, EntryIndexStat>();
    const reads: Record<string, number> = {};
    for (const [name, content] of Object.entries(files)) {
      stats.set(name, { name, size: Buffer.byteLength(content), mtimeMs: 1 });
    }
    return {
      reads,
      list: (dir) =>
        [...stats.values()]
          .filter((s) => s.name.endsWith(".md"))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      read: (dir, name) => {
        if (stats.has(name) && files[name] !== undefined) {
          reads[name] = (reads[name] ?? 0) + 1;
          return files[name];
        }
        return undefined;
      },
      setStat: (name, stat) => {
        const prev = stats.get(name);
        stats.set(name, { name, size: stat.size ?? prev?.size ?? 0, mtimeMs: stat.mtimeMs ?? prev?.mtimeMs ?? 0 });
      },
      drop: (name) => {
        stats.delete(name);
      },
    };
  }

  it("unchanged fingerprint ⇒ no re-read; result cached", () => {
    const fs = fakeFs({ "a.md": "## S\n- one\n", "b.md": "## T\n- two\n" });
    const index = new EntryIndex(fs);
    const first = index.get("/mem");
    expect(first.map((e) => e.file)).toEqual(["a.md", "b.md"]);
    expect(fs.reads["a.md"]).toBe(1);
    const second = index.get("/mem");
    expect(second).toBe(first);
    expect(fs.reads["a.md"]).toBe(1);
  });

  it("single file change ⇒ only that file re-split", () => {
    const fs = fakeFs({ "a.md": "## S\n- one\n", "b.md": "## T\n- two\n" });
    const index = new EntryIndex(fs);
    index.get("/mem");
    fs.setStat("b.md", { mtimeMs: 2 });
    const second = index.get("/mem");
    expect(fs.reads["a.md"]).toBe(1);
    expect(fs.reads["b.md"]).toBe(2);
    expect(second.map((e) => e.file)).toEqual(["a.md", "b.md"]);
  });

  it("secret/namedPrograms recompute when the file changes", () => {
    const files: Record<string, string> = { "a.md": "- run `release.sh`\n" };
    const fs = fakeFs(files);
    const index = new EntryIndex(fs);
    expect(index.get("/mem")[0]!.namedPrograms).toEqual(["release.sh"]);
    files["a.md"] = "- export TOKEN=ghs_9f8e7d6c5b4a39281706 before push\n";
    fs.setStat("a.md", { mtimeMs: 5, size: Buffer.byteLength(files["a.md"]!) });
    const entry = index.get("/mem")[0]!;
    expect(entry.namedPrograms).toEqual([]);
    expect(entry.secret).toBe(true);
  });

  it("archived files produce no entries; agent source ⇒ default authority agent", () => {
    const fs = fakeFs({
      "a.md": "---\nstatus: archived\n---\n- archived item\n",
      "b.md": "---\nsource: agent\n---\n- agent item\n",
    });
    const index = new EntryIndex(fs);
    const entries = index.get("/mem");
    expect(entries.map((e) => e.file)).toEqual(["b.md"]);
    expect(entries[0]!.authority).toBe("agent");
  });

  it("invalidate(dir) and invalidate() force a re-read", () => {
    const fs = fakeFs({ "a.md": "- x\n" });
    const index = new EntryIndex(fs);
    index.get("/mem");
    index.invalidate("/mem");
    index.get("/mem");
    expect(fs.reads["a.md"]).toBe(2);
    index.invalidate();
    index.get("/mem");
    expect(fs.reads["a.md"]).toBe(3);
  });

  it("removed files drop out", () => {
    const fs = fakeFs({ "a.md": "- x\n", "b.md": "- y\n" });
    const index = new EntryIndex(fs);
    expect(index.get("/mem")).toHaveLength(2);
    fs.drop("a.md");
    expect(index.get("/mem").map((e) => e.file)).toEqual(["b.md"]);
  });
});

describe("ordinals", () => {
  it("restart per ## region; whole-section entries get ordinal 1", () => {
    const raw = "## A\n- one\n- two\n\n## B\n\nwhole section body\n";
    const entries = split(raw);
    expect(entries.map((e) => [e.section, e.ordinal])).toEqual([
      ["A", 1],
      ["A", 2],
      ["B", 1],
    ]);
  });
});

// ───────────────────────────── blocks branch (#36 P3, arch §3.2.5) ─────────────────────────────

describe("EntryIndex blocks branch (#36 P3)", () => {
  const BLOCK = (id: string, meta: readonly string[], body: string): string =>
    [
      "---",
      "kind: block",
      ...meta,
      'created: "2026-01-01T00:00:00.000Z"',
      'updated: "2026-01-02T00:00:00.000Z"',
      "version: 1",
      "---",
      "",
      body,
      "",
    ].join("\n");

  function blocksFs(files: Record<string, string>): EntryIndexFs & { reads: Record<string, number> } {
    const reads: Record<string, number> = {};
    const stats = Object.fromEntries(
      Object.entries(files).map(([name, text]) => [name, { name, size: text.length, mtimeMs: 1 }]),
    );
    let layout = true;
    return {
      reads,
      list: () => [],
      read: () => undefined,
      blockLayout: () => layout,
      listBlocks: () => Object.values(stats).sort((a, b) => (a.name < b.name ? -1 : 1)),
      readBlock: (_dir, name) => {
        reads[name] = (reads[name] ?? 0) + 1;
        return files[name];
      },
    } as never;
  }

  it("one MemEntry per block file; heading from frontmatter; fileStatus active", () => {
    const fs = blocksFs({
      "general.001.md": BLOCK(
        "general.001",
        ["authority: user", "scope: global", "section: 核心规则", "heading: 验收 › 模型选择"],
        "- always ask first",
      ),
      "quota.001.md": BLOCK("quota.001", ["authority: agent"], "- quota note"),
      "NOTABLOCK.md": "plain text file",
    });
    const entries = new EntryIndex(fs).get("/mem");
    expect(entries.map((e) => e.file)).toEqual(["general.001.md", "quota.001.md"]); // stray drops out
    const g = entries[0]!;
    expect(g.heading).toBe("验收 › 模型选择");
    expect(g.section).toBe("核心规则");
    expect(g.block).toMatchObject({ id: "general.001", scope: "global", status: "active" });
    expect(g.fileStatus).toBe("active");
    expect(g.authority).toBe("user");
    expect(g.inline.scope).toBe("global");
  });

  it("fingerprint caching: unchanged files are never re-read; a changed file is", () => {
    // ONE mutable seam: same counters, stats can be rewritten in place.
    let body = "- v1";
    const reads: Record<string, number> = {};
    const stat = { name: "quota.001.md", size: Buffer.byteLength(body), mtimeMs: 1 };
    const fs: EntryIndexFs = {
      list: () => [],
      read: () => undefined,
      blockLayout: () => true,
      listBlocks: () => [{ ...stat }],
      readBlock: (_dir, name) => {
        reads[name] = (reads[name] ?? 0) + 1;
        return BLOCK("quota.001", [], body);
      },
    };
    const index = new EntryIndex(fs);
    const first = index.get("/mem");
    expect(first.map((e) => e.body)).toEqual(["- v1"]);
    index.get("/mem");
    expect(reads["quota.001.md"]).toBe(1); // unchanged stat ⇒ no re-read
    // rewrite the file: size changes ⇒ the fingerprint flips ⇒ re-read
    body = "- v1 rewritten longer body";
    stat.size = Buffer.byteLength(body);
    const second = index.get("/mem");
    expect(reads["quota.001.md"]).toBe(2);
    expect(second.map((e) => e.body)).toEqual(["- v1 rewritten longer body"]); // content really updated
  });

  it("no blockLayout seam ⇒ the files branch is untouched (pre-#36 seams stay compatible)", () => {
    let reads = 0;
    const fs: EntryIndexFs = {
      list: () => [{ name: "a.md", size: 4, mtimeMs: 1 }],
      read: () => {
        reads += 1;
        return "- x\n";
      },
    };
    const entries = new EntryIndex(fs).get("/mem");
    expect(entries.map((e) => e.file)).toEqual(["a.md"]);
    expect(reads).toBe(1);
  });
});

// ── #36 P4 (arch r5 §4.1.4): the v3 write-syntax keys + server-owned ignore ──

describe("parseInlineMeta #36 keys (scope/audience/supersedes/title/when/clears)", () => {
  it("scope/audience validate their enums and land in meta", () => {
    const ok = parseInlineMeta("- r <!-- mem user scope=global audience=main -->");
    expect(ok.meta.scope).toBe("global");
    expect(ok.meta.audience).toBe("main");
    expect(ok.errors).toEqual([]);
    const badScope = parseInlineMeta("- r <!-- mem scope=everywhere -->");
    expect(badScope.errors[0]).toContain('scope "everywhere" is not a valid value');
    const badAudience = parseInlineMeta("- r <!-- mem audience=some -->");
    expect(badAudience.errors[0]).toContain('audience "some" is not a valid value');
  });

  it("supersedes takes comma-separated block ids; bad ids error", () => {
    const ok = parseInlineMeta("- r <!-- mem supersedes=quota.007,pitfalls.012 -->");
    expect(ok.meta.supersedes).toEqual(["quota.007", "pitfalls.012"]);
    const bad = parseInlineMeta("- r <!-- mem supersedes=not-a-block -->");
    expect(bad.errors[0]).toContain("invalid block id");
    expect(bad.meta.supersedes).toBeUndefined();
  });

  it("title/when accept bare or quoted values within BlockMeta limits", () => {
    expect(parseInlineMeta('- r <!-- mem title="release steps" when="before any release" -->').meta).toMatchObject({
      title: "release steps",
      when: "before any release",
    });
    expect(parseInlineMeta("<!-- mem title=t -->").errors).toEqual([]);
    const tooLong = `<!-- mem title=${"t".repeat(111)} -->`;
    expect(parseInlineMeta(tooLong).errors[0]).toContain("invalid title");
  });

  it("expires=none / until=none clear instead of erroring", () => {
    const cleared = parseInlineMeta("- r <!-- mem expires=none until=none -->");
    expect(cleared.meta.clearExpires).toBe(true);
    expect(cleared.meta.clearUntil).toBe(true);
    expect(cleared.meta.expires).toBeUndefined();
    expect(cleared.errors).toEqual([]);
    // real dates still parse as dates
    expect(parseInlineMeta("- r <!-- mem expires=2030-01-01 -->").meta.expires).toBe("2030-01-01");
  });

  it("server-owned keys: STRICT default (v2 byte-parity) — still unknown-key errors", () => {
    const r = parseInlineMeta("- r <!-- mem user rev=3 version=2 -->");
    expect(r.errors).toEqual(['unknown key "rev"', 'unknown key "version"']);
    expect(r.ignored).toEqual([]);
    expect(r.meta.present).toBe(true); // errors never reject the parse
  });

  it("server-owned keys: lenient mode (tool-v3 write syntax) silently ignores + reports them", () => {
    const r = parseInlineMeta("- r <!-- mem user rev=3 version=2 created=2020-01-01 supersededBy=x.001 -->", {
      lenientServerOwned: true,
    });
    expect(r.errors).toEqual([]);
    expect(r.ignored.sort()).toEqual(["created", "rev", "supersededBy", "version"]);
    expect(r.meta.present).toBe(true);
    // unknown non-server keys still error in lenient mode too
    expect(parseInlineMeta("x <!-- mem bogus=1 -->", { lenientServerOwned: true }).errors[0]).toContain("unknown key");
  });

  it("the extended result shape stays backward compatible (ignored optional)", () => {
    const none = parseInlineMeta("- plain line");
    expect(none.meta.present).toBe(false);
    expect(none.ignored).toEqual([]);
  });
});
