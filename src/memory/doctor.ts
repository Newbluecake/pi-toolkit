// §6.1 `/mem doctor` rules — todo #22 P3.
//
// Pure function `runDoctor(snapshot, settings) → DoctorFinding[]`; never
// touches fs/pi itself (that's `doctor-command.ts`'s job — it builds a
// `DoctorSnapshot` from the real filesystem and an injected `renderTiered`
// port, then calls this file). Zero pi/typebox imports; independently
// unit-testable with a hand-built snapshot.
//
// `DoctorSnapshotFile`/`DoctorSnapshot`/`DoctorSettings` keep the shape the
// P0-b stub originally negotiated (`name`/`size`/`meta` on the file,
// `cwd`/`files` on the snapshot, the four byte thresholds + `staleDays` on
// settings) and only ADD optional fields on top (`metaErrors`, `content`,
// `nlink`, `skipped`, `slugDirLinked`, `canonicalTargetNotDir`, `render`,
// `nowMs`) — any caller written against the original stub (e.g. P4's tidy,
// developed in parallel from the same P0 base) still type-checks; the new
// fields are additive-only and simply leave the corresponding rules silent
// when omitted, never throw.
//
// Two known, reported gaps in the frozen `safe-fs.ts` surface mean
// `doctor-command.ts`'s REAL (fs-backed) snapshot can never populate
// `nlink` or `canonicalTargetNotDir` today — see this package's delivery
// report. Both rules are fully implemented and unit-tested here against a
// hand-fed snapshot; they simply never fire through the live `/mem doctor`
// command until a small safe-fs addition lands.

import { parseFrontmatter } from "./frontmatter.js";
import { formatSize } from "./render.js";
import type { DoctorFinding, DoctorId, DoctorSeverity, MemoryMeta, TieredRenderResult } from "./contracts.js";

export interface DoctorSnapshotFile {
  name: string;
  /** Whole-file size in bytes (frontmatter + body) — matches safe-fs's
   *  `RegularFileEntry.size` / `RegularStat.size`. */
  size: number;
  meta: MemoryMeta;
  /** `parseMemoryMeta(...).errors` (§5's D07), never thrown. Omitted ⇒ D07's
   *  metaErrors-derived findings are skipped for this file. */
  metaErrors?: readonly string[];
  /** Raw file content (frontmatter + body). Needed for D07's "unclosed
   *  frontmatter" detection and D13's secret scan; omitted ⇒ both are
   *  skipped for this file rather than guessed. */
  content?: string;
  /** Hard-link count (D14 "nlink > 1"). `undefined` = unknown/unsupported
   *  by the caller's fs layer — see the module doc comment above. */
  nlink?: number;
}

export type DoctorSkippedKind = "symlink" | "dangling" | "not-file" | "bad-name";

export interface DoctorSkippedFile {
  name: string;
  kind: DoctorSkippedKind;
}

export interface DoctorSnapshot {
  cwd: string;
  files: readonly DoctorSnapshotFile[];
  /** Non-addressable entries under v2 naming (§3.1 B14 / D14) — from
   *  `listRegular(dir, { names: "v2" }).skipped`. Omitted ⇒ D14's
   *  skip-classification findings are skipped. */
  skipped?: readonly DoctorSkippedFile[];
  /** §3.1 slug-directory trust: the memory dir itself is a symlink to a
   *  different real path. Omitted/undefined ⇒ no such finding. */
  slugDirLinked?: { display: string; real: string };
  /** The slug path exists but its canonical target is not a directory
   *  (D14 error). Best-effort — a caller whose fs layer can't distinguish
   *  this from "no memory yet" (today's `safe-fs.canonicalDir`) must leave
   *  this `false`/omitted, never `true` without being sure. */
  canonicalTargetNotDir?: boolean;
  /** Precomputed tiered-render outcome (§2.3), used only by D02/D09.
   *  Omitted ⇒ those two rules are skipped (e.g. before P1 ships a real
   *  `renderTiered`, or the renderer throws) rather than guessed. */
  render?: TieredRenderResult;
  /** "now", for D08's staleDays comparison — injected so callers/tests are
   *  deterministic. Omitted ⇒ `Date.now()`. */
  nowMs?: number;
}

export interface DoctorSettings {
  coreBytes: number;
  blockBytes: number;
  topicWarnBytes: number;
  topicMaxBytes: number;
  staleDays: number;
}

const ID_ORDER: readonly DoctorId[] = [
  "D01",
  "D02",
  "D03",
  "D04",
  "D05",
  "D06",
  "D07",
  "D08",
  "D09",
  "D11",
  "D13",
  "D14",
];

// ───────────────────────────── primary-core selection (§2.1) ─────────────────────────────

/**
 * `core.md` if present, else the first (by filename, code-point order)
 * `pin: true` non-archived file — the same "primary core" role the
 * injection layer (§2.1) selects. Pure and independent of `renderTiered` —
 * doctor needs to know WHICH file is primary for D01/D02/D03/D04/D05/D06
 * regardless of whether a render port is available.
 */
export function selectPrimaryCore(files: readonly DoctorSnapshotFile[]): string | undefined {
  if (files.some((f) => f.name === "core.md")) return "core.md";
  const pinned = files.filter((f) => f.meta.pin && f.meta.status !== "archived").map((f) => f.name);
  pinned.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return pinned[0];
}

// ───────────────────────────── D13 secret scan ─────────────────────────────

const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /ghp_[A-Za-z0-9]{30,}/g,
  /xox[bap]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /(?:password|secret|token)\s*[:=]\s*\S{8,}/gi,
];

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

/** "打码为前 4 字符 + …" (§6.1 D13) — code-point safe (never splits a
 *  surrogate pair). */
function maskSecret(text: string): string {
  const chars = Array.from(text);
  return `${chars.slice(0, 4).join("")}…`;
}

function findSecrets(content: string): { line: number; snippet: string }[] {
  const found: { line: number; snippet: string }[] = [];
  for (const pattern of SECRET_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const whole = m[0];
      found.push({ line: lineOf(content, m.index), snippet: maskSecret(whole) });
      if (whole.length === 0) re.lastIndex++; // never loop forever on a zero-length match
    }
  }
  found.sort((a, b) => a.line - b.line);
  return found;
}

// ───────────────────────────── D07 frontmatter structural errors ─────────────────────────────

/** `parseMemoryMeta`'s `errors` strings don't carry a severity — classify
 *  by message shape (§6.1: description/read_when length overage is
 *  "长度超限（info）"; every other structural problem is `error`). */
function classifyMetaError(message: string): DoctorSeverity {
  return /^(description|read_when) exceeds/.test(message) ? "info" : "error";
}

// ───────────────────────────── D02/D09 render-derived detail ─────────────────────────────

/** L4's literal index-line marker (§2.3 step 3/8, §2.2's index-line format)
 *  — the one reliable, level-independent signal that the PRIMARY file
 *  specifically was fully excluded, even when some OTHER trigger (e.g. an
 *  extra-pinned demotion) produced a higher overall `level`. */
function primaryFullyExcluded(render: TieredRenderResult): boolean {
  return render.text.includes("⚠ over core budget");
}

function degradeDetail(render: TieredRenderResult): string {
  const parts: string[] = [];
  if (render.omittedSections.length > 0) {
    parts.push(`primary core admitted whole sections only (omitted: ${render.omittedSections.join(", ")})`);
  }
  if (primaryFullyExcluded(render)) {
    parts.push("primary core did not fit at all and was demoted to the index");
  }
  if (render.demotedPinned.length > 0) {
    parts.push(`pinned file(s) demoted to the index: ${render.demotedPinned.join(", ")}`);
  }
  return parts.length > 0 ? ` (${parts.join("; ")})` : "";
}

// ───────────────────────────── sort ─────────────────────────────

function sortFindings(findings: readonly DoctorFinding[]): DoctorFinding[] {
  return findings.slice().sort((a, b) => {
    const ai = ID_ORDER.indexOf(a.id);
    const bi = ID_ORDER.indexOf(b.id);
    if (ai !== bi) return ai - bi;
    const af = a.file ?? "";
    const bf = b.file ?? "";
    if (af !== bf) return af < bf ? -1 : 1;
    return (a.line ?? 0) - (b.line ?? 0);
  });
}

// ───────────────────────────── main entry ─────────────────────────────

export function runDoctor(snapshot: DoctorSnapshot, settings: DoctorSettings): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const files = snapshot.files;
  const primary = selectPrimaryCore(files);
  const hasCoreMd = files.some((f) => f.name === "core.md");

  // D01: degraded primary (no core.md, a pin:true file stands in).
  if (!hasCoreMd && primary !== undefined) {
    findings.push({
      id: "D01",
      severity: "info",
      file: primary,
      message: `No core.md — "${primary}" (pin: true) is standing in as the degraded primary core.`,
      fix: "Rename it to core.md, or run /mem tidy to migrate.",
    });
  }

  const byTopic = new Map<string, string[]>();

  for (const f of files) {
    const isPrimary = f.name === primary;
    const isPin = f.meta.pin === true;
    const isArchived = f.meta.status === "archived";
    const isExtraPinned = isPin && !isPrimary && !isArchived;
    const isTopic = !isPin && !isPrimary && !isArchived;

    const topicList = byTopic.get(f.meta.topic);
    if (topicList) topicList.push(f.name);
    else byTopic.set(f.meta.topic, [f.name]);

    // D04 / D05: non-core file size (whole-file bytes).
    if (!isPrimary) {
      if (f.size > settings.topicMaxBytes) {
        findings.push({
          id: "D05",
          severity: "error",
          file: f.name,
          message: `${f.name} is ${formatSize(f.size)}, over the hard topicMaxBytes limit (${formatSize(settings.topicMaxBytes)}) — writes past this limit are rejected.`,
          fix: "Split it with /mem tidy.",
        });
      } else if (f.size > settings.topicWarnBytes) {
        findings.push({
          id: "D04",
          severity: "warn",
          file: f.name,
          message: `${f.name} is ${formatSize(f.size)}, over topicWarnBytes (${formatSize(settings.topicWarnBytes)}).`,
          fix: "Consider splitting it with /mem tidy.",
        });
      }
    }

    // D03: pin:true file that didn't get in whole.
    if (isPin && !isArchived) {
      if (isPrimary) {
        if (snapshot.render && (snapshot.render.omittedSections.length > 0 || primaryFullyExcluded(snapshot.render))) {
          findings.push({
            id: "D03",
            severity: "warn",
            file: f.name,
            message: `${f.name} (pin: true, primary core) did not fit whole into the core budget.`,
          });
        }
      } else if (snapshot.render?.demotedPinned.includes(f.name)) {
        findings.push({
          id: "D03",
          severity: "warn",
          file: f.name,
          message: `${f.name} (pin: true) did not fit into the remaining core budget and was demoted to the index.`,
          fix: "Split it, or drop pin: true, with /mem tidy.",
        });
      }
    }

    // D06: topic / extra-pinned missing description (warn); topic missing
    // read_when (info) — at most one finding per file (§14.1's "current-5
    // 期望清单 golden（… D06×4 …）").
    if (isExtraPinned || isTopic) {
      const missingDescription = f.meta.description === undefined;
      const missingReadWhen = f.meta.readWhen === undefined;
      if (missingDescription) {
        findings.push({
          id: "D06",
          severity: "warn",
          file: f.name,
          message: `${f.name} has no frontmatter description${isTopic && missingReadWhen ? " (and no read_when)" : ""} — add one so it shows up in the index guide.`,
          fix: "Add `description: …` to the frontmatter.",
        });
      } else if (isTopic && missingReadWhen) {
        findings.push({
          id: "D06",
          severity: "info",
          file: f.name,
          message: `${f.name} has no read_when — add one so the model knows when to open it.`,
          fix: "Add `read_when: …` to the frontmatter.",
        });
      }
    }

    // D07: frontmatter structural errors.
    for (const message of f.metaErrors ?? []) {
      findings.push({ id: "D07", severity: classifyMetaError(message), file: f.name, message });
    }
    if (f.content !== undefined && /^---\r?\n/.test(f.content) && parseFrontmatter(f.content) === undefined) {
      findings.push({
        id: "D07",
        severity: "error",
        file: f.name,
        message: `${f.name}'s frontmatter block is never closed with a --- line — treated as invalid.`,
      });
    }

    // D08: stale.
    if (f.meta.status === "stale") {
      findings.push({ id: "D08", severity: "info", file: f.name, message: `${f.name} is marked status: stale.` });
    }
    if (f.meta.updated !== undefined) {
      const updatedMs = Date.parse(f.meta.updated);
      if (!Number.isNaN(updatedMs)) {
        const now = snapshot.nowMs ?? Date.now();
        const ageDays = (now - updatedMs) / 86_400_000;
        if (ageDays > settings.staleDays) {
          findings.push({
            id: "D08",
            severity: "warn",
            file: f.name,
            message: `${f.name}'s updated date is ${Math.floor(ageDays)} days old (over doctor.staleDays=${settings.staleDays}).`,
          });
        }
      }
    }

    // D13: secrets.
    if (f.content !== undefined) {
      for (const s of findSecrets(f.content)) {
        findings.push({
          id: "D13",
          severity: "error",
          file: f.name,
          line: s.line,
          message: `Possible secret detected: ${s.snippet}`,
        });
      }
    }

    // D14: hard-link count.
    if (f.nlink !== undefined && f.nlink > 1) {
      findings.push({ id: "D14", severity: "info", file: f.name, message: `${f.name} has ${f.nlink} hard links.` });
    }
  }

  // D11: duplicate topic.
  for (const [topic, names] of byTopic) {
    if (names.length > 1) {
      findings.push({
        id: "D11",
        severity: "warn",
        message: `topic "${topic}" is shared by ${names.length} files: ${names.slice().sort().join(", ")}.`,
      });
    }
  }

  // D02 / D09: render-derived.
  if (snapshot.render && primary !== undefined) {
    const r = snapshot.render;
    const primaryOmitted = r.omittedSections.length > 0;
    const primaryExcluded = primaryFullyExcluded(r);
    if (primaryOmitted || primaryExcluded) {
      findings.push({
        id: "D02",
        severity: "error",
        file: primary,
        message: primaryOmitted
          ? `${primary}'s body exceeds coreBytes (${formatSize(settings.coreBytes)}) — only whole sections fit (omitted: ${r.omittedSections.join(", ")}).`
          : `${primary}'s body exceeds coreBytes (${formatSize(settings.coreBytes)}) — not even the preamble fits; it was demoted out of the core block entirely.`,
      });
    }
    if (r.level > 0 && r.level < 5) {
      findings.push({
        id: "D09",
        severity: "warn",
        message: `Memory block degraded to L${r.level}${degradeDetail(r)}.`,
      });
    } else if (r.level === 5) {
      findings.push({
        id: "D09",
        severity: "error",
        message: `Memory block frame exceeds blockBytes (${formatSize(settings.blockBytes)}) even in its minimal form (L5) — the slug or file set is too large.`,
      });
    }
  }

  // D14: skip classification (symlink/dangling/not-file/bad-name).
  for (const s of snapshot.skipped ?? []) {
    if (s.kind === "bad-name") {
      findings.push({
        id: "D14",
        severity: "info",
        file: s.name,
        message: `${s.name} does not match the v2 filename rule — not addressable under layout:tiered/toolSurface:v2.`,
      });
    } else {
      const label = s.kind === "not-file" ? "not a regular file" : s.kind;
      findings.push({
        id: "D14",
        severity: "warn",
        file: s.name,
        message: `${s.name} is a ${label} — skipped, not injected.`,
      });
    }
  }

  // D14: slug-directory trust / canonical-target sanity.
  if (snapshot.slugDirLinked) {
    findings.push({
      id: "D14",
      severity: "info",
      message: `Memory dir ${snapshot.slugDirLinked.display} → ${snapshot.slugDirLinked.real} (symlinked; the real target is trusted).`,
    });
  }
  if (snapshot.canonicalTargetNotDir) {
    findings.push({
      id: "D14",
      severity: "error",
      message: "The memory dir path resolves to something that is not a directory.",
    });
  }

  return sortFindings(findings);
}

// ───────────────────────────── §6.2 report / summary formatting ─────────────────────────────

interface SeverityCounts {
  error: number;
  warn: number;
  info: number;
}

export function countBySeverity(findings: readonly DoctorFinding[]): SeverityCounts {
  const counts: SeverityCounts = { error: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}

/** Full `/mem doctor` listing (§6.2) — multi-line, one finding per line. */
export function formatDoctorReport(findings: readonly DoctorFinding[]): string {
  if (findings.length === 0) return "/mem doctor: no findings — memory looks healthy.";
  const c = countBySeverity(findings);
  const header = `/mem doctor: ${c.error} error · ${c.warn} warn · ${c.info} info`;
  const lines = findings.map((f) => {
    const loc = f.file !== undefined ? `${f.file}${f.line !== undefined ? `:${f.line}` : ""} — ` : "";
    const fix = f.fix !== undefined ? ` (fix: ${f.fix})` : "";
    return `  [${f.severity}] ${f.id} ${loc}${f.message}${fix}`;
  });
  return [header, ...lines].join("\n");
}

/** §6.2's `/mem` / `/mem list` trailer line, e.g. "doctor: 1 error · 3 warn
 *  — /mem doctor". Always returns a line (never omitted) so the caller can
 *  append it unconditionally. */
export function summaryLine(findings: readonly DoctorFinding[]): string {
  const c = countBySeverity(findings);
  const parts: string[] = [];
  if (c.error > 0) parts.push(`${c.error} error`);
  if (c.warn > 0) parts.push(`${c.warn} warn`);
  if (c.error === 0 && c.warn === 0) parts.push(c.info > 0 ? `${c.info} info` : "0 findings");
  return `doctor: ${parts.join(" · ")} — /mem doctor`;
}
