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
  });

  it("K3: peer bump checklist names pi-compat and the exact peer ranges from package.json", () => {
    const s = section("pi peer bump checklist");
    expect(s).toContain("src/adapters/pi-compat.ts");
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      peerDependencies: Record<string, string>;
    };
    const names = Object.keys(pkg.peerDependencies).filter((n) => n.startsWith("@earendil-works/"));
    expect(names.length).toBe(3);
    for (const n of names) {
      expect(s, `${n} range drifted from package.json`).toContain(pkg.peerDependencies[n]!);
      expect(s).toContain(n);
    }
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
  });
});
