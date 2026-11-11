import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { createMemoryOwner } from "../../../src/memory/scopes/owner.js";
import * as confirm from "../../../src/memory/command-confirm.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  vi.restoreAllMocks();
});
function owner(session: boolean, hub: boolean) {
  const manager = SessionManager.inMemory("/"),
    other = SessionManager.inMemory("/");
  const ctx = { sessionManager: manager, cwd: "/" } as unknown as ExtensionContext;
  let current = true,
    locked = false,
    allowed = true;
  const runtime = createMemoryOwner({
    manager,
    append: vi.fn(),
    enabled: { session, hub },
    child: false,
    sessionEpoch: 1,
    branchGen: 0,
    reason: "created",
    context: () => ctx,
    isCurrent: () => current,
    locked: () => locked,
    commandContext: () => ({ mode: "tui", hasUI: true, isWeb: false }),
    remote: () => undefined,
    gate: { check: () => (allowed ? { ok: true } : { ok: false, reason: "E_WRITE_GATE" }) },
  })!;
  cleanup.push(() => runtime.dispose());
  return {
    runtime,
    manager,
    other,
    ctx,
    revoke: () => {
      current = false;
    },
    lock: () => {
      locked = true;
    },
    deny: () => {
      allowed = false;
    },
  };
}
it.each([
  [true, false],
  [false, true],
  [true, true],
  [false, false],
])(
  "read-only actual capabilities session=%s hub=%s are independent, no kernel/branch/owner construction",
  (session, hub) => {
    const h = owner(session!, hub!);
    const kernel = vi.spyOn(confirm, "createCommandConfirmKernel");
    const branch = vi.spyOn(h.manager, "getBranch");
    expect(h.runtime.webCapabilities(h.ctx, true)).toEqual({ sessionAdd: session, revisionReview: session || hub });
    expect(h.runtime.webCapabilities(h.ctx, false)).toEqual({ sessionAdd: session, revisionReview: false });
    expect(h.runtime.webCapabilities(undefined, true)).toEqual({ sessionAdd: false, revisionReview: false });
    expect(h.runtime.webCapabilities({ sessionManager: h.other }, true)).toEqual({
      sessionAdd: false,
      revisionReview: false,
    });
    expect(
      h.runtime.webCapabilities(
        {
          get sessionManager() {
            throw Error("unknown");
          },
        },
        true,
      ),
    ).toEqual({ sessionAdd: false, revisionReview: false });
    expect(kernel).not.toHaveBeenCalled();
    expect(branch).not.toHaveBeenCalled();
  },
);
it.each(["dispose", "manager", "sid", "gate", "locked", "current"])(
  "capabilities fail closed on actual %s; old owner never falls back",
  (mode) => {
    const h = owner(true, true);
    if (mode === "dispose") h.runtime.dispose();
    if (mode === "manager") Object.assign(h.ctx, { sessionManager: h.other });
    if (mode === "sid") h.manager.newSession();
    if (mode === "gate") h.deny();
    if (mode === "locked") h.lock();
    if (mode === "current") h.revoke();
    expect(h.runtime.webCapabilities(h.ctx, true)).toEqual({ sessionAdd: false, revisionReview: false });
  },
);
