import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createMemoryOwner } from "../../../src/memory/scopes/owner.js";
import { captureMemorySeed, type MemoryScopesGroup } from "../../../src/memory/scopes/wire.js";
const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function owner(
  manager: SessionManager,
  reason: string,
  append = (type: string, data: unknown) => {
    manager.appendCustomEntry(type, data);
  },
) {
  return createMemoryOwner({
    manager,
    append,
    enabled: { session: true, hub: false },
    child: false,
    sessionEpoch: 1,
    branchGen: 0,
    reason,
    context: () => undefined,
    isCurrent: () => true,
    locked: () => false,
    commandContext: () => ({ mode: "unknown", hasUI: false, isWeb: false }),
    remote: () => undefined,
    gate: { check: () => ({ ok: true }) },
  })!;
}
describe("actual manager owner production factory", () => {
  it("a manager without a leaf hint still reads and captures its real session memory", async () => {
    const manager = SessionManager.inMemory("/owned");
    Object.defineProperty(manager, "getLeafId", { value: undefined });
    const r = owner(manager, "created");
    try {
      expect(r.manager).toBe(manager);
      expect(r.session!.view().items).toEqual([]);
      expect(r.session!.snapshot()).toEqual({ v: 1, state: "empty" });
      expect(
        await r.tool.run("create", { op: "create", storageScope: "session", text: "real branch memory" }),
      ).toMatchObject({ ok: true, id: "n1" });
      expect(r.session!.view().items.map((i) => i.item.text)).toEqual(["real branch memory"]);
      expect(r.session!.snapshot()).toMatchObject({
        v: 1,
        state: "captured",
        seed: { fromSid: manager.getSessionId(), items: [{ id: "n1", text: "real branch memory" }] },
      });
    } finally {
      r.dispose();
    }
  });

  it.each(["getSessionId", "getSessionFile", "getBranch"] as const)(
    "%s failures still refuse parent capture",
    (method) => {
      const manager = SessionManager.inMemory("/owned");
      Object.defineProperty(manager, "getLeafId", { value: undefined });
      const r = owner(manager, "created");
      const group: MemoryScopesGroup = {
        runtime: () => r,
        childBinding: {},
        gate: { check: () => ({ ok: true }) },
        dispose: () => r.dispose(),
      };
      try {
        expect(captureMemorySeed(group, {})).toEqual({ v: 1, state: "empty" });
        Object.defineProperty(manager, method, {
          value: () => {
            throw Error(`actual ${method} failed`);
          },
        });
        expect(() => captureMemorySeed(group, {})).toThrow(
          method === "getBranch" ? "actual getBranch failed" : "memory parent unavailable",
        );
      } finally {
        r.dispose();
      }
    },
  );

  it.each(["getSessionId", "getSessionFile", "getBranch"] as const)(
    "missing %s is effective-off rather than an empty captured session",
    (method) => {
      const manager = SessionManager.inMemory("/owned");
      Object.defineProperty(manager, method, { value: undefined });
      expect(owner(manager, "created")).toBeUndefined();
    },
  );

  it("a missing manager is effective-off; present failing identity methods are not", () => {
    expect(owner(undefined as unknown as SessionManager, "created")).toBeUndefined();
    for (const method of ["getSessionId", "getSessionFile"] as const) {
      const manager = SessionManager.inMemory("/owned");
      Object.defineProperty(manager, method, {
        value: () => {
          throw Error(`real ${method} failure`);
        },
      });
      expect(() => owner(manager, "created")).toThrow(`real ${method} failure`);
    }
    const manager = SessionManager.inMemory("/owned");
    Object.defineProperty(manager, "getSessionId", { value: () => undefined });
    expect(() => owner(manager, "created")).toThrow("invalid memory session identity");
  });

  it("buffered append uses original object, same stable owner, once-only poison recovery only on actual reopen", async () => {
    const root = mkdtempSync(join(tmpdir(), "memory39-owner-"));
    roots.push(root);
    const manager = SessionManager.create(root, join(root, "sessions"));
    manager.appendMessage({ role: "user", content: "own offline session", timestamp: Date.now() });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "offline" }],
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
    const r = owner(manager, "created", (type, data) => {
      manager.appendCustomEntry(type, data);
      throw Error("unknown after append");
    });
    expect(r.manager).toBe(manager);
    const op = { op: "create", storageScope: "session", text: "actually appended" };
    expect(await r.tool.run("one", op)).toMatchObject({ ok: false, code: "E_PERSIST_UNKNOWN" });
    expect(r.session!.poisonedNow()).toBe(true);
    r.dispose();
    const reloaded = owner(manager, "reload");
    expect(reloaded.session!.poisonedNow()).toBe(true);
    expect(await reloaded.tool.run("two", op)).toMatchObject({ ok: false, code: "E_PERSIST_UNKNOWN" });
    reloaded.dispose();
    const reopened = SessionManager.open(manager.getSessionFile()!);
    expect(reopened).not.toBe(manager);
    const resumed = owner(reopened, "resume");
    expect(resumed.session!.poisonedNow()).toBe(false);
    expect(resumed.session!.view().items.map((i) => i.item.text)).toEqual(["actually appended"]);
    expect(await resumed.tool.run("three", { ...op, text: "after verified reopen" })).toMatchObject({ ok: true });
    const stable = resumed.owner;
    reopened.appendCustomEntry("ordinary-leaf", {});
    expect(resumed.owner).toBe(stable);
    resumed.dispose();
    resumed.dispose();
    expect(resumed.signal.aborted).toBe(true);
    expect(await resumed.tool.run("four", op)).toMatchObject({ ok: false });
  });
});
