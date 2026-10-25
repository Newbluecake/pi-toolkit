import { existsSync, globSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
type ImportRef = { kind: "value" | "type"; spec: string } | { kind: "unresolvable"; expression: string };

/** Classify syntax rather than text: comments/strings are not dependency edges. */
function scanSource(text: string, file = "fixture.ts"): ImportRef[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const refs: ImportRef[] = [];
  function add(argument: ts.Node | undefined, typeOnly: boolean): void {
    if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
      refs.push({ kind: typeOnly ? "type" : "value", spec: argument.text });
    } else {
      refs.push({ kind: "unresolvable", expression: argument?.getText(source) ?? "<missing>" });
    }
  }
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const typeOnly =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (!clause.name &&
            clause.namedBindings !== undefined &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.every((element) => element.isTypeOnly)));
      add(node.moduleSpecifier, typeOnly);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      add(
        node.moduleSpecifier,
        node.isTypeOnly ||
          (node.exportClause !== undefined &&
            ts.isNamedExports(node.exportClause) &&
            node.exportClause.elements.every((element) => element.isTypeOnly)),
      );
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression, node.isTypeOnly);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      add(node.arguments[0], false);
    } else if (ts.isImportTypeNode(node)) {
      add(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : node.argument, true);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return refs;
}

function scanImports(file: string): ImportRef[] {
  return scanSource(readFileSync(file, "utf8"), file);
}

function resolveImport(file: string, spec: string): string {
  const target = resolve(dirname(file), spec);
  if (target.endsWith(".js")) {
    const source = `${target.slice(0, -3)}.ts`;
    if (existsSync(source)) return source;
  }
  return target;
}

function inside(file: string, root: string): boolean {
  return file.startsWith(`${root}/`);
}

function label(file: string, ref: ImportRef): string {
  return `${relative(ROOT, file)} → ${ref.kind === "unresolvable" ? `unresolvable: ${ref.expression}` : ref.spec}`;
}

/** Follow only value edges, but reject computed imports everywhere reached. */
function memoryOffenders(roots: string[]): string[] {
  const rootSet = new Set(roots);
  const visited = new Set<string>();
  const pending = [...roots];
  const offenders: string[] = [];
  while (pending.length) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    for (const ref of scanImports(file)) {
      if (ref.kind === "unresolvable") {
        offenders.push(label(file, ref));
        continue;
      }
      if (ref.spec.startsWith("@earendil-works/") && (rootSet.has(file) || ref.kind === "value")) {
        offenders.push(label(file, ref));
      }
      if (ref.kind === "value" && ref.spec.startsWith(".")) {
        const target = resolveImport(file, ref.spec);
        if (!existsSync(target)) offenders.push(`${label(file, ref)} (missing target)`);
        else pending.push(target);
      }
    }
  }
  return offenders;
}

// source-governance r2.1 §4.2: the 13 required syntax examples, one assertion per form.
describe("pi-free AST scanner", () => {
  it.each([
    ['import "a"', [{ kind: "value", spec: "a" }]],
    ['import type { A } from "a"', [{ kind: "type", spec: "a" }]],
    ['import { type A } from "a"', [{ kind: "type", spec: "a" }]],
    ['import { type A, B } from "a"', [{ kind: "value", spec: "a" }]],
    ['import * as N from "a"', [{ kind: "value", spec: "a" }]],
    ['export type { A } from "a"', [{ kind: "type", spec: "a" }]],
    ['export { type A } from "a"', [{ kind: "type", spec: "a" }]],
    ['export * from "a"', [{ kind: "value", spec: "a" }]],
    ["import(`a`)", [{ kind: "value", spec: "a" }]],
    ["import(`${p}`)", [{ kind: "unresolvable", expression: "`${p}`" }]],
    ['require("a")', [{ kind: "value", spec: "a" }]],
    ['let t: typeof import("a")', [{ kind: "type", spec: "a" }]],
    ['// from "a"\nconst note = \'from "a"\';', []],
  ])("classifies %s", (text, expected) => {
    expect(scanSource(text as string)).toEqual(expected);
  });

  it.each([
    ['import A from "a"', [{ kind: "value", spec: "a" }]],
    ['import A, { type B } from "a"', [{ kind: "value", spec: "a" }]],
    ['export { type A, B } from "a"', [{ kind: "value", spec: "a" }]],
    ['export * as N from "a"', [{ kind: "value", spec: "a" }]],
    ['import A = require("a")', [{ kind: "value", spec: "a" }]],
    ['import type A = require("a")', [{ kind: "type", spec: "a" }]],
    ['let t: import("a").T', [{ kind: "type", spec: "a" }]],
    ["require(`a`)", [{ kind: "value", spec: "a" }]],
    ["require(path)", [{ kind: "unresolvable", expression: "path" }]],
    ["import(path)", [{ kind: "unresolvable", expression: "path" }]],
  ])("covers remaining AST categories: %s", (text, expected) => {
    expect(scanSource(text as string)).toEqual(expected);
  });
});

describe("pi-free boundaries", () => {
  for (const directory of ["core", "prompt-sections", "git"]) {
    it(`${directory}/ imports only node:* or its own relative files (including type imports)`, () => {
      const root = resolve(ROOT, `src/${directory}`);
      const files = globSync(`src/${directory}/**/*.ts`, { cwd: ROOT });
      expect(files.length, `src/${directory} must be discovered`).toBeGreaterThan(0);
      const offenders: string[] = [];
      for (const name of files) {
        const file = resolve(ROOT, name);
        for (const ref of scanImports(file)) {
          if (
            ref.kind === "unresolvable" ||
            (!ref.spec.startsWith("node:") &&
              !(ref.spec.startsWith(".") && inside(resolveImport(file, ref.spec), root)))
          ) {
            offenders.push(label(file, ref));
          }
        }
      }
      expect(offenders, offenders.join("; ")).toEqual([]);
    });
  }

  it("memory paths/frontmatter/store/render value closure stays pi-free; roots also reject pi types", () => {
    const roots = ["paths", "frontmatter", "store", "render"].flatMap((name) =>
      globSync(`src/memory/${name}.ts`, { cwd: ROOT }).map((file) => resolve(ROOT, file)),
    );
    for (const name of ["paths", "frontmatter", "store", "render"]) {
      expect(roots).toContain(resolve(ROOT, `src/memory/${name}.ts`));
    }
    const offenders = memoryOffenders(roots);
    expect(offenders, offenders.join("; ")).toEqual([]);
  });
});
