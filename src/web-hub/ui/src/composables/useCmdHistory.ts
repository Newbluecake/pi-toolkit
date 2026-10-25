/**
 * web-hub 命令历史 U1 (plan v2 §4.7) — per-agentKey shared store for the command-history
 * LOCAL state: the placeholder card a web-dispatched command gets the instant it is sent
 * (until its `subagent:cmd` record lands in the transcript), the slim dock notes (「已执行」/
 * 「结果暂未记录」/ dispatch error), and this tab's `seenRunning` timestamps backing
 * `resolveCmdState`'s 5 s append-vs-status grace.
 *
 * Module-level `Map<agentKey, store>` (the `useControl` drafts precedent) instead of
 * provide/inject: DetailDock and Transcript are SIBLINGS under AgentDetail, which is outside
 * U1's file domain — both sides call `useCmdHistory(agentKey)` and share one reactive store.
 * Bounds: ≤16 placeholders / ≤8 notes / ≤64 seenRunning entries per agent, ≤32 agents FIFO.
 * All timers are bounded and cleared when their placeholder/note resolves.
 */
import { reactive } from "vue";
import { CMD_PLACEHOLDER_TIMEOUT_MS } from "@logic/cmdRecord.js";

/** §4.7: the 「已执行 /x」 slim note auto-dismisses after 4 s. */
export const CMD_NOTE_AUTO_DISMISS_MS = 4_000;

const MAX_PLACEHOLDERS = 16;
const MAX_NOTES = 8;
const MAX_SEEN_RUNNING = 64;
const MAX_STORES = 32;

export interface CmdPlaceholder {
  readonly cmdId: string;
  readonly name: string;
  readonly args: string;
  readonly startedAt: number;
}

export type CmdNoteKind = "executed" | "deferred" | "error";

export interface CmdNote {
  readonly id: number;
  readonly kind: CmdNoteKind;
  readonly name: string;
  /** Set on the deferred note so a LATE-arriving real card removes it (§4.7). */
  readonly cmdId?: string;
  readonly error?: string;
  readonly message?: string;
}

export interface CmdHistoryStore {
  readonly placeholders: readonly CmdPlaceholder[];
  readonly notes: readonly CmdNote[];
  /** cmdId → browser-clock epoch ms this tab last saw it in `status.cmdRunning`. */
  readonly seenRunning: ReadonlyMap<string, number>;
  /** Dispatch: put the running placeholder at the transcript tail + arm the 60 s degrade. */
  begin(p: CmdPlaceholder): void;
  /** Records with these cmdIds are visible in the transcript: drop matching placeholders and
   *  deferred notes (the real card replaces both — §4.7's 降级后真卡到达 rule). */
  resolveRecords(cmdIds: Iterable<string>): void;
  /** The reply says this call leaves NO card (`history:"none"` or field absent — n1): drop
   *  the placeholder, show the short-lived 「已执行」 note. */
  finishWithoutCard(cmdId: string, name: string): void;
  /** Dispatch failed effect-none: drop the placeholder, show a manual-dismiss error note. */
  fail(cmdId: string, name: string, error: string, message?: string): void;
  /** Silently drop the placeholder (E_CONFIRM_REQUIRED — the confirm dialog takes over). */
  drop(cmdId: string): void;
  dismissNote(id: number): void;
  /** Stamp every listed cmdId as seen-running NOW (drives `resolveCmdState`'s grace). */
  noteRunning(ids: readonly string[], now?: number): void;
}

interface StoreInner {
  placeholders: CmdPlaceholder[];
  notes: CmdNote[];
  seenRunning: Map<string, number>;
}

/* Timer handles live OUTSIDE the reactive state: under Node/vitest a Timeout is a class
 * instance and `clearTimeout` rejects a reactive Proxy of it (browser numeric handles are
 * unaffected, but the store must behave identically in tests). */
type TimerMap = Map<string | number, ReturnType<typeof setTimeout>>;

function clearTimer(timers: TimerMap, key: string | number): void {
  const timer = timers.get(key);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(key);
  }
}

function removePlaceholder(st: StoreInner, phTimers: TimerMap, cmdId: string): void {
  const i = st.placeholders.findIndex((p) => p.cmdId === cmdId);
  if (i >= 0) st.placeholders.splice(i, 1);
  clearTimer(phTimers, cmdId);
}

function dismissNoteById(st: StoreInner, noteTimers: TimerMap, id: number): void {
  const i = st.notes.findIndex((n) => n.id === id);
  if (i >= 0) st.notes.splice(i, 1);
  clearTimer(noteTimers, id);
}

function pushNote(st: StoreInner, noteTimers: TimerMap, nextId: () => number, note: Omit<CmdNote, "id">): void {
  const id = nextId();
  st.notes.push({ ...note, id });
  while (st.notes.length > MAX_NOTES) {
    const first = st.notes[0];
    if (first !== undefined) dismissNoteById(st, noteTimers, first.id);
    else break;
  }
  if (note.kind === "executed") {
    noteTimers.set(
      id,
      setTimeout(() => dismissNoteById(st, noteTimers, id), CMD_NOTE_AUTO_DISMISS_MS),
    );
  }
}

function makeStore(): CmdHistoryStore {
  const st: StoreInner = reactive({
    placeholders: [],
    notes: [],
    seenRunning: new Map<string, number>(),
  }) as StoreInner;
  const phTimers: TimerMap = new Map();
  const noteTimers: TimerMap = new Map();
  let nextNoteId = 0;
  const nextId = () => ++nextNoteId;

  return {
    placeholders: st.placeholders,
    notes: st.notes,
    seenRunning: st.seenRunning,

    begin(p) {
      removePlaceholder(st, phTimers, p.cmdId);
      st.placeholders.push(p);
      while (st.placeholders.length > MAX_PLACEHOLDERS) {
        const first = st.placeholders[0];
        if (first === undefined) break;
        removePlaceholder(st, phTimers, first.cmdId);
      }
      phTimers.set(
        p.cmdId,
        setTimeout(() => {
          // §4.7 60 s degrade: no record arrived — swap the placeholder for the slim,
          // manually-dismissed 「结果暂未记录」 note. A late real card still removes the note
          // (resolveRecords matches on cmdId).
          removePlaceholder(st, phTimers, p.cmdId);
          pushNote(st, noteTimers, nextId, { kind: "deferred", cmdId: p.cmdId, name: p.name });
        }, CMD_PLACEHOLDER_TIMEOUT_MS),
      );
    },

    resolveRecords(cmdIds) {
      for (const cmdId of cmdIds) {
        removePlaceholder(st, phTimers, cmdId);
        for (const n of [...st.notes]) if (n.cmdId === cmdId) dismissNoteById(st, noteTimers, n.id);
      }
    },

    finishWithoutCard(cmdId, name) {
      removePlaceholder(st, phTimers, cmdId);
      pushNote(st, noteTimers, nextId, { kind: "executed", name });
    },

    fail(cmdId, name, error, message) {
      removePlaceholder(st, phTimers, cmdId);
      pushNote(st, noteTimers, nextId, { kind: "error", name, error, ...(message !== undefined ? { message } : {}) });
    },

    drop(cmdId) {
      removePlaceholder(st, phTimers, cmdId);
    },

    dismissNote(id) {
      dismissNoteById(st, noteTimers, id);
    },

    noteRunning(ids, now = Date.now()) {
      for (const id of ids) {
        st.seenRunning.delete(id); // refresh insertion order (FIFO eviction below)
        st.seenRunning.set(id, now);
      }
      while (st.seenRunning.size > MAX_SEEN_RUNNING) {
        const oldest = st.seenRunning.keys().next().value;
        if (oldest === undefined) break;
        st.seenRunning.delete(oldest);
      }
    },
  };
}

const stores = new Map<string, CmdHistoryStore>();

/** The shared per-agentKey store (created on first use). */
export function useCmdHistory(agentKey: string): CmdHistoryStore {
  const existing = stores.get(agentKey);
  if (existing !== undefined) return existing;
  const created = makeStore();
  stores.set(agentKey, created);
  while (stores.size > MAX_STORES) {
    const oldest = stores.keys().next().value;
    if (oldest === undefined) break;
    stores.delete(oldest);
  }
  return created;
}

/** Test seam: module-level stores survive test boundaries otherwise. Not for production use. */
export function __resetCmdHistoryStores(): void {
  stores.clear();
}
