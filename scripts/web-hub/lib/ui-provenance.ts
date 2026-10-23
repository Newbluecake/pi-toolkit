/**
 * Pure verification helpers behind `check:web`'s mermaid / provenance / licence gates
 * (web-hub-mermaid plan §7.3, §8.4, r3 R2-2/R2-7/R2-8). Everything here is I/O-free except
 * `readPackageLicenseFiles`, so the synthetic-bundle tests (tests/web-hub/check-ui-dist-provenance.test.ts)
 * can exercise every rejection without running a build.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { UiProvenance } from "../../../src/web-hub/ui/mermaid-provenance-plugin.js";

export type { UiProvenance } from "../../../src/web-hub/ui/mermaid-provenance-plugin.js";

/** gzip budget for the mermaid-exclusive closure (measured ≈1.41 MB). */
export const MERMAID_JS_BUDGET_GZIP_BYTES = 2 * 1024 * 1024;

/** Chunk-name prefix of mermaid-exclusive files (`isAllowedUiPath`/`HASHED_ASSET_RE` already accept it). */
export const MMD_PREFIX = "assets/mmd-";

/** Forbidden-pattern names exempted ONLY inside mermaid-exclusive chunks (plan §7.3 step 5). */
export const MERMAID_PATTERN_EXEMPTIONS: ReadonlySet<string> = new Set(["static style= attribute", 'Function("']);

/** Extra documentation/namespace URLs allowed ONLY inside mermaid-exclusive chunks (never fetched; r2 measured). */
export const MERMAID_URL_ALLOWLIST: readonly RegExp[] = [
  /^https:\/\/chevrotain\.io\//,
  /^https:\/\/langium\.org\//,
  /^https:\/\/en\.wikipedia\.org\//,
  /^http:\/\/www\.eclipse\.org\/elk\//,
  /^http:\/\/www\.eclipse\.org\/emf\//,
  /^http:\/\/\/org\/eclipse\/emf\//,
];

export const LICENSE_ALLOWLIST: ReadonlySet<string> = new Set([
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "0BSD",
  "Unlicense",
  "(MPL-2.0 OR Apache-2.0)",
  "EPL-2.0",
]);

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/* ----------------------------------------------------------------------- provenance integrity */

/**
 * Every `.js` in dist must be in the sidecar with an identical sha256 and nothing else may be in it
 * (R2-2: `public/theme-init.js` is recorded, never skipped). Returns human-readable errors.
 */
export function verifyProvenance(prov: UiProvenance, jsFiles: ReadonlyMap<string, Uint8Array>): string[] {
  const errors: string[] = [];
  const stale = "provenance is stale or missing — re-run `npm run build:web`";
  if (prov.v !== 1 || typeof prov.chunks !== "object" || prov.chunks === null)
    return [`provenance malformed (${stale})`];
  for (const [path, bytes] of jsFiles) {
    const entry = prov.chunks[path];
    if (!entry) errors.push(`${path}: not recorded in the provenance (${stale})`);
    else if (entry.sha256 !== sha256Hex(bytes)) errors.push(`${path}: sha256 differs from the provenance (${stale})`);
  }
  for (const path of Object.keys(prov.chunks)) {
    if (!jsFiles.has(path)) errors.push(`${path}: listed in the provenance but absent from dist (${stale})`);
  }
  return errors;
}

export function exclusiveSet(prov: UiProvenance): Set<string> {
  return new Set(
    Object.entries(prov.chunks)
      .filter(([, c]) => c.mermaidExclusive)
      .map(([p]) => p),
  );
}

/** `exemptionsFor`: only provenance-proven mermaid-exclusive files get the mermaid exemptions. */
export function exemptionsFor(path: string, prov: UiProvenance): boolean {
  return prov.chunks[path]?.mermaidExclusive === true;
}

/** Name ⇔ provenance: a path starts with `assets/mmd-` iff the sidecar says it is mermaid-exclusive. */
export function verifyNaming(prov: UiProvenance): string[] {
  const errors: string[] = [];
  for (const [path, c] of Object.entries(prov.chunks)) {
    const named = path.startsWith(MMD_PREFIX);
    if (named && !c.mermaidExclusive)
      errors.push(`${path}: named mmd-* but the provenance says it is not mermaid-exclusive`);
    if (!named && c.mermaidExclusive) errors.push(`${path}: mermaid-exclusive but not named assets/mmd-*`);
  }
  return errors;
}

/** Exactly one chunk carries the impl iff the build reaches it, and that chunk must be exclusive. */
export function verifyImplChunk(prov: UiProvenance): string[] {
  const holders = Object.entries(prov.chunks).filter(([, c]) => c.containsImpl);
  const errors: string[] = [];
  const want = prov.implInGraph ? 1 : 0;
  if (holders.length !== want) {
    errors.push(`expected ${want} chunk(s) containing mermaid-impl, found ${holders.length}`);
  }
  for (const [path, c] of holders) {
    if (!c.mermaidExclusive)
      errors.push(
        `${path}: contains mermaid-impl but is not mermaid-exclusive (mermaid reachable from the first screen?)`,
      );
  }
  if (!prov.implInGraph && exclusiveSet(prov).size > 0) {
    errors.push("mermaid-exclusive chunks exist although mermaid-impl is not in the module graph");
  }
  return errors;
}

/** BEFORE subtracting the lazy set: first-screen ∩ mermaid-exclusive must be empty. */
export function verifyFirstScreenDisjoint(firstScreen: ReadonlySet<string>, prov: UiProvenance): string[] {
  const excl = exclusiveSet(prov);
  return [...firstScreen]
    .filter((p) => excl.has(p))
    .map((p) => `${p}: mermaid-exclusive file is loaded on the first screen`);
}

/** D2 (KaTeX not bundled): no chunk's rendered modules may come from the `katex` package. */
export function verifyNoKatex(prov: UiProvenance): string[] {
  const errors: string[] = [];
  for (const [path, c] of Object.entries(prov.chunks)) {
    if (c.packages.some((p) => p.name === "katex"))
      errors.push(`${path}: contains the katex package (math must not be bundled)`);
  }
  return errors;
}

/** Sum of gzip bytes over mermaid-exclusive files, given each file's gzip size. */
export function mermaidGzipBytes(prov: UiProvenance, gzipOf: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const p of exclusiveSet(prov)) total += gzipOf.get(p) ?? 0;
  return total;
}

/* ------------------------------------------------------------------------------ licence gate */

export interface VendoredComponent {
  name: string;
  version: string;
  license: string | null;
  source: string;
  evidence: string;
  copyrightLines: string[];
  licenseText: string;
  noticeText: string | null;
}

export interface VendoredOuter {
  /** Artifact path (relative to the outer package) → sha256 of the file as it sits in node_modules. */
  artifacts: Record<string, string>;
  components: VendoredComponent[];
}

export interface VendoredBundled {
  v: 1;
  outer: Record<string, VendoredOuter>;
}

export interface ThirdPartyOverrides {
  [nameAtVersion: string]: { license: string; evidence: string };
}

export interface PackageFacts {
  /** Concatenated texts of the package's LICENSE-like files (may be empty). */
  licenseTexts: string[];
  /** Concatenated texts of NOTICE-like files. */
  noticeTexts: string[];
}

/** LICENSE/LICENCE/COPYING and NOTICE files at the top level of a package directory. */
export function readPackageLicenseFiles(dir: string): PackageFacts {
  const facts: PackageFacts = { licenseTexts: [], noticeTexts: [] };
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return facts;
  }
  for (const name of names.sort()) {
    const kind = /^(license|licence|copying)([-._].*)?$/i.test(name)
      ? "license"
      : /^notice([-._].*)?$/i.test(name)
        ? "notice"
        : null;
    if (kind === null) continue;
    try {
      const text = readFileSync(join(dir, name), "utf8").replace(/\r\n/g, "\n");
      (kind === "license" ? facts.licenseTexts : facts.noticeTexts).push(text);
    } catch {
      // unreadable / directory: ignore
    }
  }
  return facts;
}

export interface NoticePackage {
  name: string;
  version: string;
  license: string | null;
  dir: string;
}

/** Heading generator + checker share this exact format: `## name@version`. */
export function noticeHeading(name: string, version: string): string {
  return `## ${name}@${version}`;
}

/** Entry boundary written by the generator (`\n---\n\n## `). Licence texts contain `## ` markdown headings, so the next `## ` is NOT a boundary. */
export const NOTICE_ENTRY_BOUNDARY = "\n---\n\n## ";

/** Slice of the notices file belonging to one `## name@version` entry (up to the generator's next entry boundary). */
export function noticeSection(notices: string, name: string, version: string): string | null {
  const heading = `\n${noticeHeading(name, version)}\n`;
  const start = notices.indexOf(heading);
  if (start < 0) return null;
  const from = start + 1;
  const next = notices.indexOf(NOTICE_ENTRY_BOUNDARY, from);
  return notices.slice(from, next < 0 ? undefined : next);
}

export function uniquePackages(prov: UiProvenance): NoticePackage[] {
  const map = new Map<string, NoticePackage>();
  for (const c of Object.values(prov.chunks)) {
    for (const p of c.packages) map.set(`${p.name}@${p.version}`, p);
  }
  return [...map.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
}

function copyrightLinesOf(text: string): string[] {
  return [
    ...new Set(
      text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /copyright/i.test(l)),
    ),
  ];
}

export interface LicenseGateInput {
  prov: UiProvenance;
  notices: string;
  overrides: ThirdPartyOverrides;
  vendored: VendoredBundled;
  /** Facts about an installed package at `dir` (the real gate reads node_modules; null ⇒ not installed / other version). */
  packageFacts: (pkg: { name: string; version: string; dir: string }) => PackageFacts | null;
  /** The EPL banner the ELK chunk must start with (post-minify file bytes, see `elkBannerFor`). */
  elkChunkHeads: ReadonlyMap<string, string>;
  /** Expected banner text for the ELK version found in the provenance (`null` when no ELK chunk). */
  expectedElkBanner: string | null;
}

/** §8.4 gates 1–6 + R2-7 (vendored components), as a flat list of errors. */
export function verifyLicenses(input: LicenseGateInput): string[] {
  const errors: string[] = [];
  const { prov, notices, overrides, vendored } = input;

  // 1–5: per rendered package.
  for (const pkg of uniquePackages(prov)) {
    const id = `${pkg.name}@${pkg.version}`;
    let spdx = pkg.license;
    if (spdx === null) {
      const o = overrides[id];
      if (!o) {
        errors.push(
          `${id}: no licence field and no entry in third-party-overrides.json (verify by hand, then pin name@version)`,
        );
        continue;
      }
      spdx = o.license;
    }
    if (!LICENSE_ALLOWLIST.has(spdx)) {
      errors.push(`${id}: licence "${spdx}" is not on the allow-list`);
      continue;
    }
    const section = noticeSection(notices, pkg.name, pkg.version);
    if (section === null) {
      errors.push(
        `${id}: missing from THIRD_PARTY_NOTICES.md (run \`npx tsx scripts/web-hub/gen-third-party-notices.ts\`)`,
      );
      continue;
    }
    if (!section.includes(`- **License**: ${spdx}`)) errors.push(`${id}: notices entry does not state licence ${spdx}`);
    const facts = input.packageFacts({ name: pkg.name, version: pkg.version, dir: pkg.dir });
    if (facts === null) {
      errors.push(`${id}: package is not installed, cannot compare its licence files`);
      continue;
    }
    for (const text of facts.licenseTexts) {
      for (const line of copyrightLinesOf(text)) {
        if (!section.includes(line)) errors.push(`${id}: copyright line missing from the notices entry: ${line}`);
      }
    }
    for (const text of facts.noticeTexts) {
      if (!section.includes(text.trim())) errors.push(`${id}: NOTICE file content missing from the notices entry`);
    }
    if (facts.licenseTexts.length === 0 && !(overrides[id] !== undefined)) {
      errors.push(`${id}: no LICENSE file in the package (add a third-party-overrides.json entry with the evidence)`);
    }
  }

  // R2-7: pre-bundled components embedded in outer packages.
  for (const [outer, list] of Object.entries(prov.embedded ?? {})) {
    const pinned = vendored.outer[outer];
    if (!pinned) {
      errors.push(
        `${outer}: embeds third-party components but has no entry in vendored-bundled.json (review, then pin)`,
      );
      continue;
    }
    const seenArtifacts = new Map(list.map((e) => [e.file, e.sha256]));
    for (const [file, sha] of seenArtifacts) {
      const want = pinned.artifacts[file];
      if (want === undefined)
        errors.push(`${outer}: embedding artifact ${file} is not pinned in vendored-bundled.json`);
      else if (want !== sha)
        errors.push(
          `${outer}: artifact ${file} changed (sha256) — re-review its embedded components and update vendored-bundled.json`,
        );
    }
    for (const file of Object.keys(pinned.artifacts)) {
      if (!seenArtifacts.has(file))
        errors.push(`${outer}: pinned artifact ${file} no longer embeds components (stale vendored-bundled.json)`);
    }
    const detected = new Set(list.flatMap((e) => e.components));
    const declared = new Set(pinned.components.map((c) => `${c.name}@${c.version}`));
    for (const c of detected)
      if (!declared.has(c)) errors.push(`${outer}: embedded component ${c} is not declared in vendored-bundled.json`);
    for (const c of declared)
      if (!detected.has(c))
        errors.push(`${outer}: declared component ${c} is no longer embedded (stale vendored-bundled.json)`);
    for (const comp of pinned.components) {
      const id = `${comp.name}@${comp.version}`;
      if (comp.license === null || !LICENSE_ALLOWLIST.has(comp.license)) {
        errors.push(`${id} (bundled in ${outer}): licence "${comp.license}" is not on the allow-list`);
        continue;
      }
      if (comp.licenseText.trim() === "")
        errors.push(`${id} (bundled in ${outer}): empty licence text in vendored-bundled.json`);
      if (comp.copyrightLines.length === 0) errors.push(`${id} (bundled in ${outer}): no copyright line recorded`);
      for (const line of comp.copyrightLines) {
        if (!comp.licenseText.includes(line))
          errors.push(`${id} (bundled in ${outer}): copyright line not in its licence text: ${line}`);
      }
      const section = noticeSection(notices, comp.name, comp.version);
      if (section === null) {
        errors.push(`${id} (bundled in ${outer}): missing from THIRD_PARTY_NOTICES.md`);
        continue;
      }
      for (const line of comp.copyrightLines) {
        if (!section.includes(line)) errors.push(`${id}: copyright line missing from the notices entry: ${line}`);
      }
      if (comp.noticeText !== null && !section.includes(comp.noticeText.trim())) {
        errors.push(`${id}: NOTICE text missing from the notices entry`);
      }
    }
  }

  // 6: the ELK chunk starts with the EPL banner (§8.3), derived from the ELK version actually bundled.
  const elkChunks = Object.entries(prov.chunks)
    .filter(([, c]) => c.containsElk)
    .map(([p]) => p);
  for (const path of elkChunks) {
    const head = input.elkChunkHeads.get(path) ?? "";
    if (input.expectedElkBanner === null || !head.startsWith(input.expectedElkBanner)) {
      errors.push(`${path}: ELK chunk does not start with the EPL notice banner`);
    }
  }
  if (elkChunks.length > 0) {
    const elkPkg = uniquePackages(prov).find((p) => p.name === "elkjs");
    if (elkPkg === undefined) errors.push("ELK chunk present but elkjs is not in the provenance packages");
    else {
      const section = noticeSection(notices, "elkjs", elkPkg.version) ?? "";
      for (const needle of [
        "Copyright (c) 2017 Kiel University and others.",
        "Copyright (c) 2021 Kiel University and others.",
        "Copyright 2020 Google LLC",
        "Eclipse Public License - v 2.0",
        "https://github.com/kieler/elkjs",
        "3.1(a)",
      ]) {
        if (!section.includes(needle)) errors.push(`elkjs@${elkPkg.version}: notices entry lacks "${needle}"`);
      }
    }
  }
  return errors;
}
