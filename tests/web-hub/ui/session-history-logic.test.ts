// @vitest-environment node
/**
 * `@logic/sessionHistory.ts` (session-history plan §4.7.1/§4.7.3 — P-ui): the row model,
 * the list reducer's action matrix (incl. the ONE auto-restart on `cursor-expired` and the
 * cross-generation key dedupe), `nextRequest`'s auto-continue rules (io/budget/enum-incomplete
 * yes, zombie no, ≤3 rounds), the key mappers (errors, six fork-confirm texts, five gaps),
 * `incompleteNotice`'s combinable notices, and the wire narrowing both clients share.
 */
import { describe, expect, it } from "vitest";
import {
  AUTO_CONTINUE_MAX,
  HISTORY_LIST_IDLE,
  SESSION_ERR_CODES,
  formatRelTime,
  forkConfirmKey,
  historyErrorKey,
  historyGapKey,
  historyListReducer,
  incompleteNotice,
  narrowHistoryPage,
  nextRequest,
  readHistoryKindPref,
  sessionErrKey,
  toRowModel,
  writeHistoryKindPref,
  type HistoryListState,
} from "../../../src/web-hub/ui/src/logic/sessionHistory.js";
import type { HistoryItemWire, HistoryPage } from "../../../src/web-hub/protocol/session-history.js";

const NOW = 1_700_000_000_000;

function item(over: Partial<HistoryItemWire> = {}): HistoryItemWire {
  return {
    key: "2026-10/s-a.jsonl",
    id: "sess-aaaa-bbbb",
    cwd: "/home/u/proj",
    cwdLabel: "proj",
    startedAt: "2026-10-01T00:00:00.000Z",
    mtimeMs: NOW - 300_000,
    size: 1234,
    titleSource: "first",
    kind: "main",
    cwdState: "ok",
    startable: true,
    indexed: true,
    ...over,
  };
}

function page(over: Partial<HistoryPage> = {}): HistoryPage {
  return {
    items: [item()],
    stats: { files: 1, indexed: 1, enum: { complete: true, dirsDone: 1, dirsTotal: 1 } },
    ...over,
  } as HistoryPage;
}

const NO_CARDS = new Set<string>();

// ---------------------------------------------------------------------------
// toRowModel
// ---------------------------------------------------------------------------

describe("toRowModel (arch §5.5 / §7.2)", () => {
  it("maps the plain startable main session: no badges, resume+fork actions, no fallback title", () => {
    const r = toRowModel(item({ title: "Fix the bug" }), { now: NOW, knownCards: NO_CARDS });
    expect(r.title).toBe("Fix the bug");
    expect(r.titleIsFallback).toBe(false);
    expect(r.badges).toEqual([]);
    expect(r.actions).toEqual(["resume", "fork"]);
    expect(r.startable).toBe(true);
    expect(r.relTime).toBe("5m ago");
    expect(r.blockedKey).toBeUndefined();
  });

  it("blank title ⇒ titleIsFallback with empty title (the component composes the fallback)", () => {
    const r = toRowModel(item({ title: "   " }), { now: NOW, knownCards: NO_CARDS });
    expect(r.title).toBe("");
    expect(r.titleIsFallback).toBe(true);
  });

  it("badges: live/maybe from live.state, sub from kind, forked, and the four cwd states", () => {
    expect(
      toRowModel(item({ live: { state: "open", by: "card" } }), { now: NOW, knownCards: NO_CARDS }).badges,
    ).toEqual(["live"]);
    expect(
      toRowModel(item({ live: { state: "maybe", by: "proc", pid: 42 } }), { now: NOW, knownCards: NO_CARDS }).badges,
    ).toEqual(["maybe"]);
    expect(toRowModel(item({ kind: "sub" }), { now: NOW, knownCards: NO_CARDS }).badges).toEqual(["sub"]);
    expect(toRowModel(item({ forked: true }), { now: NOW, knownCards: NO_CARDS }).badges).toEqual(["forked"]);
    expect(toRowModel(item({ cwdState: "gone", startable: false }), { now: NOW, knownCards: NO_CARDS }).badges).toEqual(
      ["gone"],
    );
    expect(
      toRowModel(item({ cwdState: "moved", startable: false }), { now: NOW, knownCards: NO_CARDS }).badges,
    ).toEqual(["moved"]);
    expect(
      toRowModel(item({ cwdState: "no-access", startable: false }), { now: NOW, knownCards: NO_CARDS }).badges,
    ).toEqual(["no-access"]);
    expect(
      toRowModel(item({ cwdState: "not-dir", startable: false }), { now: NOW, knownCards: NO_CARDS }).badges,
    ).toEqual(["not-dir"]);
    // unknown/ok carry no badge
    expect(toRowModel(item({ cwdState: "unknown" }), { now: NOW, knownCards: NO_CARDS }).badges).toEqual([]);
  });

  it("blockedKey: the five greyed reasons; blocked wins over cwdState", () => {
    expect(toRowModel(item({ blocked: "gone", startable: false }), { now: NOW, knownCards: NO_CARDS }).blockedKey).toBe(
      "history.blockedGone",
    );
    expect(
      toRowModel(item({ blocked: "no-access", startable: false }), { now: NOW, knownCards: NO_CARDS }).blockedKey,
    ).toBe("history.blockedNoAccess");
    expect(
      toRowModel(item({ blocked: "not-dir", startable: false }), { now: NOW, knownCards: NO_CARDS }).blockedKey,
    ).toBe("history.blockedNotDir");
    expect(
      toRowModel(item({ cwdState: "moved", startable: false }), { now: NOW, knownCards: NO_CARDS }).blockedKey,
    ).toBe("history.blockedMoved");
    expect(
      toRowModel(item({ blocked: "invalid", startable: false }), { now: NOW, knownCards: NO_CARDS }).blockedKey,
    ).toBe("history.blockedInvalid");
  });

  it("startable=false ⇒ NO actions and no forkOnly echo (greyed rows are read-only)", () => {
    const r = toRowModel(item({ startable: false, blocked: "gone", forkOnly: "open" }), {
      now: NOW,
      knownCards: NO_CARDS,
    });
    expect(r.actions).toEqual([]);
  });

  it("forkOnly rows: fork is the primary (no resume); proofGap rides along", () => {
    const r = toRowModel(item({ forkOnly: "unverified", proofGap: "kind" }), { now: NOW, knownCards: NO_CARDS });
    expect(r.actions).toEqual(["fork"]);
    expect(r.forkOnly).toBe("unverified");
    expect(r.proofGap).toBe("kind");
  });

  it("goto: only for live.by ∈ {card,managed} AND a locally known agentKey", () => {
    const cards = new Set(["k1"]);
    const base = { now: NOW, knownCards: cards };
    expect(toRowModel(item({ live: { state: "open", by: "card", agentKey: "k1" } }), base).gotoAgentKey).toBe("k1");
    expect(toRowModel(item({ live: { state: "open", by: "managed", agentKey: "k1" } }), base).gotoAgentKey).toBe("k1");
    // not locally listed
    expect(
      toRowModel(item({ live: { state: "open", by: "card", agentKey: "k2" } }), base).gotoAgentKey,
    ).toBeUndefined();
    // proc occupancy never offers goto
    expect(toRowModel(item({ live: { state: "maybe", by: "proc", pid: 1 } }), base).gotoAgentKey).toBeUndefined();
    // and goto appends last on an actionable row
    expect(toRowModel(item({ live: { state: "open", by: "card", agentKey: "k1" } }), base).actions).toEqual([
      "resume",
      "fork",
      "goto",
    ]);
  });

  it("formatRelTime: the compact English-token ladder", () => {
    expect(formatRelTime(NOW, NOW - 5_000)).toBe("just now");
    expect(formatRelTime(NOW, NOW - 5 * 60_000)).toBe("5m ago");
    expect(formatRelTime(NOW, NOW - 3 * 3_600_000)).toBe("3h ago");
    expect(formatRelTime(NOW, NOW - 2 * 86_400_000)).toBe("2d ago");
    expect(formatRelTime(NOW, NOW - 40 * 86_400_000)).toBe("1mo ago");
    expect(formatRelTime(NOW, NOW - 400 * 86_400_000)).toBe("1y ago");
    // a future mtime (clock skew) degrades to "just now", never a negative token
    expect(formatRelTime(NOW, NOW + 60_000)).toBe("just now");
  });
});

// ---------------------------------------------------------------------------
// historyListReducer — the action matrix
// ---------------------------------------------------------------------------

describe("historyListReducer (§4.7.1)", () => {
  const ev = {
    page: (p: HistoryPage, auto = false) =>
      ({ type: "page", page: p, now: NOW, knownCards: NO_CARDS, ...(auto ? { auto: true } : {}) }) as const,
  };

  it("query resets rows/seen/cursor and re-arms the expired budget", () => {
    let s: HistoryListState = historyListReducer(HISTORY_LIST_IDLE, { type: "query", q: "", kind: "main" });
    s = historyListReducer(s, ev.page(page()));
    expect(s.rows).toHaveLength(1);
    s = historyListReducer(s, { type: "expired" }); // consumes the budget
    expect(s.phase).toBe("loading");
    expect(s.expiredUsed).toBe(true);
    s = historyListReducer(s, ev.page(page()));
    s = historyListReducer(s, { type: "query", q: "fix", kind: "all" });
    expect(s).toMatchObject({ phase: "loading", q: "fix", kind: "all", rows: [], autoRounds: 0, expiredUsed: false });
  });

  it("page appends rows, keeps the cursor/stats/partial/liveness, and counts auto rounds", () => {
    let s = historyListReducer(HISTORY_LIST_IDLE, { type: "query", q: "", kind: "main" });
    s = historyListReducer(
      s,
      ev.page(page({ next: "v1.abcdefghijk.0", partial: { reason: "budget" }, liveness: "partial" })),
    );
    expect(s.phase).toBe("ready");
    expect(s.rows).toHaveLength(1);
    expect(s.cursor).toBe("v1.abcdefghijk.0");
    expect(s.partial).toEqual({ reason: "budget" });
    expect(s.liveness).toBe("partial");
    expect(s.autoRounds).toBe(0);
    s = historyListReducer(s, ev.page(page({ items: [item({ key: "d/x.jsonl", id: "i2" })] }), true));
    expect(s.rows).toHaveLength(2);
    expect(s.autoRounds).toBe(1);
    // a final page without next drops the cursor
    s = historyListReducer(s, ev.page(page({ items: [] })));
    expect(s.cursor).toBeUndefined();
  });

  it("dedupes BY KEY across pages and generations (§4.5.3: old-gen page + new-gen page)", () => {
    let s = historyListReducer(HISTORY_LIST_IDLE, { type: "query", q: "", kind: "main" });
    s = historyListReducer(s, ev.page(page({ next: "v1.aaaaaaaaaaa.1" })));
    // expired restart (same query, new gen) → the same key arrives again on page 1
    s = historyListReducer(s, { type: "expired" });
    s = historyListReducer(s, ev.page(page({ next: "v1.bbbbbbbbbbb.1" })));
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]?.key).toBe("2026-10/s-a.jsonl");
    expect(s.seen.size).toBe(1);
  });

  it("more: only from ready with a cursor; other phases are a no-op", () => {
    let s = historyListReducer(HISTORY_LIST_IDLE, { type: "query", q: "", kind: "main" });
    expect(historyListReducer(s, { type: "more" }).phase).toBe("loading"); // no-op (still loading)
    s = historyListReducer(s, ev.page(page())); // no cursor
    expect(historyListReducer(s, { type: "more" })).toBe(s);
    s = historyListReducer(s, ev.page(page({ next: "v1.ccccccccccc.2" })));
    const more = historyListReducer(s, { type: "more" });
    expect(more.phase).toBe("loading");
    expect(more.rows).toHaveLength(1); // rows kept across the append fetch
  });

  it("error keeps the gathered rows (an appended-page failure still shows what it has)", () => {
    let s = historyListReducer(HISTORY_LIST_IDLE, { type: "query", q: "", kind: "main" });
    s = historyListReducer(s, ev.page(page({ next: "v1.ddddddddddd.3" })));
    s = historyListReducer(s, { type: "more" });
    s = historyListReducer(s, { type: "error", status: 503, error: "E_BUSY" });
    expect(s.phase).toBe("error");
    expect(s.error).toEqual({ status: 503, error: "E_BUSY" });
    expect(s.rows).toHaveLength(1);
  });

  it("expired: restarts the SAME query once; a second expiry inside one query is an error", () => {
    let s = historyListReducer(HISTORY_LIST_IDLE, { type: "query", q: "fix", kind: "all" });
    s = historyListReducer(s, ev.page(page({ next: "v1.eeeeeeeeeee.0" })));
    s = historyListReducer(s, { type: "expired" });
    expect(s).toMatchObject({ phase: "loading", q: "fix", kind: "all", rows: [], expiredUsed: true });
    s = historyListReducer(s, ev.page(page({ next: "v1.fffffffffff.0" })));
    s = historyListReducer(s, { type: "expired" });
    expect(s.phase).toBe("error");
    expect(s.error?.reason).toBe("cursor-expired");
  });
});

// ---------------------------------------------------------------------------
// nextRequest — the auto-continue rules
// ---------------------------------------------------------------------------

describe("nextRequest (§4.7.1: io/budget/enum-incomplete 续扫, zombie 不续扫, ≤3 轮)", () => {
  function ready(over: Partial<HistoryListState> = {}): HistoryListState {
    return {
      ...HISTORY_LIST_IDLE,
      phase: "ready",
      q: "fix",
      kind: "main",
      rows: [],
      seen: new Set(),
      cursor: "v1.ggggggggggg.0",
      autoRounds: 0,
      expiredUsed: false,
      ...over,
    } as HistoryListState;
  }

  it("null without a cursor or outside ready", () => {
    expect(nextRequest(ready({ cursor: undefined }))).toBeNull();
    expect(nextRequest({ ...ready(), phase: "loading" })).toBeNull();
    expect(nextRequest({ ...ready(), phase: "error" })).toBeNull();
  });

  it("auto for partial budget / enum / io", () => {
    expect(nextRequest(ready({ partial: { reason: "budget" } }))?.auto).toBe(true);
    expect(nextRequest(ready({ partial: { reason: "enum" } }))?.auto).toBe(true);
    expect(nextRequest(ready({ partial: { reason: "io" } }))?.auto).toBe(true);
  });

  it("auto while stats.enum.complete === false even without a partial", () => {
    const stats = { files: 10, indexed: 3, enum: { complete: false, dirsDone: 2, dirsTotal: 5 } };
    expect(nextRequest(ready({ stats }))?.auto).toBe(true);
  });

  it("zombie never auto-continues (F22) — manual load-more stays possible", () => {
    const r = nextRequest(ready({ partial: { reason: "zombie" } }));
    expect(r).not.toBeNull();
    expect(r?.auto).toBe(false);
  });

  it("a plain complete page without partial is manual-only", () => {
    expect(nextRequest(ready())?.auto).toBe(false);
  });

  it(`at most ${AUTO_CONTINUE_MAX} auto rounds per input, then manual`, () => {
    const stats = { files: 10, indexed: 3, enum: { complete: false, dirsDone: 2, dirsTotal: 5 } };
    for (let i = 0; i < AUTO_CONTINUE_MAX; i++) {
      expect(nextRequest(ready({ autoRounds: i, stats }))?.auto).toBe(true);
    }
    expect(nextRequest(ready({ autoRounds: AUTO_CONTINUE_MAX, stats }))?.auto).toBe(false);
  });

  it("carries the committed query/kind/cursor", () => {
    const r = nextRequest(ready({ partial: { reason: "io" }, kind: "all" }));
    expect(r).toEqual({ q: "fix", kind: "all", cursor: "v1.ggggggggggg.0", auto: true });
  });
});

// ---------------------------------------------------------------------------
// key mappers
// ---------------------------------------------------------------------------

describe("historyErrorKey (incl. the retryable 503 busy state)", () => {
  it("maps the error surface", () => {
    expect(historyErrorKey("E_BUSY", 503)).toBe("history.errBusy");
    expect(historyErrorKey("E_LAUNCHER", 503)).toBe("history.errBusy");
    expect(historyErrorKey("E_RATE", 429)).toBe("history.errRate");
    expect(historyErrorKey("E_RATE", 0)).toBe("history.errRate");
    expect(historyErrorKey("E_DEADLINE", 0)).toBe("history.errDeadline");
    expect(historyErrorKey("E_AUTH", 401)).toBe("history.errAuth");
    expect(historyErrorKey("E_NOT_FOUND", 404)).toBe("spawn.errUnsupported");
    expect(historyErrorKey("E_BAD_REQUEST", 409)).toBe("history.errCursor");
    expect(historyErrorKey("E_NETWORK", 0)).toBe("history.errNetwork");
  });
});

describe("sessionErrKey", () => {
  it("covers every SessionSpawnRejectReason + the PD14 local 'unsupported'", () => {
    expect(SESSION_ERR_CODES).toEqual([
      "session-ref",
      "model-with-session",
      "session-missing",
      "session-mismatch",
      "session-invalid",
      "session-too-large",
      "moved",
      "session-changed",
      "unsupported",
    ]);
    expect(sessionErrKey("session-missing")).toBe("history.errSessionMissing");
    expect(sessionErrKey("session-changed")).toBe("history.errSessionChanged");
    expect(sessionErrKey(undefined)).toBe("history.errSessionInvalid"); // unknown codes degrade
  });
});

describe("forkConfirmKey — the six texts (§4.7.2)", () => {
  it("open/card, open/managed; maybe; subagent; manual; unverified (incl. the fallbacks)", () => {
    expect(forkConfirmKey("open", "card")).toBe("history.forkOpenCard");
    expect(forkConfirmKey("open", "managed")).toBe("history.forkOpenManaged");
    expect(forkConfirmKey("open", "proc")).toBe("history.forkUnverified"); // not hub-produced — generic
    expect(forkConfirmKey("open")).toBe("history.forkUnverified");
    expect(forkConfirmKey("maybe", "proc")).toBe("history.forkMaybeProc");
    expect(forkConfirmKey("subagent")).toBe("history.forkSubagent");
    expect(forkConfirmKey("manual")).toBe("history.forkManual");
    expect(forkConfirmKey("unverified", undefined, "kind")).toBe("history.forkUnverified");
    // gap never selects the key — only fills {gap}
    expect(forkConfirmKey("unverified", undefined, "new-process")).toBe("history.forkUnverified");
  });
});

describe("historyGapKey — every gap has a text key (§4.7.2)", () => {
  it("maps the five ProofGaps", () => {
    expect(historyGapKey("kind")).toBe("history.gapKind");
    expect(historyGapKey("unconnected-pi")).toBe("history.gapUnconnectedPi");
    expect(historyGapKey("card-unproven")).toBe("history.gapCardUnproven");
    expect(historyGapKey("proc-partial")).toBe("history.gapProcPartial");
    expect(historyGapKey("new-process")).toBe("history.gapNewProcess");
    expect(historyGapKey(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// incompleteNotice
// ---------------------------------------------------------------------------

describe("incompleteNotice (可组合)", () => {
  const enumDone = { complete: true, dirsDone: 3, dirsTotal: 3 };

  it("complete + no omissions ⇒ empty", () => {
    expect(incompleteNotice({ files: 3, indexed: 3, enum: enumDone }, undefined)).toEqual([]);
  });

  it("combination A: enumerating + skipped + dirsSkipped", () => {
    const out = incompleteNotice(
      { files: 3, indexed: 3, skipped: 2, enum: { complete: false, dirsDone: 1, dirsTotal: 4, dirsSkipped: 1 } },
      true,
    );
    expect(out.map((n) => n.key)).toEqual([
      "history.noticeEnumRunning",
      "history.noticeSkipped",
      "history.noticeDirsSkipped",
    ]);
    expect(out[0]).toMatchObject({ dirsDone: 1, dirsTotal: 4 });
    expect(out[1]?.n).toBe(2);
    expect(out[2]?.n).toBe(1);
  });

  it("combination B: changed + truncated (both truncation flags collapse to one line)", () => {
    const out = incompleteNotice(
      { files: 9, indexed: 9, changed: 3, enum: { ...enumDone, dirsTruncated: true, filesTruncated: true } },
      true,
    );
    expect(out.map((n) => n.key)).toEqual(["history.noticeChanged", "history.noticeTruncated"]);
    expect(out[0]?.n).toBe(3);
  });

  it("combination C: everything at once, in the fixed order", () => {
    const out = incompleteNotice(
      {
        files: 9,
        indexed: 9,
        skipped: 1,
        changed: 2,
        enum: { complete: false, dirsDone: 0, dirsTotal: 4, dirsSkipped: 3, dirsTruncated: true },
      },
      true,
    );
    expect(out.map((n) => n.key)).toEqual([
      "history.noticeEnumRunning",
      "history.noticeSkipped",
      "history.noticeDirsSkipped",
      "history.noticeChanged",
      "history.noticeTruncated",
    ]);
  });

  it("an incomplete flag with no detectable cause still surfaces the generic line", () => {
    expect(incompleteNotice({ files: 1, indexed: 1, enum: enumDone }, true)).toEqual([
      { key: "history.noticeIncomplete" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// narrowHistoryPage
// ---------------------------------------------------------------------------

describe("narrowHistoryPage (§4.7.1: 丢弃不合规的项; stats.enum 缺失 ⇒ complete)", () => {
  it("drops non-conforming items, keeps conforming ones verbatim", () => {
    const p = narrowHistoryPage({
      items: [
        item(),
        { key: "no-id/x.jsonl" }, // missing id → dropped
        null, // not an object → dropped
        item({ key: "d/two.jsonl", id: "i2", live: { state: "open", by: "card", agentKey: "k" } }),
      ],
      next: "v1.hhhhhhhhhhh.1",
      stats: { files: 4, indexed: 2, skipped: 1, enum: { complete: true, dirsDone: 2, dirsTotal: 2 } },
    });
    expect(p?.items).toHaveLength(2);
    expect(p?.items[1]?.live).toEqual({ state: "open", by: "card", agentKey: "k" });
    expect(p?.next).toBe("v1.hhhhhhhhhhh.1");
    expect(p?.stats.skipped).toBe(1);
  });

  it("missing stats.enum ⇒ complete:true, dirs 0/0; garbage partial/liveness dropped", () => {
    const p = narrowHistoryPage({ items: [], stats: { files: 0, indexed: 0 } });
    expect(p?.stats.enum).toEqual({ complete: true, dirsDone: 0, dirsTotal: 0 });
    const q = narrowHistoryPage({
      items: [],
      stats: { files: 0, indexed: 0 },
      partial: { reason: "weird" },
      liveness: "half",
    });
    expect(q?.partial).toBeUndefined();
    expect(q?.liveness).toBeUndefined();
    // complete:false survives — the enumerating hint is wire-driven
    expect(
      narrowHistoryPage({
        items: [],
        stats: { files: 0, indexed: 0, enum: { complete: false, dirsDone: 0, dirsTotal: 9 } },
      })?.stats.enum.complete,
    ).toBe(false);
  });

  it("non-object body ⇒ null (the clients map that to E_BAD_RESPONSE); items non-array ⇒ empty page", () => {
    expect(narrowHistoryPage(null)).toBeNull();
    expect(narrowHistoryPage("nope")).toBeNull();
    expect(narrowHistoryPage({ items: "nope" })?.items).toEqual([]);
  });

  it("unknown enum/partial/liveness wire values never crash the narrowing", () => {
    const p = narrowHistoryPage({
      items: [item()],
      stats: { files: 1, indexed: 1, enum: { complete: "yes", dirsDone: "2", dirsTotal: null } },
      partial: 7,
    });
    // a NON-boolean complete is treated as incomplete (conservative: the enumerating hint is
    // the fail-open direction; only a missing enum counts as complete per §4.7.1)
    expect(p?.stats.enum.complete).toBe(false);
    expect(p?.stats.enum.dirsDone).toBe(0);
    expect(p?.partial).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// kind preference storage
// ---------------------------------------------------------------------------

describe("history kind preference (pwh_history_kind)", () => {
  it("reads: 'all' wins, junk/missing/failure fail open to 'main'", () => {
    expect(readHistoryKindPref({ getItem: () => "all" })).toBe("all");
    expect(readHistoryKindPref({ getItem: () => "main" })).toBe("main");
    expect(readHistoryKindPref({ getItem: () => "junk" })).toBe("main");
    expect(readHistoryKindPref({ getItem: () => null })).toBe("main");
    expect(readHistoryKindPref(null)).toBe("main");
    expect(
      readHistoryKindPref({
        getItem: () => {
          throw new Error("denied");
        },
      }),
    ).toBe("main");
  });

  it("writes best-effort; a throwing storage is swallowed", () => {
    const wrote: Array<[string, string]> = [];
    writeHistoryKindPref({ setItem: (k, v) => wrote.push([k, v]) }, "all");
    expect(wrote).toEqual([["pwh_history_kind", "all"]]);
    expect(() =>
      writeHistoryKindPref(
        {
          setItem: () => {
            throw new Error("denied");
          },
        },
        "main",
      ),
    ).not.toThrow();
  });
});
