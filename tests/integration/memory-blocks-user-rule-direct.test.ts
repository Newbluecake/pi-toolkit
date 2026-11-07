/**
 * #36 P4 (V29) — the v3 blocks tool through the REAL `wireMemory` assembly:
 * user-rule rewrite/delete and a model-driven global→topic demotion are all
 * DIRECT writes (voided echo + one TUI warning notify + CAS/abort), never a
 * confirm — mirroring tests/integration/memory-user-rule-direct.test.ts for
 * the blocks layout. The production registration itself (toolSurfaceFor ⇒
 * the v3 surface while layout:blocks) is asserted on the way in.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import { clearHealthTable } from "../../src/memory/jev/health.js";
import { wireMemory } from "../../src/memory/index.js";
import { memoryDirFor } from "../../src/memory/paths.js";
import { MEMORY_TOOL_V3_TEXT, MEMORY_TOOL_V3_TEXT_JEV } from "../../src/memory/tool-surface.js";
import { createPromptSectionHub } from "../../src/sysprompt/hub.js";
import { createFakeRegistry } from "../memory/jev/helpers/fake-registry.js";
import { writeBlocksDir, blockRaw } from "../memory/blocks/helpers.js";
import { parseBlockFile } from "../../src/memory/blocks/format.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

let envTmp: string;
let cwd: string;
let memDir: string;

beforeEach(() => {
  clearHealthTable();
  envTmp = mkdtempSync(join(tmpdir(), "mem-blocks-direct-"));
  vi.stubEnv("HOME", join(envTmp, "nohome"));
  vi.stubEnv("ARMORY_MEMORY_ROOT", join(envTmp, "root"));
  cwd = join(envTmp, "proj");
  mkdirSync(cwd, { recursive: true });
  memDir = memoryDirFor(cwd);
  writeBlocksDir(memDir, [
    { id: "general.001", authority: "user", scope: "global", body: "- 常驻用户令一条" },
    { id: "general.002", authority: "user", scope: "global", body: "- 第二条常驻令" },
  ]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(envTmp, { recursive: true, force: true });
  clearHealthTable();
});

function harness() {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<
    string,
    {
      name: string;
      description: string;
      execute: (id: string, p: unknown, s: unknown, u: unknown, c: unknown) => Promise<unknown>;
    }
  >();
  const branch: unknown[] = [];
  const pi = {
    on: (event: string, h: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), h]);
      return () => {};
    },
    registerTool: (t: { name: string; description: string }) => tools.set(t.name, t as never),
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    getActiveTools: () => ["read", "bash", "memory"],
    sendMessage: () => {},
    appendEntry: () => {},
  } as unknown as ExtensionAPI;
  const hub = createPromptSectionHub(pi, { mode: () => "stable", wakeReplay: false, adoptForeignForcedPrompt: false });
  wireMemory(pi, {
    // layout:blocks + a blocks directory ⇒ toolSurfaceFor picks the V3
    // surface at activate (arch §3.4) — one `memory` tool, same name.
    settings: { ...DEFAULT_SETTINGS.memory, layout: "blocks" },
    isChildSession: false,
    sections: hub,
    secureDomainKind: "plain",
  });
  const classifiers = DEFAULT_SETTINGS.memory.jev.classifiers;
  const fake = createFakeRegistry({
    available: classifiers,
    responses: Object.fromEntries(
      classifiers.map((id) => [
        id,
        [() => ({ stopReason: "error" as const, errorMessage: "System One API error (451): blocked" })],
      ]),
    ),
  });
  const counters = { confirm: 0, select: 0, notify: 0 };
  const notifyMessages: { message: string; level?: string }[] = [];
  const ctx = (mode: "rpc" | "tui") =>
    ({
      cwd,
      mode,
      hasUI: true,
      ui: {
        notify: (message: string, level?: string) => {
          counters.notify += 1;
          notifyMessages.push({ message, ...(level === undefined ? {} : { level }) });
        },
        confirm: async () => {
          counters.confirm += 1;
          return true;
        },
        select: async () => {
          counters.select += 1;
          return undefined;
        },
      },
      modelRegistry: fake.registry,
      sessionManager: { getBranch: () => branch, getSessionId: () => "blocks-direct-1" },
    }) as unknown as Record<string, unknown>;
  const tool = tools.get("memory")!;
  return { tool, ctx, counters, notifyMessages };
}

function revOf(id: string): string {
  const parsed = parseBlockFile(`${id}.md`, readFileSync(join(memDir, "blocks", `${id}.md`), "utf8"));
  if ("stray" in parsed) throw new Error("stray");
  return parsed.rev;
}

async function run(
  tool: { execute: (id: string, p: unknown, s: unknown, u: unknown, c: unknown) => Promise<unknown> },
  params: unknown,
  c: unknown,
) {
  const result = (await tool.execute("call-1", params, undefined, undefined, c)) as {
    content: { type: string; text: string }[];
  };
  return result.content.map((x) => x.text).join("\n");
}

describe("user-rule changes through the production v3 wireMemory (#26 V29)", () => {
  it("registers exactly one memory tool with the V3 surface (toolSurfaceFor; fix round: jev wires under layout:blocks, so the JEV description variant applies)", () => {
    const h = harness();
    expect(h.tool.name).toBe("memory");
    expect(h.tool.description).toBe(MEMORY_TOOL_V3_TEXT_JEV.description);
    expect(h.tool.description).not.toBe(MEMORY_TOOL_V3_TEXT.description);
  });

  it.each(["rpc", "tui"] as const)(
    "mode %s: rewriting a user block writes through with the voided echo, zero confirms",
    async (mode) => {
      const h = harness();
      const text = await run(
        h.tool,
        { command: "update", path: "general.001", rev: revOf("general.001"), text: "- 改写后的用户令" },
        h.ctx(mode),
      );
      expect(h.counters.confirm).toBe(0);
      expect(h.counters.select).toBe(0);
      expect(text).toContain("updated general.001 · rev ");
      expect(text).toContain("voided user rule: general.001");
      expect(
        parseBlockFile("general.001.md", readFileSync(join(memDir, "blocks", "general.001.md"), "utf8")).meta.authority,
      ).toBe("user" as never);
      expect(readFileSync(join(memDir, "blocks", "general.001.md"), "utf8")).toContain("改写后的用户令");
    },
  );

  it("tui: the user-block rewrite lands exactly one warning notify", async () => {
    const h = harness();
    await run(
      h.tool,
      { command: "update", path: "general.001", rev: revOf("general.001"), text: "- 改写 v2" },
      h.ctx("tui"),
    );
    expect(h.counters.notify).toBe(1);
    expect(h.notifyMessages[0]).toEqual({
      message: "agent 改动了用户令 general.001（已直接写入，未经确认）",
      level: "warning",
    });
  });

  it("deleting a user block: delete-kind notify + voided echo + .trash entry", async () => {
    const h = harness();
    const text = await run(h.tool, { command: "delete", path: "general.002" }, h.ctx("tui"));
    expect(text).toContain("deleted general.002 → .trash");
    expect(text).toContain("voided user rule: general.002");
    expect(h.notifyMessages).toEqual([
      {
        message: "agent 删除了用户令 general.002（块已移入 .trash，可用 /mem restore --trash 找回）",
        level: "warning",
      },
    ]);
  });

  it("the model demoting global→topic: direct write + demotion notify + voided echo", async () => {
    const h = harness();
    const text = await run(
      h.tool,
      {
        command: "update",
        path: "general.002",
        rev: revOf("general.002"),
        text: "- 第二条常驻令 <!-- mem user scope=topic -->",
      },
      h.ctx("tui"),
    );
    expect(text).toContain("voided user rule: general.002 (global → topic)");
    expect(h.notifyMessages).toEqual([
      { message: "agent 把用户令 general.002 从 global 降为 topic（已直接写入，未经确认）", level: "warning" },
    ]);
    const after = parseBlockFile("general.002.md", readFileSync(join(memDir, "blocks", "general.002.md"), "utf8"));
    expect("stray" in after).toBe(false as never);
    expect(!("stray" in after) && after.meta.scope).toBe("topic");
  });

  it("an agent-block edit notifies nobody", async () => {
    writeFileSync(
      join(memDir, "blocks", "agent.001.md"),
      blockRaw({ id: "agent.001", authority: "agent", body: "- agent fact" }),
    );
    const h = harness();
    const text = await run(
      h.tool,
      { command: "update", path: "agent.001", rev: revOf("agent.001"), text: "- agent fact v2" },
      h.ctx("tui"),
    );
    expect(text).toContain("updated agent.001");
    expect(text).not.toContain("voided user rule");
    expect(h.counters.notify).toBe(0);
  });
});
