/**
 * web-hub session-history plan §4.5.3 (`index.ts`): the verifier-rejection-round-2 fixes for
 * `page()`'s directory-open fault classification (Finding 3) and the per-file fstat TOCTOU
 * check (Finding 3b). Runs end-to-end through `createHistoryService` on a real tmp filesystem,
 * using a `fs` seam to inject errno/identity faults only at the PAGING layer (enumeration is
 * always allowed to complete fault-free first, via a two-phase on/off switch, so the test
 * targets `index.ts`'s own dir-open classification rather than `generation.ts`'s already-tested
 * enumeration-time classification, which reuses the identical literal open() path shape).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createReqDeadline } from "../../../../../src/web-hub/hub/req-deadline.js";
import { createHistoryService } from "../../../../../src/web-hub/hub/spawn/history/service.js";
import type { HistoryServiceDeps } from "../../../../../src/web-hub/hub/spawn/history/ports.js";
import { defaultHistoryFs, type HistoryFs } from "../../../../../src/web-hub/hub/spawn/history/fs.js";

let root: string;
let sessionsDir: string;
let realCwd: string;

function header(id: string, cwd: string): string {
  return `${JSON.stringify({ type: "session", id, cwd, timestamp: "t" })}\n${JSON.stringify({
    type: "custom",
    customType: "pi-hud-session-start",
  })}\n`;
}

function baseDeps(over: Partial<HistoryServiceDeps> = {}): HistoryServiceDeps {
  return {
    agentDir: root,
    forkSrcDir: join(root, "spawn", "fork-src"),
    registry: { list: () => [] },
    managed: () => [],
    deathOf: () => undefined,
    uid: process.getuid?.() ?? 0,
    hubPid: 424242,
    now: () => Date.now(),
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    ...over,
  };
}

function basenameOf(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx < 0 ? p : p.slice(idx + 1);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pwh-idx-"));
  sessionsDir = join(root, "sessions");
  mkdirSync(join(sessionsDir, "d1"), { recursive: true });
  mkdirSync(join(sessionsDir, "d2"), { recursive: true });
  mkdirSync(join(root, "spawn"), { recursive: true });
  realCwd = mkdtempSync(join(tmpdir(), "pwh-idx-cwd-"));
});

describe("pageHistory — dir-open fault classification (Finding 3)", () => {
  it("a deterministic ENOENT on the paging dir-open is consumed as changed on the FIRST paging attempt (no retry)", async () => {
    writeFileSync(join(sessionsDir, "d1", "a.jsonl"), header("sess-aaaa1", realCwd));
    writeFileSync(join(sessionsDir, "d2", "b.jsonl"), header("sess-bbbb1", realCwd));
    let faultOn = false;
    const real = defaultHistoryFs();
    const fs: HistoryFs = {
      ...real,
      open: (p, flags, mode) => {
        if (faultOn && basenameOf(p) === "d2") {
          return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
        }
        return real.open(p, flags, mode);
      },
    };
    const service = createHistoryService(baseDeps(), { fs });
    // Phase 1: fault OFF — drive enumeration + first paging pass to full completion normally.
    const warm = await service.page(
      { kind: "all", limit: 50 },
      createReqDeadline(() => Date.now(), 5000),
    );
    expect(warm.ok).toBe(true);
    if (warm.ok) {
      expect(warm.page.items.some((i) => i.id === "sess-aaaa1")).toBe(true);
      expect(warm.page.items.some((i) => i.id === "sess-bbbb1")).toBe(true);
      expect(warm.page.stats.changed).toBe(0);
    }

    // Phase 2: fault ON — a FRESH page() re-opens both dirs (index.ts always re-opens the dir
    // per file regardless of a header-index cache hit); d2's open now fails ENOENT.
    faultOn = true;
    const result = await service.page(
      { kind: "all", limit: 50 },
      createReqDeadline(() => Date.now(), 5000),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.items.some((i) => i.id === "sess-aaaa1")).toBe(true);
    expect(result.page.items.some((i) => i.id === "sess-bbbb1")).toBe(false);
    expect(result.page.stats.changed).toBeGreaterThanOrEqual(1);
    await service.dispose();
  });

  it("a TRANSIENT paging dir-open failure that succeeds before the 3rd attempt is never lost", async () => {
    writeFileSync(join(sessionsDir, "d1", "a.jsonl"), header("sess-aaaa1", realCwd));
    writeFileSync(join(sessionsDir, "d2", "b.jsonl"), header("sess-bbbb1", realCwd));
    let faultOn = false;
    let attempts = 0;
    const real = defaultHistoryFs();
    const fs: HistoryFs = {
      ...real,
      open: (p, flags, mode) => {
        if (faultOn && basenameOf(p) === "d2") {
          attempts += 1;
          if (attempts <= 2) return Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" }));
        }
        return real.open(p, flags, mode);
      },
    };
    const service = createHistoryService(baseDeps(), { fs });
    const warm = await service.page(
      { kind: "all", limit: 50 },
      createReqDeadline(() => Date.now(), 5000),
    );
    expect(warm.ok).toBe(true);

    faultOn = true;
    const seenIds = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const page = await service.page(
        { kind: "all", limit: 50 },
        createReqDeadline(() => Date.now(), 5000),
      );
      expect(page.ok).toBe(true);
      if (page.ok) for (const item of page.page.items) seenIds.add(item.id);
    }
    expect(seenIds.has("sess-aaaa1")).toBe(true);
    expect(seenIds.has("sess-bbbb1")).toBe(true); // recovered on the 3rd real attempt, not lost
    expect(attempts).toBeGreaterThanOrEqual(3);
    await service.dispose();
  });

  it("a PERMANENT paging dir-open failure is consumed as changed only once every 3 consecutive attempts, and never blocks the other dir", async () => {
    writeFileSync(join(sessionsDir, "d1", "a.jsonl"), header("sess-aaaa1", realCwd));
    writeFileSync(join(sessionsDir, "d2", "b.jsonl"), header("sess-bbbb1", realCwd));
    let faultOn = false;
    let attempts = 0;
    const real = defaultHistoryFs();
    const fs: HistoryFs = {
      ...real,
      open: (p, flags, mode) => {
        if (faultOn && basenameOf(p) === "d2") {
          attempts += 1;
          return Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" }));
        }
        return real.open(p, flags, mode);
      },
    };
    const service = createHistoryService(baseDeps(), { fs });
    const warm = await service.page(
      { kind: "all", limit: 50 },
      createReqDeadline(() => Date.now(), 5000),
    );
    expect(warm.ok).toBe(true);

    faultOn = true;
    let sawChanged = false;
    for (let i = 0; i < 6; i++) {
      const page = await service.page(
        { kind: "all", limit: 50 },
        createReqDeadline(() => Date.now(), 5000),
      );
      expect(page.ok).toBe(true);
      if (page.ok) {
        expect(page.page.items.some((it2) => it2.id === "sess-bbbb1")).toBe(false); // never faked-read
        if (page.page.stats.changed > 0) sawChanged = true;
      }
    }
    expect(sawChanged).toBe(true);
    expect(attempts).toBeGreaterThanOrEqual(3); // at least a full HISTORY_IO_RETRY_MAX cycle
    await service.dispose();
  });
});

/**
 * Verifier round 3 (defect 1): the paging-time fstat of the JUST-OPENED pinned dir fd. A
 * FAILED stat must only be consumed as deterministic `changed` when its errno proves the dir
 * fd is gone (ENOENT/ENOTDIR/ELOOP); every other failure (EIO, gate busy, the deadline race)
 * is transient — 3-strike consecutive retry, strikes 1–2 keep the position, a success between
 * strikes resets the counter. The stat fault is injected by wrapping `open` so the DIR handle's
 * `stat` rejects/hangs; file opens (basename `*.jsonl`) pass through untouched.
 */
function statFaultFs(
  real: HistoryFs,
  opts: {
    dirName: string;
    faultOn(): boolean;
    onAttempt(): void;
    mode: "eio" | "hang";
  },
): HistoryFs {
  return {
    ...real,
    open: async (p, flags, mode) => {
      const h = await real.open(p, flags, mode);
      if (!opts.faultOn() || basenameOf(p) !== opts.dirName) return h;
      opts.onAttempt();
      return {
        fd: h.fd,
        read: (buf: Buffer, offset: number, length: number, position: number) => h.read(buf, offset, length, position),
        write: (buf: Buffer, offset: number, length: number, position: number) =>
          h.write(buf, offset, length, position),
        truncate: (len: number) => h.truncate(len),
        close: () => h.close(),
        stat: () =>
          opts.mode === "hang"
            ? new Promise<never>(() => undefined) // never settles — the deadline race must fire
            : Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" })),
      };
    },
  };
}

describe("pageHistory — pinned-dir stat failure classification (verifier round 3, defect 1)", () => {
  it("a PERMANENT stat EIO is not consumed on strikes 1–2 (partial io, position kept) and skipped only on the 3rd consecutive", async () => {
    writeFileSync(join(sessionsDir, "d1", "a.jsonl"), header("sess-aaaa1", realCwd));
    writeFileSync(join(sessionsDir, "d2", "b.jsonl"), header("sess-bbbb1", realCwd));
    let faultOn = false;
    let attempts = 0;
    const fs = statFaultFs(defaultHistoryFs(), {
      dirName: "d2",
      faultOn: () => faultOn,
      onAttempt: () => {
        attempts += 1;
      },
      mode: "eio",
    });
    const service = createHistoryService(baseDeps(), { fs });
    const warm = await service.page(
      { kind: "all", limit: 50 },
      createReqDeadline(() => Date.now(), 5000),
    );
    expect(warm.ok).toBe(true);
    if (warm.ok) expect(warm.page.items.some((i) => i.id === "sess-bbbb1")).toBe(true);

    faultOn = true;
    for (let i = 0; i < 2; i++) {
      const page = await service.page(
        { kind: "all", limit: 50 },
        createReqDeadline(() => Date.now(), 5000),
      );
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      expect(page.page.partial).toEqual({ reason: "io" }); // transient — NOT consumed
      expect(page.page.stats.changed).toBe(0);
      expect(page.page.stats.skipped).toBe(0);
      expect(page.page.items.some((it2) => it2.id === "sess-bbbb1")).toBe(false);
    }
    // 3rd consecutive ⇒ skipped (consumed), the other dir still paged.
    const third = await service.page(
      { kind: "all", limit: 50 },
      createReqDeadline(() => Date.now(), 5000),
    );
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.page.stats.skipped).toBeGreaterThanOrEqual(1);
    expect(third.page.items.some((it2) => it2.id === "sess-bbbb1")).toBe(false);
    expect(third.page.items.some((it2) => it2.id === "sess-aaaa1")).toBe(true);
    expect(attempts).toBe(3);
    await service.dispose();
  });

  it("a successful dir stat between strikes RESETS the consecutive counter (needs 3 NEW consecutive failures to consume)", async () => {
    writeFileSync(join(sessionsDir, "d1", "a.jsonl"), header("sess-aaaa1", realCwd));
    writeFileSync(join(sessionsDir, "d2", "b.jsonl"), header("sess-bbbb1", realCwd));
    let faultOn = false;
    const fs = statFaultFs(defaultHistoryFs(), {
      dirName: "d2",
      faultOn: () => faultOn,
      onAttempt: () => undefined,
      mode: "eio",
    });
    const service = createHistoryService(baseDeps(), { fs });
    const warm = await service.page(
      { kind: "all", limit: 50 },
      createReqDeadline(() => Date.now(), 5000),
    );
    expect(warm.ok).toBe(true);

    // two strikes
    faultOn = true;
    for (let i = 0; i < 2; i++) {
      const page = await service.page(
        { kind: "all", limit: 50 },
        createReqDeadline(() => Date.now(), 5000),
      );
      expect(page.ok).toBe(true);
      if (page.ok) expect(page.page.stats.skipped).toBe(0);
    }
    // one success in between — recordPagingSuccess resets the counter, b is actually paged
    faultOn = false;
    const ok = await service.page(
      { kind: "all", limit: 50 },
      createReqDeadline(() => Date.now(), 5000),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.page.items.some((i) => i.id === "sess-bbbb1")).toBe(true);
    // two more strikes — still strikes 1–2 of a FRESH cycle: nothing consumed
    faultOn = true;
    for (let i = 0; i < 2; i++) {
      const page = await service.page(
        { kind: "all", limit: 50 },
        createReqDeadline(() => Date.now(), 5000),
      );
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      expect(page.page.partial).toEqual({ reason: "io" });
      expect(page.page.stats.skipped).toBe(0);
      expect(page.page.items.some((it2) => it2.id === "sess-bbbb1")).toBe(false);
    }
    await service.dispose();
  });

  it("a stat TIMEOUT (never settles) is transient too — the page degrades partial io within its request budget, nothing consumed as changed", async () => {
    writeFileSync(join(sessionsDir, "d1", "a.jsonl"), header("sess-aaaa1", realCwd));
    writeFileSync(join(sessionsDir, "d2", "b.jsonl"), header("sess-bbbb1", realCwd));
    let faultOn = false;
    const fs = statFaultFs(defaultHistoryFs(), {
      dirName: "d2",
      faultOn: () => faultOn,
      onAttempt: () => undefined,
      mode: "hang",
    });
    const service = createHistoryService(baseDeps(), { fs });
    const warm = await service.page(
      { kind: "all", limit: 50 },
      createReqDeadline(() => Date.now(), 5000),
    );
    expect(warm.ok).toBe(true);

    faultOn = true;
    const start = Date.now();
    const page = await service.page(
      { kind: "all", limit: 50 },
      createReqDeadline(() => Date.now(), 400),
    );
    const elapsed = Date.now() - start;
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.page.partial).toEqual({ reason: "io" });
    expect(page.page.stats.changed).toBe(0);
    expect(page.page.stats.skipped).toBe(0);
    expect(page.page.items.some((it2) => it2.id === "sess-bbbb1")).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(350); // the deadline race is what ended the stat
    expect(elapsed).toBeLessThan(5_000); // and it never hung the request
    await service.dispose();
  }, 10_000);
});

describe("pageHistory — per-file fstat TOCTOU check (Finding 3b)", () => {
  it("a file swapped (different dev/ino) between enumeration and paging is counted as changed, never read", async () => {
    writeFileSync(join(sessionsDir, "d1", "a.jsonl"), header("sess-aaaa1", realCwd));
    const real = defaultHistoryFs();
    const fs: HistoryFs = {
      ...real,
      open: async (p, flags, mode) => {
        const h = await real.open(p, flags, mode);
        if (!basenameOf(p).endsWith(".jsonl")) return h;
        return {
          fd: h.fd,
          read: (buf: Buffer, offset: number, length: number, position: number) =>
            h.read(buf, offset, length, position),
          write: (buf: Buffer, offset: number, length: number, position: number) =>
            h.write(buf, offset, length, position),
          truncate: (len: number) => h.truncate(len),
          close: () => h.close(),
          stat: async () => {
            const st = await h.stat();
            // simulate a TOCTOU swap: the paging-time fstat reports a DIFFERENT inode than the
            // one `generation.ts` enumerated.
            return { ...st, ino: st.ino + 999_999 };
          },
        };
      },
    };
    const service = createHistoryService(baseDeps(), { fs });
    const result = await service.page(
      { kind: "all", limit: 50 },
      createReqDeadline(() => Date.now(), 5000),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.items.some((i) => i.id === "sess-aaaa1")).toBe(false);
    expect(result.page.stats.changed).toBeGreaterThanOrEqual(1);
    await service.dispose();
  });

  it("an unchanged file (matching dev/ino/uid/nlink) is read and indexed normally", async () => {
    writeFileSync(join(sessionsDir, "d1", "a.jsonl"), header("sess-aaaa1", realCwd));
    const service = createHistoryService(baseDeps());
    const result = await service.page(
      { kind: "all", limit: 50 },
      createReqDeadline(() => Date.now(), 5000),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.items.some((i) => i.id === "sess-aaaa1")).toBe(true);
    expect(result.page.stats.changed).toBe(0);
    await service.dispose();
  });
});
