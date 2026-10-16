/**
 * Resume (web-resume plan v2 §2.6, package P3) — the ALWAYS-LOADED pure core, plus the
 * FROZEN §2.4 wire types (type-only; zero runtime bytes).
 *
 * Budget rule (plan §4 P3, first-screen 255 KiB gate): only the pieces the composer gate,
 * the dock intercept and the header 「恢复」 button need BEFORE any dialog opens live here —
 * everything heavier (the wire validator, `knownLiveElsewhere`, the whole state machine)
 * sits in the LAZY chunk (`composables/useResume.ts`, mounted only when `ResumeDialog.vue`
 * first opens) and is re-exported from there. This file is imported statically by
 * `Composer.vue` / `DetailDock.vue` / `DetailHeader.vue`, so every runtime export here costs
 * first-screen bytes — keep it lean.
 *
 * Pure/DOM-free like `./sessionHistory.ts`: the only Vue reference is a type-only
 * `InjectionKey` import (erased at build — zero runtime dependency on Vue), and every
 * function here runs unchanged under vitest.
 */
import type { InjectionKey } from "vue";

/** §2.4's scope vocabulary: the 48 h window (default) or every session in the current dir. */
export type ResumeScope = "recent" | "all";

/** §2.6: `parseResumeIntent(text)` → `{scope}` for `resume`, `/resume`, `/resume-recent`
 * (each optionally ` --all`) — everything else is `null` and keeps its old routing. */
export interface ResumeIntent {
  readonly scope: ResumeScope;
}

/**
 * The bare (no-slash) form is `resume` only — TUI session-nav never aliased a bare
 * `resume-recent`; `/resume` and `/resume-recent` are the slash forms. Leading/trailing
 * whitespace is tolerated (the composer text is trimmed by the gate anyway), but the body
 * must be EXACTLY the alias + optional `--all` — `resume foo` stays a plain prompt.
 */
const RESUME_INTENT_RE = /^(?:\/(resume(?:-recent)?)|resume)(\s+--all)?$/;

export function parseResumeIntent(text: string): ResumeIntent | null {
  if (typeof text !== "string") return null;
  const m = RESUME_INTENT_RE.exec(text.trim());
  if (m === null) return null;
  return { scope: m[2] !== undefined ? "all" : "recent" };
}

/**
 * §2.6/§2.7: the feature signal — `status.features` carries `"resume.v1"` iff the agent is
 * new, control is on, the session is persisted and the policy allows `resume`. An old agent
 * never sends `features`, so this is false and every resume affordance stays hidden
 * (compat matrix §2.8 row 1: byte-identical old behaviour).
 */
export function resumeAvailable(status: unknown): boolean {
  if (status === null || typeof status !== "object") return false;
  const features = (status as { features?: unknown }).features;
  return Array.isArray(features) && features.includes("resume.v1");
}

/**
 * §2.6: `decoratePalette(rows)` — while the feature is available, the agent-advertised
 * `/resume` + `/resume-recent` rows (policy `deny` per §2.7, so old UIs keep refusing them)
 * render as RUNNABLE with the 「恢复会话」 description: the new UI intercepts the text
 * client-side (§2.6 DetailDock first line) and never sends the command. `desc === null`
 * (feature off) returns the rows untouched — the deny badge + reason stay exactly as today.
 */
export interface PaletteRowLike {
  readonly name: string;
  readonly description: string;
  readonly policy: string;
  readonly output?: string | null;
}

export function decoratePalette<T extends PaletteRowLike>(rows: readonly T[], desc: string | null): readonly T[] {
  if (desc === null || desc === undefined) return rows;
  return rows.map((row) =>
    row.name === "resume" || row.name === "resume-recent" ? { ...row, policy: "allow", description: desc } : row,
  );
}

// ---------------------------------------------------------------------------
// §2.4 wire types (FROZEN) — RECONCILED: P2 landed them in `@protocol/messages.ts`
// (byte-identical to the shapes this file mirrored during parallel development), so the
// frozen protocol module is the single source of truth again. Type-only re-export — zero
// runtime bytes on the first-screen budget.
// ---------------------------------------------------------------------------

export type { ResumeSessionRowWire, ResumeSessionsWire } from "@protocol/messages.js";

// ---------------------------------------------------------------------------
// Dialog host seam (§2.6): `AgentDetail` provides, `DetailDock`/`DetailHeader` inject. The
// key lives HERE (not in `useResume.ts`) because the composable must stay in the lazy chunk.
// ---------------------------------------------------------------------------

/** The eager half's whole interface: open the (lazy) dialog at a scope. */
export interface ResumeDialogHost {
  open(intent: ResumeIntent): void;
}

export const RESUME_DIALOG: InjectionKey<ResumeDialogHost> = Symbol("web-hub-resume-dialog");
