// `/mem review` tests (jev-plan §4 J8, jev-arch §6.3.4): routing (--list /
// child session / --run / interactive loop), the per-kind option tables,
// stale/busy propagation, and the non-interactive (web) degrade.

import { describe, expect, test } from "vitest";
import { handleMemReview, type ReviewCommandDeps } from "../../../src/memory/jev/review-command.js";
import { splitEntries } from "../../../src/memory/jev/entries.js";
import type {
  EntryHash,
  JevCommandPort,
  MemCommandUiLike,
  MemEntry,
  ReviewSuggestion,
  ReviewSuggestionView,
} from "../../../src/memory/jev/contracts.js";
import type { EntryEditResult, InlineMetaPatch } from "../../../src/memory/jev/entry-edit.js";

function entriesOf(body: string): readonly MemEntry[] {
  return splitEntries("core.md", body, { status: "active", handWritten: false });
}

function fakeUi(selectReplies: readonly (string | undefined)[] = []): {
  ui: MemCommandUiLike;
  notifications: string[];
  selects: { title: string; options: readonly string[] }[];
  editorTexts: string[];
} {
  const notifications: string[] = [];
  const selects: { title: string; options: readonly string[] }[] = [];
  const editorTexts: string[] = [];
  let i = 0;
  const ui: MemCommandUiLike = {
    notify: (text) => notifications.push(text),
    confirm: async () => true,
    select: async (title, options) => {
      selects.push({ title, options: options.map((o) => o.value) });
      return selectReplies[i++] as never;
    },
    setEditorText: (text) => editorTexts.push(text),
  };
  return { ui, notifications, selects, editorTexts };
}

/** C-J14: `setEditorText` may be unavailable in some UI hosts —
 *  `MemCommandUiLike.setEditorText` is optional for exactly this reason.
 *  `handToAgent` must fall back to `ui.notify` when it's absent. */
function fakeUiNoEditor(selectReplies: readonly (string | undefined)[] = []): {
  ui: MemCommandUiLike;
  notifications: string[];
} {
  const notifications: string[] = [];
  let i = 0;
  const ui: MemCommandUiLike = {
    notify: (text) => notifications.push(text),
    confirm: async () => true,
    select: async (_title, _options) => selectReplies[i++] as never,
  };
  return { ui, notifications };
}

interface PortCalls {
  list: string[];
  run: { cwd: string }[];
  dismiss: string[];
  resolve: string[];
}

function fakePort(suggestions: readonly ReviewSuggestionView[]): { port: JevCommandPort; calls: PortCalls } {
  const calls: PortCalls = { list: [], run: [], dismiss: [], resolve: [] };
  const port: JevCommandPort = {
    statusLine: () => "jev: full",
    report: async () => "REPORT",
    probe: async () => "PROBE",
    retag: async () => "RETAG",
    resetIndex: async () => "RESET",
    tags: {
      list: () => "TAGS",
      add: async () => "TAGS-ADD",
      remove: async () => "TAGS-RM",
      setEnabled: async () => "TAGS-SET",
    },
    review: {
      list: (cwd) => {
        calls.list.push(cwd);
        return suggestions;
      },
      run: async (cwd) => {
        calls.run.push({ cwd });
        return "jev: review pass complete — 0 suggestion(s)";
      },
      dismiss: async (_cwd, id) => {
        calls.dismiss.push(id);
      },
      resolve: async (_cwd, id) => {
        calls.resolve.push(id);
      },
    },
    isChildSession: false,
  };
  return { port, calls };
}

function sugg(over: Partial<ReviewSuggestion> & Pick<ReviewSuggestion, "kind" | "a">): ReviewSuggestion {
  return { id: "s1", p: 0.9, at: "2026-10-30T00:00:00.000Z", ...over };
}

function view(s: ReviewSuggestion, stale = false): ReviewSuggestionView {
  return { suggestion: s, stale };
}

function baseDeps(over: Partial<ReviewCommandDeps> = {}): {
  deps: ReviewCommandDeps;
  editCalls: { delete: MemEntry[]; meta: { entry: MemEntry; patch: InlineMetaPatch }[] };
} {
  const editCalls = { delete: [] as MemEntry[], meta: [] as { entry: MemEntry; patch: InlineMetaPatch }[] };
  const deps: ReviewCommandDeps = {
    cwd: "/proj",
    dir: "/mem/proj",
    entries: [],
    isChildSession: false,
    interactive: true,
    registry: undefined,
    updatedAtOf: (_h: EntryHash) => undefined,
    deleteEntry: async (entry) => {
      editCalls.delete.push(entry);
      return "ok" as EntryEditResult;
    },
    setInlineMeta: async (entry, patch) => {
      editCalls.meta.push({ entry, patch });
      return "ok" as EntryEditResult;
    },
    ...over,
  };
  return { deps, editCalls };
}

describe("/mem review routing", () => {
  test("--list works in a child session and never touches edit ports", async () => {
    const entries = entriesOf("## Rules\n\n- rule one\n- rule two\n");
    const a = entries[0]!;
    const b = entries[1]!;
    const s = sugg({
      kind: "duplicate",
      a: { hash: a.hash, anchor: "core.md|Rules|rule one" },
      b: { hash: b.hash, anchor: "core.md|Rules|rule two" },
    });
    const { port, calls } = fakePort([view(s)]);
    const { ui, notifications } = fakeUi();
    const { deps } = baseDeps({ isChildSession: true, entries });

    await handleMemReview("--list", ui, port, deps);

    expect(calls.list).toEqual(["/proj"]);
    expect(notifications[0]).toContain("1 open suggestion");
    expect(notifications[0]).toContain("[duplicate]");
  });

  test("no memory dir ⇒ early notify, no port calls", async () => {
    const { port, calls } = fakePort([]);
    const { ui, notifications } = fakeUi();
    const { deps } = baseDeps({ dir: undefined });

    await handleMemReview("", ui, port, deps);

    expect(notifications).toEqual(["review: no memory directory for this cwd"]);
    expect(calls.list).toEqual([]);
  });

  test("child session refuses the default interactive form", async () => {
    const { port } = fakePort([view(sugg({ kind: "obsolete", a: { hash: "h1", anchor: "core.md||x" } }))]);
    const { ui, notifications } = fakeUi();
    const { deps } = baseDeps({ isChildSession: true });

    await handleMemReview("", ui, port, deps);

    expect(notifications).toEqual(["review: requires the interactive main session"]);
  });

  test("--run dispatches to port.review.run when interactive", async () => {
    const { port, calls } = fakePort([]);
    const { ui, notifications } = fakeUi();
    const { deps } = baseDeps({ interactive: true });

    await handleMemReview("--run", ui, port, deps);

    expect(calls.run).toEqual([{ cwd: "/proj" }]);
    expect(notifications[0]).toContain("review pass complete");
  });

  // jev-arch §6.3.4 / hygiene-flow Q35 (verdict nit #3): a non-interactive
  // (web) `--run` degrades to the `--list` text WITHOUT ever calling
  // `port.review.run` — confirming it in the web UI spends no Jev call.
  test("--run from a non-interactive caller never calls port.review.run; degrades to --list text", async () => {
    const entries = entriesOf("## Rules\n\n- rule one\n");
    const s = sugg({ kind: "obsolete", a: { hash: entries[0]!.hash, anchor: "core.md|Rules|rule one" } });
    const { port, calls } = fakePort([view(s)]);
    const { ui, notifications, selects } = fakeUi();
    const { deps } = baseDeps({ interactive: false, entries });

    await handleMemReview("--run", ui, port, deps);

    expect(calls.run).toEqual([]);
    expect(selects).toEqual([]);
    expect(notifications[0]).toContain("[obsolete]");
    expect(notifications[0]).toContain("Run /mem review in the terminal");
  });

  test("non-interactive (web) default degrades to the --list text plus the terminal pointer", async () => {
    const entries = entriesOf("## Rules\n\n- rule one\n");
    const s = sugg({ kind: "obsolete", a: { hash: entries[0]!.hash, anchor: "core.md|Rules|rule one" } });
    const { port } = fakePort([view(s)]);
    const { ui, notifications, selects } = fakeUi();
    const { deps } = baseDeps({ interactive: false, entries });

    await handleMemReview("", ui, port, deps);

    expect(selects).toEqual([]);
    expect(notifications[0]).toContain("Run /mem review in the terminal");
  });

  test("no open suggestions ⇒ short notify, no loop", async () => {
    const { port } = fakePort([]);
    const { ui, notifications, selects } = fakeUi();
    const { deps } = baseDeps();

    await handleMemReview("", ui, port, deps);

    expect(notifications).toEqual(["review: no open suggestions"]);
    expect(selects).toEqual([]);
  });
});

describe("/mem review interactive loop", () => {
  test("duplicate, ages unknown: explicit A/B delete options, deletes the chosen side and resolves", async () => {
    const entries = entriesOf("## Rules\n\n- rule one\n- rule two\n");
    const [a, b] = entries;
    const s = sugg({
      kind: "duplicate",
      a: { hash: a!.hash, anchor: "core.md|Rules|rule one" },
      b: { hash: b!.hash, anchor: "core.md|Rules|rule two" },
    });
    const { port, calls } = fakePort([view(s)]);
    const { ui, selects } = fakeUi(["delete-b"]);
    const { deps, editCalls } = baseDeps({ entries });

    await handleMemReview("", ui, port, deps);

    expect(selects[0]!.options).toEqual(["delete-a", "delete-b", "agent", "keep", "skip"]);
    expect(editCalls.delete).toEqual([b]);
    expect(calls.resolve).toEqual(["s1"]);
  });

  test("duplicate, ages known: single delete-older option picks the right side", async () => {
    const entries = entriesOf("## Rules\n\n- rule one\n- rule two\n");
    const [a, b] = entries;
    const s = sugg({
      kind: "duplicate",
      a: { hash: a!.hash, anchor: "core.md|Rules|rule one" },
      b: { hash: b!.hash, anchor: "core.md|Rules|rule two" },
    });
    const { port, calls } = fakePort([view(s)]);
    const updatedAtOf = (h: EntryHash): string | undefined => (h === a!.hash ? "2026-01-01" : "2026-06-01");
    const { ui, selects } = fakeUi(["delete-a"]);
    const { deps, editCalls } = baseDeps({ entries, updatedAtOf });

    await handleMemReview("", ui, port, deps);

    expect(selects[0]!.options).toEqual(["delete-a", "agent", "keep", "skip"]);
    expect(editCalls.delete).toEqual([a]);
    expect(calls.resolve).toEqual(["s1"]);
  });

  test("supersedes: 'Keep' dismisses the pair forever instead of resolving it", async () => {
    const entries = entriesOf("## Rules\n\n- rule one\n- rule two\n");
    const [a, b] = entries;
    const s = sugg({ kind: "supersedes", a: { hash: a!.hash, anchor: "x" }, b: { hash: b!.hash, anchor: "y" } });
    const { port, calls } = fakePort([view(s)]);
    const { ui } = fakeUi(["keep"]);
    const { deps, editCalls } = baseDeps({ entries });

    await handleMemReview("", ui, port, deps);

    expect(calls.dismiss).toEqual(["s1"]);
    expect(calls.resolve).toEqual([]);
    expect(editCalls.delete).toEqual([]);
  });

  test("conflict: 'Hand to agent' fills the editor and resolves", async () => {
    const entries = entriesOf("## Rules\n\n- rule one\n- rule two\n");
    const [a, b] = entries;
    const s = sugg({ kind: "conflict", a: { hash: a!.hash, anchor: "x" }, b: { hash: b!.hash, anchor: "y" } });
    const { port, calls } = fakePort([view(s)]);
    const { ui, editorTexts } = fakeUi(["agent"]);
    const { deps } = baseDeps({ entries });

    await handleMemReview("", ui, port, deps);

    expect(editorTexts).toHaveLength(1);
    expect(editorTexts[0]).toContain("conflict");
    expect(calls.resolve).toEqual(["s1"]);
  });

  // plan §4 J8 test list ("C-J14 消费"; verdict minor #2): `setEditorText`
  // unavailable ⇒ `handToAgent` falls back to `ui.notify` with the same
  // instruction text, and still resolves the suggestion.
  test("conflict: 'Hand to agent' falls back to ui.notify when setEditorText is unavailable", async () => {
    const entries = entriesOf("## Rules\n\n- rule one\n- rule two\n");
    const [a, b] = entries;
    const s = sugg({ kind: "conflict", a: { hash: a!.hash, anchor: "x" }, b: { hash: b!.hash, anchor: "y" } });
    const { port, calls } = fakePort([view(s)]);
    const { ui, notifications } = fakeUiNoEditor(["agent"]);
    const { deps } = baseDeps({ entries });

    await handleMemReview("", ui, port, deps);

    expect(notifications.some((n) => n.includes("conflict"))).toBe(true);
    expect(calls.resolve).toEqual(["s1"]);
  });

  test("obsolete: 'Extend 30 days' patches expires and resolves", async () => {
    const entries = entriesOf("## Rules\n\n- rule one\n");
    const a = entries[0]!;
    const s = sugg({ kind: "obsolete", a: { hash: a.hash, anchor: "x" } });
    const { port, calls } = fakePort([view(s)]);
    const { ui } = fakeUi(["extend"]);
    const { deps, editCalls } = baseDeps({ entries });

    await handleMemReview("", ui, port, deps);

    expect(editCalls.meta).toHaveLength(1);
    expect(editCalls.meta[0]!.patch.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(calls.resolve).toEqual(["s1"]);
  });

  test("user-like: 'Mark as user order' sets authority=user", async () => {
    const entries = entriesOf("## Rules\n\n- rule one\n");
    const a = entries[0]!;
    const s = sugg({ kind: "user-like", a: { hash: a.hash, anchor: "x" } });
    const { port, calls } = fakePort([view(s)]);
    const { ui } = fakeUi(["mark"]);
    const { deps, editCalls } = baseDeps({ entries });

    await handleMemReview("", ui, port, deps);

    expect(editCalls.meta[0]!.patch).toEqual({ authority: "user" });
    expect(calls.resolve).toEqual(["s1"]);
  });

  test("skip leaves the suggestion untouched", async () => {
    const entries = entriesOf("## Rules\n\n- rule one\n");
    const a = entries[0]!;
    const s = sugg({ kind: "obsolete", a: { hash: a.hash, anchor: "x" } });
    const { port, calls } = fakePort([view(s)]);
    const { ui, notifications } = fakeUi(["skip"]);
    const { deps, editCalls } = baseDeps({ entries });

    await handleMemReview("", ui, port, deps);

    expect(calls.resolve).toEqual([]);
    expect(calls.dismiss).toEqual([]);
    expect(editCalls.delete).toEqual([]);
    expect(notifications.at(-1)).toContain("processed 0, skipped 1");
  });

  test("a vanished entry (hash no longer in deps.entries) is skipped without any port call", async () => {
    const s = sugg({ kind: "obsolete", a: { hash: "nope", anchor: "x" } });
    const { port, calls } = fakePort([view(s)]);
    const { ui, selects, notifications } = fakeUi();
    const { deps } = baseDeps({ entries: [] });

    await handleMemReview("", ui, port, deps);

    expect(selects).toEqual([]);
    expect(calls.resolve).toEqual([]);
    expect(notifications.at(-1)).toContain("processed 0, skipped 1");
  });

  test("busy delete: suggestion stays open, counted as skipped", async () => {
    const entries = entriesOf("## Rules\n\n- rule one\n");
    const a = entries[0]!;
    const s = sugg({ kind: "obsolete", a: { hash: a.hash, anchor: "x" } });
    const { port, calls } = fakePort([view(s)]);
    const { ui, notifications } = fakeUi(["delete"]);
    const { deps } = baseDeps({ entries, deleteEntry: async () => "busy" });

    await handleMemReview("", ui, port, deps);

    expect(calls.resolve).toEqual([]);
    expect(notifications.some((n) => n.includes("busy"))).toBe(true);
  });
});
