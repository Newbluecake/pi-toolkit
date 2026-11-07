// Guard for the slimmed AGENTS.md (docs/dev/source-governance/plan-lowrisk.md §1.8, K0–K9).
// AGENTS.md is injected into every session, so its size is capped and its load-bearing global rules are
// pinned by independent, section-scoped assertions (not whole-file greps).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const agents = readFileSync(join(ROOT, "AGENTS.md"), "utf8");

/** Body of the `## <title-prefix>…` section, up to the next `## ` heading. */
function section(titlePrefix: string): string {
  const lines = agents.split("\n");
  const i = lines.findIndex((l) => l.startsWith(`## ${titlePrefix}`));
  if (i < 0) throw new Error(`AGENTS.md has no "## ${titlePrefix}" section`);
  let j = i + 1;
  while (j < lines.length && !lines[j]!.startsWith("## ")) j++;
  return lines.slice(i + 1, j).join("\n");
}

describe("AGENTS.md guard", () => {
  it("K0: stays under the 32 KiB hard cap", () => {
    expect(Buffer.byteLength(agents, "utf8")).toBeLessThanOrEqual(32 * 1024);
  });

  it("K1: the read-the-README-first rule is at the very top", () => {
    expect(agents.slice(0, 1500)).toContain("先 read 下表『必读』列的 README");
  });

  it("K2: peer bump checklist carries the conformance recipe and every existing suite", () => {
    const s = section("pi peer bump checklist");
    expect(s).toContain("npm run test:conformance");
    expect(s).toContain("PI_TOOLKIT_DROID_CONFORMANCE=1");
    const suites = [
      "agent-dir",
      "memory-jev-channels",
      "unknown-slash-text",
      "cmd-history",
      "droid-protocol",
      "fabric-wake",
      "fabric-xs",
      "rpc-spawn",
      "schedule",
      "secure-gocryptfs",
      "slash-args",
      "traffic",
      "traffic-coexist",
    ];
    let checked = 0;
    for (const name of suites) {
      if (!existsSync(join(ROOT, "tests", "conformance", `${name}.test.ts`))) continue; // self-gating: skip suites that no longer exist
      expect(s, `${name}.test.ts missing from the checklist`).toContain(`${name}.test.ts`);
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
    for (const id of ["C-X1–C-X16", "C-X12b/C-X14b", "C-J1–C-J16", "C-J7/C-J8/C-J15"]) {
      expect(s, `${id} missing from checklist`).toContain(id);
    }
    const xs = readFileSync(join(ROOT, "tests/conformance/fabric-xs.test.ts"), "utf8");
    for (const id of ["C-X12b", "C-X14b", "C-X16"]) expect(xs).toContain(id);
    const jev = readFileSync(join(ROOT, "tests/conformance/memory-jev-channels.test.ts"), "utf8");
    expect(jev).toContain("C-J16");
  });

  it("K3: peer bump checklist names pi-compat and the exact peer ranges from package.json", () => {
    const s = section("pi peer bump checklist");
    expect(s).toContain("src/adapters/pi-compat.ts");
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      peerDependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      peerDependenciesMeta: Record<string, { optional: boolean }>;
      dependencies?: Record<string, string>;
    };
    const names = Object.keys(pkg.peerDependencies).filter((n) => n.startsWith("@earendil-works/"));
    expect(names.length).toBe(3);
    for (const n of names) {
      expect(s, `${n} range drifted from package.json`).toContain(pkg.peerDependencies[n]!);
      expect(s).toContain(n);
      expect(pkg.peerDependencies[n]).toBe(">=1.5.0 <1.6.0");
      expect(pkg.devDependencies[n]).toBe("1.5.0");
      expect(pkg.peerDependenciesMeta[n]?.optional).toBe(true);
    }
  });

  it("current baseline documents the breaking floor without widening tested patches", () => {
    const s = section("pi peer bump checklist");
    for (const text of [
      "Breaking Change",
      "pi 1.0–1.4 are no longer supported",
      'TESTED_PI_RANGE = "1.5.0 - 1.5.0"',
      "1.5.1 remain untested and warn",
    ])
      expect(s).toContain(text);
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    for (const text of [">=1.5.0 <1.6.0", "Breaking Change", "1.5.1"]) expect(readme).toContain(text);
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies["@sinclair/typebox"]).toBe("*");
  });

  it("K4: frozen-artifact tables list every A/A′ golden and each exists on disk", () => {
    const s = section("Frozen artifacts");
    const files = [
      "fabric-xs-off-golden.json",
      "fabric-wake-off-golden.json",
      "fabric-xs-reply-off-golden.json",
      "compact-hint-golden.json",
      "schedule-off-golden.json",
      "secure-off-golden.json",
      "secure-contract-parity.json",
      "keepalive-legacy-golden.json",
      "bash-tools-golden.json",
      "legacy-xs-v071/",
      "secure-launcher-off-golden.json",
    ];
    const all = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? [`${n}/`, ...all(join(dir, n))] : [n]));
    const onDisk = all(join(ROOT, "tests", "fixtures"));
    for (const f of files) {
      expect(s, `${f} not in the frozen table`).toContain(f);
      expect(onDisk, `${f} not on disk`).toContain(f);
    }
  });

  it("K5: Releasing keeps the branch/version/changelog anchors", () => {
    const s = section("Releasing");
    for (const a of [
      "A **patch** release is cut",
      "releasing minor/major on `dev` is forbidden",
      "at least 50 `feat` commits",
      "**CHANGELOG is generated, never hand-edited**",
      "scripts/release/release.sh <version>",
    ]) {
      expect(s, a).toContain(a);
    }
  });

  it("K6: pi-extension specifics keeps the easy-to-get-wrong rules", () => {
    const s = section("pi-extension specifics");
    for (const a of ["jiti", "/reload", "module scope", "HOST_KEY", "inert", "unref()"]) expect(s, a).toContain(a);
  });

  it("K7: rename rule and the global invariants (HOST_KEY / unref / runtime old names)", () => {
    expect(section("What this is")).toContain('Do NOT "finish the rename" inside');
    const inv = section("Global invariants");
    for (const a of [
      "HOST_KEY",
      "initSecureDomain()",
      "unref()",
      "pi-subagent.json",
      'Symbol.for("pi-subagent:',
      "subagent:*",
      "[pi-subagent]",
    ]) {
      expect(inv, a).toContain(a);
    }
  });

  it("K8: every docs/dev README linked from AGENTS.md exists", () => {
    const links = [...agents.matchAll(/docs\/dev\/[\w./-]+?\/README\.md/g)].map((m) => m[0]);
    expect(links.length).toBeGreaterThan(20);
    for (const l of new Set(links)) expect(existsSync(join(ROOT, l)), l).toBe(true);
  });

  it("K9: every first-level src/ directory is registered in Repository layout", () => {
    const s = section("Repository layout");
    const dirs = readdirSync(join(ROOT, "src")).filter((n) => statSync(join(ROOT, "src", n)).isDirectory());
    expect(dirs.length).toBeGreaterThan(30);
    for (const d of dirs) expect(s, `src/${d}/ not in the layout table`).toContain(`src/${d}/`);
    const fastRow = s.split("\n").filter((line) => line.startsWith("| `src/fast/`"));
    expect(fastRow).toHaveLength(1);
    expect(fastRow[0]).toContain("docs/dev/fast-command/README.md");
  });
});
