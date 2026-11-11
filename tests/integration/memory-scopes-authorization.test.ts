import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  SettingsManager,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createCommandCapture, wrapCommandApi } from "../../src/commands/capture.js";
import { createBuiltinBridge } from "../../src/web-hub/agent/builtin-bridge.js";
import { createCommandHandler } from "../../src/web-hub/agent/commands.js";
import { createCommandLedger } from "../../src/web-hub/agent/ledger.js";
import { createQueueMirror } from "../../src/web-hub/agent/queue-mirror.js";
import { wireMemoryScopes } from "../../src/memory/scopes/wire.js";
import { wireMemory } from "../../src/memory/index.js";
import { createPromptSectionHub } from "../../src/sysprompt/hub.js";
import { DEFAULT_MEMORY_SETTINGS } from "../../src/memory/settings.js";
import {
  fakeModel,
  fakeModelRuntime,
  textTurn,
  createFakeUiContext,
  createUiCallLog,
} from "../conformance/topic-switch-runtime-harness.js";
import type { CmdFrame, CmdResultFrame, CmdLateFrame } from "../../src/web-hub/protocol/messages.js";

const origin = { listener: "loopback" as const, ip: "127.0.0.1", reqId: "memory39-web" };
it("actual SDK Web prompt/command/current-capture and native direct/single-confirm matrix", async () => {
  const root = mkdtempSync(join(tmpdir(), "memory39-web-sdk-")),
    agentDir = join(root, "agent");
  mkdirSync(agentDir);
  mkdirSync(join(root, "hub"));
  vi.stubEnv("HOME", root);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("ARMORY_MEMORY_ROOT", join(root, "memory"));
  Reflect.deleteProperty(globalThis, Symbol.for("pi-subagent:web-hub:cmd-ledger"));
  const model = fakeModel(),
    local = fakeModelRuntime(model, [textTurn("ordinary offline")]);
  const manager = SessionManager.inMemory(root),
    owned = new Set<string>(),
    capture = createCommandCapture(owned);
  const settings = {
    ...DEFAULT_MEMORY_SETTINGS,
    layout: "legacy" as const,
    toolSurface: "legacy" as const,
    scopes: { session: true, hub: true },
    jev: { ...DEFAULT_MEMORY_SETTINGS.jev, enabled: false },
  };
  let api!: ExtensionAPI, ctx!: ExtensionContext, scopes!: NonNullable<ReturnType<typeof wireMemoryScopes>>;
  const errors: unknown[] = [];
  const settingsManager = SettingsManager.create(root, agentDir);
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noThemes: true,
    noPromptTemplates: true,
    extensionFactories: [
      (raw) => {
        api = wrapCommandApi(raw, () => capture, owned);
        scopes = wireMemoryScopes(api, {
          settings,
          child: false,
          domain: "plain",
          gate: { check: () => ({ ok: true }) },
          locked: () => false,
          remote: () => undefined,
          hubPaths: () => ({ stateDir: join(root, "hub") }),
        })!;
        const sections = createPromptSectionHub(api, {
          mode: () => "stable",
          wakeReplay: false,
          adoptForeignForcedPrompt: false,
        });
        wireMemory(api, { settings, scopes, sections, isChildSession: false });
        raw.on("session_start", (_event, context) => {
          ctx = context;
        });
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    model: model as never,
    modelRuntime: local as never,
    sessionManager: manager,
    settingsManager,
    resourceLoader: loader,
  });
  const ui = createFakeUiContext(createUiCallLog()),
    select = vi.fn(async (_title: string, choices: string[]) => choices[1]);
  ui.select = select;
  await session.bindExtensions({
    mode: "tui",
    uiContext: ui,
    shutdownHandler: () => {},
    onError: (error) => errors.push(error),
  });
  const timers: ReturnType<typeof setTimeout>[] = [],
    sent: Array<CmdResultFrame | CmdLateFrame> = [];
  const bridge = createBuiltinBridge({
    pi: api,
    getCtx: () => ctx,
    getSessionId: () => manager.getSessionId(),
    capture: () => capture,
    memoryScopes: true,
    overrides: () => ({ mem: "allow" }),
  });
  const handler = createCommandHandler({
    pi: api,
    getCtx: () => ctx,
    getSessionId: () => manager.getSessionId(),
    memoryProof: () => scopes.proof,
    ledger: createCommandLedger(),
    queueMirror: createQueueMirror(),
    compactionState: { manualCompacting: false, deferAfterManualCompaction: (fn) => fn(), dispose() {} },
    originEntry: { appendOrigin() {}, notify() {}, dispose() {} },
    builtinBridge: bridge,
    controlEnabled: () => true,
    now: Date.now,
    send: (frame) => sent.push(frame),
    onChanged() {},
    setTimer(ms, fn) {
      const timer = setTimeout(fn, ms);
      timer.unref();
      timers.push(timer);
      return { cancel: () => clearTimeout(timer) };
    },
  });
  const frame = (id: string, cmd: CmdFrame["cmd"]): CmdFrame => ({
    t: "cmd",
    rid: `r-${id}`,
    id,
    deadlineMs: 8000,
    origin,
    cmd,
  });
  try {
    // Native human surface: add/rm zero extra popups; restore/adopt exactly one each.
    await session.prompt("/mem session add native exact");
    await session.prompt("/mem hub add native shared");
    await session.prompt("/mem hub rm general.001");
    expect(select).not.toHaveBeenCalled();
    const trash = scopes.current()!.hub!.management.listTrash()[0]!;
    await session.prompt(`/mem hub restore ${trash.fileName}`);
    expect(select).toHaveBeenCalledTimes(1);
    expect(select.mock.calls[0]![0]).toContain("native shared");
    await session.prompt("/mem hub adopt");
    expect(select).toHaveBeenCalledTimes(2);
    const before = scopes.current()!.session!.view().items.length;
    for (const [i, args] of [
      "session add web forbidden",
      "hub add forbidden",
      "hub rm general.001",
      "hub adopt",
      `hub restore ${trash.fileName}`,
    ].entries()) {
      handler.handle(frame(`deny-${i}`, { op: "command", name: "mem", args, confirm: true }));
      expect(sent.at(-1)).toMatchObject({ ok: false, code: "E_UNSUPPORTED", effect: "none" });
    }
    expect(scopes.current()!.session!.view().items).toHaveLength(before);
    expect(select).toHaveBeenCalledTimes(2);
    // Captured-host dispatch negative only: this is NOT a model slash capability or a new threat model.
    capture.arm({
      cmdId: "captured-host",
      reqId: origin.reqId,
      origin,
      name: "mem",
      args: "session add captured forbidden",
      deadlineAt: Date.now() + 8000,
    });
    api.sendUserMessage("/mem session add captured forbidden", { expandPromptTemplates: true, deliverAs: "followUp" });
    capture.settleArm();
    await vi.waitFor(() => expect(JSON.stringify(capture.outputFor("captured-host"))).toContain("E_AUTHORITY"));
    expect(scopes.current()!.session!.view().items).toHaveLength(before);
    handler.handle(frame("read", { op: "command", name: "mem", args: "session list" }));
    expect(sent.at(-1)).toMatchObject({
      ok: false,
      code: "E_UNSUPPORTED",
      effect: "none",
      message: expect.stringContaining("memory command channel unavailable"),
    });
    expect(JSON.stringify(scopes.current()!.session!.view())).toContain("native exact");
    // Slash-shaped memory prompts are denied before native dispatch.
    const beforeRaw = local.callCount();
    handler.handle(frame("raw", { op: "prompt", text: "/mem session add raw-web-must-not-command", deliver: "steer" }));
    expect(sent.at(-1)).toMatchObject({
      ok: false,
      code: "E_COMMAND_DENIED",
      effect: "none",
      message: "Send /mem as a command",
    });
    expect(local.callCount()).toBe(beforeRaw);
    expect(scopes.current()!.session!.view().items).toHaveLength(before);
    expect(JSON.stringify(local.requestMessages)).not.toContain("/mem session add raw-web-must-not-command");
    const calls = local.callCount();
    handler.handle(frame("ordinary", { op: "prompt", text: "ordinary prompt unchanged", deliver: "steer" }));
    await vi.waitFor(() => expect(local.callCount()).toBeGreaterThan(calls));
    await session.waitForIdle();
    expect(JSON.stringify(local.requestMessages)).toContain("ordinary prompt unchanged");
    expect(errors).toEqual([]);
  } finally {
    handler.dispose();
    capture.dispose();
    for (const timer of timers) clearTimeout(timer);
    scopes.dispose();
    session.dispose();
    Reflect.deleteProperty(globalThis, Symbol.for("pi-subagent:web-hub:cmd-ledger"));
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
