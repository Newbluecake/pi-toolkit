/**
 * `/mem` slash command — human surface for project memory
 * (memory-plan §5.4): list / path / import [--force] [slug|all].
 *
 * Translated line-by-line from the standalone @getpipher/armory-memory
 * plugin, with the repository command-handler error convention applied:
 * errors go to `ctx.ui.notify(…, "warning")` and are NEVER thrown (the
 * memory *tool* deliberately throws instead — see §6.4).
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { memoryDirFor, type MemoryPaths } from "./paths.js";
import { discoverCCProjects, importAll, importProject, listMemory, type ImportResult } from "./store.js";

export type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

const DESCRIPTION = "Project memory. /mem · /mem list · /mem import [--force] [slug|all] · /mem path";

function fmtImport(r: ImportResult): string {
  const s = r.skipped ? `, ${r.skipped} skipped (exists)` : "";
  return `  ${r.project}: ${r.files} imported${s}`;
}

export function createMemCommand(deps: { paths?: MemoryPaths }): { description: string; handler: CommandHandler } {
  return {
    description: DESCRIPTION,
    handler: async (args, ctx) => {
      const a = (args ?? "").trim();
      const [sub, ...rest] = a.split(/\s+/);
      const cwd = ctx?.cwd ?? process.cwd();
      try {
        if (sub === "path") {
          if (ctx.hasUI) ctx.ui.notify(`memory dir: ${memoryDirFor(cwd, deps.paths)}`, "info");
          return;
        }
        if (sub === "list") {
          const files = listMemory(cwd, deps.paths);
          const msg = files.length ? files.map((f) => `  ${f.name} (${f.size}B)`).join("\n") : `(no memory for ${cwd})`;
          if (ctx.hasUI) ctx.ui.notify(msg, "info");
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
            results = importAll(force, deps.paths);
          } else {
            results = targets.map((s) => importProject(s, force, deps.paths));
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
        // default: list
        const files = listMemory(cwd, deps.paths);
        const msg = files.length
          ? files.map((f) => `  ${f.name} (${f.size}B)`).join("\n")
          : `(no memory for ${cwd} — run /mem import to bring in Claude Code memory)`;
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
      } catch (err) {
        if (ctx.hasUI) ctx.ui.notify(`memory error: ${(err as Error).message}`, "warning");
      }
    },
  };
}
