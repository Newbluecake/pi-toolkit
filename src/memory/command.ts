/**
 * `/mem` slash command — human surface for project memory
 * (memory-plan §5.4): list / path / import [--force] [slug|all] / doctor /
 * tidy / restore.
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
 * - `doctor` / `tidy` / `restore` dispatch to the (still-stubbed) P3/P4
 *   command handlers; their "not implemented yet" rejection flows through
 *   the same try/catch → warning notify as every other command error.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolveWorktreeOrigin } from "../core/worktree-origin.js";
import type { MemorySettings } from "../config/settings.js";
import type { TidyPort } from "./contracts.js";
import { memoryDirFor, type MemoryPaths } from "./paths.js";
import { discoverCCProjects, importAll, importProject, listMemory, type ImportResult } from "./store.js";
import { formatSize } from "./render.js";
import { handleMemDoctorCommand, collectDoctorFindings, type RenderTieredPort } from "./doctor-command.js";
import { summaryLine } from "./doctor.js";
import { handleMemTidyCommand } from "./tidy/command.js";

export type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

const DESCRIPTION =
  "Project memory. /mem · /mem list · /mem import [--force] [slug|all] · /mem path · /mem doctor · /mem tidy · /mem restore";

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

export interface CreateMemCommandDeps {
  paths?: MemoryPaths;
  /** Default false — used only by the `/mem tidy`/`/mem restore` gate (§7). */
  isChildSession?: boolean;
  /** §7's spawn port; undefined ⇒ "tidy unavailable in this session". Wired
   *  by `wireMemory`'s `attachTidy` (post-guard, main session only). */
  getTidyPort?: () => TidyPort | undefined;
  /** Activate-time memory settings shared by doctor and tidy. */
  settings?: MemorySettings;
  renderBlock?: RenderTieredPort;
  runDoctor?: typeof import("./doctor.js").runDoctor;
  onAfterWrite?: (cwd: string) => void;
}

const MEM_SUBCOMMANDS: ReadonlyArray<{ value: string; description: string }> = [
  { value: "list", description: "列出项目记忆文件（默认）" },
  { value: "path", description: "显示记忆目录路径" },
  { value: "import", description: "从 Claude Code 导入记忆 [--force] [slug|all]" },
  { value: "doctor", description: "记忆健康检查（D01-D14）" },
  { value: "tidy", description: "治理记忆 [--dry-run|--frontmatter] [file…]" },
  { value: "restore", description: "恢复 tidy 备份 [--trash]" },
];

const MEM_SECOND_LEVEL: Record<string, ReadonlyArray<{ value: string; description: string }>> = {
  tidy: [
    { value: "tidy --dry-run", description: "只预览，不写入" },
    { value: "tidy --frontmatter", description: "只整理 frontmatter" },
  ],
  restore: [{ value: "restore --trash", description: "从回收项恢复" }],
  import: [{ value: "import --force", description: "覆盖已存在的同名文件" }],
};

export function createMemCommand(deps: CreateMemCommandDeps): {
  description: string;
  getArgumentCompletions: (argumentPrefix: string) => { value: string; label: string; description: string }[];
  handler: CommandHandler;
} {
  const isChildSession = deps.isChildSession ?? false;
  const getTidyPort = deps.getTidyPort ?? (() => undefined);
  return {
    description: DESCRIPTION,
    getArgumentCompletions: (argumentPrefix: string) => {
      try {
        const a = (argumentPrefix ?? "").trimStart();
        const tokens = a.split(/\s+/).filter(Boolean);
        const partial = a.endsWith(" ") || a === "" ? "" : (tokens[tokens.length - 1] ?? "");
        const head = tokens.length > 1 || (tokens.length === 1 && a.endsWith(" ")) ? tokens[0] : undefined;
        if (head !== undefined) {
          return (MEM_SECOND_LEVEL[head] ?? [])
            .filter((item) => item.value.slice(head.length + 1).startsWith(partial))
            .map((item) => ({ ...item, label: item.value }));
        }
        return MEM_SUBCOMMANDS.filter((item) => item.value.startsWith(partial)).map((item) => ({
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
        return body + doctorTrailer();
      };
      try {
        if (sub === "path") {
          if (ctx.hasUI) ctx.ui.notify(`memory dir: ${memoryDirFor(cwd, deps.paths)}`, "info");
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
          });
          return;
        }
        if (sub === "tidy" || sub === "restore") {
          await handleMemTidyCommand(sub, rest.join(" "), ctx, {
            ...(deps.paths === undefined ? {} : { paths: deps.paths }),
            isChildSession,
            getTidyPort,
            settings: () =>
              deps.settings ??
              (() => {
                throw new Error("memory settings unavailable");
              })(),
            ...(deps.runDoctor === undefined ? {} : { runDoctor: deps.runDoctor }),
            ...(deps.onAfterWrite === undefined ? {} : { onAfterWrite: deps.onAfterWrite }),
          });
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
