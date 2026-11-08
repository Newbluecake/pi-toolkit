/** Context-free, non-mutating subset of the Web /mem command surface.
 * This executor does not authenticate callers; the host seam must do that before calling it.
 */
import { join } from "node:path";
import { resolveWorktreeOrigin } from "../core/worktree-origin.js";
import { snapshotMigrationSources } from "./blocks/migrate.js";
import { planMigration } from "./blocks/migrate-plan.js";
import { readIndex } from "./jev/index-store.js";
import { canonicalDir, readRegular } from "./safe-fs.js";
import { listBackups, listTrashEntries } from "./tidy/manifest.js";
import { classifyMemoryCommand } from "./command-policy.js";
import { memoryDirFor, type MemoryPaths } from "./paths.js";
import { formatSize } from "./render.js";
import { listMemory } from "./store.js";

export type MemoryReadResult =
  | { readonly ok: true; readonly output: string }
  | { readonly ok: false; readonly code: "E_MEM_WEB_UNSUPPORTED"; readonly message: string };

/** The cwd and optional paths must come from the host, never model-supplied input. */
export function executeMemoryRead(rawArgs: string, cwd: string, paths?: MemoryPaths): MemoryReadResult {
  const args = rawArgs.trim();
  if (classifyMemoryCommand(rawArgs) !== "read") {
    return { ok: false, code: "E_MEM_WEB_UNSUPPORTED", message: "该命令暂不支持 Web 通道" };
  }
  const resolved = resolveWorktreeOrigin(cwd) ?? cwd;
  const dir = memoryDirFor(resolved, paths);
  if (args === "restore" || args === "restore --legacy" || args === "restore --trash") {
    const canon = canonicalDir(dir);
    if (!canon) return { ok: true, output: `no memory directory for ${resolved}` };
    const trash = listTrashEntries(canon.real);
    if (args === "restore --trash")
      return {
        ok: true,
        output: trash.length ? trash.map((e) => `  ${e.id} — ${e.name}`).join("\n") : "trash is empty",
      };
    const backups = listBackups(canon.real);
    const lines = [
      ...backups.map((b) => {
        let legacy = false;
        try {
          legacy =
            (JSON.parse(readRegular(join(canon.real, ".backup", b.id), "manifest.json").text) as { v?: unknown }).v ===
            1;
        } catch {
          /* invalid manifests are omitted or reported elsewhere */
        }
        return `  ${b.id} — ${b.kind} · ${String(b.fileCount)} file(s) · ${b.createdAt}${legacy ? " · legacy (no sha) — restore requires --legacy" : ""}`;
      }),
      ...trash.map((t) => `  (trash) ${t.id} — ${t.name}`),
    ];
    return { ok: true, output: lines.length ? lines.join("\n") : "no backups or trash entries" };
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
