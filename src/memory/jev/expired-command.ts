// `/mem expired` — jev-plan §4 J8; jev-arch §6.3.5 (到期, deterministic —
// zero Jev calls: entries are classified by `jev/entries.ts`'s
// `expiredEntries`/`untilEntries`, pure predicates over the inline
// `expires`/`until` comment). Pi-free, same `MemCommandUiLike` + deps-bag
// shape as `review-command.ts`.
//
// Unlike `/mem review`, `/mem expired` has no `--list` read-only escape for
// a child session — jev-plan §4 J8's gate is "main-session + interactive
// only" (no partial exception: this feature needs no Jev client at all, so
// there is nothing "degraded" about refusing it outside the main session;
// the refusal is purely about letting a human CONFIRM each deletion/
// extension). A non-interactive main session (web/RPC, `deps.interactive`
// false) still gets the same read-only listing `/mem review --list` would
// show, plus the terminal pointer (Q35).

import type { MemCommandUiLike, MemEntry } from "./contracts.js";
import { expiredEntries, untilEntries } from "./entries.js";
import type { EntryEditResult, InlineMetaPatch } from "./entry-edit.js";

export interface ExpiredCommandDeps {
  readonly dir: string | undefined;
  readonly entries: readonly MemEntry[];
  readonly isChildSession: boolean;
  readonly interactive: boolean;
  /** `YYYY-MM-DD`, injected so tests are deterministic (defaults to today). */
  readonly today?: string;
  readonly deleteEntry: (entry: MemEntry) => Promise<EntryEditResult>;
  readonly setInlineMeta: (entry: MemEntry, patch: InlineMetaPatch) => Promise<EntryEditResult>;
}

const WEB_FALLBACK_NOTE = "Run /mem expired in the terminal to process entries one by one.";

function todayOf(deps: ExpiredCommandDeps): string {
  return deps.today ?? new Date().toISOString().slice(0, 10);
}

function plus30Days(from: string): string {
  const base = Number.isNaN(Date.parse(from)) ? new Date() : new Date(`${from}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + 30);
  return base.toISOString().slice(0, 10);
}

interface ExpiredRow {
  readonly entry: MemEntry;
  readonly kind: "expired" | "until";
}

function rowsOf(entries: readonly MemEntry[], today: string): readonly ExpiredRow[] {
  const expired = expiredEntries(entries, today).map((entry) => ({ entry, kind: "expired" as const }));
  const until = untilEntries(entries).map((entry) => ({ entry, kind: "until" as const }));
  return [...expired, ...until];
}

/** Same shape as `review-command.ts`'s `describeAnchor` — `file › section:
 *  "first ~24 code points of the body…"` — so a confirmation dialog or the
 *  `--list`-equivalent text never asks the user to act on a bare file:line
 *  with no idea what the entry actually says. */
function describeEntry(entry: MemEntry): string {
  const where = entry.section === "" ? entry.file : `${entry.file} › ${entry.section}`;
  const chars = Array.from(entry.body);
  const snippet = chars.slice(0, 24).join("");
  return `${where}: "${snippet}${chars.length > 24 ? "…" : ""}"`;
}

function describeRow(row: ExpiredRow): string {
  const { entry, kind } = row;
  const detail = kind === "expired" ? `expires=${entry.inline.expires ?? "?"}` : `until="${entry.inline.until ?? "?"}"`;
  return `  ${entry.file}:${String(entry.lineStart)} [${kind}] ${detail} — ${describeEntry(entry)}`;
}

function formatList(rows: readonly ExpiredRow[]): string {
  if (rows.length === 0) return "expired: no entries past their expiry/condition";
  return [`expired: ${String(rows.length)} entr${rows.length === 1 ? "y" : "ies"}`, ...rows.map(describeRow)].join(
    "\n",
  );
}

async function act(
  row: ExpiredRow,
  choice: string | undefined,
  today: string,
  ui: MemCommandUiLike,
  deps: ExpiredCommandDeps,
): Promise<boolean> {
  if (choice === "delete") {
    const result = await deps.deleteEntry(row.entry);
    if (result === "busy") {
      ui.notify("expired: memory dir busy — try again");
      return false;
    }
    if (result === "stale") {
      ui.notify("expired: entry changed since it was listed — skipped");
      return false;
    }
    return true;
  }
  if (choice === "extend" || choice === "clear") {
    const patch: InlineMetaPatch =
      choice === "extend" ? { expires: plus30Days(today), until: null } : { expires: null, until: null };
    const result = await deps.setInlineMeta(row.entry, patch);
    if (result === "busy") {
      ui.notify("expired: memory dir busy — try again");
      return false;
    }
    if (result === "stale") {
      ui.notify("expired: entry changed since it was listed — skipped");
      return false;
    }
    return true;
  }
  return false; // skip / cancelled
}

/** `/mem expired` — no arguments besides the degraded-list case; the
 *  interactive loop drives one `ui.select` per entry. */
export async function handleMemExpired(_args: string, ui: MemCommandUiLike, deps: ExpiredCommandDeps): Promise<void> {
  if (deps.dir === undefined) {
    ui.notify("expired: no memory directory for this cwd");
    return;
  }
  const today = todayOf(deps);
  const rows = rowsOf(deps.entries, today);
  if (rows.length === 0) {
    ui.notify(formatList(rows));
    return;
  }
  if (deps.isChildSession) {
    ui.notify("expired: requires the interactive main session");
    return;
  }
  if (!deps.interactive) {
    ui.notify(`${formatList(rows)}\n${WEB_FALLBACK_NOTE}`);
    return;
  }

  let processed = 0;
  let skipped = 0;
  for (const row of rows) {
    const label =
      row.kind === "expired" ? `expired — ${describeEntry(row.entry)}` : `until — ${describeEntry(row.entry)}`;
    const choice = await ui.select(`expired · ${label}`, [
      { value: "delete", label: "Delete" },
      { value: "extend", label: "Extend 30 days" },
      { value: "clear", label: "Clear the expiry" },
      { value: "skip", label: "Skip" },
    ]);
    const acted = await act(row, choice, today, ui, deps);
    if (acted) processed++;
    else skipped++;
  }
  ui.notify(`expired: processed ${String(processed)}, skipped ${String(skipped)}`);
}
