/**
 * `memory` tool — model-callable surface for the cwd-keyed project memory
 * (memory-plan §5.3). list is always available; write/append are gated by
 * the settings block and refuse in child sessions unless
 * `memory.allowWriteInChildSessions` is enabled (B1).
 *
 * Differences vs the standalone @getpipher/armory-memory plugin (§6.4):
 * - adds write/append actions with the §5.3 safety model (dir fence, dual
 *   byte caps, 0600, provenance frontmatter — all enforced by the store);
 * - execute errors THROW (repo convention) instead of returning an
 *   `Error: …` text payload (Nit 13);
 * - the omp `{message}` injection branch and the gateway trace sink are
 *   dropped (§1.3 non-goals).
 *
 * cwd resolution (B3): a worktree child session keys reads/writes to the
 * MAIN repository's memory directory via the worktree-origin registry.
 */

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import type { MemorySettings } from "../config/settings.js";
import { resolveWorktreeOrigin } from "../core/worktree-origin.js";
import { memoryDirFor, toSlug, type MemoryPaths } from "./paths.js";
import { listMemory, writeMemoryFile } from "./store.js";

export const MemoryToolParams = Type.Object({
  action: Type.Optional(Type.Union([Type.Literal("list"), Type.Literal("write"), Type.Literal("append")])),
  name: Type.Optional(
    Type.String({
      description: 'Memory file name, e.g. "decisions.md". Required for write/append. *.md only, no path separators.',
    }),
  ),
  content: Type.Optional(
    Type.String({ description: "Full file body (write) or text to append (append). Required for write/append." }),
  ),
});
export type MemoryToolParams = Static<typeof MemoryToolParams>;

export interface MemoryToolDeps {
  settings: MemorySettings;
  isChildSession: boolean;
  /** 写成功后由 wireMemory 接线：cache.delete(cwd) 或冻结标记（freezeInjectionAfterWrite）。 */
  onAfterWrite: (cwd: string) => void;
  paths?: MemoryPaths;
}

type ToolTextResult = { content: { type: "text"; text: string }[]; details: undefined };

function text(text: string): ToolTextResult {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

/** B3: worktree child sessions resolve back to the original repository cwd. */
function resolveCwd(ctx: ExtensionContext | undefined): string {
  const raw = ctx?.cwd ?? process.cwd();
  return resolveWorktreeOrigin(raw) ?? raw;
}

export function createMemoryTool(deps: MemoryToolDeps): ToolDefinition {
  const { settings } = deps;
  return {
    name: "memory",
    label: "Memory",
    description:
      "Project memory for the current working directory (Claude-Code-compatible, cwd-keyed, " +
      "auto-injected each turn). Use to list the cwd's memory files, and to persist durable " +
      "project facts with write/append. Import from Claude Code via /mem import. " +
      "Never put secrets in memory — the text reaches the model provider.",
    promptSnippet: "Read and update the current project's cross-session memory",
    promptGuidelines: [
      "Use memory (action:'list') to list the current cwd's memory files.",
      "Project memory is also auto-injected into your context each turn (## Memory block).",
      "Use memory action:'write'|'append' to persist durable project facts (decisions, gotchas, conventions). Prefer append to grow an existing topic file; keep files focused and small.",
      "Add frontmatter `pin: true` to a memory file to keep it in the auto-injected inline zone.",
      "Agent-written files are marked `source: agent` and shown with a data-not-instructions fence; user-edited files carry no fence.",
    ],
    parameters: MemoryToolParams,
    async execute(_toolCallId, params: MemoryToolParams, _signal, _onUpdate, ctx): Promise<ToolTextResult> {
      const action = params.action ?? "list";
      const cwd = resolveCwd(ctx);
      if (action === "list") {
        const files = listMemory(cwd, deps.paths);
        if (files.length === 0) {
          return text(`No memory for ${cwd} yet. Add *.md to ${memoryDirFor(cwd, deps.paths)}/ or run /mem import.`);
        }
        const out = files
          .map((f) => `${f.name} (${f.size}B, ${new Date(f.mtimeMs).toISOString().slice(0, 10)})`)
          .join("\n");
        return text(`Memory for ${cwd} (${toSlug(cwd)}):\n${out}`);
      }
      // write / append
      // B1: child sessions are read-only by default. The tool throws the
      // actionable message itself; writeMemoryFile's allowWrite gate stays as
      // the structural backstop for any future second caller (R7).
      if (deps.isChildSession && !settings.allowWriteInChildSessions) {
        throw new Error(
          "child sessions are read-only for memory by default; enable memory.allowWriteInChildSessions to allow writes",
        );
      }
      const name = params.name;
      if (!name) throw new Error(`memory action '${action}' requires 'name' (e.g. "decisions.md")`);
      const content = params.content;
      if (content === undefined) throw new Error(`memory action '${action}' requires 'content'`);
      const result = writeMemoryFile(
        cwd,
        name,
        content,
        {
          append: action === "append",
          allowWrite: true,
          maxWriteBytes: settings.maxWriteBytes,
          maxFileBytes: settings.maxFileBytes,
        },
        deps.paths,
      );
      deps.onAfterWrite(cwd);
      // B1 user-visible signal: rpc/headless sessions (hasUI=false) stay silent.
      if (ctx?.hasUI) {
        ctx.ui.notify(`memory ${action}: ${name} (+${result.bytesWritten}B → ${result.path})`, "info");
      }
      return text(`memory ${action}: ${name} (+${result.bytesWritten}B, total ${result.totalBytes}B → ${result.path})`);
    },
  };
}
