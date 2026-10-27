/**
 * #72 AF4 / alias-force-default §5.3: monotonic, session-scoped human intent.
 * AFW supplies ALL entries (getEntries, never getBranch) and a synchronous appendEntry
 * adapter. No pi imports, disk access, process globals or timers live here.
 */
export const XS_ALIAS_DECIDED_CUSTOM_TYPE = "subagent:xs-alias-decided";

export type XsAliasDecidedVia = "set" | "clear" | "take" | "force" | "inherit";
export interface XsAliasDecidedEntryData {
  v: 1;
  sessionId: string;
  at: number;
  via: XsAliasDecidedVia;
}
export type XsAliasMarkDecided = (via: XsAliasDecidedVia) => void;
export interface XsAliasDecidedPort {
  decided(): boolean;
  markDecided: XsAliasMarkDecided;
}

/** Latest valid matching entry wins; malformed entries cannot undo an earlier decision. */
export function readXsAliasDecidedEntry(
  entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>,
  sessionId: string,
): XsAliasDecidedEntryData | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.type !== "custom" || entry.customType !== XS_ALIAS_DECIDED_CUSTOM_TYPE) continue;
    const d = entry.data as Partial<XsAliasDecidedEntryData> | null | undefined;
    if (
      d?.v !== 1 ||
      d.sessionId !== sessionId ||
      sessionId === "" ||
      typeof d.at !== "number" ||
      !Number.isFinite(d.at) ||
      d.at < 0 ||
      (d.via !== "set" && d.via !== "clear" && d.via !== "take" && d.via !== "force" && d.via !== "inherit")
    )
      continue;
    return { v: 1, sessionId, at: d.at, via: d.via };
  }
  return undefined;
}

/** One instance per stack/sid. Memory is set BEFORE append; append failure never re-enables auto. */
export function createXsAliasDecided(deps: {
  sessionId: string;
  entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>;
  persist(data: XsAliasDecidedEntryData): void;
  now?: () => number;
}): XsAliasDecidedPort {
  let decided = readXsAliasDecidedEntry(deps.entries, deps.sessionId) !== undefined;
  return {
    decided: () => decided,
    markDecided(via) {
      decided = true;
      try {
        deps.persist({ v: 1, sessionId: deps.sessionId, at: (deps.now ?? Date.now)(), via });
      } catch {
        // In-memory intent is still authoritative for this stack.
      }
    },
  };
}
