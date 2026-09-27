// §6 `/mem doctor` command dispatch + §6.2 summary line + §6.3 startup
// reminder — todo #22 P3.
//
// `handleMemDoctorCommand`'s signature is the one the P0-b frozen
// `command.ts` already calls unconditionally for `/mem doctor` — kept
// byte-identical (`(args, ctx, deps) => Promise<void>`) so this package
// never needs to touch `command.ts`. `DoctorCommandDeps` only ADDS optional
// fields on top of the original stub's `{ paths?: MemoryPaths }` (`settings`,
// `renderTieredPort`, `now`) — `command.ts` still only ever passes `paths`,
// so every new field falls back to its documented default there; tests
// inject the rest directly.
//
// P5 production wiring appends the summary in `command.ts` and registers the
// startup reminder in `index.ts`; both paths use the real renderer/doctor.

import { createHash } from "node:crypto";
import type { ExtensionCommandContext, ExtensionHandler, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { resolveWorktreeOrigin } from "../core/worktree-origin.js";
import type { MemorySettings } from "../config/settings.js";
import type { DoctorFinding, TieredRenderInput, TieredRenderResult } from "./contracts.js";
import {
  formatDoctorReport,
  runDoctor,
  type DoctorSettings,
  type DoctorSkippedFile,
  type DoctorSnapshot,
  type DoctorSnapshotFile,
} from "./doctor.js";
import { parseMemoryMeta } from "./meta.js";
import { memoryDirFor, type MemoryPaths } from "./paths.js";
import { canonicalDirState, listRegular, readRegular } from "./safe-fs.js";
import { renderTiered } from "./tiered.js";

export type RenderTieredPort = (input: TieredRenderInput) => TieredRenderResult;

/** Real production port: P1's `renderTiered`. Errors are still handled as
 * best-effort degradation by the command/reminder callers. */
const DEFAULT_RENDER_PORT: RenderTieredPort = (input) => renderTiered(input);

export interface DoctorCommandDeps {
  paths?: MemoryPaths;
  /** Production callers thread the activate-time settings snapshot. */
  settings: MemorySettings;
  renderTieredPort?: RenderTieredPort;
  /** Clock for D08's staleDays comparison. Defaults to `Date.now`. */
  now?: () => number;
}

function toDoctorSettings(settings: MemorySettings): DoctorSettings {
  return {
    coreBytes: settings.coreBytes,
    blockBytes: settings.blockBytes,
    topicWarnBytes: settings.topicWarnBytes,
    topicMaxBytes: settings.topicMaxBytes,
    staleDays: settings.doctor.staleDays,
  };
}

/** Build a real `DoctorSnapshot` from the filesystem for `cwd` (§6's I/O
 *  layer — `doctor.ts`'s `runDoctor` stays pure). Never throws: a missing
 *  memory dir simply yields an empty snapshot (0 files), same as every
 *  other memory read path. */
function buildSnapshot(
  cwd: string,
  paths: MemoryPaths | undefined,
  settings: MemorySettings,
  renderPort: RenderTieredPort,
  now: () => number,
): DoctorSnapshot {
  const display = memoryDirFor(cwd, paths);
  const state = canonicalDirState(display);
  const canon = state.state === "ok" ? state.dir : undefined;
  const dir = canon ? canon.real : display;

  const { files: regularFiles, skipped } = listRegular(dir, { names: "v2" });
  const files: DoctorSnapshotFile[] = regularFiles.map((rf) => {
    let content = "";
    try {
      content = readRegular(dir, rf.name).text;
    } catch {
      content = ""; // raced delete / became a symlink — treat as empty, never fatal
    }
    const fallbackTopic = rf.name.replace(/\.md$/, "");
    const { meta, errors } = parseMemoryMeta(content, fallbackTopic);
    return { name: rf.name, size: rf.size, meta, metaErrors: errors, content, nlink: rf.nlink };
  });

  let render: TieredRenderResult | undefined;
  try {
    render = renderPort({
      cwd,
      profile: "full",
      access: "memory+read",
      coreBytes: settings.coreBytes,
      blockBytes: settings.blockBytes,
      indexMax: settings.indexMax,
    });
  } catch {
    render = undefined; // renderer errors are best-effort; D02/D09 simply sit out
  }

  const skippedOut: readonly DoctorSkippedFile[] = skipped.map((s) => ({ name: s.name, kind: s.kind }));

  return {
    cwd,
    files,
    skipped: skippedOut,
    canonicalTargetNotDir: state.state === "not-dir",
    ...(canon?.linked ? { slugDirLinked: { display: canon.display, real: canon.real } } : {}),
    ...(render ? { render } : {}),
    nowMs: now(),
  };
}

function runDoctorFor(
  cwd: string,
  paths: MemoryPaths | undefined,
  settings: MemorySettings,
  renderPort: RenderTieredPort,
  now: () => number,
): DoctorFinding[] {
  const snapshot = buildSnapshot(cwd, paths, settings, renderPort, now);
  return runDoctor(snapshot, toDoctorSettings(settings));
}

/** P5 shared health port for the v2 directory view and tidy integration. */
export function collectDoctorFindings(
  cwd: string,
  paths: MemoryPaths | undefined,
  settings: MemorySettings,
  renderPort: RenderTieredPort = DEFAULT_RENDER_PORT,
  now: () => number = () => Date.now(),
): DoctorFinding[] {
  return runDoctorFor(cwd, paths, settings, renderPort, now);
}

/**
 * `/mem doctor` — full listing (§6.2): `ctx.ui.notify` normally, or
 * `ctx.ui.editor` (read-only display — the return value is discarded) once
 * there are more than 20 findings so a long report doesn't spam the
 * transcript. No-UI sessions (print/RPC) are silently inert, matching
 * every other `/mem` subcommand's `ctx.hasUI` convention.
 */
export async function handleMemDoctorCommand(
  _args: string,
  ctx: ExtensionCommandContext,
  deps: DoctorCommandDeps,
): Promise<void> {
  if (!ctx.hasUI) return;
  const cwd = resolveWorktreeOrigin(ctx.cwd) ?? ctx.cwd;
  const settings = deps.settings;
  const now = deps.now ?? (() => Date.now());
  const renderPort = deps.renderTieredPort ?? DEFAULT_RENDER_PORT;
  const findings = runDoctorFor(cwd, deps.paths, settings, renderPort, now);
  const report = formatDoctorReport(findings);
  if (findings.length > 20) {
    await ctx.ui.editor("memory doctor", report);
    return;
  }
  const hasError = findings.some((f) => f.severity === "error");
  ctx.ui.notify(report, hasError ? "warning" : "info");
}

// ───────────────────────────── §6.3 startup reminder ─────────────────────────────

/** `sha1` over the sorted `id+file` pairs of the error/D01 findings that
 *  would trigger a reminder — cheap, stable dedup key (§6.3's "指纹"). */
function fingerprintFindings(findings: readonly DoctorFinding[]): string {
  const keys = findings.map((f) => `${f.id}:${f.file ?? ""}`).sort();
  return createHash("sha1").update(keys.join("\n")).digest("hex");
}

function startupReminderText(findings: readonly DoctorFinding[]): string {
  const errors = findings.filter((f) => f.severity === "error").length;
  const d01 = findings.some((f) => f.id === "D01");
  const bits: string[] = [];
  if (errors > 0) bits.push(`${errors} error finding${errors === 1 ? "" : "s"}`);
  if (d01) bits.push("no core.md");
  return `/mem doctor: ${bits.join(", ")} — run /mem doctor for details.`;
}

export interface CreateStartupReminderDeps {
  isChildSession: boolean;
  paths?: MemoryPaths;
  settings: MemorySettings;
  renderTieredPort?: RenderTieredPort;
  now?: () => number;
}

export interface StartupReminder {
  /** Structurally an `ExtensionHandler<SessionStartEvent>` — ready for
   *  `pi.on("session_start", reminder.check)` (wired by `wireMemory`). */
  check: ExtensionHandler<SessionStartEvent>;
  /** /reload starts a new activation and may repeat the reminder. */
  reset(): void;
}

const REMINDER_KEY = Symbol.for("pi-subagent:memory-doctor-reminders");
const REMINDER_CAPACITY = 256;

function lastNotified(): Map<string, string> {
  const global = globalThis as Record<symbol, unknown>;
  let map = global[REMINDER_KEY] as Map<string, string> | undefined;
  if (!map) {
    map = new Map();
    global[REMINDER_KEY] = map;
  }
  return map;
}

/**
 * §6.3: main-session + UI-only + `memory.doctor.notifyOnStart` reminder,
 * fired at most once per session (`notifiedSessions`, keyed by
 * `ctx.sessionManager.getSessionId()`) and deduplicated across sessions in
 * the same process by a per-cwd error/D01 fingerprint (`lastNotified`) —
 * the session set lives in this factory's closure; the cwd map lives on a
 * process-global Symbol so a new activation during /new keeps deduplicating.
 * /reload explicitly clears that map through reset().
 * Never calls `sendMessage`/`appendEntry`/spawns anything — `ctx.ui.notify`
 * only.
 */
export function createStartupReminder(deps: CreateStartupReminderDeps): StartupReminder {
  const notifiedSessions = new Set<string>();
  const settings = deps.settings;
  const now = deps.now ?? (() => Date.now());
  const renderPort = deps.renderTieredPort ?? DEFAULT_RENDER_PORT;

  return {
    reset: () => {
      notifiedSessions.clear();
      lastNotified().clear();
    },
    check: (_event, ctx) => {
      if (deps.isChildSession || !settings.doctor.notifyOnStart || !ctx.hasUI) return;
      let sessionId: string | undefined;
      try {
        sessionId = ctx.sessionManager.getSessionId();
      } catch {
        sessionId = undefined;
      }
      if (sessionId !== undefined && notifiedSessions.has(sessionId)) return;

      const cwd = resolveWorktreeOrigin(ctx.cwd) ?? ctx.cwd;
      let findings: DoctorFinding[];
      try {
        findings = runDoctorFor(cwd, deps.paths, settings, renderPort, now);
      } catch {
        return; // never throw out of a session_start hook
      }
      const relevant = findings.filter((f) => f.severity === "error" || f.id === "D01");
      if (relevant.length === 0) return;

      const fingerprint = fingerprintFindings(relevant);
      const recent = lastNotified();
      if (recent.get(cwd) === fingerprint) return;

      if (sessionId !== undefined) notifiedSessions.add(sessionId);
      recent.delete(cwd);
      recent.set(cwd, fingerprint);
      if (recent.size > REMINDER_CAPACITY) recent.delete(recent.keys().next().value!);
      ctx.ui.notify(startupReminderText(relevant), "warning");
    },
  };
}
