import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { TERMINAL_HTTP_PATHS as tinyPaths } from "../../../src/web-hub/protocol/terminal-paths.js";
import { TERMINAL_HTTP_PATHS as privatePaths } from "../../../src/web-hub/protocol/terminal.js";
import { TERMINAL_HTTP_PATHS as eagerPaths } from "../../../src/web-hub/protocol/http-contract.js";

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
  it("preserves every original value/order and shares one frozen object", () => {
    const original = {
      prepare: "/api/terminal/prepare",
      open: "/api/terminal/open",
      list: "/api/terminal/list",
      attach: "/api/terminal/attach",
      detach: "/api/terminal/detach",
      input: "/api/terminal/input",
      resize: "/api/terminal/resize",
      ack: "/api/terminal/ack",
      renew: "/api/terminal/renew",
      state: "/api/terminal/state",
      close: "/api/terminal/close",
    };
    expect(Object.entries(tinyPaths)).toEqual(Object.entries(original));
    expect(privatePaths).toBe(tinyPaths);
    expect(eagerPaths).toBe(tinyPaths);
    expect(Object.isFrozen(tinyPaths)).toBe(true);
  });
  it("keeps the http-contract runtime import graph away from terminal schema construction", () => {
    const graph = runtimeGraph(resolve(protocol, "http-contract.ts"));
    expect(graph.has(resolve(protocol, "terminal-paths.ts"))).toBe(true);
    expect(graph.has(resolve(protocol, "terminal.ts"))).toBe(false);
    expect(runtimeImports(resolve(protocol, "terminal-paths.ts"))).toEqual([]);
    expect([...graph].filter((id) => id.includes("typebox"))).toEqual([]);
  });
});
