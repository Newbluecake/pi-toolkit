import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { consultSessionDir, FORK_TTL_MS, sweepForkDir } from "../../src/consult/fork-store.js";
import {
  LEGACY_FORK_TTL_MS,
  legacyConsultForkDir,
  sweepLegacyConsultForks,
} from "../../src/runtime/legacy-consult-forks.js";
import { resetSecureDomainForTests } from "../../src/secure/domain.js";
import { freezeDomain, makeFakeVault, type FakeVault } from "../secure/helpers.js";

/**
 * #40 P0: the legacy consult fork dir + sweep, migrated verbatim from
 * fork-store. Cases ported from tests/consult/fork-store.test.ts (T-6) plus the
 * plain/secure root and the fork-store delegation (signatures unchanged).
 */

const dirs: string[] = [];
let v: FakeVault | undefined;
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "legacy-forks-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  resetSecureDomainForTests();
  v?.cleanup();
  v = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const header = (id: string, dir: string): string =>
  `${JSON.stringify({ type: "session", version: 3, id, timestamp: "t", cwd: dir })}\n`;

describe("legacyConsultForkDir", () => {
  it("plain domain ⇒ <agentDir>/cache/consult-sessions", () => {
    expect(legacyConsultForkDir()).toBe(join(getAgentDir(), "cache", "consult-sessions"));
    expect(consultSessionDir()).toBe(legacyConsultForkDir());
  });

  it("secure domain ⇒ the in-vault <state>/cache/consult-sessions", () => {
    v = makeFakeVault();
    freezeDomain(v);
    expect(legacyConsultForkDir()).toBe(join(v.state, "cache", "consult-sessions"));
    expect(consultSessionDir()).toBe(legacyConsultForkDir());
  });

  it("TTL is 24h and fork-store re-exports the same value", () => {
    expect(LEGACY_FORK_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(FORK_TTL_MS).toBe(LEGACY_FORK_TTL_MS);
  });
});

describe("sweepLegacyConsultForks", () => {
  function populate(dir: string, now: number) {
    const valid = join(dir, "valid.jsonl");
    writeFileSync(valid, header("s", dir));
    const expired = join(dir, "expired.jsonl");
    writeFileSync(expired, header("s2", dir));
    const freshFragment = join(dir, "fresh-fragment.jsonl"); // _persist reborn after unlink: fresh mtime, no header
    writeFileSync(freshFragment, `${JSON.stringify({ type: "message", id: "m", parentId: null, timestamp: "t" })}\n`);
    const oldFragment = join(dir, "old-fragment.jsonl");
    writeFileSync(oldFragment, "not a session at all\n");
    const past = new Date(now - LEGACY_FORK_TTL_MS - 60_000);
    utimesSync(expired, past, past);
    const older = new Date(now - 3 * LEGACY_FORK_TTL_MS);
    utimesSync(oldFragment, older, older);
    return { valid, expired, freshFragment, oldFragment };
  }

  it("keeps valid files inside the TTL, drops expired files and headerless fragments regardless of mtime", () => {
    const dir = tempDir();
    const now = Date.now();
    const f = populate(dir, now);
    const result = sweepLegacyConsultForks(dir, LEGACY_FORK_TTL_MS, now);
    // oldFragment is both old and headerless — the TTL rule fires first.
    expect(result).toEqual({ removedExpired: 2, removedFragments: 1, kept: 1, errors: 0 });
    expect(existsSync(f.valid)).toBe(true);
    expect(existsSync(f.expired)).toBe(false);
    expect(existsSync(f.freshFragment)).toBe(false); // fragment rule ignores TTL
    expect(existsSync(f.oldFragment)).toBe(false);
  });

  it("works under a secure root and leaves files outside it untouched", () => {
    v = makeFakeVault();
    freezeDomain(v);
    const root = legacyConsultForkDir();
    mkdirSync(root, { recursive: true });
    const now = Date.now();
    const f = populate(root, now);
    const outside = join(v.outside, "keep.jsonl");
    writeFileSync(outside, "not a session\n");
    expect(sweepLegacyConsultForks(undefined, undefined, now)).toEqual({
      removedExpired: 2,
      removedFragments: 1,
      kept: 1,
      errors: 0,
    });
    expect(existsSync(f.valid)).toBe(true);
    expect(existsSync(outside)).toBe(true);
  });

  it("never throws on a missing dir, never touches subdirectories, no-op for an empty dir", () => {
    const zero = { removedExpired: 0, removedFragments: 0, kept: 0, errors: 0 };
    expect(sweepLegacyConsultForks(join(tempDir(), "does-not-exist"))).toEqual(zero);
    const dir = tempDir();
    mkdirSync(join(dir, "subdir"));
    expect(sweepLegacyConsultForks(dir)).toEqual(zero);
    expect(statSync(join(dir, "subdir")).isDirectory()).toBe(true);
  });

  it("header edge cases: header without trailing newline kept, oversized first line and empty file removed", () => {
    const dir = tempDir();
    const noNl = join(dir, "no-newline.jsonl");
    writeFileSync(noNl, header("a", dir).trimEnd());
    const big = join(dir, "big.jsonl");
    writeFileSync(big, `${"y".repeat(9 * 1024)}\n`);
    const empty = join(dir, "empty.jsonl");
    writeFileSync(empty, "");
    const blankFirst = join(dir, "blank-first.jsonl");
    writeFileSync(blankFirst, `\n{ broken\n${header("b", dir)}`);
    expect(sweepLegacyConsultForks(dir)).toEqual({ removedExpired: 0, removedFragments: 2, kept: 2, errors: 0 });
    expect(existsSync(noNl)).toBe(true);
    expect(existsSync(blankFirst)).toBe(true);
    expect(existsSync(big)).toBe(false);
    expect(existsSync(empty)).toBe(false);
  });

  it("fork-store's sweepForkDir delegates with identical results", () => {
    const a = tempDir();
    const b = tempDir();
    const now = Date.now();
    populate(a, now);
    populate(b, now);
    expect(sweepForkDir(a, FORK_TTL_MS, now)).toEqual(sweepLegacyConsultForks(b, LEGACY_FORK_TTL_MS, now));
  });
});
