/**
 * 模型目录磁盘缓存（external-agent plan §4.7 存储侧）。同步、原子写（tmp + rename）、0600/0700、≤256KiB；
 * 读到损坏/超限/形状不符 ⇒ undefined；写失败静默（每个 store 只 warn 一次）。pi-free。
 */
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { catalogCachePath } from "./paths.js";
import type { CatalogStore, ExternalCatalog, ExternalModelInfo } from "./types.js";

export const CATALOG_MAX_BYTES = 256 * 1024;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

const optStr = (v: unknown): boolean => v === undefined || typeof v === "string";

function validModel(m: unknown): m is ExternalModelInfo {
  if (m === null || typeof m !== "object") return false;
  const r = m as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.deprecated === "boolean" &&
    Array.isArray(r.reasoningEfforts) &&
    r.reasoningEfforts.every((e) => typeof e === "string") &&
    optStr(r.displayName) &&
    optStr(r.upstreamProvider) &&
    optStr(r.kind) &&
    optStr(r.defaultEffort) &&
    (r.tokenMultiplier === undefined || typeof r.tokenMultiplier === "number")
  );
}

function validCatalog(c: unknown, provider: string): c is ExternalCatalog {
  if (c === null || typeof c !== "object") return false;
  const r = c as Record<string, unknown>;
  if (r.provider !== provider || typeof r.fetchedAt !== "number" || !Number.isFinite(r.fetchedAt)) return false;
  if (!optStr(r.agentVersion) || !optStr(r.protocolVersion) || !optStr(r.binaryFingerprint)) return false;
  if (!Array.isArray(r.models) || !r.models.every(validModel)) return false;
  if (r.drift !== undefined) {
    const d = r.drift as Record<string, unknown> | null;
    if (d === null || typeof d !== "object" || typeof d.expected !== "string" || typeof d.actual !== "string")
      return false;
  }
  return true;
}

export function createCatalogStore(agentDir: string): CatalogStore {
  let warned = false;
  const warn = (why: string): void => {
    if (warned) return;
    warned = true;
    console.warn(`[pi-subagent] external-agent catalog cache write failed: ${why}`);
  };
  return {
    read(provider) {
      let fd: number | undefined;
      try {
        fd = openSync(catalogCachePath(agentDir, provider), constants.O_RDONLY | O_NOFOLLOW);
        const st = fstatSync(fd);
        if (!st.isFile() || st.size > CATALOG_MAX_BYTES) return undefined;
        const buf = Buffer.alloc(st.size);
        let off = 0;
        while (off < st.size) {
          const n = readSync(fd, buf, off, st.size - off, off);
          if (n <= 0) break;
          off += n;
        }
        const parsed: unknown = JSON.parse(buf.toString("utf8", 0, off));
        return validCatalog(parsed, provider) ? parsed : undefined;
      } catch {
        return undefined;
      } finally {
        if (fd !== undefined) {
          try {
            closeSync(fd);
          } catch {
            /* ignore */
          }
        }
      }
    },
    write(catalog) {
      const path = catalogCachePath(agentDir, catalog.provider);
      const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      let fd: number | undefined;
      try {
        const data = Buffer.from(JSON.stringify(catalog), "utf8");
        if (data.length > CATALOG_MAX_BYTES) {
          warn(`catalog exceeds ${CATALOG_MAX_BYTES} bytes`);
          return;
        }
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
        writeSync(fd, data, 0, data.length);
        closeSync(fd);
        fd = undefined;
        renameSync(tmp, path);
      } catch (e) {
        warn(e instanceof Error ? e.message : String(e));
        if (fd !== undefined) {
          try {
            closeSync(fd);
          } catch {
            /* ignore */
          }
        }
        try {
          unlinkSync(tmp);
        } catch {
          /* ignore */
        }
      }
    },
  };
}
