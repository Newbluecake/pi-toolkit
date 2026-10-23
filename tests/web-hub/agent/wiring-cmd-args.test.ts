/**
 * web-hub-slash-args plan §4.4/§4.5 (P1): wiring-level tests — the shared `argCompleters`
 * map feeds S-own completion end-to-end through `wireWebHub`, the passthrough TUI
 * autocomplete wrapper registers exactly once per activation (TUI + "all" only), the agent
 * hello carries `cmd.args.v1` exactly while the feature is on, and the `commands` slot
 * publishes `args`-carrying frames per r1 #1 ①/②.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { wireWebHub, type WebHubDeps } from "../../../src/web-hub/agent/index.js";
import type { AgentFrame, CommandsFrame } from "../../../src/web-hub/protocol/messages.js";
import type { CompleteReplyFrame } from "../../../src/web-hub/protocol/command-args.js";
import type { ArgCompleter } from "../../../src/web-hub/agent/command-complete.js";
import { ackFrame, fakeCtx, fakeNet, fakePi, pathsIn, resetGlobals, SETTINGS, tmpDir } from "./helpers.js";

let tmp: ReturnType<typeof tmpDir>;
beforeEach(() => {
  tmp = tmpDir("wh-d-cmdargs-");
  resetGlobals();
});
afterEach(() => {
  resetGlobals();
  tmp.cleanup();
});

function deps(over: Partial<WebHubDeps> = {}): WebHubDeps {
  return {
    settings: SETTINGS,
    fleet: () => [],
    env: { HOME: tmp.dir },
    paths: pathsIn(tmp.dir),
    buildInfo: async () => ({ pluginVersion: "1.2.3", buildId: "1.2.3@test" }),
    argv1: "/nonexistent/pi",
    ...over,
  };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

/** TUI ctx whose ui records addAutocompleteProvider registrations. */
function tuiCtxWithAutocomplete(): { ctx: ReturnType<typeof fakeCtx>["ctx"]; registered: unknown[] } {
  const registered: unknown[] = [];
  const { ctx } = fakeCtx({ mode: "tui" });
  (ctx as unknown as { ui: Record<string, unknown> }).ui.addAutocompleteProvider = (f: unknown) => {
    registered.push(f);
  };
  return { ctx, registered };
}

/** Drive wireWebHub to a live connection over fakeNet; returns the fake net. */
async function liveConnect(
  d: WebHubDeps,
  pi: ReturnType<typeof fakePi>["pi"],
  fire: ReturnType<typeof fakePi>["fire"],
  caps: string[],
  ctx: ReturnType<typeof fakeCtx>["ctx"],
): ReturnType<typeof fakeNet> {
  const n = fakeNet();
  d.netConnect = n.netConnect;
  wireWebHub(pi, d);
  fire("session_start", { type: "session_start", reason: "startup" }, ctx);
  await flush();
  const s = n.sockets[0]!;
  s.emit("connect");
  s.hub(ackFrame("k1", 4242, caps));
  return n;
}

describe("wireWebHub — cmd.args caps & commands slot args (P1)", () => {
  it("default settings: hello carries cmd.args.v1; commands replay carries args for the cap-carrying hub", async () => {
    const { pi, fire } = fakePi();
    (pi as unknown as { getCommands: () => unknown[] }).getCommands = () => [
      { name: "agent", description: "diag", source: "extension" },
    ];
    const { ctx } = fakeCtx({ mode: "rpc" });
    const n = await liveConnect(deps({}), pi, fire, ["command.v1", "cmd.args.v1"], ctx);
    const s = n.sockets[0]!;
    const hello = s.frames().find((f) => f.t === "hello") as { caps: string[] };
    expect(hello.caps).toContain("cmd.v1");
    expect(hello.caps).toContain("cmd.args.v1");
    const commands = s.frames().find((f) => f.t === "commands") as CommandsFrame;
    expect(commands).toBeDefined();
    const agent = commands.items.find((i) => i.name === "agent");
    expect(agent?.args?.usage).toContain("status");
    expect(agent?.args?.complete).toBe(true);
    // a builtin row gets its table usage but never `complete` (§3.1: no dynamic completion)
    const model = commands.items.find((i) => i.name === "model");
    expect(model?.args?.usage).toBe("<provider/model>");
    expect(model?.args?.complete).toBeUndefined();
  });

  it('commandComplete "off": no cap advertised, no args on the wire, no S-own replies', async () => {
    const { pi, fire } = fakePi();
    const { ctx } = fakeCtx({ mode: "rpc" });
    const d = deps({ settings: { ...SETTINGS, commandComplete: "off" } });
    const n = await liveConnect(d, pi, fire, ["command.v1"], ctx);
    const s = n.sockets[0]!;
    const hello = s.frames().find((f) => f.t === "hello") as { caps: string[] };
    expect(hello.caps).not.toContain("cmd.args.v1");
    const commands = s.frames().find((f) => f.t === "commands") as CommandsFrame;
    expect(commands.items.every((i) => i.args === undefined)).toBe(true);
  });

  it("webCommands false ⇒ no cmd.args.v1 either (the route needs command.v1; never advertise a lie)", async () => {
    const { pi, fire } = fakePi();
    const { ctx } = fakeCtx({ mode: "rpc" });
    const d = deps({ settings: { ...SETTINGS, webCommands: false } });
    const n = await liveConnect(d, pi, fire, [], ctx);
    const hello = n.sockets[0]!.frames().find((f) => f.t === "hello") as { caps: string[] };
    expect(hello.caps).not.toContain("command.v1");
    expect(hello.caps).not.toContain("cmd.args.v1");
  });
});

describe("wireWebHub — S-own completion end-to-end (§4.3/§4.4)", () => {
  const EXT_PI = {
    getCommands: () => [{ name: "webhub", description: "hub", source: "extension" }],
  };

  it("complete_req over a live link answers through the shared argCompleters map (deny items filtered)", async () => {
    const { pi, fire } = fakePi();
    (pi as unknown as { getCommands: () => unknown[] }).getCommands = EXT_PI.getCommands;
    const { ctx } = fakeCtx({ mode: "rpc" });
    const completers = new Map<string, ArgCompleter>();
    completers.set("webhub", () => [
      { value: "status", label: "status" },
      { value: "passwd", label: "passwd" }, // deny per PI_TOOLKIT_TABLE.webhub
    ]);
    const n = await liveConnect(deps({ argCompleters: completers }), pi, fire, ["command.v1", "cmd.args.v1"], ctx);
    const s = n.sockets[0]!;
    const before = s.frames().length;
    s.hub({
      t: "complete_req",
      rid: "cr-9",
      name: "webhub",
      prefix: "",
      deadlineMs: 2000,
      origin: { listener: "loopback" },
    });
    await flush();
    const reply = s
      .frames()
      .slice(before)
      .find((f) => f.t === "complete_reply") as CompleteReplyFrame;
    expect(reply).toMatchObject({ rid: "cr-9", ok: true, source: "own" });
    if (reply.ok !== true) throw new Error("unreachable");
    expect(reply.items.map((i) => i.value)).toEqual(["status"]);
  });

  it('mode "toolkit": a third-party command with no S-own entry answers empty (never S-tui)', async () => {
    const { pi, fire } = fakePi();
    (pi as unknown as { getCommands: () => unknown[] }).getCommands = EXT_PI.getCommands;
    const { ctx } = fakeCtx({ mode: "rpc" });
    const d = deps({
      argCompleters: new Map<string, ArgCompleter>(),
      settings: { ...SETTINGS, commandComplete: "toolkit" },
    });
    const n = await liveConnect(d, pi, fire, ["command.v1", "cmd.args.v1"], ctx);
    const s = n.sockets[0]!;
    const before = s.frames().length;
    s.hub({
      t: "complete_req",
      rid: "cr-10",
      name: "webhub",
      prefix: "",
      deadlineMs: 2000,
      origin: { listener: "lan" },
    });
    await flush();
    const reply = s
      .frames()
      .slice(before)
      .find((f) => f.t === "complete_reply") as CompleteReplyFrame;
    expect(reply).toMatchObject({ rid: "cr-10", ok: true, items: [], source: "own" });
  });
});

describe("wireWebHub — TUI autocomplete provider capture (§4.5)", () => {
  it("registers exactly once on the first TUI session; the factory is a transparent passthrough", async () => {
    const { pi, fire } = fakePi();
    const { ctx, registered } = tuiCtxWithAutocomplete();
    const n = fakeNet();
    wireWebHub(pi, deps({ netConnect: n.netConnect }));
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await flush();
    expect(registered).toHaveLength(1);
    // a same-activation /new re-runs session_start: sticky, never re-registered
    fire("session_start", { type: "session_start", reason: "new" }, ctx);
    await flush();
    expect(registered).toHaveLength(1);
    // passthrough: the factory returns `current` UNCHANGED (twice — pi replays wrappers)
    const factory = registered[0] as (current: unknown) => unknown;
    const current = { getSuggestions: async () => null };
    expect(factory(current)).toBe(current);
    expect(factory({ getSuggestions: async () => null })).toEqual({ getSuggestions: expect.any(Function) });
    // session_shutdown clears the captured provider (hasTui would go false); wrapper stays registered
    fire("session_shutdown", { type: "session_shutdown", reason: "new" }, ctx);
    await flush();
    expect(registered).toHaveLength(1);
  });

  it("never registers in rpc mode, nor while the setting is toolkit/off", async () => {
    const { pi, fire } = fakePi();
    const rpc = fakeCtx({ mode: "rpc" });
    const tui = tuiCtxWithAutocomplete();
    const n = fakeNet();
    wireWebHub(pi, deps({ netConnect: n.netConnect, settings: { ...SETTINGS, commandComplete: "toolkit" } }));
    fire("session_start", { type: "session_start", reason: "startup" }, tui.ctx);
    await flush();
    fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, tui.ctx);
    const n2 = fakeNet();
    wireWebHub(pi, deps({ netConnect: n2.netConnect }));
    fire("session_start", { type: "session_start", reason: "startup" }, rpc.ctx);
    await flush();
    expect(tui.registered).toHaveLength(0); // toolkit ⇒ never registered even in TUI
    expect((rpc.ctx as unknown as { ui: Record<string, unknown> }).ui.addAutocompleteProvider).toBeUndefined();
  });
});
