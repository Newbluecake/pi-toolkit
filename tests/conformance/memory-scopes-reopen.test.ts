/** Official pi 1.5 offline own/tmp runtime evidence, NOT P4c production wiring.
 * Uses the existing fake-provider runtime harness; no SDK patches, network, real user
 * sessions or isReopened booleans. Real runtime switchSession/newSession/reload/rebind
 * supply actual ctx.sessionManager objects to the production poison/store kernel.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createProbeHarness, type ProbeHarness } from "./topic-switch-runtime-harness.js";
import {
  createSessionMemoryStore,
  sessionPoisonIdentity,
  type SessionMemoryStore,
} from "../../src/memory/scopes/session-store.js";
import { sharedSessionPoisonRegistry, type SessionRecoveryAuthority } from "../../src/memory/scopes/session-poison.js";
import type { MemoryOwner } from "../../src/memory/scopes/types.js";

async function fixture(run: (f: Awaited<ReturnType<typeof build>>) => Promise<void>) {
  const f = await build();
  try {
    await run(f);
    expect(f.harness.modelRuntime.callCount()).toBe(0);
  } finally {
    await f.harness.dispose();
  }
}
async function build() {
  const registry = sharedSessionPoisonRegistry();
  let current:
    | {
        store: SessionMemoryStore;
        owner: MemoryOwner;
        manager: object;
        context: ExtensionContext;
        authority: SessionRecoveryAuthority;
        key: string;
      }
    | undefined;
  let epoch = 0,
    branchReads = 0,
    appendAttempts = 0;
  let failAfterAppend = false;
  const starts: { reason: string; manager: object; context: ExtensionContext; recovered: boolean; issued: boolean }[] =
    [];
  const harness: ProbeHarness = await createProbeHarness({
    scripted: [],
    hooks: {
      onSessionStart(event, ctx, _generation, pi) {
        current?.store.dispose();
        current?.authority.dispose();
        const manager = ctx.sessionManager;
        const owner: MemoryOwner = {
          incarnation: {},
          sid: manager.getSessionId(),
          sessionEpoch: ++epoch,
          branchGen: epoch,
          ...(manager.getSessionFile() !== undefined ? { sessionFile: manager.getSessionFile()! } : {}),
        };
        const authority = registry.recoveryAuthority();
        const key = sessionPoisonIdentity(JSON.stringify([owner.sid, owner.sessionFile]));
        const store = createSessionMemoryStore({
          currentOwner: () => current!.owner,
          getManager: () => ctx.sessionManager,
          getSessionId: () => ctx.sessionManager.getSessionId(),
          getSessionFile: () => ctx.sessionManager.getSessionFile(),
          isLocked: () => false,
          getBranch: () => {
            branchReads++;
            return ctx.sessionManager.getBranch();
          },
          now: () => "2026-11-07T00:00:00.000Z",
          poisonRegistry: registry,
          recovery: authority,
          appendCustomEntry(type, data) {
            appendAttempts++;
            pi.appendEntry(type, data);
            if (failAfterAppend) {
              failAfterAppend = false;
              throw new Error("own fixture observes unknown after real append");
            }
          },
        });
        current = { store, owner, manager, context: ctx, authority, key };
        // Fixture models the approved host qualification ONLY from the actual runtime event.
        // This is NOT a newly wired toolkit hook. Production qualification belongs to P4c.
        const receipt = event.reason === "resume" ? authority.recordReopen(key, "resume", manager) : undefined;
        const recovered = receipt !== undefined && store.verifyRecovery(receipt);
        starts.push({ reason: event.reason, manager, context: ctx, recovered, issued: receipt !== undefined });
      },
      onSessionShutdown() {
        current?.store.dispose();
        current?.authority.dispose();
      },
    },
  });
  function active() {
    if (current === undefined) throw new Error("actual SDK session_start missing");
    return current;
  }
  async function write(text: string) {
    const c = active();
    return c.store.enqueue({
      operation: { storageScope: "session", op: "create", authority: "agent", text },
      owner: c.owner,
    });
  }
  function persistedFile() {
    const manager = SessionManager.create(harness.cwd, join(harness.cwd, "sessions"));
    manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "own tmp user, no provider call" }],
      timestamp: Date.now(),
    });
    const file = manager.getSessionFile();
    if (file === undefined || !existsSync(file)) throw new Error("own tmp SDK file not persisted");
    return file;
  }
  return {
    harness,
    registry,
    starts,
    active,
    write,
    persistedFile,
    branchReads: () => branchReads,
    appendAttempts: () => appendAttempts,
    failNextAppend: () => {
      failAfterAppend = true;
    },
  };
}

describe("B2 actual SDK manager recovery facts", () => {
  it("public ctx getter is actual manager; reload/rebind keep it and do not clear; actual resume opens new object and verifies branch", async () =>
    fixture(async (f) => {
      expect(f.active().manager).toBe(f.harness.session().sessionManager);
      const file = f.persistedFile();
      await f.harness.runtime.switchSession(file);
      const failed = f.active();
      expect(f.starts.at(-1)?.reason).toBe("resume");
      f.failNextAppend();
      expect(await f.write("unknown but actually appended")).toMatchObject({ ok: false, code: "E_PERSIST_UNKNOWN" });
      const attempts = f.appendAttempts();
      await f.harness.session().reload();
      expect(f.starts.at(-1)?.reason).toBe("reload");
      expect(f.active().manager).toBe(failed.manager);
      expect(f.active().context === failed.context).toBe(false);
      expect(f.active().store.poisonedNow()).toBe(true);
      expect(f.starts.at(-1)?.issued).toBe(false);
      await f.harness.session().bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
      expect(f.active().manager).toBe(failed.manager);
      expect(await f.write("must not append after rebind")).toMatchObject({ ok: false, code: "E_PERSIST_UNKNOWN" });
      expect(f.appendAttempts()).toBe(attempts);
      const beforeReads = f.branchReads();
      await f.harness.runtime.switchSession(file);
      expect(f.active().manager).not.toBe(failed.manager);
      expect(f.active().manager).toBe(f.harness.session().sessionManager);
      expect(f.active().key).toBe(failed.key);
      expect(f.branchReads()).toBeGreaterThan(beforeReads);
      expect(f.starts.at(-1)).toMatchObject({ reason: "resume", issued: true, recovered: true });
      expect(f.registry.code(failed.key)).toBeUndefined();
      expect(
        f
          .active()
          .store.view()
          .items.map((i) => i.item.text),
      ).toContain("unknown but actually appended");
      expect(await f.write("after verified open")).toMatchObject({ ok: true });
      expect(
        await failed.store.enqueue({
          operation: { storageScope: "session", op: "create", authority: "agent", text: "late old owner" },
          owner: failed.owner,
        }),
      ).toMatchObject({ ok: false, code: "E_STALE_SESSION" });
    }));
  it("real runtime new has new object/sid and empty branch but NEVER clears the old identity", async () =>
    fixture(async (f) => {
      const file = f.persistedFile();
      await f.harness.runtime.switchSession(file);
      f.failNextAppend();
      await f.write("old failed session");
      const old = f.active();
      await f.harness.runtime.newSession();
      expect(f.starts.at(-1)).toMatchObject({ reason: "new", issued: false, recovered: false });
      expect(f.active().manager).not.toBe(old.manager);
      expect(f.active().owner.sid).not.toBe(old.owner.sid);
      expect(f.active().store.view().items).toHaveLength(0);
      expect(f.registry.code(old.key)).toBe("E_PERSIST_UNKNOWN");
      expect(await f.write("new session owns its own memory")).toMatchObject({ ok: true });
      // Ordinary SessionManager.newSession changes sid on the SAME object, not an open proof.
      const same = f.harness.session().sessionManager;
      const id = f.registry.captureManager(same);
      same.newSession();
      expect(f.registry.captureManager(same)).toBe(id);
      expect(f.registry.recoveryAuthority().recordReopen(old.key, "new" as "resume", same)).toBeUndefined();
      expect(f.registry.code(old.key)).toBe("E_PERSIST_UNKNOWN");
    }));
  it("plain actual SessionManager.newSession on the failed object cannot masquerade as resume", async () =>
    fixture(async (f) => {
      const file = f.persistedFile();
      await f.harness.runtime.switchSession(file);
      f.failNextAppend();
      await f.write("failed before same-object newSession");
      const old = f.active(),
        actual = f.harness.session().sessionManager;
      const id = f.registry.captureManager(actual);
      actual.newSession();
      expect(actual.getSessionId()).not.toBe(old.owner.sid);
      expect(f.registry.captureManager(actual)).toBe(id);
      expect(f.registry.recoveryAuthority().recordReopen(old.key, "resume", actual)).toBeUndefined();
      expect(f.registry.code(old.key)).toBe("E_PERSIST_UNKNOWN");
      expect(
        await old.store.enqueue({
          operation: { storageScope: "session", op: "create", authority: "agent", text: "stale sid" },
          owner: old.owner,
        }),
      ).toMatchObject({ ok: false, code: "E_STALE_SESSION" });
    }));
  it("actual open+fresh read qualifies before later UI finish failure; disposed old owner stays cancelled", async () =>
    fixture(async (f) => {
      const file = f.persistedFile();
      await f.harness.runtime.switchSession(file);
      f.failNextAppend();
      await f.write("content survives actual reopen");
      const old = f.active();
      await expect(
        f.harness.runtime.switchSession(file, {
          withSession: async () => {
            throw new Error("own late UI finish failure");
          },
        }),
      ).rejects.toThrow("own late UI finish failure");
      expect(f.active().manager).not.toBe(old.manager);
      expect(f.active().manager).toBe(f.harness.session().sessionManager);
      expect(f.starts.at(-1)).toMatchObject({ reason: "resume", recovered: true });
      expect(f.registry.code(old.key)).toBeUndefined();
      expect(old.store.verifyRecovery({} as never)).toBe(false);
      expect(
        await old.store.enqueue({
          operation: { storageScope: "session", op: "create", authority: "agent", text: "old rollback owner" },
          owner: old.owner,
        }),
      ).toMatchObject({ ok: false, code: "E_STALE_SESSION" });
    }));
});
