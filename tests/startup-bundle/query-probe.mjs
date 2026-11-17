/** Plain Node probe: exercise jiti's TS importer and the shipped native bridge, not URL text. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const piPackage = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const requirePi = createRequire(join(piPackage, "package.json"));
const { createJiti } = await import(pathToFileURL(requirePi.resolve("jiti")).href);
const nativeImport = createRequire(import.meta.url)(join(root, "bundle-bridge.cjs"));
const dir = mkdtempSync(join(tmpdir(), "pt-query-"));
try {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  const target = join(dir, "target.js");
  const importer = join(dir, "importer.ts");
  writeFileSync(importer, "export default (url: string) => import(url);");
  writeFileSync(target, 'export const instance = {}; export default "old";');
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  const load = await jiti.import(importer, { default: true });
  const url = pathToFileURL(target).href;
  const old = await load(url + "?v=old");
  writeFileSync(target, 'export const instance = {}; export default "new";');
  const stale = await load(url + "?v=new");
  const fresh = await nativeImport(url + "?v=new");
  const reused = await nativeImport(url + "?v=new");
  assert.equal(old.default, "old");
  assert.equal(stale.default, "old");
  assert.equal(old.instance, stale.instance);
  assert.equal(fresh.default, "new");
  assert.notEqual(fresh.instance, old.instance);
  assert.equal(fresh, reused);
  console.log("PASS query: jiti strips query; native bridge loads new code and reuses same URL");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
