/**
 * Vite plugin: write `dist/web-hub-ui/build-info.json` (vue-plan.md v2.1 §1.2, §5.2 — P0
 * frozen). Runs as `closeBundle` with `enforce: "post"` so it fires after the `public/`
 * directory copy Vite itself performs (favicon/theme-init also need to be in the manifest).
 *
 * Walks `outDir` (sorted, deterministic), rejecting anything that isn't a regular file (a
 * symlink anywhere under the build output makes the build fail outright — a build artifact
 * must never let hub-side `verifyUiRoot` (P5a) trust a symlink it didn't create itself), hashes
 * every file with SHA-256, and writes the manifest `ui-manifest.ts`'s `parseUiBuildInfo` accepts.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { PROTO } from "../protocol/version.js";
import { isAllowedUiPath, type UiBuildInfo, type UiManifestFile } from "../protocol/ui-manifest.js";

/** `src/web-hub/ui/` → repo root. */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const GIT_TIMEOUT_MS = 2_000;
const BUILD_INFO_FILE = "build-info.json";

export async function readPackageVersion(): Promise<string> {
  const raw = await readFile(join(REPO_ROOT, "package.json"), "utf8");
  const pkg = JSON.parse(raw) as { version?: unknown };
  return typeof pkg.version === "string" ? pkg.version : "0.0.0";
}

/** `git rev-parse HEAD` (short) + dirty suffix; `"unknown"` outside git, on error, or on timeout. */
export async function resolveCommit(): Promise<string> {
  const head = await runGit(["rev-parse", "HEAD"]);
  if (head === undefined) return "unknown";
  const short = head.trim().slice(0, 12);
  if (!/^[0-9a-f]{12}$/.test(short)) return "unknown";
  const dirty = await runGit(["status", "--porcelain"]);
  return dirty !== undefined && dirty.trim() !== "" ? `${short}-dirty` : short;
}

function runGit(args: string[]): Promise<string | undefined> {
  return new Promise((resolveP) => {
    const child = execFile("git", args, { cwd: REPO_ROOT, timeout: GIT_TIMEOUT_MS }, (err, stdout) => {
      resolveP(err ? undefined : stdout);
    });
    child.on("error", () => resolveP(undefined));
  });
}

function builtAtNow(): string {
  const epoch = process.env["SOURCE_DATE_EPOCH"];
  if (epoch !== undefined && epoch !== "") {
    const n = Number(epoch);
    if (Number.isFinite(n)) return new Date(n * 1000).toISOString();
  }
  return new Date().toISOString();
}

/** Recursively list every regular file under `dir`, throwing on symlinks or other special files. */
async function walkFiles(dir: string, base: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`build-info-plugin: refusing to publish a symlink in the UI dist: ${relative(base, abs)}`);
    }
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(abs, base)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`build-info-plugin: unexpected non-regular file in the UI dist: ${relative(base, abs)}`);
    }
    out.push(abs);
  }
  return out;
}

async function hashFile(path: string): Promise<UiManifestFile> {
  const buf = await readFile(path);
  const bytes = (await stat(path)).size;
  const sha256 = createHash("sha256").update(buf).digest("hex");
  return { path, bytes, sha256 };
}

export function buildInfoPlugin(): Plugin {
  let outDir = "";
  return {
    name: "pwh:build-info",
    enforce: "post",
    apply: "build",
    configResolved(config) {
      outDir = resolvePath(config.root, config.build.outDir);
    },
    async closeBundle() {
      const absFiles = await walkFiles(outDir, outDir);
      const files: UiManifestFile[] = [];
      for (const abs of absFiles) {
        const rel = relative(outDir, abs).split("\\").join("/");
        if (rel === BUILD_INFO_FILE) continue; // never hash-self-reference
        if (!isAllowedUiPath(rel)) {
          throw new Error(`build-info-plugin: unexpected output file not on the path whitelist: ${rel}`);
        }
        const hashed = await hashFile(abs);
        files.push({ ...hashed, path: rel });
      }
      files.sort((a, b) => a.path.localeCompare(b.path));
      const info: UiBuildInfo = {
        v: 1,
        version: await readPackageVersion(),
        proto: { major: PROTO.major },
        builtAt: builtAtNow(),
        commit: await resolveCommit(),
        files,
      };
      await writeFile(join(outDir, BUILD_INFO_FILE), `${JSON.stringify(info, null, 2)}\n`, "utf8");
    },
  };
}
