/** T51's explicitly root-provisioned, measured browser only. No npx/cache scan,
 * package installation, network fallback or inferred browser version. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { LoadPlaywrightResult } from "./playwright.js";
export async function loadTerminalPlaywright(): Promise<LoadPlaywrightResult> {
  try {
    const entry = process.env.TPS_PLAYWRIGHT_MODULE,
      binary = process.env.TPS_CHROMIUM;
    if (!entry || !binary || process.env.npm_config_offline !== "true")
      throw new Error("explicit offline TPS_PLAYWRIGHT_MODULE/TPS_CHROMIUM required; no installation");
    const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex"),
      pkg = await readFile(join(dirname(entry), "package.json"));
    if (
      JSON.parse(pkg.toString("utf8")).version !== "1.65.1" ||
      digest(pkg) !== "66a5c412c28b7fe15902da5cb5d7dd503d1c8604d0afe46797fe31aa7dc1a6e0"
    )
      throw new Error("approved Playwright1.65.1 package measurement mismatch");
    if (digest(await readFile(binary)) !== "045558b2f167db04624e36d952496705418a85d87ff9b5fb55a8c40cc59201ae")
      throw new Error("approved Chromium1255 measurement mismatch");
    const pw = await import(pathToFileURL(entry).href);
    return { ok: true, chromium: pw.chromium, version: "1.65.1", executablePath: binary, source: "offline" };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "approved browser unavailable" };
  }
}
