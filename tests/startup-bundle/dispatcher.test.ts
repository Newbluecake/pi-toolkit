import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, utimesSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * startup-bundle plan r3 §3.2 / §7.1: the root entry is a dispatcher, and the four routing
 * outcomes are contractual:
 *   with bundle → bundle;  without bundle → source;  bad bundle → throw (never fall back);
 *   PI_TOOLKIT_ENTRY=src → source even when the bundle exists.
 *
 * Each case runs in its own child process (§7.1 seam B: process boundaries isolate HOST_KEY, the
 * secure domain, module cache and the process-global hook marker without any manual reset).
 *
 * The layout is a REAL package skeleton — a verbatim copy of `index.ts` plus
 * `src/core/{bundle-entry,host-modules}.ts`, a stand-in `src/index.ts` that reports which path
 * ran, and a fake pi install tree (with its module copies) above it. Copying those three files is
 * what makes the bundle path controllable: `bundle-entry.ts` resolves `../../dist/bundle/index.js`
 * relative to its own file, so a copy under the temp root points at the temp root's dist/.
 */
const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/**
 * Absolute path to the TS loader for the child processes. A bare `--import tsx` is resolved from
 * the CHILD's cwd (the temp package, which has no node_modules) — that fails with
 * ERR_MODULE_NOT_FOUND. Resolving it here anchors it to this repository's devDependency.
 */
const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");

let tmp: { dir: string; cleanup: () => void } | undefined;
afterEach(() => {
  tmp?.cleanup();
  tmp = undefined;
});

interface Layout {
  dir: string;
  entry: string;
}

/** Build a package skeleton; `bundle` = the bundle source to write, or undefined for no dist/. */
function layout(bundle: string | undefined): Layout {
  const dir = mkdtempSync(join(tmpdir(), "pt-dispatch-"));
  tmp = { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };

  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pi-toolkit", type: "module" }));
  copyFileSync(join(ROOT, "index.ts"), join(dir, "index.ts"));

  mkdirSync(join(dir, "src", "core"), { recursive: true });
  copyFileSync(join(ROOT, "src", "core", "bundle-entry.ts"), join(dir, "src", "core", "bundle-entry.ts"));
  copyFileSync(join(ROOT, "src", "core", "host-modules.ts"), join(dir, "src", "core", "host-modules.ts"));
  // The source-path stand-in: records that the source branch ran, and nothing else.
  writeFileSync(
    join(dir, "src", "index.ts"),
    `export default async function activate(): Promise<void> {\n  process.stdout.write(JSON.stringify({ via: "source" }) + "\\n");\n}\n`,
  );

  if (bundle !== undefined) {
    mkdirSync(join(dir, "dist", "bundle"), { recursive: true });
    writeFileSync(join(dir, "dist", "bundle", "index.js"), bundle);
  }

  writeFakePiTree(dir);
  return { dir, entry: join(dir, "index.ts") };
}

const OK_BUNDLE = `export default async function activate() {\n  process.stdout.write(JSON.stringify({ via: "bundle" }) + "\\n");\n}\n`;

/** A pi install tree above <dir>: node_modules/@earendil-works/{pi-coding-agent,pi-tui,pi-ai} + typebox. */
function writeFakePiTree(dir: string): void {
  const modules = join(dir, "node_modules");
  const write = (relativePath: string, content: string): void => {
    const full = join(modules, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };

  write(
    "@earendil-works/pi-coding-agent/package.json",
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      type: "module",
      exports: { ".": { import: "./dist/index.js" } },
    }),
  );
  write("@earendil-works/pi-coding-agent/dist/index.js", "export const host = 'coding-agent';\n");
  write(
    "@earendil-works/pi-tui/package.json",
    JSON.stringify({ name: "@earendil-works/pi-tui", type: "module", exports: { ".": { import: "./dist/index.js" } } }),
  );
  write("@earendil-works/pi-tui/dist/index.js", "export class Container {}\n");
  write(
    "@earendil-works/pi-ai/package.json",
    JSON.stringify({
      name: "@earendil-works/pi-ai",
      type: "module",
      exports: { ".": { import: "./dist/index.js" }, "./compat": { import: "./dist/compat.js" } },
    }),
  );
  write("@earendil-works/pi-ai/dist/index.js", "export const ai = 'core';\n");
  write("@earendil-works/pi-ai/dist/compat.js", "export const ai = 'compat';\n");
  write(
    "typebox/package.json",
    JSON.stringify({
      name: "typebox",
      type: "module",
      exports: { ".": { import: "./build/index.mjs" }, "./value": { import: "./build/value/index.mjs" } },
    }),
  );
  write("typebox/build/index.mjs", "export const Type = {};\n");
  write("typebox/build/value/index.mjs", "export const Check = () => true;\n");
}

/** Run the dispatcher in a child process and report stdout/stderr/exit. */
function run(l: Layout, env: Record<string, string> = {}): { stdout: string; stderr: string; status: number | null } {
  const probe = join(l.dir, "probe.ts");
  writeFileSync(
    probe,
    `const entry = await import(${JSON.stringify(`./${"index.ts"}`)});\n` + `await entry.default({});\n`,
  );
  const result = spawnSync(process.execPath, ["--import", TSX_LOADER, probe], {
    cwd: l.dir,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      ...env,
      // Keep the temp package self-contained: no unrelated PI_* config from the developer's shell.
      PI_TOOLKIT_ENTRY: env["PI_TOOLKIT_ENTRY"] ?? "",
    },
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

describe("root entry dispatcher (plan §3.2)", () => {
  it("bundle present ⇒ bundle path, source never evaluated", () => {
    const l = layout(OK_BUNDLE);
    const r = run(l);
    expect(r.stdout).toContain('{"via":"bundle"}');
    expect(r.stdout).not.toContain('{"via":"source"}');
    expect(r.status).toBe(0);
  });

  it("stale bundle (src newer) ⇒ still loads the bundle, no stale warning", () => {
    const l = layout(OK_BUNDLE);
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(join(l.dir, "dist", "bundle", "index.js"), old, old);
    const r = run(l);
    expect(r.stdout).toContain('{"via":"bundle"}');
    expect(r.stderr).not.toContain("bundle is stale");
    expect(r.status).toBe(0);
  });

  it("no bundle ⇒ source path (git install / unbuilt checkout)", () => {
    const l = layout(undefined);
    const r = run(l);
    expect(r.stdout).toContain('{"via":"source"}');
    expect(r.status).toBe(0);
  });

  it("PI_TOOLKIT_ENTRY=src forces the source path even when the bundle exists", () => {
    const l = layout(OK_BUNDLE);
    const r = run(l, { PI_TOOLKIT_ENTRY: "src" });
    expect(r.stdout).toContain('{"via":"source"}');
    expect(r.stdout).not.toContain('{"via":"bundle"}');
  });

  it("a syntactically broken bundle throws — it must NOT silently fall back to source", () => {
    const l = layout("export default async function (");
    const r = run(l);
    expect(r.status).not.toBe(0);
    // The whole point: no source activation happened behind the user's back.
    expect(r.stdout).not.toContain('{"via":"source"}');
  });

  it("a bundle that throws at load time propagates the error, no fallback", () => {
    const l = layout('throw new Error("boom-bundle");\n');
    const r = run(l);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("boom-bundle");
    expect(r.stdout).not.toContain('{"via":"source"}');
  });

  it("a bundle whose default export is not callable throws (broken artifact is visible)", () => {
    const l = layout("export default 42;\n");
    const r = run(l);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("no default activate() export");
    expect(r.stdout).not.toContain('{"via":"source"}');
  });
});

describe("root entry surface (plan §3.2 / Blocker 1)", () => {
  it("exposes ONLY a default export — a named re-export would drag the source graph back in", () => {
    const probe = join(tmpdir(), `pt-root-surface-${process.pid}.mjs`);
    writeFileSync(
      probe,
      `const mod = await import(${JSON.stringify(`file://${join(ROOT, "index.ts").replace(/\\/g, "/")}`)});\n` +
        `process.stdout.write(JSON.stringify(Object.keys(mod)));\n`,
    );
    try {
      const result = spawnSync(process.execPath, ["--import", TSX_LOADER, probe], {
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(result.stdout).toBe('["default"]');
    } finally {
      rmSync(probe, { force: true });
    }
  });
});

describe("build script gates (plan §6.3)", () => {
  it("the bundle on disk is reproducible, within budget, src-only and dynamically import-free", () => {
    const bundlePath = join(ROOT, "dist", "bundle", "index.js");
    const exists = (() => {
      try {
        readFileSync(bundlePath);
        return true;
      } catch {
        return false;
      }
    })();
    // CI builds before testing; a developer checkout may simply not have run build:bundle yet.
    // The assertion is skipped only in that case — never to paper over a failing gate.
    if (!exists) return;

    const result = spawnSync(process.execPath, ["scripts/build-bundle.mjs", "--check"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("build:bundle --check ok");
  });
});
