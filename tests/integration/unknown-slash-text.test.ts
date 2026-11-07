/** #40 real HTTP frontend → command handler/bridge → real pi session + fake provider;
 * Feishu uses real admission/durable receive/dedup with a fake installation, never a tenant. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import { createCommandHandler, type CommandHandler } from "../../src/web-hub/agent/commands.js";
import { createBuiltinBridge } from "../../src/web-hub/agent/builtin-bridge.js";
import { createCommandLedger } from "../../src/web-hub/agent/ledger.js";
import { createQueueMirror } from "../../src/web-hub/agent/queue-mirror.js";
import { createControl } from "../../src/web-hub/ui/src/composables/useControl.js";
import { createUnknownSlashFallback, outcomeFromHttp, parseSlash } from "../../src/web-hub/ui/src/logic/control.js";
import type { HubTransport, CmdRequest } from "../../src/web-hub/ui/src/transport/types.js";
import type { CmdFrame, CmdResultFrame } from "../../src/web-hub/protocol/messages.js";
import { fakeDeps, login, makeAgent, makeTmp, postJson } from "../web-hub/http/helpers.js";
import { fakeCtx } from "../web-hub/agent/helpers.js";
import { assistantTextMsg, withSession, disposeHarnessDirs } from "../conformance/agent-session-harness.js";
import { cleanupF6, f6Rig, messageEnvelope, OTHER, untilF6 } from "../fixtures/feishu/f6.js";

const LEDGER = Symbol.for("pi-subagent:web-hub:cmd-ledger");
afterEach(async () => {
  delete (globalThis as Record<symbol, unknown>)[LEDGER];
  disposeHarnessDirs();
  await cleanupF6();
});

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("#40 session did not settle");
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}

describe("#40 transport and input-chain closed loops", () => {
  it("HTTP command unknown → new prompt id; raw body once; replay and known errors never run a second model turn", async () => {
    delete (globalThis as Record<symbol, unknown>)[LEDGER];
    let pi!: ExtensionAPI;
    let handler: CommandHandler | undefined;
    const known: string[] = [];
    const inputs: string[] = [];
    await withSession(
      {
        scripted: [{ toolCall: false, build: (m) => assistantTextMsg(m, "ok") }],
        extensionFactories: [
          (api: ExtensionAPI) => {
            pi = api;
            api.registerCommand("knownprobe", {
              handler: async (args) => {
                known.push(args);
                throw new Error("EXPECTED-KNOWN-FAIL");
              },
            });
            api.registerCommand("注册名", {
              handler: async () => {
                known.push("must-not-execute");
              },
            });
            api.on("input", (e) => {
              inputs.push(e.text);
              handler?.onInputEvent(e);
              return { action: "continue" };
            });
            api.on("message_start", (e) => handler?.onMessageStart(e));
          },
        ],
      },
      async ({ session, modelRuntime }) => {
        const tmp = makeTmp("unknown-slash-http-");
        const deps = fakeDeps(tmp.dir);
        deps.agents.set("a1", makeAgent("a1"));
        const { ctx } = fakeCtx();
        const ledger = createCommandLedger();
        const replies = new Map<string, (frame: CmdResultFrame) => void>();
        const frames: CmdFrame[] = [];
        const origin = vi.fn();
        handler = createCommandHandler({
          pi,
          getCtx: () => ctx,
          getSessionId: () => "sess-1",
          ledger,
          queueMirror: createQueueMirror(),
          compactionState: { manualCompacting: false, dispose() {} },
          originEntry: { appendOrigin: origin, notify() {}, dispose() {} },
          builtinBridge: createBuiltinBridge({ pi, getCtx: () => ctx, getSessionId: () => "sess-1" }),
          controlEnabled: () => true,
          unknownSlashTextEnabled: () => true,
          now: Date.now,
          send: (f) => {
            if (f.t === "cmd_result") replies.get(f.id)?.(f);
          },
          onChanged() {},
          setTimer: (ms, fn) => {
            const timer = setTimeout(fn, ms);
            timer.unref();
            return { cancel: () => clearTimeout(timer) };
          },
        });
        deps.commands = {
          request: async (frame) =>
            new Promise<CmdResultFrame>((resolve) => {
              frames.push(frame);
              replies.set(frame.id, resolve);
              handler!.handle(frame);
            }),
          drain: async () => ({ inflight: 0, timedOut: false }),
          inflight: () => 0,
        };
        const frontend = createHttpFrontend(deps);
        const port = (await frontend.listen()).port;
        const cookie = await login(port, deps.paths.tokenFile);
        const wire: CmdRequest[] = [];
        const transport = {
          command: async (request: CmdRequest) => {
            wire.push(request);
            const response = await postJson(port, "/api/cmd", request, {
              Cookie: cookie,
              Origin: `http://127.0.0.1:${port}`,
            });
            return outcomeFromHttp(response.status, JSON.parse(response.body));
          },
        } as HubTransport;
        const control = createControl(transport, () => {}, { getSessionId: () => "sess-1" });
        try {
          const raw = "/unregistered\t raw\n  tail  \n\n<attachment>already-composed</attachment>";
          const slash = parseSlash(raw)!;
          let scope: string | null = "a1:sess-1:e1:unknown-slash-text.v1";
          const accept = createUnknownSlashFallback(
            () => scope,
            async () => {
              await control.sendPrompt("a1", raw, "followUp", raw);
            },
          );
          const result = await control.runCommand("a1", slash.name, slash.args);
          expect(result).toMatchObject({ ok: false, error: "E_UNKNOWN_COMMAND", effect: "none" });
          expect(await accept(result)).toBe(true);
          expect(await accept(result)).toBe(false);
          await until(() => modelRuntime.callCount() === 1 && !session.isStreaming);
          expect(wire.map((r) => r.op)).toEqual(["command", "prompt"]);
          expect(wire[0]!.id).not.toBe(wire[1]!.id);
          expect(inputs).toEqual([raw]);
          const messages = modelRuntime.requestMessages[0] as Array<{ role: string; content: unknown }>;
          expect(messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual([
            [{ type: "text", text: raw }],
          ]);
          expect(ledger.get(wire[0]!.id)?.state).toBe("failed");
          expect(origin).toHaveBeenCalledTimes(1); // only B is a message, A never executed
          await transport.command(wire[1]!); // same B id is a ledger replay, not a new turn
          expect(inputs).toEqual([raw]);
          expect(modelRuntime.callCount()).toBe(1);
          for (const [name, args] of [
            ["knownprobe", "bad args"],
            ["quit", ""],
            ["model", ""],
            ["knownprobe", "x".repeat(17000)],
          ]) {
            const outcome = await control.runCommand("a1", name!, args!, { confirm: true });
            const noFallback = createUnknownSlashFallback(
              () => scope,
              async () => {
                await control.sendPrompt("a1", "/must-not-send", "steer");
              },
            );
            expect(await noFallback(outcome)).toBe(false);
          }
          await until(() => known.length === 1);
          expect(known).toEqual(["bad args"]);
          expect(modelRuntime.callCount()).toBe(1);
          const invalidKnown = await control.sendPrompt("a1", "/注册名 body", "followUp");
          expect(invalidKnown).toMatchObject({ ok: false, error: "E_BAD_REQUEST", effect: "none" });
          expect(known).toEqual(["bad args"]);
          expect(modelRuntime.callCount()).toBe(1);
          const cancelled = createUnknownSlashFallback(
            () => scope,
            async () => {
              await control.sendPrompt("a1", raw, "steer");
            },
          );
          scope = null;
          expect(await cancelled(result)).toBe(false);
          expect(wire.filter((r) => r.op === "prompt")).toHaveLength(3); // B, replay B, rejected registered name
          expect(frames.filter((f) => f.cmd.op === "prompt")).toHaveLength(3);
        } finally {
          handler.dispose();
          handler = undefined;
          await frontend.close();
          tmp.cleanup();
        }
      },
    );
  }, 20000);

  it("Feishu admission/durable dedup delivers pi-looking text once, but known bot syntax errors never dispatch", async () => {
    const r = await f6Rig({ debounceMs: 0 });
    const raw = "/reload\n  preserve body  ";
    const envelope = messageEnvelope("slash-one", raw);
    const accepted = await r.inbound.handle(envelope);
    expect(accepted.ack).toBe(true);
    await r.requests.flushChat("chat");
    await untilF6(() => r.request.mock.calls.length === 1);
    const frame = r.request.mock.calls[0]![0];
    expect(frame.cmd).toMatchObject({ op: "prompt" });
    expect(frame.cmd.op === "prompt" && frame.cmd.text).toContain(raw);
    expect(frame.origin.ip).toBe("feishu");
    const duplicate = await r.inbound.handle(envelope);
    expect(duplicate.ack).toBe(true);
    await r.requests.flushChat("chat");
    expect(r.request).toHaveBeenCalledTimes(1);
    await r.inbound.handle(messageEnvelope("slash-bad", "/use"));
    await r.inbound.handle(messageEnvelope("slash-stranger", "/notregistered", { sender: OTHER }));
    await r.requests.flushChat("chat");
    expect(r.request).toHaveBeenCalledTimes(1);
    expect(r.intents.some((i) => i.type === "notice" && i.code === "help")).toBe(true);
    expect(r.state.requests.list()).toHaveLength(1);
  });
});
