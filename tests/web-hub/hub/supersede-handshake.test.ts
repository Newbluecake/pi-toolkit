/**
 * acc32-B9 (revised per verifier r_29729WTC): real-frame-timing coverage for the dialogs-slot
 * handshake. `supersede.test.ts` exercises the state machine against an injected fake
 * `awaitDialogsSlot`; this file wires the REAL registry + agent-server + supersede the same way
 * `hub.ts` does (registry.bus subscription, hubVersion compare, dialogs defense-in-depth tick) and
 * drives an actual unix-socket agent connection, so the three timing outcomes the task calls out
 * are proven against real frame delivery, not just a mocked promise:
 *   1. hello arrives, then a `dialogs` frame reporting an OPEN dialog arrives asynchronously
 *      afterward ⇒ no replacement while it's open.
 *   2. that dialog later closes (another `dialogs` frame) ⇒ replacement follows.
 *   3. hello arrives and NO `dialogs` frame ever follows ⇒ the bounded handshake timeout elapses
 *      and the quiet path still replaces (never hangs forever on a minimal/older agent build).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
import { join } from "node:path";
import { createAgentServer, type AgentServer } from "../../../src/web-hub/hub/agent-server.js";
import { createRegistry, type Registry } from "../../../src/web-hub/hub/registry.js";
import {
  createSupersede,
  SUPERSEDE_DIALOGS_HANDSHAKE_MS,
  type SupersedeController,
} from "../../../src/web-hub/hub/supersede.js";
import { config, connectClient, hello, memLog, tmpDirs, type TestClient } from "./helpers.js";

const tmp = tmpDirs();
let server: net.Server;
let agentServer: AgentServer;
let registry: Registry;
let supersede: SupersedeController;
let restart: ReturnType<typeof vi.fn>;
let sockPath: string;
let unsubscribeDialogsTick: () => void;
const clients: TestClient[] = [];

/** Same wiring as hub.ts's `createSupersede({ awaitDialogsSlot: ... })`. */
function wireAwaitDialogsSlot(reg: Registry): (agentKey: string, timeoutMs: number) => Promise<void> {
  return (agentKey, timeoutMs) => {
    if (reg.get(agentKey)?.dialogs !== undefined) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      };
      const unsubscribe = reg.bus.subscribe((e) => {
        if (e.type === "dialogs" && e.agentKey === agentKey) finish();
      });
      const timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
    });
  };
}

async function setup(): Promise<void> {
  sockPath = join(tmp.make("wh-ssh-"), "hub.sock");
  restart = vi.fn(async () => undefined);
  registry = createRegistry({
    now: () => Date.now(),
    log: memLog(),
    pidAlive: () => true,
    hubVersion: "1.0.0",
    onVersion: (pluginVersion, agentKey) => supersede.observe(pluginVersion, agentKey),
  });
  supersede = createSupersede({
    hubVersion: "1.0.0",
    now: () => Date.now(),
    openDialogs: () =>
      registry.list().flatMap((a) => {
        const dialogs = a.dialogs as { open?: unknown[] } | null | undefined;
        const count = dialogs?.open?.length ?? 0;
        return count === 0 ? [] : [{ agentKey: a.agentKey, count }];
      }),
    inflight: () => 0,
    restart,
    awaitDialogsSlot: wireAwaitDialogsSlot(registry),
  });
  // acc32-B9 defense in depth (hub.ts): re-check quiet whenever a `dialogs` slot changes.
  unsubscribeDialogsTick = registry.bus.subscribe((e) => {
    if (e.type === "dialogs") supersede.tick();
  });
  server = net.createServer();
  await new Promise<void>((r) => server.listen(sockPath, () => r()));
  agentServer = createAgentServer(server, {
    registry,
    config: config({ pluginVersion: "1.0.0", buildId: "1.0.0@hub" }),
    log: memLog(),
    now: () => Date.now(),
    httpPort: () => 7878,
  });
}

beforeEach(setup);

afterEach(async () => {
  vi.useRealTimers();
  unsubscribeDialogsTick();
  supersede.dispose();
  for (const c of clients.splice(0)) c.sock.destroy();
  await agentServer.close();
  await new Promise<void>((r) => server.close(() => r()));
  tmp.cleanup();
});

async function client(): Promise<TestClient> {
  const c = await connectClient(sockPath);
  clients.push(c);
  return c;
}

const openDialogFrame = {
  t: "dialogs" as const,
  epoch: "epoch-1",
  open: [
    {
      dialogId: "ask:1",
      source: "ask_user" as const,
      toolCallId: "tc1",
      questions: [{ question: "continue?", options: [{ label: "yes" }] }],
      allowCancel: true,
      openedAt: 1,
    },
  ],
  closed: [],
};

const closedDialogFrame = { t: "dialogs" as const, epoch: "epoch-1", open: [], closed: [] };

describe("supersede dialogs-slot handshake — real frame timing (acc32-B9)", () => {
  it("a dialogs frame reporting an open dialog, arriving asynchronously after hello, blocks replacement", async () => {
    const c = await client();
    c.send(hello({ pluginVersion: "2.0.0" }));
    await c.waitFrame((f) => f["t"] === "hello_ack");
    // Not yet decided: the handshake wait for this agent's dialogs slot is still pending.
    expect(restart).not.toHaveBeenCalled();
    // The `dialogs` frame lands strictly after hello_ack, over a real extra network round trip —
    // exactly the D14 timing this fix has to tolerate.
    c.send(openDialogFrame);
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(restart).not.toHaveBeenCalled();
  }, 10_000);

  it("closing that dialog (a later dialogs frame) lets the quiet path replace", async () => {
    const c = await client();
    c.send(hello({ pluginVersion: "2.0.0" }));
    await c.waitFrame((f) => f["t"] === "hello_ack");
    c.send(openDialogFrame);
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(restart).not.toHaveBeenCalled();
    c.send(closedDialogFrame);
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(restart).toHaveBeenCalledWith(expect.objectContaining({ forced: false }));
  }, 10_000);

  it("no dialogs frame ever follows ⇒ the bounded handshake timeout elapses and the quiet path still replaces", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const c = await client();
    c.send(hello({ pluginVersion: "2.0.0" }));
    await vi.waitFor(() =>
      expect(c.frames.some((f) => (f as Record<string, unknown>)["t"] === "hello_ack")).toBe(true),
    );
    expect(restart).not.toHaveBeenCalled();
    // No `dialogs` frame ever arrives for this agent. Advance past the bounded handshake window.
    await vi.advanceTimersByTimeAsync(SUPERSEDE_DIALOGS_HANDSHAKE_MS + 10);
    expect(restart).toHaveBeenCalledWith(expect.objectContaining({ forced: false }));
  }, 10_000);
});
