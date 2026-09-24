import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { toCreateOptions } from "../../src/runtime/session-driver.js";

/**
 * Exercises pi's real DefaultResourceLoader (in empty temp dirs, so no
 * extensions/skills/context files are discovered): the override must be what
 * the loader hands to pi's system-prompt builder as `customPrompt`.
 */
describe("session-driver toCreateOptions: replace-mode system prompt", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "pi-sp-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("wires systemPrompt through a resource loader override and strips the field", async () => {
    const cwd = tmp();
    const options = await toCreateOptions({ agentDir: tmp(), systemPrompt: "You are the domain expert." }, cwd);
    expect(options).not.toHaveProperty("systemPrompt");
    const loader = options.resourceLoader as { getSystemPrompt(): string | undefined };
    expect(loader.getSystemPrompt()).toBe("You are the domain expert.");
    expect(options.settingsManager).toBeDefined();
  });

  it("leaves the spec untouched (no loader) when there is no systemPrompt", async () => {
    const spec = { agentDir: "/x", tools: ["read"] };
    const options = await toCreateOptions(spec, tmp());
    expect(options).toEqual(spec);
    expect(options).not.toHaveProperty("resourceLoader");
  });
});
