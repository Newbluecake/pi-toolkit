import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { AgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { PiSessionDriver, PiSessionHandle } from "../../src/runtime/session-driver.js";
import type { HumanRuntime } from "../../src/runtime/human-runtime.js";
import { createSpawnService } from "../../src/service/spawn-service.js";
import type { SpawnServiceDeps } from "../../src/service/spawn-service.js";
import type { FastMode, SessionSpec } from "../../src/core/types.js";

function own() {
  const root = mkdtempSync(join(tmpdir(), "fast-child-"));
  const cwd = join(root, "work");
  const agentDir = join(root, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  return { root, cwd, agentDir };
}

// This zero-prompt suite forbids transport entirely (stronger than loopback-only).
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Fast offline fixture: network forbidden"));
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.mocked(globalThis.fetch).mockRestore();
});

describe("Fast production driver with real SDK 1.5 settings discovery", () => {
  it.each([undefined, "child prompt override"])(
    "same bus receiver + original human observer, override=%s",
    async (systemPrompt) => {
      const { root, cwd, agentDir } = own();
      const cleanupFile = join(root, "cleanup");
      const plugin = join(root, "receiver.mjs");
      writeFileSync(
        plugin,
        `import {appendFileSync} from "node:fs";
      export default function(pi) { let manager;
        pi.events.on("subagent:fast-bind", (r) => {
          if(manager && manager !== r.manager) return;
          manager=r.manager;
          r.reply({v:1,wired:true,readMode:()=>{
            const e=manager.getBranch().filter(e=>e.type==="custom"&&e.customType==="subagent:fast").at(-1);
            return e?.data.mode ?? "inherit";
          },dispose:()=>appendFileSync(${JSON.stringify(cleanupFile)},"disposed\\n")});
        });
      }`,
      );
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [plugin] }));
      const humanDispose = vi.fn();
      let observerStarted = 0;
      const human: HumanRuntime = {
        prepare: async () => ({
          tool: {
            name: "message_session",
            label: "isolated observer tool",
            description: "offline",
            parameters: Type.Object({ to: Type.String(), text: Type.String(), wake: Type.Optional(Type.Boolean()) }),
            execute: async () => ({ content: [{ type: "text", text: "not invoked" }], details: {} }),
          },
          observer: (pi) => {
            pi.on("session_start", () => {
              observerStarted++;
            });
          },
          dispose: humanDispose,
          wrapAgent: (tool) => tool,
        }),
        childLinked() {},
        detach() {},
      };
      const modelRuntime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
        modelsStorePath: join(root, "catalog"),
        allowModelNetwork: false,
      });
      let branchMode: (() => FastMode) | undefined;
      const unbind = vi.fn();
      const driver = new PiSessionDriver(false, (p, id) => modelRuntime.getModel(p, id), human, {
        bind(owner, read) {
          expect(owner.parentRunId).toBe("real-child");
          branchMode = read;
          expect(read()).toBe("off");
          return unbind;
        },
      });
      const prompt = vi.spyOn(AgentSession.prototype, "prompt");
      let handle: PiSessionHandle | undefined;
      try {
        handle = (await driver.create({
          cwd,
          agentDir,
          persist: false,
          model: { provider: "openai", id: "gpt-4o-mini" },
          fastSeed: { v: 1, mode: "off" },
          ...(systemPrompt ? { systemPrompt } : {}),
          runId: "real-child",
        } as SessionSpec)) as PiSessionHandle;
        // Public SDK lifecycle start is explicit; the receiver was already installed by reload.
        await handle.session.bindExtensions({});
        expect(observerStarted).toBe(1);
        expect(handle.session.getAllTools().some((t) => t.name === "message_session")).toBe(true);
        expect(branchMode?.()).toBe("off");
        handle.session.sessionManager.appendCustomEntry("subagent:fast", { v: 1, mode: "on" });
        expect(branchMode?.()).toBe("on");
        if (systemPrompt) expect(handle.session.systemPrompt).toContain(systemPrompt);
        expect(
          handle.getBranchEntries?.().filter((e) => (e as { customType?: string }).customType === "subagent:fast"),
        ).toHaveLength(2);
        expect(prompt).not.toHaveBeenCalled();
        await handle.requestAbort();
        handle.dispose();
        expect(readFileSync(cleanupFile, "utf8")).toBe("disposed\n");
        expect(unbind).toHaveBeenCalledTimes(1);
        expect(humanDispose).toHaveBeenCalled();
      } finally {
        handle?.dispose();
        prompt.mockRestore();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it("real EISDIR seed append failure leaves last good branch and first prompt count zero", async () => {
    const { root, cwd, agentDir } = own();
    const manager = SessionManager.create(cwd, join(root, "sessions"));
    manager.appendMessage({ role: "user", content: "fixture flush", timestamp: 1 });
    manager.appendCustomEntry("subagent:fast", { v: 1, mode: "off" });
    const file = manager.getSessionFile()!;
    renameSync(file, `${file}.good`);
    mkdirSync(file);
    const open = vi.spyOn(SessionManager, "open").mockReturnValue(manager);
    const prompt = vi.spyOn(AgentSession.prototype, "prompt");
    try {
      await expect(
        new PiSessionDriver().resume(file, { cwd, agentDir, fastSeed: { v: 1, mode: "on" } }),
      ).rejects.toHaveProperty("code", "EISDIR");
      const records = manager.getBranch().filter((e) => e.type === "custom" && e.customType === "subagent:fast");
      expect(records.map((e) => (e.type === "custom" ? e.data : undefined))).toEqual([{ v: 1, mode: "off" }]);
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
      prompt.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("snapshot throw releases the exact resume reservation before inbox/slots/labels", async () => {
    const { root, cwd } = own();
    const file = join(root, "owned.jsonl");
    writeFileSync(file, "{}\n");
    const type = { name: "worker", description: "worker", promptMode: "append" as const, systemPrompt: "" };
    const deps: SpawnServiceDeps = {
      types: {
        get: () => type,
        list: () => [type],
        configHashOf: () => undefined,
        reload: async () => ({ types: [type], errors: [] }),
      },
      pool: {
        stats: { limit: 1, inUse: 0, queued: 0, slotless: 0 },
        acquire: async (runId) => ({ ok: true, ticket: { runId, release() {} } }),
      },
      runner: { run: () => new Promise(() => {}) },
    };
    try {
      const donor = createSpawnService(deps);
      const original = await donor.spawn({ type: "worker", prompt: "prior" });
      if ("error" in original) throw new Error(original.error.message);
      const previous = {
        ...donor.snapshots()[0]!,
        status: "completed" as const,
        diag: { ...donor.snapshots()[0]!.diag, sessionFile: file },
      };
      const snapshot = vi.fn<() => undefined>(() => {
        throw new Error("capture failed");
      });
      const service = createSpawnService({ ...deps, durableRecords: () => [previous], fastParent: { snapshot } });
      const failed = await service.spawn({
        type: "worker",
        prompt: "resume",
        cwd,
        resumeFrom: original.runId,
        label: "retry",
      });
      expect(failed).toHaveProperty("error.message", "Fast parent snapshot failed: capture failed");
      expect(service.successorOf(file)).toBeUndefined();
      expect(service.successorOf(original.runId)).toBeUndefined();
      expect(service.runningIds()).toEqual([]);
      snapshot.mockImplementation(() => undefined);
      const retried = await service.spawn({
        type: "worker",
        prompt: "resume again",
        cwd,
        resumeFrom: original.runId,
        label: "retry",
        poolFullPolicy: "reject",
      });
      expect(retried).toHaveProperty("runId");
      if ("runId" in retried) expect(service.successorOf(file)).toBe(retried.runId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
