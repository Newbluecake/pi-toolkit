/** Terminal P0 budgets are independent of ordinary lazy/mermaid allowances (R1). */
import { createHash } from "node:crypto";
import type { UiProvenance } from "./ui-provenance.js";

export const TERMINAL_JS_BUDGET_GZIP_BYTES = 256 * 1024;
export const TERMINAL_CSS_BUDGET_GZIP_BYTES = 16 * 1024;
export const TERMINAL_HOST_BUDGET_GZIP_BYTES = 4 * 1024;

export function terminalExclusiveSet(prov: UiProvenance): Set<string> {
  return new Set(
    Object.entries(prov.chunks)
      .filter(([, c]) => c.terminalExclusive)
      .map(([path]) => path),
  );
}

export function verifyTerminalProvenance(
  prov: UiProvenance,
  firstScreen: ReadonlySet<string>,
  cssFiles: ReadonlyMap<string, Uint8Array>,
  html: string,
  sourceCssFiles: ReadonlyMap<string, Uint8Array> = new Map(),
): string[] {
  const errors: string[] = [];
  const exclusive = terminalExclusiveSet(prov);
  let holders = 0;
  let hosts = 0;
  for (const [path, c] of Object.entries(prov.chunks)) {
    if (path.startsWith("assets/term-") !== !!c.terminalExclusive)
      errors.push(`${path}: terminal name/provenance mismatch`);
    if (c.terminalExclusive && (firstScreen.has(path) || c.mermaidExclusive))
      errors.push(`${path}: terminal first-screen/mermaid overlap`);
    if (c.terminalHost) hosts++;
    if (c.containsTerminalImpl) {
      holders++;
      if (!c.terminalExclusive) errors.push(`${path}: terminal impl is not exclusive`);
    }
    if (c.packages.some((p) => p.name.startsWith("@xterm/")) && !c.terminalExclusive)
      errors.push(`${path}: xterm outside terminal closure`);
    for (const p of c.packages) {
      if (p.name === "@xterm/xterm" && p.version !== "6.0.0") errors.push(`xterm version ${p.version} unsupported`);
    }
  }
  if (holders !== (prov.terminal?.implInGraph ? 1 : 0)) errors.push("terminal impl count mismatch");
  if (!prov.terminal?.implInGraph && exclusive.size) errors.push("terminal chunks without impl");
  if (prov.terminal?.implInGraph && hosts !== 1) errors.push("terminal host count mismatch");
  const assets = Object.entries(prov.terminal?.css ?? {});
  if (prov.terminal?.implInGraph && assets.length !== 2) errors.push("terminal requires exactly two lazy CSS assets");
  for (const [path, asset] of assets) {
    const bytes = cssFiles.get(path);
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
      errors.push(`${path}: terminal CSS missing/stale source binding`);
    const source = sourceCssFiles.get(asset.sourceModule);
    if (!source || createHash("sha256").update(source).digest("hex") !== asset.sourceSha256)
      errors.push(`${path}: terminal CSS source changed`);
    if (!asset.sourceModule.endsWith(".css?url")) errors.push(`${path}: terminal CSS not graph-bound to ?url`);
    if (html.includes(path)) errors.push(`${path}: terminal CSS is preloaded on first screen`);
    if (bytes && /@import\b|url\s*\(/i.test(Buffer.from(bytes).toString()))
      errors.push(`${path}: unresolved CSS import/url`);
  }
  return errors;
}
