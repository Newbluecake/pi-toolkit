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
 * - Agent-side files (`src/web-hub/agent/**` plus command capture) must not import hub — except type-only imports
 *   of `ports.js` / `ui-root.js`.
 */
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROTOCOL_HUB = ["src/web-hub/protocol", "src/web-hub/hub"].map((d) => resolve(ROOT, d));

/** The ONLY src/git files hub code may import (worktree-diff plan §1.1 / §5 D1 #12). */
const GIT_FILE_ALLOWLIST = ["run", "worktrees", "diff", "graph"].map((n) => resolve(ROOT, `src/git/${n}.ts`));
/** P3 sysload hub imports the pi-free sampler closure directly; keep this explicit rather than
 * allowing arbitrary imports outside the hub/protocol boundary. */
const SYSLOAD_FILE_ALLOWLIST = [
  "src/core/clock.ts",
  "src/sysload/io-ledger.ts",
  "src/sysload/mounts.ts",
  "src/sysload/procfs.ts",
  "src/sysload/sampler.ts",
  "src/sysload/top.ts",
  "src/sysload/tracker.ts",
  "src/sysload/types.ts",
  "src/sysload/wire.ts",
  // data-encryption P2 §2.7: the supervisor's managed-spawn env runs through the import-free hubSafeEnv.
  "src/secure/env.ts",
].map((p) => resolve(ROOT, p));
/** Settings are shared with hub only as erased types; their value closure stays pinned below. */
const HUB_TYPE_ONLY_ALLOWLIST = ["src/config/settings.ts"].map((p) => resolve(ROOT, p));
const AGENT_SIDE_EXTRA_CANDIDATES = ["src/web-hub/agent/command-capture.ts", "src/commands/capture.ts"];

/** scheduled-reports plan r3 §7.6/§12 S1: the hub coordinator reads schedule state through the pure,
 * read-only half of src/schedule/core (reader + path primitives + cron + occurrence + liveness
 * judgment + the frozen spec). The writer / lock / claim / session-proof half is agent-only and
 * deliberately NOT allowlisted. */
const SCHEDULE_CORE_FILE_ALLOWLIST = ["spec", "cron", "occurrence", "paths", "reader", "recovery"].map((n) =>
  resolve(ROOT, `src/schedule/core/${n}.ts`),
);
/** Exact VALUE-import closure of the allowlisted schedule core files (type-only lines omitted). */
const SCHEDULE_CORE_FILE_CLOSURE: Record<string, string[]> = {
  // spec.ts value-imports AND value-re-exports the protocol vocabulary (two scanner hits).
  "src/schedule/core/spec.ts": [
    "node:crypto",
    "../../web-hub/protocol/schedule.js",
    "../../web-hub/protocol/schedule.js",
  ],
  "src/schedule/core/cron.ts": ["./spec.js"],
  "src/schedule/core/occurrence.ts": ["./cron.js", "./spec.js"],
  "src/schedule/core/paths.ts": ["node:crypto", "node:fs", "node:path"],
  "src/schedule/core/reader.ts": ["node:fs", "./paths.js", "./spec.js"],
  "src/schedule/core/recovery.ts": ["node:fs", "node:os", "./spec.js"],
};

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
  "src/git/graph.ts": [{ spec: "./diff.js", typeOnly: false }],
};

/**
 * P3 sysload closure (hub-boundary pin, verifier r_5YF8V2G1 finding 2): the EXACT set of
 * VALUE (non-`import type`) specifiers each allowlisted sysload/config file may carry.
 * Unlike `GIT_FILE_CLOSURE` this table deliberately omits `import type` lines —
 * `src/config/settings.ts` already has `import type` lines reaching pi-facing modules
 * (`../web-hub/agent/index.js`, `../commands/webhub.js`) that are erased at runtime and
 * would churn this table on unrelated feature work. What MUST stay frozen is the value
 * import surface: a new runtime import anywhere in this closure (e.g. a pi import such as
 * `@earendil-works/*` or `../web-hub/agent/index.js`) turns the boundary red until a
 * conscious table update — that is the whole point.
 */
const SYSLOAD_FILE_CLOSURE: Record<string, string[]> = {
  "src/core/clock.ts": [],
  "src/core/agent-dir.ts": ["node:path", "node:url"],
  "src/web-hub/protocol/agent-dir.ts": ["node:path", "node:url"],
  "src/config/settings.ts": [
    "node:fs",
    "node:os",
    "node:path",
    // #56 ⑧: the `cacheTtl` block lives in cache-ttl/settings.ts (pinned below) — config no longer imports keepalive-state.
    "../cache-ttl/settings.js",
    "../compact-hint/settings.js",
    // settings-rename P2 (plan §6.3): settingsLocation()/prepareSettingsFile() resolve the agentDir through the
    // pi-free core resolver (node:path + node:url only; pinned above). A conscious table update — the hub
    // whitelist is NOT loosened: the hub reaches agent-dir through its own protocol mirror.
    "../core/agent-dir.js",
    "../core/deadline.js",
    "../extensions/worktree-link-paths.js",
    // #56 ⑧: the `fabric` block lives in fabric/settings.ts (pinned below).
    "../fabric/settings.js",
    "../memory/tidy/batch-settings.js",
    "../quota/settings.js",
    "../sysload/settings.js",
    "../topic-switch/settings.js",
    // #56 ⑧: the `webHub` / `feishuBot` blocks live in web-hub/agent/settings.ts (pinned below).
    "../web-hub/agent/settings.js",
    // external-agent plan §2.8: droid pricing refs validated with parseStrictModelRef (pure, zero imports).
    "./model-hint.js",
    // data-encryption P2 §2.4 step 2: the secure-domain settings override (pi-free closure below).
    "../secure/domain.js",
    // data-encryption P1 review #5: cross-process settings-file lock (flock child, pi-free).
    "../secure/settings-lock.js",
    "./time-units.js",
  ],
  "src/secure/settings-lock.ts": ["node:child_process", "node:fs", "node:path"],
  // settings-rename P1: domain resolves the settings file through the agentDir + file-name protocol.
  "src/secure/domain.ts": [
    "node:fs",
    "node:os",
    "node:path",
    "../core/agent-dir.js",
    "./config.js",
    "./env.js",
    "./settings-lock.js",
  ],
  "src/secure/config.ts": ["node:path"],
  "src/secure/env.ts": [],
  "src/config/model-hint.ts": [],
  "src/fabric/xs/channel.ts": ["../../web-hub/protocol/xs.js"],
  // #56 ⑧: fabric block settings — channel-plan CH0 pure channel-name rules + the pure receive/session-id rules.
  "src/fabric/settings.ts": ["./xs/channel.js", "./xs/receive.js"],
  "src/fabric/xs/receive.ts": [],
  "src/cache-ttl/settings.ts": ["./keepalive-state.js"],
  // #56 ⑧: quota block settings — `./types.js` is type-only (erased), so no value import at all.
  "src/quota/settings.ts": [],
  // #56 ⑧: load block settings — the frozen sysload domain constants.
  "src/sysload/settings.ts": ["./types.js"],
  // #56 ⑧: compact block settings — the pure threshold defaults.
  "src/compact-hint/settings.ts": ["./threshold.js"],
  // #56 ⑧: webHub/feishuBot block settings — LAN host/origin classification (L16 第一处) + the browser-safe,
  // import-free shared CIDR parser (LAN security P0). The hub whitelist is NOT loosened: these are the same two files.
  "src/web-hub/agent/settings.ts": ["../protocol/client-allow.js", "../protocol/lan.js"],
  "src/sysload/io-ledger.ts": [],
  // P0's compatibility re-export keeps the shared file limits available to pi-free callers.
  "src/memory/tidy/batch-settings.ts": ["../contracts.js"],
  "src/memory/contracts.ts": [],
  "src/sysload/mounts.ts": ["./procfs.js"],
  "src/sysload/procfs.ts": [],
  "src/sysload/sampler.ts": ["node:fs", "node:os", "./io-ledger.js", "./mounts.js", "./procfs.js"],
  "src/sysload/top.ts": ["node:fs", "./io-ledger.js", "./procfs.js"],
  "src/sysload/tracker.ts": ["./types.js"],
  "src/sysload/types.ts": [],
  "src/sysload/wire.ts": ["./top.js"],
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
function hubImportAllowed(file: string, spec: string, typeOnly: boolean): boolean {
  const inHub = file.startsWith(`${resolve(ROOT, "src/web-hub/hub")}/`);
  return (
    spec.startsWith("node:") ||
    spec === "@sinclair/typebox" ||
    spec.startsWith("@sinclair/typebox/") ||
    (spec.startsWith(".") &&
      (insideProtocolHub(resolveImport(file, spec)) ||
        // hub files escaping {protocol,hub} must land on an exact, reviewed allowlist
        (inHub &&
          ((typeOnly && HUB_TYPE_ONLY_ALLOWLIST.includes(resolveImport(file, spec))) ||
            GIT_FILE_ALLOWLIST.includes(resolveImport(file, spec)) ||
            SYSLOAD_FILE_ALLOWLIST.includes(resolveImport(file, spec)) ||
            SCHEDULE_CORE_FILE_ALLOWLIST.includes(resolveImport(file, spec))))))
  );
}

/** Agent-side runtime imports may never reach hub logic, wherever capture lives. */
function agentImportAllowed(file: string, spec: string, typeOnly: boolean): boolean {
  const target = resolveImport(file, spec);
  const hub = resolve(ROOT, "src/web-hub/hub");
  if (target !== hub && !target.startsWith(`${hub}/`)) return true;
  return typeOnly && ["ports", "ui-root"].some((name) => target === resolve(hub, `${name}.ts`));
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
      for (const { spec, typeOnly } of scanImports(file)) {
        if (!hubImportAllowed(file, spec, typeOnly)) offenders.push(`${relative(ROOT, file)} → "${spec}"`);
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

  it("agent-side files (agent/** + command capture) never import hub/** (ports/ui-root type-only excepted)", () => {
    const agentFiles = globSync("src/web-hub/agent/**/*.ts", { cwd: ROOT }).map((f) => resolve(ROOT, f));
    const captureFiles = AGENT_SIDE_EXTRA_CANDIDATES.map((f) => resolve(ROOT, f)).filter(existsSync);
    expect(captureFiles, "exactly one command capture layout must exist").toHaveLength(1);
    const constrained = new Set([...agentFiles, ...captureFiles]);
    expect([...constrained]).toEqual(expect.arrayContaining(agentFiles));
    expect([...constrained]).toEqual(expect.arrayContaining(captureFiles));
    const offenders: string[] = [];
    for (const file of constrained) {
      for (const { spec, typeOnly } of scanImports(file)) {
        if (!agentImportAllowed(file, spec, typeOnly)) {
          offenders.push(`${relative(ROOT, file)} → "${spec}" (typeOnly=${typeOnly})`);
        }
      }
    }
    expect(offenders, offenders.join("; ")).toEqual([]);
  });

  it.each([
    ["src/commands/capture.ts", "../web-hub/hub/registry.js", false, false],
    ["src/commands/capture.ts", "../web-hub/hub/ports.js", true, true],
    ["src/commands/capture.ts", "../web-hub/hub/ports.js", false, false],
    ["src/web-hub/agent/x.ts", "../hub/registry.js", false, false],
    ["src/web-hub/agent/x.ts", "../hub/ui-root.js", true, true],
  ])("agent admission: %s → %s (typeOnly=%s)", (file, spec, typeOnly, allowed) => {
    expect(agentImportAllowed(resolve(ROOT, file), spec, typeOnly)).toBe(allowed);
  });

  it.each([false, true])("hub settings import is type-only (typeOnly=%s)", (typeOnly) => {
    const file = resolve(ROOT, "src/web-hub/hub/load.ts");
    expect(hubImportAllowed(file, "../../config/settings.js", typeOnly)).toBe(typeOnly);
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

  it("the sysload allowlist files import EXACTLY the pinned value-import closure (a future pi value import fails)", () => {
    for (const [relPath, expected] of Object.entries(SYSLOAD_FILE_CLOSURE)) {
      const file = resolve(ROOT, relPath);
      const actual = scanImports(file)
        .filter((ref) => !ref.typeOnly)
        .map((ref) => ref.spec)
        .sort((a, b) => a.localeCompare(b));
      const wanted = [...expected].sort((a, b) => a.localeCompare(b));
      expect(actual, `${relPath} must import exactly ${JSON.stringify(wanted)} (value imports only)`).toEqual(wanted);
    }
  });

  it("the schedule core allowlist files import EXACTLY the pinned value-import closure (scheduled-reports S1)", () => {
    for (const [relPath, expected] of Object.entries(SCHEDULE_CORE_FILE_CLOSURE)) {
      const actual = scanImports(resolve(ROOT, relPath))
        .filter((ref) => !ref.typeOnly)
        .map((ref) => ref.spec)
        .sort((a, b) => a.localeCompare(b));
      const wanted = [...expected].sort((a, b) => a.localeCompare(b));
      expect(actual, `${relPath} must import exactly ${JSON.stringify(wanted)} (value imports only)`).toEqual(wanted);
    }
    // the type-only imports of the closure stay inside the same reviewed set (no pi type leaks)
    for (const relPath of Object.keys(SCHEDULE_CORE_FILE_CLOSURE)) {
      const file = resolve(ROOT, relPath);
      for (const ref of scanImports(file).filter((r) => r.typeOnly)) {
        const target = resolveImport(file, ref.spec);
        expect(
          SCHEDULE_CORE_FILE_ALLOWLIST.includes(target) || insideProtocolHub(target),
          `${relPath} type-imports ${ref.spec}`,
        ).toBe(true);
      }
    }
  });

  it("hub may import the read-only schedule core but never its writer half", () => {
    const hubFile = resolve(ROOT, "src/web-hub/hub/schedule/scan.fixture.ts");
    for (const n of ["reader", "cron", "occurrence", "paths", "recovery", "spec"]) {
      expect(hubImportAllowed(hubFile, `../../../schedule/core/${n}.js`, false), n).toBe(true);
    }
    for (const n of ["writer", "lock", "claim", "session-proof"]) {
      expect(hubImportAllowed(hubFile, `../../../schedule/core/${n}.js`, false), n).toBe(false);
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
      expect(hubImportAllowed(hubFile, spec, false), `${spec} from hub`).toBe(true);
    }
    // a real src/git file OUTSIDE the allowlist — even with a .ts sibling to normalize
    expect(existsSync(resolve(ROOT, "src/git/path-label.ts"))).toBe(true);
    expect(hubImportAllowed(hubFile, "../../git/path-label.js", false)).toBe(false);
    // escaping outside src entirely
    expect(hubImportAllowed(hubFile, "../../index.js", false)).toBe(false);
    // the git allowlist is hub-only: protocol files may not reach src/git at all
    expect(hubImportAllowed(protocolFile, "../git/diff.js", false)).toBe(false);
  });
});
