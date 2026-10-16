/**
 * web-resume plan §4 "P2 list" — `src/web-hub/agent/resume-list.ts`: generation build, row
 * filter, search, cursor paging, lifetime, bounds and the shutdown fence. The P1 core is the
 * REAL one (`defaultResumeCore()`, P1 landed) except `advanceProvenance`, which is faked for
 * determinism; file layouts are real tmpdirs in the `<agent>/sessions/<dir>` shape.
 */
import { describe, expect, it, onTestFinished } from "vitest";
import type { FileHandle } from "node:fs/promises";
import {
  createResumeList,
  defaultResumeCore,
  RESUME_GEN_IDLE_MS,
  RESUME_GEN_REUSE_MS,
  type ResumeCorePort,
  type ResumeListDeps,
  type ResumeListHandle,
} from "../../../src/web-hub/agent/resume-list.js";
import type { CmdArgs, CmdFrame, CmdOrigin, ResumeSessionsWire } from "../../../src/web-hub/protocol/messages.js";
import { fakeClock, fakeIndex, makeLayout, writeSession, type Layout } from "./resume-fixtures.js";

const ORIGIN: CmdOrigin = { listener: "loopback", ip: "127.0.0.1", reqId: "abcdef0123456789" };
const CWD = "/tmp/web-resume-p2-cwd";

function listFrame(args: string): CmdFrame {
  return { t: "cmd", rid: "r-1", id: "cmd-0000000000000001", deadlineMs: 8_000, origin: ORIGIN, cmd: listArgs(args) };
}
function listArgs(args: string): CmdArgs & { op: "command" } {
  return { op: "command", name: "resume", args };
}

interface ListHarness {
  handle: ResumeListHandle;
  layout: Layout;
  clock: ReturnType<typeof fakeClock>;
  provCalls: number;
  provSignals: Array<AbortSignal | undefined>;
  deferredProv: boolean;
  provReleased: boolean;
  resolveProv?: (signal: AbortSignal | undefined) => void;
  maxHeld: number;
}

function makeList(
  over: {
    core?: Partial<ResumeCorePort>;
    cwd?: string;
    currentId?: string;
    deferredProv?: boolean;
    /** Lazy paths the faked provenance index reports as sub sessions (layout paths are only
     *  known after files are written, hence a getter). */
    provPaths?: () => string[];
  } = {},
): ListHarness {
  const layout = makeLayout();
  onTestFinished(() => layout.cleanup());
  const clock = fakeClock(Date.now());
  const base = defaultResumeCore();
  const h: ListHarness = {
    handle: undefined as unknown as ResumeListHandle,
    layout,
    clock,
    provCalls: 0,
    provSignals: [],
    deferredProv: over.deferredProv === true,
    provReleased: false,
    maxHeld: 0,
  };
  let held = 0;
  const core: ResumeCorePort = {
    ...base,
    async openSessionNoFollowAsync(path) {
      held += 1;
      h.maxHeld = Math.max(h.maxHeld, held);
      const r = await base.openSessionNoFollowAsync(path);
      if (r === undefined) {
        held -= 1;
        return undefined;
      }
      return {
        fact: r.fact,
        handle: {
          fd: r.handle.fd,
          close: async () => {
            held -= 1;
            await r.handle.close();
          },
        } as unknown as FileHandle,
      };
    },
    async advanceProvenance(sessionDir, budget, signal) {
      h.provCalls += 1;
      h.provSignals.push(signal);
      if (h.deferredProv) {
        if (!h.provReleased) {
          await new Promise<void>((resolve) => {
            h.resolveProv = (s) => {
              h.provReleased = true;
              resolve();
              void s;
            };
          });
        }
        return fakeIndex();
      }
      return over.core?.advanceProvenance !== undefined
        ? over.core.advanceProvenance(sessionDir, budget, signal)
        : fakeIndex(over.provPaths?.() ?? []);
    },
    ...(over.core?.isSubagentSession !== undefined ? { isSubagentSession: over.core.isSubagentSession } : {}),
    ...(over.core?.displayTitle !== undefined ? { displayTitle: over.core.displayTitle } : {}),
  };
  const deps: ResumeListDeps = {
    getSessionDir: () => layout.sessionDir,
    cwd: () => over.cwd ?? CWD,
    currentSessionId: () => over.currentId ?? "",
    now: clock.now,
    core,
  };
  h.handle = createResumeList(deps);
  return h;
}

function jsonArgs(payload: Record<string, unknown>): string {
  return `__list ${JSON.stringify(payload)}`;
}

async function listOk(h: ListHarness, payload: Record<string, unknown>): Promise<ResumeSessionsWire> {
  const r = await h.handle.list(listFrame(jsonArgs(payload)), listArgs(jsonArgs(payload)));
  expect(r).toMatchObject({ ok: true });
  const data = (r as { data: { op: string; sessions?: ResumeSessionsWire } }).data;
  expect(data.op).toBe("command");
  const sessions = data.sessions;
  expect(sessions).toBeDefined();
  return sessions!;
}

function ids(w: ResumeSessionsWire): string[] {
  return w.rows.map((r) => r.id);
}

describe("resume-list — build and row filter (§2.4)", () => {
  it("lists same-cwd files with custom filenames and excludes foreign-cwd headers", async () => {
    const h = makeList();
    writeSession(h.layout.sessionDir, "2026a_alpha.jsonl", { id: "alpha", cwd: CWD, firstMessage: "hello a" });
    writeSession(h.layout.sessionDir, "mysession.custom.jsonl", { id: "beta", cwd: CWD, name: "renamed" });
    writeSession(h.layout.sessionDir, "2026c_gamma.jsonl", { id: "gamma", cwd: "/tmp/somewhere-else" });
    const w = await listOk(h, { scope: "all" });
    expect(ids(w).sort()).toEqual(["alpha", "beta"]);
    expect(w.provenance).toBe("complete");
    expect(w.scope).toBe("all");
    expect(w.windowHours).toBe(48);
    expect(w.gen).toMatch(/^[0-9a-f]{16}$/);
    expect(w.rows.find((r) => r.id === "beta")).toMatchObject({ title: "renamed", titleSource: "name" });
    expect(w.rows.find((r) => r.id === "alpha")).toMatchObject({ titleSource: "first" });
  });

  it("marks the current session and forked sessions; never hides the current one", async () => {
    const h = makeList({ currentId: "alpha" });
    writeSession(h.layout.sessionDir, "a.jsonl", { id: "alpha", cwd: CWD });
    writeSession(h.layout.sessionDir, "b.jsonl", { id: "beta", cwd: CWD, forked: true });
    const w = await listOk(h, { scope: "all" });
    expect(w.rows.find((r) => r.id === "alpha")).toMatchObject({ current: true });
    expect(w.rows.find((r) => r.id === "beta")).toMatchObject({ forked: true });
  });

  it("drops subagent sessions entirely (self-marker and provenance hit) — D1", async () => {
    let provPaths: string[] = [];
    const h = makeList({ provPaths: () => provPaths });
    writeSession(h.layout.sessionDir, "c.jsonl", { id: "child1", cwd: CWD, child: true });
    const legacyPath = writeSession(h.layout.sessionDir, "l.jsonl", { id: "legacy", cwd: CWD });
    writeSession(h.layout.sessionDir, "m.jsonl", { id: "main", cwd: CWD });
    // first pass: only the self-marker child is hidden (empty provenance index)
    const w1 = await listOk(h, { scope: "all" });
    expect(ids(w1)).toEqual(["legacy", "main"]);
    // second pass after a rebuild: the provenance index names the legacy child (no self-marker)
    provPaths = [legacyPath];
    h.clock.advance(RESUME_GEN_REUSE_MS + 1);
    const w2 = await listOk(h, { scope: "all" });
    expect(ids(w2)).toEqual(["main"]);
  });

  it("omits every copy of a duplicate header id and reports ambiguous", async () => {
    const h = makeList();
    writeSession(h.layout.sessionDir, "a.jsonl", { id: "dup", cwd: CWD });
    writeSession(h.layout.sessionDir, "b.jsonl", { id: "dup", cwd: CWD });
    writeSession(h.layout.sessionDir, "c.jsonl", { id: "solo", cwd: CWD });
    const w = await listOk(h, { scope: "all" });
    expect(ids(w)).toEqual(["solo"]);
    expect(w.ambiguous).toBe(1);
  });

  it("excludes files older than 48h from scope=recent but lists them under all", async () => {
    const h = makeList();
    const old = new Date(Date.now() - 49 * 3_600_000);
    writeSession(h.layout.sessionDir, "old.jsonl", { id: "old", cwd: CWD, mtime: old });
    writeSession(h.layout.sessionDir, "new.jsonl", { id: "new", cwd: CWD });
    const recent = await listOk(h, { scope: "recent" });
    expect(ids(recent)).toEqual(["new"]);
    const all = await listOk(h, { scope: "all" });
    expect(ids(all)).toEqual(["new", "old"]);
  });

  it("sorts modifiedMs desc then id asc, stably", async () => {
    const h = makeList();
    const t = Date.now();
    writeSession(h.layout.sessionDir, "x1.jsonl", { id: "bb", cwd: CWD, mtime: new Date(t) });
    writeSession(h.layout.sessionDir, "x2.jsonl", { id: "aa", cwd: CWD, mtime: new Date(t) });
    writeSession(h.layout.sessionDir, "x3.jsonl", { id: "cc", cwd: CWD, mtime: new Date(t + 5_000) });
    const w = await listOk(h, { scope: "all" });
    expect(ids(w)).toEqual(["cc", "aa", "bb"]);
  });

  it("rejects a symlinked session file (lstat non-regular is not a candidate)", async () => {
    const h = makeList();
    const real = writeSession(h.layout.sessionDir, "real.jsonl", { id: "real", cwd: CWD });
    const { symlinkSync } = await import("node:fs");
    symlinkSync(real, `${h.layout.sessionDir}/link.jsonl`);
    const w = await listOk(h, { scope: "all" });
    expect(ids(w)).toEqual(["real"]);
  });

  it("survives a big single line (loose text extraction still yields a row)", async () => {
    const h = makeList();
    const big = "x".repeat(200_000);
    writeSession(h.layout.sessionDir, "big.jsonl", { id: "big", cwd: CWD, firstMessage: big });
    const w = await listOk(h, { scope: "all" });
    expect(ids(w)).toEqual(["big"]);
    expect(w.rows[0]!.title.length).toBeLessThanOrEqual(120);
    expect(w.partial).toBeUndefined(); // one 200 KiB file is well inside the 64 MiB budget
  });
});

describe("resume-list — search and cursor paging (§2.4)", () => {
  it("filters by title tokens case-insensitively and pages with a gen-bound cursor", async () => {
    const h = makeList();
    for (let i = 0; i < 130; i += 1) {
      writeSession(h.layout.sessionDir, `f${i}.jsonl`, {
        id: `sid${String(i).padStart(3, "0")}`,
        cwd: CWD,
        firstMessage: i % 2 === 0 ? `Fix the Widget bug number ${i}` : `Refactor gadget ${i}`,
        mtime: new Date(Date.now() - i * 1_000),
      });
    }
    const p1 = await listOk(h, { scope: "all" });
    expect(p1.rows).toHaveLength(100);
    expect(p1.total).toBe(130);
    expect(p1.next).toMatch(new RegExp(`^${p1.gen}\\.100\\.`));
    const p2 = await listOk(h, { scope: "all", cursor: p1.next });
    expect(p2.rows).toHaveLength(30);
    expect(p2.next).toBeUndefined();
    expect(p2.gen).toBe(p1.gen);
    const q = await listOk(h, { scope: "all", q: "widget BUG" });
    expect(q.total).toBe(65);
    expect(q.q).toBe("widget BUG");
    // a cursor minted for another q ⇒ reset:true + a fresh first page
    const reset = await listOk(h, { scope: "all", q: "gadget", cursor: p1.next });
    expect(reset.reset).toBe(true);
    expect(reset.total).toBe(65);
    expect(reset.rows.every((r) => r.title.toLowerCase().includes("gadget"))).toBe(true);
  });

  it("resets when the generation changed (cursor gen gone)", async () => {
    const h = makeList();
    for (let i = 0; i < 5; i += 1) {
      writeSession(h.layout.sessionDir, `f${i}.jsonl`, {
        id: `s${i}`,
        cwd: CWD,
        mtime: new Date(Date.now() - i * 1_000),
      });
    }
    const p1 = await listOk(h, { scope: "all" });
    h.clock.advance(RESUME_GEN_REUSE_MS + 1); // force a rebuild on the next first-page request
    const stale = await listOk(h, { scope: "all", cursor: `${p1.gen}.1.00000000` });
    expect(stale.reset).toBe(true);
    expect(stale.gen).not.toBe(p1.gen);
    expect(stale.rows.length).toBe(5);
  });

  it("rejects malformed cursors and args without touching the fs", async () => {
    const h = makeList();
    const badCursor = await h.handle.list(
      listFrame(jsonArgs({ scope: "all", cursor: "nope" })),
      listArgs(jsonArgs({ scope: "all", cursor: "nope" })),
    );
    expect(badCursor).toMatchObject({ ok: false, code: "E_BAD_REQUEST" });
    const badJson = await h.handle.list(listFrame("__list {oops"), listArgs("__list {oops"));
    expect(badJson).toMatchObject({ ok: false, code: "E_BAD_REQUEST" });
    const badScope = await h.handle.list(
      listFrame(jsonArgs({ scope: "everything" })),
      listArgs(jsonArgs({ scope: "everything" })),
    );
    expect(badScope).toMatchObject({ ok: false, code: "E_BAD_REQUEST" });
    const wrongForm = await h.handle.list(listFrame("__pick {}"), listArgs("__pick {}"));
    expect(wrongForm).toMatchObject({ ok: false, code: "E_BAD_REQUEST" });
    expect(h.provCalls).toBe(0);
  });
});

describe("resume-list — generation lifetime (§2.4)", () => {
  it("reuses a gen ≤10s old for first pages, then rebuilds", async () => {
    const h = makeList();
    writeSession(h.layout.sessionDir, "a.jsonl", { id: "a", cwd: CWD });
    const w1 = await listOk(h, { scope: "all" });
    const w2 = await listOk(h, { scope: "all" });
    expect(w2.gen).toBe(w1.gen);
    expect(h.provCalls).toBe(1);
    h.clock.advance(RESUME_GEN_REUSE_MS + 1);
    const w3 = await listOk(h, { scope: "all" });
    expect(w3.gen).not.toBe(w1.gen);
    expect(h.provCalls).toBe(2);
  });

  it("drops a gen idle 120s on the next access (lazy, no timers)", async () => {
    const h = makeList();
    writeSession(h.layout.sessionDir, "a.jsonl", { id: "a", cwd: CWD });
    const w1 = await listOk(h, { scope: "all" });
    h.clock.advance(RESUME_GEN_IDLE_MS + 1);
    const w2 = await listOk(h, { scope: "all" });
    expect(w2.gen).not.toBe(w1.gen);
  });

  it("keeps one gen per scope; scopes build independently", async () => {
    const h = makeList();
    writeSession(h.layout.sessionDir, "a.jsonl", { id: "a", cwd: CWD });
    const recent = await listOk(h, { scope: "recent" });
    const all = await listOk(h, { scope: "all" });
    expect(recent.gen).not.toBe(all.gen);
    expect(h.handle.genOf("recent")).toBe(recent.gen);
    expect(h.handle.genOf("all")).toBe(all.gen);
  });
});

describe("resume-list — concurrency and the shutdown fence (§2.4)", () => {
  it("holds ≤4 concurrent open fds across two scopes building at once", async () => {
    const h = makeList();
    for (let i = 0; i < 40; i += 1) {
      writeSession(h.layout.sessionDir, `f${i}.jsonl`, { id: `s${String(i).padStart(3, "0")}`, cwd: CWD });
    }
    const pRecent = h.handle.list(listFrame(jsonArgs({ scope: "recent" })), listArgs(jsonArgs({ scope: "recent" })));
    const pAll = h.handle.list(listFrame(jsonArgs({ scope: "all" })), listArgs(jsonArgs({ scope: "all" })));
    const [r1, r2] = await Promise.all([pRecent, pAll]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(h.maxHeld).toBeLessThanOrEqual(4);
    expect(h.maxHeld).toBeGreaterThan(1); // the gate actually parallelizes
  });

  it("aborts an in-flight build on shutdown; the late completion never installs a gen", async () => {
    const h = makeList({ deferredProv: true });
    writeSession(h.layout.sessionDir, "a.jsonl", { id: "a", cwd: CWD });
    const pending = h.handle.list(listFrame(jsonArgs({ scope: "all" })), listArgs(jsonArgs({ scope: "all" })));
    for (let i = 0; i < 50 && h.provCalls === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 5)); // let the build reach advanceProvenance
    }
    expect(h.provCalls).toBe(1);
    h.handle.onShutdown();
    const signal = h.provSignals[0];
    h.resolveProv?.(signal);
    const r = await pending;
    expect(r).toMatchObject({ ok: false, code: "E_STALE_CTX", message: "resume:scanning" });
    expect(h.handle.genOf("all")).toBeUndefined();
    // the signal handed to the provenance advance was aborted (its cache write is suppressed)
    expect(signal?.aborted).toBe(true);
    // a fresh request after the boundary builds a new generation normally
    const w = await listOk(h, { scope: "all" });
    expect(ids(w)).toEqual(["a"]);
  });
});
