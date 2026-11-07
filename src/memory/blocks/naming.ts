import { join } from "node:path";
import { canonicalDir, inspectDirNoFollow, isV2Name, statRegularIfExists } from "../safe-fs.js";
import { MemoryError } from "../paths.js";
import type { MemorySettings } from "../settings.js";
export const BLOCK_NAME_RE = /^[a-z0-9][a-z0-9-]{0,47}\.[0-9]{3,6}\.md$/;
export const ARCHIVE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,47}\.[0-9]{3,6}(?:\.r[1-9][0-9]{0,2})?\.md$/;
export function parseBlockName(name: string): { topic: string; seq: number } | undefined {
  if (!BLOCK_NAME_RE.test(name)) return undefined;
  const [topic, seq] = name.split(".");
  return { topic: topic!, seq: Number(seq) };
}
export function parseArchiveName(name: string): { topic: string; seq: number; r?: number } | undefined {
  if (!ARCHIVE_NAME_RE.test(name)) return undefined;
  const [topic, seq, revision] = name.split(".");
  return { topic: topic!, seq: Number(seq), ...(revision?.startsWith("r") ? { r: Number(revision.slice(1)) } : {}) };
}
export function canonicalTopic(stem: string): string | undefined {
  const topic = stem
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return topic || undefined;
}
export function nextSeq(topic: string, used: Iterable<string>): number {
  let max = 0;
  for (const name of used) {
    // Trash has a newTidyId prefix; names from all three namespaces participate.
    const candidate = name.replace(/^\d{8}T\d{9}Z-\d+-[0-9a-f]{6}-/, "");
    const parsed = parseArchiveName(candidate);
    if (parsed?.topic === topic) max = Math.max(max, parsed.seq);
  }
  if (max >= 999999) throw new Error("E_SEQ_EXHAUSTED");
  return max + 1;
}
export type DirFormat = "blocks" | "files" | "absent" | "held";
export type EffectiveLayout = "blocks" | "tiered" | "legacy";
export function dirFormat(memDir: string, diag: (message: string) => void = () => {}): DirFormat {
  try {
    // Names also detect malformed/symlink holds, which must fail closed.
    const canonical = canonicalDir(memDir);
    const path = canonical?.real ?? memDir;
    try {
      if (statRegularIfExists(path, ".blocks-hold")) return "held";
    } catch (err) {
      if (err instanceof MemoryError) return "held";
      throw err;
    }
    let parent;
    try {
      parent = inspectDirNoFollow(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "absent";
      throw err;
    }
    if (parent.names.includes("blocks")) {
      const st = inspectDirNoFollow(join(path, "blocks"));
      if (st.dev !== parent.dev) throw new Error("blocks/ is on another device");
      if (statRegularIfExists(join(path, "blocks"), ".layout.json")) return "blocks";
    }
    return parent.names.some(isV2Name) ? "files" : "absent";
  } catch (err) {
    diag(`memory: layout check failed: ${String(err)}`);
    return "files";
  }
}
export function effectiveLayout(settingsLayout: EffectiveLayout, format: DirFormat): EffectiveLayout {
  if (format === "blocks") return "blocks";
  return settingsLayout === "blocks" && format !== "absent" ? "tiered" : settingsLayout;
}
export function toolSurfaceFor(
  settings: MemorySettings,
  format: DirFormat,
  secureLocked = false,
): "v3" | "v2" | "legacy" {
  if (
    settings.layout === "blocks" &&
    (format === "blocks" || format === "absent" || (format === "files" && settings.migrate.auto && !secureLocked))
  )
    return "v3";
  return settings.toolSurface;
}
