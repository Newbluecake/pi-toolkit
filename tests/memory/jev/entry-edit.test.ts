// entry-edit.ts tests (jev-plan §4 J8): CAS re-locate by content hash,
// whole-section-vs-list-item heading handling, `.trash` backup/recovery
// shape, lock-busy passthrough, and inline-comment patch/clear/append.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { deleteEntry, setInlineMeta } from "../../../src/memory/jev/entry-edit.js";
import { splitEntries } from "../../../src/memory/jev/entries.js";
import type { MemEntry } from "../../../src/memory/jev/contracts.js";
import { lockCreate } from "../../../src/memory/safe-fs.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "jev-edit-"));
  roots.push(dir);
  return dir;
}

function write(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body, "utf8");
}

function entriesOf(name: string, body: string): readonly MemEntry[] {
  return splitEntries(name, body, { status: "active", handWritten: false });
}

function findByBody(entries: readonly MemEntry[], needle: string): MemEntry {
  const e = entries.find((x) => x.body.includes(needle));
  if (!e) throw new Error(`no entry matching ${JSON.stringify(needle)}`);
  return e;
}

describe("deleteEntry", () => {
  test("list item: deletes only that item, keeps the heading and siblings", async () => {
    const dir = fixture();
    const body = "## Rules\n\n- rule one\n- rule two\n- rule three\n";
    write(dir, "core.md", body);
    const entries = entriesOf("core.md", body);
    const target = findByBody(entries, "rule two");

    const result = await deleteEntry(dir, target);
    expect(result).toBe("ok");

    const after = readFileSync(join(dir, "core.md"), "utf8");
    expect(after).toContain("## Rules");
    expect(after).toContain("rule one");
    expect(after).not.toContain("rule two");
    expect(after).toContain("rule three");
  });

  test("whole-section entry (no list in the region): deletes the heading too", async () => {
    const dir = fixture();
    const body =
      "## Context\n\nThis whole section is one entry with no list items at all in it, forty plus chars.\n\n## Rules\n\n- rule one\n";
    write(dir, "core.md", body);
    const entries = entriesOf("core.md", body);
    const target = findByBody(entries, "This whole section");
    expect(entries.filter((e) => e.section === target.section)).toHaveLength(1);

    const result = await deleteEntry(dir, target);
    expect(result).toBe("ok");

    const after = readFileSync(join(dir, "core.md"), "utf8");
    expect(after).not.toContain("## Context");
    expect(after).not.toContain("This whole section");
    expect(after).toContain("## Rules");
    expect(after).toContain("rule one");
  });

  test("backs the pre-edit file up to .trash before rewriting", async () => {
    const dir = fixture();
    const body = "## Rules\n\n- rule one\n- rule two\n";
    write(dir, "core.md", body);
    const target = findByBody(entriesOf("core.md", body), "rule two");

    await deleteEntry(dir, target);

    const trashFiles = readdirSync(join(dir, ".trash"));
    expect(trashFiles).toHaveLength(1);
    expect(trashFiles[0]).toMatch(/-core\.md$/);
    expect(readFileSync(join(dir, ".trash", trashFiles[0]!), "utf8")).toBe(body);
  });

  test("stale: entry already gone from the live file", async () => {
    const dir = fixture();
    const body = "## Rules\n\n- rule one\n- rule two\n";
    write(dir, "core.md", body);
    const target = findByBody(entriesOf("core.md", body), "rule two");

    // Someone else already removed it.
    write(dir, "core.md", "## Rules\n\n- rule one\n");

    const result = await deleteEntry(dir, target);
    expect(result).toBe("stale");
    expect(readFileSync(join(dir, "core.md"), "utf8")).toBe("## Rules\n\n- rule one\n");
  });

  test("busy: lock held by a live same-host process", async () => {
    const dir = fixture();
    const body = "## Rules\n\n- rule one\n- rule two\n";
    write(dir, "core.md", body);
    const target = findByBody(entriesOf("core.md", body), "rule two");
    expect(lockCreate(dir, { pid: process.pid, host: "test-host", at: Date.now() })).toBe(true);

    const result = await deleteEntry(dir, target);
    expect(result).toBe("busy");
    expect(readFileSync(join(dir, "core.md"), "utf8")).toBe(body);
  });
});

describe("setInlineMeta", () => {
  test("adds an expires= comment to an entry with no inline comment yet", async () => {
    const dir = fixture();
    const body = "## Rules\n\n- rule one\n";
    write(dir, "core.md", body);
    const target = findByBody(entriesOf("core.md", body), "rule one");

    const result = await setInlineMeta(dir, target, { expires: "2026-12-01" });
    expect(result).toBe("ok");
    const after = readFileSync(join(dir, "core.md"), "utf8");
    expect(after).toContain("- rule one <!-- mem expires=2026-12-01 -->");
  });

  test("clears expires/until while preserving gate and tags", async () => {
    const dir = fixture();
    const body = "## Rules\n\n- rule one <!-- mem expires=2026-01-01 gate=hold tags=+infra -->\n";
    write(dir, "core.md", body);
    const target = findByBody(entriesOf("core.md", body), "rule one");

    const result = await setInlineMeta(dir, target, { expires: null, until: null });
    expect(result).toBe("ok");
    const after = readFileSync(join(dir, "core.md"), "utf8");
    expect(after).toContain("gate=hold");
    expect(after).toContain("tags=+infra");
    expect(after).not.toContain("expires=");
  });

  test("marks authority=user, keeping other keys", async () => {
    const dir = fixture();
    const body = "## Rules\n\n- rule one <!-- mem lesson -->\n";
    write(dir, "core.md", body);
    const target = findByBody(entriesOf("core.md", body), "rule one");

    const result = await setInlineMeta(dir, target, { authority: "user" });
    expect(result).toBe("ok");
    const after = readFileSync(join(dir, "core.md"), "utf8");
    expect(after).toContain("<!-- mem user -->");
    expect(after).not.toContain("lesson");
  });

  test("removing the last key drops the comment entirely", async () => {
    const dir = fixture();
    const body = "## Rules\n\n- rule one <!-- mem expires=2026-01-01 -->\n";
    write(dir, "core.md", body);
    const target = findByBody(entriesOf("core.md", body), "rule one");

    const result = await setInlineMeta(dir, target, { expires: null });
    expect(result).toBe("ok");
    const after = readFileSync(join(dir, "core.md"), "utf8");
    expect(after).toBe("## Rules\n\n- rule one\n");
  });

  test("stale when the entry's content changed since it was read", async () => {
    const dir = fixture();
    const body = "## Rules\n\n- rule one\n";
    write(dir, "core.md", body);
    const target = findByBody(entriesOf("core.md", body), "rule one");
    write(dir, "core.md", "## Rules\n\n- rule one EDITED\n");

    const result = await setInlineMeta(dir, target, { expires: "2026-12-01" });
    expect(result).toBe("stale");
  });

  test("busy: lock held", async () => {
    const dir = fixture();
    const body = "## Rules\n\n- rule one\n";
    write(dir, "core.md", body);
    const target = findByBody(entriesOf("core.md", body), "rule one");
    expect(lockCreate(dir, { pid: process.pid, host: "test-host", at: Date.now() })).toBe(true);

    const result = await setInlineMeta(dir, target, { expires: "2026-12-01" });
    expect(result).toBe("busy");
  });
});
