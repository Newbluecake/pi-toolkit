import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BASELINE, fakeCtx, fakePi, resetGlobals, sandbox } from "../../integration/helpers/schedule-activate.js";
import { resetSecureDomainForTests } from "../../../src/secure/domain.js";
import type { CommandHandler, CommandHandlerDeps } from "../../../src/web-hub/agent/commands.js";
import type { CmdFrame } from "../../../src/web-hub/protocol/messages.js";

// Async completion is an intentionally injected bridge seam: the production memoryRead port is synchronous.
const observed = vi.hoisted(() => ({
  handler: undefined as CommandHandler | undefined,
  ledger: undefined as CommandHandlerDeps["ledger"] | undefined,
  resolve: undefined as ((value: never) => void) | undefined,
}));
vi.mock("../../../src/web-hub/agent/builtin-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/web-hub/agent/builtin-bridge.js")>();
  return {
    ...actual,
    createBuiltinBridge: (...args: Parameters<typeof actual.createBuiltinBridge>) => {
      const bridge = actual.createBuiltinBridge(...args);
      return {
        ...bridge,
        execute: () =>
          new Promise((resolve) => {
            observed.resolve = resolve;
          }),
      };
    },
  };
});
vi.mock("../../../src/web-hub/agent/commands.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/web-hub/agent/commands.js")>();
  return {
    ...actual,
    createCommandHandler: (...args: Parameters<typeof actual.createCommandHandler>) => {
      const handler = actual.createCommandHandler(...args);
      observed.handler = handler;
      observed.ledger = args[0].ledger;
      return handler;
    },
  };
});
import activate from "../../../src/index.js";

describe("memory waiters through root lifecycle wiring", () => {
  beforeEach(() => {
    resetGlobals();
    resetSecureDomainForTests();
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent:web-hub:cmd-ledger")];
  });
  afterEach(() => {
    resetGlobals();
    resetSecureDomainForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    observed.handler = undefined;
    observed.ledger = undefined;
    observed.resolve = undefined;
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent:web-hub:cmd-ledger")];
  });
  it.each(["session_tree", "session_shutdown"])("clears the waiter via actual %s handler", async (event) => {
    const box = sandbox("memory-waiter-wiring-");
    vi.stubEnv("PI_CODING_AGENT_DIR", `${box.home}/.pi/agent`);
    vi.stubEnv("PI_OFFLINE", "1");
    box.writeSettings({
      ...BASELINE,
      webHub: { enabled: true, autoStart: false, port: 0 },
      quota: { enabled: false },
      load: { enabled: false },
      title: { enabled: false },
    });
    const originalSet = Map.prototype.set;
    let waiters: Map<unknown, unknown> | undefined;
    const spy = vi.spyOn(Map.prototype, "set").mockImplementation(function (
      this: Map<unknown, unknown>,
      key: unknown,
      value: unknown,
    ) {
      if (key === "wire-mem" && value && typeof value === "object" && "timer" in value && "frame" in value)
        waiters = this;
      return originalSet.call(this, key, value);
    });
    const { pi, handlers } = fakePi();
    const { ctx } = fakeCtx(box.home);
    const fire = async (name: string, data: object) => {
      for (const fn of handlers.get(name) ?? []) await fn(data, ctx);
    };
    try {
      activate(pi);
      await fire("session_start", { type: "session_start", reason: "startup" });
      expect(observed.handler).toBeDefined();
      const frame: CmdFrame = {
        t: "cmd",
        id: "wire-mem",
        rid: "r-wire",
        deadlineMs: 8000,
        origin: { listener: "loopback", ip: "127.0.0.1", reqId: "0123456789abcdef" },
        cmd: { op: "command", name: "mem", args: "list" },
      };
      observed.handler!.handle(frame);
      expect(waiters?.size).toBe(1);
      await fire(event, event === "session_shutdown" ? { type: event, reason: "reload" } : { type: event });
      expect(waiters?.size).toBe(0);
      expect(observed.ledger?.query("wire-mem")).toMatchObject({
        state: "failed",
        result: { code: "E_STALE_CTX", retryable: false },
      });
      observed.resolve!({ ok: true, data: { op: "abort" } } as never);
      await Promise.resolve();
      expect(observed.ledger?.query("wire-mem")).toMatchObject({ state: "failed", result: { code: "E_STALE_CTX" } });
      if (event === "session_tree") await fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
    } finally {
      spy.mockRestore();
      box.cleanup();
    }
  });
});
