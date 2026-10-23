import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";

export type MentionAutocompleteStatus = "running" | "settled" | "other";

export interface MentionAutocompleteEntry {
  readonly label: string;
  readonly type: string;
  readonly runId: string;
  readonly status: MentionAutocompleteStatus;
}

/** fabric reply-plan §9.5 (package M): one @session completion entry — a directory-cache row
 *  projection (never paths or session files). */
export interface MentionSessionAutocompleteEntry {
  readonly ref: string;
  readonly name?: string;
  readonly cwdLabel: string;
  readonly receive: string;
  readonly busy: boolean;
  /** Channel-plan §4.3: shared channels (canonical names, no `#`); absent/empty ⇒ default-only
   *  (description byte-identical to the pre-channel format). */
  readonly channels?: readonly string[];
  /** Alias-plan §5.4/§6 (AL5b): the row's canonical alias; absent ⇒ pre-alias behavior/description. */
  readonly alias?: string;
}

export interface MentionAutocompleteSource {
  /** Returns only labels which are valid root-child mention targets. */
  entries(): readonly MentionAutocompleteEntry[];
  /** Reply-plan §9.5: session entries from the xs directory cache (the implementation triggers
   *  `refresh("complete")` but NEVER awaits it). Absent ⇔ the xs surface is off — completion
   *  output stays byte-identical (§9.7). A throwing implementation degrades to no entries. */
  sessions?(): readonly MentionSessionAutocompleteEntry[];
  /** Reply-plan §9.5 insert-value rule: true iff `name` satisfies §9.1's bare-form static
   *  conditions (shape ①, not a subagent label ②, no same-name file ③, unique in the cache) so
   *  the entry inserts `@<name>`; otherwise the entry inserts the explicit `@session:<ref>`.
   *  Absent ⇒ never bare (fail-safe to the unambiguous explicit form). */
  sessionBareName?(name: string): boolean;
  /** Alias-plan §5.4: true iff the canonical `alias` may be inserted as `@<alias>` (label/file/unique
   *  checks, cache-only). Absent ⇒ alias entries insert the explicit `@session:<ref>`. */
  sessionBareAlias?(alias: string): boolean;
}

export interface AtToken {
  readonly raw: string;
  readonly prefix: string;
  readonly start: number;
}

/** Extract the @ token immediately before the cursor, at a word boundary. */
export function extractAtToken(line: string, cursorCol: number): AtToken | undefined {
  const beforeCursor = line.slice(0, cursorCol);
  const match = beforeCursor.match(/(?:^|[ \t])(@[^\s]*)$/);
  if (!match) return undefined;
  const raw = match[1];
  if (!raw || raw.includes('"') || raw.includes("'")) return undefined;
  return { raw, prefix: raw.slice(1), start: beforeCursor.length - raw.length };
}

/** Replace only the token before the cursor, preserving text after the cursor. */
export function replaceAtToken(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
  value: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
  const line = lines[cursorLine] ?? "";
  const token = extractAtToken(line, cursorCol);
  if (!token) return { lines, cursorLine, cursorCol };
  const end = cursorCol < line.length && /[ \t]/.test(line[cursorCol] ?? "") ? cursorCol + 1 : cursorCol;
  const nextLine = line.slice(0, token.start) + value + line.slice(end);
  const nextLines = [...lines];
  nextLines[cursorLine] = nextLine;
  return { lines: nextLines, cursorLine, cursorCol: token.start + value.length };
}

/** Layer mention completions over pi's slash/path provider. */
export function createMentionAutocompleteProvider(
  current: AutocompleteProvider,
  source: MentionAutocompleteSource,
): AutocompleteProvider {
  const ownItems = new WeakSet<AutocompleteItem>();
  return {
    triggerCharacters: ["@"],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const token = extractAtToken(lines[cursorLine] ?? "", cursorCol);
      const base = await current.getSuggestions(lines, cursorLine, cursorCol, options);
      if (!token) return base;

      const agentItems = source
        .entries()
        .filter(
          (entry) =>
            /^[^\s]+$/.test(entry.label) &&
            entry.label !== "root" &&
            entry.label !== "system" &&
            entry.label.startsWith(token.prefix),
        )
        .map((entry) => {
          const state =
            entry.status === "running" ? "running" : entry.status === "settled" ? "已结束·@可resume" : "不可用";
          const item: AutocompleteItem = {
            value: `@${entry.label}`,
            label: `@${entry.label}`,
            description: `agent · ${entry.type} · ${state} · ${entry.runId}`,
          };
          ownItems.add(item);
          return item;
        });

      // fabric reply-plan §9.5: session entries AFTER the agent group. The insert value is the
      // bare `@<name>` only when the source's sessionBareName approves (§9.1 ①②③ + cache-unique);
      // every conflicting entry inserts the explicit `@session:<ref>` — completion always yields
      // a deterministic form. A throwing sessions()/sessionBareName() degrades to no entries /
      // explicit refs, never to a broken completion pass.
      let sessionEntries: readonly MentionSessionAutocompleteEntry[] = [];
      try {
        sessionEntries = source.sessions?.() ?? [];
      } catch {
        sessionEntries = [];
      }
      const sessionItems = sessionEntries.flatMap((entry) => {
        let bare = false;
        let aliasValue: string | undefined;
        if (entry.alias !== undefined) {
          try {
            if (source.sessionBareAlias?.(entry.alias) === true) aliasValue = `@${entry.alias}`;
          } catch {
            aliasValue = undefined;
          }
        }
        if (aliasValue === undefined && entry.name !== undefined) {
          try {
            bare = source.sessionBareName?.(entry.name) ?? false;
          } catch {
            bare = false;
          }
        }
        const value = aliasValue ?? (bare && entry.name !== undefined ? `@${entry.name}` : `@session:${entry.ref}`);
        // prefix match on the inserted value, or (alias entries) on the alias as typed (NFKC + ASCII lowercase)
        const typed = token.prefix.normalize("NFKC").replace(/[A-Z]/g, (c) => c.toLowerCase());
        const aliasHit = entry.alias !== undefined && typed.length > 0 && entry.alias.startsWith(typed);
        if (!value.slice(1).startsWith(token.prefix) && !aliasHit) return [];
        const al = entry.alias !== undefined ? `@${entry.alias} · ` : "";
        const chs =
          entry.channels !== undefined && entry.channels.length > 0
            ? `${entry.channels.map((c) => `#${c}`).join(",")} · `
            : "";
        const item: AutocompleteItem = {
          value,
          label: value,
          description: `session · ${al}${chs}${entry.cwdLabel} · ${entry.receive} · ${entry.busy ? "busy" : "idle"}`,
        };
        ownItems.add(item);
        return [item];
      });

      if (agentItems.length === 0 && sessionItems.length === 0) return base;
      return { prefix: token.raw, items: [...agentItems, ...sessionItems, ...(base?.items ?? [])] };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if (ownItems.has(item)) return replaceAtToken(lines, cursorLine, cursorCol, `${item.value} `);
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    ...(current.shouldTriggerFileCompletion
      ? {
          shouldTriggerFileCompletion: (lines: string[], cursorLine: number, cursorCol: number) =>
            current.shouldTriggerFileCompletion!(lines, cursorLine, cursorCol),
        }
      : {}),
  };
}
