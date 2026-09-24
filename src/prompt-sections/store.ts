import { POINTED, initialSectionState, type SectionName, type SectionState } from "./stable-section.js";

export const PROMPT_SECTIONS_ENTRY_TYPE = "subagent:prompt-sections";

export interface PersistedSectionV1 {
  snapshot: string;
  announced?: string;
  pointer?: true;
  stale?: true;
  sentCount: number;
  sentBytes: number;
}

export interface PromptSectionsEntryV1 {
  v: 1;
  sections: Partial<Record<SectionName, PersistedSectionV1>>;
}

export type ReadBackReason = "startup" | "reload" | "new" | "resume" | "fork" | "tree";

const NAMES: readonly SectionName[] = ["pi_project_memory", "pi_subagent_types", "pi_subagent_models"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function isName(value: string): value is SectionName {
  return (NAMES as readonly string[]).includes(value);
}

function sanitizeSection(raw: unknown): PersistedSectionV1 | undefined {
  if (!isRecord(raw) || typeof raw.snapshot !== "string" || !isCount(raw.sentCount) || !isCount(raw.sentBytes))
    return undefined;
  if (raw.announced !== undefined && typeof raw.announced !== "string") return undefined;
  if (raw.pointer !== undefined && raw.pointer !== true) return undefined;
  if (raw.stale !== undefined && raw.stale !== true) return undefined;
  if (raw.pointer === true && raw.announced !== undefined) return undefined;
  return {
    snapshot: raw.snapshot,
    ...(typeof raw.announced === "string" ? { announced: raw.announced } : {}),
    ...(raw.pointer === true ? { pointer: true } : {}),
    ...(raw.stale === true ? { stale: true } : {}),
    sentCount: raw.sentCount,
    sentBytes: raw.sentBytes,
  };
}

export function serializeSectionStates(states: ReadonlyMap<SectionName, SectionState>): PromptSectionsEntryV1 {
  const sections: Partial<Record<SectionName, PersistedSectionV1>> = {};
  for (const [name, state] of states) {
    if (state.snapshot === undefined) continue;
    sections[name] = {
      snapshot: state.snapshot,
      ...(typeof state.announced === "string" && state.announced !== state.snapshot
        ? { announced: state.announced }
        : {}),
      ...(state.announced === POINTED ? { pointer: true } : {}),
      ...(state.stale ? { stale: true } : {}),
      sentCount: state.sentCount,
      sentBytes: state.sentBytes,
    };
  }
  return { v: 1, sections };
}

export function sanitizePromptSectionsEntry(raw: unknown): PromptSectionsEntryV1 | undefined {
  if (!isRecord(raw) || raw.v !== 1 || !isRecord(raw.sections)) return undefined;
  const sections: Partial<Record<SectionName, PersistedSectionV1>> = {};
  for (const [name, section] of Object.entries(raw.sections)) {
    if (!isName(name)) continue;
    const clean = sanitizeSection(section);
    if (clean) sections[name] = clean;
  }
  return { v: 1, sections };
}

function toState(section: PersistedSectionV1): SectionState {
  return {
    snapshot: section.snapshot,
    announced: section.pointer ? POINTED : (section.announced ?? section.snapshot),
    stale: section.stale === true,
    sentCount: section.sentCount,
    sentBytes: section.sentBytes,
  };
}

export function readBackSectionStates(
  branch: readonly unknown[],
  reason: ReadBackReason,
  registered: readonly SectionName[],
): { states: Map<SectionName, SectionState>; exact: boolean; serialized: string } | undefined {
  if (reason === "new") return undefined;
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index] as { type?: unknown; customType?: unknown; data?: unknown } | undefined;
    if (entry?.type !== "custom" || entry.customType !== PROMPT_SECTIONS_ENTRY_TYPE) continue;
    const clean = sanitizePromptSectionsEntry(entry.data);
    if (!clean) continue;
    const states = new Map<SectionName, SectionState>();
    for (const name of registered)
      states.set(name, clean.sections[name] ? toState(clean.sections[name]!) : initialSectionState());
    const exact =
      reason === "reload" &&
      !branch.slice(index + 1).some((item) => (item as { type?: unknown })?.type === "compaction");
    return { states, exact, serialized: JSON.stringify(clean) };
  }
  return undefined;
}
