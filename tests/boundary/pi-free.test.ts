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

  it("#39 pure scoped kernels and child-bind stay pi-free (PI-facing owner/wire are not pure domain)", () => {
    const names = [
      "types",
      "limits",
      "authorize",
      "op-cap",
      "session-command",
      "session-fold",
      "session-ops",
      "session-poison",
      "session-store",
      "session-section",
      "hub-slot",
      "hub-store",
      "hub-management",
      "hub-section",
      "render",
      "child-bind",
    ];
    const roots = names.map((name) => resolve(ROOT, `src/memory/scopes/${name}.ts`));
    for (const file of roots) expect(existsSync(file), file).toBe(true);
    const offenders = memoryOffenders(roots);
    expect(offenders, offenders.join("; ")).toEqual([]);
  });

  it("unified memory dispatcher/adapters and shared scoped operations stay pi-free", () => {
    const roots = [
      ...globSync("src/memory/unified/**/*.ts", { cwd: ROOT }),
      "src/memory/scopes/tool-surface.ts",
      "src/memory/scopes/tool-operations.ts",
    ].map((file) => resolve(ROOT, file));
    expect(roots.length).toBeGreaterThanOrEqual(6);
    const offenders = memoryOffenders(roots);
    expect(offenders, offenders.join("; ")).toEqual([]);
  });

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

  // jev-reflex plan R0 (PD3/PD4): reflex core/ports are checked by value closure (they import
  // topic-switch/memory/core helpers from outside their directory, so the directory loop above does not fit).
  it("reflex core/** value closure stays pi-free", () => {
    const roots = globSync("src/reflex/core/**/*.ts", { cwd: ROOT }).map((file) => resolve(ROOT, file));
    expect(roots.length, "reflex core roots must be discovered").toBeGreaterThanOrEqual(2);
    const offenders = memoryOffenders(roots);
    expect(offenders, offenders.join("; ")).toEqual([]);
  });

  it("reflex ports/** value closure stays pi-free", () => {
    const roots = globSync("src/reflex/ports/*.ts", { cwd: ROOT }).map((file) => resolve(ROOT, file));
    expect(roots.length, "reflex ports roots must be discovered").toBeGreaterThanOrEqual(1);
    const offenders = memoryOffenders(roots);
    expect(offenders, offenders.join("; ")).toEqual([]);
  });

  // #25 B0 (BA §4.6, X2): the runtime draft loader lives outside core/ but is pure Node — its
  // value closure must stay pi-free just like core/** and ports/*.
  it("reflex drafts/** value closure stays pi-free", () => {
    const roots = globSync("src/reflex/drafts/*.ts", { cwd: ROOT }).map((file) => resolve(ROOT, file));
    expect(roots.length, "reflex drafts roots must be discovered").toBeGreaterThanOrEqual(1);
    const offenders = memoryOffenders(roots);
    expect(offenders, offenders.join("; ")).toEqual([]);
  });

  // J1 (jev-plan §4 J1 / arch §3.2): everything under src/memory/jev/ except
  // wire.ts + segment.ts (the only pi-facing modules), plus the shared
  // secret-patterns root. Later jev packages' new files are constrained
  // automatically by the glob.
  it("memory jev/* (minus wire/segment) and secret-patterns stay pi-free", () => {
    const roots = [
      ...globSync("src/memory/jev/*.ts", { cwd: ROOT })
        .filter((file) => !file.endsWith("wire.ts") && !file.endsWith("segment.ts"))
        .map((file) => resolve(ROOT, file)),
      // predict/ (plan.md v3.2 §11.1): the whole P layer is pi-free, no exceptions.
      ...globSync("src/memory/jev/predict/*.ts", { cwd: ROOT }).map((file) => resolve(ROOT, file)),
      resolve(ROOT, "src/memory/secret-patterns.ts"),
    ];
    expect(roots.length, "jev roots must be discovered").toBeGreaterThanOrEqual(8);
    const offenders = memoryOffenders(roots);
    expect(offenders, offenders.join("; ")).toEqual([]);
  });

  // #36 memory-governance plan §4 P0 / arch §3.1: blocks/ and govern/ are new
  // pi-free roots. P0 pins the boundary AHEAD of the directories existing
  // (P1 lands blocks/, P3/P5a land govern/) — the assertion covers whatever
  // the globs discover, so the first file added there is already bound. No
  // minimum-count assertion until the directories exist (that would fail on
  // the P0 baseline); P1's verifier should re-check this file's coverage.
  it("memory blocks/* and govern/* value closures stay pi-free (#36)", () => {
    const roots = [
      ...globSync("src/memory/blocks/*.ts", { cwd: ROOT }).map((file) => resolve(ROOT, file)),
      ...globSync("src/memory/govern/*.ts", { cwd: ROOT }).map((file) => resolve(ROOT, file)),
    ];
    // The glob must be wired to reality: a directory that exists yields at
    // least one root (a silent glob typo would otherwise make the pi-free
    // check vacuously green once P1/P3/P5a land).
    for (const dir of ["blocks", "govern"]) {
      const dirPath = resolve(ROOT, `src/memory/${dir}`);
      const discovered = roots.filter((file) => file.startsWith(`${dirPath}/`)).length;
      if (existsSync(dirPath)) {
        expect(discovered, `src/memory/${dir} exists but the glob matched nothing`).toBeGreaterThan(0);
      } else {
        expect(discovered).toBe(0);
      }
    }
    const offenders = memoryOffenders(roots);
    expect(offenders, offenders.join("; ")).toEqual([]);
  });
});
