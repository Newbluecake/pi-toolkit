/**
 * web-resume plan §4 "P2 list" — the bounds as a seeded property test: rows ≤2 000, page
 * ≤100 rows / ≤32 KiB, title ≤120 UTF-16 with C0 scrubbed and surrogate-safe cuts, stable
 * (modifiedMs desc, id asc) order, cursor continuation covering exactly `total`, duplicate ids
 * never surfaced; plus the deterministic 64 MiB / 5 s build caps and the 5 000-file cap.
 */
import { describe, expect, it, onTestFinished } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FileHandle } from "node:fs/promises";
import {
  createResumeList,
  defaultResumeCore,
  RESUME_PAGE_BYTES,
  RESUME_PAGE_ROWS,
  RESUME_ROWS_MAX,
  RESUME_TITLE_MAX_UTF16,
  type ResumeCorePort,
  type ResumeListDeps,
  type ResumeListHandle,
} from "../../../src/web-hub/agent/resume-list.js";
import type { CmdArgs, CmdFrame, CmdOrigin, ResumeSessionsWire } from "../../../src/web-hub/protocol/messages.js";
import { fakeClock, fakeIndex, makeLayout, writeSession, type Layout } from "./resume-fixtures.js";

const ORIGIN: CmdOrigin = { listener: "loopback", ip: "127.0.0.1", reqId: "abcdef0123456789" };
const CWD = "/tmp/web-resume-bounds";

/** Deterministic PRNG (mulberry32) — the property test is fully reproducible from the seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface BoundsHarness {
  handle: ResumeListHandle;
  layout: Layout;
  clock: ReturnType<typeof fakeClock>;
  core: ResumeCorePort;
}

function makeHarness(
  over: {
    onOpen?: () => void;
    fakeSizes?: (path: string) => number | undefined;
  } = {},
): BoundsHarness {
  const layout = makeLayout();
  onTestFinished(() => layout.cleanup());
  const clock = fakeClock(Date.now());
  const base = defaultResumeCore();
  const core: ResumeCorePort = {
    ...base,
    async openSessionNoFollowAsync(path) {
      over.onOpen?.();
      const r = await base.openSessionNoFollowAsync(path);
      if (r === undefined) return undefined;
      const size = over.fakeSizes?.(path);
      const fact = size === undefined ? r.fact : { ...r.fact, size };
      return {
        fact,
        handle: {
          fd: r.handle.fd,
          close: async () => {
            await r.handle.close();
          },
        } as unknown as FileHandle,
      };
    },
    advanceProvenance: async () => fakeIndex(),
  };
  const deps: ResumeListDeps = {
    getSessionDir: () => layout.sessionDir,
    cwd: () => CWD,
    currentSessionId: () => "",
    now: clock.now,
    core,
  };
  return { handle: createResumeList(deps), layout, clock, core };
}

function cmdArgs(args: string): CmdArgs & { op: "command" } {
  return { op: "command", name: "resume", args };
}
function cmdFrame(args: string): CmdFrame {
  return {
    t: "cmd",
    rid: "r-1",
    id: "cmd-0000000000000001",
    deadlineMs: 8_000,
    origin: ORIGIN,
    cmd: cmdArgs(args),
  };
}

async function listOk(h: BoundsHarness, payload: Record<string, unknown>): Promise<ResumeSessionsWire> {
  const args = `__list ${JSON.stringify(payload)}`;
  const r = await h.handle.list(cmdFrame(args), cmdArgs(args));
  expect(r.ok).toBe(true);
  return (r as { data: { sessions: ResumeSessionsWire } }).data.sessions;
}

function isC0(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return c <= 0x1f;
}

describe("resume-list bounds — seeded property (§4 P2 list)", () => {
  for (const seed of [1, 7, 42, 1337, 90210]) {
    it(`invariants hold for seed ${seed}`, async () => {
      const h = makeHarness();
      const rnd = mulberry32(seed);
      const n = 40 + Math.floor(rnd() * 80);
      // model of the row filter: same-cwd non-child files, per-id counts (dup ids all omitted)
      const eligibleCounts = new Map<string, number>();
      const eligibleMtime = new Map<string, number>();
      for (let i = 0; i < n; i += 1) {
        const dup = rnd() < 0.05 && eligibleCounts.size > 0;
        const id = dup ? [...eligibleCounts.keys()][Math.floor(rnd() * eligibleCounts.size)]! : `sid${seed}_${i}`;
        const foreign = !dup && rnd() < 0.15;
        const child = !dup && rnd() < 0.15;
        const named = rnd() < 0.4;
        const payload =
          rnd() < 0.3 ? "den\u0000\u0007ty" : rnd() < 0.6 ? "标题".repeat(30 + Math.floor(rnd() * 60)) : "plain";
        const mtime = new Date(Date.now() - Math.floor(rnd() * 100) * 1_000);
        writeSession(h.layout.sessionDir, `f${i}.jsonl`, {
          id,
          cwd: foreign ? "/tmp/other" : CWD,
          child,
          name: named ? payload : undefined,
          firstMessage: named ? undefined : payload,
          mtime,
        });
        if (!foreign && !child) {
          eligibleCounts.set(id, (eligibleCounts.get(id) ?? 0) + 1);
          eligibleMtime.set(id, mtime.getTime());
        }
      }
      const expectedIds = [...eligibleCounts.entries()].filter(([, c]) => c === 1).map(([id]) => id);
      const ambiguousIds = [...eligibleCounts.entries()].filter(([, c]) => c > 1).length;
      const w = await listOk(h, { scope: "all" });
      // row set: exactly the unique non-dup same-cwd non-sub files, one row each
      expect(new Set(w.rows.map((r) => r.id))).toEqual(new Set(expectedIds));
      expect(w.total).toBe(expectedIds.length);
      expect(w.ambiguous ?? 0).toBe(ambiguousIds);
      // titles: ≤120 UTF-16, C0 scrubbed, no lone surrogate from the cut
      for (const row of w.rows) {
        expect(row.title.length).toBeLessThanOrEqual(RESUME_TITLE_MAX_UTF16);
        expect([...row.title].some(isC0)).toBe(false);
        const last = row.title.charCodeAt(row.title.length - 1);
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      }
      // page bounds + stable order across the whole cursor walk
      let rows = w.rows.slice();
      expect(rows.length).toBeLessThanOrEqual(RESUME_PAGE_ROWS);
      let cursor: string | undefined = w.next;
      for (let guard = 0; cursor !== undefined && guard < 50; guard += 1) {
        const page = await listOk(h, { scope: "all", cursor });
        rows = rows.concat(page.rows);
        cursor = page.next;
      }
      expect(rows.map((r) => r.id)).toEqual(
        [...expectedIds].sort((a, b) => {
          const ma = eligibleMtime.get(a)!;
          const mb = eligibleMtime.get(b)!;
          return mb - ma || (a < b ? -1 : a > b ? 1 : 0);
        }),
      );
    }, 20_000);
  }

  it("caps a page at ≤32 KiB even before the 100-row limit (wide CJK titles)", async () => {
    const h = makeHarness();
    // 120 UTF-16 CJK title chars ≈ 360+ UTF-8 bytes/row → the byte cap fires around row ~90
    for (let i = 0; i < 120; i += 1) {
      writeSession(h.layout.sessionDir, `w${i}.jsonl`, {
        id: `wide${String(i).padStart(3, "0")}`,
        cwd: CWD,
        name: "会话标题很长".repeat(18),
        mtime: new Date(Date.now() - i * 1_000),
      });
    }
    const w = await listOk(h, { scope: "all" });
    expect(w.rows.length).toBeLessThan(RESUME_PAGE_ROWS);
    expect(Buffer.byteLength(JSON.stringify(w.rows), "utf8")).toBeLessThanOrEqual(RESUME_PAGE_BYTES + 600);
    expect(w.next).toBeDefined();
  });

  it("stops at 2000 rows and reports truncated", async () => {
    const h = makeHarness();
    for (let i = 0; i < RESUME_ROWS_MAX + 30; i += 1) {
      writeSession(h.layout.sessionDir, `r${i}.jsonl`, {
        id: `row${String(i).padStart(5, "0")}`,
        cwd: CWD,
        mtime: new Date(Date.now() - i * 1_000),
      });
    }
    const w = await listOk(h, { scope: "all" });
    expect(w.rows).toHaveLength(RESUME_PAGE_ROWS);
    expect(w.total).toBe(RESUME_ROWS_MAX);
    expect(w.truncated).toBe(true);
  }, 30_000);

  it("keeps the rows built so far and flags partial when the 5 s wall budget runs out", async () => {
    let opens = 0;
    const h = makeHarness({
      onOpen: () => {
        h.clock.advance(400);
        opens += 1;
      },
    });
    for (let i = 0; i < 40; i += 1) {
      writeSession(h.layout.sessionDir, `t${i}.jsonl`, { id: `t${i}`, cwd: CWD });
    }
    const w = await listOk(h, { scope: "all" });
    expect(w.partial).toBe(true);
    expect(w.total).toBeLessThan(40);
    expect(w.total).toBeGreaterThanOrEqual(10);
    expect(opens).toBeLessThan(40);
  });

  it("flags partial when the 64 MiB read budget is exhausted", async () => {
    const h = makeHarness();
    // ~66 KiB real files ⇒ 64 KiB head + 16 KiB tail = 80 KiB accounted each; 64 MiB / 80 KiB
    // ⇒ the cut lands after ~819 files, rows so far kept.
    const filler = JSON.stringify({ type: "custom", customType: "pad", data: "x".repeat(65_600) });
    for (let i = 0; i < 1_100; i += 1) {
      writeSession(h.layout.sessionDir, `b${i}.jsonl`, {
        id: `b${String(i).padStart(4, "0")}`,
        cwd: CWD,
        extraLines: [filler],
        mtime: new Date(Date.now() - i * 10),
      });
    }
    const w = await listOk(h, { scope: "all" });
    expect(w.partial).toBe(true);
    expect(w.total).toBeLessThan(1_100);
    expect(w.total).toBeGreaterThan(700);
  }, 120_000);

  it("caps candidate files at 5 000 newest-first and reports truncated", async () => {
    const h = makeHarness();
    for (let i = 0; i < 5_001 + 5; i += 1) {
      // empty files: dirent candidates, but head-read rejects them — the cap is what we assert
      writeFileSync(join(h.layout.sessionDir, `e${String(i).padStart(5, "0")}.jsonl`), "");
    }
    writeSession(h.layout.sessionDir, "zz-last.jsonl", {
      id: "theonly",
      cwd: CWD,
      mtime: new Date(Date.now() + 60_000),
    });
    const w = await listOk(h, { scope: "all" });
    expect(w.truncated).toBe(true);
    expect(idsInclude(w, "theonly")).toBe(true); // newest-first cap keeps the newest file
  }, 60_000);
});

function idsInclude(w: ResumeSessionsWire, id: string): boolean {
  return w.rows.some((r) => r.id === id);
}
