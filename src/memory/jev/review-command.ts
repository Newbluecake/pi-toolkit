// `/mem review` — jev-plan §4 J8; jev-arch §6.3.3/§6.3.4. Pi-free: takes a
// structured `MemCommandUiLike` instead of `ExtensionCommandContext`, the
// already-wired `JevCommandPort` (J4) and a small deps bag the pi-aware
// `command.ts` builds (cwd/dir resolution, the live entry list, the
// interactivity flag, and the two fs-touching primitives from
// `entry-edit.ts`). Never imports `@earendil-works/*` (I8).
//
// `--list` is always read-only and allowed in a child session (jev-arch
// §6.3.4: "查看并执行已有建议" — viewing is zero-call). Everything else
// (the default interactive loop, `--run`) requires the interactive main
// session; a non-interactive caller (web/RPC — `deps.interactive` false)
// gets the same text the terminal would show for `--list`, plus one line
// pointing back at the terminal (Q35 hygiene-flow) — `--run` in particular
// NEVER calls `port.review.run` from a non-interactive caller, so a
// confirmed web `/mem review --run` spends no Jev call at all.
//
// The interactive loop never throws: `ui.select` returning undefined (the
// dialog was cancelled) is treated exactly like "Skip".

import type {
  ClassifierRegistryLike,
  EntryHash,
  JevCommandPort,
  MemCommandUiLike,
  MemEntry,
  ReviewSuggestion,
  ReviewSuggestionView,
} from "./contracts.js";
import type { EntryEditResult, InlineMetaPatch } from "./entry-edit.js";

export interface ReviewCommandDeps {
  readonly cwd: string;
  /** Canonical memory directory; `undefined` ⇒ no memory for this cwd. */
  readonly dir: string | undefined;
  /** Live entries for `dir` (already fetched by the caller — command.ts's
   *  own `EntryIndex`), used to resolve a suggestion's hash to a concrete
   *  `MemEntry` before editing it. */
  readonly entries: readonly MemEntry[];
  readonly isChildSession: boolean;
  /** `ctx.mode === "tui" && ctx.hasUI && !isWebInvocation(ctx)` — gates the
   *  per-suggestion `ui.select` loop (Q35). */
  readonly interactive: boolean;
  readonly registry: ClassifierRegistryLike | undefined;
  /** Sidecar `at` for a hash, when tagged — used only to pick which side of
   *  a `duplicate` pair is older; `undefined` when either side is untagged
   *  (the user is offered an explicit A/B choice instead, see below). */
  readonly updatedAtOf: (hash: EntryHash) => string | undefined;
  readonly deleteEntry: (entry: MemEntry) => Promise<EntryEditResult>;
  readonly setInlineMeta: (entry: MemEntry, patch: InlineMetaPatch) => Promise<EntryEditResult>;
}

const WEB_FALLBACK_NOTE = "Run /mem review in the terminal to process suggestions one by one.";

/** `anchorOf`'s `file|section|first-24-code-points` shape (jev/review.ts),
 *  rendered for a human. Never throws on a malformed anchor. */
function describeAnchor(anchor: string): string {
  const parts = anchor.split("|");
  const file = parts[0] ?? "?";
  const section = parts[1] ?? "";
  const snippet = parts.slice(2).join("|");
  const where = section === "" ? file : `${file} › ${section}`;
  return `${where}: "${snippet}${snippet.length >= 24 ? "…" : ""}"`;
}

function formatSuggestion(view: ReviewSuggestionView): string {
  const s = view.suggestion;
  const tag = view.stale ? " (stale)" : "";
  const vs = s.b === undefined ? "" : ` vs ${describeAnchor(s.b.anchor)}`;
  return `  [${s.kind}] p=${s.p.toFixed(2)}${tag} ${describeAnchor(s.a.anchor)}${vs}`;
}

function formatList(views: readonly ReviewSuggestionView[]): string {
  if (views.length === 0) return "review: no suggestions";
  const open = views.filter((v) => !v.stale).length;
  return [
    `review: ${String(open)} open suggestion${open === 1 ? "" : "s"} (${String(views.length)} total)`,
    ...views.map(formatSuggestion),
  ].join("\n");
}

function plus30Days(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 30);
  return d.toISOString().slice(0, 10);
}

async function deleteAndResolve(
  entry: MemEntry,
  id: string,
  ui: MemCommandUiLike,
  port: JevCommandPort,
  deps: ReviewCommandDeps,
): Promise<boolean> {
  const result = await deps.deleteEntry(entry);
  if (result === "busy") {
    ui.notify("review: memory dir busy — try again");
    return false;
  }
  if (result === "stale") {
    ui.notify("review: entry changed since this suggestion was made — skipped");
    return false;
  }
  await port.review.resolve(deps.cwd, id);
  return true;
}

async function setMetaAndResolve(
  entry: MemEntry,
  patch: InlineMetaPatch,
  id: string,
  ui: MemCommandUiLike,
  port: JevCommandPort,
  deps: ReviewCommandDeps,
): Promise<boolean> {
  const result = await deps.setInlineMeta(entry, patch);
  if (result === "busy") {
    ui.notify("review: memory dir busy — try again");
    return false;
  }
  if (result === "stale") {
    ui.notify("review: entry changed since this suggestion was made — skipped");
    return false;
  }
  await port.review.resolve(deps.cwd, id);
  return true;
}

async function handToAgent(
  instruction: string,
  id: string,
  ui: MemCommandUiLike,
  port: JevCommandPort,
  deps: ReviewCommandDeps,
): Promise<boolean> {
  if (ui.setEditorText) ui.setEditorText(instruction);
  else ui.notify(instruction);
  await port.review.resolve(deps.cwd, id);
  return true;
}

async function keepForever(id: string, port: JevCommandPort, deps: ReviewCommandDeps): Promise<boolean> {
  await port.review.dismiss(deps.cwd, id);
  return true;
}

/** jev-arch §6.3.4's per-kind option table, executed. Returns `true` when
 *  the suggestion was acted on (resolved/dismissed), `false` for "Skip" or
 *  a cancelled/busy/stale attempt (the suggestion stays open). */
async function processSuggestion(
  s: ReviewSuggestion,
  a: MemEntry,
  b: MemEntry | undefined,
  ui: MemCommandUiLike,
  port: JevCommandPort,
  deps: ReviewCommandDeps,
): Promise<boolean> {
  switch (s.kind) {
    case "duplicate": {
      const atA = deps.updatedAtOf(a.hash);
      const atB = b === undefined ? undefined : deps.updatedAtOf(b.hash);
      const olderIsA = atA !== undefined && atB !== undefined && atA !== atB ? atA < atB : undefined;
      const options =
        olderIsA === undefined
          ? [
              { value: "delete-a", label: `Delete A — ${describeAnchor(s.a.anchor)}` },
              { value: "delete-b", label: `Delete B — ${describeAnchor(s.b?.anchor ?? "")}` },
              { value: "agent", label: "Hand to agent — merge" },
              { value: "keep", label: "Keep both (don't ask again)" },
              { value: "skip", label: "Skip" },
            ]
          : [
              {
                value: olderIsA ? "delete-a" : "delete-b",
                label: `Delete older — ${describeAnchor(olderIsA ? s.a.anchor : (s.b?.anchor ?? ""))}`,
              },
              { value: "agent", label: "Hand to agent — merge" },
              { value: "keep", label: "Keep both (don't ask again)" },
              { value: "skip", label: "Skip" },
            ];
      const choice = await ui.select(`review ${s.id} · duplicate`, options);
      if (choice === "delete-a") return deleteAndResolve(a, s.id, ui, port, deps);
      if (choice === "delete-b" && b !== undefined) return deleteAndResolve(b, s.id, ui, port, deps);
      if (choice === "agent") {
        return handToAgent(
          `Merge these duplicate memory entries: ${describeAnchor(s.a.anchor)} and ${describeAnchor(s.b?.anchor ?? "")}.`,
          s.id,
          ui,
          port,
          deps,
        );
      }
      if (choice === "keep") return keepForever(s.id, port, deps);
      return false;
    }
    case "supersedes": {
      const options = [
        { value: "delete", label: `Delete superseded — ${describeAnchor(s.b?.anchor ?? "")}` },
        { value: "agent", label: "Hand to agent — rewrite" },
        { value: "keep", label: "Keep" },
        { value: "skip", label: "Skip" },
      ];
      const choice = await ui.select(`review ${s.id} · supersedes`, options);
      if (choice === "delete" && b !== undefined) return deleteAndResolve(b, s.id, ui, port, deps);
      if (choice === "agent") {
        return handToAgent(
          `Rewrite the superseded memory entry ${describeAnchor(s.b?.anchor ?? "")} to match ${describeAnchor(s.a.anchor)}.`,
          s.id,
          ui,
          port,
          deps,
        );
      }
      if (choice === "keep") return keepForever(s.id, port, deps);
      return false;
    }
    case "conflict": {
      const options = [
        { value: "agent", label: "Hand to agent — draft a unified version" },
        { value: "keep", label: "Keep" },
        { value: "skip", label: "Skip" },
      ];
      const choice = await ui.select(`review ${s.id} · conflict`, options);
      if (choice === "agent") {
        return handToAgent(
          `These two memory entries conflict — draft one unified entry: ${describeAnchor(s.a.anchor)} vs ${describeAnchor(s.b?.anchor ?? "")}.`,
          s.id,
          ui,
          port,
          deps,
        );
      }
      if (choice === "keep") return keepForever(s.id, port, deps);
      return false;
    }
    case "obsolete": {
      const options = [
        { value: "delete", label: "Delete" },
        { value: "extend", label: "Extend 30 days" },
        { value: "permanent", label: "Make permanent" },
        { value: "skip", label: "Skip" },
      ];
      const choice = await ui.select(`review ${s.id} · obsolete — ${describeAnchor(s.a.anchor)}`, options);
      if (choice === "delete") return deleteAndResolve(a, s.id, ui, port, deps);
      if (choice === "extend") return setMetaAndResolve(a, { expires: plus30Days() }, s.id, ui, port, deps);
      if (choice === "permanent") return setMetaAndResolve(a, { expires: null, until: null }, s.id, ui, port, deps);
      return false;
    }
    case "user-like": {
      const options = [
        { value: "mark", label: "Mark as user order" },
        { value: "lesson", label: "Keep as lesson" },
        { value: "skip", label: "Skip" },
      ];
      const choice = await ui.select(`review ${s.id} · suspected user order — ${describeAnchor(s.a.anchor)}`, options);
      if (choice === "mark") return setMetaAndResolve(a, { authority: "user" }, s.id, ui, port, deps);
      if (choice === "lesson") return keepForever(s.id, port, deps);
      return false;
    }
    default:
      return false;
  }
}

/** `/mem review [--list | --run]`. `--list` is always a real read-only
 *  list; `--run` and the bare interactive default both degrade to that same
 *  text for a non-interactive (web/non-tui) caller — jev-arch §6.3.4 /
 *  hygiene-flow Q35: "web 端执行 review 需要确认，确认后降级为只读文本清单并提示
 *  回终端处理，不做任何写入" — `--run` never actually spends a Jev call from
 *  a non-interactive caller. */
export async function handleMemReview(
  args: string,
  ui: MemCommandUiLike,
  port: JevCommandPort,
  deps: ReviewCommandDeps,
): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const sub = tokens[0];
  if (deps.dir === undefined) {
    ui.notify("review: no memory directory for this cwd");
    return;
  }
  if (sub === "--list") {
    ui.notify(formatList(port.review.list(deps.cwd)));
    return;
  }
  if (deps.isChildSession) {
    ui.notify("review: requires the interactive main session");
    return;
  }
  if (sub !== undefined && sub !== "--run") {
    ui.notify("usage: /mem review [--list | --run]");
    return;
  }

  if (sub === "--run") {
    if (!deps.interactive) {
      ui.notify(`${formatList(port.review.list(deps.cwd))}\n${WEB_FALLBACK_NOTE}`);
      return;
    }
    ui.notify(await port.review.run(deps.cwd, deps.registry));
    return;
  }

  const views = port.review.list(deps.cwd).filter((v) => !v.stale);
  if (views.length === 0) {
    ui.notify("review: no open suggestions");
    return;
  }
  if (!deps.interactive) {
    ui.notify(`${formatList(views)}\n${WEB_FALLBACK_NOTE}`);
    return;
  }

  let processed = 0;
  let skipped = 0;
  for (const view of views) {
    const s = view.suggestion;
    const entryA = deps.entries.find((e) => e.hash === s.a.hash);
    const entryB = s.b === undefined ? undefined : deps.entries.find((e) => e.hash === s.b?.hash);
    if (entryA === undefined || (s.b !== undefined && entryB === undefined)) {
      skipped++;
      continue; // vanished since listed — a fresh list() call will mark it stale
    }
    const acted = await processSuggestion(s, entryA, entryB, ui, port, deps);
    if (acted) processed++;
    else skipped++;
  }
  ui.notify(`review: processed ${String(processed)}, skipped ${String(skipped)}`);
}
