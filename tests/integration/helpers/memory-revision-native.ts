/** Native recovery's registered production chain. All storage is the existing
 * D/C/E fixture's own temp directory; no model/provider is used by recovery. */
import * as fs from "node:fs";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, vi } from "vitest";
import { fakePi, emitAll } from "./schedule-activate.js";
import { createPromptSectionHub } from "../../../src/sysprompt/hub.js";
import { loadSettings } from "../../../src/config/settings.js";
import { wireMemory } from "../../../src/memory/index.js";
import { wireMemoryScopes } from "../../../src/memory/scopes/wire.js";
import * as commands from "../../../src/memory/command.js";
import type { fixture } from "../../memory/govern/revision-e-helpers.js";

const closes: (() => void)[] = [];
afterEach(() => {
  for (const close of closes.splice(0)) close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

export async function registeredRecovery(
  h: Awaited<ReturnType<typeof fixture>>,
  options: {
    domain?: "plain" | "secure" | "locked";
    child?: boolean;
    noScopes?: boolean;
    disabled?: boolean;
    jev?: boolean;
  } = {},
) {
  // toSlug("/") is empty: all memory access stays in h.dir, not in HOME.
  vi.stubEnv("ARMORY_MEMORY_ROOT", h.dir);
  const cwd = "/";
  const f = fakePi();
  const settings = loadSettings({
    memory: {
      enabled: !options.disabled,
      scopes: { session: true, hub: false },
      migrate: { auto: false },
      doctor: { notifyOnStart: false },
      governance: { enabled: false },
      incremental: { enabled: true, auto: false, jobCostCapUsd: 0 },
      jev: { enabled: options.jev ?? false, classifiers: ["offline/unavailable"], predict: { enabled: false } },
    },
  }).memory;
  const manager = SessionManager.inMemory(cwd);
  const lifecycle = new AbortController();
  const ui = { notify: vi.fn(), confirm: vi.fn<ExtensionCommandContext["ui"]["confirm"]>(async () => true) };
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    ui,
    sessionManager: manager,
    isIdle: () => true,
    hasPendingMessages: () => false,
  } as unknown as ExtensionCommandContext;
  const state = { gate: true };
  const gate = {
    capture() {},
    check: vi.fn(() => (state.gate ? { ok: true as const } : { ok: false as const, reason: "locked" as const })),
  };
  const scopes = options.noScopes
    ? undefined
    : wireMemoryScopes(f.pi, {
        settings,
        child: options.child ?? false,
        domain: options.domain ?? "plain",
        gate: { check: () => ({ ok: true }) },
        locked: () => false,
        remote: () => undefined,
        hubPaths: () => undefined,
      });
  if (scopes) closes.push(() => scopes.dispose());
  f.pi.appendEntry = (type, data) => {
    manager.appendCustomEntry(type, data);
  };
  const registration = vi.spyOn(commands, "createMemCommand");
  const memory = wireMemory(f.pi, {
    settings,
    isChildSession: options.child ?? false,
    secureDomainKind: options.domain ?? "plain",
    ...(scopes ? { scopes } : {}),
    writeGate: gate,
    sessionSignal: () => lifecycle.signal,
    sections: createPromptSectionHub(f.pi, {
      mode: () => "stable",
      wakeReplay: false,
      adoptForeignForcedPrompt: false,
    }),
  });
  const deps = registration.mock.calls.at(-1)![0];
  expect(deps.onAfterWrite).toBeTypeOf("function");
  const afterWrite = vi.spyOn(deps, "onAfterWrite"); // calls the ORIGINAL cache/Jev/activity invalidator
  const emit = (name: string, event: object = {}) => emitAll(f, name, { type: name, ...event }, ctx);
  await emit("session_start", { reason: "startup" });
  const command = f.commands.get("mem") as ReturnType<typeof commands.createMemCommand>;
  expect(command.handler).toBeTypeOf("function");
  return {
    ...f,
    ctx,
    ui,
    state,
    gate,
    settings,
    scopes,
    manager,
    lifecycle,
    afterWrite,
    deps,
    memory,
    emit,
    run: (args = `restore --revision ${h.frozen.actionId}`) => command.handler(args, ctx),
  };
}

export function treeBytes(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (path: string, prefix: string) => {
    for (const e of fs.readdirSync(path, { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${path}/${e.name}`, `${prefix}${e.name}/`);
      else result[`${prefix}${e.name}`] = fs.readFileSync(`${path}/${e.name}`).toString("base64");
    }
  };
  walk(dir, "");
  return result;
}
