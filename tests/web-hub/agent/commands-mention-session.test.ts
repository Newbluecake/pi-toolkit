/**
 * fabric reply-plan §9.3 (package M): the web prompt path's @session branch — the SYNC
 * determination gains `sessions?.parse` and the `MentionResultData` `action:"session"` variant
 * (RX0 froze the wire). The send port is a fake (the real sender is RX4; assembly is MW).
 */
import { describe, expect, it, vi } from "vitest";
import { createCommandHandler, type CommandHandlerDeps } from "../../../src/web-hub/agent/commands.js";
import { createCommandLedger } from "../../../src/web-hub/agent/ledger.js";
import { createQueueMirror } from "../../../src/web-hub/agent/queue-mirror.js";
import { createMentionRegistry } from "../../../src/mention/registry.js";
import type { MentionRouteDeps } from "../../../src/mention/mention.js";
import {
  createMentionSessionPort,
  type MentionSessionSendOutcome,
  type SessionMentionNotice,
} from "../../../src/mention/session.js";
import type { XsDirectoryRow } from "../../../src/fabric/xs/directory.js";
import type { BuiltinBridge } from "../../../src/web-hub/agent/builtin-bridge.js";
import type { CmdFrame, CmdOrigin, CmdResultFrame, CmdLateFrame } from "../../../src/web-hub/protocol/messages.js";
import { fakeCtx, fakePi, fakeTimerQueue } from "./helpers.js";

// The command ledger is process-global (Symbol.for) — same reset discipline as commands.test.ts.
const LEDGER_KEY = Symbol.for("pi-subagent:web-hub:cmd-ledger");
const WEB_ORIGIN: CmdOrigin = { listener: "loopback", ip: "127.0.0.1", reqId: "abcdef0123456789" };

let seq = 0;
function frame(text: string): CmdFrame {
  seq += 1;
  return {
    t: "cmd",
    rid: `r-f${seq}`,
    id: `f${seq}`,
    deadlineMs: 8000,
    origin: WEB_ORIGIN,
    cmd: { op: "prompt", text, deliver: "steer" },
  };
}

function row(ref: string, name?: string): XsDirectoryRow {
  return {
    ref,
    ...(name !== undefined ? { name } : {}),
    cwdLabel: "~/repo",
    kind: "main",
    receive: "wake",
    busy: false,
    lastActiveAgoS: 5,
  };
}

interface SessionHarness {
  handle(text: string): void;
  sent: Array<CmdResultFrame | CmdLateFrame>;
  sendUserMessage: ReturnType<typeof vi.fn>;
  notifies: SessionMentionNotice[];
  sends: Array<{ target: string; message: string; options?: { expectReply?: boolean } }>;
  registry: ReturnType<typeof createMentionRegistry>;
  setOutcome(next: MentionSessionSendOutcome | ((call: number) => MentionSessionSendOutcome)): void;
  setJoined(joined: boolean): void;
  dispose(): void;
}

function makeSessionHarness(joined = true): SessionHarness {
  const { pi } = fakePi();
  const { ctx } = fakeCtx({ mode: "tui" });
  const sent: Array<CmdResultFrame | CmdLateFrame> = [];
  const notifies: SessionMentionNotice[] = [];
  const sends: SessionHarness["sends"] = [];
  const registry = createMentionRegistry();
  let isJoined = joined;
  let outcome: MentionSessionSendOutcome | ((call: number) => MentionSessionSendOutcome) = {
    status: "sent",
    effect: "applied",
  };
  const rows: XsDirectoryRow[] = [row("ab12cd34", "builder")];
  const port = createMentionSessionPort({
    joined: () => isJoined,
    isLabel: (name) => registry.resolve(name) !== undefined,
    cwd: () => "/tmp",
    lookupExact: (name) => {
      const hits = rows.filter((r) => r.name === name || r.ref === name);
      return hits.length === 1 ? hits[0] : undefined;
    },
    send: async (target, message, options) => {
      sends.push({ target, message, ...(options !== undefined ? { options } : {}) });
      return typeof outcome === "function" ? outcome(sends.length) : outcome;
    },
  });
  const mentionDeps: MentionRouteDeps = {
    registry,
    query: {
      get: () => ({ status: "running", diag: { lastEventAt: 1 } }),
      steer: vi.fn(async () => ({ ok: true as const })),
    },
    spawn: { spawn: vi.fn() as never },
    sessions: port,
    notifySession: (notice) => notifies.push(notice),
  };
  const builtinBridge: BuiltinBridge = {
    execute: vi.fn(() => ({ ok: false, code: "E_UNSUPPORTED", retryable: false, effect: "none" })),
    isQuiet: () => false,
  };
  const deps: CommandHandlerDeps = {
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
    mention: () => mentionDeps,
  };
  const handler = createCommandHandler(deps);
  return {
    handle: (text) => handler.handle(frame(text)),
    sent,
    sendUserMessage: vi.spyOn(pi, "sendUserMessage"),
    notifies,
    sends,
    registry,
    setOutcome(next) {
      outcome = next;
    },
    setJoined(next) {
      isJoined = next;
    },
    dispose() {
      handler.dispose();
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("web prompt op: @session mentions (reply-plan §9.3)", () => {
  it("routes a session mention and settles with the action:session MentionResultData", async () => {
    delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY];
    const h = makeSessionHarness();
    h.setOutcome({
      status: "sent",
      effect: "applied",
      requestId: "q0123456789abcdef01",
      to: { ref: "ab12cd34", name: "builder" },
    });
    h.handle("@builder 5m 进展如何");
    await flush();
    expect(h.sendUserMessage).not.toHaveBeenCalled(); // intercepted — never a native prompt
    expect(h.sends).toEqual([{ target: "ab12cd34", message: "5m 进展如何" }]); // default expectReply send
    expect(h.sent).toEqual([
      {
        t: "cmd_result",
        rid: expect.any(String),
        id: expect.any(String),
        ok: true,
        data: {
          op: "prompt",
          delivery: "observed",
          behavior: "steer",
          mention: { action: "session", label: "builder", effect: "applied", requestId: "q0123456789abcdef01" },
        },
      },
    ]);
    expect(h.notifies).toHaveLength(1);
    expect(h.notifies[0]?.kind).toBe("sent");
    h.dispose();
  });

  it("explicit @session:<ref> routes with the operand verbatim; failure settles effect-only", async () => {
    delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY];
    const h = makeSessionHarness();
    h.setOutcome({ status: "sent", effect: "none", reason: "rejected" });
    h.handle("@session:ef9911aa hello");
    await flush();
    expect(h.sendUserMessage).not.toHaveBeenCalled();
    expect(h.sends).toEqual([{ target: "ef9911aa", message: "hello" }]);
    expect(h.sent[0]).toMatchObject({
      ok: true,
      data: {
        mention: { action: "session", label: "ef9911aa", effect: "none" }, // no requestId on failure
      },
    });
    expect(h.notifies[0]).toMatchObject({ kind: "error", message: "对方拒收（ef9911aa）" });
    h.dispose();
  });

  it("reply_unsupported falls back to one plain send (no requestId in the wire result)", async () => {
    delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY];
    const h = makeSessionHarness();
    h.setOutcome((call) =>
      call === 1
        ? { status: "reply_unsupported", effect: "none" }
        : { status: "sent", effect: "applied", to: { ref: "ab12cd34", name: "builder" } },
    );
    h.handle("@builder hi");
    await flush();
    expect(h.sends).toHaveLength(2);
    expect(h.sends[1]).toMatchObject({ options: { expectReply: false } });
    expect(h.sent[0]).toMatchObject({
      ok: true,
      data: { mention: { action: "session", label: "builder", effect: "applied" } },
    });
    expect(h.notifies[0]?.message).toContain("对方不支持回复关联");
    h.dispose();
  });

  it("a registered subagent label keeps priority over a same-named session (web path)", async () => {
    delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY];
    const h = makeSessionHarness();
    h.registry.register("builder", { runId: "run-1", type: "general", parent: "root" });
    h.handle("@builder steer please");
    await flush();
    expect(h.sends).toEqual([]); // session branch never reached
    expect(h.sent[0]).toMatchObject({
      ok: true,
      data: { mention: { action: "steer", label: "builder", runId: "run-1" } },
    });
    h.dispose();
  });

  it("not joined: every @ shape falls through to the native prompt path (§9.7)", () => {
    delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY];
    const h = makeSessionHarness(false);
    for (const text of ["@session:builder hi", "@builder hi", "@nobody hi"]) {
      h.sendUserMessage.mockClear();
      h.handle(text);
      expect(h.sendUserMessage, text).toHaveBeenCalledWith(text, { deliverAs: "steer", expandPromptTemplates: false });
    }
    expect(h.sends).toEqual([]);
    h.dispose();
  });

  it("leave (joined→false) mid-session restores the pass-through for @session: too", async () => {
    delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY];
    const h = makeSessionHarness(true);
    h.setOutcome({ status: "sent", effect: "applied", to: { ref: "ab12cd34" } });
    h.handle("@session:builder before leave");
    await flush();
    expect(h.sends).toHaveLength(1); // was intercepted while joined
    h.setJoined(false);
    h.handle("@session:builder after leave");
    expect(h.sendUserMessage).toHaveBeenCalledWith("@session:builder after leave", {
      deliverAs: "steer",
      expandPromptTemplates: false,
    });
    expect(h.sends).toHaveLength(1);
    h.dispose();
  });
});
