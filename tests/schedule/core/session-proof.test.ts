/**
 * scheduled-reports plan r3 §6.3 / §5.5 (S1): the session-file entry proof — only a persisted
 * `custom_message` line with customType `subagent:schedule` and the matching details id counts;
 * reads start at the pre-send offset, are capped (16 MiB ⇒ too-large / unverified), refuse
 * symlinks and non-regular files, skip over-long foreign lines, honor a deadline.
 */
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ProofQuery,
  SCHED_PROOF_SETTLE_MS,
  decodeAnchor,
  encodeAnchor,
  findSessionEntry,
  SCHED_PROOF_LINE_MAX,
  sessionFileAnchor,
  sessionFileOffset,
} from "../../../src/schedule/core/session-proof.js";

/** Freshly written test files are "unsettled" by design; the settle check has its own test. */
const find = (q: ProofQuery) => findSessionEntry({ settleMs: 0, ...q });

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sched-proof-"));
  file = join(dir, "s.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const line = (o: unknown): string => `${JSON.stringify(o)}\n`;
const entry = (details: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  line({
    type: "custom_message",
    customType: "subagent:schedule",
    content: "x",
    display: true,
    details,
    id: "e1",
    parentId: null,
    ...extra,
  });

describe("findSessionEntry", () => {
  it("finds the entry written after the anchor; earlier/foreign look-alikes do not count", () => {
    writeFileSync(file, line({ type: "session", id: "h" }) + entry({ noteId: "n-1" }, { id: "old" }));
    const anchor = sessionFileAnchor(file)!;
    // look-alikes after the anchor: wrong type, wrong customType, the id inside text content
    appendFileSync(
      file,
      line({ type: "message", message: { content: 'subagent:schedule "noteId":"n-2"' } }) +
        line({ type: "custom_message", customType: "subagent:other", details: { noteId: "n-2" } }) +
        line({ type: "custom", customType: "subagent:schedule", data: { noteId: "n-2" } }),
    );
    expect(find({ file, anchor, key: "noteId", id: "n-2" })).toMatchObject({
      kind: "absent",
      scannedFrom: anchor.offset,
      rewritten: false,
    });
    expect(find({ file, anchor, key: "noteId", id: "n-1" })).toMatchObject({ kind: "absent" }); // before anchor
    appendFileSync(file, entry({ kind: "result", noteId: "n-2" }, { id: "new" }));
    expect(find({ file, anchor, key: "noteId", id: "n-2" })).toMatchObject({
      kind: "found",
      entryId: "new",
    });
    expect(find({ file, anchor, key: "digestId", id: "n-2" }).kind).toBe("absent");
  });

  it("a file shorter than the recorded offset was rewritten ⇒ scan from 0", () => {
    writeFileSync(file, entry({ digestId: "d-1" }));
    expect(find({ file, offset: 10_000_000, key: "digestId", id: "d-1" }).kind).toBe("found");
  });

  it("a trailing line without a newline still counts; chunk boundaries do not matter", () => {
    writeFileSync(file, "z".repeat(256 * 1024 - 7) + "\n" + entry({ noteId: "edge" }).trimEnd());
    expect(find({ file, offset: 0, key: "noteId", id: "edge" }).kind).toBe("found");
  });

  it("over-long foreign lines are skipped, the target after them is found", () => {
    writeFileSync(
      file,
      line({ type: "message", blob: "b".repeat(SCHED_PROOF_LINE_MAX + 5) }) + entry({ noteId: "after" }),
    );
    expect(find({ file, offset: 0, key: "noteId", id: "after" }).kind).toBe("found");
  });

  it("more than the cap to scan ⇒ too-large (never a false absent)", () => {
    writeFileSync(file, "x".repeat(2048) + "\n" + entry({ noteId: "far" }));
    expect(find({ file, offset: 0, key: "noteId", id: "far", maxBytes: 1024 })).toMatchObject({
      kind: "too-large",
    });
  });

  it("deadline ⇒ inconclusive", () => {
    writeFileSync(file, entry({ noteId: "x" }));
    let t = 0;
    expect(find({ file, offset: 0, key: "noteId", id: "x", deadlineAt: 5, clock: () => (t += 10) })).toEqual({
      kind: "inconclusive",
      reason: "deadline",
    });
  });

  it("symlink / FIFO / missing are refused without blocking", () => {
    writeFileSync(file, entry({ noteId: "x" }));
    symlinkSync(file, join(dir, "link.jsonl"));
    expect(find({ file: join(dir, "link.jsonl"), offset: 0, key: "noteId", id: "x" })).toMatchObject({
      kind: "refused",
      reason: "symlink",
    });
    execFileSync("mkfifo", [join(dir, "fifo")]);
    expect(find({ file: join(dir, "fifo"), offset: 0, key: "noteId", id: "x" })).toMatchObject({
      reason: "not-file",
    });
    expect(find({ file: join(dir, "nope"), offset: 0, key: "noteId", id: "x" })).toMatchObject({
      reason: "missing",
    });
    expect(sessionFileOffset(join(dir, "nope"))).toBe(0);
    expect(sessionFileOffset(join(dir, "link.jsonl"))).toBeUndefined();
  });
});

/** Review M4: the pre-send offset is bound to the file's identity; nothing unprovable is "absent". */
describe("findSessionEntry — file identity (review M4)", () => {
  const pad = (n: number): string => line({ type: "message", pad: "p".repeat(n) });

  it("truncated + rewritten past the old offset with the note near the start ⇒ full rescan finds it", () => {
    writeFileSync(file, line({ type: "session", id: "h" }) + pad(4000));
    const anchor = sessionFileAnchor(file)!;
    // Rewritten in place (same inode): the note now sits BEFORE the old offset, and the file has
    // grown past it again. An offset-only scan (the pre-fix behaviour) would report "absent".
    writeFileSync(file, line({ type: "session", id: "h2" }) + entry({ noteId: "early" }) + pad(6000));
    expect(find({ file, anchor, key: "noteId", id: "early" })).toMatchObject({ kind: "found" });
    expect(find({ file, anchor, key: "noteId", id: "nope" })).toMatchObject({
      kind: "absent",
      scannedFrom: 0,
      rewritten: true,
    });
  });

  it("replaced by rename (new inode) ⇒ the anchor does not match ⇒ rescan from 0", () => {
    writeFileSync(file, pad(3000));
    const anchor = sessionFileAnchor(file)!;
    const other = join(dir, "other.jsonl");
    writeFileSync(other, entry({ noteId: "moved" }) + pad(5000));
    renameSync(other, file);
    expect(find({ file, anchor, key: "noteId", id: "moved" })).toMatchObject({ kind: "found" });
  });

  it("a bare offset > 0 can never prove absence (unanchored); offset 0 still can", () => {
    writeFileSync(file, pad(100));
    const offset = sessionFileOffset(file)!;
    appendFileSync(file, pad(10));
    expect(find({ file, offset, key: "noteId", id: "x" })).toEqual({
      kind: "inconclusive",
      reason: "unanchored",
    });
    expect(find({ file, offset: 0, key: "noteId", id: "x" })).toMatchObject({ kind: "absent" });
  });

  it("truncated while being read ⇒ premature EOF ⇒ inconclusive(short-read), never absent", () => {
    writeFileSync(file, pad(1000));
    let first = true;
    const clock = (): number => {
      if (first) truncateSync(file, 0); // just before the first chunk read
      first = false;
      return 0;
    };
    expect(find({ file, offset: 0, key: "noteId", id: "x", deadlineAt: 1e12, clock })).toEqual({
      kind: "inconclusive",
      reason: "short-read",
    });
  });

  it("the path re-pointed to another inode during the scan ⇒ inconclusive(changed)", () => {
    writeFileSync(file, pad(1000));
    let first = true;
    const clock = (): number => {
      if (first) {
        const other = join(dir, "swap.jsonl");
        writeFileSync(other, pad(2000));
        renameSync(other, file); // our fd still reads the old inode to its end
      }
      first = false;
      return 0;
    };
    expect(find({ file, offset: 0, key: "noteId", id: "x", deadlineAt: 1e12, clock })).toEqual({
      kind: "inconclusive",
      reason: "changed",
    });
  });

  it("anchors round-trip through their string form; malformed strings are rejected", () => {
    writeFileSync(file, pad(50));
    const a = sessionFileAnchor(file)!;
    expect(decodeAnchor(encodeAnchor(a))).toEqual(a);
    expect(encodeAnchor(a).length).toBeLessThanOrEqual(128);
    for (const bad of [
      "",
      "a1:1:2:3:zz:yy",
      `a2${encodeAnchor(a).slice(2)}`,
      "a1:-1:0:0:0000000000000000:0000000000000000",
    ]) {
      expect(decodeAnchor(bad)).toBeUndefined();
    }
    expect(sessionFileAnchor(join(dir, "missing"))).toMatchObject({ offset: 0 });
  });
});

/** Review round 2 (M4 residual): absence needs a scan over a provably unchanged file. */
describe("findSessionEntry — stable-scan proof (review round 2)", () => {
  const sleepSync = (ms: number): void => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  };

  it("rewritten IN PLACE during the scan (same inode, size restored, note moved into the already-read first chunk) ⇒ inconclusive, never absent", () => {
    // > one 256 KiB chunk, so the scan reads chunk 1, then we rewrite, then it reads the rest
    const filler = line({ type: "message", pad: "p".repeat(300_000) });
    const note = entry({ noteId: "late-note" });
    const head = line({ type: "session", id: "h", pad: "q".repeat(note.length - 40) });
    writeFileSync(file, head.slice(0, note.length - 1) + "\n" + filler);
    expect(find({ file, offset: 0, key: "noteId", id: "late-note" })).toMatchObject({ kind: "absent" }); // control
    sleepSync(30); // leave the timestamp tick of the initial write behind
    let calls = 0;
    const clock = (): number => {
      calls += 1;
      if (calls === 2) {
        // after chunk 1 was read: rewrite bytes [0, note.length) in place — same inode, same size
        sleepSync(15);
        const fd = openSync(file, "r+");
        writeSync(fd, Buffer.from(note, "utf8"), 0, Buffer.byteLength(note), 0);
        closeSync(fd);
      }
      return 0;
    };
    const sizeBefore = statSync(file).size;
    const inoBefore = statSync(file).ino;
    const r = find({ file, offset: 0, key: "noteId", id: "late-note", deadlineAt: 1e12, clock });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(statSync(file).size).toBe(sizeBefore); // the reviewer's scenario: size restored
    expect(statSync(file).ino).toBe(inoBefore); // …and the same inode
    expect(r).toEqual({ kind: "inconclusive", reason: "changed" }); // pre-fix: absent
    // a stable rescan afterwards finds the note at byte 0
    expect(find({ file, offset: 0, key: "noteId", id: "late-note" })).toMatchObject({ kind: "found", atByte: 0 });
  });

  it("appended during the scan ⇒ inconclusive (size/ctime moved), even though nothing shrank", () => {
    writeFileSync(file, line({ type: "message", pad: "p".repeat(300_000) }));
    sleepSync(30);
    let calls = 0;
    const clock = (): number => {
      if (++calls === 2) appendFileSync(file, line({ type: "message" }));
      return 0;
    };
    expect(find({ file, offset: 0, key: "noteId", id: "x", deadlineAt: 1e12, clock })).toEqual({
      kind: "inconclusive",
      reason: "changed",
    });
  });

  it("a file changed within the settle margin of the scan start cannot prove absence (coarse timestamps)", () => {
    writeFileSync(file, line({ type: "message" }));
    expect(findSessionEntry({ file, offset: 0, key: "noteId", id: "x" })).toEqual({
      kind: "inconclusive",
      reason: "unsettled",
    });
    const later = Date.now() + SCHED_PROOF_SETTLE_MS + 1;
    expect(findSessionEntry({ file, offset: 0, key: "noteId", id: "x", wallNow: () => later })).toMatchObject({
      kind: "absent",
    });
    // a found entry needs no settle proof
    appendFileSync(file, entry({ noteId: "y" }));
    expect(findSessionEntry({ file, offset: 0, key: "noteId", id: "y" })).toMatchObject({ kind: "found" });
  });
});
