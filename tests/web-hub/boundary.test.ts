import { describe, expect, it } from "vitest";
import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { relative, resolve } from "node:path";

/**
 * Boundary guard for web-hub (plan §包 A):
 * - `src/web-hub/{protocol,hub}/**` may only import `node:*`, `@sinclair/typebox(/...)`
 *   and relative paths that stay inside `src/web-hub/{protocol,hub}`. In particular
 *   no `@earendil-works/*` (protocol/hub must stay pi-free and dependency-free).
 * - `src/web-hub/agent/**` must not import `../hub/**` — except type-only imports
 *   of `ports.js`.
 */
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROTOCOL_HUB = ["src/web-hub/protocol", "src/web-hub/hub"].map((d) => resolve(ROOT, d));

interface ImportRef {
  file: string;
  spec: string;
  typeOnly: boolean;
}

function scanImports(file: string): ImportRef[] {
  const src = readFileSync(file, "utf8");
  const refs: ImportRef[] = [];
  // `import ... from "spec"`, `import type ... from "spec"`, `export ... from "spec"`
  const fromRe = /(?:^|[;\n])\s*(?:import|export)(\s+type)?\s+[^;'"]*?from\s*["']([^"']+)["']/g;
  for (const m of src.matchAll(fromRe)) {
    refs.push({ file, spec: m[2]!, typeOnly: m[1] !== undefined });
  }
  // bare side-effect import: `import "spec"`
  const bareRe = /(?:^|[;\n])\s*import\s*["']([^"']+)["']/g;
  for (const m of src.matchAll(bareRe)) refs.push({ file, spec: m[1]!, typeOnly: false });
  return refs;
}

function insideProtocolHub(absPath: string): boolean {
  return PROTOCOL_HUB.some((dir) => absPath === dir || absPath.startsWith(`${dir}/`));
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

  it("protocol/hub only import node:*, @sinclair/typebox and intra-{protocol,hub} relative paths", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const { spec } of scanImports(file)) {
        const ok =
          spec.startsWith("node:") ||
          spec === "@sinclair/typebox" ||
          spec.startsWith("@sinclair/typebox/") ||
          (spec.startsWith(".") && insideProtocolHub(resolve(file, "..", spec)));
        if (!ok) offenders.push(`${relative(ROOT, file)} → "${spec}"`);
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

  it("agent/** does not import ../hub/** (ports.js type-only imports excepted)", () => {
    const agentFiles = globSync("src/web-hub/agent/**/*.ts", { cwd: ROOT }).map((f) => resolve(ROOT, f));
    const offenders: string[] = [];
    for (const file of agentFiles) {
      for (const { spec, typeOnly } of scanImports(file)) {
        const isHubImport = spec.startsWith("../hub/");
        const allowed = isHubImport && spec === "../hub/ports.js" && typeOnly;
        if (isHubImport && !allowed) offenders.push(`${relative(ROOT, file)} → "${spec}" (typeOnly=${typeOnly})`);
      }
    }
    expect(offenders, offenders.join("; ")).toEqual([]);
  });
});
