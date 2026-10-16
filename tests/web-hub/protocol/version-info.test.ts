import { describe, expect, it } from "vitest";
import { VERSION_HUB_CAP } from "../../../src/web-hub/protocol/version.js";
import {
  VERSION_INFO_PATH,
  VERSION_LIMITS,
  compareCommit,
  normalizeCommit,
  parseVersionInfoWire,
} from "../../../src/web-hub/protocol/version-info.js";

describe("constants (web-hub-version plan §2, V0 frozen surface)", () => {
  it("VERSION_HUB_CAP is stable and inert in V0 (nothing folds it into a caps array yet)", () => {
    expect(VERSION_HUB_CAP).toBe("version.v1");
  });

  it("VERSION_INFO_PATH / VERSION_LIMITS are stable", () => {
    expect(VERSION_INFO_PATH).toBe("/api/version");
    expect(VERSION_LIMITS).toEqual({
      changelogSections: 5,
      sectionBytes: 8192,
      fileBytes: 1 << 20,
      commits: 20,
      subjectChars: 200,
      bodyBytes: 64 * 1024,
      waiters: 8,
      requestMs: 4000,
      gitStepMs: 1000,
      fileMs: 1000,
      okTtlMs: 30_000,
      failTtlMs: 10_000,
    });
  });
});

describe("normalizeCommit", () => {
  type Ok = [unknown, { hex: string; dirty: boolean } | null];
  const ok: Ok[] = [
    // bare short hash
    ["abc1234", { hex: "abc1234", dirty: false }],
    // full 40-hex sha1 and 64-hex sha256 are both fine
    ["a".repeat(40), { hex: "a".repeat(40), dirty: false }],
    ["b".repeat(64), { hex: "b".repeat(64), dirty: false }],
    // hub buildId form `<version>@<hash>` (clean / dirty `*`)
    ["0.5.5@abc1234", { hex: "abc1234", dirty: false }],
    ["0.5.5@abc1234*", { hex: "abc1234", dirty: true }],
    ["@abc1234", { hex: "abc1234", dirty: false }],
    // UI manifest form `-dirty` (exactly ONE terminal mark — the two dirty vocabularies never chain)
    ["abc1234-dirty", { hex: "abc1234", dirty: true }],
    ["0.5.5@abc1234-dirty", { hex: "abc1234", dirty: true }],
    // just a star, no version part
    ["abc1234*", { hex: "abc1234", dirty: true }],
  ];
  it.each(ok)("normalizeCommit(%j) → %j", (input, want) => {
    expect(normalizeCommit(input)).toEqual(want);
  });

  type Null = unknown;
  const nulls: Null[] = [
    // non-strings
    undefined,
    null,
    123,
    {},
    [],
    () => "abc1234",
    "",
    // nogit / unknown in every spelling
    "nogit",
    "unknown",
    "@nogit",
    "0.5.5@nogit",
    "@unknown",
    "0.5.5@unknown",
    "0.5.5@nogit*",
    // uppercase hex is rejected (git emits lowercase; CommitRef.commit is specified 小写)
    "ABC1234",
    "Abc1234",
    "abc1234A",
    "0.5.5@ABC1234",
    // fewer than 7 hex chars
    "abc123",
    "abcdef",
    "0.5.5@abc123",
    // over the 64-char bound
    "c".repeat(65),
    // leftover junk after the single-mark strip (stacked marks never parse)
    "abc1234**",
    "abc1234-dirty-dirty",
    "abc1234-dirty*",
    "abc1234*-dirty",
    " abc1234",
    "abc1234 ",
    "0.5.5@",
    "0.5.5",
    "main",
    "HEAD",
  ];
  it.each(nulls.map((v) => [v] as const))("normalizeCommit(%j) → null", (input) => {
    expect(normalizeCommit(input)).toBeNull();
  });
});

describe("compareCommit", () => {
  it("prefix equality on the shorter side's length (min ≥ 7)", () => {
    expect(compareCommit("abc1234", "abc1234567890abcdef1234567890abcdef1234567")).toBe("same");
    expect(compareCommit("abc1234567890abcdef1234567890abcdef1234567", "abc1234")).toBe("same");
    expect(compareCommit("abc1234", "abc1234")).toBe("same");
    // the 7-char common prefix decides; the 8th char differing below that length is invisible
    expect(compareCommit("abc1234", "abc12345")).toBe("same");
  });

  it("differ when the compared prefix diverges", () => {
    expect(compareCommit("abc1234", "abd1234")).toBe("differ");
    expect(compareCommit("0.5.5@abc1234", "0.5.6@abd5678")).toBe("differ");
  });

  it("dirty is ignored for equality", () => {
    expect(compareCommit("0.5.5@abc1234*", "abc1234")).toBe("same");
    expect(compareCommit("abc1234-dirty", "abc1234*")).toBe("same");
    expect(compareCommit("abc1234", "abc1234-dirty")).toBe("same");
  });

  it("either side unparseable ⇒ unknown (never same)", () => {
    expect(compareCommit(null, "abc1234")).toBe("unknown");
    expect(compareCommit("abc1234", undefined)).toBe("unknown");
    expect(compareCommit("nogit", "abc1234")).toBe("unknown");
    expect(compareCommit("abc1234", "unknown")).toBe("unknown");
    expect(compareCommit("0.5.5", "0.5.5")).toBe("unknown");
    expect(compareCommit(123, 456)).toBe("unknown");
  });
});

describe("parseVersionInfoWire", () => {
  const base = {
    v: 1,
    checkedAt: 1760000000000,
    hub: { pid: 4242, startedAt: 1759999000000 },
  };

  function fullBody(): Record<string, unknown> {
    return {
      ...base,
      repo: {
        head: { commit: "33a89f166f2a", time: 1760000123, dirty: true },
        packageVersion: "0.5.5",
        lastTag: "v0.5.5",
        commits: [
          { commit: "33a89f166f2a", time: 1760000123, subject: "fix(hud): fetch race" },
          { commit: "ab12cd3ef45", time: 1759999999, subject: "feat(workflow): queue" },
        ],
        commitsTotal: 48,
      },
      changelog: {
        sections: [
          { title: "0.5.5", date: "2026-10-16", markdown: "### Fixes\n- hud", truncated: true },
          { title: "0.5.4", markdown: "…" },
        ],
      },
      truncated: true,
    };
  }

  it("parses a full body into an equal shape", () => {
    expect(parseVersionInfoWire(fullBody())).toEqual({
      v: 1,
      checkedAt: 1760000000000,
      hub: { pid: 4242, startedAt: 1759999000000 },
      repo: {
        head: { commit: "33a89f166f2a", time: 1760000123, dirty: true },
        packageVersion: "0.5.5",
        lastTag: "v0.5.5",
        commits: [
          { commit: "33a89f166f2a", time: 1760000123, subject: "fix(hud): fetch race" },
          { commit: "ab12cd3ef45", time: 1759999999, subject: "feat(workflow): queue" },
        ],
        commitsTotal: 48,
      },
      changelog: {
        sections: [
          { title: "0.5.5", date: "2026-10-16", markdown: "### Fixes\n- hud", truncated: true },
          { title: "0.5.4", markdown: "…" },
        ],
      },
      truncated: true,
    });
  });

  it("parses a minimal body — repo/changelog keys wholly absent (non-toplevel package root)", () => {
    expect(parseVersionInfoWire({ ...base })).toEqual({
      v: 1,
      checkedAt: 1760000000000,
      hub: { pid: 4242, startedAt: 1759999000000 },
    });
  });

  it("parses with every optional sub-key missing", () => {
    const wire = parseVersionInfoWire({ ...base, repo: { head: { commit: "abc1234" } } });
    expect(wire).toEqual({ ...base, repo: { head: { commit: "abc1234" } } });
  });

  it("parses every SectionError variant on both sections", () => {
    const errors = ["timeout", "unavailable", "git-too-old", "too-large", "missing"] as const;
    for (const error of errors) {
      expect(parseVersionInfoWire({ ...base, repo: { error }, changelog: { error } })).toEqual({
        ...base,
        repo: { error },
        changelog: { error },
      });
    }
  });

  it("`{error}` wins when a section object carries both forms' keys", () => {
    const body = { ...base, repo: { error: "timeout", head: { commit: "abc1234" } } };
    expect(parseVersionInfoWire(body)).toEqual({ ...base, repo: { error: "timeout" } });
  });

  it("ignores unknown fields at every level (additive-extension room)", () => {
    const body = fullBody();
    (body as Record<string, unknown>)["extra"] = 1;
    const repo = body["repo"] as Record<string, unknown>;
    repo["future"] = { x: 1 };
    const hub = (body as Record<string, unknown>)["hub"] as Record<string, unknown>;
    hub["extra"] = "y";
    const cl = body["changelog"] as Record<string, unknown>;
    (cl["sections"] as Record<string, unknown>[])[0]!["future"] = true;
    expect(parseVersionInfoWire(body)).toEqual(parseVersionInfoWire(fullBody()));
  });

  it("accepts arrays exactly at the caps (5 sections / 20 commits)", () => {
    const sections = Array.from({ length: 5 }, (_, i) => ({ title: `0.5.${i}`, markdown: "m" }));
    const commits = Array.from({ length: 20 }, (_, i) => ({
      commit: `${i.toString(16).padStart(2, "0")}cdef01`,
      time: 1760000000 + i,
      subject: `s${i}`,
    }));
    const wire = parseVersionInfoWire({
      ...base,
      changelog: { sections },
      repo: { head: { commit: "abc1234def" }, commits },
    });
    expect(wire?.changelog && "sections" in wire.changelog ? wire.changelog.sections.length : 0).toBe(5);
    expect(wire?.repo && "commits" in wire.repo && wire.repo.commits ? wire.repo.commits.length : 0).toBe(20);
  });

  it("REJECTS over-limit arrays (plan §2「parse 拒绝超界」— the producer already trims)", () => {
    const sections6 = Array.from({ length: 6 }, (_, i) => ({ title: `0.5.${i}`, markdown: "m" }));
    expect(parseVersionInfoWire({ ...base, changelog: { sections: sections6 } })).toBeUndefined();
    const commits21 = Array.from({ length: 21 }, (_, i) => ({
      commit: `${i.toString(16).padStart(2, "0")}cdef01`,
      time: 1,
      subject: "s",
    }));
    expect(
      parseVersionInfoWire({ ...base, repo: { head: { commit: "abc1234def" }, commits: commits21 } }),
    ).toBeUndefined();
  });

  type Bad = [string, unknown];
  const bad: Bad[] = [
    // top-level garbage
    ["not an object", "nope"],
    ["null", null],
    ["array", [base]],
    ["number", 1],
    ["v wrong type", { ...base, v: "1" }],
    ["v wrong value", { ...base, v: 2 }],
    ["checkedAt missing", { v: 1, hub: base.hub }],
    ["checkedAt NaN", { ...base, checkedAt: Number.NaN }],
    ["checkedAt Infinity", { ...base, checkedAt: Number.POSITIVE_INFINITY }],
    ["checkedAt string", { ...base, checkedAt: "1760000000000" }],
    ["checkedAt negative", { ...base, checkedAt: -1 }],
    ["hub missing", { v: 1, checkedAt: 1 }],
    ["hub null", { ...base, hub: null }],
    ["hub array", { ...base, hub: [4242, 1759999000000] }],
    ["hub.pid zero", { ...base, hub: { pid: 0, startedAt: 1759999000000 } }],
    ["hub.pid negative", { ...base, hub: { pid: -1, startedAt: 1759999000000 } }],
    ["hub.pid fractional", { ...base, hub: { pid: 1.5, startedAt: 1759999000000 } }],
    ["hub.pid string", { ...base, hub: { pid: "4242", startedAt: 1759999000000 } }],
    ["hub.startedAt missing", { ...base, hub: { pid: 4242 } }],
    ["hub.startedAt unsafe", { ...base, hub: { pid: 4242, startedAt: 1e21 } }],
    ["truncated false", { ...base, truncated: false }],
    ["truncated string", { ...base, truncated: "yes" }],
    // repo error form
    ["repo error unknown literal", { ...base, repo: { error: "boom" } }],
    ["repo error non-string", { ...base, repo: { error: 5 } }],
    ["repo bare array", { ...base, repo: [] }],
    // repo head
    ["repo head missing", { ...base, repo: {} }],
    ["repo head null", { ...base, repo: { head: null } }],
    ["repo head.commit short", { ...base, repo: { head: { commit: "abc123" } } }],
    ["repo head.commit uppercase", { ...base, repo: { head: { commit: "ABC1234" } } }],
    ["repo head.commit buildId form NOT re-normalized", { ...base, repo: { head: { commit: "0.5.5@abc1234" } } }],
    ["repo head.commit unknown", { ...base, repo: { head: { commit: "unknown" } } }],
    ["repo head.time NaN", { ...base, repo: { head: { commit: "abc1234", time: Number.NaN } } }],
    ["repo head.time negative", { ...base, repo: { head: { commit: "abc1234", time: -1 } } }],
    ["repo head.time string", { ...base, repo: { head: { commit: "abc1234", time: "12" } } }],
    ["repo head.dirty false", { ...base, repo: { head: { commit: "abc1234", dirty: false } } }],
    ["repo head.dirty string", { ...base, repo: { head: { commit: "abc1234", dirty: "yes" } } }],
    // repo optionals
    ["repo packageVersion empty", { ...base, repo: { head: { commit: "abc1234" }, packageVersion: "" } }],
    ["repo packageVersion number", { ...base, repo: { head: { commit: "abc1234" }, packageVersion: 1 } }],
    ["repo lastTag empty", { ...base, repo: { head: { commit: "abc1234" }, lastTag: "" } }],
    ["repo commits not array", { ...base, repo: { head: { commit: "abc1234" }, commits: {} } }],
    ["repo commits entry null", { ...base, repo: { head: { commit: "abc1234" }, commits: [null] } }],
    [
      "repo commits entry bad commit",
      { ...base, repo: { head: { commit: "abc1234" }, commits: [{ commit: "xy", time: 1, subject: "s" }] } },
    ],
    [
      "repo commits entry bad time",
      { ...base, repo: { head: { commit: "abc1234" }, commits: [{ commit: "abc1234", time: "1", subject: "s" }] } },
    ],
    [
      "repo commits entry bad subject",
      { ...base, repo: { head: { commit: "abc1234" }, commits: [{ commit: "abc1234", time: 1, subject: 7 }] } },
    ],
    ["repo commitsTotal negative", { ...base, repo: { head: { commit: "abc1234" }, commitsTotal: -1 } }],
    ["repo commitsTotal unsafe", { ...base, repo: { head: { commit: "abc1234" }, commitsTotal: 1e21 } }],
    // changelog success form
    ["changelog sections missing", { ...base, changelog: {} }],
    ["changelog sections not array", { ...base, changelog: { sections: "x" } }],
    ["changelog section null", { ...base, changelog: { sections: [null] } }],
    ["changelog section title empty", { ...base, changelog: { sections: [{ title: "", markdown: "m" }] } }],
    ["changelog section title number", { ...base, changelog: { sections: [{ title: 1, markdown: "m" }] } }],
    ["changelog section markdown missing", { ...base, changelog: { sections: [{ title: "0.5.5" }] } }],
    [
      "changelog section date number",
      { ...base, changelog: { sections: [{ title: "0.5.5", markdown: "m", date: 5 }] } },
    ],
    [
      "changelog section date empty",
      { ...base, changelog: { sections: [{ title: "0.5.5", markdown: "m", date: "" }] } },
    ],
    [
      "changelog section truncated false",
      { ...base, changelog: { sections: [{ title: "0.5.5", markdown: "m", truncated: false }] } },
    ],
  ];
  it.each(bad)("rejects %s ⇒ undefined", (_name, body) => {
    expect(parseVersionInfoWire(body)).toBeUndefined();
  });

  it("never throws on hostile shapes (deeply nested / cyclic)", () => {
    const cyclic: Record<string, unknown> = { ...base };
    cyclic["repo"] = cyclic;
    expect(() => parseVersionInfoWire(cyclic)).not.toThrow();
    // the cycle resolves through shape validation: `repo` has no `head`, so the parse fails fast
    expect(parseVersionInfoWire(cyclic)).toBeUndefined();
    expect(parseVersionInfoWire({ ...base, repo: { head: { commit: "abc1234", time: cyclic } } })).toBeUndefined();
  });
});
