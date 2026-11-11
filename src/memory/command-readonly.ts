/** Context-free, non-mutating subset of the Web /mem command surface.
 * This executor does not authenticate callers; the host seam must do that before calling it.
 */
import { join } from "node:path";
import { resolveWorktreeOrigin } from "../core/worktree-origin.js";
import { snapshotMigrationSources } from "./blocks/migrate.js";
import { planMigration } from "./blocks/migrate-plan.js";
import { readIndex } from "./jev/index-store.js";
import { canonicalDir, readRegular } from "./safe-fs.js";
import { classifyMemoryCommand } from "./command-policy.js";
import { memoryDirFor, type MemoryPaths } from "./paths.js";
import { formatSize } from "./render.js";
import { listMemory } from "./store.js";
import { dirFormat } from "./blocks/naming.js";
import { listTrashEntries, LEGACY_BACKUP_REFUSAL } from "./trash.js";
import type { MemorySettings } from "./settings.js";

export type MemoryReadResult =
  | { readonly ok: true; readonly output: string }
  | { readonly ok: false; readonly code: "E_MEM_WEB_UNSUPPORTED"; readonly message: string };

/** The cwd and optional paths must come from the host, never model-supplied input. */
export function executeMemoryRead(
  rawArgs: string,
  cwd: string,
  paths?: MemoryPaths,
  _settings?: MemorySettings,
): MemoryReadResult {
  const args = rawArgs.trim();
  const [head, mode] = args.split(/\s+/);
  if (head === "restore" && args.split(/\s+/).includes("--revision"))
    return {
      ok: false,
      code: "E_MEM_WEB_UNSUPPORTED",
      message: "restore --revision 仅支持当前原生 TUI 主会话的一次精确确认；Web 不支持 revision 恢复。",
    };
  // Recognize only the retired backup surface to give actionable errors; this
  // does not grant a read exemption or execute native restore on the Web path.
  if (head === "restore" && mode !== "--trash" && mode !== "--block")
    return { ok: false, code: "E_MEM_WEB_UNSUPPORTED", message: LEGACY_BACKUP_REFUSAL };
  if (classifyMemoryCommand(rawArgs) !== "read") {
    return { ok: false, code: "E_MEM_WEB_UNSUPPORTED", message: "该命令暂不支持 Web 通道" };
  }
  const resolved = resolveWorktreeOrigin(cwd) ?? cwd;
  const dir = memoryDirFor(resolved, paths);
  if (args === "restore --trash") {
    // Deliberately ignore retired .backup manifests, journals and root archive/.
    const canon = canonicalDir(dir);
    if (!canon) return { ok: true, output: `no memory directory for ${resolved}` };
    const trash = listTrashEntries(dirFormat(canon.real) === "blocks" ? join(canon.real, "blocks") : canon.real);
    return { ok: true, output: trash.length ? trash.map((e) => `  ${e.id} — ${e.name}`).join("\n") : "trash is empty" };
  }
  if (args === "migrate --dry-run") {
    const canon = canonicalDir(dir);
    if (!canon) return { ok: false, code: "E_MEM_WEB_UNSUPPORTED", message: "该命令暂不支持 Web 通道" };
    return {
      ok: true,
      output: JSON.stringify(
        planMigration(
          snapshotMigrationSources(canon.real),
          readIndex(canon.real).index,
          new Date().toISOString().slice(0, 10),
        ).report,
        null,
        2,
      ),
    };
  }
  if (args === "migrate --report") {
    const canon = canonicalDir(dir);
    if (!canon) return { ok: false, code: "E_MEM_WEB_UNSUPPORTED", message: "该命令暂不支持 Web 通道" };
    return { ok: true, output: readRegular(join(canon.real, "blocks"), ".migration-report.json").text };
  }
  if (!["", "list", "path"].includes(args))
    return { ok: false, code: "E_MEM_WEB_UNSUPPORTED", message: "该命令暂不支持 Web 通道" };
  if (args === "path") return { ok: true, output: `memory dir: ${memoryDirFor(resolved, paths)}` };
  const files = listMemory(resolved, paths);
  return {
    ok: true,
    output: files.length
      ? files.map((file) => `  ${file.name} (${formatSize(file.size)})`).join("\n")
      : `(no memory for ${resolved}${args === "" ? " — run /mem import to bring in Claude Code memory" : ""})`,
  };
}
