/** Fixed sources → measured tool artifacts. No caller module path, JSON adapter or
 * version string is accepted. O is EXACT OLD_SOURCE plus the recorded observation
 * patch; N production source must be clean at HEAD. No install/worktree mutation.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync, symlinkSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { build, version as esbuildVersion } from "esbuild";
import { packageRoot } from "../../../src/core/package-root.js";
import type { ComponentVersion } from "./audit.js";
import { HeldDirectory, digest, json } from "./files.js";
import { OLD_SOURCE } from "./legacy-reader.js";
import { OLD_PATCH_FILES, patchOldMaintenanceSource } from "./old-build-patch.js";
const repository = () => packageRoot(import.meta.url);
const git = (args: string[]) =>
  execFileSync("/usr/bin/git", args, { cwd: repository(), timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
export interface MeasuredBuild {
  readonly kind: "old" | "new";
  readonly directory: string;
  readonly artifact: string;
  readonly version: Readonly<ComponentVersion>;
  readonly manifestSha256: string;
  verify(): void;
  close(): void;
  /** Internal fixed generated artifact only, never accepts a module specifier. */
  load(): Promise<any>;
}
export async function buildMeasuredRuntime(parent: HeldDirectory, kind: "old" | "new"): Promise<MeasuredBuild> {
  const repo = repository();
  const output = parent.mkdir(kind === "old" ? "build-o" : "build-n");
  let sourceRoot = repo;
  const sourceCommit = kind === "old" ? OLD_SOURCE : git(["rev-parse", "HEAD"]).toString().trim();
  const patch: Array<{ path: string; beforeSha256: string; afterSha256: string; before: string; after: string }> = [];
  if (kind === "old") {
    if (
      git(["rev-parse", `${OLD_SOURCE}^{commit}`])
        .toString()
        .trim() !== OLD_SOURCE
    )
      throw new Error("fixed O unavailable");
    sourceRoot = output.path;
    const archive = git([
      "archive",
      OLD_SOURCE,
      "src",
      "package.json",
      "tests/integration/web-hub-terminal-system-rc.ts",
    ]);
    execFileSync("/usr/bin/tar", ["-xf", "-", "-C", sourceRoot], {
      input: archive,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    for (const path of OLD_PATCH_FILES) {
      const file = join(sourceRoot, path),
        before = readFileSync(file, "utf8");
      if (!Buffer.from(before).equals(git(["show", `${OLD_SOURCE}:${path}`])))
        throw new Error("fixed O source mismatch");
      const after = patchOldMaintenanceSource(path, before);
      patch.push({
        path,
        beforeSha256: digest(Buffer.from(before)),
        afterSha256: digest(Buffer.from(after)),
        before,
        after,
      });
      writeFileSync(file, after);
    }
  } else {
    git(["diff", "--exit-code", "HEAD", "--", "src"]);
    // Content anchor for the generated artifact; not a copied or installed dependency tree.
    writeFileSync(join(output.path, "package.json"), readFileSync(join(repo, "package.json")), { mode: 0o600 });
  }
  // Only a NEW private symlink. Never write/chmod/install into the shared node_modules target.
  symlinkSync(join(repo, "node_modules"), join(output.path, "node_modules"), "dir");
  const worker = join(repo, "scripts/web-hub/terminal-v2-maintenance/sdk-worker.js");
  const entry = `
export {startHub} from ${JSON.stringify(join(sourceRoot, "src/web-hub/hub/hub.js"))};
export {createHttpFrontend} from ${JSON.stringify(join(sourceRoot, "src/web-hub/hub/http.js"))};
export {wireWebHub} from ${JSON.stringify(join(sourceRoot, "src/web-hub/agent/index.js"))};
export {resolveHubPaths} from ${JSON.stringify(join(sourceRoot, "src/web-hub/protocol/paths.js"))};
import {wireWebHub} from ${JSON.stringify(join(sourceRoot, "src/web-hub/agent/index.js"))};
import {runSdkWorker} from ${JSON.stringify(worker)};
import {resolveHubPaths} from ${JSON.stringify(join(sourceRoot, "src/web-hub/protocol/paths.js"))};
import {DEFAULT_SETTINGS} from ${JSON.stringify(join(sourceRoot, "src/config/settings.js"))};
${
  kind === "old"
    ? `
export {createTerminalOwner} from ${JSON.stringify(join(sourceRoot, "src/web-hub/agent/terminal/owner.js"))};
export {terminalIdentitiesGone} from ${JSON.stringify(join(sourceRoot, "src/web-hub/agent/terminal/reaper.js"))};
import {createTerminalOwner} from ${JSON.stringify(join(sourceRoot, "src/web-hub/agent/terminal/owner.js"))};
export {createTerminalTestBackend} from ${JSON.stringify(join(sourceRoot, "src/web-hub/agent/terminal/backend.js"))};
import {createTerminalTestBackend} from ${JSON.stringify(join(sourceRoot, "src/web-hub/agent/terminal/backend.js"))};
const workerRuntime = {kind: "old", wireWebHub, resolveHubPaths, defaults: DEFAULT_SETTINGS.webHub, createTerminalOwner, createTerminalTestBackend};
`
    : `
export {createTerminalTestBackend} from ${JSON.stringify(join(sourceRoot, "src/web-hub/hub/terminal/v2/backend.js"))};
export {createTerminalAllocationLedgerV2} from ${JSON.stringify(join(sourceRoot, "src/web-hub/hub/terminal/v2/ledger.js"))};
export {terminalIdentitiesGone} from ${JSON.stringify(join(sourceRoot, "src/web-hub/hub/terminal/v2/reaper.js"))};
const workerRuntime = {kind: "new", wireWebHub, resolveHubPaths, defaults: DEFAULT_SETTINGS.webHub};
`
}
if (process.argv[2] === "__owned_sdk_worker" && process.send) runSdkWorker(workerRuntime).catch(() => process.exit(70));
`;
  const artifact = join(output.path, "runtime.mjs");
  const consumed = new Map<string, Buffer>();
  await build({
    absWorkingDir: repo,
    plugins: [
      {
        name: "measured-inputs",
        setup(builder) {
          builder.onLoad({ filter: /\.[cm]?[jt]s$/ }, ({ path }) => {
            const contents = readFileSync(path);
            consumed.set(path, contents);
            return { contents, loader: path.endsWith("ts") ? "ts" : "js", resolveDir: dirname(path) };
          });
        },
      },
    ],
    stdin: { contents: entry, resolveDir: repo, sourcefile: "fixed-maintenance-entry.ts", loader: "ts" },
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    packages: "external",
    minifyWhitespace: true,
    legalComments: "none",
    outfile: artifact,
    metafile: true,
    logLevel: "silent",
  });
  chmodSync(artifact, 0o600);
  const artifactSha256 = digest(readFileSync(artifact));
  const inputs = [...consumed]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, bytes]) => ({ path, sha256: digest(bytes), bytes: bytes.length }));
  if (kind === "new") git(["diff", "--exit-code", "HEAD", "--", "src"]);
  const controlDir = join(repo, "scripts/web-hub/terminal-v2-maintenance");
  const controlInputs = [
    join(repo, "scripts/web-hub/terminal-v2-maintenance.ts"),
    ...readdirSync(controlDir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => join(controlDir, name)),
  ]
    .sort()
    .map((path) => ({ path, sha256: digest(readFileSync(path)) }));
  const sdkPackage = join(repo, "node_modules/@earendil-works/pi-coding-agent/package.json");
  const sdk = JSON.parse(readFileSync(sdkPackage, "utf8")) as { version?: string };
  if (sdk.version !== "1.5.0") throw new Error("controlled SDK baseline must be exactly 1.5.0");
  const fileIdentity = (path: string) => {
    const s = statSync(path);
    return { dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs };
  };
  const runtimeInputs = [process.execPath, "/usr/bin/git", "/usr/bin/tar", sdkPackage].map((path) => {
    const identity = fileIdentity(path),
      sha256 = digest(readFileSync(path));
    if (JSON.stringify(identity) !== JSON.stringify(fileIdentity(path))) throw new Error("runtime measurement changed");
    return { path, sha256, identity };
  });
  const manifest = output.create(
    "measurement.json",
    json({
      v: 1,
      kind,
      sourceCommit,
      controlSourceCommit: git(["rev-parse", "HEAD"]).toString().trim(),
      entry,
      inputs,
      controlInputs,
      runtimeInputs,
      toolchain: { node: process.version, esbuild: esbuildVersion, sdk: sdk.version },
      patch,
      artifactSha256,
      controlledToolBuild: true,
    }),
  );
  const artifactPin = output.read("runtime.mjs", 32 * 1024 * 1024);
  output.sync();
  parent.sync();
  const version = Object.freeze({
    sourceCommit,
    artifactSha256,
    build: `t51-tool-${kind}-${manifest.fingerprint.sha256}`,
  });
  let closed = false;
  const verify = () => {
    if (closed) throw new Error("measured build closed");
    parent.check();
    output.verify(manifest);
    output.verify(artifactPin);
    for (const input of [...inputs, ...controlInputs])
      if (digest(readFileSync(input.path)) !== input.sha256) throw new Error("measured source changed");
    for (const input of runtimeInputs)
      if (JSON.stringify(fileIdentity(input.path)) !== JSON.stringify(input.identity))
        throw new Error("measured runtime changed");
  };
  verify();
  return Object.freeze({
    kind,
    directory: output.path,
    artifact,
    version,
    manifestSha256: manifest.fingerprint.sha256,
    verify,
    close() {
      if (!closed) {
        closed = true;
        output.close();
      }
    },
    async load() {
      verify();
      const module = await import(pathToFileURL(artifact).href);
      verify();
      return module;
    },
  });
}
