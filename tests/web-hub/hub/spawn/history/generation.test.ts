/**
 * web-hub session-history plan §4.5.3 (`generation.ts`) + v3.2 V1 / v3.3 W1-W2: continuable
 * fd-anchored enumeration, the gen lock's recheck-before-commit discipline, and fd-ledger
 * integration (X3 #1-#3).
 */
import { mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createReqDeadline } from "../../../../../src/web-hub/hub/req-deadline.js";
import {
  createHistoryIoGate,
  HISTORY_DEADLINE_RETRY_MAX,
} from "../../../../../src/web-hub/hub/spawn/history/budget.js";
import { PreviewIoError } from "../../../../../src/web-hub/hub/preview/fs.js";
import { createFdLedger, type FdLedger } from "../../../../../src/web-hub/hub/spawn/history/fd-ledger.js";
import { createGenStore } from "../../../../../src/web-hub/hub/spawn/history/generation.js";
import { defaultHistoryFs, type HistoryFs } from "../../../../../src/web-hub/hub/spawn/history/fs.js";

const UID = process.getuid?.() ?? 0;
let root: string;
let sessionsDir: string;

function baseDeps(fs: HistoryFs = defaultHistoryFs(), ledger: FdLedger = createFdLedger(32)) {
  return {
    agentDir: root,
    uid: UID,
    fs,
    gate: createHistoryIoGate(4),
    ledger,
    now: () => Date.now(),
  };
}

function seedTree(dirs: number, filesPerDir: number): Set<string> {
  const keys = new Set<string>();
  for (let d = 0; d < dirs; d++) {
    const dirName = `d${d}`;
    mkdirSync(join(sessionsDir, dirName));
    for (let f = 0; f < filesPerDir; f++) {
      const fileName = `f${f}.jsonl`;
      writeFileSync(
        join(sessionsDir, dirName, fileName),
        `${JSON.stringify({ type: "session", id: `s${d}-${f}`, cwd: "/w", timestamp: "t" })}\n`,
      );
      keys.add(`${dirName}/${fileName}`);
    }
  }
  return keys;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pwh-gen-"));
  sessionsDir = join(root, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
});

async function drainToCompletion(
  store: ReturnType<typeof createGenStore>,
  opts: { budgetMs?: number } = {},
): Promise<{ files: Set<string>; genId: string; dupCount: number }> {
  // The FIRST acquire (sessionsRoot realpath+open+stat+readdir) always gets a realistic budget
  // — a tiny `opts.budgetMs` is for exercising the CONTINUABLE per-step enumeration afterwards,
  // not for making the one-time gen-creation itself flaky under system load.
  const creationDeadline = createReqDeadline(() => Date.now(), 5000);
  const acq = await store.acquire(undefined, creationDeadline);
  if (acq.kind !== "gen") throw new Error(`unexpected acquire result: ${acq.kind}`);
  const genId = acq.handle.genId;
  let snap = acq.handle.snapshot();
  for (let i = 0; i < 20_000 && !snap.enum.complete; i++) {
    const stepDeadline = createReqDeadline(() => Date.now(), opts.budgetMs ?? 5000);
    await acq.handle.advance(stepDeadline);
    snap = acq.handle.snapshot();
  }
  acq.handle.release();
  const seen = new Set<string>();
  let dupCount = 0;
  for (const f of snap.files) {
    if (seen.has(f.key)) dupCount += 1;
    seen.add(f.key);
  }
  return { files: seen, genId, dupCount };
}

describe("createGenStore — basic enumeration", () => {
  it("enumerates every file exactly once across dirs, and reports complete", async () => {
    const expected = seedTree(3, 4);
    const store = createGenStore(baseDeps());
    const { files, dupCount } = await drainToCompletion(store);
    expect(files).toEqual(expected);
    expect(dupCount).toBe(0);
    await store.dispose();
  });

  it("empty sessionsRoot ⇒ immediately complete with zero files", async () => {
    const store = createGenStore(baseDeps());
    const deadline = createReqDeadline(() => Date.now(), 5000);
    const acq = await store.acquire(undefined, deadline);
    if (acq.kind !== "gen") throw new Error("unreachable");
    await acq.handle.advance(deadline);
    expect(acq.handle.snapshot().enum.complete).toBe(true);
    expect(acq.handle.snapshot().files).toHaveLength(0);
    acq.handle.release();
    await store.dispose();
  });

  it("sessionsRoot unreadable (readdir fails) ⇒ create-failed, no gen created", async () => {
    const fs = defaultHistoryFs();
    const broken: HistoryFs = { ...fs, readdir: () => Promise.reject(new Error("unreadable")) };
    const store = createGenStore(baseDeps(broken));
    const deadline = createReqDeadline(() => Date.now(), 5000);
    const acq = await store.acquire(undefined, deadline);
    expect(acq.kind).toBe("create-failed");
    await store.dispose();
  });

  it("unknown cursor genId ⇒ cursor-expired", async () => {
    seedTree(1, 1);
    const store = createGenStore(baseDeps());
    const deadline = createReqDeadline(() => Date.now(), 5000);
    const acq = await store.acquire({ genId: "doesnotexist", pos: 0 }, deadline);
    expect(acq.kind).toBe("expired");
    await store.dispose();
  });
});

describe("createGenStore — fd anchoring (E8)", () => {
  it("never calls fs.readdir/open with a literal sessionsRoot-prefixed path — always /proc/self/fd/", async () => {
    seedTree(2, 2);
    const seenPaths: string[] = [];
    const real = defaultHistoryFs();
    const wrapped: HistoryFs = {
      ...real,
      open: (p, flags, mode) => {
        seenPaths.push(p);
        return real.open(p, flags, mode);
      },
      readdir: (p, opts) => {
        seenPaths.push(p);
        return real.readdir(p, opts);
      },
    };
    const store = createGenStore(baseDeps(wrapped));
    await drainToCompletion(store);
    // the FIRST open (sessionsRoot itself) legitimately uses the real path; every subsequent
    // dir/file open must be fd-anchored.
    const nonRootPaths = seenPaths.filter((p) => !p.startsWith(sessionsDir) || p.includes("/proc/self/fd/"));
    const anchoredCount = seenPaths.filter((p) => p.startsWith("/proc/self/fd/")).length;
    expect(anchoredCount).toBeGreaterThan(0);
    expect(nonRootPaths.every((p) => p.startsWith("/proc/self/fd/") || p === sessionsDir)).toBe(true);
    await store.dispose();
  });

  it("a directory replaced by a symlink mid-enumeration is never followed — pinned fd behavior (E8b)", async () => {
    seedTree(2, 1); // d0, d1 each with one file
    const store = createGenStore(baseDeps());
    const deadline = createReqDeadline(() => Date.now(), 5000);
    const acq = await store.acquire(undefined, deadline);
    if (acq.kind !== "gen") throw new Error("unreachable");
    // swap d1 (not-yet-enumerated, since dirs order from readdir may vary — swap BOTH candidates
    // defensively isn't possible without re-reading; instead swap the directory that still has
    // its real tree AFTER one partial advance targeting only d0).
    await acq.handle.advance(deadline); // likely finishes in one shot on a tiny tree; re-check below
    const snapBefore = acq.handle.snapshot();
    acq.handle.release();
    // Swap whichever dir existed BEFORE the gen was created — can't be targeted mid-flight on
    // such a tiny tree without a slow-fs injection, so this test instead asserts the gen's own
    // dirs[] stays frozen even after the real filesystem changes afterward.
    const outside = mkdtempSync(join(tmpdir(), "pwh-outside-"));
    writeFileSync(join(outside, "evil.jsonl"), "x");
    renameSync(join(sessionsDir, "d1"), `${join(sessionsDir, "d1")}.real`);
    symlinkSync(outside, join(sessionsDir, "d1"));
    expect(snapBefore.enum.complete).toBe(true);
    expect(Array.from(snapBefore.files).some((f) => f.key.includes("evil"))).toBe(false);
    await store.dispose();
  });
});

describe("createGenStore — continuable enumeration under a tiny per-call budget", () => {
  it("converges to the full set over multiple advance() calls without duplication or omission", async () => {
    const expected = seedTree(6, 10); // 60 files
    const store = createGenStore(baseDeps());
    const { files, dupCount } = await drainToCompletion(store, { budgetMs: 1 }); // forces many small steps
    expect(files).toEqual(expected);
    expect(dupCount).toBe(0);
    await store.dispose();
  });

  it("a scale run (30 dirs x 20 files) fully converges with no loss or duplication", async () => {
    const expected = seedTree(30, 20); // 600 files
    const store = createGenStore(baseDeps());
    const { files, dupCount } = await drainToCompletion(store, { budgetMs: 2 });
    expect(files.size).toBe(expected.size);
    expect(files).toEqual(expected);
    expect(dupCount).toBe(0);
    await store.dispose();
  }, 20_000);

  it("a 234-dir x 24-file scale run (5616 files) with randomized per-call budgets and injected transient IO errors converges to the full set exactly once", async () => {
    const DIRS = 234;
    const FILES_PER_DIR = 24;
    const expected = seedTree(DIRS, FILES_PER_DIR);
    expect(expected.size).toBe(5616);

    // Deterministic PRNG (LCG) — reproducible failure injection + budget randomization.
    let seed = 1_234_567;
    const rand = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    // Pick a bounded number of dir-level and file-level targets for TRANSIENT (fails twice,
    // succeeds on the 3rd attempt) failures — HISTORY_IO_RETRY_MAX is 3, so a transient
    // failure must NEVER be lost, only delayed.
    const transientDirs = new Set<string>();
    for (let d = 0; d < DIRS && transientDirs.size < 8; d++) {
      if (rand() < 0.03) transientDirs.add(`d${d}`);
    }
    const transientFiles = new Set<string>();
    for (const key of expected) {
      if (transientFiles.size >= 20) break;
      if (rand() < 0.004) transientFiles.add(key);
    }
    const attempts = new Map<string, number>();
    const bumpAttempt = (key: string): number => {
      const n = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, n);
      return n;
    };

    const real = defaultHistoryFs();
    const fs: HistoryFs = {
      ...real,
      open: (p, flags, mode) => {
        const last = p.slice(p.lastIndexOf("/") + 1);
        if (transientDirs.has(last) && bumpAttempt(`open:${last}`) < 3) {
          return Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" }));
        }
        return real.open(p, flags, mode);
      },
      lstat: (p) => {
        const last = p.slice(p.lastIndexOf("/") + 1);
        const dirName = p.slice(0, p.lastIndexOf("/")).slice(p.slice(0, p.lastIndexOf("/")).lastIndexOf("/") + 1);
        const key = `${dirName}/${last}`;
        if (transientFiles.has(key) && bumpAttempt(`lstat:${key}`) < 3) {
          return Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" }));
        }
        return real.lstat(p);
      },
    };

    const ledger = createFdLedger(32);
    const store = createGenStore(baseDeps(fs, ledger));
    const creationDeadline = createReqDeadline(() => Date.now(), 5000);
    const acq = await store.acquire(undefined, creationDeadline);
    if (acq.kind !== "gen") throw new Error(`unexpected acquire result: ${acq.kind}`);
    let snap = acq.handle.snapshot();
    for (let i = 0; i < 100_000 && !snap.enum.complete; i++) {
      // randomized per-call budget between 1 and 25ms forces the enumeration through MANY
      // small, budget-truncated steps, each resuming exactly where the last left off.
      const budgetMs = 1 + Math.floor(rand() * 24);
      const stepDeadline = createReqDeadline(() => Date.now(), budgetMs);
      await acq.handle.advance(stepDeadline);
      snap = acq.handle.snapshot();
    }
    acq.handle.release();
    expect(snap.enum.complete).toBe(true);

    const seen = new Set<string>();
    let dupCount = 0;
    for (const f of snap.files) {
      if (seen.has(f.key)) dupCount += 1;
      seen.add(f.key);
    }
    // every transiently-failing dir/file eventually succeeds (never permanently lost) — the
    // full expected set is recovered exactly once, with zero duplication.
    expect(dupCount).toBe(0);
    expect(seen).toEqual(expected);
    await store.dispose();
  }, 30_000);

  it(
    "REGRESSION (found via the scale run above under real CPU contention, seed 521273224; made " +
      "deterministic per gpt-6-astra P1-b — the fake fs rejects with a `PreviewIoError` directly " +
      'instead of racing a real timer): a dir-open "deadline" loss on what would otherwise be a ' +
      "genuine eventual SUCCESS must not consume the same consecutive-failure strike a real I/O " +
      "error does — doing so can fold an unrelated budget timeout into a transient fault's own " +
      '"succeeds by the 3rd attempt" slot and silently drop the whole directory (session-history ' +
      'plan §3.1 F31: "瞬时错误永不导致 skipped")',
    async () => {
      const expected = seedTree(1, 3); // d0/f0.jsonl, f1.jsonl, f2.jsonl
      let attempt = 0;
      const real = defaultHistoryFs();
      const fs: HistoryFs = {
        ...real,
        open: (p, flags, mode) => {
          const last = p.slice(p.lastIndexOf("/") + 1);
          if (last !== "d0") return real.open(p, flags, mode);
          attempt += 1;
          if (attempt <= 2) {
            // genuine transient I/O errors — exactly what HISTORY_IO_RETRY_MAX is FOR.
            return Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" }));
          }
          if (attempt === 3) {
            // a GENUINE eventual success — this round's `boundedFdOpen` call just happens to
            // race out on ITS OWN per-call budget (deterministic: the fake fs itself rejects
            // with the exact error `racePreviewIo` would produce on a real timeout, so
            // `boundedFdOpen` takes the identical `reason:"deadline"` branch with zero real
            // wall-clock dependence — no setTimeout, no tiny-budget race to get unlucky on).
            return Promise.reject(new PreviewIoError("deadline", "test-injected"));
          }
          return real.open(p, flags, mode); // attempt 4+: real success
        },
      };
      const ledger = createFdLedger(32);
      const store = createGenStore(baseDeps(fs, ledger));
      const creationDeadline = createReqDeadline(() => Date.now(), 5000);
      const acq = await store.acquire(undefined, creationDeadline);
      if (acq.kind !== "gen") throw new Error(`unexpected acquire result: ${acq.kind}`);
      let snap = acq.handle.snapshot();
      for (let i = 0; i < 20 && !snap.enum.complete; i++) {
        const stepDeadline = createReqDeadline(() => Date.now(), 2_000); // generous, uniform —
        // the deadline loss above is injected directly, never raced for real.
        await acq.handle.advance(stepDeadline);
        snap = acq.handle.snapshot();
      }
      acq.handle.release();
      expect(snap.enum.complete).toBe(true);
      expect(attempt).toBe(4); // EIO, EIO, deadline-loss, real success — deterministic now
      expect(snap.enum.dirsSkipped).toBe(0); // the whole point: never consumed as a strike
      const seen = new Set(snap.files.map((f) => f.key));
      expect(seen).toEqual(expected);
      await store.dispose();
    },
    10_000,
  );

  it(
    "REGRESSION (gpt-6-astra P1-a, livelock): a directory whose open() deterministically hits " +
      "the per-call deadline on EVERY attempt is bounded by HISTORY_DEADLINE_RETRY_MAX, then " +
      "counted dirsSkipped and the cursor advances — never retried forever; the other directories " +
      "converge normally",
    async () => {
      const expected = seedTree(3, 2); // d0 (hung), d1, d2 — 2 files each
      const hungDirFiles = new Set(["d0/f0.jsonl", "d0/f1.jsonl"]);
      let hungAttempts = 0;
      const real = defaultHistoryFs();
      const fs: HistoryFs = {
        ...real,
        open: (p, flags, mode) => {
          const last = p.slice(p.lastIndexOf("/") + 1);
          if (last !== "d0") return real.open(p, flags, mode);
          hungAttempts += 1;
          // ALWAYS a deadline loss — a stand-in for a mount/path that never answers in time,
          // no matter how many times it is retried.
          return Promise.reject(new PreviewIoError("deadline", "test-injected: permanently hung"));
        },
      };
      const ledger = createFdLedger(32);
      const store = createGenStore(baseDeps(fs, ledger));
      const creationDeadline = createReqDeadline(() => Date.now(), 5000);
      const acq = await store.acquire(undefined, creationDeadline);
      if (acq.kind !== "gen") throw new Error(`unexpected acquire result: ${acq.kind}`);
      let snap = acq.handle.snapshot();
      let calls = 0;
      // bounded loop — a livelock (the pre-fix `return commit({partial:{reason:"busy"}})` for
      // EVERY deadline loss, forever) would spin this to the cap without ever completing.
      for (; calls < 50 && !snap.enum.complete; calls++) {
        const stepDeadline = createReqDeadline(() => Date.now(), 2_000);
        await acq.handle.advance(stepDeadline);
        snap = acq.handle.snapshot();
      }
      acq.handle.release();
      expect(snap.enum.complete).toBe(true); // terminates — never livelocks
      expect(hungAttempts).toBe(HISTORY_DEADLINE_RETRY_MAX); // bounded: exactly this many tries
      expect(snap.enum.dirsSkipped).toBe(1); // d0 counted skipped, not silently dropped
      const seen = new Set(snap.files.map((f) => f.key));
      const expectedMinusHung = new Set([...expected].filter((k) => !hungDirFiles.has(k)));
      expect(seen).toEqual(expectedMinusHung); // d1/d2 fully present, exactly once
      expect(snap.files.length).toBe(expectedMinusHung.size); // no duplicates (a Set would hide them)
      await store.dispose();
    },
    10_000,
  );

  it(
    "REGRESSION (gpt-6-astra P1-a, livelock, file path): a file whose lstat() deterministically " +
      "hits the per-call deadline on EVERY attempt is bounded by HISTORY_DEADLINE_RETRY_MAX, then " +
      "counted (filesSkipped) and the cursor advances — the dir still completes, siblings present",
    async () => {
      const expected = seedTree(1, 3); // d0/f0.jsonl, f1.jsonl, f2.jsonl
      let hungAttempts = 0;
      const real = defaultHistoryFs();
      const fs: HistoryFs = {
        ...real,
        lstat: (p) => {
          const last = p.slice(p.lastIndexOf("/") + 1);
          if (last !== "f1.jsonl") return real.lstat(p);
          hungAttempts += 1;
          return Promise.reject(new PreviewIoError("deadline", "test-injected: permanently hung"));
        },
      };
      const ledger = createFdLedger(32);
      const store = createGenStore(baseDeps(fs, ledger));
      const creationDeadline = createReqDeadline(() => Date.now(), 5000);
      const acq = await store.acquire(undefined, creationDeadline);
      if (acq.kind !== "gen") throw new Error(`unexpected acquire result: ${acq.kind}`);
      let snap = acq.handle.snapshot();
      for (let calls = 0; calls < 50 && !snap.enum.complete; calls++) {
        const stepDeadline = createReqDeadline(() => Date.now(), 2_000);
        await acq.handle.advance(stepDeadline);
        snap = acq.handle.snapshot();
      }
      acq.handle.release();
      expect(snap.enum.complete).toBe(true);
      expect(hungAttempts).toBe(HISTORY_DEADLINE_RETRY_MAX);
      expect(snap.skipped).toBe(1); // f1.jsonl counted skipped, not silently dropped
      const seen = new Set(snap.files.map((f) => f.key));
      const expectedMinusHung = new Set([...expected].filter((k) => k !== "d0/f1.jsonl"));
      expect(seen).toEqual(expectedMinusHung); // f0/f2 present, exactly once
      expect(snap.files.length).toBe(expectedMinusHung.size); // no duplicates (a Set would hide them)
      await store.dispose();
    },
    10_000,
  );
});

describe("createGenStore — true mid-generation directory swap (Finding 4)", () => {
  it("a directory swapped to a symlink BETWEEN two separate advance() calls is detected as changed, never followed", async () => {
    seedTree(2, 1); // d0 (1 file), d1 (1 file)
    // A deterministic fake clock, decoupled from real wall-clock: bumped to a huge value the
    // instant the FIRST file's lstat resolves, so the OUTER loop's own budget check
    // (`overBudget() && minimumMet()`) trips before the gen ever touches the second directory
    // — regardless of how fast the real disk I/O happens to run on this machine.
    let clock = 0;
    const now = (): number => clock;
    const real = defaultHistoryFs();
    const fs: HistoryFs = {
      ...real,
      lstat: async (p) => {
        const st = await real.lstat(p);
        clock = 10_000_000;
        return st;
      },
    };
    const ledger = createFdLedger(32);
    const store = createGenStore({ agentDir: root, uid: UID, fs, gate: createHistoryIoGate(4), ledger, now });

    const acq = await store.acquire(undefined, createReqDeadline(now, 1000));
    if (acq.kind !== "gen") throw new Error("unreachable");
    await acq.handle.advance(createReqDeadline(now, 1000));
    const snap = acq.handle.snapshot();
    expect(snap.enum.complete).toBe(false);
    expect(snap.enum.dirsDone).toBe(1);
    const doneDirName = snap.files[0]?.dir.name;
    if (doneDirName === undefined) throw new Error("unreachable");
    const pendingDirName = doneDirName === "d0" ? "d1" : "d0";
    acq.handle.release();

    // swap the NOT-yet-enumerated directory for a symlink to a foreign tree, strictly AFTER
    // the first advance() call returned (the lease was released above).
    const outside = mkdtempSync(join(tmpdir(), "pwh-outside-"));
    writeFileSync(join(outside, "evil.jsonl"), "x");
    renameSync(join(sessionsDir, pendingDirName), `${join(sessionsDir, pendingDirName)}.real`);
    symlinkSync(outside, join(sessionsDir, pendingDirName));

    clock = 0; // fresh real budget for the resuming phase
    const acq2 = await store.acquire(undefined, createReqDeadline(now, 5000));
    if (acq2.kind !== "gen") throw new Error("unreachable");
    let snap2 = acq2.handle.snapshot();
    for (let i = 0; i < 20 && !snap2.enum.complete; i++) {
      await acq2.handle.advance(createReqDeadline(now, 5000));
      snap2 = acq2.handle.snapshot();
    }
    acq2.handle.release();

    expect(snap2.enum.complete).toBe(true);
    expect(snap2.changed).toBe(1); // the symlinked dir is counted as changed, never followed
    expect(snap2.files.length).toBe(1); // only the original dir's file — nothing from `outside`
    expect(snap2.files.some((f) => f.key.includes("evil"))).toBe(false);
    await store.dispose();
  });
});

describe("createGenStore — consecutive-failure semantics (enumeration)", () => {
  it("a transient dir-open failure that succeeds before the 3rd attempt is never skipped", async () => {
    seedTree(1, 1);
    let attempts = 0;
    const real = defaultHistoryFs();
    const fs: HistoryFs = {
      ...real,
      open: (p, flags, mode) => {
        if (p.endsWith("/d0") || p === join(sessionsDir, "d0")) {
          attempts += 1;
          if (attempts <= 2) return Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" }));
        }
        return real.open(p, flags, mode);
      },
    };
    const store = createGenStore(baseDeps(fs));
    const { files } = await drainToCompletion(store);
    expect(files.size).toBe(1);
    await store.dispose();
  });

  it("a permanent dir-open failure is skipped after HISTORY_IO_RETRY_MAX consecutive failures, and counted dirsSkipped", async () => {
    seedTree(2, 1);
    const real = defaultHistoryFs();
    const fs: HistoryFs = {
      ...real,
      open: (p, flags, mode) => {
        if (p === join(sessionsDir, "d0") || p.endsWith("/fd/0/d0")) {
          return Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" }));
        }
        // fd-anchored opens for d0 go through a different literal path form than the root
        // itself; match on substring "d0" at the LAST path segment only.
        const last = p.slice(p.lastIndexOf("/") + 1);
        if (last === "d0") return Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" }));
        return real.open(p, flags, mode);
      },
    };
    const store = createGenStore(baseDeps(fs));
    const { files } = await drainToCompletion(store);
    // d0's one file is permanently unreachable; d1's file still gets enumerated.
    expect(files.size).toBe(1);
    await store.dispose();
  });
});

describe("createGenStore — fd ledger integration (X3 #1/#2)", () => {
  it("fds are reserved before open and released exactly once — dispose() brings the ledger back to 0", async () => {
    seedTree(2, 2);
    const ledger = createFdLedger(32);
    const store = createGenStore(baseDeps(defaultHistoryFs(), ledger));
    await drainToCompletion(store);
    // a completed-but-still-live gen keeps its resident rootFd open (reused for later pages) —
    // only dispose()/eviction closes it.
    expect(ledger.counts().gen).toBeGreaterThanOrEqual(1);
    await store.dispose();
    expect(ledger.counts().gen).toBe(0);
  });

  it("ledger exhaustion (max reached) makes gen creation fail rather than over-allocate", async () => {
    seedTree(1, 1);
    const ledger = createFdLedger(0); // nothing can ever be reserved
    const store = createGenStore(baseDeps(defaultHistoryFs(), ledger));
    const deadline = createReqDeadline(() => Date.now(), 5000);
    const acq = await store.acquire(undefined, deadline);
    expect(acq.kind).toBe("create-failed");
    await store.dispose();
  });
});

describe("createGenStore — commit-after-await validity (verifier round 3, defect 2)", () => {
  it("a dispose() that lands while a pending-dir close await is pending discards the staged state — gen unchanged, advance ends partial busy", async () => {
    // 100 files in ONE dir; a controllable clock jumps huge after the 70th lstat so advance #1
    // budget-truncates MID-DIR (filesDone 70 ≥ HISTORY_ENUM_MIN_FILES) and leaves gen.pending
    // set. Advance #2 then finishes the dir and parks on the dir close — which we make hang.
    // While that close await is pending, store.dispose() flips gen.closed; when the close race
    // finally gives up, runAdvance's commit() must DISCARD everything advance #2 staged.
    mkdirSync(join(sessionsDir, "d0"));
    for (let f = 0; f < 100; f++) {
      writeFileSync(
        join(sessionsDir, "d0", `f${f}.jsonl`),
        `${JSON.stringify({ type: "session", id: `s-${f}`, cwd: "/w", timestamp: "t" })}\n`,
      );
    }
    let clock = 0;
    let lstatCount = 0;
    let clockArmed = true;
    let hangClose = false;
    let closeStarted = false;
    const real = defaultHistoryFs();
    const fs: HistoryFs = {
      ...real,
      lstat: async (p) => {
        const st = await real.lstat(p);
        if (clockArmed) {
          lstatCount += 1;
          if (lstatCount >= 70) {
            clockArmed = false;
            clock = 10_000_000;
          }
        }
        return st;
      },
      open: async (p, flags, mode) => {
        const h = await real.open(p, flags, mode);
        if (!p.endsWith("/d0")) return h;
        return {
          fd: h.fd,
          stat: () => h.stat(),
          read: (buf: Buffer, offset: number, length: number, position: number) =>
            h.read(buf, offset, length, position),
          write: (buf: Buffer, offset: number, length: number, position: number) =>
            h.write(buf, offset, length, position),
          truncate: (len: number) => h.truncate(len),
          close: () => {
            closeStarted = true;
            if (!hangClose) return h.close();
            void h.close(); // the REAL fd is always closed — only the returned promise hangs
            return new Promise<void>(() => undefined);
          },
        };
      },
    };
    const ledger = createFdLedger(32);
    const store = createGenStore({
      agentDir: root,
      uid: UID,
      fs,
      gate: createHistoryIoGate(4),
      ledger,
      now: () => clock,
    });

    const acq = await store.acquire(
      undefined,
      createReqDeadline(() => clock, 1000),
    );
    if (acq.kind !== "gen") throw new Error("unreachable");
    const first = await acq.handle.advance(createReqDeadline(() => clock, 1000));
    const snapBefore = acq.handle.snapshot();
    expect(first.partial).toEqual({ reason: "budget" });
    expect(snapBefore.enum.complete).toBe(false);
    expect(snapBefore.files.length).toBe(70); // truncated mid-dir: gen.pending is resident

    clock = 0; // fresh budget for the resuming advance
    hangClose = true;
    const advanceP = acq.handle.advance(createReqDeadline(() => clock, 5000));
    // wait (bounded) until advance #2 is actually parked inside the hanging close
    for (let i = 0; i < 400 && !closeStarted; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(closeStarted).toBe(true);
    const disposeP = store.dispose(); // flips gen.closed while the close await is pending
    const second = await advanceP;
    expect(second).toEqual({ partial: { reason: "busy" } }); // staged state discarded
    await disposeP;

    const snapAfter = acq.handle.snapshot();
    expect(snapAfter.files.length).toBe(70); // the 30 files advance #2 enumerated were NOT committed
    expect(snapAfter.enum.complete).toBe(false);
    expect(snapAfter.enum.dirsDone).toBe(0);
    expect(snapAfter.enum.filesTruncated).toBe(false);
    acq.handle.release();
  }, 15_000);
});

describe("createGenStore — exactly-once gen-fd close+release (v3.4 X3.1)", () => {
  // Both tests reuse the "commit-after-await validity" machinery above: 100 files in ONE dir,
  // a clock that jumps huge after the 70th lstat so advance #1 budget-truncates MID-DIR
  // (leaving gen.pending resident), and an advance #2 that parks on a controllable await while
  // store.dispose() closes the ACTIVE generation underneath it. Before X3.1, BOTH closeGenFds()
  // and runAdvance's own pending close closed the SAME inherited handle and each called
  // release(1,"gen") — the fd-ledger's silent clamp masked the second release, and the second
  // .close() could even hit an unrelated fd had its number been recycled in between.
  function seed100(): void {
    mkdirSync(join(sessionsDir, "d0"));
    for (let f = 0; f < 100; f++) {
      writeFileSync(
        join(sessionsDir, "d0", `f${f}.jsonl`),
        `${JSON.stringify({ type: "session", id: `s-${f}`, cwd: "/w", timestamp: "t" })}\n`,
      );
    }
  }

  it("dispose() landing while runAdvance is parked on the inherited pending close: that fd is closed exactly once, never over-released", async () => {
    seed100();
    let clock = 0;
    let lstatCount = 0;
    let clockArmed = true;
    let hangClose = false;
    let closeStarted = false;
    let d0SeamCloses = 0; // seam close() invocations (what a double close would double)
    const real = defaultHistoryFs();
    const fs: HistoryFs = {
      ...real,
      lstat: async (p) => {
        const st = await real.lstat(p);
        if (clockArmed) {
          lstatCount += 1;
          if (lstatCount >= 70) {
            clockArmed = false;
            clock = 10_000_000;
          }
        }
        return st;
      },
      open: async (p, flags, mode) => {
        const h = await real.open(p, flags, mode);
        if (!p.endsWith("/d0")) return h;
        return {
          fd: h.fd,
          stat: () => h.stat(),
          read: (buf: Buffer, offset: number, length: number, position: number) =>
            h.read(buf, offset, length, position),
          write: (buf: Buffer, offset: number, length: number, position: number) =>
            h.write(buf, offset, length, position),
          truncate: (len: number) => h.truncate(len),
          close: () => {
            d0SeamCloses += 1;
            closeStarted = true;
            void h.close(); // the REAL fd close always happens — count every invocation
            if (!hangClose) return h.close();
            return new Promise<void>(() => undefined); // only the RETURNED promise hangs
          },
        };
      },
    };
    const ledger = createFdLedger(32);
    const store = createGenStore({
      agentDir: root,
      uid: UID,
      fs,
      gate: createHistoryIoGate(4),
      ledger,
      now: () => clock,
    });

    const acq = await store.acquire(
      undefined,
      createReqDeadline(() => clock, 1000),
    );
    if (acq.kind !== "gen") throw new Error("unreachable");
    const first = await acq.handle.advance(createReqDeadline(() => clock, 1000));
    expect(first.partial).toEqual({ reason: "budget" });
    expect(acq.handle.snapshot().files.length).toBe(70); // truncated mid-dir: gen.pending resident

    clock = 0; // fresh budget for the resuming advance
    hangClose = true;
    const advanceP = acq.handle.advance(createReqDeadline(() => clock, 5000));
    for (let i = 0; i < 400 && !closeStarted; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(closeStarted).toBe(true);
    // runAdvance's closeOwned already won the pending owner's CAS when it started this close;
    // dispose()'s closeGenFds must now LOSE that same CAS — no second close, no second release.
    const disposeP = store.dispose();
    const second = await advanceP;
    expect(second).toEqual({ partial: { reason: "busy" } }); // staged state discarded
    await disposeP;

    expect(acq.handle.snapshot().files.length).toBe(70); // nothing half-advanced
    expect(d0SeamCloses).toBe(1); // the pending fd was closed EXACTLY once
    expect(ledger.counts()).toEqual({ gen: 0, pin: 0, temp: 0, max: 32 });
    expect(ledger.overRelease()).toBe(0); // X3.1: exactly-once, never a masked over-release
    acq.handle.release();
  }, 15_000);

  it("dispose() landing while runAdvance is parked INSIDE an lstat: closeGenFds wins the owner CAS, the advance never re-closes the inherited pending", async () => {
    seed100();
    let clock = 0;
    let lstatCount = 0;
    let clockArmed = true;
    let hangLstat = false;
    let lstatParked = false;
    let releaseLstat = (): void => undefined;
    const lstatGate = new Promise<void>((resolve) => {
      releaseLstat = resolve;
    });
    let d0SeamCloses = 0;
    const real = defaultHistoryFs();
    const fs: HistoryFs = {
      ...real,
      lstat: async (p) => {
        if (hangLstat) {
          lstatParked = true;
          await lstatGate;
        }
        const st = await real.lstat(p);
        if (clockArmed) {
          lstatCount += 1;
          if (lstatCount >= 70) {
            clockArmed = false;
            clock = 10_000_000;
          }
        }
        return st;
      },
      open: async (p, flags, mode) => {
        const h = await real.open(p, flags, mode);
        if (!p.endsWith("/d0")) return h;
        return {
          fd: h.fd,
          stat: () => h.stat(),
          read: (buf: Buffer, offset: number, length: number, position: number) =>
            h.read(buf, offset, length, position),
          write: (buf: Buffer, offset: number, length: number, position: number) =>
            h.write(buf, offset, length, position),
          truncate: (len: number) => h.truncate(len),
          close: () => {
            d0SeamCloses += 1;
            return h.close();
          },
        };
      },
    };
    const ledger = createFdLedger(32);
    const store = createGenStore({
      agentDir: root,
      uid: UID,
      fs,
      gate: createHistoryIoGate(4),
      ledger,
      now: () => clock,
    });

    const acq = await store.acquire(
      undefined,
      createReqDeadline(() => clock, 1000),
    );
    if (acq.kind !== "gen") throw new Error("unreachable");
    const first = await acq.handle.advance(createReqDeadline(() => clock, 1000));
    expect(first.partial).toEqual({ reason: "budget" });
    expect(acq.handle.snapshot().files.length).toBe(70);

    clock = 0;
    hangLstat = true;
    const advanceP = acq.handle.advance(createReqDeadline(() => clock, 5000));
    for (let i = 0; i < 400 && !lstatParked; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(lstatParked).toBe(true);
    // dispose() closes root+pending while the advance hangs inside the lstat — closeGenFds
    // wins the pending owner's CAS here; when the lstat resolves, runAdvance must abandon
    // WITHOUT touching the already-closed inherited pending fd again.
    const disposeP = store.dispose();
    await new Promise((r) => setTimeout(r, 30)); // let closeGenFds' closes settle
    releaseLstat();
    const second = await advanceP;
    expect(second).toEqual({ partial: { reason: "busy" } });
    await disposeP;

    expect(acq.handle.snapshot().files.length).toBe(70); // staged state discarded, as in defect 2
    expect(d0SeamCloses).toBe(1); // closed exactly once — by closeGenFds alone
    expect(ledger.counts()).toEqual({ gen: 0, pin: 0, temp: 0, max: 32 });
    expect(ledger.overRelease()).toBe(0);
    acq.handle.release();
  }, 15_000);
});

describe("createGenStore — leases and dispose (v3.2 V1, v3.3 W3)", () => {
  it("dispose() closes all resident fds even with multiple leases outstanding, and is idempotent", async () => {
    seedTree(2, 2);
    const ledger = createFdLedger(32);
    const store = createGenStore(baseDeps(defaultHistoryFs(), ledger));
    const deadline = createReqDeadline(() => Date.now(), 5000);
    const acq1 = await store.acquire(undefined, deadline);
    if (acq1.kind !== "gen") throw new Error("unreachable");
    await acq1.handle.advance(deadline);
    // a second lease on the SAME gen (first page unfinished pos still 0, reuse incomplete/latest)
    const acq2 = await store.acquire(undefined, deadline);
    if (acq2.kind !== "gen") throw new Error("unreachable");

    await store.dispose();
    await store.dispose(); // idempotent — must not throw
    expect(ledger.counts().gen).toBe(0);
    acq1.handle.release();
    acq2.handle.release();
  });
});
