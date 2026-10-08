// @vitest-environment happy-dom
/**
 * `SessionHistoryDialog.vue` (session-history plan §4.7.3 — P-ui). A REAL `createNewSession`
 * orchestrator over a scripted `start` drives the flow half (the dir-picker-test harness
 * pattern); the list half runs against a scripted `spawn.history`. Pins: rows/listbox
 * semantics, greyed rows, the 250ms debounce, the kind persistence (`pwh_history_kind`),
 * load-more + auto-continue, `cursor-expired` reload, the skipped/dirsSkipped/changed/
 * enumerating banners, the empty hints, the unverified → fork confirm → submit path, the
 * 409 `session-open` flow view, `failed{kind:"session"}` inline + refresh, and the ALWAYS
 * rendered W1–W7 best-effort note (copy-pinned for W5/W7 in en AND zh).
 *
 * The dialog Teleports to `<body>` — every query goes through `document.body` (VTU's
 * teleport stub does not propagate slot updates for this component, verified 2026-10).
 */
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ref, shallowRef } from "vue";
import SessionHistoryDialog from "../../../src/web-hub/ui/src/components/spawn/SessionHistoryDialog.vue";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { createNewSession } from "../../../src/web-hub/ui/src/composables/useNewSession.js";
import { MESSAGES } from "../../../src/web-hub/ui/src/i18n/index.js";
import type { HubHandle, HubState } from "../../../src/web-hub/ui/src/types.js";
import type { SpawnHistoryOutcome, SpawnOutcome } from "../../../src/web-hub/ui/src/transport/types.js";
import type { HistoryPage } from "../../../src/web-hub/protocol/session-history.js";
import type { SpawnRequestBody } from "../../../src/web-hub/protocol/spawn.js";

const NOW = 1_700_000_000_000;

function fakeClock() {
  let now = NOW;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number): number => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id: number): void => void timers.delete(id),
    advance(ms: number): void {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

function historyPage(over: Partial<HistoryPage> = {}): HistoryPage {
  return {
    items: [],
    stats: { files: 0, indexed: 0, enum: { complete: true, dirsDone: 1, dirsTotal: 1 } },
    ...over,
  } as HistoryPage;
}

interface Harness {
  readonly hub: HubHandle;
  readonly historyCalls: Array<{ q?: string; kind?: "main" | "all"; cursor?: string }>;
  readonly starts: SpawnRequestBody[];
  readonly clock: ReturnType<typeof fakeClock>;
  readonly agents: Map<string, unknown>;
}

/**
 * HUB_CTX with a real §3.2 orchestrator (historyCap on) and a scripted `history`. The
 * history resolver is keyed by call index — each test scripts a queue of outcomes; the LAST
 * entry repeats for any extra call.
 */
function harness(opts: {
  history: Array<SpawnHistoryOutcome | ((q: { q?: string; kind?: string; cursor?: string }) => SpawnHistoryOutcome)>;
  start?: (req: SpawnRequestBody) => Promise<SpawnOutcome>;
  caps?: string[];
  agents?: Map<string, unknown>;
}): Harness {
  const historyCalls: Array<{ q?: string; kind?: "main" | "all"; cursor?: string }> = [];
  const starts: SpawnRequestBody[] = [];
  const clock = fakeClock();
  const caps = opts.caps ?? ["spawn.v1", "spawn.history.v1"];
  const agents = opts.agents ?? new Map();
  let histIdx = 0;
  const newSession = createNewSession({
    start: (req) => {
      starts.push(req);
      return (opts.start ?? (async () => ({ ok: true, data: { spawnId: "sp-1", state: "starting" } })))(req);
    },
    historyCap: () => caps.includes("spawn.history.v1"),
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    newId: () => `req-${starts.length}-aaaaaaaaaaaa`,
  });
  const hub: HubHandle = {
    state: ref({ agents, spawns: null, hub: { caps } } as unknown as HubState),
    dispatch: () => {},
    spawn: {
      list: async () => ({ ok: false, error: "E_NOT_FOUND", status: 404 }),
      dirs: async () => ({ ok: true, recent: [] }),
      start: async () => ({ ok: false, error: "E_UNSUPPORTED", retryable: false }),
      stop: async () => ({ ok: true, state: "stopping" }),
      history: async (q) => {
        historyCalls.push(q);
        const entry = opts.history[Math.min(histIdx, opts.history.length - 1)];
        histIdx++;
        const outcome = typeof entry === "function" ? entry(q) : entry;
        return outcome;
      },
      newSession,
      prefs: shallowRef(null),
      refreshPrefs: async () => ({ ok: false, error: "E_NOT_FOUND", status: 404 }),
      setDefaultModel: async () => ({ ok: false, error: "E_UNSUPPORTED", retryable: false }),
      historyCap: () => caps.includes("spawn.history.v1"),
    },
  };
  return { hub, historyCalls, starts, clock, agents };
}

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  document.body.style.overflow = "";
  document.body.innerHTML = "";
  window.localStorage.clear();
  vi.useRealTimers();
});

function q<T extends Element = HTMLElement>(sel: string): T {
  const el = document.body.querySelector<T>(sel);
  if (el === null) throw new Error(`not found in document.body: ${sel}`);
  return el;
}
function qa(sel: string): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>(sel));
}
async function click(el: HTMLElement): Promise<void> {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await flushPromises();
}
async function type(el: HTMLInputElement, value: string): Promise<void> {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  await flushPromises();
}
function mountDialog(h: Harness) {
  const w = mount(SessionHistoryDialog, { global: { provide: { [HUB_CTX as symbol]: h.hub } } });
  mounted.push(w);
  return w;
}

function mainItem(over: Record<string, unknown> = {}) {
  return {
    key: "2026-10/a.jsonl",
    id: "sess-1111-2222",
    cwd: "/home/u/proj",
    cwdLabel: "proj",
    startedAt: "2026-10-01T00:00:00.000Z",
    mtimeMs: Date.now() - 300_000,
    size: 10,
    title: "Fix the parser",
    titleSource: "first",
    kind: "main",
    cwdState: "ok",
    startable: true,
    indexed: true,
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe("SessionHistoryDialog: list basics", () => {
  it("renders rows via textContent: title, cwd label, relative time, badges", async () => {
    const h = harness({
      history: [
        {
          ok: true,
          page: historyPage({
            items: [mainItem({ live: { state: "open", by: "card" }, forked: true })],
            stats: { files: 1, indexed: 1, enum: { complete: true, dirsDone: 1, dirsTotal: 1 } },
          }),
        },
      ],
    });
    mountDialog(h);
    await flushPromises();
    expect(qa(".history-row")).toHaveLength(1);
    const row = q<HTMLElement>(".history-row");
    expect(row.textContent).toContain("Fix the parser");
    expect(row.textContent).toContain("proj");
    expect(row.textContent).toContain("5m ago");
    expect(qa(".history-badge").map((b) => b.textContent?.trim())).toEqual(["live", "forked"]);
  });

  it("listbox semantics: role=listbox/option, aria-selected tracks the keyboard selection", async () => {
    const h = harness({
      history: [
        {
          ok: true,
          page: historyPage({ items: [mainItem(), mainItem({ key: "d/b.jsonl", id: "i2" })] }),
        },
      ],
    });
    mountDialog(h);
    await flushPromises();
    const list = q('[role="listbox"]');
    expect(list).toBeTruthy();
    const options = qa('[role="option"]');
    expect(options).toHaveLength(2);
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await flushPromises();
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");
    expect(options[0]?.getAttribute("aria-selected")).toBe("false");
  });

  it("greyed rows: aria-disabled, the blocked reason line, NO action buttons", async () => {
    const h = harness({
      history: [
        {
          ok: true,
          page: historyPage({ items: [mainItem({ startable: false, cwdState: "gone", blocked: "gone" })] }),
        },
      ],
    });
    mountDialog(h);
    await flushPromises();
    const row = q<HTMLElement>(".history-row");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.textContent).toContain("The directory no longer exists");
    expect(qa(".history-row-actions button")).toHaveLength(0);
  });

  it("a title-less row falls back to （无标题） · <id8>", async () => {
    const h = harness({
      history: [{ ok: true, page: historyPage({ items: [mainItem({ title: undefined })] }) }],
    });
    mountDialog(h);
    await flushPromises();
    expect(q(".history-row").textContent).toContain("(no title) · sess-111");
  });

  it("goto renders as a real link (#/agent/<key>) only for locally known cards", async () => {
    const h = harness({
      history: [
        {
          ok: true,
          page: historyPage({
            items: [
              mainItem({ live: { state: "open", by: "card", agentKey: "k1" } }),
              mainItem({ key: "d/b.jsonl", id: "i2", live: { state: "maybe", by: "proc", pid: 7 } }),
            ],
          }),
        },
      ],
      agents: new Map([["k1", { key: "k1" }]]),
    });
    mountDialog(h);
    await flushPromises();
    const links = qa(".history-row a.btn");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("#/agent/k1");
    expect(links[0]?.textContent?.trim()).toBe("Go to");
  });
});

describe("SessionHistoryDialog: search + kind", () => {
  it("debounces the search 250ms (Enter commits immediately)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = harness({ history: [{ ok: true, page: historyPage() }] });
    mountDialog(h);
    await flushPromises();
    expect(h.historyCalls).toHaveLength(1); // the initial page
    await type(q<HTMLInputElement>(".history-search input"), "parser");
    expect(h.historyCalls).toHaveLength(1); // still debounced
    await vi.advanceTimersByTimeAsync(249);
    expect(h.historyCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(h.historyCalls).toHaveLength(2);
    expect(h.historyCalls[1]?.q).toBe("parser");
    // Enter commits immediately, without waiting out the debounce
    await type(q<HTMLInputElement>(".history-search input"), "parser two");
    q<HTMLInputElement>(".history-search input").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await flushPromises();
    expect(h.historyCalls[h.historyCalls.length - 1]?.q).toBe("parser two");
  });

  it("the kind toggle refetches with kind=all and persists pwh_history_kind", async () => {
    const h = harness({ history: [{ ok: true, page: historyPage() }] });
    mountDialog(h);
    await flushPromises();
    expect(h.historyCalls[0]?.kind).toBe("main"); // the client drops it on the wire (main is the default)
    const box = q<HTMLInputElement>(".history-kind input");
    await click(box);
    expect(h.historyCalls[1]?.kind).toBe("all");
    expect(window.localStorage.getItem("pwh_history_kind")).toBe("all");
  });

  it("the persisted kind is the initial fetch's kind", async () => {
    window.localStorage.setItem("pwh_history_kind", "all");
    const h = harness({ history: [{ ok: true, page: historyPage() }] });
    mountDialog(h);
    await flushPromises();
    expect(h.historyCalls[0]?.kind).toBe("all");
  });

  it("first Esc clears the search (refetch with q omitted), second Esc closes", async () => {
    const h = harness({ history: [{ ok: true, page: historyPage() }] });
    const w = mountDialog(h);
    await flushPromises();
    await type(q<HTMLInputElement>(".history-search input"), "xyz");
    q<HTMLInputElement>(".history-search input").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await flushPromises();
    expect(h.historyCalls.at(-1)?.q).toBe("xyz");
    const input = q<HTMLInputElement>(".history-search input");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flushPromises();
    expect(w.emitted("close")).toBeUndefined(); // cleared, not closed
    expect(input.value).toBe("");
    expect(h.historyCalls.at(-1)?.q).toBe(""); // empty q — the client omits it on the wire
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flushPromises();
    expect(w.emitted("close")).toHaveLength(1);
  });
});

describe("SessionHistoryDialog: paging, auto-continue, cursor-expired, busy", () => {
  it("a plain next cursor renders 「加载更多」; clicking fetches with the cursor", async () => {
    const h = harness({
      history: [
        { ok: true, page: historyPage({ next: "v1.aaaaaaaaaaa.1", items: [mainItem()] }) },
        { ok: true, page: historyPage({ items: [mainItem({ key: "d/b.jsonl", id: "i2" })] }) },
      ],
    });
    mountDialog(h);
    await flushPromises();
    const more = q<HTMLButtonElement>(".history-foot-actions button");
    expect(more.textContent?.trim()).toBe("Load more");
    await click(more);
    expect(h.historyCalls[1]?.cursor).toBe("v1.aaaaaaaaaaa.1");
    expect(qa(".history-row")).toHaveLength(2);
  });

  it("partial {budget} + cursor AUTO-continues (no button), deduping by key across the rounds", async () => {
    const h = harness({
      history: [
        {
          ok: true,
          page: historyPage({
            items: [mainItem()],
            next: "v1.bbbbbbbbbbb.1",
            partial: { reason: "budget" },
            stats: { files: 9, indexed: 3, enum: { complete: true, dirsDone: 2, dirsTotal: 2 } },
          }),
        },
        {
          ok: true,
          page: historyPage({
            items: [mainItem(), mainItem({ key: "d/c.jsonl", id: "i3" })], // same key again — dedupe
            stats: { files: 9, indexed: 5, enum: { complete: true, dirsDone: 2, dirsTotal: 2 } },
          }),
        },
      ],
    });
    mountDialog(h);
    await flushPromises();
    expect(h.historyCalls).toHaveLength(2); // the auto round fired on its own
    expect(h.historyCalls[1]?.cursor).toBe("v1.bbbbbbbbbbb.1");
    expect(qa(".history-row")).toHaveLength(2); // deduped, not 3
    expect(qa(".history-foot-actions button")).toHaveLength(0); // no next cursor left
  });

  it("zombie partial: NO auto round — the load-more button stays", async () => {
    const h = harness({
      history: [{ ok: true, page: historyPage({ next: "v1.ccccccccccc.1", partial: { reason: "zombie" } }) }],
    });
    mountDialog(h);
    await flushPromises();
    expect(h.historyCalls).toHaveLength(1);
    expect(q<HTMLButtonElement>(".history-foot-actions button").textContent?.trim()).toBe("Load more");
  });

  it("cursor-expired reloads the same query from scratch once; a second expiry becomes an error", async () => {
    const h = harness({
      history: [
        { ok: true, page: historyPage({ next: "v1.ddddddddddd.1", items: [mainItem()] }) },
        { ok: false, error: "E_BAD_REQUEST", status: 409, reason: "cursor-expired" },
        {
          ok: true,
          page: historyPage({ next: "v1.eeeeeeeeeee.1", items: [mainItem({ key: "d/z.jsonl", id: "i9" })] }),
        },
        { ok: false, error: "E_BAD_REQUEST", status: 409, reason: "cursor-expired" },
      ],
    });
    mountDialog(h);
    await flushPromises();
    // load more → expired → auto restart from the beginning (no cursor on call 2)
    await click(q<HTMLButtonElement>(".history-foot-actions button"));
    expect(h.historyCalls[2]?.cursor).toBeUndefined();
    expect(h.historyCalls[2]?.q).toBe("");
    await click(q<HTMLButtonElement>(".history-foot-actions button"));
    expect(q(".history-session-error").textContent).toContain("The list changed on the hub");
    // and the retry button re-issues the query — a MANUAL retry is a NEW query, so it gets
    // its own one auto-restart (call 4's 409 restarts once more via call 5 before erroring)
    await click(q<HTMLButtonElement>(".history-session-error button"));
    expect(h.historyCalls).toHaveLength(6);
    expect(h.historyCalls[4]?.cursor).toBeUndefined();
  });

  it("503 busy renders as a retryable busy state", async () => {
    const h = harness({ history: [{ ok: false, error: "E_BUSY", status: 503 }] });
    mountDialog(h);
    await flushPromises();
    expect(q(".history-session-error").textContent).toContain("The hub is busy");
    expect(q<HTMLButtonElement>(".history-session-error button").textContent?.trim()).toBe("Retry");
  });
});

describe("SessionHistoryDialog: banners + hints", () => {
  it("partial line 「Indexed X / Y」 + the io retry note; the enumerating/近似 hint while enum incomplete", async () => {
    const h = harness({
      history: [
        {
          ok: true,
          page: historyPage({
            items: [mainItem()],
            partial: { reason: "io" },
            stats: { files: 12, indexed: 4, skipped: 2, enum: { complete: false, dirsDone: 1, dirsTotal: 7 } },
          }),
        },
        {
          ok: true,
          page: historyPage({
            items: [],
            partial: { reason: "io" },
            stats: { files: 12, indexed: 4, skipped: 2, enum: { complete: false, dirsDone: 1, dirsTotal: 7 } },
          }),
        },
        {
          ok: true,
          page: historyPage({
            items: [],
            partial: { reason: "io" },
            stats: { files: 12, indexed: 4, skipped: 2, enum: { complete: false, dirsDone: 1, dirsTotal: 7 } },
          }),
        },
        {
          ok: true,
          page: historyPage({
            items: [],
            partial: { reason: "io" },
            stats: { files: 12, indexed: 4, skipped: 2, enum: { complete: false, dirsDone: 1, dirsTotal: 7 } },
          }),
        },
      ],
    });
    mountDialog(h);
    await flushPromises();
    const foot = q(".history-foot");
    expect(foot.textContent).toContain("Indexed 4 of 12 session files");
    expect(foot.textContent).toContain("Some file reads failed — retrying");
    expect(foot.textContent).toContain("Enumerating session directories (1/7)");
    expect(foot.textContent).toContain("approximate");
  });

  it("the skipped banner combines with dirsSkipped / changed / truncated lines", async () => {
    const h = harness({
      history: [
        {
          ok: true,
          page: historyPage({
            stats: {
              files: 5,
              indexed: 5,
              skipped: 3,
              changed: 2,
              enum: { complete: true, dirsDone: 4, dirsTotal: 4, dirsSkipped: 1, dirsTruncated: true },
            },
          }),
        },
      ],
    });
    mountDialog(h);
    await flushPromises();
    const text = qa(".history-banner")
      .map((b) => b.textContent)
      .join("\n");
    expect(text).toContain("3 session files failed to read");
    expect(text).toContain("1 directories could not be read");
    expect(text).toContain("2 sessions' directories were changed");
    expect(text).toContain("The list reached its cap");
  });

  it("liveness note; empty hints (no files vs no match)", async () => {
    const h = harness({
      history: [
        { ok: true, page: historyPage({ liveness: "partial" }) },
        { ok: true, page: historyPage({ liveness: "no-proc" }) },
        {
          ok: true,
          page: historyPage({ stats: { files: 0, indexed: 0, enum: { complete: true, dirsDone: 0, dirsTotal: 0 } } }),
        },
      ],
    });
    mountDialog(h);
    await flushPromises();
    expect(q(".history-foot").textContent).toContain("occupancy detection may be incomplete");
    // kind toggle → second scripted page (files 0, no query)
    await click(q<HTMLInputElement>(".history-kind input"));
    expect(q(".history-empty").textContent).toContain("No session files");
    // search with no hits → the no-match hint
    await type(q<HTMLInputElement>(".history-search input"), "zzz");
    await vi.waitFor(() => expect(h.historyCalls.at(-1)?.q).toBe("zzz"));
    await flushPromises();
    expect(q(".history-empty").textContent).toContain("No sessions match");
  });

  it("the W1–W7 best-effort note ALWAYS renders, W5 and W7 verbatim (en)", async () => {
    const h = harness({ history: [{ ok: true, page: historyPage() }] });
    mountDialog(h);
    await flushPromises();
    const note = q(".history-besteffort");
    expect(note.textContent).toContain("pid is reused by a new process");
    expect(note.textContent).toContain("swapped out and swapped back");
    expect(note.textContent).toContain("(W5)");
    expect(note.textContent).toContain("(W7)");
  });

  it("zh copy: bestEffortNote contains 「pid 被新进程复用」 and 「替换又换回」 (§4.7.2 copy pin)", () => {
    const zh = MESSAGES.zh["history"]?.["bestEffortNote"] ?? "";
    expect(zh).toContain("pid 被新进程复用");
    expect(zh).toContain("替换又换回");
    const en = MESSAGES.en["history"]?.["bestEffortNote"] ?? "";
    expect(en).toContain("pid is reused by a new process");
    expect(en).toContain("swapped out and swapped back");
  });
});

describe("SessionHistoryDialog: resume / fork flows", () => {
  it("a startable row resumes: submit {cwd, session:{key,id,mode:resume}}; awaiting closes the dialog", async () => {
    const h = harness({
      history: [{ ok: true, page: historyPage({ items: [mainItem()] }) }],
      start: async () => ({ ok: true, data: { spawnId: "sp-9", state: "starting" } }),
    });
    const w = mountDialog(h);
    await flushPromises();
    await click(q<HTMLButtonElement>(".history-row-actions button"));
    expect(h.starts).toHaveLength(1);
    expect(h.starts[0]).toEqual({
      id: "req-0-aaaaaaaaaaaa",
      cwd: "/home/u/proj",
      session: { key: "2026-10/a.jsonl", id: "sess-1111-2222", mode: "resume" },
    });
    expect(w.emitted("close")).toHaveLength(1); // awaiting ⇒ close
  });

  it("a forkOnly unverified row: primary IS 「复制为新会话」; confirm submits mode:fork once (PD17)", async () => {
    const h = harness({
      history: [
        {
          ok: true,
          page: historyPage({
            items: [
              mainItem({
                forkOnly: "unverified",
                proofGap: "unconnected-pi",
                live: { state: "maybe", by: "proc", pid: 313 },
              }),
            ],
          }),
        },
      ],
    });
    const w = mountDialog(h);
    await flushPromises();
    const primary = q<HTMLButtonElement>(".history-row-actions button");
    expect(primary.textContent?.trim()).toBe("Copy as new session");
    await click(primary);
    // the local confirm view with the specific gap copy
    const confirm = q(".spawn-confirm");
    expect(confirm.textContent).toContain("pi process not connected to the hub exists (pid 313)");
    expect(confirm.textContent).toContain("best-effort"); // the W1–W7 note rides along
    await click(q<HTMLButtonElement>(".spawn-confirm-actions .btn-primary"));
    expect(h.starts).toHaveLength(1);
    expect(h.starts[0]).toMatchObject({
      cwd: "/home/u/proj",
      session: { key: "2026-10/a.jsonl", id: "sess-1111-2222", mode: "fork" },
      confirm: true,
      expectCwd: "/home/u/proj",
    });
    expect(w.emitted("close")).toHaveLength(1);
  });

  it("the overflow menu's 「复制为新会话」 on a resume row forks (manual confirm text)", async () => {
    const h = harness({
      history: [{ ok: true, page: historyPage({ items: [mainItem()] }) }],
    });
    const w = mountDialog(h);
    await flushPromises();
    await click(qa<HTMLButtonElement>(".history-row-actions button")[1]!); // the ⋯ toggle
    await click(q(".history-overflow-item"));
    const confirm = q(".spawn-confirm");
    expect(confirm.textContent).toContain("A copy of this session will be started"); // manual text
    await click(q<HTMLButtonElement>(".spawn-confirm-actions .btn-primary"));
    expect(h.starts[0]).toMatchObject({ session: { mode: "fork" }, confirm: true });
    expect(w.emitted("close")).toHaveLength(1);
  });

  it("409 session-open: the flow view swaps to HistoryForkConfirm; confirm resends the SAME id as mode:fork", async () => {
    let call = 0;
    const h = harness({
      history: [{ ok: true, page: historyPage({ items: [mainItem()] }) }],
      start: async (req) => {
        call++;
        if (call === 1) {
          return {
            ok: false,
            error: "E_CONFIRM_REQUIRED",
            retryable: false,
            resolvedCwd: "/home/u/proj",
            reason: "session-open",
            forkReason: "open",
            live: { state: "open", by: "card", agentKey: "k9" },
          };
        }
        return { ok: true, data: { spawnId: "sp-2", state: "starting" } };
      },
    });
    const w = mountDialog(h);
    await flushPromises();
    await click(q<HTMLButtonElement>(".history-row-actions button"));
    await flushPromises();
    const confirm = q(".spawn-confirm");
    expect(confirm.textContent).toContain("open by a web session");
    await click(q<HTMLButtonElement>(".spawn-confirm-actions .btn-primary"));
    expect(h.starts).toHaveLength(2);
    expect(h.starts[1]?.id).toBe(h.starts[0]?.id); // SAME id
    expect(h.starts[1]).toMatchObject({ confirm: true, session: { mode: "fork" }, expectCwd: "/home/u/proj" });
    expect(w.emitted("close")).toHaveLength(1);
  });

  it("a non-session 409 reason renders SpawnConfirm instead (the dir-confirm view)", async () => {
    let call = 0;
    const h = harness({
      history: [{ ok: true, page: historyPage({ items: [mainItem()] }) }],
      start: async () => {
        call++;
        return call === 1
          ? { ok: false, error: "E_CONFIRM_REQUIRED", retryable: false, resolvedCwd: "/x", reason: "lan" }
          : { ok: true, data: { spawnId: "sp-3", state: "starting" } };
      },
    });
    mountDialog(h);
    await flushPromises();
    await click(q<HTMLButtonElement>(".history-row-actions button"));
    await flushPromises();
    expect(q(".spawn-confirm").textContent).toContain("Confirm the real directory");
  });

  it("failed{kind:session}: inline session error + the list refreshes", async () => {
    const h = harness({
      history: [
        { ok: true, page: historyPage({ items: [mainItem()] }) },
        { ok: true, page: historyPage({ items: [] }) },
      ],
      start: async () => ({ ok: false, error: "E_DIR", reason: "session-missing", retryable: false }),
    });
    mountDialog(h);
    await flushPromises();
    await click(q<HTMLButtonElement>(".history-row-actions button"));
    await flushPromises();
    expect(q(".history-session-error").textContent).toContain("The session file no longer exists");
    expect(h.historyCalls).toHaveLength(2); // refreshed
    expect(qa(".history-row")).toHaveLength(0);
  });

  it("PD14: without the history cap the resume fails locally — NO request, the session error shows", async () => {
    const h = harness({
      history: [{ ok: true, page: historyPage({ items: [mainItem()] }) }],
      caps: ["spawn.v1"], // no spawn.history.v1
    });
    mountDialog(h);
    await flushPromises();
    await click(q<HTMLButtonElement>(".history-row-actions button"));
    expect(h.starts).toHaveLength(0);
    expect(q(".history-session-error").textContent).toContain("no longer offers session history");
  });
});
