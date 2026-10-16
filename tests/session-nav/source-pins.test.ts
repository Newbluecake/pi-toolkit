// web-resume plan §4/§2.2 source-scan pins:
// - the child-marker and run-mark literals equal their source-of-truth constants (no runtime
//   import of the runtime-heavy modules);
// - no `readFile(path)` / `createReadStream(path)` / `readFileSync(path)` remains in the P1
//   session-nav modules that own the open discipline (skill-titles.ts is out of P1's file set).

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

async function source(rel: string): Promise<string> {
  return readFile(join(SRC, rel), "utf8");
}

function constString(text: string, name: string): string {
  const m = new RegExp(`export const ${name} = "([^"]+)"`).exec(text);
  expect(m, `${name} not found`).toBeDefined();
  return m![1];
}

describe("marker literals are pinned to their sources of truth", () => {
  test("SUBAGENT_CHILD_MARKER_TYPE == session-driver.ts SUBAGENT_CHILD_CUSTOM_TYPE", async () => {
    const driver = await source("runtime/session-driver.ts");
    const head = await source("session-nav/session-head.ts");
    expect(constString(head, "SUBAGENT_CHILD_MARKER_TYPE")).toBe(constString(driver, "SUBAGENT_CHILD_CUSTOM_TYPE"));
  });

  test("SUBAGENT_RUN_CUSTOM_TYPE == pi-run-log.ts RUN_CUSTOM_TYPE", async () => {
    const runLog = await source("adapters/pi-run-log.ts");
    const provenance = await source("session-nav/provenance.ts");
    expect(constString(provenance, "SUBAGENT_RUN_CUSTOM_TYPE")).toBe(constString(runLog, "RUN_CUSTOM_TYPE"));
  });

  test("the header id rule is the single RESTORE_SESSION_ID_RE (runtime import, no copy)", async () => {
    const head = await source("session-nav/session-head.ts");
    expect(head).toContain('from "../web-hub/protocol/spawn.js"');
    expect(head).toContain("RESTORE_SESSION_ID_RE");
    expect(head).not.toMatch(new RegExp("SESSION_ID_RE\\s*=\\s*\\/\\^")); // no local copy
  });
});

describe("open discipline: no by-path whole-file reads in the P1 modules", () => {
  const P1_MODULES = [
    "session-nav/session-head.ts",
    "session-nav/provenance.ts",
    "session-nav/classify.ts",
    "session-nav/subagent-sessions.ts",
    "session-nav/recent-sessions.ts",
    "session-nav/index.ts",
  ];

  test("no readFile/readFileSync/createReadStream by path", async () => {
    for (const rel of P1_MODULES) {
      // Strip comments first — the open-discipline doc lines legitimately NAME the banned APIs.
      const text = (await source(rel)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(text, `${rel} must not createReadStream`).not.toContain("createReadStream");
      expect(text, `${rel} must not readFile`).not.toMatch(/\breadFile(Sync)?\s*\(/);
    }
  });
});
