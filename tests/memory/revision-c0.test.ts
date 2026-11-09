/** C0 only: real temporary files plus synchronous fault seams. No freezer,
 * audit, applier or UTF-8 admission is implemented/tested by this package.
 * Compile-time cases at the end MUST also run via the standalone strict tsc
 * command recorded in /tmp/p50-c0.json (vitest only strips TypeScript). */
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRegular, readRegularBytes } from "../../src/memory/safe-fs.js";
import type {
  ApplyObservation,
  ClientProvenance,
  ExpectedAfter,
  RevisionProposal,
  RevisionProposalBase,
} from "../../src/memory/jev/contracts.js";

vi.mock("node:fs", async (original) => ({ ...(await original<typeof import("node:fs")>()) }));
const roots: string[] = [];
function root(): string {
  const dir = fs.mkdtempSync(join(tmpdir(), "p50-c0-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Preserve actual synchronous I/O; inject a single mutation at a read boundary. */
function duringFirstRead(mutate: () => void) {
  const read = fs.readSync;
  let first = true;
  return vi.spyOn(fs, "readSync").mockImplementation(((fd, buffer, offset, length, position) => {
    const n = read(fd, buffer, offset, length, position);
    if (first) {
      first = false;
      mutate();
    }
    return n;
  }) as typeof fs.readSync);
}

describe("P50 C0 readRegularBytes", () => {
  it("preserves invalid UTF-8, BOM, CRLF, NUL and non-ASCII bytes; legacy decoding is unchanged", () => {
    const dir = root();
    const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf, 0xff, 0xc3, 0x28, 0x00]), Buffer.from("原文\r\n")]);
    fs.writeFileSync(join(dir, "a.md"), raw);
    const result = readRegularBytes(dir, "a.md", { maxBytes: raw.length });
    expect(Buffer.isBuffer(result.bytes)).toBe(true);
    expect(result.bytes.equals(raw)).toBe(true);
    const stat = fs.lstatSync(join(dir, "a.md"));
    expect(result.stat).toEqual({
      dev: stat.dev,
      ino: stat.ino,
      size: raw.length,
      mode: stat.mode,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      nlink: stat.nlink,
    });
    expect(readRegular(dir, "a.md")).toEqual({ text: raw.toString("utf8"), stat: result.stat });
    expect(Buffer.from(readRegular(dir, "a.md").text).equals(raw)).toBe(false);
    // Returned bytes are caller-owned, not magically immutable and not a cache.
    result.bytes.fill(0);
    expect(fs.readFileSync(join(dir, "a.md")).equals(raw)).toBe(true);
    expect(readRegularBytes(dir, "a.md").bytes.equals(raw)).toBe(true);
  });

  it("accepts empty files at a zero limit and the exact boundary, refuses limit+1 without truncation", () => {
    const dir = root();
    fs.writeFileSync(join(dir, "empty.md"), Buffer.alloc(0));
    expect(readRegularBytes(dir, "empty.md", { maxBytes: 0 }).bytes).toEqual(Buffer.alloc(0));
    fs.writeFileSync(join(dir, "a.md"), Buffer.from([0, 1, 2, 255]));
    expect(readRegularBytes(dir, "a.md", { maxBytes: 4 }).bytes).toEqual(Buffer.from([0, 1, 2, 255]));
    const read = vi.spyOn(fs, "readSync");
    const close = vi.spyOn(fs, "closeSync");
    expect(() => readRegularBytes(dir, "a.md", { maxBytes: 3 })).toThrow(/limit/);
    expect(read).not.toHaveBeenCalled(); // stat bound checked BEFORE any content read
    expect(close).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(join(dir, "a.md"))).toEqual(Buffer.from([0, 1, 2, 255]));
  });

  it("uses a finite 64 MiB default ceiling before reading a sparse over-limit file", () => {
    const dir = root();
    const fd = fs.openSync(join(dir, "large.md"), "w");
    try {
      fs.ftruncateSync(fd, 64 * 1024 * 1024 + 1);
    } finally {
      fs.closeSync(fd);
    }
    const read = vi.spyOn(fs, "readSync");
    const alloc = vi.spyOn(Buffer, "alloc");
    expect(() => readRegularBytes(dir, "large.md")).toThrow(/limit/);
    expect(read).not.toHaveBeenCalled();
    expect(alloc).not.toHaveBeenCalled();
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, 64 * 1024 * 1024 + 1, null, "4"])(
    "rejects invalid/unbounded maxBytes %s before opening",
    (maxBytes) => {
      const dir = root();
      const open = vi.spyOn(fs, "openSync");
      expect(() => readRegularBytes(dir, "missing.md", { maxBytes: maxBytes as number })).toThrow(
        /invalid raw read limit/,
      );
      expect(open).not.toHaveBeenCalled();
    },
  );

  it.each(["", ".", "..", "../outside.md", "a/b.md", "a\0b"])("rejects non-basename %j before opening", (name) => {
    const dir = root();
    const open = vi.spyOn(fs, "openSync");
    expect(() => readRegularBytes(dir, name)).toThrow(/bad-name/);
    expect(open).not.toHaveBeenCalled();
  });

  it("refuses live and dangling symlinks, and non-regular directory entries, without reading", () => {
    const dir = root();
    fs.writeFileSync(join(dir, "a.md"), "private bytes");
    fs.symlinkSync(join(dir, "a.md"), join(dir, "link.md"));
    fs.symlinkSync(join(dir, "missing.md"), join(dir, "dangling.md"));
    fs.mkdirSync(join(dir, "directory.md"));
    const read = vi.spyOn(fs, "readSync");
    for (const name of ["link.md", "dangling.md"]) expect(() => readRegularBytes(dir, name)).toThrow(/symlink/);
    expect(() => readRegularBytes(dir, "directory.md")).toThrow(/not a regular file/);
    expect(read).not.toHaveBeenCalled();
  });

  it("uses no-follow/nonblocking open and bounded chunks, including the EOF probe", () => {
    const dir = root();
    const raw = Buffer.alloc(128 * 1024 + 3, 0xff);
    fs.writeFileSync(join(dir, "a.md"), raw);
    const read = fs.readSync;
    const lengths: number[] = [];
    // Force partial reads too; one read syscall must not be assumed to fill a buffer.
    vi.spyOn(fs, "readSync").mockImplementation(((fd, buffer, offset, length, position) => {
      lengths.push(length);
      return read(fd, buffer, offset, Math.min(length, 997), position);
    }) as typeof fs.readSync);
    const open = vi.spyOn(fs, "openSync");
    const close = vi.spyOn(fs, "closeSync");
    expect(readRegularBytes(dir, "a.md", { maxBytes: raw.length }).bytes).toEqual(raw);
    const flags = open.mock.calls[0]![1] as number;
    expect(flags & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
    expect(flags & fs.constants.O_NONBLOCK).toBe(fs.constants.O_NONBLOCK);
    expect(Math.max(...lengths)).toBe(64 * 1024);
    expect(lengths.at(-1)).toBe(1);
    expect(lengths.length).toBeGreaterThan(100);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("refuses growth during the read rather than silently returning a truncated snapshot", () => {
    const dir = root();
    fs.writeFileSync(join(dir, "a.md"), "abc");
    duringFirstRead(() => fs.appendFileSync(join(dir, "a.md"), "d"));
    const close = vi.spyOn(fs, "closeSync");
    expect(() => readRegularBytes(dir, "a.md", { maxBytes: 3 })).toThrow(/growth/);
    expect(close).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(join(dir, "a.md"), "utf8")).toBe("abcd");
  });

  it("refuses shrinkage observed by the post-read stat even when original bytes were already read", () => {
    const dir = root();
    fs.writeFileSync(join(dir, "a.md"), "abcd");
    duringFirstRead(() => fs.truncateSync(join(dir, "a.md"), 2));
    expect(() => readRegularBytes(dir, "a.md")).toThrow(/changed during raw read/);
    expect(fs.readFileSync(join(dir, "a.md"), "utf8")).toBe("ab");
  });

  it("refuses an early EOF/short read and closes the descriptor", () => {
    const dir = root();
    fs.writeFileSync(join(dir, "a.md"), "abc");
    vi.spyOn(fs, "readSync").mockReturnValueOnce(0);
    const close = vi.spyOn(fs, "closeSync");
    expect(() => readRegularBytes(dir, "a.md")).toThrow(/short read/);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each(["replacement", "symlink"])("refuses a path %s after opening the original inode", (kind) => {
    const dir = root();
    fs.writeFileSync(join(dir, "a.md"), "abc");
    fs.writeFileSync(join(dir, "other.md"), "abc");
    duringFirstRead(() => {
      fs.renameSync(join(dir, "a.md"), join(dir, "old.md"));
      if (kind === "symlink") fs.symlinkSync(join(dir, "other.md"), join(dir, "a.md"));
      else fs.renameSync(join(dir, "other.md"), join(dir, "a.md"));
    });
    expect(() => readRegularBytes(dir, "a.md")).toThrow(/changed during raw read/);
    expect(fs.readFileSync(join(dir, "old.md"), "utf8")).toBe("abc");
  });

  it("refuses same-size edits signalled by metadata and does not claim an atomic snapshot", () => {
    const dir = root();
    fs.writeFileSync(join(dir, "a.md"), "abc");
    duringFirstRead(() => {
      fs.writeFileSync(join(dir, "a.md"), "xyz");
      fs.utimesSync(join(dir, "a.md"), new Date(0), new Date(0));
    });
    expect(() => readRegularBytes(dir, "a.md")).toThrow(/changed during raw read/);
    expect(fs.readFileSync(join(dir, "a.md"), "utf8")).toBe("xyz");
  });

  it("propagates read failures while closing the descriptor, with no file mutation", () => {
    const dir = root();
    fs.writeFileSync(join(dir, "a.md"), "abc");
    const error = new Error("injected read error");
    vi.spyOn(fs, "readSync").mockImplementationOnce(() => {
      throw error;
    });
    const close = vi.spyOn(fs, "closeSync");
    expect(() => readRegularBytes(dir, "a.md")).toThrow(error);
    expect(close).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(join(dir, "a.md"), "utf8")).toBe("abc");
  });
});

// Compile-only negative cases. Never run as a validator or counted as runtime
// tests. Unused @ts-expect-error directives FAIL strict tsc if the types weaken.
function compileTimeContracts(base: RevisionProposalBase, provenance: ClientProvenance): void {
  const file: ApplyObservation = {
    kind: "applied",
    expectedAfter: { kind: "file", digest: "sha256", rev: "rev" },
    proof: "rename-observed",
  };
  const link: ApplyObservation = { ...file, proof: "link-observed" };
  const missing: ApplyObservation = { kind: "applied", expectedAfter: { kind: "missing" }, proof: "unlink-observed" };
  const missingLinkInput = { kind: "applied", expectedAfter: { kind: "missing" }, proof: "link-observed" } as const;
  // @ts-expect-error A trash link alone does not prove source deletion.
  const missingLink: ApplyObservation = missingLinkInput;
  const missingRenameInput = {
    kind: "applied",
    expectedAfter: { kind: "missing" },
    proof: "rename-observed",
  } as const;
  // @ts-expect-error Rename cannot prove the source-unlink boundary for missing.
  const missingRename: ApplyObservation = missingRenameInput;
  const fileUnlinkInput = {
    kind: "applied",
    expectedAfter: { kind: "file", digest: "sha256", rev: "rev" },
    proof: "unlink-observed",
  } as const;
  // @ts-expect-error Unlink is not a file creation/replacement observation.
  const fileUnlink: ApplyObservation = fileUnlinkInput;
  const fakeMissingInput = {
    kind: "applied",
    expectedAfter: { kind: "missing", digest: "fake", rev: "fake" },
    proof: "unlink-observed",
  } as const;
  // @ts-expect-error No invented digest/rev for a missing expected target.
  const fakeMissing: ApplyObservation = fakeMissingInput;
  const fileNoRevInput = {
    kind: "applied",
    expectedAfter: { kind: "file", digest: "sha256" },
    proof: "rename-observed",
  } as const;
  // @ts-expect-error File observations require BOTH precise digest and rev.
  const fileNoRev: ApplyObservation = fileNoRevInput;
  const missingBytesInput = { kind: "missing", raw: Buffer.from("fake"), digest: "fake", rev: "fake" } as const;
  // @ts-expect-error Expected missing has no raw bytes/digest/rev.
  const missingBytes: ExpectedAfter = missingBytesInput;
  const generated: RevisionProposal = {
    ...base,
    action: "rewrite-single",
    generatedBody: "body",
    outputDigest: "sha256",
    generationProvenance: provenance,
    generationInputComplete: false,
  };
  const suggestion: RevisionProposal = { ...base, action: "rewrite-single" };
  const halfGeneratedInput = { ...base, action: "rewrite-single", generatedBody: "body" } as const;
  // @ts-expect-error No half-populated generation bundle.
  const halfGenerated: RevisionProposal = halfGeneratedInput;
  const lostCompletenessInput = {
    ...base,
    action: "rewrite-single",
    generatedBody: "body",
    outputDigest: "sha256",
    generationProvenance: provenance,
  } as const;
  // @ts-expect-error B's inputComplete must survive generation into the proposal.
  const lostCompleteness: RevisionProposal = lostCompletenessInput;
  const noExpiryInput = { ...base, action: "expires" } as const;
  // @ts-expect-error Expires requires frozen payload, not a date to compute later.
  const noExpiry: RevisionProposal = noExpiryInput;
  const clearDateInput = {
    ...base,
    action: "expires",
    expiry: { op: "clear", dateRuleVersion: "v1", nextExpires: "2026-11-11" },
  } as const;
  // @ts-expect-error Clear cannot carry a set date.
  const clearDate: RevisionProposal = clearDateInput;
  const deleteBodyInput = { ...generated, action: "delete" } as const;
  // @ts-expect-error Delete does not carry generated body.
  const deleteBody: RevisionProposal = deleteBodyInput;
  void [
    file,
    link,
    missing,
    missingLink,
    missingRename,
    fileUnlink,
    fakeMissing,
    fileNoRev,
    missingBytes,
    generated,
    suggestion,
    halfGenerated,
    lostCompleteness,
    noExpiry,
    clearDate,
    deleteBody,
  ];
}
void compileTimeContracts;
