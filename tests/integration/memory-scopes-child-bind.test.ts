import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { PiSessionDriver, PiSessionHandle } from "../../src/runtime/session-driver.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const model = {
  id: "fake",
  name: "Fake",
  api: "anthropic-messages",
  provider: "fake",
  baseUrl: "http://localhost",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0 },
  contextWindow: 200000,
  maxTokens: 1024,
};
describe("memory-only canonical public SDK loader", () => {
  it("binds actual created/open manager before any prompt, with frozen same parent slot and exact cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "memory39-child-bind-"));
    roots.push(root);
    const cwd = join(root, "cwd"),
      agentDir = join(root, "agent");
    mkdirSync(cwd);
    mkdirSync(agentDir);
    const plugin = join(root, "receiver.ts");
    // Fixture imports production receiver; bus capture through actual loader discovery.
    writeFileSync(
      plugin,
      `import { receiveMemoryChildBinding } from ${JSON.stringify(join(import.meta.dirname, "../../src/memory/scopes/child-bind.ts"))}; export default pi => { receiveMemoryChildBinding(pi.events, req => { req.manager.appendCustomEntry("memory39:bound", { reason:req.reason, slot:req.frozenParentHubSlot, frozen:Object.isFrozen(req.frozenParentHubSlot) }); return () => req.manager.appendCustomEntry("memory39:disposed", { reason:req.reason }); }); };`,
    );
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [plugin], cacheWarming: "off" }));
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("No network"));
    const prompt = vi.spyOn(AgentSession.prototype, "prompt");
    const slot = { effectiveStateDir: join(root, "state"), uid: process.getuid!(), source: "web-hub" as const };
    const driver = new PiSessionDriver(false, () => model, undefined, undefined, undefined, {
      strict: true,
      frozenParentHubSlot: slot,
    });
    const spec = { cwd, agentDir, persist: false, model: { provider: "fake", id: "fake" } };
    const created = (await driver.create(spec)) as PiSessionHandle;
    const sm = created.session.sessionManager;
    expect(
      sm
        .getBranch()
        .filter((e) => e.type === "custom")
        .map((e) => e.data),
    ).toEqual([{ reason: "created", slot, frozen: true }]);
    created.dispose();
    created.dispose();
    expect(sm.getBranch().filter((e) => e.type === "custom" && e.customType === "memory39:disposed")).toHaveLength(1);
    const persisted = SessionManager.create(cwd, join(root, "sessions"));
    persisted.appendMessage({ role: "user", content: "owned offline fixture", timestamp: Date.now() });
    persisted.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "owned" }],
      api: "anthropic-messages",
      provider: "fake",
      model: "fake",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const resumed = (await driver.resume(persisted.getSessionFile()!, spec)) as PiSessionHandle;
    expect(resumed.session.sessionManager).not.toBe(persisted);
    expect(
      resumed.getBranchEntries!().filter((e) => (e as { customType?: string }).customType === "memory39:bound"),
    ).toMatchObject([{ data: { reason: "resume", slot, frozen: true } }]);
    resumed.dispose();
    expect(prompt).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });
});
