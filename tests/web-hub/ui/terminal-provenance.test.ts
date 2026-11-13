import { describe, expect, it } from "vitest";
import {
  sha256Hex,
  uniquePackages,
  verifyProvenance,
  type UiProvenance,
} from "../../../scripts/web-hub/lib/ui-provenance.js";
import {
  TERMINAL_JS_BUDGET_GZIP_BYTES,
  TERMINAL_CSS_BUDGET_GZIP_BYTES,
  TERMINAL_HOST_BUDGET_GZIP_BYTES,
  terminalExclusiveSet,
  verifyTerminalProvenance,
} from "../../../scripts/web-hub/lib/terminal-provenance.js";
import { budgetExceeded, gzipBytes } from "../../../scripts/web-hub/check-ui-dist.js";
import { classifyChunkModules, computeExclusiveSets } from "../../../src/web-hub/ui/mermaid-provenance-plugin.js";

const path = "assets/term-impl-abcdefgh.js";
const cssPath = "assets/xterm-abcdefgh.css";
const sourceModule = "node_modules/@xterm/xterm/css/xterm.css?url";
const bytes = Buffer.from(".terminal { color: red; }");
function fixture(): UiProvenance {
  return {
    v: 1,
    implInGraph: false,
    embedded: {},
    chunks: {
      [path]: {
        sha256: sha256Hex("terminal"),
        mermaidExclusive: false,
        terminalExclusive: true,
        containsTerminalImpl: true,
        containsImpl: false,
        containsElk: false,
        packages: [{ name: "@xterm/xterm", version: "6.0.0", license: "MIT", dir: "node_modules/@xterm/xterm" }],
      },
      "assets/terminal-spike-abcdefgh.js": {
        sha256: sha256Hex("host"),
        mermaidExclusive: false,
        terminalHost: true,
        containsImpl: false,
        containsElk: false,
        packages: [],
      },
    },
    terminal: {
      implInGraph: true,
      css: {
        [cssPath]: {
          sha256: sha256Hex(bytes),
          sourceSha256: sha256Hex(bytes),
          sourceModule,
          packages: [{ name: "@xterm/xterm", version: "6.0.0", license: "MIT", dir: "node_modules/@xterm/xterm" }],
        },
        "assets/terminal-abcdefgh.css": {
          sha256: sha256Hex(bytes),
          sourceSha256: sha256Hex(bytes),
          sourceModule: "terminal.css?url",
          packages: [],
        },
      },
    },
  };
}
function verify(prov: UiProvenance, firstScreen = new Set<string>(), html = "") {
  return verifyTerminalProvenance(
    prov,
    firstScreen,
    new Map([
      [cssPath, bytes],
      ["assets/terminal-abcdefgh.css", bytes],
    ]),
    html,
    new Map([
      [sourceModule, bytes],
      ["terminal.css?url", bytes],
    ]),
  );
}

describe("terminal P0 provenance gates", () => {
  it("uses independent total budgets with inclusive boundaries", () => {
    expect([TERMINAL_JS_BUDGET_GZIP_BYTES, TERMINAL_CSS_BUDGET_GZIP_BYTES, TERMINAL_HOST_BUDGET_GZIP_BYTES]).toEqual([
      262144, 16384, 4096,
    ]);
    for (const budget of [262144, 16384, 4096]) {
      expect(budgetExceeded(budget, budget)).toBe(false);
      expect(budgetExceeded(budget + 1, budget)).toBe(true);
    }
    expect(gzipBytes("terminal")).toBeGreaterThan(0);
  });
  it("accepts graph/SHA-bound exclusive JS and CSS and includes CSS licences", () => {
    expect(verify(fixture())).toEqual([]);
    expect([...terminalExclusiveSet(fixture())]).toEqual([path]);
    const prov = fixture();
    prov.chunks[path]!.packages = [];
    expect(uniquePackages(prov).map((p) => p.name)).toContain("@xterm/xterm");
  });
  it("rejects first-screen reachability and overlap with the mermaid allowance", () => {
    expect(verify(fixture(), new Set([path])).join()).toContain("overlap");
    const prov = fixture();
    prov.chunks[path]!.mermaidExclusive = true;
    expect(verify(prov).join()).toContain("overlap");
  });
  it("rejects filename-only classification, escaped xterm and version drift", () => {
    const prov = fixture();
    prov.chunks[path]!.terminalExclusive = false;
    expect(verify(prov).join()).toContain("mismatch");
    expect(verify(prov).join()).toContain("outside terminal closure");
    const wrong = fixture();
    wrong.chunks[path]!.packages[0]!.version = "6.0.1";
    expect(verify(wrong).join()).toContain("unsupported");
  });
  it("rejects CSS tampering, source drift, preloading and missing assets", () => {
    const tampered = fixture();
    tampered.terminal!.css[cssPath]!.sha256 = "0".repeat(64);
    expect(verify(tampered).join()).toContain("stale");
    const source = fixture();
    source.terminal!.css[cssPath]!.sourceSha256 = "0".repeat(64);
    expect(verify(source).join()).toContain("source changed");
    expect(verify(fixture(), new Set(), `<link href="/${cssPath}">`).join()).toContain("first screen");
    const missing = fixture();
    delete missing.terminal!.css[cssPath];
    expect(verify(missing).join()).toContain("exactly two");
  });
  it("rejects JS tampering through the shared SHA gate", () => {
    expect(verifyProvenance(fixture(), new Map([[path, Buffer.from("changed")]])).join()).toContain("sha256 differs");
  });
  it("derives exclusivity from the graph and identifies mixed rendered chunks", () => {
    const nodes = {
      host: { importedIds: ["shared"], dynamicallyImportedIds: ["impl"], isEntry: true },
      impl: { importedIds: ["xterm", "css", "shared"], dynamicallyImportedIds: [] },
      xterm: { importedIds: [], dynamicallyImportedIds: [] },
      css: { importedIds: [], dynamicallyImportedIds: [] },
      shared: { importedIds: [], dynamicallyImportedIds: [] },
    };
    const exclusive = computeExclusiveSets(
      (id) => nodes[id as keyof typeof nodes],
      Object.keys(nodes),
      "impl",
    ).exclusive;
    expect([...exclusive].sort()).toEqual(["css", "impl", "xterm"]);
    expect(classifyChunkModules(["impl", "xterm"], exclusive).exclusive).toBe(true);
    expect(classifyChunkModules(["impl", "shared"], exclusive).mixed).toBe(true);
  });
});
