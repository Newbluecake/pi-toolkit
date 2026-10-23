import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CheckError, classifyJsAssets, scanForbiddenPatterns } from "../../scripts/web-hub/check-ui-dist.ts";
import {
  exclusiveSet,
  exemptionsFor,
  mermaidGzipBytes,
  noticeSection,
  sha256Hex,
  verifyFirstScreenDisjoint,
  verifyImplChunk,
  verifyLicenses,
  verifyNaming,
  verifyNoKatex,
  verifyProvenance,
  type LicenseGateInput,
  type ThirdPartyOverrides,
  type VendoredBundled,
} from "../../scripts/web-hub/lib/ui-provenance.ts";
import { elkBanner, type ProvenanceChunk, type UiProvenance } from "../../src/web-hub/ui/mermaid-provenance-plugin.js";

/**
 * Synthetic-bundle tests for check:web's provenance gates (web-hub-mermaid plan §10.3, r3 R2-2/R2-7/R2-8).
 * No build is run: bundles, html and sidecars are hand-made so each rejection is isolated.
 */
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function chunk(source: string, extra: Partial<ProvenanceChunk> = {}): ProvenanceChunk {
  return {
    sha256: sha256Hex(enc(source)),
    mermaidExclusive: false,
    containsImpl: false,
    containsElk: false,
    packages: [],
    ...extra,
  };
}

/** A healthy synthetic dist: entry + shared + lazy business chunk + mermaid impl/core + public theme-init. */
function healthy(): { prov: UiProvenance; files: Map<string, string>; html: string } {
  const files = new Map<string, string>([
    [
      "theme-init.js",
      readFileSync(fileURLToPath(new URL("../../src/web-hub/ui/public/theme-init.js", import.meta.url)), "utf8"),
    ],
    [
      "assets/index-aaaaaaaa.js",
      'import"./shared-bbbbbbbb.js";const m=()=>import("./mmd-mermaid-impl-cccccccc.js");const b=()=>import("./Biz-dddddddd.js");',
    ],
    ["assets/shared-bbbbbbbb.js", "export const s=1;"],
    ["assets/Biz-dddddddd.js", "export const b=1;"],
    ["assets/mmd-mermaid-impl-cccccccc.js", 'import{c}from"./mmd-core-eeeeeeee.js";export const i=c;'],
    [
      "assets/mmd-core-eeeeeeee.js",
      'export const c=`<g style="x">`;/* https://chevrotain.io/docs */const g=Function("return this")();',
    ],
  ]);
  const chunks: Record<string, ProvenanceChunk> = {};
  for (const [path, src] of files) {
    chunks[path] = chunk(src, {
      mermaidExclusive: path.startsWith("assets/mmd-"),
      containsImpl: path === "assets/mmd-mermaid-impl-cccccccc.js",
    });
  }
  const prov: UiProvenance = { v: 1, implInGraph: true, chunks, embedded: {} };
  const html =
    '<script src="/theme-init.js"></script><script type="module" src="/assets/index-aaaaaaaa.js"></script><link rel="modulepreload" href="/assets/shared-bbbbbbbb.js">';
  return { prov, files, html };
}

const bytesOf = (files: Map<string, string>): Map<string, Uint8Array> =>
  new Map([...files].map(([k, v]) => [k, enc(v)]));

describe("verifyProvenance (sha binding, R2-2)", () => {
  it("accepts a consistent sidecar INCLUDING the real public/theme-init.js (recorded non-exclusive, never skipped)", () => {
    const { prov, files } = healthy();
    expect(prov.chunks["theme-init.js"]).toMatchObject({ mermaidExclusive: false, packages: [] });
    expect(verifyProvenance(prov, bytesOf(files))).toEqual([]);
  });

  it("rejects a js file whose bytes changed after the build (stale sha)", () => {
    const { prov, files } = healthy();
    files.set("assets/shared-bbbbbbbb.js", "export const s=2;");
    expect(verifyProvenance(prov, bytesOf(files)).join("\n")).toMatch(/assets\/shared-bbbbbbbb\.js: sha256 differs/);
  });

  it("rejects a dist js file missing from the sidecar — including a public/ file (no 'unrecorded files are skipped')", () => {
    const { prov, files } = healthy();
    delete (prov.chunks as Record<string, unknown>)["theme-init.js"];
    expect(verifyProvenance(prov, bytesOf(files)).join("\n")).toMatch(/theme-init\.js: not recorded/);
  });

  it("rejects a sidecar entry with no file on disk (extra entry)", () => {
    const { prov, files } = healthy();
    prov.chunks["assets/ghost-ffffffff.js"] = chunk("x");
    expect(verifyProvenance(prov, bytesOf(files)).join("\n")).toMatch(/ghost.*absent from dist/);
  });

  it("rejects a malformed sidecar", () => {
    expect(verifyProvenance({} as UiProvenance, new Map()).join("")).toMatch(/malformed/);
  });
});

describe("naming ⇔ exclusivity (name/provenance mismatch)", () => {
  it("accepts matching names", () => {
    expect(verifyNaming(healthy().prov)).toEqual([]);
  });
  it("rejects an mmd- file the sidecar calls non-exclusive", () => {
    const { prov } = healthy();
    prov.chunks["assets/mmd-core-eeeeeeee.js"]!.mermaidExclusive = false;
    expect(verifyNaming(prov).join("\n")).toMatch(/named mmd-\* but .* not mermaid-exclusive/);
  });
  it("rejects an exclusive file that is not named mmd-", () => {
    const { prov } = healthy();
    prov.chunks["assets/shared-bbbbbbbb.js"]!.mermaidExclusive = true;
    expect(verifyNaming(prov).join("\n")).toMatch(/not named assets\/mmd-\*/);
  });
});

describe("impl chunk invariants", () => {
  it("healthy: exactly one exclusive chunk contains the impl", () => {
    expect(verifyImplChunk(healthy().prov)).toEqual([]);
  });
  it("1. the impl statically imported by an entry: its chunk is not exclusive ⇒ fail", () => {
    const { prov } = healthy();
    prov.chunks["assets/mmd-mermaid-impl-cccccccc.js"]!.mermaidExclusive = false;
    expect(verifyImplChunk(prov).join("\n")).toMatch(/not mermaid-exclusive/);
  });
  it("two impl holders, or none while the graph has it ⇒ fail", () => {
    const a = healthy().prov;
    a.chunks["assets/mmd-core-eeeeeeee.js"]!.containsImpl = true;
    expect(verifyImplChunk(a).join("\n")).toMatch(/found 2/);
    const b = healthy().prov;
    b.chunks["assets/mmd-mermaid-impl-cccccccc.js"]!.containsImpl = false;
    expect(verifyImplChunk(b).join("\n")).toMatch(/found 0/);
  });
  it("a production build that never reaches the impl: zero holders and zero exclusive chunks is fine; exclusive chunks without an impl are not", () => {
    const { prov } = healthy();
    for (const c of Object.values(prov.chunks)) {
      c.mermaidExclusive = false;
      c.containsImpl = false;
    }
    prov.implInGraph = false;
    expect(verifyImplChunk(prov)).toEqual([]);
    prov.chunks["assets/mmd-core-eeeeeeee.js"]!.mermaidExclusive = true;
    expect(verifyImplChunk(prov).join("\n")).toMatch(/although mermaid-impl is not in the module graph/);
  });
});

describe("first screen ∩ exclusive = ∅ (checked BEFORE subtraction) + classifyJsAssets recursion", () => {
  it("healthy: disjoint", () => {
    const { prov, files, html } = healthy();
    const c = classifyJsAssets(html, files);
    expect(verifyFirstScreenDisjoint(c.firstScreen, prov)).toEqual([]);
    expect(c.firstScreen.has("assets/shared-bbbbbbbb.js")).toBe(true);
    expect(c.lazy.has("assets/Biz-dddddddd.js")).toBe(true);
    expect(c.lazy.has("assets/mmd-mermaid-impl-cccccccc.js")).toBe(true);
  });

  it("2. a modulepreload'd chunk that STATICALLY imports an mmd- file is found by the always-on recursion (the old `modulePreloads.length === 0` guard hid it)", () => {
    const { prov, files, html } = healthy();
    files.set("assets/shared-bbbbbbbb.js", 'import"./mmd-core-eeeeeeee.js";export const s=1;');
    const c = classifyJsAssets(html, files);
    expect(c.firstScreen.has("assets/mmd-core-eeeeeeee.js")).toBe(true);
    expect(verifyFirstScreenDisjoint(c.firstScreen, prov).join("\n")).toMatch(
      /mmd-core-eeeeeeee\.js: mermaid-exclusive file is loaded on the first screen/,
    );
  });

  it("an entry that statically imports the impl chunk is first-screen ⇒ disjointness fails", () => {
    const { prov, files, html } = healthy();
    files.set("assets/index-aaaaaaaa.js", 'import"./mmd-mermaid-impl-cccccccc.js";');
    const c = classifyJsAssets(html, files);
    expect(verifyFirstScreenDisjoint(c.firstScreen, prov)).not.toEqual([]);
  });

  it("static recursion also follows chains through preloaded chunks and ignores dynamic import()", () => {
    const files = new Map([
      ["assets/e.js", 'const d=()=>import("./lazy.js");'],
      ["assets/p.js", 'import"./q.js";'],
      ["assets/q.js", "export{}"],
      ["assets/lazy.js", "export{}"],
    ]);
    const c = classifyJsAssets(
      '<script type="module" src="/assets/e.js"></script><link rel="modulepreload" href="/assets/p.js">',
      files,
    );
    expect([...c.firstScreen].sort()).toEqual(["assets/e.js", "assets/p.js", "assets/q.js"]);
    expect([...c.lazy]).toEqual(["assets/lazy.js"]);
  });
});

describe("scanForbiddenPatterns: exemptions are per-file and provenance-proven (§7.3 step 5)", () => {
  const MERMAID_STYLE = 'x=`<g style="a:b">`;';
  const LODASH = 'const g=Function("return this")();';

  it("3. a NON-exclusive lazy business chunk with `style=` gets no exemption and fails", () => {
    const { prov } = healthy();
    expect(exemptionsFor("assets/Biz-dddddddd.js", prov)).toBe(false);
    expect(() =>
      scanForbiddenPatterns(MERMAID_STYLE, "assets/Biz-dddddddd.js", exemptionsFor("assets/Biz-dddddddd.js", prov)),
    ).toThrow(/static style= attribute/);
    expect(() => scanForbiddenPatterns(LODASH, "assets/Biz-dddddddd.js", false)).toThrow(/Function\(/);
  });

  it("8. positive: in a provenance-exclusive mmd- file the two exemptions and the extra doc URLs pass", () => {
    const { prov, files } = healthy();
    const path = "assets/mmd-core-eeeeeeee.js";
    expect(exemptionsFor(path, prov)).toBe(true);
    expect(() => scanForbiddenPatterns(files.get(path)!, path, true)).not.toThrow();
    for (const url of [
      "https://chevrotain.io/docs",
      "https://langium.org/x",
      "https://en.wikipedia.org/wiki/X",
      "http://www.eclipse.org/elk/",
      "http://www.eclipse.org/emf/2002/Ecore",
      "http:///org/eclipse/emf/ecore/EcorePackage",
    ]) {
      expect(() => scanForbiddenPatterns(`x="${url}"`, path, true), url).not.toThrow();
      expect(() => scanForbiddenPatterns(`x="${url}"`, "assets/app-aaaaaaaa.js", false), url).toThrow(/allowlist/);
    }
  });

  it("the never-exempt patterns stay forbidden even in an exclusive file", () => {
    for (const bad of [
      "eval(1)",
      "new Function('x')",
      "x='<style>'",
      "x='<script>'",
      'x="<a onclick=1>"',
      "//# sourceMappingURL=x.map",
      "x='http://evil.example/a'",
    ]) {
      expect(() => scanForbiddenPatterns(bad, "assets/mmd-core-eeeeeeee.js", true), bad).toThrow(CheckError);
    }
  });

  it("the real public/theme-init.js passes the ordinary (non-exempt) scan", () => {
    const { files } = healthy();
    expect(() => scanForbiddenPatterns(files.get("theme-init.js")!, "theme-init.js", false)).not.toThrow();
  });
});

describe("D2: katex must not be bundled; budget helper", () => {
  it("7. a package named katex in any chunk ⇒ fail", () => {
    const { prov } = healthy();
    expect(verifyNoKatex(prov)).toEqual([]);
    prov.chunks["assets/mmd-core-eeeeeeee.js"]!.packages = [
      { name: "katex", version: "0.16.0", license: "MIT", dir: "node_modules/katex" },
    ];
    expect(verifyNoKatex(prov).join("\n")).toMatch(/katex/);
  });

  it("the mermaid gzip total only counts exclusive files", () => {
    const { prov } = healthy();
    const gz = new Map([
      ["assets/mmd-core-eeeeeeee.js", 100],
      ["assets/mmd-mermaid-impl-cccccccc.js", 50],
      ["assets/Biz-dddddddd.js", 999],
    ]);
    expect(mermaidGzipBytes(prov, gz)).toBe(150);
    expect(exclusiveSet(prov).size).toBe(2);
  });
});

/* ------------------------------------------------------------------------------ licence gate */

const ELK_LICENSE = "# Eclipse Public License - v 2.0\n\nTHE ACCOMPANYING PROGRAM ...\n";

function licenseFixture(): LicenseGateInput & { notices: string } {
  const prov: UiProvenance = {
    v: 1,
    implInGraph: true,
    chunks: {
      "assets/mmd-a-aaaaaaaa.js": chunk("a", {
        mermaidExclusive: true,
        packages: [
          { name: "pkg-a", version: "1.0.0", license: "MIT", dir: "node_modules/pkg-a" },
          { name: "khroma", version: "2.1.0", license: null, dir: "node_modules/khroma" },
        ],
      }),
      "assets/mmd-elk-bbbbbbbb.js": chunk("elk", {
        mermaidExclusive: true,
        containsElk: true,
        packages: [{ name: "elkjs", version: "0.9.3", license: "EPL-2.0", dir: "node_modules/elkjs" }],
      }),
    },
    embedded: { "outer@2.0.0": [{ file: "dist/x.mjs", sha256: "a".repeat(64), components: ["inner@1.0.0"] }] },
  };
  const vendored: VendoredBundled = {
    v: 1,
    outer: {
      "outer@2.0.0": {
        artifacts: { "dist/x.mjs": "a".repeat(64) },
        components: [
          {
            name: "inner",
            version: "1.0.0",
            license: "MIT",
            source: "https://example.test/inner",
            evidence: "tarball",
            copyrightLines: ["Copyright (c) 2020 Inner Authors"],
            licenseText: "MIT\n\nCopyright (c) 2020 Inner Authors\n\nPermission is hereby granted…",
            noticeText: null,
          },
        ],
      },
    },
  };
  const overrides: ThirdPartyOverrides = { "khroma@2.1.0": { license: "MIT", evidence: "verified" } };
  const entry = (id: string, spdx: string, body: string): string =>
    `\n---\n\n## ${id}\n\n- **Version**: x\n- **License**: ${spdx}\n\n\`\`\`\n${body}\n\`\`\`\n`;
  const notices =
    "# Third-Party Notices\n" +
    entry(
      "pkg-a@1.0.0",
      "MIT",
      "Copyright (c) 2019 A Authors\nlicense text\n## looks like a heading inside a licence text\nmore",
    ) +
    entry("khroma@2.1.0", "MIT", "Copyright (c) 2019 Fabio") +
    entry(
      "elkjs@0.9.3",
      "EPL-2.0",
      `Copyright (c) 2017 Kiel University and others.\nCopyright (c) 2021 Kiel University and others.\nCopyright 2020 Google LLC\nEclipse Public License - v 2.0\nhttps://github.com/kieler/elkjs\nEPL-2.0 §3.1(a) source availability\n${ELK_LICENSE}`,
    ) +
    entry("inner@1.0.0", "MIT", "Copyright (c) 2020 Inner Authors");
  const facts: Record<string, { licenseTexts: string[]; noticeTexts: string[] }> = {
    "pkg-a@1.0.0": { licenseTexts: ["Copyright (c) 2019 A Authors\nlicense text"], noticeTexts: [] },
    "khroma@2.1.0": { licenseTexts: ["Copyright (c) 2019 Fabio"], noticeTexts: [] },
    "elkjs@0.9.3": { licenseTexts: [ELK_LICENSE], noticeTexts: [] },
  };
  return {
    prov,
    notices,
    overrides,
    vendored,
    packageFacts: (p) => facts[`${p.name}@${p.version}`] ?? null,
    elkChunkHeads: new Map([["assets/mmd-elk-bbbbbbbb.js", `${elkBanner("0.9.3")}import{a}from"./x.js";`]]),
    expectedElkBanner: elkBanner("0.9.3"),
  };
}

describe("verifyLicenses (§8.4 + R2-7)", () => {
  it("accepts a fully covered, well-formed fixture (a `## ` heading inside licence text does not split the entry)", () => {
    expect(verifyLicenses(licenseFixture())).toEqual([]);
    const f = licenseFixture();
    expect(noticeSection(f.notices, "pkg-a", "1.0.0")).toContain("more");
  });

  it("a package missing from the notices, or with the wrong licence stated, fails", () => {
    const a = licenseFixture();
    a.notices = a.notices.replace("## pkg-a@1.0.0", "## pkg-zzz@1.0.0");
    expect(verifyLicenses(a).join("\n")).toMatch(/pkg-a@1\.0\.0: missing from THIRD_PARTY_NOTICES/);
    const b = licenseFixture();
    b.notices = b.notices.replace("- **License**: MIT", "- **License**: ISC");
    expect(verifyLicenses(b).join("\n")).toMatch(/does not state licence MIT/);
  });

  it("a licence outside the allow-list fails", () => {
    const f = licenseFixture();
    f.prov.chunks["assets/mmd-a-aaaaaaaa.js"]!.packages[0]!.license = "GPL-3.0";
    expect(verifyLicenses(f).join("\n")).toMatch(/GPL-3\.0.*not on the allow-list/);
  });

  it("`license: null` needs a name@version override; a version bump invalidates it", () => {
    const f = licenseFixture();
    f.overrides = {};
    expect(verifyLicenses(f).join("\n")).toMatch(/khroma@2\.1\.0: no licence field and no entry/);
    const g = licenseFixture();
    g.prov.chunks["assets/mmd-a-aaaaaaaa.js"]!.packages[1]!.version = "2.2.0";
    expect(verifyLicenses(g).join("\n")).toMatch(/khroma@2\.2\.0: no licence field and no entry/);
  });

  it("every copyright line of the package's own LICENSE must appear in its entry; NOTICE content too (Apache)", () => {
    const f = licenseFixture();
    const inner = f.packageFacts;
    f.packageFacts = (p) => {
      const base = inner(p);
      if (p.name !== "pkg-a" || !base) return base;
      return {
        licenseTexts: [`${base.licenseTexts[0]}\nCopyright (c) 2018 Someone Else`],
        noticeTexts: ["This product includes software developed by X."],
      };
    };
    const msg = verifyLicenses(f).join("\n");
    expect(msg).toMatch(/copyright line missing .*Someone Else/);
    expect(msg).toMatch(/NOTICE file content missing/);
  });

  it("R2-7: an outer package embedding components without a vendored entry fails; a changed artifact sha fails; stale/undeclared components fail", () => {
    const none = licenseFixture();
    none.vendored = { v: 1, outer: {} };
    expect(verifyLicenses(none).join("\n")).toMatch(/outer@2\.0\.0: embeds third-party components but has no entry/);

    const changed = licenseFixture();
    changed.prov.embedded["outer@2.0.0"]![0]!.sha256 = "b".repeat(64);
    expect(verifyLicenses(changed).join("\n")).toMatch(/artifact dist\/x\.mjs changed \(sha256\)/);

    const undeclared = licenseFixture();
    undeclared.prov.embedded["outer@2.0.0"]![0]!.components.push("sneaky@9.9.9");
    expect(verifyLicenses(undeclared).join("\n")).toMatch(/embedded component sneaky@9\.9\.9 is not declared/);

    const stale = licenseFixture();
    stale.vendored.outer["outer@2.0.0"]!.components.push({
      ...stale.vendored.outer["outer@2.0.0"]!.components[0]!,
      name: "gone",
    });
    expect(verifyLicenses(stale).join("\n")).toMatch(/declared component gone@1\.0\.0 is no longer embedded/);

    const noNotice = licenseFixture();
    noNotice.notices = noNotice.notices.replace("## inner@1.0.0", "## innerx@1.0.0");
    expect(verifyLicenses(noNotice).join("\n")).toMatch(
      /inner@1\.0\.0 \(bundled in outer@2\.0\.0\): missing from THIRD_PARTY_NOTICES/,
    );
  });

  it("an outer-package version bump (new outer key) is treated as unreviewed", () => {
    const f = licenseFixture();
    f.prov.embedded = { "outer@2.0.1": f.prov.embedded["outer@2.0.0"]! };
    expect(verifyLicenses(f).join("\n")).toMatch(/outer@2\.0\.1: embeds third-party components but has no entry/);
  });

  it("§8.3/R2-8: the ELK chunk must START with the banner for the bundled version, and elkjs's entry must carry the §3.1(a) statement", () => {
    const f = licenseFixture();
    f.elkChunkHeads = new Map([["assets/mmd-elk-bbbbbbbb.js", `import{a}from"./x.js";${elkBanner("0.9.3")}`]]);
    expect(verifyLicenses(f).join("\n")).toMatch(/does not start with the EPL notice banner/);
    const g = licenseFixture();
    g.expectedElkBanner = elkBanner("0.9.4");
    expect(verifyLicenses(g).join("\n")).toMatch(/does not start with the EPL notice banner/);
    const h = licenseFixture();
    h.notices = h.notices.replace("§3.1(a)", "§X");
    expect(verifyLicenses(h).join("\n")).toMatch(/elkjs@0\.9\.3: notices entry lacks "3\.1\(a\)"/);
  });
});
