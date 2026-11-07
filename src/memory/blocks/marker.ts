import { readRegular, statRegularIfExists } from "../safe-fs.js";
export interface BlocksMarkerV1 {
  v: 1;
  migratedAt?: string;
  runId?: string;
  source?: "migrate" | "fresh";
  gen?: number;
  files?: readonly { path: string; sha256: string; size: number }[];
}
export function readMarker(realDir: string): BlocksMarkerV1 | undefined {
  try {
    if (!statRegularIfExists(realDir, ".layout.json")) return undefined;
    const p = JSON.parse(readRegular(realDir, ".layout.json").text) as BlocksMarkerV1;
    if (p.v !== 1) return { v: 1 };
    return {
      v: 1,
      ...(typeof p.migratedAt === "string" ? { migratedAt: p.migratedAt } : {}),
      ...(typeof p.runId === "string" ? { runId: p.runId } : {}),
      ...(p.source === "migrate" || p.source === "fresh" ? { source: p.source } : {}),
      ...(Number.isSafeInteger(p.gen) && p.gen! >= 0 ? { gen: p.gen! } : {}),
      ...(Array.isArray(p.files) &&
      p.files.every(
        (f) =>
          typeof f.path === "string" &&
          !f.path.startsWith("/") &&
          !f.path.split("/").some((s: string) => s === ".." || s === "" || s === ".") &&
          /^[a-f0-9]{64}$/.test(f.sha256) &&
          Number.isSafeInteger(f.size) &&
          f.size >= 0,
      )
        ? { files: p.files }
        : {}),
    };
  } catch {
    return { v: 1 };
  }
}
