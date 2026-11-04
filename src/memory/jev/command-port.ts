// `JevCommandPort` implementation (jev-plan §4 J4; the port shape itself is
// frozen in contracts.ts). Serves `/mem jev` (report/probe/retag/reset-index),
// `/mem tags` (list/add/rm/disable/enable) and the review read/run/dismiss/
// resolve surface J8's `/mem review` builds on.
//
// All fs access goes through index-store.ts (safe-fs primitives); the port
// itself never imports node:fs. The optional `config` / `usage` / `segment`
// / `health` deps fill the `/mem jev` report's model rows, usage line and
// segment counters — those live in J6's wire closure and the plain
// `JevClient` interface does not expose them (root-approved additions); each
// has a safe default so the port works standalone.
//
// Write-ish subcommands (`retag`, `reset-index`, `tags add/rm/disable/
// enable`, `review run/dismiss/resolve`) refuse child sessions; the /mem
// command layer additionally requires `ctx.hasUI` (plan §4 J4). Everything
// returns strings (or throws never) — command.ts just notifies them.
//
// Pi-free root; instance state only (I4).

import { coverage } from "./health.js";
import {
  gcIndex,
  readIndex,
  readTaxonomyFile,
  removeIndex,
  writeIndexPatch,
  writeTaxonomyFile,
} from "./index-store.js";
import { runReviewPass, anchorOf, markStale } from "./review.js";
import { tagBulk, taggableEntries } from "./tagging.js";
import { mergeTaxonomy, validateTagDef, PRESET_TAGS } from "./taxonomy.js";
import { formatJevReport, formatStatusLine } from "./format.js";
import { parseProxyUrl, redactProxyUrl } from "./proxy-fetch.js";
import { EntryIndex } from "./entries.js";
import type {
  ClassifierRegistryLike,
  EntryHash,
  EntryTags,
  HealthTable,
  JevClient,
  JevCommandPort,
  JevConfig,
  JevIndexV1,
  JevReportView,
  JevStatus,
  JevUsage,
  MemEntry,
  ReviewSuggestion,
  ReviewSuggestionView,
  ReviewState,
  TagDef,
  TagDefInput,
  TaxonomyFileV1,
} from "./contracts.js";

export interface JevCommandPortDeps {
  readonly client: JevClient;
  readonly entryIndex: EntryIndex;
  /** Canonical memory slug dir for a cwd; `undefined` ⇒ no memory here. */
  readonly dirFor: (cwd: string) => string | undefined;
  readonly now: () => number;
  readonly isChildSession: boolean;
  /** Fire-and-forget background bulk-tagging kick (migration / tag backfill),
   *  provided by the wire layer. */
  readonly triggerBulk: (cwd: string) => void;
  // ── root-approved optional report providers (J6 wires; safe defaults) ──
  /** Classifier list + maxCostUsd for the models/usage rows. */
  readonly config?: JevConfig;
  /** Per-activation usage counters (JevClientHandle.usage). */
  readonly usage?: () => JevUsage;
  /** Segment injection counters from the wire closure. */
  readonly segment?: () => JevReportView["segment"];
  /** Health table for per-model notes (defaults to the shared table). */
  readonly health?: HealthTable;
}

const ZERO_SEGMENT: JevReportView["segment"] = {
  injectedByLayer: {},
  injectedTotal: 0,
};

// ───────────────────────────── report text helpers ─────────────────────────────

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const STOPPED_WHEN_JUDGED_DOWN: readonly string[] = ["recall U", "error recall E", "write tagging", "review run"];
const ZERO_CALL_RUNNING: readonly string[] = ["action fast path A", "re-inject after compaction B", "review list"];

function statusText(status: JevStatus): string {
  switch (status.kind) {
    case "off":
      return `off (${status.reason})`;
    case "probing":
      return "enabled · probing";
    case "full":
      return `enabled · full · ${status.model}`;
    case "partial": {
      const parts = [`enabled · partial (${status.reason})`];
      if (status.retryAt !== undefined) parts.push(`next probe ${hhmm(status.retryAt)}`);
      return parts.join(" · ");
    }
  }
}

function modelNote(
  state: { readonly state: string; readonly code?: string; readonly until?: number },
  now: number,
): string | undefined {
  if (
    (state.state === "unavailable" || state.state === "transient") &&
    state.until !== undefined &&
    state.until > now
  ) {
    const code = state.code ?? state.state;
    const base = `unavailable (${code}) until ${hhmm(state.until)}`;
    return code === "451" ? `${base} — 451 多为地区拦截，可设 memory.jev.proxy` : base;
  }
  return undefined;
}

function stoppedRunning(status: JevStatus): { stopped: readonly string[]; running: readonly string[] } {
  switch (status.kind) {
    case "full":
      return { stopped: [], running: [...STOPPED_WHEN_JUDGED_DOWN, ...ZERO_CALL_RUNNING] };
    case "probing":
    case "partial":
      return { stopped: STOPPED_WHEN_JUDGED_DOWN, running: ZERO_CALL_RUNNING };
    case "off":
      return {
        stopped: [...STOPPED_WHEN_JUDGED_DOWN, "action fast path A", "re-inject after compaction B"],
        running: ["review list"],
      };
  }
}

// ───────────────────────────── taxonomy file helpers ─────────────────────────────

function emptyTaxonomyFile(): TaxonomyFileV1 {
  return { v: 1, tags: [], disabledPresets: [] };
}

function renderTagList(
  tags: readonly TagDef[],
  kind: (t: TagDef) => string,
  opts: { readonly total: number; readonly rev: string; readonly extra?: string },
): string {
  const lines = [`tags ${tags.length} enabled / 64 max · taxonomy ${opts.rev}${opts.extra ?? ""}`];
  for (const t of tags) {
    const risk = t.risk === "high" ? " [high]" : "";
    lines.push(`  ${t.id.padEnd(18, " ")}${t.label}${risk} — ${t.description} (${kind(t)})`);
  }
  return lines.join("\n");
}

function mainSessionRefusal(op: string): string {
  return `jev: ${op} is main-session only`;
}

// ───────────────────────────── the port ─────────────────────────────

export function createJevCommandPort(deps: JevCommandPortDeps): JevCommandPort {
  const isoNow = (): string => new Date(deps.now()).toISOString();

  const dirOf = (cwd: string): string | undefined => deps.dirFor(cwd);
  const entriesOf = (dir: string): readonly MemEntry[] => deps.entryIndex.get(dir);

  const presetsRev = (): string => {
    const merged = mergeTaxonomy();
    if (!merged.ok) throw new Error(merged.error); // presets never fail to merge
    return merged.taxonomy.rev;
  };
  const taxonomyOf = (dir: string | undefined): { rev: string; error?: string } => {
    if (dir === undefined) return { rev: presetsRev() };
    const file = readTaxonomyFile(dir);
    if (file === undefined) return { rev: presetsRev() };
    const merged = mergeTaxonomy(file);
    if (!merged.ok) return { rev: presetsRev(), error: merged.error };
    return { rev: merged.taxonomy.rev };
  };

  const indexAndEntries = (
    cwd: string,
  ): { dir: string; index: JevIndexV1; entries: readonly MemEntry[] } | undefined => {
    const dir = dirOf(cwd);
    if (dir === undefined) return undefined;
    return { dir, index: readIndex(dir).index, entries: entriesOf(dir) };
  };

  const patchReview = async (cwd: string, mutate: (review: ReviewState) => ReviewState): Promise<boolean> => {
    const ctx = indexAndEntries(cwd);
    if (ctx === undefined || ctx.index.review === undefined) return false;
    const review = mutate(ctx.index.review);
    return (await writeIndexPatch(ctx.dir, { review })) === "ok";
  };

  const statusLine = (cwd: string): string => {
    try {
      const ctx = indexAndEntries(cwd);
      const cov = ctx === undefined ? { tagged: 0, total: 0, pending: 0 } : coverage(ctx.entries, ctx.index);
      const status = deps.client.status();
      return formatStatusLine(status, {
        tagged: cov.tagged,
        total: cov.total,
        ...(ctx?.index.lastTaggedAt === undefined ? {} : { lastTaggedAt: ctx.index.lastTaggedAt }),
        ...(deps.usage === undefined ? {} : { usage: deps.usage() }),
      });
    } catch {
      return "jev: status unavailable";
    }
  };

  const report = async (cwd: string, _registry: ClassifierRegistryLike | undefined): Promise<string> => {
    const ctx = indexAndEntries(cwd);
    const rebuilt = ctx === undefined ? false : readIndex(ctx.dir).rebuilt;
    const entries = ctx === undefined ? [] : ctx.entries;
    const index = ctx === undefined ? { v: 1 as const, entries: {} as Record<EntryHash, EntryTags> } : ctx.index;
    const cov = coverage(entries, index);
    const tax = taxonomyOf(ctx?.dir);
    const status = deps.client.status();
    const now = deps.now();
    const health = deps.health;
    const models: { id: string; note?: string }[] = [];
    for (const id of deps.config?.classifiers ?? []) {
      const h = health?.get(id);
      const note = h === undefined ? undefined : modelNote(h, now);
      models.push(note === undefined ? { id } : { id, note });
    }
    const sr = stoppedRunning(status);
    const liveHashes = new Set(entries.map((e) => e.hash));
    const suggestions = markStale(index.review?.suggestions ?? [], liveHashes);
    const usage = deps.usage?.() ?? { costUsd: 0, calls: 0 };
    return formatJevReport({
      status: `${statusText(status)}${rebuilt ? " · index rebuilt" : ""}${tax.error === undefined ? "" : " · taxonomy file invalid (presets in use)"}`,
      models,
      stopped: sr.stopped,
      running: sr.running,
      tags: {
        tagged: cov.tagged,
        total: cov.total,
        pending: cov.pending,
        ...(index.lastTaggedAt === undefined ? {} : { lastTaggedAt: index.lastTaggedAt }),
        taxonomyRev: tax.rev,
      },
      ...proxyView(deps.config?.proxy ?? ""),
      usage: { calls: usage.calls, costUsd: usage.costUsd, maxCostUsd: deps.config?.maxCostUsd ?? 0 },
      segment: deps.segment?.() ?? ZERO_SEGMENT,
      review: {
        // §9.4 shows a date-only `last 2026-10-28`; the sidecar keeps the full
        // ISO stamp (§6.3.1 intervalDays needs it) — trim at the view edge
        // (format.ts is J1-frozen).
        ...(index.review?.lastRunAt === undefined ? {} : { lastRunAt: index.review.lastRunAt.slice(0, 10) }),
        open: suggestions.filter((s) => !s.stale).length,
      },
    });
  };

  const probe = async (registry: ClassifierRegistryLike | undefined): Promise<string> => {
    if (registry === undefined) return "jev: probe unavailable — no classifier registry in this session context";
    const status = await deps.client.probe(registry);
    return `jev: probe → ${statusText(status)}`;
  };

  const retag = async (cwd: string, all: boolean, registry: ClassifierRegistryLike | undefined): Promise<string> => {
    if (deps.isChildSession) return mainSessionRefusal("retag");
    const ctx = indexAndEntries(cwd);
    if (ctx === undefined) return "jev: no memory directory for this cwd";
    if (registry === undefined) return "jev: retag unavailable — no classifier registry in this session context";
    const taxonomy = mergeTaxonomy(readTaxonomyFile(ctx.dir));
    if (!taxonomy.ok) return `jev: retag refused — taxonomy file invalid (${taxonomy.error})`;
    const eligible = taggableEntries(ctx.entries);
    const targets = all ? eligible : eligible.filter((e) => ctx.index.entries[e.hash] === undefined);
    if (targets.length === 0) {
      return `jev: nothing to tag (${all ? "no taggable entries" : "no pending entries"})`;
    }
    const upserts: Record<EntryHash, EntryTags> = {};
    const result = await tagBulk({
      client: deps.client,
      registry,
      entries: targets,
      taxonomy: taxonomy.taxonomy,
      // `--all` re-tags everything: no base records, so every entry runs the
      // entry part again; without --all only pending entries are processed.
      ...(all ? {} : { base: ctx.index.entries }),
      onEntryTags: (hash, tags) => {
        upserts[hash] = tags;
      },
    });
    const live = new Set(ctx.entries.map((e) => e.hash));
    // Corpus-aware GC of the merged view, then persist ONLY the fresh
    // records — the store merges by hash over the current file, so records
    // written concurrently (J5 write port) are never clobbered.
    const gc = gcIndex({ v: 1, entries: { ...ctx.index.entries, ...upserts } }, live);
    const fresh = Object.fromEntries(Object.entries(upserts).filter(([hash]) => gc.entries[hash] !== undefined));
    const write =
      Object.keys(fresh).length === 0
        ? "ok"
        : await writeIndexPatch(ctx.dir, { upsert: fresh, lastTaggedAt: isoNow() });
    return [
      `jev: retag ${result.tagged}/${result.tagged + result.pending} tagged · ${result.calls} calls · $${result.costUsd.toFixed(4)}`,
      write === "busy" ? " · sidecar busy — results not saved, rerun later" : "",
    ].join("");
  };

  const resetIndex = async (cwd: string): Promise<string> => {
    if (deps.isChildSession) return mainSessionRefusal("reset-index");
    const dir = dirOf(cwd);
    if (dir === undefined) return "jev: no memory directory for this cwd";
    try {
      const out = await removeIndex(dir);
      return out === "busy"
        ? "jev: reset-index skipped — memory dir busy, try again"
        : "jev: sidecar index cleared (taxonomy kept)";
    } catch (err) {
      return `jev: reset-index failed: ${(err as Error).message}`;
    }
  };

  const tagsList = (cwd: string): string => {
    const dir = dirOf(cwd);
    if (dir === undefined) return "tags: no memory directory for this cwd";
    const file = readTaxonomyFile(dir);
    const merged = mergeTaxonomy(file ?? undefined);
    if (!merged.ok) {
      const presetsMerged = mergeTaxonomy();
      if (presetsMerged.ok) {
        return [
          `tags: taxonomy file invalid (${merged.error}) — presets in use`,
          renderTagList(presetsMerged.taxonomy.tags, () => "preset", {
            total: presetsMerged.taxonomy.tags.length,
            rev: presetsMerged.taxonomy.rev,
          }),
        ].join("\n");
      }
      return `tags: taxonomy file invalid (${merged.error})`;
    }
    const disabledPresets = file?.disabledPresets ?? [];
    const body = renderTagList(merged.taxonomy.tags, (t) => (t.source === "preset" ? "preset" : "user"), {
      total: merged.taxonomy.tags.length,
      rev: merged.taxonomy.rev,
    });
    if (disabledPresets.length === 0) return body;
    return `${body}\ndisabled presets: ${[...disabledPresets].sort().join(", ")}`;
  };

  const writeTaxonomy = async (dir: string, file: TaxonomyFileV1, note: string): Promise<string> => {
    const out = await writeTaxonomyFile(dir, file);
    if (out === "busy") return "tags: memory dir busy — change not saved, try again";
    return note;
  };

  const tagsAdd = async (cwd: string, def: TagDefInput): Promise<string> => {
    if (deps.isChildSession) return "tags: add is main-session only";
    const dir = dirOf(cwd);
    if (dir === undefined) return "tags: no memory directory for this cwd";
    const validated = validateTagDef(def);
    if (!validated.ok) return `tags: ${validated.error}`;
    const file = readTaxonomyFile(dir) ?? emptyTaxonomyFile();
    const existing = file.tags.find((t) => t.id === validated.def.id);
    let tags: readonly TagDef[];
    let changeNote: string;
    if (existing === undefined) {
      tags = [...file.tags, validated.def];
      changeNote = `added ${validated.def.id} (backfill queued)`;
    } else {
      // Editing an existing user tag: description change bumps rev (the
      // backfill re-asks that tag); matcher-only edits do not (§4.3.1).
      const rev = existing.description === validated.def.description ? existing.rev : existing.rev + 1;
      tags = file.tags.map((t) => (t.id === existing.id ? { ...validated.def, rev } : t));
      changeNote = `updated ${validated.def.id}${existing.description === validated.def.description ? "" : " (rev bumped, backfill queued)"}`;
    }
    const next: TaxonomyFileV1 = { v: 1, tags, disabledPresets: file.disabledPresets };
    const merged = mergeTaxonomy(next);
    if (!merged.ok) return `tags: ${merged.error}`;
    const note = await writeTaxonomy(dir, next, `tags: ${changeNote}`);
    if (note.startsWith("tags: added") || note.includes("rev bumped")) deps.triggerBulk(cwd);
    return note;
  };

  const tagsRemove = async (cwd: string, id: string): Promise<string> => {
    if (deps.isChildSession) return "tags: rm is main-session only";
    const dir = dirOf(cwd);
    if (dir === undefined) return "tags: no memory directory for this cwd";
    const file = readTaxonomyFile(dir) ?? emptyTaxonomyFile();
    if (PRESET_TAGS.some((t) => t.id === id)) {
      return `tags: ${id} is a preset (presets can be disabled, not removed) — /mem tags disable ${id}`;
    }
    if (!file.tags.some((t) => t.id === id)) return `tags: no user tag ${JSON.stringify(id)}`;
    const next: TaxonomyFileV1 = {
      v: 1,
      tags: file.tags.filter((t) => t.id !== id),
      disabledPresets: file.disabledPresets,
    };
    return writeTaxonomy(dir, next, `tags: removed ${id} (existing judgments are ignored from now on)`);
  };

  const tagsSetEnabled = async (cwd: string, id: string, enabled: boolean): Promise<string> => {
    if (deps.isChildSession) return `tags: ${enabled ? "enable" : "disable"} is main-session only`;
    const dir = dirOf(cwd);
    if (dir === undefined) return "tags: no memory directory for this cwd";
    const file = readTaxonomyFile(dir) ?? emptyTaxonomyFile();
    const isPreset = PRESET_TAGS.some((t) => t.id === id);
    if (isPreset) {
      const disabled = new Set(file.disabledPresets);
      if (enabled) {
        if (!disabled.has(id)) return `tags: preset ${id} is already enabled`;
        disabled.delete(id);
      } else {
        if (disabled.has(id)) return `tags: preset ${id} is already disabled`;
        disabled.add(id);
      }
      const next: TaxonomyFileV1 = { v: 1, tags: file.tags, disabledPresets: [...disabled].sort() };
      const note = await writeTaxonomy(
        dir,
        next,
        `tags: ${id} ${enabled ? "enabled" : "disabled"}${enabled ? " (backfill queued)" : ""}`,
      );
      if (enabled) deps.triggerBulk(cwd);
      return note;
    }
    if (!enabled) {
      // User tags have no disabled slot in the file (§4.3.1): disabling one
      // removes it; re-add with /mem tags add to bring it back.
      if (!file.tags.some((t) => t.id === id)) return `tags: no user tag ${JSON.stringify(id)}`;
      const next: TaxonomyFileV1 = {
        v: 1,
        tags: file.tags.filter((t) => t.id !== id),
        disabledPresets: file.disabledPresets,
      };
      return writeTaxonomy(dir, next, `tags: user tag ${id} removed (user tags are re-added, not re-enabled)`);
    }
    return `tags: ${JSON.stringify(id)} is not a disabled preset — user tags are re-added with /mem tags add`;
  };

  const reviewList = (cwd: string): readonly ReviewSuggestionView[] => {
    const ctx = indexAndEntries(cwd);
    if (ctx === undefined) return [];
    const live = new Set(ctx.entries.map((e) => e.hash));
    return markStale(ctx.index.review?.suggestions ?? [], live);
  };

  const reviewRun = async (cwd: string, registry: ClassifierRegistryLike | undefined): Promise<string> => {
    if (deps.isChildSession) return mainSessionRefusal("review run");
    const ctx = indexAndEntries(cwd);
    if (ctx === undefined) return "jev: no memory directory for this cwd";
    if (registry === undefined) return "jev: review run unavailable — no classifier registry in this session context";
    const outcome = await runReviewPass({
      client: deps.client,
      registry,
      entries: ctx.entries,
      index: ctx.index,
      today: isoNow().slice(0, 10),
      // The slug dir's basename is the cwd's last path segment — the closest
      // thing to a project name the port can see without a new dep.
      project: ctx.dir.split("/").filter(Boolean).pop() ?? "",
    });
    if ("ok" in outcome) {
      return `jev: review run failed (${outcome.reason}${outcome.detail === "" ? "" : `: ${outcome.detail.slice(0, 160)}`})`;
    }
    const write = await writeIndexPatch(ctx.dir, { review: outcome });
    const open = outcome.suggestions.length;
    return `jev: review pass complete — ${open} suggestion(s)${write === "busy" ? " · sidecar busy, results not saved" : ""} → /mem review`;
  };

  const reviewDismiss = async (cwd: string, id: string): Promise<void> => {
    await patchReview(cwd, (review) => {
      const suggestion = review.suggestions.find((s) => s.id === id) as ReviewSuggestion | undefined;
      if (suggestion === undefined) return review;
      const anchorOfSuggestion = (side: { hash: EntryHash; anchor: string }): string => side.anchor;
      const dismissed = [
        ...review.dismissed,
        {
          hashKey:
            suggestion.b === undefined ? suggestion.a.hash : [suggestion.a.hash, suggestion.b.hash].sort().join("+"),
          anchorKey:
            suggestion.b === undefined
              ? anchorOfSuggestion(suggestion.a)
              : [anchorOfSuggestion(suggestion.a), anchorOfSuggestion(suggestion.b)].sort().join("+"),
        },
      ];
      return { ...review, suggestions: review.suggestions.filter((s) => s.id !== id), dismissed };
    });
  };

  const reviewResolve = async (cwd: string, id: string): Promise<void> => {
    await patchReview(cwd, (review) =>
      review.suggestions.some((s) => s.id === id)
        ? { ...review, suggestions: review.suggestions.filter((s) => s.id !== id) }
        : review,
    );
  };

  return {
    statusLine,
    report,
    probe,
    retag,
    resetIndex,
    tags: { list: tagsList, add: tagsAdd, remove: tagsRemove, setEnabled: tagsSetEnabled },
    review: { list: reviewList, run: reviewRun, dismiss: reviewDismiss, resolve: reviewResolve },
    isChildSession: deps.isChildSession,
  };
}

// ───────────────────────────── /mem tags add argument parsing ─────────────────────────────

/**
 * Minimal quote-aware tokenizer: whitespace-separated tokens; single- or
 * double-quoted spans keep their spaces (quotes removed). Unterminated
 * quotes swallow to the end (self-written per the plan's J4 risk note —
 * web-hub's cmdArgs is not shared across the boundary).
 */
export function tokenizeTagsArgs(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  for (const ch of input) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur !== "") {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur !== "") out.push(cur);
  return out;
}

export type ParseTagsAddResult = { ok: true; def: TagDefInput } | { ok: false; error: string };

export const TAGS_ADD_USAGE =
  'usage: /mem tags add <id> --label <label> --desc "…" [--risk high] [--commands a,b] [--paths a,b] [--tools a,b]';

/** Parse `/mem tags add` tokens into a `TagDefInput`. */
export function parseTagsAddArgs(tokens: readonly string[]): ParseTagsAddResult {
  const id = tokens[0];
  if (id === undefined || id.startsWith("-")) return { ok: false, error: TAGS_ADD_USAGE };
  let label: string | undefined;
  let description: string | undefined;
  let risk: "normal" | "high" | undefined;
  let commands: string[] | undefined;
  let paths: string[] | undefined;
  let tools: string[] | undefined;
  const csv = (raw: string | undefined): string[] | undefined =>
    raw === undefined
      ? undefined
      : raw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "");

  for (let i = 1; i < tokens.length; i++) {
    const flag = tokens[i]!;
    const value = tokens[i + 1];
    if (value === undefined) return { ok: false, error: `missing value for ${flag}` };
    switch (flag) {
      case "--label":
        label = value;
        break;
      case "--desc":
      case "--description":
        description = value;
        break;
      case "--risk":
        if (value !== "high" && value !== "normal") return { ok: false, error: `--risk must be high or normal` };
        risk = value;
        break;
      case "--commands":
        commands = csv(value);
        break;
      case "--paths":
        paths = csv(value);
        break;
      case "--tools":
        tools = csv(value);
        break;
      default:
        return { ok: false, error: `unknown option ${flag}` };
    }
    i += 1;
  }
  if (label === undefined || description === undefined) {
    return { ok: false, error: "--label and --desc are required" };
  }
  return {
    ok: true,
    def: {
      id,
      label,
      description,
      ...(risk === undefined ? {} : { risk }),
      ...(commands === undefined ? {} : { commands }),
      ...(paths === undefined ? {} : { paths }),
      ...(tools === undefined ? {} : { tools }),
    },
  };
}

/** `/mem jev` proxy line: credentials always masked (`http://***@host:port`);
 *  an unparsable/unsupported proxy is shown as ignored (the client treats it
 *  as "not configured"). Empty ⇒ no line. */
function proxyView(proxy: string): { proxy?: string } {
  if (proxy === "") return {};
  const shown = redactProxyUrl(proxy);
  return {
    proxy: parseProxyUrl(proxy) === undefined ? `${shown} — ignored (only http:// proxies are supported)` : shown,
  };
}
