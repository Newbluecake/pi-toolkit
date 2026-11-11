// #36 F1: Jev-off blocks contract. Capture once; never overwrite an existing golden.
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MEMORY_SETTINGS } from "../../../src/memory/settings.js";
import { wireMemory, type WireMemoryOpts } from "../../../src/memory/index.js";
import { memoryDirFor, toSlug } from "../../../src/memory/paths.js";
import { writeBlocksDir } from "./helpers.js";

const golden = join(import.meta.dirname, "../../fixtures/memory/blocks-off-golden.json");
const capture = process.env.PI_TOOLKIT_UPDATE_BLOCKS_GOLDEN === "1";
if (capture && existsSync(golden)) throw new Error("blocks-off golden exists; refusing to overwrite");

it("records Jev-off registration and actual resident/index output", () => {
  const root = mkdtempSync(join(tmpdir(), "blocks-off-"));
  const cwd = join(root, "project");
  mkdirSync(cwd);
  vi.stubEnv("ARMORY_MEMORY_ROOT", join(root, "memory"));
  try {
    writeBlocksDir(memoryDirFor(cwd), [
      { id: "rules.001", authority: "user", scope: "global", body: "- always check the gate" },
      { id: "notes.001", authority: "agent", body: "- topic detail" },
    ]);
    const events: string[] = [];
    let section: any;
    const pi = {
      on: (name: string) => events.push(name),
      registerTool: (tool: { name: string }) => events.push(`tool:${tool.name}`),
      registerCommand: (name: string) => events.push(`command:${name}`),
    } as unknown as ExtensionAPI;
    const settings = { ...DEFAULT_MEMORY_SETTINGS, jev: { ...DEFAULT_MEMORY_SETTINGS.jev, enabled: false } };
    expect(settings.layout).toBe("blocks");
    wireMemory(pi, {
      settings,
      isChildSession: false,
      sections: {
        register: (_name: string, value: unknown) => {
          section = value;
        },
      } as unknown as WireMemoryOpts["sections"],
    });
    const rendered = String(
      section.provider({ ctx: { cwd } as ExtensionContext, optionsCwd: cwd, promptText: "" }),
    ).replaceAll(toSlug(cwd), "<SLUG>");
    expect(rendered).toContain("always check the gate");
    expect(rendered).toContain("notes");
    expect(events).not.toContain("tool_call");
    expect(events).not.toContain("tool_result");
    const observed = { events, rendered };
    if (capture) {
      const formatted = JSON.stringify(observed, null, 2).replace(
        /"events": \[[\s\S]*?\]/,
        `"events": [${events.map((event) => JSON.stringify(event)).join(", ")}]`,
      );
      writeFileSync(golden, formatted + "\n", { flag: "wx" });
    } else expect(observed).toEqual(JSON.parse(readFileSync(golden, "utf8")));
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
