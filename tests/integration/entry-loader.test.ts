import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as codingAgent from "@earendil-works/pi-coding-agent";

const packageRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const hostEntry = resolve(packageRoot, "node_modules/@earendil-works/pi-coding-agent/dist/index.js");
const loadExtensions =
  "loadExtensions" in codingAgent
    ? (codingAgent as typeof codingAgent & { loadExtensions: (paths: string[], cwd: string) => Promise<any> })
        .loadExtensions
    : (await import(pathToFileURL(resolve(dirname(hostEntry), "core/extensions/loader.js")).href)).loadExtensions;

// activate() reads the user settings file for the merged-plugin gates — run
// against a throwaway $HOME so all gates sit at their defaults (on) and the
// developer's real ~/.pi/agent/pi-subagent.json is never read.
const fakeHome = mkdtempSync(join(tmpdir(), "pi-toolkit-loader-home-"));
const realHome = process.env.HOME;
process.env.HOME = fakeHome;
afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("pi-toolkit extension entry", () => {
  it("loads the single manifest entry and exposes every merged surface", async () => {
    const loaded = await loadExtensions([resolve(packageRoot, "index.ts")], packageRoot);
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions).toHaveLength(1);
    const tools = loaded.extensions.flatMap((extension: any) => [...extension.tools.keys()]);
    // subagent core + pre-guard merged plugins, all from the one entry
    expect(tools).toContain("Agent");
    expect(tools).toContain("ask_user");
    expect(tools).toContain("web_search");
    expect(tools).toContain("TaskCreate");
    const commands = loaded.extensions.flatMap((extension: any) => [...extension.commands.keys()]);
    for (const name of ["agent", "tasks", "pi-hud-refresh", "watch", "feishu-test"]) {
      expect(commands, `command /${name}`).toContain(name);
    }
  }, 30_000);
});
