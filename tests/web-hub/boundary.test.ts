import { existsSync, globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Boundary guard for web-hub (plan §包 A, refined by worktree-diff plan §5 D1 #12):
 * - `src/web-hub/{protocol,hub}/**` may only import `node:*`, `@sinclair/typebox(/...)`
 *   and relative paths that stay inside `src/web-hub/{protocol,hub}`. In particular
 *   no `@earendil-works/*` (protocol/hub must stay pi-free and dependency-free).
 * - `src/web-hub/hub/**` may additionally reach OUT of {protocol,hub} via relative imports
 *   that resolve to EXACTLY `src/git/run.ts`, `src/git/worktrees.ts` or `src/git/diff.ts`
 *   (the worktree-diff git layer) — not "anything under src/git/**".
 * - Isolation is NOT "imports node:* ⇒ isolated": `node:*` itself carries `child_process`/
 *   `fs`. The guarantee is the precise per-file allowlist above plus the closure table
 *   below (GIT_FILE_CLOSURE) pinning the transitive import surface of those three files;
 *   adding any import to them must go through a conscious update of that constant table.
 * - `src/web-hub/agent/**` must not import `../hub/**` — except type-only imports
 *   of `ports.js` / `ui-root.js`.
 */
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROTOCOL_HUB = ["src/web-hub/protocol", "src/web-hub/hub"].map((d) => resolve(ROOT, d));

/** The ONLY src/git files hub code may import (worktree-diff plan §1.1 / §5 D1 #12). */
const GIT_FILE_ALLOWLIST = ["run", "worktrees", "diff"].map((n) => resolve(ROOT, `src/git/${n}.ts`));

/**
 * Closure constant table (worktree-diff plan §5 D1 #12): the exact import surface of the
 * three allowlisted files. Any new import in them turns this test red — update the table
 * only as a deliberate boundary decision, never casually.
 */
const GIT_FILE_CLOSURE: Record<string, Array<{ spec: string; typeOnly: boolean }>> = {
  "src/git/run.ts": [{ spec: "node:child_process", typeOnly: false }],
  "src/git/worktrees.ts": [
    { spec: "node:fs", typeOnly: false },
    { spec: "./run.js", typeOnly: true },
  ],
  "src/git/diff.ts": [],
};

interface ImportRef {
  file: string;
  spec: string;
  typeOnly: boolean;
}

/**
 * Scan source text for import references — ALL FOUR forms must be covered so that
 * "any new import turns the boundary red" cannot be dodged by form choice: static
 * `import/export … from "spec"` (type-only tracked), bare side-effect `import "spec"`,
 * dynamic `import("spec")` and `require("spec")` (typeOnly always false).
 */
function scanSource(src: string, file: string): ImportRef[] {
  const refs: ImportRef[] = [];
  // `import ... from "spec"`, `import type ... from "spec"`, `export ... from "spec"`
  const fromRe = /(?:^|[;\n])\s*(?:import|export)(\s+type)?\s*[^;'"]*?from\s*["']([^"']+)["']/g;
  for (const m of src.matchAll(fromRe)) {
    refs.push({ file, spec: m[2]!, typeOnly: m[1] !== undefined });
  }
  // bare side-effect import: `import "spec"`
  const bareRe = /(?:^|[;\n])\s*import\s*["']([^"']+)["']/g;
  for (const m of src.matchAll(bareRe)) refs.push({ file, spec: m[1]!, typeOnly: false });
  // dynamic import: `import("spec")` / `await import("spec")`
  const dynamicRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of src.matchAll(dynamicRe)) refs.push({ file, spec: m[1]!, typeOnly: false });
  // CommonJS require: `require("spec")`
  const requireRe = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of src.matchAll(requireRe)) refs.push({ file, spec: m[1]!, typeOnly: false });
  return refs;
}

function scanImports(file: string): ImportRef[] {
  return scanSource(readFileSync(file, "utf8"), file);
}

/**
 * NodeNext resolution: ESM specifiers are `.js`-suffixed while the sources on disk are
 * `.ts` — normalize a resolved `.js` path to its `.ts` sibling when that source exists,
 * so exact-file allowlist comparisons see the real compilation unit. Without this, a
 * legitimate hub-side `import … from "../../git/diff.js"` would resolve to a `.js` path
 * and never match the allowlist.
 */
function resolveImport(file: string, spec: string): string {
  const resolved = resolve(file, "..", spec);
  if (resolved.endsWith(".js")) {
    const ts = `${resolved.slice(0, -3)}.ts`;
    if (existsSync(ts)) return ts;
  }
  return resolved;
}

function insideProtocolHub(absPath: string): boolean {
  return PROTOCOL_HUB.some((dir) => absPath === dir || absPath.startsWith(`${dir}/`));
}

/** The single admission predicate for protocol/hub import specs. */
function hubImportAllowed(file: string, spec: string): boolean {
  const inHub = file.startsWith(`${resolve(ROOT, "src/web-hub/hub")}/`);
  return (
    spec.startsWith("node:") ||
    spec === "@sinclair/typebox" ||
    spec.startsWith("@sinclair/typebox/") ||
    (spec.startsWith(".") &&
      (insideProtocolHub(resolveImport(file, spec)) ||
        // hub files escaping {protocol,hub} must land on the exact git allowlist
        (inHub && GIT_FILE_ALLOWLIST.includes(resolveImport(file, spec)))))
  );
}

describe("web-hub boundary", () => {
  const files = [
    ...globSync("src/web-hub/protocol/**/*.ts", { cwd: ROOT }),
    ...globSync("src/web-hub/hub/**/*.ts", { cwd: ROOT }),
  ].map((f) => resolve(ROOT, f));

  it("protocol/hub files are discovered", () => {
    expect(files.map((f) => relative(ROOT, f))).toEqual(
      expect.arrayContaining([
        "src/web-hub/protocol/version.ts",
        "src/web-hub/protocol/ndjson.ts",
        "src/web-hub/protocol/paths.ts",
        "src/web-hub/protocol/messages.ts",
        "src/web-hub/protocol/keys.ts",
        "src/web-hub/protocol/http-contract.ts",
        "src/web-hub/hub/ports.ts",
      ]),
    );
  });

  it("protocol/hub imports stay within node:*, @sinclair/typebox, intra-{protocol,hub} relative paths, and (hub only) the exact src/git three-file allowlist", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const { spec } of scanImports(file)) {
        if (!hubImportAllowed(file, spec)) offenders.push(`${relative(ROOT, file)} → "${spec}"`);
      }
    }
    expect(offenders, offenders.join("; ")).toEqual([]);
  });

  it("protocol/hub never import @earendil-works/* or any other package", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const { spec } of scanImports(file)) {
        if (!spec.startsWith("node:") && !spec.startsWith(".") && !spec.startsWith("@sinclair/typebox")) {
          offenders.push(`${relative(ROOT, file)} → "${spec}"`);
        }
      }
    }
    expect(offenders, offenders.join("; ")).toEqual([]);
  });

  it("agent/** does not import ../hub/** (ports.js / ui-root.js type-only imports excepted)", () => {
    const agentFiles = globSync("src/web-hub/agent/**/*.ts", { cwd: ROOT }).map((f) => resolve(ROOT, f));
    const offenders: string[] = [];
    // vue-plan.md v2.1 §2.3 (P5b): `hub.json`'s `ui` field is a `UiStatus` (`hub/ui-root.js`) —
    // the agent side (`/webhub status`) reads it back and needs the same type. `ports.js` stays
    // the only allowed *value* boundary (agent never imports hub logic); this only widens the
    // type-only exception the same way `ports.js` already had one.
    const TYPE_ONLY_ALLOWED = new Set(["../hub/ports.js", "../hub/ui-root.js"]);
    for (const file of agentFiles) {
      for (const { spec, typeOnly } of scanImports(file)) {
        const isHubImport = spec.startsWith("../hub/");
        const allowed = isHubImport && TYPE_ONLY_ALLOWED.has(spec) && typeOnly;
        if (isHubImport && !allowed) offenders.push(`${relative(ROOT, file)} → "${spec}" (typeOnly=${typeOnly})`);
      }
    }
    expect(offenders, offenders.join("; ")).toEqual([]);
  });

  it("the three allowlisted src/git files import EXACTLY the pinned closure table (worktree-diff §5 D1 #12)", () => {
    for (const [relPath, expected] of Object.entries(GIT_FILE_CLOSURE)) {
      const file = resolve(ROOT, relPath);
      const actual = scanImports(file)
        .map((ref) => ({ spec: ref.spec, typeOnly: ref.typeOnly }))
        .sort((a, b) => a.spec.localeCompare(b.spec));
      const wanted = [...expected].sort((a, b) => a.spec.localeCompare(b.spec));
      expect(actual, `${relPath} must import exactly ${JSON.stringify(wanted)}`).toEqual(wanted);
    }
  });

  it("protocol files may not escape {protocol,hub} at all (the git allowlist is hub-only)", () => {
    const protocolDir = resolve(ROOT, "src/web-hub/protocol");
    const offenders: string[] = [];
    for (const file of files) {
      if (!file.startsWith(`${protocolDir}/`)) continue;
      for (const { spec } of scanImports(file)) {
        if (spec.startsWith(".") && !insideProtocolHub(resolveImport(file, spec))) {
          offenders.push(`${relative(ROOT, file)} → "${spec}"`);
        }
      }
    }
    expect(offenders, offenders.join("; ")).toEqual([]);
  });
});

describe("web-hub boundary import scanner (worktree-diff §5 D1 #12 fix 1a/1b/1c)", () => {
  it("captures all four import forms (static from / type-only / bare side-effect / dynamic / require)", () => {
    const fixture = [
      'import { spawn } from "node:child_process";',
      'import type { GitRunner } from "./run.js";',
      'export { scanWorktrees } from "./worktrees.js";',
      'import "./side-effect.js";',
      'const mod = await import("./dynamic.js");',
      'function lazy() { return require("./cjs.js"); }',
      "// not an import: importMaybe('./nope.js') has no paren form below",
    ].join("\n");
    const refs = scanSource(fixture, "/ fixture /x.ts");
    expect(refs).toEqual([
      { file: "/ fixture /x.ts", spec: "node:child_process", typeOnly: false },
      { file: "/ fixture /x.ts", spec: "./run.js", typeOnly: true },
      { file: "/ fixture /x.ts", spec: "./worktrees.js", typeOnly: false },
      { file: "/ fixture /x.ts", spec: "./side-effect.js", typeOnly: false },
      { file: "/ fixture /x.ts", spec: "./dynamic.js", typeOnly: false },
      { file: "/ fixture /x.ts", spec: "./cjs.js", typeOnly: false },
    ]);
  });

  it("does not invent imports from plain strings or identifiers", () => {
    const refs = scanSource(
      [
        'const spec = "node:fs"; // string, not an import',
        "// importMaybe is an identifier, not the import keyword",
        'const note = "the phrase import(quoted) inside a string is unquoted here";',
      ].join("\n"),
      "/ fixture /y.ts",
    );
    expect(refs).toEqual([]);
  });

  it("normalizes a NodeNext `.js` specifier to its `.ts` source sibling", () => {
    const hubFile = resolve(ROOT, "src/web-hub/hub/ports.ts");
    expect(resolveImport(hubFile, "../../git/diff.js")).toBe(resolve(ROOT, "src/git/diff.ts"));
    expect(resolveImport(hubFile, "../protocol/messages.js")).toBe(resolve(ROOT, "src/web-hub/protocol/messages.ts"));
    // no .ts sibling ⇒ path stays as resolved (never silently rewritten)
    expect(resolveImport(hubFile, "./does-not-exist.js")).toBe(resolve(ROOT, "src/web-hub/hub/does-not-exist.js"));
  });

  it("the admission predicate accepts exactly the three git files from hub (`.js` specifiers included) and nothing else — assertion-level proof without touching sources", () => {
    // a hub file two levels below web-hub (e.g. hub/worktree-diff/routes.ts) needs ../../../git/…;
    // use a top-level hub fixture path so ../../git/… resolves to src/git exactly.
    const hubFile = resolve(ROOT, "src/web-hub/hub/routes.fixture.ts");
    const protocolFile = resolve(ROOT, "src/web-hub/protocol/version.ts");
    for (const spec of ["../../git/run.js", "../../git/worktrees.js", "../../git/diff.js"]) {
      expect(hubImportAllowed(hubFile, spec), `${spec} from hub`).toBe(true);
    }
    // a real src/git file OUTSIDE the allowlist — even with a .ts sibling to normalize
    expect(existsSync(resolve(ROOT, "src/git/path-label.ts"))).toBe(true);
    expect(hubImportAllowed(hubFile, "../../git/path-label.js")).toBe(false);
    // escaping outside src entirely
    expect(hubImportAllowed(hubFile, "../../index.js")).toBe(false);
    // the git allowlist is hub-only: protocol files may not reach src/git at all
    expect(hubImportAllowed(protocolFile, "../git/diff.js")).toBe(false);
  });
});
