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
import { join } from "node:path";
import type { ExtensionCommandContext, ExtensionHandler, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { resolveWorktreeOrigin } from "../core/worktree-origin.js";
import type { MemorySettings } from "../config/settings.js";
import type { TieredRenderInput, TieredRenderResult } from "./contracts.js";
import {
  formatDoctorReport,
  runDoctor,
  runDoctorBlocks,
  type DoctorBlocksInput,
  type DoctorFindingLike,
  type DoctorSettings,
  type DoctorSkippedFile,
  type DoctorSnapshot,
  type DoctorSnapshotFile,
} from "./doctor.js";
import { frontmatterSource } from "./frontmatter.js";
import { splitEntries } from "./jev/entries.js";
import type { JevDoctorPort } from "./jev/contracts.js";
import { parseMemoryMeta } from "./meta.js";
import { softMetaDiagnostics } from "./soft-meta.js";
import { memoryDirFor, type MemoryPaths } from "./paths.js";
import { canonicalDirState, inspectDirNoFollow, listDirNames, listRegular, readRegular } from "./safe-fs.js";
import { renderTiered } from "./tiered.js";
import { dirFormat, parseArchiveName } from "./blocks/naming.js";
import { readCorpus } from "./blocks/store.js";
import { legacyDrift } from "./blocks/legacy.js";
import { readBlocksState, readHold } from "./blocks/state.js";

export type RenderTieredPort = (input: TieredRenderInput) => TieredRenderResult;

/** Real production port: P1's `renderTiered`. Errors are still handled as
 * best-effort degradation by the command/reminder callers. */
const DEFAULT_RENDER_PORT: RenderTieredPort = (input) => renderTiered(input);

/** `YYYY-MM-DD` for `runDoctor`'s `jev.today` (D17’s expiry comparison). */
function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface DoctorCommandDeps {
  scoped?: () => readonly import("./scopes/doctor.js").ScopedDoctorFinding[];
  paths?: MemoryPaths;
  /** Production callers thread the activate-time settings snapshot. */
  settings: MemorySettings;
  renderTieredPort?: RenderTieredPort;
  /** Clock for D08's staleDays comparison. Defaults to `Date.now`. */
  now?: () => number;
  /** jev-plan §4 J8: presence alone (regardless of what it returns here)
   *  gates `runDoctor`'s D17–D19 — absent ⇒ byte-identical report (I9). */
  jev?: JevDoctorPort;
}

function toDoctorSettings(settings: MemorySettings): DoctorSettings {
  return {
    coreBytes: settings.coreBytes,
    blockBytes: settings.blockBytes,
    topicWarnBytes: settings.topicWarnBytes,
    topicMaxBytes: settings.topicMaxBytes,
    staleDays: settings.doctor.staleDays,
    layout: settings.layout,
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
  jevToday?: string,
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
    // jev-plan §4 J8: only split entries when D17/D18 are actually going to
    // run (`jevToday` present) and the file is live (archived files inject
    // nothing and carry no entries, same convention as EntryIndex).
    const entries =
      jevToday !== undefined && meta.status !== "archived"
        ? splitEntries(rf.name, content, {
            status: meta.status === "stale" ? "stale" : "active",
            handWritten: frontmatterSource(content) !== "agent",
          })
        : undefined;
    return {
      name: rf.name,
      size: rf.size,
      meta,
      metaErrors: errors,
      content,
      nlink: rf.nlink,
      ...(entries === undefined ? {} : { entries }),
    };
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
  jev?: JevDoctorPort,
): DoctorFindingLike[] {
  const display = memoryDirFor(cwd, paths);
  // #36 P4 (root ruling 2026-11-06, fix round 2): a blocks-format
  // directory always takes the blocks dispatch, but a "held" one only
  // does while the rollback is still unfinished (D25's rollback-unfinished
  // finding must stay reachable) OR the blocks/ dir is still a real
  // directory (the blocks layout is still live). A COMPLETED rollback whose
  // blocks/ dir is gone is a files layout now — running the blocks doctor
  // there misreported D24 block-format and dropped the legacy file codes.
  // The files/absent paths are byte-identical to before.
  const format = dirFormat(display);
  if (format === "blocks" || (format === "held" && heldStillUsesBlocks(display))) {
    return blocksDoctorFindings(display, settings, now);
  }
  const snapshot = buildSnapshot(cwd, paths, settings, renderPort, now, jev === undefined ? undefined : isoDate(now()));
  return runDoctor(snapshot, toDoctorSettings(settings), jev === undefined ? undefined : { today: isoDate(now()) });
}

/** #36 P4 fix round 2: should a "held" directory take the blocks dispatch?
 * `true` while the hold records an unfinished rollback (D25 reachable even
 * if blocks/ was already removed) or blocks/ is still a real directory;
 * `false` once a completed rollback has removed blocks/ — the files-layout
 * doctor runs there instead (legacy codes restored, no false D24). */
function heldStillUsesBlocks(memDir: string): boolean {
  const canon = canonicalDirState(memDir);
  const dir = canon.state === "ok" ? canon.dir.real : memDir;
  try {
    if (readHold(dir)?.rollback?.done === false) return true;
  } catch {
    /* unreadable hold — fall through to the blocks-dir presence check */
  }
  try {
    inspectDirNoFollow(join(dir, "blocks"));
    return true;
  } catch {
    return false;
  }
}

/** Assemble `runDoctorBlocks`'s input from a real blocks directory. Every
 *  read is fail-soft — a partial directory still yields the findings whose
 *  inputs read cleanly (an unfinished rollback leaves dirFormat "held" with
 *  blocks/ possibly still present; D25's hold finding reads independently). */
function blocksDoctorFindings(memDir: string, settings: MemorySettings, now: () => number): DoctorFindingLike[] {
  const canon = canonicalDirState(memDir);
  const dir = canon.state === "ok" ? canon.dir.real : memDir;
  const realDir = join(dir, "blocks");
  let input: DoctorBlocksInput;
  try {
    const corpus = readCorpus(realDir);
    const archivedIds: string[] = [];
    try {
      for (const f of listRegular(join(realDir, "archive"), { names: "v2" }).files) {
        const parsed = parseArchiveName(f.name);
        if (parsed !== undefined) archivedIds.push(`${parsed.topic}.${parsed.seq}`);
      }
    } catch {
      // no archive dir — nothing to add
    }
    let driftCount = 0;
    try {
      driftCount = legacyDrift(dir).length;
    } catch {
      driftCount = 0; // unreadable migration report ⇒ no drift claim
    }
    const stagingWithoutOwner = listDirNames(dir)
      .filter((name) => /^\.blocks-staging-/.test(name))
      .filter((name) => {
        try {
          return !inspectDirNoFollow(join(dir, name)).names.includes("owner.json");
        } catch {
          return true; // unreadable ⇒ treat as ownerless (surfaces D25)
        }
      });
    input = {
      blocks: corpus.blocks,
      strays: corpus.strays,
      archivedIds,
      settingsLayout: settings.layout,
      rootFileCount: corpus.legacy.files.length,
      driftCount,
      residentBytes: settings.residentBytes,
      today: isoDate(now()),
      ...(stagingWithoutOwner.length === 0 ? {} : { stagingWithoutOwner }),
    };
  } catch {
    // corpus unreadable (mid-rollback) — report only the state/hold codes
    input = {
      blocks: [],
      strays: [],
      settingsLayout: settings.layout,
      rootFileCount: 0,
      residentBytes: settings.residentBytes,
      today: isoDate(now()),
    };
  }
  try {
    input = { ...input, state: readBlocksState(dir) };
  } catch {
    /* state file unreadable — D25's overBudgetStreak simply sits out */
  }
  const hold = (() => {
    try {
      return readHold(dir);
    } catch {
      return undefined;
    }
  })();
  return runDoctorBlocks(hold === undefined ? input : { ...input, hold });
}

/** P5 shared health port for the v2 directory view and tidy integration. */
export function collectDoctorFindings(
  cwd: string,
  paths: MemoryPaths | undefined,
  settings: MemorySettings,
  renderPort: RenderTieredPort = DEFAULT_RENDER_PORT,
  now: () => number = () => Date.now(),
  jev?: JevDoctorPort,
): DoctorFindingLike[] {
  return runDoctorFor(cwd, paths, settings, renderPort, now, jev);
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
  const findings = runDoctorFor(cwd, deps.paths, settings, renderPort, now, deps.jev);
  const extra = deps.scoped?.() ?? [];
  const display = memoryDirFor(cwd, deps.paths);
  const state = canonicalDirState(display);
  const soft = softMetaDiagnostics(state.state === "ok" ? state.dir.real : display);
  const softLines = soft.map(
    (d) => `E_META_SOFT ${d.field}: ${d.bytes}B exceeds ${d.limit}B; historical value truncated for reading`,
  );
  const report =
    formatDoctorReport(findings) +
    (softLines.length ? "\n" + softLines.join("\n") : "") +
    (extra.length
      ? "\n" + extra.map((f) => `${f.code} ${f.scope}: ${f.reason}${f.entryId ? ` (${f.entryId})` : ""}`).join("\n")
      : "");
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
function fingerprintFindings(findings: readonly DoctorFindingLike[]): string {
  const keys = findings.map((f) => `${f.id}:${f.file ?? ""}`).sort();
  return createHash("sha1").update(keys.join("\n")).digest("hex");
}

function startupReminderText(findings: readonly DoctorFindingLike[]): string {
  const errors = findings.filter((f) => f.severity === "error").length;
  const d01 = findings.some((f) => f.id === "D01");
  const bits: string[] = [];
  if (errors > 0) bits.push(`${errors} error finding${errors === 1 ? "" : "s"}`);
  if (d01) bits.push("no core.md");
  // Only the D01 states /mem init can actually fix point at it (its fix text
  // names /mem init); an archived core.md or a pin:true stand-in would make
  // init refuse, so those keep the plain doctor pointer. Error findings
  // always need the full doctor report.
  const initFixable = findings.some((f) => f.id === "D01" && f.fix?.includes("/mem init") === true);
  const detail = initFixable
    ? "run /mem init to create one, or /mem doctor for details."
    : "run /mem doctor for details.";
  return `/mem doctor: ${bits.join(", ")} — ${detail}`;
}

export interface CreateStartupReminderDeps {
  isChildSession: boolean;
  paths?: MemoryPaths;
  settings: MemorySettings;
  renderTieredPort?: RenderTieredPort;
  now?: () => number;
  /** jev-plan §4 J8: expired count / core usage / open suggestions / jev
   *  status, appended as extra lines (jev-arch §1.4/§6.3.4/§6.3.5). Also
   *  gates D17–D19 in the reminder's own `runDoctor` call, same as
   *  `DoctorCommandDeps.jev`. */
  jev?: JevDoctorPort;
  /** jev-plan §4 J8 / Q34: a non-empty `memory.jev.classifiers` that parsed
   *  to zero valid entries gets one plain-English line here — independent
   *  of `jev` (jev is off in exactly this case) and of any doctor findings. */
  settingsWarnings?: readonly string[];
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
      let findings: DoctorFindingLike[];
      try {
        findings = runDoctorFor(cwd, deps.paths, settings, renderPort, now, deps.jev);
      } catch {
        return; // never throw out of a session_start hook
      }
      const relevant = findings.filter((f) => f.severity === "error" || f.id === "D01");
      const extraLines = deps.jev?.extraReminder(cwd) ?? [];
      const warnLines = deps.settingsWarnings ?? [];
      // I9: with neither a jev port nor settings warnings, this is the exact
      // original early-return/fingerprint/notify sequence — byte-identical.
      if (relevant.length === 0 && extraLines.length === 0 && warnLines.length === 0) return;

      const extraFingerprint =
        extraLines.length === 0 && warnLines.length === 0
          ? ""
          : `|${createHash("sha1")
              .update([...extraLines, ...warnLines].join("\n"))
              .digest("hex")}`;
      const fingerprint = fingerprintFindings(relevant) + extraFingerprint;
      const recent = lastNotified();
      if (recent.get(cwd) === fingerprint) return;

      if (sessionId !== undefined) notifiedSessions.add(sessionId);
      recent.delete(cwd);
      recent.set(cwd, fingerprint);
      if (recent.size > REMINDER_CAPACITY) recent.delete(recent.keys().next().value!);
      const lines = relevant.length > 0 ? [startupReminderText(relevant)] : [];
      lines.push(...extraLines, ...warnLines);
      ctx.ui.notify(lines.join("\n"), "warning");
    },
  };
}
