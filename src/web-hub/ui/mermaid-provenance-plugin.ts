/**
 * Rollup/Vite plugin: mermaid provenance (web-hub-mermaid plan §7.2, r3 R2-2/R2-7/R2-8).
 *
 * Computes — from the module graph, at `buildEnd` — the set `E` of modules that ONLY the lazily
 * imported `components/shared/mermaid-impl.ts` can reach (`E = M \ A`: `M` = reachable from the impl,
 * `A` = reachable from the real entries WITHOUT passing through the impl). Then:
 *
 *  - names a chunk `assets/mmd-[name]-[hash].js` iff every module it carries is in `E` (and `assets/…`
 *    otherwise); a chunk mixing `E` and non-`E` modules FAILS the build (mixed chunk);
 *  - prepends the EPL notice banner to the chunk carrying `elkjs/lib/elk.bundled.js` in `renderChunk`
 *    (post) — i.e. BEFORE Rollup computes the content hash — and also feeds it to `augmentChunkHash`, so
 *    a banner-only change always renames the file (R2-8);
 *  - at `closeBundle` (after Vite copied `public/`), writes a provenance sidecar that enumerates EVERY
 *    `.js` file on disk with its sha256 (R2-2: `public/theme-init.js` is recorded as non-exclusive,
 *    never skipped), whether it is mermaid-exclusive / carries the impl / carries ELK, and the
 *    `node_modules` packages whose modules were actually rendered into it; plus the list of bundled-in
 *    third-party components that pre-bundled outer packages (mermaid, @mermaid-js/parser, …) embed
 *    (detected from the `// …node_modules/.pnpm/<name>@<ver>/…` path comments their dist files carry).
 *
 * `check:web` (scripts/web-hub/check-ui-dist.ts + lib/ui-provenance.ts) consumes the sidecar.
 * Nothing here runs at runtime in the browser or the hub.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { OutputBundle, OutputChunk, PreRenderedChunk } from "rollup";
import type { Plugin } from "vite";

/* ------------------------------------------------------------------------------ data shapes */

export interface ProvenancePackage {
  name: string;
  version: string;
  license: string | null;
  /** Package directory from the first `node_modules/` segment on (repo-root relative, `/`-separated). */
  dir: string;
}

export interface ProvenanceChunk {
  sha256: string;
  mermaidExclusive: boolean;
  containsImpl: boolean;
  containsElk: boolean;
  packages: ProvenancePackage[];
}

/** One outer-package artifact file that embeds third-party components (detected, not declared). */
export interface ProvenanceEmbedded {
  /** Path relative to the outer package directory, `/`-separated. */
  file: string;
  /** sha256 of the artifact file as it sits in node_modules. */
  sha256: string;
  /** `name@version` (or `name@?` when the comment carried no version). */
  components: string[];
}

export interface UiProvenance {
  v: 1;
  /** False when the build never reaches `mermaid-impl.ts` (e.g. the production build before the UI wires it). */
  implInGraph: boolean;
  chunks: Record<string, ProvenanceChunk>;
  /** Outer `name@version` → embedded-component artifacts. */
  embedded: Record<string, ProvenanceEmbedded[]>;
}

/* --------------------------------------------------------------------------- pure graph logic */

export interface ModuleNode {
  importedIds: readonly string[];
  dynamicallyImportedIds: readonly string[];
  isEntry?: boolean;
}
export type ModuleLookup = (id: string) => ModuleNode | null | undefined;

/** Modules reachable from `starts` over static AND dynamic edges, never entering `stopAt`. */
export function reachableModules(lookup: ModuleLookup, starts: Iterable<string>, stopAt?: string): Set<string> {
  const seen = new Set<string>();
  const stack = [...starts];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id) || id === stopAt) continue;
    seen.add(id);
    const node = lookup(id);
    if (!node) continue;
    stack.push(...node.importedIds, ...node.dynamicallyImportedIds);
  }
  return seen;
}

export interface ExclusiveSets {
  /** `M`: everything the impl can reach (including the impl). */
  mermaid: Set<string>;
  /** `A`: everything the entries reach without passing through the impl. */
  app: Set<string>;
  /** `E = M \ A`. */
  exclusive: Set<string>;
}

export function computeExclusiveSets(lookup: ModuleLookup, allIds: readonly string[], implId: string): ExclusiveSets {
  const entries = allIds.filter((id) => lookup(id)?.isEntry === true);
  const mermaid = reachableModules(lookup, [implId]);
  const app = reachableModules(lookup, entries, implId);
  const exclusive = new Set([...mermaid].filter((id) => !app.has(id)));
  return { mermaid, app, exclusive };
}

export const MMD_CHUNK_PATTERN = "assets/mmd-[name]-[hash].js";
export const PLAIN_CHUNK_PATTERN = "assets/[name]-[hash].js";

/** `mmd-` iff the chunk is non-empty and EVERY module id is mermaid-exclusive. */
export function chunkFileNamePattern(moduleIds: readonly string[], exclusive: ReadonlySet<string>): string {
  return moduleIds.length > 0 && moduleIds.every((id) => exclusive.has(id)) ? MMD_CHUNK_PATTERN : PLAIN_CHUNK_PATTERN;
}

export interface ChunkClassification {
  exclusive: boolean;
  mixed: boolean;
  /** A few non-exclusive offenders when mixed (for the build error). */
  offenders: string[];
}

/** Classify a chunk by its modules with `renderedLength > 0` (tree-shaken-away modules don't count). */
export function classifyChunkModules(
  renderedModuleIds: readonly string[],
  exclusive: ReadonlySet<string>,
): ChunkClassification {
  const inE = renderedModuleIds.filter((id) => exclusive.has(id));
  const notE = renderedModuleIds.filter((id) => !exclusive.has(id));
  return {
    exclusive: inE.length > 0 && notE.length === 0,
    mixed: inE.length > 0 && notE.length > 0,
    offenders: notE.slice(0, 3),
  };
}

/* ---------------------------------------------------------------------------- package helpers */

const NODE_MODULES_SEG = `${sep}node_modules${sep}`;

/** Package directory + name of a module id living in node_modules; `null` for first-party / virtual ids. */
export function packageDirOfModuleId(id: string): { name: string; dir: string } | null {
  const clean = id.split("?")[0] ?? id;
  if (clean.startsWith("\0")) return null;
  const idx = clean.lastIndexOf(NODE_MODULES_SEG);
  if (idx < 0) return null;
  const rest = clean.slice(idx + NODE_MODULES_SEG.length).split(sep);
  const first = rest[0];
  if (first === undefined || first === "") return null;
  if (first.startsWith("@")) {
    const second = rest[1];
    if (second === undefined) return null;
    return { name: `${first}/${second}`, dir: join(clean.slice(0, idx + NODE_MODULES_SEG.length), first, second) };
  }
  return { name: first, dir: join(clean.slice(0, idx + NODE_MODULES_SEG.length), first) };
}

/** `/abs/repo/node_modules/a/node_modules/b` → `node_modules/a/node_modules/b`. */
export function repoRelativePackageDir(dir: string): string {
  const idx = dir.indexOf(`node_modules${sep}`);
  return (idx < 0 ? dir : dir.slice(idx)).split(sep).join("/");
}

export function normalizeLicense(raw: unknown): string | null {
  if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  if (raw !== null && typeof raw === "object" && typeof (raw as { type?: unknown }).type === "string") {
    return (raw as { type: string }).type;
  }
  return null;
}

function licenseOfPackageJson(pkg: Record<string, unknown>): string | null {
  const direct = normalizeLicense(pkg["license"]);
  if (direct !== null) return direct;
  const list = pkg["licenses"];
  if (Array.isArray(list) && list.length > 0) {
    const types = list.map((l) => normalizeLicense(l)).filter((t): t is string => t !== null);
    if (types.length > 0) return types.length === 1 ? types[0]! : `(${types.join(" OR ")})`;
  }
  return null;
}

/** `// ../../node_modules/.pnpm/<name>@<ver>[_peer…]/node_modules/<name>/…` path comments → `name@ver`. */
export function embeddedComponentsOf(code: string): string[] {
  const out = new Set<string>();
  // pnpm writes a scoped package's directory as `@scope+name@ver…` (the `+` stands for the scope's `/`).
  for (const m of code.matchAll(
    /node_modules\/\.pnpm\/((?:@[^/@+\s]+\+)?[^/@+\s]+)@([^/_\s]+)[^/\s]*\/node_modules\//g,
  )) {
    out.add(`${m[1]!.replace("+", "/")}@${m[2]}`);
  }
  // npm/yarn-flat comment form (no version in the path): flagged with `?` so it can never match a pin.
  for (const m of code.matchAll(/^\/\/ (?:\.\.\/)+node_modules\/(?!\.pnpm\/)((?:@[^/\s]+\/)?[^/\s]+)\//gm)) {
    out.add(`${m[1]}@?`);
  }
  return [...out].sort();
}

/* ---------------------------------------------------------------------------------- the banner */

export const ELK_MODULE_RE = /[\\/]node_modules[\\/]elkjs[\\/]lib[\\/]elk\.bundled\.js$/;

export function elkBanner(version: string): string {
  return (
    `/*! Contains elkjs ${version} — SPDX-License-Identifier: EPL-2.0 — Copyright (c) 2017, 2021 Kiel University and others; ` +
    `includes web-worker, Copyright 2020 Google LLC (Apache-2.0). Unmodified, minified. ` +
    `Source: https://github.com/kieler/elkjs (tag ${version}). ` +
    `Full notices and license texts: THIRD_PARTY_NOTICES.md shipped with pi-toolkit. */\n`
  );
}

/* ------------------------------------------------------------------------------- the plugin */

export interface MermaidProvenanceOptions {
  /** Absolute path of the sidecar JSON to write. */
  outFile: string;
  /** Suffix identifying the impl module id; default `components/shared/mermaid-impl.ts`. */
  implSuffix?: string;
  /** Override the banner text (tests only: proves a banner-only change renames the chunk). */
  bannerOverride?: string;
}

export interface MermaidProvenancePlugin extends Plugin {
  /** Wire into `build.rollupOptions.output.chunkFileNames`. */
  chunkFileNames: (chunk: PreRenderedChunk) => string;
}

const DEFAULT_IMPL_SUFFIX = `components${sep}shared${sep}mermaid-impl.ts`;

async function walkJs(dir: string, base: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkJs(abs, base)));
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(relative(base, abs).split(sep).join("/"));
  }
  return out.sort();
}

export function mermaidProvenancePlugin(options: MermaidProvenanceOptions): MermaidProvenancePlugin {
  const implSuffix = options.implSuffix ?? DEFAULT_IMPL_SUFFIX;
  let exclusive = new Set<string>();
  let implId: string | null = null;
  let outDir = "";
  let elkVersion = "unknown";
  const embeddedByModule = new Map<string, { pkgKey: string; file: string; components: string[] }>();
  const pkgCache = new Map<string, ProvenancePackage | null>();
  const chunkMeta = new Map<
    string,
    {
      exclusive: boolean;
      containsImpl: boolean;
      containsElk: boolean;
      packages: ProvenancePackage[];
      moduleIds: string[];
    }
  >();

  const banner = (): string => options.bannerOverride ?? elkBanner(elkVersion);

  async function packageInfo(id: string): Promise<ProvenancePackage | null> {
    const loc = packageDirOfModuleId(id);
    if (!loc) return null;
    const hit = pkgCache.get(loc.dir);
    if (hit !== undefined) return hit;
    let info: ProvenancePackage | null = null;
    try {
      const pkg = JSON.parse(await readFile(join(loc.dir, "package.json"), "utf8")) as Record<string, unknown>;
      info = {
        name: loc.name,
        version: typeof pkg["version"] === "string" ? pkg["version"] : "0.0.0",
        license: licenseOfPackageJson(pkg),
        dir: repoRelativePackageDir(loc.dir),
      };
    } catch {
      info = { name: loc.name, version: "unknown", license: null, dir: repoRelativePackageDir(loc.dir) };
    }
    pkgCache.set(loc.dir, info);
    return info;
  }

  const plugin: MermaidProvenancePlugin = {
    name: "pwh:mermaid-provenance",
    apply: "build",
    chunkFileNames(chunk) {
      return chunkFileNamePattern(chunk.moduleIds, exclusive);
    },
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    async buildEnd(err) {
      if (err) return;
      const ids = [...this.getModuleIds()];
      implId = ids.find((id) => id.endsWith(implSuffix)) ?? null;
      if (implId === null) {
        exclusive = new Set();
      } else {
        const lookup: ModuleLookup = (id) => this.getModuleInfo(id);
        exclusive = computeExclusiveSets(lookup, ids, implId).exclusive;
      }
      const elkId = ids.find((id) => ELK_MODULE_RE.test(id));
      if (elkId) {
        const info = await packageInfo(elkId);
        if (info) elkVersion = info.version;
      }
      embeddedByModule.clear();
      for (const id of ids) {
        const loc = packageDirOfModuleId(id);
        if (!loc) continue;
        const code = this.getModuleInfo(id)?.code;
        if (typeof code !== "string" || !code.includes("node_modules/")) continue;
        const components = embeddedComponentsOf(code);
        if (components.length === 0) continue;
        const info = await packageInfo(id);
        if (!info) continue;
        const clean = id.split("?")[0] ?? id;
        embeddedByModule.set(id, {
          pkgKey: `${info.name}@${info.version}`,
          file: relative(loc.dir, clean).split(sep).join("/"),
          components,
        });
      }
    },
    renderChunk: {
      order: "post",
      handler(code, chunk) {
        if (!chunk.moduleIds.some((id) => ELK_MODULE_RE.test(id))) return null;
        return { code: banner() + code, map: null };
      },
    },
    augmentChunkHash(chunk) {
      return chunk.moduleIds.some((id) => ELK_MODULE_RE.test(id)) ? banner() : undefined;
    },
    async generateBundle(_o, bundle: OutputBundle) {
      chunkMeta.clear();
      for (const [fileName, item] of Object.entries(bundle)) {
        if (item.type !== "chunk") continue;
        const chunk = item as OutputChunk;
        const rendered = Object.entries(chunk.modules)
          .filter(([, m]) => m.renderedLength > 0)
          .map(([id]) => id);
        const cls = classifyChunkModules(rendered, exclusive);
        if (cls.mixed) {
          this.error(
            `mermaid provenance: mixed chunk ${fileName} carries mermaid-exclusive and shared modules ` +
              `(e.g. ${cls.offenders.join(", ")}) — fix the import graph so mermaid code never shares a chunk with app code`,
          );
        }
        const pkgs = new Map<string, ProvenancePackage>();
        for (const id of rendered) {
          const p = await packageInfo(id);
          if (p) pkgs.set(`${p.name}@${p.version}`, p);
        }
        chunkMeta.set(fileName, {
          exclusive: cls.exclusive,
          containsImpl: implId !== null && rendered.includes(implId),
          containsElk: rendered.some((id) => ELK_MODULE_RE.test(id)),
          packages: [...pkgs.values()].sort((a, b) => (a.name + a.version).localeCompare(b.name + b.version)),
          moduleIds: rendered,
        });
      }
    },
    closeBundle: {
      order: "post",
      async handler() {
        if (outDir === "") return;
        const files = await walkJs(outDir, outDir);
        const chunks: Record<string, ProvenanceChunk> = {};
        const rendered = new Set<string>();
        for (const rel of files) {
          const sha256 = createHash("sha256")
            .update(await readFile(join(outDir, rel)))
            .digest("hex");
          const meta = chunkMeta.get(rel);
          if (meta) for (const id of meta.moduleIds) rendered.add(id);
          chunks[rel] = {
            sha256,
            mermaidExclusive: meta?.exclusive ?? false,
            containsImpl: meta?.containsImpl ?? false,
            containsElk: meta?.containsElk ?? false,
            packages: meta?.packages ?? [],
          };
        }
        const embedded: Record<string, ProvenanceEmbedded[]> = {};
        for (const [id, e] of embeddedByModule) {
          if (!rendered.has(id)) continue;
          const sha256 = createHash("sha256")
            .update(await readFile(id.split("?")[0] ?? id))
            .digest("hex");
          (embedded[e.pkgKey] ??= []).push({ file: e.file, sha256, components: e.components });
        }
        for (const list of Object.values(embedded)) list.sort((a, b) => a.file.localeCompare(b.file));
        const prov: UiProvenance = { v: 1, implInGraph: implId !== null, chunks, embedded };
        await mkdir(dirname(options.outFile), { recursive: true });
        await writeFile(options.outFile, `${JSON.stringify(prov, null, 1)}\n`, "utf8");
      },
    },
  };
  return plugin;
}
