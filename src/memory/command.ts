/**
 * `/mem` slash command — human surface for project memory
 * (memory-plan §5.4): list / path / import [--force] [slug|all] / doctor /
 * trash / block restore.
 *
 * Translated line-by-line from the standalone @getpipher/armory-memory
 * plugin, with the repository command-handler error convention applied:
 * errors go to `ctx.ui.notify(…, "warning")` and are NEVER thrown (the
 * memory *tool* deliberately throws instead — see §6.4).
 *
 * todo #22 optimize-plan P0-b:
 * - `cwd` now resolves worktree origin (§1's "顺手修" — the tool and inject
 *   hook already did this; `/mem` was the odd one out).
 * - `import` awaits the now-async `importAll` / `importProject` (§3.3);
 *   an explicit slug list is a serial `for…of` `await` loop, NOT
 *   `Promise.all` — the first rejection stops the batch and already-imported
 *   slugs keep their results, matching the pre-#22 synchronous behavior.
 * - Doctor and standalone restore errors flow through the same
 *   try/catch → warning notify as every other command error.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isWebInvocation } from "../commands/capture.js";
import { resolveWorktreeOrigin } from "../core/worktree-origin.js";
import type { MemorySettings } from "../config/settings.js";
import type { MemoryWriteGate } from "./contracts.js";
import { parseTagsAddArgs, tokenizeTagsArgs } from "./jev/command-port.js";
import type {
  ClassifierRegistryLike,
  EntryHash,
  JevCommandPort,
  JevDoctorPort,
  MemCommandUiLike,
  MemEntry,
} from "./jev/contracts.js";
import { EntryIndex, expiredEntries, untilEntries } from "./jev/entries.js";
import { deleteEntry as fsDeleteEntry, setInlineMeta as fsSetInlineMeta } from "./jev/entry-edit.js";
import { blockReviewDisplay, blockExpiredDisplay, fileExpiredDisplay } from "./govern/display.js";
import { readIndex } from "./jev/index-store.js";
import { restoreBlock } from "./govern/sweep.js";
import { previewRevisionRestore, restoreRevisionRaw, type RevisionRestorePreview } from "./govern/revision-audit.js";
import { clampSpanMs } from "../core/deadline.js";
import { handleMemReview } from "./jev/review-command.js";
import { readMarker } from "./blocks/marker.js";
import { dirFormat, parseBlockName } from "./blocks/naming.js";
import { listTrashEntries } from "./trash.js";
import { restoreTrashedBlock } from "./blocks/store.js";
import {
  runMigration,
  resumeRollback,
  rollbackMigration,
  snapshotMigrationSources,
  plainMemoryWriteGate,
} from "./blocks/migrate.js";
import { planMigration } from "./blocks/migrate-plan.js";
import { legacyDrift, importLegacy } from "./blocks/legacy.js";
import { readBlocksState, readHold } from "./blocks/state.js";
import { join } from "node:path";
import { memoryDirFor, defaultPaths, type MemoryPaths } from "./paths.js";
import {
  canonicalMemoryDir,
  canonicalDir,
  ensureMemoryDir,
  inspectDirNoFollow,
  readRegular,
  TxnFsError,
} from "./safe-fs.js";
import { discoverCCProjects, importAll, importProject, listMemory, type ImportResult } from "./store.js";
import { formatSize } from "./render.js";
import { handleMemDoctorCommand, collectDoctorFindings, type RenderTieredPort } from "./doctor-command.js";
import { summaryLine } from "./doctor.js";
import { handleMemInitCommand } from "./init-command.js";
import { restoreFromTrash, LEGACY_BACKUP_REFUSAL } from "./trash.js";

export type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

const DESCRIPTION =
  "Project memory. /mem · /mem list · /mem init · /mem import [--force] [slug|all] · /mem path · /mem doctor · /mem restore --trash";
/** With a jev port the description gains the new subcommands (J4's jev/tags,
 *  J8's review/expired). The 2026-11-09 tidy removal is a declared
 *  command-surface change; unrelated Jev-off bytes remain frozen. */
const DESCRIPTION_JEV = `${DESCRIPTION} · /mem jev · /mem tags · /mem review · /mem expired · 维护: /mem jev reset-index`;

function fmtImport(r: ImportResult): string {
  const s = r.skipped ? `, ${r.skipped} skipped (exists)` : "";
  return `  ${r.project}: ${r.files} imported${s}`;
}

/** B3-consistent cwd resolution (matches the tool / inject hook): a worktree
 *  child session keys reads/writes to the MAIN repository's memory dir. */
function resolveCwd(ctx: ExtensionCommandContext): string {
  const raw = ctx?.cwd ?? process.cwd();
  return resolveWorktreeOrigin(raw) ?? raw;
}

/** Existing host owner lifetime, not a new authorization/approval owner. The
 * assembly must bind actual manager/owner/epoch and plain domain, never provider. */
export interface NativeRevisionRecoveryLifetime {
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}

export interface CreateMemCommandDeps {
  /** Absent => fail closed BEFORE audit discovery. Only plain main hosts supply it. */
  revisionRecovery?: (ctx: ExtensionCommandContext) => NativeRevisionRecoveryLifetime | undefined;
  scopedRouter?: (args: string, ctx: ExtensionCommandContext) => Promise<{ handled: boolean; result?: unknown }>;
  scopedDoctor?: () => readonly import("./scopes/doctor.js").ScopedDoctorFinding[];
  contentReadonly?: boolean;
  contentWriteGate?: MemoryWriteGate;
  paths?: MemoryPaths;
  writeGate?: MemoryWriteGate;
  /** Child sessions cannot restore files. */
  isChildSession?: boolean;
  /** Activate-time memory settings used by doctor. */
  settings?: MemorySettings;
  renderBlock?: RenderTieredPort;
  onAfterWrite?: (cwd: string, origin?: string) => void;
  /** Jev command port (`/mem jev`, `/mem tags`; jev-plan J4). `undefined` ⇔
   *  jev is not wired: every new branch below is skipped, the completion
   *  table and DESCRIPTION stay byte-identical (I9, jev-off-golden). */
  jev?: JevCommandPort;
}

const MEM_SUBCOMMANDS: ReadonlyArray<{ value: string; description: string }> = [
  { value: "list", description: "列出项目记忆文件（默认）" },
  { value: "init", description: "初始化项目记忆（创建 core.md 骨架）" },
  { value: "path", description: "显示记忆目录路径" },
  { value: "import", description: "从 Claude Code 导入记忆 [--force] [slug|all]" },
  { value: "doctor", description: "记忆健康检查（D01-D14）" },
  { value: "restore", description: "恢复回收项 [--trash]" },
];

const MEM_SECOND_LEVEL: Record<string, ReadonlyArray<{ value: string; description: string }>> = {
  restore: [{ value: "restore --trash", description: "从回收项恢复" }],
  import: [{ value: "import --force", description: "覆盖已存在的同名文件" }],
};

/** jev/tags second-level completion (J4) — appended only with a port;
 *  review/expired added by J8, same gating. */
const MEM_JEV_SUBCOMMANDS: ReadonlyArray<{ value: string; description: string }> = [
  { value: "jev", description: "Jev 分类引擎状态 [probe|retag]；维护：reset-index" },
  { value: "tags", description: "场景标签管理 [list|add|rm|disable|enable]" },
  { value: "review", description: "整理建议逐条确认 [--list|--run]" },
  { value: "expired", description: "到期条目处理" },
];
const MEM_JEV_SECOND_LEVEL: Record<string, ReadonlyArray<{ value: string; description: string }>> = {
  jev: [
    { value: "jev probe", description: "强制刷新可用集" },
    { value: "jev retag", description: "补打 pending 条目" },
    { value: "jev retag --all", description: "全部重打" },
    { value: "jev reset-index", description: "维护：清除侧车索引（保留 taxonomy）" },
  ],
  tags: [
    { value: "tags list", description: "列出标签" },
    { value: "tags add", description: "新增/更新标签（需 --label --desc）" },
    { value: "tags rm", description: "删除用户标签" },
    { value: "tags disable", description: "停用预置标签" },
    { value: "tags enable", description: "启用预置标签" },
  ],
  review: [
    { value: "review --list", description: "只读列出当前建议" },
    { value: "review --run", description: "立即跑一轮整理并生成建议" },
  ],
};

export function createMemCommand(deps: CreateMemCommandDeps): {
  description: string;
  getArgumentCompletions: (argumentPrefix: string) => { value: string; label: string; description: string }[];
  handler: CommandHandler;
} {
  const isChildSession = deps.isChildSession ?? false;
  const jev = deps.jev;
  // J8: a dedicated `EntryIndex` for review/expired's hash→MemEntry lookups
  // — only ever `.get()`'d on a review/expired/doctor dispatch, and only
  // constructed at all when jev is wired (I9: zero behavior with no port).
  const entryIndex = jev === undefined ? undefined : new EntryIndex();
  const dirFor = (c: string): string | undefined => canonicalMemoryDir(c, deps.paths)?.real;
  const entriesFor = (c: string): readonly MemEntry[] => {
    const dir = dirFor(c);
    return dir === undefined || entryIndex === undefined ? [] : entryIndex.get(dir);
  };
  // Blocks expose their own layout-specific menu; files use the declared Jev-off contract.
  const blocks = deps.settings?.layout === "blocks";
  const subcommands = [
    ...(jev === undefined ? MEM_SUBCOMMANDS : [...MEM_SUBCOMMANDS, ...MEM_JEV_SUBCOMMANDS]).map((item) =>
      blocks && item.value === "restore" ? { ...item, description: "恢复归档块 [--block]" } : item,
    ),
    ...(blocks
      ? [
          {
            value: "migrate",
            description: "维护：块布局迁移 [--dry-run|--all|--report|--status|--import-legacy|--rollback]",
          },
        ]
      : []),
  ];
  const secondLevel: Record<string, ReadonlyArray<{ value: string; description: string }>> = jev === undefined
    ? { ...MEM_SECOND_LEVEL }
    : { ...MEM_SECOND_LEVEL, ...MEM_JEV_SECOND_LEVEL };
  if (blocks) {
    secondLevel.restore = [{ value: "restore --block", description: "恢复归档块" }, ...MEM_SECOND_LEVEL.restore!];
  }
  const scopedHelp = deps.scopedRouter ? " · /mem session|hub status (list equivalent; status recommended)" : "";
  const description = blocks
    ? "Project memory blocks. /mem · /mem list · /mem init · /mem import · /mem path · /mem doctor · /mem restore --block" +
      (jev === undefined ? "" : " · /mem jev · /mem tags · /mem review · /mem expired") +
      scopedHelp +
      " · 维护: /mem migrate [--dry-run|--all|--report|--status|--import-legacy|--rollback]"
    : jev === undefined
      ? DESCRIPTION + scopedHelp
      : DESCRIPTION_JEV.replace(" · 维护:", `${scopedHelp} · 维护:`);
  return {
    description,
    getArgumentCompletions: (argumentPrefix: string) => {
      try {
        const a = (argumentPrefix ?? "").trimStart();
        const tokens = a.split(/\s+/).filter(Boolean);
        const partial = a.endsWith(" ") || a === "" ? "" : (tokens[tokens.length - 1] ?? "");
        const head = tokens.length > 1 || (tokens.length === 1 && a.endsWith(" ")) ? tokens[0] : undefined;
        if (head !== undefined) {
          const second = secondLevel[head] ?? [];
          const typed = a.trim();
          return (
            second
              .filter((item) => item.value.startsWith(typed) || item.value.slice(head.length + 1).startsWith(partial))
              // `value` carries the full argument text (pi-tui's applyCompletion replaces the
              // whole argument prefix with it); `label` stays the completed tail only, like
              // pi's own /mcp ({ value: "login github", label: "github" }).
              .map((item) => ({ ...item, label: item.value.slice(head.length + 1) }))
          );
        }
        return subcommands
          .filter((item) => item.value.startsWith(partial))
          .map((item) => ({
            value: item.value,
            label: item.value,
            description: item.description,
          }));
      } catch {
        return [];
      }
    },
    handler: async (args, ctx) => {
      const a = (args ?? "").trim();
      if (deps.scopedRouter) {
        const routed = await deps.scopedRouter(a, ctx);
        if (routed.handled) {
          if (ctx.hasUI) ctx.ui.notify(JSON.stringify(routed.result, null, 2), "info");
          return;
        }
      }
      if (deps.contentReadonly && !/^(?:list|path|doctor|jev|tags(?: list)?)?$/.test(a)) {
        if (ctx.hasUI) ctx.ui.notify("E_CHILD_READONLY: project memory is readonly", "warning");
        return;
      }
      const [sub, ...rest] = a.split(/\s+/);
      const cwd = resolveCwd(ctx);
      const doctorTrailer = (): string => {
        if (!deps.settings) return "";
        return `\n${summaryLine(
          collectDoctorFindings(cwd, deps.paths, deps.settings, deps.renderBlock, () => Date.now()),
        )}`;
      };
      const listMessage = (emptyHint: string): string => {
        const files = listMemory(cwd, deps.paths);
        const body = files.length ? files.map((f) => `  ${f.name} (${formatSize(f.size)})`).join("\n") : emptyHint;
        // J4: with a jev port the default listing gains ONE trailer status
        // line (jev-plan §4 J4); without one the message is byte-identical.
        let trailer = "";
        if (jev !== undefined) {
          try {
            trailer = `\n${jev.statusLine(cwd)}`;
          } catch {
            trailer = "\njev: status unavailable";
          }
        }
        return body + doctorTrailer() + trailer;
      };
      try {
        if (sub === "migrate") {
          const flags = new Set(rest);
          const allowed = ["--dry-run", "--all", "--report", "--status", "--import-legacy", "--rollback"];
          if (
            rest.some((x) => !allowed.includes(x)) ||
            ["--report", "--status", "--import-legacy", "--rollback"].filter((x) => flags.has(x)).length > 1
          )
            throw new Error("usage: /mem migrate [--dry-run|--all|--report|--status|--import-legacy|--rollback]");
          const readonly = flags.has("--dry-run") || flags.has("--status") || flags.has("--report");
          if (isChildSession || (!readonly && !isInteractive(ctx)) || (flags.has("--all") && !isInteractive(ctx)))
            throw new Error("memory migration requires the interactive main session");
          const gate = deps.writeGate ?? plainMemoryWriteGate;
          const current = memoryDirFor(cwd, deps.paths);
          let dirs = [current];
          if (flags.has("--all")) {
            const root = (deps.paths ?? defaultPaths()).memoryRoot;
            // Gate before enumeration: a locked session must not even probe layout.
            const v = gate.check(current);
            if (!v.ok && v.reason !== "identity-changed") throw new Error(`E_GATE: ${v.reason}`);
            dirs = inspectDirNoFollow(root)
              .names.filter((n) => !n.startsWith("."))
              .map((n) => join(root, n))
              .filter((d) => {
                try {
                  return inspectDirNoFollow(d).dev === inspectDirNoFollow(root).dev && dirFormat(d) === "files";
                } catch {
                  return false;
                }
              });
          }
          for (const dir of dirs) {
            if (!readonly) {
              const before = gate.check(dir);
              if (!before.ok && before.reason !== "identity-changed") throw new Error(`E_GATE: ${before.reason}`);
              if (!canonicalDir(dir)) ensureMemoryDir(dir);
              gate.capture(dir);
            }
            const verdict = gate.check(dir);
            if (!verdict.ok) throw new Error(`E_GATE: ${verdict.reason}`);
            let text: string;
            if (flags.has("--status"))
              text = JSON.stringify(
                {
                  auto: deps.settings?.migrate.auto ?? true,
                  layout: deps.settings?.layout,
                  dir: dirFormat(dir),
                  ...readBlocksState(dir),
                  hold: readHold(dir),
                  legacyDrift: legacyDrift(dir).length,
                  runId: readMarker(join(dir, "blocks"))?.runId,
                },
                null,
                2,
              );
            else if (flags.has("--report")) text = readRegular(join(dir, "blocks"), ".migration-report.json").text;
            else if (flags.has("--dry-run") && !flags.has("--import-legacy"))
              text = JSON.stringify(
                planMigration(
                  snapshotMigrationSources(dir),
                  readIndex(dir).index,
                  new Date().toISOString().slice(0, 10),
                ).report,
                null,
                2,
              );
            else if (flags.has("--dry-run") && flags.has("--import-legacy"))
              text = JSON.stringify(await importLegacy(dir, { gate, dryRun: true }));
            else {
              await resumeRollback(dir, { gate, explicit: true });
              if (flags.has("--rollback")) {
                const rollback = await rollbackMigration(dir, { gate });
                text = `memory: rolled back to current legacy files; retained: ${rollback.retained ?? "held"}; changed/new blocks: ${rollback.changed.join(", ") || "none"} — /reload required`;
              } else if (flags.has("--import-legacy"))
                text = JSON.stringify(await importLegacy(dir, { gate, dryRun: flags.has("--dry-run") }));
              else {
                const result = await runMigration(dir, { gate, explicit: true });
                text = `memory: ${result.outcome}${result.reason ? ` — ${result.reason}` : ""}`;
              }
              deps.onAfterWrite?.(cwd);
            }
            if (ctx.hasUI) ctx.ui.notify(text, "info");
          }
          return;
        }
        if (sub === "path") {
          if (ctx.hasUI) ctx.ui.notify(`memory dir: ${memoryDirFor(cwd, deps.paths)}`, "info");
          return;
        }
        if (sub === "init") {
          const initSettings = deps.settings;
          await handleMemInitCommand(ctx, {
            ...(deps.paths === undefined ? {} : { paths: deps.paths }),
            isChildSession,
            ...(deps.contentWriteGate ? { writeGate: deps.contentWriteGate } : {}),
            ...(initSettings === undefined ? {} : { settings: initSettings }),
            ...(deps.onAfterWrite === undefined ? {} : { onAfterWrite: deps.onAfterWrite }),
            ...(initSettings === undefined
              ? {}
              : {
                  doctorSummary: (c: string) =>
                    summaryLine(collectDoctorFindings(c, deps.paths, initSettings, deps.renderBlock, () => Date.now())),
                }),
          });
          return;
        }
        if (sub === "list") {
          if (ctx.hasUI) ctx.ui.notify(listMessage(`(no memory for ${cwd})`), "info");
          return;
        }
        if (sub === "import") {
          const force = rest.includes("--force");
          const targets = rest.filter((x) => x !== "--force");
          let results: ImportResult[];
          if (targets.length === 0 || targets[0] === "all") {
            const projects = discoverCCProjects(deps.paths);
            if (projects.length === 0) {
              if (ctx.hasUI)
                ctx.ui.notify("No Claude Code projects found at ~/.claude/projects/ — nothing to import.", "warning");
              return;
            }
            results = await importAll(force, deps.paths);
          } else {
            // Serial, NOT Promise.all (§3.3): the first rejection stops the
            // batch here — already-imported slugs keep their results.
            results = [];
            for (const s of targets) {
              results.push(await importProject(s, force, deps.paths));
            }
          }
          const total = results.reduce(
            (acc, r) => {
              acc.files += r.files;
              acc.skipped += r.skipped;
              return acc;
            },
            { files: 0, skipped: 0 },
          );
          const summary =
            `Imported ${total.files} file(s)${total.skipped ? `, ${total.skipped} skipped` : ""}.\n` +
            results.map(fmtImport).join("\n");
          if (ctx.hasUI) ctx.ui.notify(summary, "info");
          return;
        }
        if (sub === "doctor") {
          await handleMemDoctorCommand(rest.join(" "), ctx, {
            settings:
              deps.settings ??
              (() => {
                throw new Error("memory settings unavailable");
              })(),
            ...(deps.paths === undefined ? {} : { paths: deps.paths }),
            ...(deps.renderBlock === undefined ? {} : { renderTieredPort: deps.renderBlock }),
            ...(jev === undefined ? {} : { jev: jevDoctorPortFrom(jev, entriesFor) }),
            ...(deps.scopedDoctor ? { scoped: deps.scopedDoctor } : {}),
          });
          return;
        }
        // Exact native revision grammar is dispatched before every legacy/trash/
        // block branch, including malformed mixed forms. No discovery on failure.
        if (sub === "restore" && rest.includes("--revision")) {
          if (rest.length !== 2 || rest[0] !== "--revision" || !/^[a-f0-9]{64}$/.test(rest[1]!))
            throw new Error("usage: /mem restore --revision <64-lowercase-hex actionId>");
          await restoreNativeRevision(rest[1]!, cwd, ctx, deps);
          return;
        }
        if (sub === "restore" && rest[0] !== "--block" && rest.includes("--trash")) {
          const display = memoryDirFor(cwd, deps.paths);
          const root = canonicalDir(display)?.real;
          const format = dirFormat(display);
          if (format === "held") throw new Error("E_UNMIGRATED: layout is held");
          if (root && format !== "blocks" && inspectDirNoFollow(root).names.includes("blocks"))
            throw new Error("E_UNMIGRATED: blocks layout is inaccessible or invalid");
          if (format === "blocks" && root) {
            if (isChildSession || !ctx.hasUI) {
              if (ctx.hasUI) ctx.ui.notify("/mem restore is only available in the main session", "warning");
              return;
            }
            if (
              rest.length > 2 ||
              rest.filter((arg) => arg === "--trash").length !== 1 ||
              rest.some((arg) => arg.startsWith("--") && arg !== "--trash")
            )
              throw new Error("usage: /mem restore --trash [id]");
            const gate = deps.writeGate ?? plainMemoryWriteGate;
            if (!gate.check(root).ok) throw new Error("E_WRITE_GATE: memory write refused");
            const blocks = join(root, "blocks");
            const info = inspectDirNoFollow(blocks);
            if (info.names.includes(".trash")) {
              const trash = inspectDirNoFollow(join(blocks, ".trash"));
              if (trash.dev !== info.dev) throw new Error("E_WRITE_GATE: trash device changed");
            }
            const entries = listTrashEntries(blocks).filter((entry) => parseBlockName(entry.name));
            const id = rest.find((arg) => arg !== "--trash");
            if (!id) {
              ctx.ui.notify(
                entries.length ? entries.map((entry) => `  ${entry.id} — ${entry.name}`).join("\n") : "trash is empty",
                "info",
              );
              return;
            }
            const entry = entries.find((item) => item.id === id);
            if (!entry) {
              ctx.ui.notify(`no trash entry ${id}`, "warning");
              return;
            }
            const name = await restoreTrashedBlock(root, id, { gate });
            deps.onAfterWrite?.(cwd);
            ctx.ui.notify(`restore --trash: restored ${name}`, "info");
            return;
          }
        }
        if (
          (sub === "restore" && rest[0] === "--block") ||
          ((sub === "review" || sub === "expired") && dirFormat(memoryDirFor(cwd, deps.paths)) === "blocks")
        ) {
          const dir = canonicalDir(memoryDirFor(cwd, deps.paths))?.real ?? memoryDirFor(cwd, deps.paths);
          if (sub === "restore") {
            if (isChildSession) {
              if (ctx.hasUI) ctx.ui.notify("restore: requires main session", "warning");
              return;
            }
            if (!rest[1]) throw new Error("usage: /mem restore --block <id or stored name>");
            const message = await restoreBlock(dir, rest[1], { gate: deps.writeGate ?? plainMemoryWriteGate });
            deps.onAfterWrite?.(cwd);
            if (ctx.hasUI) ctx.ui.notify(message, "info");
          } else if (ctx.hasUI) {
            ctx.ui.notify(
              sub === "review"
                ? `${blockReviewDisplay(dir)}${rest.includes("--run") ? "\n只展示现有建议，不会启动整理。" : ""}`
                : blockExpiredDisplay(dir),
              "info",
            );
          }
          return;
        }
        if (sub === "restore") {
          // Old tidy journals/manifests/archives are deliberately never opened or recovered.
          if (rest[0] !== "--trash") throw new Error(LEGACY_BACKUP_REFUSAL);
          if (isChildSession || !isInteractive(ctx)) {
            if (ctx.hasUI) ctx.ui.notify("/mem restore requires the interactive main session", "warning");
            return;
          }
          if (rest.length > 2 || rest.some((arg, i) => i > 0 && arg.startsWith("-")))
            throw new Error("usage: /mem restore --trash [id]");
          const root = canonicalDir(memoryDirFor(cwd, deps.paths))?.real;
          const entries = root ? listTrashEntries(root) : [];
          if (!rest[1]) {
            ctx.ui.notify(
              entries.length ? entries.map((e) => `  ${e.id} — ${e.name}`).join("\n") : "trash is empty",
              "info",
            );
            return;
          }
          const result = await restoreFromTrash(
            cwd,
            rest[1],
            "skip",
            deps.paths,
            deps.writeGate ?? plainMemoryWriteGate,
          ).catch((err: unknown) => {
            if (err instanceof TxnFsError && err.mutated) {
              try {
                deps.onAfterWrite?.(cwd);
              } catch {
                /* preserve the partial-mutation observation */
              }
            }
            throw err;
          });
          if (!result.restored) {
            ctx.ui.notify(result.reason ?? "restore refused", "warning");
            return;
          }
          deps.onAfterWrite?.(cwd);
          ctx.ui.notify("restore --trash: restored", "info");
          return;
        }
        if (sub === "jev" && jev !== undefined) {
          await handleMemJev(jev, rest, ctx, cwd);
          return;
        }
        if (sub === "tags" && jev !== undefined) {
          await handleMemTags(jev, rest, ctx, cwd);
          return;
        }
        if (sub === "review" && jev !== undefined) {
          const dir = dirFor(cwd);
          await handleMemReview("--list", toMemCommandUi(ctx), jev, {
            cwd,
            dir,
            entries: entriesFor(cwd),
            isChildSession,
            interactive: isInteractive(ctx),
            registry: jevRegistryOf(ctx),
            updatedAtOf: updatedAtOfFor(dir),
            deleteEntry: (entry) => (dir === undefined ? Promise.resolve("stale" as const) : fsDeleteEntry(dir, entry)),
            setInlineMeta: (entry, patch) =>
              dir === undefined ? Promise.resolve("stale" as const) : fsSetInlineMeta(dir, entry, patch),
          });
          return;
        }
        if (sub === "expired") {
          const dir = dirFor(cwd);
          if (ctx.hasUI)
            ctx.ui.notify(
              dir === undefined
                ? "expired: no memory directory"
                : fileExpiredDisplay(jev === undefined ? new EntryIndex().get(dir) : entriesFor(cwd)),
              "info",
            );
          return;
        }
        if (sub === "review") {
          if (ctx.hasUI) ctx.ui.notify("review: unavailable\n此布局未启用建议索引，无法显示建议。", "info");
          return;
        }
        // default: list
        if (ctx.hasUI)
          ctx.ui.notify(listMessage(`(no memory for ${cwd} — run /mem import to bring in Claude Code memory)`), "info");
        return;
      } catch (err) {
        if (ctx.hasUI) ctx.ui.notify(`memory error: ${(err as Error).message}`, "warning");
      }
    },
  };
}

/** One existing native dialog, outside the C lock. Abort/timeout races even
 * an uncooperative UI; a late true cannot revive the continuation. */
async function confirmNativeRevision(
  ctx: ExtensionCommandContext,
  preview: RevisionRestorePreview,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false;
  const local = new AbortController();
  const abort = () => local.abort();
  let settleAbort: (() => void) | undefined;
  const cancelled = new Promise<false>((resolve) => {
    settleAbort = () => resolve(false);
    local.signal.addEventListener("abort", settleAbort, { once: true });
  });
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, clampSpanMs(120_000) ?? 120_000);
  timer.unref();
  try {
    const { rawBefore, auditDigest, ...metadata } = preview;
    return (
      (await Promise.race([
        ctx.ui.confirm(
          "恢复指定 revision（仅此目标）",
          [
            JSON.stringify(metadata, null, 2),
            `审计/命名空间摘要：${auditDigest}`,
            `精确效果：${preview.expectedAfter.kind === "missing" ? "仅当目标仍缺失时创建" : "仅替换仍与 expectedAfter 完全匹配的"} ${preview.memoryDir}/blocks/${preview.targetId}.md；写回 before.md 的 ${preview.beforeBytes} 原始字节。`,
            "不重新序列化、不增加 version、不修改 context/successor 或回收副本。BOM/CRLF 以审计原始字节为准。",
            "—— 将恢复的完整原文（显示不替代上述字节摘要） ——",
            rawBefore,
          ].join("\n"),
          { signal: local.signal },
        ),
        cancelled,
      ])) === true && !local.signal.aborted
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    if (settleAbort) local.signal.removeEventListener("abort", settleAbort);
    local.abort();
  }
}

async function restoreNativeRevision(
  actionId: string,
  cwd: string,
  ctx: ExtensionCommandContext,
  deps: CreateMemCommandDeps,
): Promise<void> {
  const confirm = ctx.ui?.confirm;
  const native = () =>
    !deps.isChildSession &&
    deps.settings?.enabled === true &&
    !deps.contentReadonly &&
    isInteractive(ctx) &&
    typeof confirm === "function" &&
    ctx.ui?.confirm === confirm;
  if (!native()) throw new Error("restore --revision: requires actual native TUI main with confirmation");
  const lifetime = deps.revisionRecovery?.(ctx);
  if (!lifetime) throw new Error("restore --revision: current plain memory owner unavailable");
  const current = () => {
    const valid = lifetime.isCurrent();
    return valid && !lifetime.signal.aborted && native() && resolveCwd(ctx) === cwd;
  };
  if (!current()) throw new Error("restore --revision: owner/epoch unavailable");
  const display = memoryDirFor(cwd, deps.paths);
  const gate = deps.writeGate;
  if (!gate || !gate.check(display).ok || deps.contentWriteGate?.check(display).ok === false || !current())
    throw new Error("restore --revision: write gate refused");
  const dir = canonicalDir(display)?.real;
  if (!dir || dirFormat(dir) !== "blocks") throw new Error("restore --revision: actual blocks directory required");
  const auditDeps = {
    gate,
    signal: lifetime.signal,
    isCurrent: () => current() && deps.contentWriteGate?.check(dir).ok !== false,
    now: () => new Date(),
  };
  const result = previewRevisionRestore(dir, actionId, auditDeps);
  if (result.kind !== "ready") throw new Error(`restore --revision refused: ${result.reason}`);
  if (!current()) throw new Error("restore --revision: owner/epoch changed");
  if (!(await confirmNativeRevision(ctx, result.preview, lifetime.signal))) {
    ctx.ui.notify("restore --revision: cancelled; no recovery writes", "info");
    return;
  }
  if (!current()) throw new Error("restore --revision: owner/epoch changed after confirmation");
  const restored = await restoreRevisionRaw(
    dir,
    {
      actionId,
      expectedAuditDigest: result.preview.auditDigest,
      signal: lifetime.signal,
    },
    auditDeps,
  );
  if (restored.kind === "restored" || restored.kind === "effect-unknown") {
    try {
      deps.onAfterWrite?.(cwd, "revision");
    } catch {
      /* do not misreport an observed effect as rejected */
    }
    ctx.ui.notify(
      restored.kind === "restored"
        ? `restore --revision: restored ${result.preview.targetId} (${actionId})`
        : "restore --revision: effect-unknown; 目标可能已改变。禁止盲目重试，请人工检查目标和审计恢复 intent。",
      restored.kind === "restored" ? "info" : "warning",
    );
  } else throw new Error(`restore --revision refused: ${restored.reason}`);
}

// ───────────────────────────── jev subcommands (J4) ─────────────────────────────

/** `ctx.modelRegistry` is the classifier registry source (jev-arch §5.1);
 *  read lazily so sessions without one stay untouched (off(pi-api)). */
function jevRegistryOf(ctx: ExtensionCommandContext): ClassifierRegistryLike | undefined {
  return (ctx as { modelRegistry?: ClassifierRegistryLike }).modelRegistry;
}

// ────────────────────────────── review/expired plumbing (J8) ──────────────────────────────

/** Composes a `JevDoctorPort` (contracts.ts, jev-plan §4 J8) out of the
 *  existing `JevCommandPort` (J4) and the local entry lookup — production
 *  wiring only needs to supply the `JevCommandPort`; this file does the
 *  rest, so J7's eventual real wiring can pass the very same port through
 *  unchanged. Never throws: every sub-line is best-effort. */
function jevDoctorPortFrom(jevPort: JevCommandPort, entriesFor: (cwd: string) => readonly MemEntry[]): JevDoctorPort {
  return {
    extraReminder(cwd: string): readonly string[] {
      const lines: string[] = [];
      try {
        const entries = entriesFor(cwd);
        const today = new Date().toISOString().slice(0, 10);
        const expired = expiredEntries(entries, today).length;
        const untilCount = untilEntries(entries).length;
        if (expired > 0) lines.push(`${String(expired)} entr${expired === 1 ? "y" : "ies"} expired — /mem expired`);
        if (untilCount > 0) {
          lines.push(
            `${String(untilCount)} entr${untilCount === 1 ? "y" : "ies"} with an until condition — /mem expired`,
          );
        }
      } catch {
        // best effort — never block the startup reminder
      }
      try {
        const open = jevPort.review.list(cwd).filter((s) => !s.stale).length;
        if (open > 0) lines.push(`jev ${String(open)} suggestion${open === 1 ? "" : "s"} — /mem review`);
      } catch {
        // best effort
      }
      try {
        lines.push(jevPort.statusLine(cwd));
      } catch {
        // best effort
      }
      return lines;
    },
  };
}

/** Adapts `ctx.ui` (`ExtensionCommandContext`, pi-aware) to the pi-free
 *  `MemCommandUiLike` J8's review/expired handlers take. No-UI sessions get
 *  no-op `notify`/`confirm`/`select` — the handlers themselves already
 *  early-return on `deps.dir === undefined`/child-session before ever
 *  reaching a `ui.*` call in that case, matching every other `/mem`
 *  subcommand's "silent without a UI" convention. */
function toMemCommandUi(ctx: ExtensionCommandContext): MemCommandUiLike {
  const base: MemCommandUiLike = {
    notify: (text: string) => {
      if (ctx.hasUI) ctx.ui.notify(text, "info");
    },
    confirm: async (title, body, opts) => (ctx.hasUI ? ctx.ui.confirm(title, body, opts) : false),
    select: async (title, options) => {
      if (!ctx.hasUI) return undefined;
      const picked = await ctx.ui.select(
        title,
        options.map((o) => o.label),
      );
      return options.find((o) => o.label === picked)?.value;
    },
  };
  return ctx.hasUI ? { ...base, setEditorText: (text: string) => ctx.ui.setEditorText(text) } : base;
}

/** `/mem review`'s default interactive loop and `/mem expired`'s per-entry
 *  loop both need a real `ui.select` — a non-tui or web-claimed invocation
 *  (hygiene-flow Q35) degrades to the same text a `--list` would show. */
function isInteractive(ctx: ExtensionCommandContext): boolean {
  return ctx.hasUI && ctx.mode === "tui" && !isWebInvocation(ctx);
}

/** Sidecar `at` for a hash (jev-plan §4 J8's "duplicate" older-side pick) —
 *  a plain read, no lock; `undefined` dir or untagged hash ⇒ undefined. */
function updatedAtOfFor(dir: string | undefined): (hash: EntryHash) => string | undefined {
  if (dir === undefined) return () => undefined;
  return (hash: EntryHash) => readIndex(dir).index.entries[hash]?.at;
}

/** `/mem jev [probe | retag [--all] | reset-index]`. Write-ish operations
 *  (retag/reset-index) are main-session + hasUI only (jev-plan §4 J4); the
 *  bare report and probe are read-only. */
async function handleMemJev(
  jev: JevCommandPort,
  rest: readonly string[],
  ctx: ExtensionCommandContext,
  cwd: string,
): Promise<void> {
  const op = rest[0];
  const notify = (text: string, level: "info" | "warning" = "info"): void => {
    // Silent refusal without a UI — the framework offers no output channel
    // for /mem commands in print/RPC-no-UI mode (same convention as every
    // other /mem branch and the restore gate; verifier item 2).
    if (ctx.hasUI) ctx.ui.notify(text, level);
  };
  if ((op === "retag" || op === "reset-index") && (jev.isChildSession || !ctx.hasUI)) {
    notify(`jev: ${op} requires the interactive main session`, "warning");
    return;
  }
  try {
    if (op === undefined) {
      notify(await jev.report(cwd, jevRegistryOf(ctx)));
      return;
    }
    if (op === "probe") {
      notify(await jev.probe(jevRegistryOf(ctx)));
      return;
    }
    if (op === "retag") {
      notify(await jev.retag(cwd, rest.includes("--all"), jevRegistryOf(ctx)));
      return;
    }
    if (op === "reset-index") {
      notify(await jev.resetIndex(cwd));
      return;
    }
    notify("usage: /mem jev [probe | retag [--all] | reset-index]", "warning");
  } catch (err) {
    notify(`jev error: ${(err as Error).message}`, "warning");
  }
}

/** `/mem tags [list | add <id> --label … --desc "…" [--risk high]
 *  [--commands a,b] [--paths a,b] [--tools a,b] | rm <id> | disable <id> |
 *  enable <id>`. Everything but `list` is main-session + hasUI only. The
 *  minimal quote-aware tokenization keeps `--desc "two words"` intact. */
async function handleMemTags(
  jev: JevCommandPort,
  rest: readonly string[],
  ctx: ExtensionCommandContext,
  cwd: string,
): Promise<void> {
  const op = rest[0] ?? "list";
  const notify = (text: string, level: "info" | "warning" = "info"): void => {
    if (ctx.hasUI) ctx.ui.notify(text, level);
  };
  const gated = (): boolean => {
    // No-UI refusals are silent (framework has no output channel here) —
    // same convention as handleMemJev above and the restore gate.
    if (jev.isChildSession || !ctx.hasUI) {
      notify(`tags: ${op} requires the interactive main session`, "warning");
      return false;
    }
    return true;
  };
  try {
    if (op === "list") {
      notify(jev.tags.list(cwd));
      return;
    }
    if (op === "add") {
      if (!gated()) return;
      const parsed = parseTagsAddArgs(tokenizeTagsArgs(rest.slice(1).join(" ")));
      if (!parsed.ok) {
        notify(parsed.error, "warning");
        return;
      }
      notify(await jev.tags.add(cwd, parsed.def));
      return;
    }
    if (op === "rm") {
      if (!gated()) return;
      const id = rest[1];
      if (id === undefined) {
        notify("usage: /mem tags rm <id>", "warning");
        return;
      }
      notify(await jev.tags.remove(cwd, id));
      return;
    }
    if (op === "disable" || op === "enable") {
      if (!gated()) return;
      const id = rest[1];
      if (id === undefined) {
        notify(`usage: /mem tags ${op} <id>`, "warning");
        return;
      }
      notify(await jev.tags.setEnabled(cwd, id, op === "enable"));
      return;
    }
    notify(
      'usage: /mem tags [list | add <id> --label … --desc "…" [--risk high] [--commands a,b] [--paths a,b] [--tools a,b] | rm <id> | disable <id> | enable <id>]',
      "warning",
    );
  } catch (err) {
    notify(`tags error: ${(err as Error).message}`, "warning");
  }
}

/** Web-only gate. It does not change, call, or impersonate the native command handler. */
export async function executeConfirmedMemoryWrite(
  call: import("./command-confirm.js").MemoryWebCall,
  request: import("./command-policy.js").MemoryWriteRequest,
  plan: import("./scopes/session-store.js").FrozenPlan,
  receipt: import("./command-confirm.js").MemoryCommandApproval,
  deps: {
    readonly kernel: import("./command-confirm.js").CommandConfirmKernel;
    readonly currentOwnerMatches: (binding: import("./command-confirm.js").MemoryWebCallBinding) => boolean;
    readonly store: Pick<
      import("./scopes/session-store.js").SessionMemoryStore,
      "ownsWebPlan" | "enqueueConfirmedCommand"
    >;
  },
): Promise<import("./scopes/session-store.js").SessionWebOutcome> {
  const failure = (
    code: import("./command-confirm.js").CommandErrorCode,
  ): import("./scopes/session-store.js").SessionWebFailure => ({
    ok: false,
    effect: "none",
    code,
    message: `${code}: 本步未执行。`,
    retryable: false,
  });
  const reject = (code: import("./command-confirm.js").CommandErrorCode) => {
    // Revoke only this call. The store retains its prepared observation until its owner
    // releases it after completion; closing the kernel does not release the store plan.
    deps.kernel.close(call);
    return failure(code);
  };
  try {
    const binding = deps.kernel.binding(call);
    if (!binding || !deps.currentOwnerMatches(binding)) return reject("E_MEM_NEEDS_HUMAN_COMMAND");
    if (request.kind !== "session.add" || plan.kind !== "session.add" || request.rawArgs !== plan.commandPlan.rawArgs)
      return reject("E_MEM_PLAN_CHANGED");
    if (!deps.store.ownsWebPlan(call, plan)) return reject("E_MEM_PLAN_CHANGED");
    if (!deps.kernel.check(call, receipt, plan.commandPlan)) return reject("E_MEM_CONFIRM_STALE");
  } catch {
    return reject("E_MEM_CONFIRM_STALE");
  }
  try {
    return await deps.store.enqueueConfirmedCommand(call, plan, receipt);
  } catch {
    // The store is responsible for classifying attempted writes; an unexpected rejection
    // from an injected consumer cannot establish that no effect occurred.
    return {
      ok: false,
      effect: "unknown",
      code: "E_PERSIST_UNKNOWN",
      message: "E_PERSIST_UNKNOWN: 写入结果未知，请勿盲目重试。",
      retryable: false,
      recovery: "explicit-reopen-and-verify",
    };
  }
}
