/**
 * wtgraph.files.v1 protocol: `parseWtGraphCommitFiles` — strict key whitelist, status/orig/count
 * rules, `truncated` consistency, byte cap, never throws.
 */
import { describe, expect, it } from "vitest";

import {
  WTGRAPH_FILES_BODY_MAX_BYTES,
  WTGRAPH_FILES_MAX,
  WTGRAPH_FILES_PATH,
  parseWtGraphCommitFiles,
} from "../../../src/web-hub/protocol/worktree-graph.js";
import { WTGRAPH_FILES_HUB_CAP } from "../../../src/web-hub/protocol/version.js";

const H = "a".repeat(40);
const ok = () => ({
  v: 1,
  h: H,
  entries: [
    { path: "src/a.ts", status: "M", add: 3, del: 1 },
    { path: "b.txt", orig: "a.txt", status: "R", add: 0, del: 0 },
    { path: "logo.png", status: "A", binary: true },
    { path: "gone", status: "D" },
  ],
  total: 4,
  truncated: false,
  limits: { files: false, bytes: false, output: false },
});
const parse = (raw: unknown) => parseWtGraphCommitFiles(raw, 100);

describe("parseWtGraphCommitFiles", () => {
  it("constants: path + cap names", () => {
    expect(WTGRAPH_FILES_PATH).toBe("/api/worktree-graph/files");
    expect(WTGRAPH_FILES_HUB_CAP).toBe("wtgraph.files.v1");
  });

  it("accepts a valid body verbatim (sha1 and sha256 oids; shallow flag)", () => {
    expect(parse(ok())).toEqual(ok());
    expect(parse({ ...ok(), h: "b".repeat(64), shallow: true })).toMatchObject({ shallow: true });
  });

  it("rejects unknown keys at every level", () => {
    expect(parse({ ...ok(), extra: 1 })).toBeNull();
    expect(parse({ ...ok(), limits: { ...ok().limits, more: false } })).toBeNull();
    const e = ok();
    (e.entries[0] as Record<string, unknown>).x = 1;
    expect(parse(e)).toBeNull();
  });

  it("status / orig / counts rules", () => {
    const withEntry = (entry: unknown) => ({ ...ok(), entries: [entry], total: 1 });
    expect(parse(withEntry({ path: "a", status: "U" }))).toBeNull();
    expect(parse(withEntry({ path: "a", status: "R" }))).toBeNull(); // R needs orig
    expect(parse(withEntry({ path: "a", orig: "b", status: "M" }))).toBeNull(); // orig only on R
    expect(parse(withEntry({ path: "a", status: "M", add: 1 }))).toBeNull(); // add without del
    expect(parse(withEntry({ path: "a", status: "M", add: -1, del: 0 }))).toBeNull();
    expect(parse(withEntry({ path: "a", status: "M", add: 1, del: 1, binary: true }))).toBeNull();
    expect(parse(withEntry({ path: "", status: "M" }))).toBeNull();
    expect(parse(withEntry({ path: "a\0b", status: "M" }))).toBeNull();
    expect(parse(withEntry({ path: "x".repeat(4097), status: "M" }))).toBeNull();
  });

  it("truncated must equal entries < total || limits.output; total ≥ entries", () => {
    expect(parse({ ...ok(), total: 3 })).toBeNull();
    expect(parse({ ...ok(), total: 5 })).toBeNull(); // truncated false but entries < total
    expect(parse({ ...ok(), total: 5, truncated: true })).not.toBeNull();
    expect(parse({ ...ok(), truncated: true })).toBeNull();
    expect(parse({ ...ok(), truncated: true, limits: { files: false, bytes: false, output: true } })).not.toBeNull();
  });

  it("caps: entries ≤ WTGRAPH_FILES_MAX; byteLength ≤ the body cap; bad oid / v", () => {
    const many = Array.from({ length: WTGRAPH_FILES_MAX + 1 }, (_, i) => ({ path: `f${i}`, status: "A" }));
    expect(parse({ ...ok(), entries: many, total: many.length })).toBeNull();
    expect(parseWtGraphCommitFiles(ok(), WTGRAPH_FILES_BODY_MAX_BYTES + 1)).toBeNull();
    expect(parse({ ...ok(), h: H.toUpperCase() })).toBeNull();
    expect(parse({ ...ok(), h: "a".repeat(41) })).toBeNull();
    expect(parse({ ...ok(), v: 2 })).toBeNull();
  });

  it("never throws on hostile input", () => {
    const evil = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("boom");
        },
      },
    );
    expect(parse(evil)).toBeNull();
    expect(parse(null)).toBeNull();
    expect(parse([])).toBeNull();
    expect(parse(Object.create({ v: 1 }))).toBeNull();
  });
});
