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
