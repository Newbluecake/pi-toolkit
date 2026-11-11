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
// `nowMs`) — any caller written against the original stub (e.g. command callers,
// developed in parallel from the same P0 base) still type-checks; the new
// fields are additive-only and simply leave the corresponding rules silent
// when omitted, never throw.
//
// `doctor-command.ts`'s real (fs-backed) snapshot populates `nlink` from
// safe-fs `RegularFileEntry.nlink` and `canonicalTargetNotDir` from
// `canonicalDirState` (P0-c); hand-fed snapshots may still omit them, in
// which case the corresponding D14 rules stay silent.

import { parseFrontmatter } from "./frontmatter.js";
import { formatSize } from "./render.js";
import { findSecrets } from "./secret-patterns.js";
import { expiredEntries, untilEntries } from "./jev/entries.js";
import { bodyBytes, isExpired, isResident, type ParsedBlock } from "./blocks/format.js";
import { residentBlocksOf, residentMeteredBytes } from "./blocks/render.js";
import type { BlocksStateV1, BlocksHoldV1 } from "./blocks/state.js";
import type { DirFormat } from "./blocks/naming.js";
import type { DoctorFinding, DoctorId, DoctorSeverity, MemoryMeta, TieredRenderResult } from "./contracts.js";
import type { MemEntry } from "./jev/contracts.js";

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
  /** jev-plan §4 J8: per-file entry split (jev/entries.ts's `splitEntries`),
   *  used ONLY when `runDoctor`'s `jev` parameter is present (D17/D18).
   *  Omitted ⇒ those two rules are skipped for the file — same "optional
   *  add-on, never guessed" convention as every other field here. */
  entries?: readonly MemEntry[];
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
   *  this from "no memory yet" (e.g. plain `safe-fs.canonicalDir`) must leave
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
  /** Memory layout the injected block actually uses. The no-primary D01
   *  warn and D09 describe the TIERED renderer's resident-core/degradation
   *  model; under `legacy` the block inlines file bodies (render.ts) and
   *  those findings would be factually wrong — they sit out entirely.
   *  Omitted ⇒ `"tiered"` (the default layout, and every hand-fed test
   *  snapshot that predates the field).
   *  #36 P0: `"blocks"` joins the union because `MemoryLayout` widened (the
   *  settings key parses it); until P3 adds the blocks dispatch the value
   * cannot appear in real settings (P5b flips the default later). */
  layout?: "legacy" | "tiered" | "blocks";
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
  "D17",
  "D18",
  "D19",
];

// ───────────────────────────── primary-core selection (§2.1) ─────────────────────────────

/**
 * Active `core.md` if present, else the first (by filename, code-point
 * order) `pin: true` non-archived file — the same "primary core" role the
 * injection layer (§2.1) selects (`tiered.ts` picks both candidates from
 * its non-archived set only, so a `status: archived` core.md injects
 * nothing and must not count here either). Pure and independent of
 * `renderTiered` — doctor needs to know WHICH file is primary for
 * D01/D02/D03/D04/D05/D06 regardless of whether a render port is available.
 */
export function selectPrimaryCore(files: readonly DoctorSnapshotFile[]): string | undefined {
  const core = files.find((f) => f.name === "core.md" && f.meta.status !== "archived");
  if (core) return "core.md";
  const pinned = files.filter((f) => f.meta.pin && f.meta.status !== "archived").map((f) => f.name);
  pinned.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return pinned[0];
}

// ───────────────────────────── D13 secret scan ─────────────────────────────
// SECRET_PATTERNS / findSecrets moved verbatim to ./secret-patterns.ts (J1,
// pure move) so the Jev entry index (jev/entries.ts `secret` field) shares
// the exact same detection source as D13; behavior is byte-identical.

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

/** D09's L1 detail (2026-10-16): how many index candidates ended up in the
 * `also:` name-only tail instead of a full index line. The candidate total
 * mirrors `renderTiered`'s candidate list (topic files + demoted pinned + a
 * fully-excluded primary); a pure L1 has no demotions, so this is normally
 * just `topics − fullIndexLines`. Returns "" when everything got a full
 * line (L1 caused solely by e.g. an archived-only tail or a core-profile
 * render). */
function nameOnlyDetail(render: TieredRenderResult, topicCount: number): string {
  const candidateTotal = topicCount + render.demotedPinned.length + (primaryFullyExcluded(render) ? 1 : 0);
  const nameOnly = Math.max(0, candidateTotal - render.fullIndexLines);
  return nameOnly > 0 ? ` (${String(nameOnly)} topic(s) listed by name only — still openable via memory view)` : "";
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

export function runDoctor(
  snapshot: DoctorSnapshot,
  settings: DoctorSettings,
  jev?: { today: string },
): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const files = snapshot.files;
  const primary = selectPrimaryCore(files);
  // D01's no-primary warn and D09 are tiered-renderer findings — under
  // layout:legacy the block inlines file bodies and has no resident-core
  // concept, so they would be factually wrong there (defaults to tiered,
  // the default layout, for hand-fed snapshots that omit the field).
  const layout = settings.layout ?? "tiered";
  const layoutTiered = layout === "tiered";
  const layoutBlocks = layout === "blocks";

  // D01: primary-core health. Two cases:
  //  · NO primary at all (no active core.md, not even a pin:true stand-in) —
  //    the worst resident state: 0 bytes of always-on content are injected
  //    each turn, yet this used to be completely silent (field-study F2,
  //    docs/dev/memory/field-study-claude2api.md). Now a warn with
  //    actionable guidance; a hand-maintained MEMORY.md-style index gets an
  //    explicit "it is treated as a normal topic file and never injected
  //    whole" callout, because its author usually believes the injected
  //    block IS that index. Tiered only — see layoutTiered above. Empty /
  //    fully-archived libraries stay silent — there is no resident content
  //    to miss.
  //  · degraded primary (no active core.md, a pin:true file stands in) — info,
  //    as before.
  if (primary === undefined) {
    if (layoutTiered && files.some((f) => f.meta.status !== "archived")) {
      const handIndex = files.find((f) => f.name.toLowerCase() === "memory.md" && f.meta.status !== "archived");
      const archivedCore = files.find((f) => f.name === "core.md" && f.meta.status === "archived");
      const extra: string[] = [];
      if (handIndex) {
        extra.push(
          `"${handIndex.name}" looks like a hand-maintained index, but it is treated as a normal topic file and never injected whole.`,
        );
      }
      if (archivedCore) extra.push("A core.md exists but is status: archived, so it injects nothing.");
      findings.push({
        id: "D01",
        severity: "warn",
        ...(handIndex ? { file: handIndex.name } : {}),
        message: `No core.md and no pinned file — no primary core, so no always-on memory content is injected (0 bytes of resident rules${
          extra.length === 0 ? "; the block carries only the auto-generated index" : ""
        }).${extra.length > 0 ? ` ${extra.join(" ")}` : ""}`,
        fix: handIndex
          ? `${archivedCore ? "Move" : "Run /mem init, then move"} the always-on rules from ${handIndex.name} into core.md, or add \`pin: true\` to a suitable file — ${handIndex.name} itself will not be auto-injected.`
          : archivedCore
            ? "Set core.md back to status: active, or add `pin: true` to a suitable file's frontmatter."
            : "Run /mem init to create core.md with the always-on rules, or add `pin: true` to a suitable file's frontmatter.",
      });
    }
  } else if (primary !== "core.md") {
    // #36 P3 (arch §3.3.4): blocks 目录下没有 primary/pin 概念（常驻区取
    // 代 core），静默。
    if (!layoutBlocks) {
      findings.push({
        id: "D01",
        severity: "info",
        file: primary,
        message: `No core.md — "${primary}" (pin: true) is standing in as the degraded primary core.`,
        // D01 fixes the primary name/status; D02 separately reports coreBytes overflow.
        fix: files.some((f) => f.name === "core.md")
          ? "Manually merge the always-on rules into core.md and ensure its status is active."
          : "Manually rename this file to core.md to make it the always-on primary core.",
      });
    }
  }

  const byTopic = new Map<string, string[]>();
  // Non-archived topic files (the tiered renderer's full-index-line
  // candidates, minus demoted primary/pinned) — used by D09's L1 detail.
  let topicCount = 0;

  for (const f of files) {
    const isPrimary = f.name === primary;
    const isPin = f.meta.pin === true;
    const isArchived = f.meta.status === "archived";
    const isExtraPinned = isPin && !isPrimary && !isArchived;
    const isTopic = !isPin && !isPrimary && !isArchived;
    if (isTopic) topicCount++;

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
          fix: "Manually split it into focused topic files.",
        });
      } else if (f.size > settings.topicWarnBytes) {
        findings.push({
          id: "D04",
          severity: "warn",
          file: f.name,
          message: `${f.name} is ${formatSize(f.size)}, over topicWarnBytes (${formatSize(settings.topicWarnBytes)}).`,
          fix: "Consider manually splitting it into focused topic files.",
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
          fix: "Manually split it, or remove pin: true.",
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

  // D02 / D09: render-derived. Gated on the render existing only — NOT on
  // a primary being selected (field-study F2: D09 used to sit out entirely
  // for a no-primary block, hiding "degraded to L1" index-only injection).
  // D02 itself is about the primary's own admission and still needs one:
  // without a primary its markers (omittedSections / the over-core-budget
  // index line) can never hold, so it simply never fires there.
  if (snapshot.render) {
    const r = snapshot.render;
    if (primary !== undefined) {
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
    }
    // D09 speaks the tiered renderer's degradation ladder (L1–L5). Under
    // layout:legacy the injected block is the legacy renderer's inline form
    // — these levels describe nothing real there, so the rule sits out
    // entirely (review: legacy libraries must not get newly-false D09s).
    // L1 (some candidates listed by name only in the `also:` line) is BENIGN
    // — every file is still listed and openable, and splitting large files
    // (D04's advice) makes it MORE likely — so it reports as info with the
    // name-only count, not a warn that contradicts D04's fix hint.
    if (layoutTiered) {
      if (r.level > 0 && r.level < 5) {
        const l1 = r.level === 1;
        findings.push({
          id: "D09",
          severity: l1 ? "info" : "warn",
          message: `Memory block degraded to L${r.level}${l1 ? nameOnlyDetail(r, topicCount) : degradeDetail(r)}.`,
        });
      } else if (r.level === 5) {
        findings.push({
          id: "D09",
          severity: "error",
          message: `Memory block frame exceeds blockBytes (${formatSize(settings.blockBytes)}) even in its minimal form (L5) — the slug or file set is too large.`,
        });
      }
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

  // D17–D19 (jev-plan §4 J8, jev-arch §6.3.5/§1.4): only when `jev` is
  // supplied — absent, this whole block never runs and the report is
  // byte-identical to before these codes existed (I9).
  if (jev) {
    // #36 P3 (arch 附录 A): blocks 目录下 D17 只统计 user 块 —— agent 块
    // 的到期交给治理（sweep 归档 + 渲染层过滤）。
    const allEntries = layoutBlocks
      ? files.flatMap((f) => (f.entries ?? []).filter((e) => e.authority === "user"))
      : files.flatMap((f) => f.entries ?? []);
    for (const e of expiredEntries(allEntries, jev.today)) {
      findings.push({
        id: "D17",
        severity: "warn",
        file: e.file,
        line: e.lineStart,
        message: `entry expired on ${e.inline.expires ?? "?"} — delete it, extend it, or clear the expiry with /mem expired.`,
        fix: "/mem expired",
      });
    }
    for (const e of untilEntries(allEntries)) {
      findings.push({
        id: "D17",
        severity: "info",
        file: e.file,
        line: e.lineStart,
        message: `entry has an until condition (${JSON.stringify(e.inline.until ?? "")}) — confirm it with /mem expired.`,
      });
    }
    for (const f of files) {
      for (const e of f.entries ?? []) {
        for (const err of e.inlineErrors) {
          findings.push({
            id: "D18",
            severity: "error",
            file: e.file,
            line: e.lineStart,
            message: `inline authority comment error: ${err}`,
          });
        }
      }
    }
    if (primary !== undefined && settings.coreBytes > 0 && !layoutBlocks) {
      const alreadyFlagged = findings.some((f) => (f.id === "D02" || f.id === "D03") && f.file === primary);
      const primaryFile = files.find((f) => f.name === primary);
      if (!alreadyFlagged && primaryFile) {
        const ratio = primaryFile.size / settings.coreBytes;
        if (ratio >= 0.8) {
          findings.push({
            id: "D19",
            severity: "warn",
            file: primary,
            message: `${primary} is at ${String(Math.round(ratio * 100))}% of coreBytes (${formatSize(settings.coreBytes)}) — getting close to the hard budget.`,
            fix: "Manually trim it, or split topics out.",
          });
        }
      }
    }
  }

  return sortFindings(findings);
}

// ───────────────────────────── #36 blocks-only doctor codes (D20–D25, arch 附录 A) ─────────────────────────────

/** Root 裁定 2026-11-06（P3 派单批复）：D20–D25 的 id 联合与 snapshot I/O
 *  层（doctor-command.ts）不在 P3 文件域，所以在 doctor.ts 内本地扩展，
 *  不动 contracts.ts 的 `DoctorId`；生产 `/mem doctor` 的 blocks 分派接线
 *  留 P4/P5b。`formatDoctorReport`/`countBySeverity`/`summaryLine` 的参数
 *  放宽为 `DoctorFindingLike`，两者都接受。 */
export type BlocksDoctorId = "D20" | "D21" | "D22" | "D23" | "D24" | "D25";

export type BlocksDoctorFinding = Omit<DoctorFinding, "id"> & { id: BlocksDoctorId };

/** Structural superset of both finding shapes — what the formatters accept. */
export interface DoctorFindingLike {
  readonly id: string;
  readonly severity: DoctorSeverity;
  readonly file?: string;
  readonly line?: number;
  readonly message: string;
  readonly fix?: string;
}

export interface DoctorBlocksInput {
  /** `readCorpus(realDir).blocks`. */
  readonly blocks: readonly ParsedBlock[];
  /** `readCorpus(realDir).strays` — D23. */
  readonly strays: readonly string[];
  /** Archived block ids (readCorpus counts per topic; the names come from
   *  listing `blocks/archive/`) — D22 existence checks. Omitted ⇒ only the
   *  active ids are known. */
  readonly archivedIds?: readonly string[];
  /** The settings `layout` value — D24 (directory already block-format). */
  readonly settingsLayout: "tiered" | "legacy" | "blocks";
  /** Root-directory v2 `.md` count — D24's rollback-snapshot line. */
  readonly rootFileCount: number;
  /** Drift verdict count (arch §4.3.6 — produced by blocks/legacy.ts in P2;
   *  injected here so this file stays pure). 0/omitted ⇒ silent. */
  readonly driftCount?: number;
  /** `memory.residentBytes` — D21. */
  readonly residentBytes: number;
  readonly today: string;
  /** `.blocks-state.json` — D25 overBudgetStreak. */
  readonly state?: BlocksStateV1;
  /** `.blocks-hold` — D25 unfinished rollback. */
  readonly hold?: BlocksHoldV1;
  /** `.blocks-staging-*` dirs without an owner.json — D25. */
  readonly stagingWithoutOwner?: readonly string[];
  readonly nowMs?: number;
}

const BLOCKS_ID_ORDER: readonly string[] = ["D20", "D21", "D22", "D23", "D24", "D25"];

/** `runDoctorBlocks` — the blocks-layout-only codes (arch 附录 A). Pure:
 *  everything the rules need arrives in `DoctorBlocksInput`; no fs, no pi. */
export function runDoctorBlocks(input: DoctorBlocksInput): BlocksDoctorFinding[] {
  const findings: BlocksDoctorFinding[] = [];
  // D22 existence checks look at EVERY block id on disk (superseded blocks
  // still exist); archived ids arrive via input when the caller listed them.
  const knownIds = new Set<string>([...input.blocks.map((b) => b.id), ...(input.archivedIds ?? [])]);
  // D20: migration-exempt oversize bodies.
  for (const b of input.blocks) {
    const size = bodyBytes(b.body);
    if (size > 1024) {
      findings.push({
        id: "D20",
        severity: "warn",
        file: `${b.id}.md`,
        message: `${b.id}'s body is ${formatSize(size)}, over the 1024B block budget (migration-exempt) — update it to shrink below 1024B.`,
        fix: `memory update ${b.id}`,
      });
    }
  }
  // D21: resident budget — main-session口径, same metering as the renderer.
  {
    const resident = residentBlocksOf(input.blocks, { isChild: false, today: input.today });
    const used = residentMeteredBytes(resident, input.today);
    if (used > input.residentBytes * 4) {
      findings.push({
        id: "D21",
        severity: "error",
        message: `Resident user rules are ${formatSize(used)}, over 4× the residentBytes budget (${formatSize(input.residentBytes)}) — consolidate or demote to topic.`,
        fix: "/mem review",
      });
    } else if (used > input.residentBytes) {
      findings.push({
        id: "D21",
        severity: "warn",
        message: `Resident user rules are ${formatSize(used)} of the residentBytes budget (${formatSize(input.residentBytes)}) — consolidate or demote to topic.`,
        fix: "/mem review",
      });
    }
  }
  // D22: dangling supersededBy edges and cycles (single-sided relation).
  {
    const byId = new Map(input.blocks.map((b) => [b.id, b] as const));
    for (const b of input.blocks) {
      const target = b.meta.supersededBy;
      if (target === undefined) continue;
      if (!knownIds.has(target)) {
        findings.push({
          id: "D22",
          severity: "warn",
          file: `${b.id}.md`,
          message: `${b.id}.supersededBy → ${target}: no such block (moved, deleted or archived?).`,
          fix: `memory update ${b.id}`,
        });
        continue;
      }
      // Cycle walk: follow supersededBy until a block without one; bail at
      // revisit/self — every member of a cycle reports once (dedup below).
      const seen = new Set<string>([b.id]);
      let cursor: ParsedBlock | undefined = b;
      let cyclic = false;
      while (cursor !== undefined && cursor.meta.supersededBy !== undefined) {
        const next = cursor.meta.supersededBy;
        if (seen.has(next)) {
          cyclic = true;
          break;
        }
        seen.add(next);
        cursor = byId.get(next);
      }
      if (cyclic) {
        findings.push({
          id: "D22",
          severity: "warn",
          file: `${b.id}.md`,
          message: `supersededBy cycle detected at ${b.id} → ${target} — restore or clear one edge.`,
          fix: "/mem restore --block",
        });
      }
    }
  }
  // D23: parse errors (inline-meta remains, invalid frontmatter values,
  // agent scope ignored) + stray files in blocks/. Only the BODY oversize
  // (`E_TOO_LARGE`) is D20's subject — an over-limit `section` (>120B,
  // `E_SECTION_TOO_LARGE`) has no other reporter, so D23 covers it
  // (acceptance fix).
  for (const b of input.blocks) {
    for (const err of b.errors) {
      if (err === "E_TOO_LARGE" || err === "E_META_SOFT") continue;
      findings.push({
        id: "D23",
        severity: "warn",
        file: `${b.id}.md`,
        message: `${b.id}: ${err}`,
      });
    }
  }
  for (const name of input.strays) {
    findings.push({
      id: "D23",
      severity: "warn",
      file: name,
      message: `${name} is a stray file in blocks/ (missing kind: block or a malformed name) — not addressable as a block.`,
    });
  }
  // D24: layout/settings mismatch + rollback snapshot + legacy drift.
  if (input.settingsLayout !== "blocks") {
    findings.push({
      id: "D24",
      severity: "info",
      message: `layout setting is ${input.settingsLayout} but the directory is block-format — the data format wins, rendering uses blocks.`,
    });
  }
  if (input.rootFileCount > 0) {
    findings.push({
      id: "D24",
      severity: "info",
      message: `Root keeps ${input.rootFileCount} legacy file(s) as the rollback snapshot — untouched by design (/mem migrate --rollback to restore).`,
    });
  }
  if ((input.driftCount ?? 0) > 0) {
    findings.push({
      id: "D24",
      severity: "info",
      message: `Legacy drift: ${input.driftCount} root file(s) changed since migration — /mem migrate --import-legacy to import.`,
    });
  }
  // D25: overBudgetStreak, ownerless staging dirs, unfinished rollback.
  if ((input.state?.overBudgetStreak ?? 0) >= 3) {
    findings.push({
      id: "D25",
      severity: "warn",
      message: `Auto-migration went over budget ${input.state?.overBudgetStreak} times in a row — run /mem migrate explicitly.`,
    });
  }
  if ((input.stagingWithoutOwner?.length ?? 0) > 0) {
    findings.push({
      id: "D25",
      severity: "warn",
      message: `${input.stagingWithoutOwner?.length} staging dir(s) missing owner.json — never auto-cleaned; remove by hand if stale.`,
    });
  }
  if (input.hold?.rollback?.done === false) {
    findings.push({
      id: "D25",
      severity: "warn",
      message: "Rollback unfinished (hold.rollback.done=false) — the next /mem migrate continues it.",
    });
  }
  return findings.sort((a, b) => {
    const ai = BLOCKS_ID_ORDER.indexOf(a.id);
    const bi = BLOCKS_ID_ORDER.indexOf(b.id);
    if (ai !== bi) return ai - bi;
    const af = a.file ?? "";
    const bf = b.file ?? "";
    return af < bf ? -1 : af > bf ? 1 : 0;
  });
}

// ───────────────────────────── report / summary formatting (§6.2) ─────────────────────────────

interface SeverityCounts {
  error: number;
  warn: number;
  info: number;
}

export function countBySeverity(findings: readonly DoctorFindingLike[]): SeverityCounts {
  const counts: SeverityCounts = { error: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}

/** Full `/mem doctor` listing (§6.2) — multi-line, one finding per line. */
export function formatDoctorReport(findings: readonly DoctorFindingLike[]): string {
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
export function summaryLine(findings: readonly DoctorFindingLike[]): string {
  const c = countBySeverity(findings);
  const parts: string[] = [];
  if (c.error > 0) parts.push(`${c.error} error`);
  if (c.warn > 0) parts.push(`${c.warn} warn`);
  if (c.error === 0 && c.warn === 0) parts.push(c.info > 0 ? `${c.info} info` : "0 findings");
  return `doctor: ${parts.join(" · ")} — /mem doctor`;
}
