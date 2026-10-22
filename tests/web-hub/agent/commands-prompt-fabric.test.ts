/**
 * fabric (2026-10-22 user ruling, superseding phase-2 §5.3/#9/XI13's blanket refusal): the
 * prompt-op text guard for `/fabric` membership/policy mutations. Prompt text still never
 * executes them (defense-in-depth against a future pi flipping `expandPromptTemplates` defaults,
 * same shape as the `/webhub 2fa|passwd|user` precedent) — the web's EXECUTION surface is the
 * policy-gated command op (`webCommandPolicy.fabric`, default allow). The guard is also the last
 * choke point Feishu frames reach (hub F6 admission forwards Feishu only as prompt/dialog ops),
 * so Feishu origins get the dedicated 「飞书入口」 refusal. Read-only `/fabric status`/`blocks`
 * remain promptable.
 */
import { describe, expect, it, vi } from "vitest";
import { createCommandHandler, type CommandHandlerDeps } from "../../../src/web-hub/agent/commands.js";
import { createCommandLedger } from "../../../src/web-hub/agent/ledger.js";
import { createQueueMirror } from "../../../src/web-hub/agent/queue-mirror.js";
import type { BuiltinBridge } from "../../../src/web-hub/agent/builtin-bridge.js";
import type { CmdFrame, CmdOrigin } from "../../../src/web-hub/protocol/messages.js";
import { fakeCtx, fakePi, fakeTimerQueue } from "./helpers.js";

// The command ledger is process-global (Symbol.for) — same reset discipline as commands.test.ts.
const LEDGER_KEY = Symbol.for("pi-subagent:web-hub:cmd-ledger");
let seq = 0;

const WEB_ORIGIN: CmdOrigin = { listener: "loopback", ip: "127.0.0.1", reqId: "abcdef0123456789" };
const LAN_WEB_ORIGIN: CmdOrigin = { listener: "lan", ip: "192.168.1.23", user: "alice", reqId: "abcdef0123456790" };
/** Hub F6 admission's synthetic marker (`createFeishuCommandOrigin`): `ip:"feishu"`. */
const FEISHU_ORIGIN: CmdOrigin = { listener: "lan", ip: "feishu", user: "feishu:ou_123", reqId: "abcdef0123456791" };

function frame(text: string, origin: CmdOrigin = WEB_ORIGIN): CmdFrame {
  seq += 1;
  return {
    t: "cmd",
    rid: `r-f${seq}`,
    id: `f${seq}`,
    deadlineMs: 8000,
    origin,
    cmd: { op: "prompt", text, deliver: "steer" },
  };
}

function makeHandler(): {
  handler: ReturnType<typeof createCommandHandler>;
  sent: unknown[];
  sendUserMessage: ReturnType<typeof vi.fn>;
} {
  const { pi } = fakePi();
  const { ctx } = fakeCtx({ mode: "tui" });
  const sent: unknown[] = [];
  const builtinBridge: BuiltinBridge = {
    execute: vi.fn(() => ({ ok: false, code: "E_UNSUPPORTED", retryable: false, effect: "none" })),
    isQuiet: () => false,
  };
  const handler = createCommandHandler({
    pi,
    getCtx: () => ctx,
    getSessionId: () => "s1",
    ledger: createCommandLedger(),
    queueMirror: createQueueMirror(),
    compactionState: { manualCompacting: false, dispose() {} },
    originEntry: { appendOrigin: vi.fn(), notify: vi.fn(), dispose: vi.fn() },
    builtinBridge,
    controlEnabled: () => true,
    now: () => 1000,
    send: (f) => sent.push(f),
    onChanged: () => undefined,
    setTimer: fakeTimerQueue().setTimer,
  });
  return { handler, sent, sendUserMessage: vi.spyOn(pi, "sendUserMessage") };
}

const DENIED_RE = /^\/fabric\s+(?:join|leave|receive|block|unblock|fence)(?:\s|$)/;

describe("prompt op: /fabric mutation text refusal (2026-10-22 ruling)", () => {
  it.each([
    "/fabric join",
    "/fabric leave",
    "/fabric receive wake",
    "/fabric receive off",
    "/fabric block ab12cd34ef56",
    "/fabric block someone",
    "/fabric unblock 1",
    "/fabric fence reset",
    "  /fabric join  ",
    "/fabric join\n",
    "please run /fabric leave now", // not a match — free text mentioning the command
  ] as const)("%s is classified before dispatch", (text) => {
    delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY];
    const h = makeHandler();
    h.handler.handle(frame(text));
    const denied = String(text).trim().match(DENIED_RE) !== null;
    if (denied) {
      expect(h.sent).toMatchObject([{ ok: false, code: "E_COMMAND_DENIED", effect: "none" }]);
      expect(h.sendUserMessage).not.toHaveBeenCalled();
    } else {
      // free text that merely MENTIONS a mutation stays dispatchable (only a real command
      // line starting with /fabric <mutation> is refused)
      expect(h.sent.some((f) => (f as { code?: string }).code === "E_COMMAND_DENIED")).toBe(false);
    }
    h.handler.dispose();
  });

  it("web origins (loopback + LAN-logged-in) are refused with the command-surface message", () => {
    for (const origin of [WEB_ORIGIN, LAN_WEB_ORIGIN]) {
      delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY];
      const h = makeHandler();
      h.handler.handle(frame("/fabric join", origin));
      expect(h.sent).toMatchObject([
        {
          ok: false,
          code: "E_COMMAND_DENIED",
          effect: "none",
          message: "Send /fabric as a command (op:command) — webCommandPolicy.fabric applies",
        },
      ]);
      expect(h.sendUserMessage).not.toHaveBeenCalled();
      h.handler.dispose();
    }
  });

  it("feishu-origin prompt text gets the dedicated 飞书 refusal (last choke point feishu frames reach)", () => {
    delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY];
    const h = makeHandler();
    h.handler.handle(frame("/fabric join", FEISHU_ORIGIN));
    expect(h.sent).toMatchObject([
      {
        ok: false,
        code: "E_COMMAND_DENIED",
        effect: "none",
        message: "飞书入口不能修改跨会话加入状态，请在终端或 web 执行",
      },
    ]);
    expect(h.sendUserMessage).not.toHaveBeenCalled();
    h.handler.dispose();
  });

  it("/fabric status and /fabric blocks stay promptable (read-only)", () => {
    delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY];
    const h = makeHandler();
    h.handler.handle(frame("/fabric status"));
    h.handler.handle(frame("/fabric blocks"));
    expect(h.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(h.sent.some((f) => (f as { code?: string }).code === "E_COMMAND_DENIED")).toBe(false);
    h.handler.dispose();
  });
});
