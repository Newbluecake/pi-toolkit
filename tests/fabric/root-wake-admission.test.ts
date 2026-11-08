import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import { buildFabric, readRootBudgetState } from "../../src/fabric/stack.js";

const sender = "r_SENDER01";
function rig(
  options: { idle?: boolean; pending?: boolean; wake?: boolean; throwSend?: boolean; reportQuota?: number } = {},
) {
  let idle = options.idle ?? true;
  let pending = options.pending ?? false;
  const sendMessage = vi.fn((_message: unknown, _options: unknown) => {
    if (options.throwSend) throw new Error("unknown host effect");
  });
  const ctx = {
    isIdle: () => idle,
    hasPendingMessages: () => pending,
    sessionManager: { getSessionId: () => "own-test-session" },
  } as unknown as ExtensionContext;
  const fabric = buildFabric(
    { sendMessage, appendEntry() {} } as unknown as ExtensionAPI,
    ctx,
    {
      ...DEFAULT_SETTINGS,
      fabric: {
        ...DEFAULT_SETTINGS.fabric,
        enabled: true,
        reportQuota: options.reportQuota ?? 20,
        minIntervalMs: 0,
        rootMinIntervalMs: 0,
        wake: { ...DEFAULT_SETTINGS.fabric.wake, enabled: options.wake ?? true },
      },
    },
    [],
    false,
    {},
    () => undefined,
    () => undefined,
    { tombstone: () => undefined, agentTypeExists: () => false },
  );
  fabric.tree.append("root", sender);
  fabric.tree.markRunning(sender);
  const send = (wake: boolean | null = true) =>
    fabric.router.admit(sender, {
      to: "root",
      kind: "report",
      text: "body",
      generation: 1,
      ...(wake === null ? {} : { wake }),
    });
  const arrive = (event = {}) => fabric.rootBudget?.observeAcceptedUserArrival(event);
  return {
    fabric,
    ctx,
    sendMessage,
    send,
    arrive,
    setState: (i: boolean, p = false) => {
      idle = i;
      pending = p;
    },
  };
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("root admission production stack", () => {
  it("no window fails closed; a new user opens two starts regardless of child level; third body still delivered", async () => {
    const r = rig();
    try {
      expect(r.send()).toMatchObject({ ok: true, wake: false, wakeDowngraded: "root_no_window" });
      await flush();
      expect(r.sendMessage.mock.calls[0]?.[1]).toEqual({ triggerTurn: false });
      r.arrive();
      r.fabric.level!.raise(sender, 99);
      expect(r.send()).toMatchObject({ wake: true });
      await flush();
      expect(r.send()).toMatchObject({ wake: true });
      await flush();
      expect(r.send()).toMatchObject({ wake: false, wakeDowngraded: "root_limit" });
      await flush();
      expect(r.fabric.rootBudget!.snapshot()).toMatchObject({ used: 2 });
      expect(r.sendMessage).toHaveBeenCalledTimes(4);
      expect(r.fabric.engine.select((x) => x.state === "delivered")).toHaveLength(4);
    } finally {
      r.fabric.mailbox.dispose();
    }
  });

  it("busy and starting admission do not consume or start; idle burst reserves only once", async () => {
    for (const state of [
      [false, false],
      [true, true],
      [true, false],
    ] as const) {
      const r = rig({ idle: state[0], pending: state[1] });
      try {
        r.arrive();
        const a = r.send();
        const b = r.send();
        expect(a).toMatchObject({ wake: state[0] && !state[1] });
        expect(b).toMatchObject({ wake: false, wakeDowngraded: state[0] && !state[1] ? "root_reserved" : "root_busy" });
        expect(r.fabric.rootBudget!.snapshot().used).toBe(state[0] && !state[1] ? 1 : 0);
        await flush();
        expect(r.sendMessage).toHaveBeenCalledTimes(2);
        if (state[0]) expect(r.sendMessage.mock.calls[1]?.[1]).toEqual({ triggerTurn: false });
      } finally {
        r.fabric.mailbox.dispose();
      }
    }
  });

  it("ordinary rejection does not reserve; failed send retains reservation without refund or body retry", async () => {
    const rejected = rig({ reportQuota: 0 });
    try {
      rejected.arrive();
      expect(rejected.send()).toMatchObject({ status: "quota_exhausted" });
      expect(rejected.fabric.rootBudget!.snapshot().used).toBe(0);
    } finally {
      rejected.fabric.mailbox.dispose();
    }
    const r = rig({ throwSend: true });
    try {
      r.arrive();
      expect(r.send()).toMatchObject({ wake: true });
      await flush();
      r.fabric.mailbox.pump();
      await flush();
      expect(r.sendMessage).toHaveBeenCalledTimes(1);
      expect(r.send()).toMatchObject({ wake: false, wakeDowngraded: "root_reserved" });
      expect(r.fabric.rootBudget!.snapshot().used).toBe(1);
    } finally {
      r.fabric.mailbox.dispose();
    }
  });

  it("missing/throwing/nonboolean host state is unknown, including when the other getter says busy", async () => {
    expect(readRootBudgetState({})).toBe("unknown");
    expect(readRootBudgetState({ isIdle: () => false })).toBe("unknown");
    expect(
      readRootBudgetState({
        isIdle: () => true,
        hasPendingMessages: () => {
          throw Error("x");
        },
      }),
    ).toBe("unknown");
    expect(readRootBudgetState({ isIdle: () => "yes" as never, hasPendingMessages: () => false })).toBe("unknown");
    const r = rig();
    try {
      r.arrive();
      r.ctx.isIdle = () => {
        throw Error("unknown");
      };
      expect(r.send()).toMatchObject({ wake: false, wakeDowngraded: "root_unknown" });
      await flush();
      expect(r.sendMessage.mock.calls[0]?.[1]).toEqual({ triggerTurn: false });
      expect(r.fabric.rootBudget!.snapshot().used).toBe(0);
    } finally {
      r.fabric.mailbox.dispose();
    }
  });

  it("wake off has no budget; omitted wake keeps legacy call; disposed facade cannot reopen", async () => {
    const off = rig({ wake: false });
    try {
      expect(off.fabric.rootBudget).toBeUndefined();
      expect(off.send()).not.toHaveProperty("wake");
      await flush();
      expect(off.sendMessage.mock.calls[0]?.[1]).toEqual({ deliverAs: "steer", triggerTurn: true });
    } finally {
      off.fabric.mailbox.dispose();
    }
    const r = rig();
    try {
      expect(r.send(null)).not.toHaveProperty("wake");
      await flush();
      expect(r.sendMessage.mock.calls[0]?.[1]).toEqual({ deliverAs: "steer", triggerTurn: true });
    } finally {
      r.fabric.mailbox.dispose();
    }
    expect(r.arrive()).toBe(false);
  });
});

describe("#64 persisted root wake downgrade", () => {
  it.each([
    ["root_no_window", { idle: true }, false],
    ["root_busy", { idle: false }, true],
    ["root_reserved", { idle: true }, true],
  ] as const)("retains %s through delivered transition", async (reason, options, arrive) => {
    const r = rig(options);
    try {
      if (arrive) r.arrive();
      if (reason === "root_reserved") r.send();
      const result = r.send();
      expect(result).toMatchObject({ ok: true, wakeDowngraded: reason });
      await flush();
      expect(r.fabric.engine.select((x) => x.key === (result.ok ? result.key : ""))[0]).toMatchObject({
        state: "delivered",
        wakeDowngraded: reason,
      });
    } finally {
      r.fabric.mailbox.dispose();
    }
  });
});
