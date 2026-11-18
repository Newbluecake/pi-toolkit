/** Self-contained fixed Node22 maintenance consumer. No SDK/tsx/runtime npm deps. */
import { build, version as esbuildVersion } from "esbuild";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = (b) => createHash("sha256").update(b).digest("hex");
const paths = ["package.json", "index.ts", "index.js", "bundle-bridge.cjs"];
function walk(relative) {
  for (const name of readdirSync(join(root, relative)).sort()) {
    const path = `${relative}/${name}`,
      st = statSync(join(root, path));
    if (st.isDirectory()) walk(path);
    else if (st.isFile()) paths.push(path);
    else throw new Error("unsupported source kind");
  }
}
walk("src");
const sources = Object.fromEntries(paths.sort().map((p) => [p, digest(readFileSync(join(root, p)))]));
const output = join(root, "dist/maintenance");
mkdirSync(output, { recursive: true });
const artifact = join(output, "cli.mjs");
const result = await build({
  absWorkingDir: root,
  entryPoints: [join(root, "scripts/web-hub/terminal-v2-retained/cli.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: artifact,
  metafile: true,
  define: { __T51_NEW_SOURCE_FILES__: JSON.stringify(sources) },
  legalComments: "none",
  logLevel: "silent",
});
if (result.metafile && Object.keys(result.metafile.outputs).length !== 1)
  throw new Error("maintenance must be one self-contained entry");
chmodSync(artifact, 0o755);
for (const notice of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) copyFileSync(join(root, notice), join(output, notice));
copyFileSync(join(root, "docs/dev/web-hub-terminal/retained-runbook.md"), join(output, "README.md"));
const sourceChanges = execFileSync(
  "/usr/bin/git",
  [
    "-c",
    "core.fsmonitor=false",
    "diff",
    "--no-ext-diff",
    "--name-only",
    "HEAD",
    "--",
    "src",
    "package.json",
    "index.ts",
    "index.js",
    "bundle-bridge.cjs",
  ],
  { cwd: root, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1" } },
)
  .toString()
  .trim();
const manifest = {
  v: 1,
  kind: "pi-terminal-maint-node22",
  builderSha256: digest(readFileSync(fileURLToPath(import.meta.url))),
  toolchain: { node: process.version, esbuild: esbuildVersion },
  sourceHead: execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim(),
  sourceProfileSha256: digest(Buffer.from(JSON.stringify(sources) + "\n")),
  sourceWorkingTreeDirty: sourceChanges.length > 0,
  sourceChanges: sourceChanges ? sourceChanges.split("\n") : [],
  files: {
    "cli.mjs": digest(readFileSync(artifact)),
    "README.md": digest(readFileSync(join(output, "README.md"))),
    LICENSE: digest(readFileSync(join(output, "LICENSE"))),
    "THIRD_PARTY_NOTICES.md": digest(readFileSync(join(output, "THIRD_PARTY_NOTICES.md"))),
  },
  inputs: Object.keys(result.metafile.inputs).sort(),
  inputSha256: Object.fromEntries(
    Object.keys(result.metafile.inputs)
      .sort()
      .map((path) => [
        path,
        path === "<define:__T51_NEW_SOURCE_FILES__>"
          ? digest(Buffer.from(JSON.stringify(sources)))
          : digest(readFileSync(resolve(root, path))),
      ]),
  ),
};
writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`build:maintenance ok — ${artifact} sha256=${manifest.files["cli.mjs"]} inputs=${manifest.inputs.length}`);
