/**
 * R1 (2026-11 defensive fix): `onReq`'s live-branch answer is a TAIL-WINDOW projection —
 * the raw branch is walked newest-first and only the kept tail (plus at most one
 * budget-overflow probe / one hasMore probe) is ever projected, never the whole in-memory
 * branch (same incident class as the hub-side refresh-slow rule). Pinned two ways:
 *  1. a counting `projectSessionEntry` wrapper (vi.mock) asserts the projection count for a
 *     big branch + small limit stays in the tail window;
 *  2. an inline REFERENCE implementation of the old "project all, then trim the head"
 *     algorithm is run over a seeded matrix of branches × (limit, maxBytes, before) and the
 *     new output is asserted byte-identical (entries JSON, truncated, hasMore, leaf_missing).
 */
import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { createRunTranscripts, type RunTranscriptPort } from "../../../src/web-hub/agent/run-transcript.js";
import type { AgentFrame, WireEntry } from "../../../src/web-hub/protocol/messages.js";
import { projectSessionEntry } from "../../../src/web-hub/protocol/keys.js";
import { RUN_TX, type RunTxReqFrame } from "../../../src/web-hub/protocol/run-transcript.js";

const counter = vi.hoisted(() => ({ n: 0 }));
vi.mock("../../../src/web-hub/protocol/keys.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../src/web-hub/protocol/keys.js")>();
  return {
    ...mod,
    projectSessionEntry: (raw: unknown): WireEntry | undefined => {
      counter.n += 1;
      return mod.projectSessionEntry(raw);
    },
  };
});

// --------------------------------------------------------------------- harness

const RUN = "r_TAILFIX01";
const liveRun = { status: "running", terminal: false };

type Reply = Extract<AgentFrame, { t: "run_tx_reply" }>;

function req(over: Partial<RunTxReqFrame> = {}): RunTxReqFrame {
  return { t: "run_tx_req", rid: "rid-1", runId: RUN, limit: 200, maxBytes: RUN_TX.maxBytes, ...over };
}

function drive(branch: readonly unknown[], over: Partial<RunTxReqFrame> = {}): Reply {
  const sent: AgentFrame[] = [];
  const port: RunTranscriptPort = {
    info: () => liveRun,
    branch: () => branch,
    observe: () => ({ kind: "unknown" }),
  };
  const rt = createRunTranscripts({
    port: () => port,
    trySend: (f) => {
      sent.push(f);
      return "written";
    },
    enabled: () => true,
    now: () => 0,
    setTimer: () => ({ cancel: () => undefined }),
  });
  rt.onReq(req(over));
  expect(sent).toHaveLength(1);
  return sent[0] as Reply;
}

function msgEntry(id: string, parentId: string | null, text = "x"): unknown {
  return {
    id,
    parentId,
    type: "message",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function branchOf(n: number, text = "x"): unknown[] {
  return Array.from({ length: n }, (_, i) => msgEntry(`e${i}`, i === 0 ? null : `e${i - 1}`, text));
}

// ------------------------------------------------- old algorithm, verbatim reference

interface Query {
  before?: string;
  limit: number;
  maxBytes: number;
}

/** The pre-R1 implementation ("project all, then trim the head") reduced to its output. */
function reference(
  raw: readonly unknown[],
  q: Query,
): { err: true } | { err: false; entries: string; truncated: boolean; hasMore: boolean } {
  const projected: WireEntry[] = [];
  for (const r of raw) {
    const e = projectSessionEntry(r);
    if (e !== undefined) projected.push(e);
  }
  let head = projected.length;
  if (q.before !== undefined) {
    const at = projected.findIndex((e) => e.id === q.before);
    if (at === -1) return { err: true };
    head = at;
  }
  const limit = Math.max(0, Math.floor(q.limit));
  const budget = Math.max(0, Math.min(q.maxBytes, RUN_TX.maxBytes));
  let used = 0;
  let start = head;
  let truncated = false;
  for (let i = head - 1; i >= 0 && start > head - limit; i--) {
    const size = Buffer.byteLength(JSON.stringify(projected[i]), "utf8") + 1;
    if (used + size > budget) {
      truncated = true;
      break;
    }
    used += size;
    start = i;
  }
  return {
    err: false,
    entries: JSON.stringify(projected.slice(start, head)),
    truncated,
    hasMore: start > 0,
  };
}

// ------------------------------------------------------------- projection count

describe("R1 tail-window projection (counted)", () => {
  it("big branch + small limit ⇒ only the tail window is projected, never the whole branch", () => {
    const branch = branchOf(500);
    counter.n = 0;
    const f = drive(branch, { limit: 10 });
    if (f.ok && f.source === "live") {
      expect(f.entries).toHaveLength(10);
      expect(f.entries[0]!.id).toBe("e490");
      expect(f.hasMore).toBe(true);
      expect(f.truncated).toBe(false);
    } else {
      expect.unreachable();
    }
    expect(counter.n).toBe(11); // 10 kept + 1 hasMore probe (500 with the old algorithm)
  });

  it("byte budget overflow ⇒ kept + the single overflow probe (hasMore is free)", () => {
    // Uniform tail sizes (zero-padded ids) so the budget fits EXACTLY 5 entries.
    const chunk = "z".repeat(1024);
    const branch = Array.from({ length: 500 }, (_, i) =>
      msgEntry(`e${String(i).padStart(4, "0")}`, i === 0 ? null : `e${String(i - 1).padStart(4, "0")}`, chunk),
    );
    const one = Buffer.byteLength(JSON.stringify(projectSessionEntry(branch[499])!), "utf8") + 1;
    counter.n = 0;
    const f = drive(branch, { limit: 200, maxBytes: 5 * one + (one - 1) });
    if (f.ok && f.source === "live") {
      expect(f.entries).toHaveLength(5);
      expect(f.truncated).toBe(true);
      expect(f.hasMore).toBe(true);
    } else {
      expect.unreachable();
    }
    expect(counter.n).toBe(6); // 5 kept + 1 overflow probe; truncated ⇒ no hasMore scan
  });

  it("before paging ⇒ one projectability probe + the tail window, no head-side projection", () => {
    const branch = branchOf(500);
    counter.n = 0;
    const f = drive(branch, { before: "e250", limit: 10 });
    if (f.ok && f.source === "live") {
      expect(f.entries.map((e) => e.id)).toEqual(Array.from({ length: 10 }, (_, i) => `e${240 + i}`));
      expect(f.hasMore).toBe(true);
    } else {
      expect.unreachable();
    }
    expect(counter.n).toBe(12); // 1 before-probe + 10 kept + 1 hasMore probe
  });

  it("whole branch fits ⇒ walked to the head, hasMore false, no extra projections", () => {
    const branch = branchOf(40);
    counter.n = 0;
    const f = drive(branch, { limit: 200 });
    if (f.ok && f.source === "live") {
      expect(f.entries).toHaveLength(40);
      expect(f.hasMore).toBe(false);
      expect(f.truncated).toBe(false);
    } else {
      expect.unreachable();
    }
    expect(counter.n).toBe(40); // every entry walked once; i ran off the head ⇒ no probe
  });
});

// ------------------------------------------- seeded equivalence vs the old algorithm

/** mulberry32 — deterministic, no Math.random in tests. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A mixed branch: projectable message/custom entries, junk (non-projectable), id collisions. */
function genBranch(rand: () => number): unknown[] {
  const n = Math.floor(rand() * 120);
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const roll = rand();
    const id = rand() < 0.08 && out.length > 0 ? "dup" : `e${i}`; // occasional id collisions
    if (roll < 0.12) {
      // junk: non-projectable shapes — some carrying an id that also exists projectable
      const junk: unknown[] = [null, {}, [], { id }, { id, timestamp: 1 }, { id, timestamp: "t", parentId: null }];
      out.push(junk[Math.floor(rand() * junk.length)]);
    } else if (roll < 0.3) {
      out.push({
        id,
        parentId: i === 0 ? null : `e${i - 1}`,
        type: "custom_message",
        customType: "subagent:note",
        timestamp: "2026-01-01T00:00:00.000Z",
        content: { text: "y".repeat(Math.floor(rand() * 400)) },
      });
    } else {
      out.push(msgEntry(id, i === 0 ? null : `e${i - 1}`, "x".repeat(Math.floor(rand() * 2000))));
    }
  }
  return out;
}

function genQueries(rand: () => number, branch: readonly unknown[]): Query[] {
  const ids = branch
    .map((r) => (r !== null && typeof r === "object" && !Array.isArray(r) ? (r as { id?: unknown }).id : undefined))
    .filter((v): v is string => typeof v === "string");
  const queries: Query[] = [];
  const limits = [0, 1, 3, 17, 200];
  const budgets = [0, 512, 8 << 10, RUN_TX.maxBytes];
  for (let k = 0; k < 6; k++) {
    const q: Query = {
      limit: limits[Math.floor(rand() * limits.length)]!,
      maxBytes: budgets[Math.floor(rand() * budgets.length)]!,
    };
    const b = rand();
    if (b < 0.35 && ids.length > 0) q.before = ids[Math.floor(rand() * ids.length)];
    else if (b < 0.45) q.before = "missing-id";
    queries.push(q);
  }
  return queries;
}

describe("R1 equivalence with the old project-all algorithm (seeded matrix)", () => {
  it("entries JSON / truncated / hasMore / leaf_missing are byte-identical across the matrix", () => {
    let checked = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const rand = rng(seed);
      const branch = genBranch(rand);
      for (const q of genQueries(rand, branch)) {
        const want = reference(branch, q);
        const f = drive(branch, q);
        if (want.err) {
          expect(f).toMatchObject({ ok: false, code: "E_NOT_FOUND", reason: "leaf_missing" });
          continue;
        }
        expect(f.ok).toBe(true);
        if (f.ok && f.source === "live") {
          expect(JSON.stringify(f.entries)).toBe(want.entries); // byte-identical window
          expect(f.truncated).toBe(want.truncated);
          expect(f.hasMore).toBe(want.hasMore);
          // never more projections than the old algorithm, and bounded by the window + probes
        } else {
          expect.unreachable();
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100); // the matrix really ran
  });

  it("junk-only prefixes do not fool hasMore (limit stop over a non-projectable head)", () => {
    const branch = [{ id: "junk" }, { nope: true }, msgEntry("e1", null), msgEntry("e2", "e1")];
    const f = drive(branch, { limit: 2 });
    if (f.ok && f.source === "live") {
      expect(f.entries.map((e) => e.id)).toEqual(["e1", "e2"]);
      expect(f.hasMore).toBe(false); // the prefix has NO projectable entry
      expect(f.truncated).toBe(false);
    } else {
      expect.unreachable();
    }
  });

  it("before matching a NON-projectable entry keeps scanning (old findIndex matched projectable only)", () => {
    const branch = [
      { id: "dup" },
      msgEntry("e1", null),
      { ...(msgEntry("dup", "e1") as object) },
      msgEntry("e3", "dup"),
    ];
    const f = drive(branch, { before: "dup", limit: 10 });
    if (f.ok && f.source === "live") {
      expect(f.entries.map((e) => e.id)).toEqual(["e1"]); // candidates: strictly older than the projectable "dup"
      expect(f.hasMore).toBe(false);
    } else {
      expect.unreachable();
    }
  });

  it("limit 0 ⇒ empty window but hasMore still reflects a projectable entry", () => {
    const f = drive(branchOf(5), { limit: 0 });
    if (f.ok && f.source === "live") {
      expect(f.entries).toEqual([]);
      expect(f.hasMore).toBe(true);
      expect(f.truncated).toBe(false);
    } else {
      expect.unreachable();
    }
  });
});
