/**
 * #26 (no-user-guard-confirm plan §6 G-group, production wiring): the user-rule
 * direct write through the REAL `wireMemory` assembly — the real PromptSectionHub,
 * the real `wireJev` + `createJevWritePort` (real touchedUserEntries pairing),
 * the real directory lock/commit — proving at the registration level that no
 * confirm/select is ever called in any mode and the one warning notify lands on
 * the TUI. Replaces tests/integration/memory-headless-confirm.test.ts (the
 * remote confirm card went with the guard); the host-side proof that
 * `src/index.ts` no longer passes a `remote` port to wireMemory is carried by
 * typecheck (the opt no longer exists).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import { clearHealthTable } from "../../src/memory/jev/health.js";
import { wireMemory } from "../../src/memory/index.js";
import { memoryDirFor } from "../../src/memory/paths.js";
import { createPromptSectionHub } from "../../src/sysprompt/hub.js";
import { createFakeRegistry } from "../memory/jev/helpers/fake-registry.js";
import { writeBlocksDir } from "../memory/blocks/helpers.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

const BLOCK_ID = "rules.001";
const GUARD_BODY = "- 用户令一条";

function seed(authority: "user" | "agent", body = GUARD_BODY): void {
  writeBlocksDir(memDir, [
    { id: BLOCK_ID, authority, ...(authority === "user" ? { scope: "global" as const } : {}), body },
  ]);
}

let envTmp: string;
let cwd: string;
let memDir: string;

beforeEach(() => {
  clearHealthTable();
  envTmp = mkdtempSync(join(tmpdir(), "mem-direct-wire-"));
  vi.stubEnv("HOME", join(envTmp, "nohome"));
  vi.stubEnv("ARMORY_MEMORY_ROOT", join(envTmp, "root"));
  cwd = join(envTmp, "proj");
  mkdirSync(cwd, { recursive: true });
  memDir = memoryDirFor(cwd);
  mkdirSync(memDir, { recursive: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(envTmp, { recursive: true, force: true });
  clearHealthTable();
});

/** A wiring-level harness: registers the memory tool the way src/index.ts does
 *  (minus the web-hub ports — the only #26-relevant opt, sessionSignal, is
 *  main-session-only and orthogonal to zero-confirm). */
function harness() {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<
    string,
    { name: string; execute: (id: string, p: unknown, s: unknown, u: unknown, c: unknown) => Promise<unknown> }
  >();
  const branch: unknown[] = [];
  const pi = {
    on: (event: string, h: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), h]);
      return () => {};
    },
    registerTool: (t: { name: string }) => tools.set(t.name, t as never),
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    getActiveTools: () => ["read", "bash", "memory"],
    sendMessage: () => {},
    appendEntry: () => {},
  } as unknown as ExtensionAPI;
  const hub = createPromptSectionHub(pi, { mode: () => "stable", wakeReplay: false, adoptForeignForcedPrompt: false });
  wireMemory(pi, {
    settings: { ...DEFAULT_SETTINGS.memory },
    isChildSession: false,
    sections: hub,
    secureDomainKind: "plain",
  });
  const classifiers = DEFAULT_SETTINGS.memory.jev.classifiers;
  // every classify fails (451-style) ⇒ deterministic "not tagged (partial…)" echo
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
      sessionManager: { getBranch: () => branch, getSessionId: () => "direct-1" },
    }) as unknown as Record<string, unknown>;
  const tool = tools.get("memory")!;
  return { tool, ctx, counters, notifyMessages };
}

async function exec(
  tool: { execute: (id: string, p: unknown, s: unknown, u: unknown, c: unknown) => Promise<unknown> },
  c: unknown,
) {
  const viewed = (await tool.execute("view-1", { command: "view", path: BLOCK_ID }, undefined, undefined, c)) as {
    content: { type: string; text: string }[];
  };
  const viewText = viewed.content.map((part) => part.text).join("\n");
  const rev = viewText.match(/#### rules\.001 · rev (\d+-[0-9a-f]{6})/)?.[1];
  expect(rev).toBeDefined();
  expect(viewText).toContain("用户令");
  const original = viewText.slice(viewText.indexOf("\n") + 1);
  const replacement = original.replace("用户令", "改掉");
  expect(replacement).not.toBe(original);
  return (await tool.execute(
    "call-1",
    { command: "update", path: BLOCK_ID, rev, text: replacement },
    undefined,
    undefined,
    c,
  )) as { content: { type: string; text: string }[] };
}

describe("user-rule edits through the production wireMemory (#26)", () => {
  it.each(["rpc", "tui"] as const)(
    "mode %s: ui.confirm/ui.select are never called; the write lands with the voided echo",
    async (mode) => {
      const h = harness();
      seed("user");
      const result = await exec(h.tool, h.ctx(mode));
      const text = result.content.map((c) => c.text).join("\n");
      expect(h.counters.confirm).toBe(0);
      expect(h.counters.select).toBe(0);
      expect(text).toContain("updated rules.001");
      expect(text).toContain("voided user rule: rules.001");
      expect(readFileSync(join(memDir, "blocks", `${BLOCK_ID}.md`), "utf8")).toContain("改掉");
    },
  );

  it("tui: exactly one warning notify lands (rpc's notify is fire-and-forget, dropped by the hub — not an acceptance channel)", async () => {
    const h = harness();
    seed("user");
    await exec(h.tool, h.ctx("tui"));
    expect(h.counters.notify).toBe(1);
    expect(h.notifyMessages[0]).toEqual({
      message: "agent 改动了用户令 rules.001（已直接写入，未经确认）",
      level: "warning",
    });
  });

  it("rpc: the notify call happens (hasUI true) but never blocks or fails the write — delivery is the hub's business", async () => {
    const h = harness();
    seed("user");
    const result = await exec(h.tool, h.ctx("rpc"));
    expect(result.content.map((c) => c.text).join("\n")).toContain("voided user rule: rules.001");
    expect(readFileSync(join(memDir, "blocks", `${BLOCK_ID}.md`), "utf8")).toContain("改掉");
    expect(h.counters.confirm).toBe(0);
  });

  it("an edit that does NOT touch a user entry notifies nobody and confirms nobody", async () => {
    const h = harness();
    // Agent-authored block: the same text update is not a user-rule edit.
    seed("agent", "- 提到用户令的普通经验");
    const result = await exec(h.tool, h.ctx("tui"));
    expect(result.content.map((c) => c.text).join("\n")).toContain("updated rules.001");
    expect(readFileSync(join(memDir, "blocks", `${BLOCK_ID}.md`), "utf8")).toContain("提到改掉的普通经验");
    expect(h.counters.confirm).toBe(0);
    expect(h.counters.notify).toBe(0);
  });
  it("missing or stale rev returns errors without changing the block or notifying", async () => {
    const h = harness();
    seed("user");
    const ctx = h.ctx("tui");
    const file = join(memDir, "blocks", `${BLOCK_ID}.md`);
    const before = readFileSync(file, "utf8");
    const missing = (await h.tool.execute(
      "missing",
      { command: "update", path: BLOCK_ID, text: "- changed" },
      undefined,
      undefined,
      ctx,
    )) as { content: { text: string }[] };
    expect(JSON.parse(missing.content[0]!.text)).toMatchObject({
      ok: false,
      code: "E_REV_REQUIRED",
      message: expect.stringMatching(/\S/),
    });
    const stale = (await h.tool.execute(
      "stale",
      { command: "update", path: BLOCK_ID, rev: "1-000000", text: "- changed" },
      undefined,
      undefined,
      ctx,
    )) as { content: { text: string }[] };
    expect(JSON.parse(stale.content[0]!.text)).toMatchObject({
      ok: false,
      code: "E_CONFLICT",
      message: expect.stringMatching(/\S/),
    });
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(h.counters.notify).toBe(0);
    expect(h.counters.confirm).toBe(0);
    expect(h.counters.select).toBe(0);
  });
});
