import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiSessionDriver, PiSessionHandle } from "../../src/runtime/session-driver.js";
import { createFastController, createFastSessionPorts } from "../../src/fast/wire.js";
import type { FastMode, SessionSpec } from "../../src/core/types.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("Fast production receiver with canonical settings-discovered SDK loader", () => {
  it.each([undefined, "Fast isolated prompt override"])(
    "three seeds, live child branch, two children and disposed owner, prompt=%s",
    async (systemPrompt) => {
      const root = mkdtempSync(join(tmpdir(), "fast-wiring-child-"));
      roots.push(root);
      const cwd = join(root, "cwd");
      const agentDir = join(root, "agent");
      mkdirSync(cwd);
      mkdirSync(agentDir);
      const plugin = join(root, "fast-receiver.ts");
      writeFileSync(
        plugin,
        `import { wireFastChild } from ${JSON.stringify(join(import.meta.dirname, "../../src/fast/wire.ts"))}; export default function(pi) { wireFastChild(pi, true); }`,
      );
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [plugin], cacheWarming: "off" }));
      const runtime = await ModelRuntime.create({
        authPath: join(root, "auth.json"),
        modelsPath: join(root, "models.json"),
        modelsStorePath: join(root, "catalog"),
        allowModelNetwork: false,
      });
      const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("No transport permitted"));
      const prompt = vi.spyOn(AgentSession.prototype, "prompt");
      const ports = createFastSessionPorts(
        createFastController({ getBranch: () => [], appendEntry: () => {}, isCurrent: () => true }),
      );
      const driver = new PiSessionDriver(false, (p, id) => runtime.getModel(p, id), undefined, ports.childState);
      const handles: PiSessionHandle[] = [];
      try {
        for (const mode of ["on", "off", "inherit"] as FastMode[]) {
          const spec = {
            cwd,
            agentDir,
            persist: false,
            model: { provider: "openai", id: "gpt-4o-mini" },
            fastSeed: { v: 1, mode },
            runId: `child-${mode}`,
            ...(systemPrompt ? { systemPrompt } : {}),
          } as SessionSpec;
          const handle = (await driver.create(spec)) as PiSessionHandle;
          handles.push(handle);
          expect(ports.parent.snapshot(`child-${mode}`)).toEqual({ v: 1, mode });
          expect(
            handle.getBranchEntries?.().filter((e) => (e as { customType?: string }).customType === "subagent:fast"),
          ).toHaveLength(1);
          handle.session.sessionManager.appendCustomEntry("subagent:fast", { v: 1, mode: "off" });
          expect(ports.parent.snapshot(`child-${mode}`)).toEqual({ v: 1, mode: "off" });
        }
        handles[0]!.session.sessionManager.appendCustomEntry("subagent:fast", { v: 1, mode: "on" });
        expect(ports.parent.snapshot("child-off")).toEqual({ v: 1, mode: "off" });
        expect(ports.parent.snapshot("child-on")).toEqual({ v: 1, mode: "on" });
        handles[0]!.dispose();
        expect(ports.parent.snapshot("child-on")).toBeUndefined();
        expect(ports.parent.snapshot("child-off")).toEqual({ v: 1, mode: "off" });
        ports.dispose();
        expect(ports.parent.snapshot("child-off")).toBeUndefined();
        expect(prompt).not.toHaveBeenCalled();
        expect(network).not.toHaveBeenCalled();
      } finally {
        for (const handle of handles) handle.dispose();
        ports.dispose();
      }
    },
  );
});
