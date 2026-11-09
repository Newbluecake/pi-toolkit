import { describe, expect, it, vi } from "vitest";
import { SessionManager, type ExtensionContext, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fakePi, emitAll } from "../../integration/helpers/schedule-activate.js";
import { DEFAULT_MEMORY_SETTINGS } from "../../../src/memory/settings.js";
import { wireMemoryScopes, captureMemorySeed } from "../../../src/memory/scopes/wire.js";
import type { AskUserRemotePort } from "../../../src/ask-user/remote.js";

function context(manager: SessionManager): ExtensionCommandContext {
  return {
    sessionManager: manager,
    cwd: "/owned",
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: { select: async () => undefined, notify() {} },
  } as unknown as ExtensionCommandContext;
}
function harness() {
  const pi = fakePi();
  const manager = SessionManager.inMemory("/owned");
  pi.pi.appendEntry = (type, data) => {
    manager.appendCustomEntry(type, data);
  };
  let remote: AskUserRemotePort | undefined;
  const wiring = wireMemoryScopes(pi.pi, {
    settings: { ...DEFAULT_MEMORY_SETTINGS, scopes: { session: true, hub: false } },
    child: false,
    domain: "plain",
    gate: { check: () => ({ ok: true }) },
    locked: () => false,
    remote: () => remote,
    hubPaths: () => {
      throw Error("hub-off must not resolve paths");
    },
  })!;
  return {
    pi,
    manager,
    wiring,
    ctx: context(manager),
    remote(value: AskUserRemotePort) {
      remote = value;
    },
  };
}
describe("scopes activation group", () => {
  it("off/secure/locked create no hooks, paths, store, poison global or port", () => {
    for (const domain of ["plain", "secure", "locked"] as const) {
      const pi = fakePi(),
        paths = vi.fn(() => {
          throw Error("no path reads");
        });
      const before = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("pi-subagent:memory-session-poison"));
      const result = wireMemoryScopes(pi.pi, {
        settings: { ...DEFAULT_MEMORY_SETTINGS, scopes: { session: domain !== "plain", hub: true } },
        child: false,
        domain,
        gate: { check: () => ({ ok: true }) },
        locked: () => false,
        remote: () => undefined,
        hubPaths: paths,
        ...(domain === "plain"
          ? { settings: { ...DEFAULT_MEMORY_SETTINGS, scopes: { session: false, hub: false } } }
          : {}),
      });
      expect(result).toBeUndefined();
      expect(paths).not.toHaveBeenCalled();
      expect(pi.handlers.size).toBe(0);
      expect(pi.tools.size).toBe(0);
      expect(Object.getOwnPropertyDescriptor(globalThis, Symbol.for("pi-subagent:memory-session-poison"))).toEqual(
        before,
      );
    }
  });
  it.each(["manager", "getSessionId", "getSessionFile", "getBranch"] as const)(
    "missing %s leaves no parent/workflow capture port or authority and preserves unrelated hooks",
    async (missing) => {
      const pi = fakePi();
      const paths = vi.fn(() => ({ stateDir: "/must-not-read" }));
      const wiring = wireMemoryScopes(pi.pi, {
        settings: { ...DEFAULT_MEMORY_SETTINGS, scopes: { session: true, hub: true } },
        child: false,
        domain: "plain",
        gate: { check: () => ({ ok: true }) },
        locked: () => false,
        remote: () => undefined,
        hubPaths: paths,
      })!;
      const manager = SessionManager.inMemory("/owned");
      const branch = vi.spyOn(manager, "getBranch");
      if (missing !== "manager") Object.defineProperty(manager, missing, { value: undefined });
      const ctx = context(missing === "manager" ? (undefined as unknown as SessionManager) : manager);
      const downstream = vi.fn();
      pi.pi.on("session_start", downstream);
      try {
        await emitAll(pi, "session_start", { type: "session_start", reason: "startup" }, ctx);
        expect(downstream).toHaveBeenCalledTimes(1);
        expect(wiring.current()).toBeUndefined();
        expect(wiring.group()).toBeUndefined();
        for (const event of ["input", "before_agent_start", "agent_start", "session_tree"]) {
          await emitAll(pi, event, { type: event }, ctx);
          expect(wiring.current()).toBeUndefined();
          expect(wiring.group()).toBeUndefined();
        }
        expect(paths).not.toHaveBeenCalled();
        expect(branch).not.toHaveBeenCalled();
        expect((await wiring.command("session add no-authority", ctx)).result).toMatchObject({
          ok: false,
          code: "E_STALE_SESSION",
        });
      } finally {
        wiring.dispose();
      }
    },
  );

  it("loss of manager revokes the exact old owner; a later complete context can open a new one", async () => {
    const h = harness();
    await emitAll(h.pi, "session_start", { type: "session_start", reason: "startup" }, h.ctx);
    const old = h.wiring.current()!;
    h.wiring.context(context(undefined as unknown as SessionManager));
    expect(old.signal.aborted).toBe(true);
    expect(h.wiring.group()).toBeUndefined();
    h.wiring.context(h.ctx);
    expect(h.wiring.current()!.owner.incarnation).not.toBe(old.owner.incarnation);
    h.wiring.dispose();
  });

  it("ordinary leaf keeps owner; tree rotates and exact old-group teardown cannot revoke replacement", async () => {
    const h = harness();
    await emitAll(h.pi, "session_start", { type: "session_start", reason: "startup" }, h.ctx);
    const first = h.wiring.current()!,
      group = h.wiring.group()!;
    expect((await h.wiring.command("session add human", h.ctx)).result).toMatchObject({ ok: true });
    h.manager.appendCustomEntry("ordinary-leaf", {});
    h.wiring.context(h.ctx);
    expect(h.wiring.current()!.owner).toBe(first.owner);
    const snap = captureMemorySeed(group, {});
    expect(snap.state).toBe("captured");
    expect(Object.isFrozen(snap)).toBe(true);
    await emitAll(h.pi, "session_tree", { type: "session_tree" }, h.ctx);
    const tree = h.wiring.current()!;
    expect(tree.owner.incarnation).not.toBe(first.owner.incarnation);
    expect(first.signal.aborted).toBe(true);
    expect(tree.owner.branchGen).toBe(first.owner.branchGen + 1);
    expect(captureMemorySeed(group, {}).state).toBe("captured");
    await emitAll(h.pi, "session_start", { type: "session_start", reason: "reload" }, h.ctx);
    const next = h.wiring.current()!;
    group.dispose();
    group.dispose();
    expect(tree.signal.aborted).toBe(true);
    expect(next.signal.aborted).toBe(false);
    expect(h.wiring.current()).toBe(next);
    expect(() => captureMemorySeed(group, {})).toThrow("unavailable");
    h.wiring.dispose();
    expect(next.signal.aborted).toBe(true);
  });
  it("live remote getter reaches newly attached shared approval, RPC cannot open local select", async () => {
    const h = harness();
    const ctx = { ...h.ctx, mode: "rpc" } as ExtensionContext;
    await emitAll(h.pi, "session_start", { type: "session_start", reason: "startup" }, ctx);
    const r = h.wiring.current()!;
    r.tracker.noteWebTurn(r.owner);
    const opens = vi.fn();
    h.remote({
      open(req) {
        opens(req);
        return {
          setOnRemote(fn) {
            fn({
              kind: "answer",
              answers: { SESSION: req.questions[0]!.options[1]!.label },
              origin: "browser",
              originKind: "loopback",
            });
          },
          close() {},
        };
      },
    });
    expect(
      await r.tool.run("user-write", {
        op: "create",
        storageScope: "session",
        authority: "user",
        text: "remote approved exact body",
      }),
    ).toMatchObject({ ok: true });
    expect(opens).toHaveBeenCalledTimes(1);
    expect(r.session!.view().items[0]!.item.authority).toBe("user");
    h.wiring.dispose();
  });
});
