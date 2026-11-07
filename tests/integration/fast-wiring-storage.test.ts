import { mkdtempSync, mkdirSync, renameSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createFastController, wireFastMain, type FastSessionPorts } from "../../src/fast/wire.js";
import { readFastMode } from "../../src/fast/state.js";

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("Fast test forbids external transport"));
  vi.spyOn(Socket.prototype, "connect").mockImplementation(() => {
    throw Error("Fast test forbids sockets");
  });
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe("production Fast controller and real SDK1.5 storage", () => {
  it.each([false, true])(
    "actual EISDIR rollback, later append/branch/reopen cannot revive failed on (flushed=%s)",
    (flushed) => {
      const root = mkdtempSync(join(tmpdir(), "fast-wiring-store-"));
      try {
        const manager = SessionManager.create(root, join(root, "sessions"));
        if (flushed) manager.appendMessage({ role: "user", content: "fixture flush", timestamp: 1 });
        manager.appendCustomEntry("subagent:fast", { v: 1, mode: "off" });
        const offLeaf = manager.getLeafId()!;
        const file = manager.getSessionFile()!;
        // SDK buffers pre-message custom entries; force a real write via appendMessage when unflushed.
        const append = (type: string, data: unknown) => {
          manager.appendCustomEntry(type, data);
        };
        const controller = createFastController({
          getBranch: () => manager.getBranch(),
          appendEntry: append,
          isCurrent: () => true,
        });
        if (!flushed) {
          controller.command("on"); // A buffered append's normal return IS success by the public SDK contract.
          expect(controller.snapshot()?.mode).toBe("on");
          controller.command("off");
          manager.appendMessage({ role: "user", content: "flush buffered records", timestamp: 2 });
        }
        renameSync(file, `${file}.good`);
        mkdirSync(file);
        controller.command("on");
        expect(controller.snapshot()?.mode).toBe("off");
        expect(controller.describe()).toContain("storage-fault");
        expect(readFastMode(manager.getBranch())).toBe("off");
        rmSync(file, { recursive: true });
        renameSync(`${file}.good`, file);
        manager.appendCustomEntry("unrelated", { ok: true });
        manager.branch(offLeaf);
        expect(controller.snapshot()?.mode).toBe("off");
        manager.appendCustomEntry("unrelated", { fork: true });
        expect(readFastMode(SessionManager.open(file).getBranch())).toBe("off");
        const entries = readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { customType?: string; data?: { mode: string } });
        const fast = entries.filter((e) => e.customType === "subagent:fast");
        expect(fast.at(-1)?.data?.mode).toBe("off");
        // No Fast on entry was appended by the failed command (buffered normal successes above are retained).
        expect(fast.filter((e) => e.data?.mode === "on")).toHaveLength(flushed ? 0 : 1);
        controller.dispose();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("actual SDK command capture: normal append success, zero startup/status records and stale ctx after dispose", async () => {
    const root = mkdtempSync(join(tmpdir(), "fast-wiring-sdk-"));
    const manager = SessionManager.inMemory(root);
    let ports: FastSessionPorts | undefined;
    let capturedCtx: ExtensionContext | undefined;
    const settingsManager = SettingsManager.inMemory({ cacheWarming: "off" });
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: join(root, "agent"),
      settingsManager,
      noExtensions: true,
      extensionFactories: [
        (pi) => {
          const fast = wireFastMain(pi, true)!;
          pi.on("session_start", (_event, ctx) => {
            capturedCtx = ctx;
            ports = fast.open(ctx);
          });
        },
      ],
    });
    await loader.reload();
    const modelRuntime = await ModelRuntime.create({
      authPath: join(root, "auth.json"),
      modelsPath: join(root, "models.json"),
      modelsStorePath: join(root, "catalog"),
      allowModelNetwork: false,
    });
    const { session } = await createAgentSession({
      cwd: root,
      agentDir: join(root, "agent"),
      sessionManager: manager,
      settingsManager,
      resourceLoader: loader,
      modelRuntime,
      noTools: "all",
    });
    try {
      await session.bindExtensions({});
      expect(ports?.workflow.capture()).toEqual({ v: 1, mode: "inherit" });
      const count = () =>
        manager.getBranch().filter((e) => e.type === "custom" && e.customType === "subagent:fast").length;
      expect(count()).toBe(0);
      await session.prompt("/fast status");
      expect(count()).toBe(0);
      await session.prompt("/fast on");
      expect(count()).toBe(1);
      expect(ports?.workflow.capture()).toEqual({ v: 1, mode: "on" });
      await session.prompt("/fast on");
      await session.prompt("/fast nope");
      expect(count()).toBe(1);
      await session.prompt("/fast off");
      expect(count()).toBe(2);
      expect(readFastMode(manager.getBranch())).toBe("off");
      session.dispose();
      expect(() => capturedCtx!.sessionManager).toThrow(/stale|disposed|replacement/i);
      expect(ports?.workflow.capture()).toBeUndefined();
    } finally {
      ports?.dispose();
      session.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
