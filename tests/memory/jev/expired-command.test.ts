// `/mem expired` tests (jev-plan §4 J8, jev-arch §6.3.5): deterministic
// classification via `expiredEntries`/`untilEntries`, the four-option
// interactive loop, main-session gating (no `--list` escape), and the
// non-interactive (web) degrade.

import { describe, expect, test } from "vitest";
import { handleMemExpired, type ExpiredCommandDeps } from "../../../src/memory/jev/expired-command.js";
import { splitEntries } from "../../../src/memory/jev/entries.js";
import type { MemCommandUiLike, MemEntry } from "../../../src/memory/jev/contracts.js";
import type { EntryEditResult, InlineMetaPatch } from "../../../src/memory/jev/entry-edit.js";

function entriesOf(body: string): readonly MemEntry[] {
  return splitEntries("core.md", body, { status: "active", handWritten: false });
}

function fakeUi(selectReplies: readonly (string | undefined)[] = []): {
  ui: MemCommandUiLike;
  notifications: string[];
  selects: { title: string; options: readonly string[] }[];
} {
  const notifications: string[] = [];
  const selects: { title: string; options: readonly string[] }[] = [];
  let i = 0;
  const ui: MemCommandUiLike = {
    notify: (text) => notifications.push(text),
    confirm: async () => true,
    select: async (title, options) => {
      selects.push({ title, options: options.map((o) => o.value) });
      return selectReplies[i++] as never;
    },
  };
  return { ui, notifications, selects };
}

function baseDeps(over: Partial<ExpiredCommandDeps> = {}): {
  deps: ExpiredCommandDeps;
  editCalls: { delete: MemEntry[]; meta: { entry: MemEntry; patch: InlineMetaPatch }[] };
} {
  const editCalls = { delete: [] as MemEntry[], meta: [] as { entry: MemEntry; patch: InlineMetaPatch }[] };
  const deps: ExpiredCommandDeps = {
    dir: "/mem/proj",
    entries: [],
    isChildSession: false,
    interactive: true,
    today: "2026-10-30",
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

describe("/mem expired routing", () => {
  test("no memory dir ⇒ early notify", async () => {
    const { ui, notifications } = fakeUi();
    const { deps } = baseDeps({ dir: undefined });

    await handleMemExpired("", ui, deps);

    expect(notifications).toEqual(["expired: no memory directory for this cwd"]);
  });

  test("no expired/until entries ⇒ short notify, no gating applied", async () => {
    const { ui, notifications } = fakeUi();
    const { deps } = baseDeps({ isChildSession: true, entries: entriesOf("## Rules\n\n- rule one\n") });

    await handleMemExpired("", ui, deps);

    expect(notifications).toEqual(["expired: no entries past their expiry/condition"]);
  });

  test("child session refuses even when entries exist", async () => {
    const entries = entriesOf("- rule one <!-- mem expires=2020-01-01 -->\n");
    const { ui, notifications } = fakeUi();
    const { deps } = baseDeps({ isChildSession: true, entries });

    await handleMemExpired("", ui, deps);

    expect(notifications).toEqual(["expired: requires the interactive main session"]);
  });

  test("non-interactive (web) degrades to a text listing with the terminal pointer", async () => {
    const entries = entriesOf("- rule one <!-- mem expires=2020-01-01 -->\n");
    const { ui, notifications, selects } = fakeUi();
    const { deps } = baseDeps({ interactive: false, entries });

    await handleMemExpired("", ui, deps);

    expect(selects).toEqual([]);
    expect(notifications[0]).toContain("[expired]");
    expect(notifications[0]).toContain("Run /mem expired in the terminal");
  });

  test("groups both expires-passed and until-only entries", async () => {
    const entries = entriesOf(
      '- rule one <!-- mem expires=2020-01-01 -->\n- rule two <!-- mem until="v2.0 ships" -->\n- rule three\n',
    );
    const { ui, notifications } = fakeUi();
    const { deps } = baseDeps({ interactive: false, entries });

    await handleMemExpired("", ui, deps);

    expect(notifications[0]).toContain("2 entries");
    expect(notifications[0]).toContain("[expired]");
    expect(notifications[0]).toContain("[until]");
  });

  test("an expires= dated exactly today is NOT expired yet", async () => {
    const entries = entriesOf("- rule one <!-- mem expires=2026-10-30 -->\n");
    const { ui, notifications } = fakeUi();
    const { deps } = baseDeps({ interactive: false, entries, today: "2026-10-30" });

    await handleMemExpired("", ui, deps);

    expect(notifications).toEqual(["expired: no entries past their expiry/condition"]);
  });
});

describe("/mem expired interactive loop", () => {
  test("Delete removes the entry", async () => {
    const entries = entriesOf("- rule one <!-- mem expires=2020-01-01 -->\n");
    const { ui, selects } = fakeUi(["delete"]);
    const { deps, editCalls } = baseDeps({ entries });

    await handleMemExpired("", ui, deps);

    expect(selects[0]!.options).toEqual(["delete", "extend", "clear", "skip"]);
    expect(editCalls.delete).toEqual([entries[0]]);
  });

  // verdict minor #1: the confirmation title must carry enough of the
  // entry's own content to recognize it before deleting — not just file:line.
  test("the confirmation title includes a content snippet (~24 code points), not just file:line", async () => {
    const entries = entriesOf(
      "- Avoid using GPT models for routing, they are unreliable <!-- mem expires=2020-01-01 -->\n",
    );
    const { ui, selects } = fakeUi(["skip"]);
    const { deps } = baseDeps({ entries });

    await handleMemExpired("", ui, deps);

    expect(selects[0]!.title).toContain("core.md");
    expect(selects[0]!.title).toContain("Avoid using GPT models");
  });

  test("Extend 30 days writes expires = today+30 and clears any until", async () => {
    const entries = entriesOf('- rule one <!-- mem until="v2.0 ships" -->\n');
    const { ui } = fakeUi(["extend"]);
    const { deps, editCalls } = baseDeps({ entries, today: "2026-01-01" });

    await handleMemExpired("", ui, deps);

    expect(editCalls.meta[0]!.patch).toEqual({ expires: "2026-01-31", until: null });
  });

  test("Clear drops both expires and until", async () => {
    const entries = entriesOf("- rule one <!-- mem expires=2020-01-01 -->\n");
    const { ui } = fakeUi(["clear"]);
    const { deps, editCalls } = baseDeps({ entries });

    await handleMemExpired("", ui, deps);

    expect(editCalls.meta[0]!.patch).toEqual({ expires: null, until: null });
  });

  test("Skip leaves the entry untouched", async () => {
    const entries = entriesOf("- rule one <!-- mem expires=2020-01-01 -->\n");
    const { ui, notifications } = fakeUi(["skip"]);
    const { deps, editCalls } = baseDeps({ entries });

    await handleMemExpired("", ui, deps);

    expect(editCalls.delete).toEqual([]);
    expect(editCalls.meta).toEqual([]);
    expect(notifications.at(-1)).toContain("processed 0, skipped 1");
  });

  test("busy result is reported and counted as skipped", async () => {
    const entries = entriesOf("- rule one <!-- mem expires=2020-01-01 -->\n");
    const { ui, notifications } = fakeUi(["delete"]);
    const { deps } = baseDeps({ entries, deleteEntry: async () => "busy" });

    await handleMemExpired("", ui, deps);

    expect(notifications.some((n) => n.includes("busy"))).toBe(true);
    expect(notifications.at(-1)).toContain("processed 0, skipped 1");
  });

  test("processes multiple rows in order and summarizes", async () => {
    const entries = entriesOf(
      '- rule one <!-- mem expires=2020-01-01 -->\n- rule two <!-- mem until="v2.0 ships" -->\n',
    );
    const { ui, notifications } = fakeUi(["delete", "clear"]);
    const { deps, editCalls } = baseDeps({ entries });

    await handleMemExpired("", ui, deps);

    expect(editCalls.delete).toHaveLength(1);
    expect(editCalls.meta).toHaveLength(1);
    expect(notifications.at(-1)).toContain("processed 2, skipped 0");
  });
});
