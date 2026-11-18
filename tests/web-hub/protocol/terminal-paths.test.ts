import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { TERMINAL_V2_HTTP_PATHS as v2Eager } from "../../../src/web-hub/protocol/http-contract.js";
import {
  TERMINAL_V2_CAP,
  TERMINAL_V2_HTTP_PATHS as v2Tiny,
  terminalV2Files,
} from "../../../src/web-hub/protocol/terminal-v2-paths.js";
import { TERMINAL_V2_HTTP_PATHS as v2Private } from "../../../src/web-hub/protocol/terminal-v2.js";

const protocol = fileURLToPath(new URL("../../../src/web-hub/protocol/", import.meta.url));
/** Follow static emitted imports/re-exports, not erased type-only edges or lazy import(). */
function runtimeImports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly) continue;
      if (
        clause &&
        !clause.name &&
        clause.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.length > 0 &&
        clause.namedBindings.elements.every((e) => e.isTypeOnly)
      )
        continue;
      if (ts.isStringLiteral(statement.moduleSpecifier)) imports.push(statement.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && !statement.isTypeOnly) {
      if (
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.length > 0 &&
        statement.exportClause.elements.every((e) => e.isTypeOnly)
      )
        continue;
      if (ts.isStringLiteral(statement.moduleSpecifier)) imports.push(statement.moduleSpecifier.text);
    }
  }
  return imports;
}
function runtimeGraph(entry: string): Set<string> {
  const seen = new Set<string>(),
    pending = [entry];
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of runtimeImports(file)) {
      if (!specifier.startsWith(".")) {
        seen.add(specifier);
        continue;
      }
      pending.push(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
    }
  }
  return seen;
}
describe("terminal eager path boundary (P1-C A)", () => {
  it("declares only v2 paths without advertising legacy routes", () => {
    expect(v2Tiny).toBe(v2Eager);
    expect(v2Tiny).toBe(v2Private);
    expect(Object.isFrozen(v2Tiny)).toBe(true);
    expect(TERMINAL_V2_CAP).toBe("terminal.tabs.v2");
    expect(Object.keys(v2Tiny)).toEqual([
      "list",
      "create",
      "creation",
      "rename",
      "close",
      "view",
      "input",
      "resize",
      "ack",
    ]);
    for (const [op, path] of Object.entries(v2Tiny)) expect(path).toBe(`/api/terminal/v2/${op}`);
    expect(terminalV2Files("/isolated/state")).toEqual({
      root: "/isolated/state/terminal-v2",
      ledger: "/isolated/state/terminal-v2/ledger.json",
      marker: "/isolated/state/terminal-v2/marker.json",
      witness: "/isolated/state/.terminal-initialized-v2",
      archive: "/isolated/state/.terminal-allocation-archive-v2",
    });
  });
  it("keeps the http-contract runtime import graph away from terminal schema construction", () => {
    const graph = runtimeGraph(resolve(protocol, "http-contract.ts"));
    expect(graph.has(resolve(protocol, "terminal.ts"))).toBe(false);
    expect(runtimeImports(resolve(protocol, "terminal-v2-paths.ts"))).toEqual([]);
    expect(runtimeImports(resolve(protocol, "terminal-v2-values.ts"))).toEqual([]);
    expect(graph.has(resolve(protocol, "terminal-v2.ts"))).toBe(false);
    expect([...graph].filter((id) => id.includes("typebox"))).toEqual([]);
  });
});
