/**
 * A (hub self-version) — the end-to-end premise: a REAL `hub/main.ts` child booted through jiti
 * with a STALE `PI_WEBHUB_CONFIG` (what an old pi activation would write) must still report the
 * version of the package it loaded. That is the whole bug: before this, `hub.json.version` — and
 * `ui-root`'s `expect.version`, `AgentCard.outdated`, supersede's reference — were the launcher's
 * cached number, so a hub running the new disk code rejected the new disk UI bundle.
 *
 * Runs the production process entry, not `startHub`, because only `main.ts` owns the override.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const HUB_MAIN = resolve("src/web-hub/hub/main.ts");
const PKG_VERSION = (JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { version: string }).version;

const children: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) {
    if (c.exitCode === null) {
      c.kill("SIGKILL");
      await new Promise<void>((r) => c.once("exit", () => r()));
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpHome(): string {
  const d = mkdtempSync(join(tmpdir(), "pwh-selfver-main-"));
  dirs.push(d);
  return d;
}

async function waitFor<T>(fn: () => T | undefined, ms: number): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

interface HubRecord {
  version?: unknown;
  buildId?: unknown;
  pid?: unknown;
}

describe("real hub/main.ts self-versions from the package it loaded", () => {
  it("a stale launcher pair is overridden by the on-disk package version", async () => {
    const home = tmpHome();
    const child = spawn(process.execPath, ["--import", "tsx", HUB_MAIN], {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        HOME: home,
        PI_WEBHUB_CONFIG: JSON.stringify({
          v: 1,
          home,
          port: 0,
          idleExitMinutes: 10,
          // Exactly what a pi activated before the release would have cached:
          pluginVersion: "0.0.1-stale",
          buildId: "0.0.1-stale@deadbeef",
        }),
      },
    });
    children.push(child);
    let stderr = "";
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });

    const hubJson = join(home, ".pi", "agent", "web-hub", "hub.json");
    const rec = await waitFor<HubRecord>(() => {
      try {
        return JSON.parse(readFileSync(hubJson, "utf8")) as HubRecord;
      } catch {
        return undefined;
      }
    }, 30_000);
    expect(rec, stderr).toBeDefined();
    expect(rec!.version).toBe(PKG_VERSION);
    // ...and the launcher's commit must not ride along under a different version.
    expect(rec!.buildId).toBe(`${PKG_VERSION}@unknown`);

    const log = await waitFor<string>(() => {
      try {
        const text = readFileSync(join(home, ".pi", "agent", "web-hub", "hub.log"), "utf8");
        // Wait for the line itself, not just for the file: the hub keeps appending, and
        // `createHubLog` rotates at 1 MiB, so the assertion polls for the content.
        return text.includes("hub version from package") ? text : undefined;
      } catch {
        return undefined;
      }
    }, 15_000);
    expect(log ?? "").toContain('"msg":"hub version from package"');
    expect(log ?? "").toContain('"launcher":"0.0.1-stale"');
  }, 45_000);
});
