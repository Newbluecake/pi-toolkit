/**
 * web-hub-slash-args plan §4.4/§4.5 (P1): wiring-level tests — the shared `argCompleters`
 * map feeds S-own completion end-to-end through `wireWebHub`, the passthrough TUI
 * autocomplete wrapper registers exactly once per activation (TUI + "all" only), the agent
 * hello carries `cmd.args.v1` exactly while the feature is on, and the `commands` slot
 * publishes `args`-carrying frames per r1 #1 ①/②.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemCommand } from "../../../src/memory/command.js";
import type { RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { createStatusCommand, type StatusCommandDeps } from "../../../src/commands/status.js";
import { createThreadCommand } from "../../../src/commands/thread.js";
import { createReflexCommand, type ReflexCommandDeps } from "../../../src/reflex/command.js";
import { BUILTIN_SCRIPTS } from "../../../src/reflex/core/catalog.js";
import { createWebHubCommand } from "../../../src/commands/webhub.js";
import { decodeAgentFrame } from "../../../src/web-hub/protocol/messages.js";
import type { JevCommandPort } from "../../../src/memory/jev/contracts.js";
import { wrapCommandApi } from "../../../src/commands/capture.js";
import { executeMemoryRead } from "../../../src/memory/command-readonly.js";
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

/** The host has already decided which commands to register. These conditional test
 * registrations do NOT simulate activate's secure/child gates (covered by real trace/goldens). */
function registerGovernance(
  pi: ReturnType<typeof fakePi>["pi"],
  flags: { rebind?: boolean; drafts?: boolean; registered?: boolean } = {},
) {
  type Command = Omit<RegisteredCommand, "name" | "sourceInfo">;
  const business = vi.fn((key: PropertyKey): never => {
    throw Error(`business read: ${String(key)}`);
  });
  const draftEnabled = vi.fn(() => flags.drafts === true);
  const draftRead = vi.fn((): never => business("draft read"));
  const reflex = new Proxy(
    {
      catalog: BUILTIN_SCRIPTS,
      drafts: { enabled: draftEnabled, dir: draftRead, result: draftRead, loading: draftRead, counters: draftRead },
    } as unknown as ReflexCommandDeps,
    {
      get: (target, key) => (key === "catalog" || key === "drafts" ? Reflect.get(target, key) : business(key)),
    },
  );
  const factories = {
    agent: createStatusCommand(new Proxy({} as StatusCommandDeps, { get: (_t, key) => business(key) })),
    thread: createThreadCommand({ current: () => business("thread.current"), rebind: flags.rebind === true }),
    reflex: createReflexCommand(reflex),
    webhub: createWebHubCommand({ control: () => business("webhub.control"), open: () => business("open") }),
  };
  const records = new Map<string, Command>();
  pi.registerCommand = (name, command) => {
    records.set(name, command);
  };
  Object.assign(pi, {
    getCommands: () =>
      [...records].map(([name, command]) => ({ name, source: "extension", description: command.description })),
  });
  const raw = new Map<string, ArgCompleter>();
  const owned = new Set<string>();
  const wrapped = wrapCommandApi(pi, () => undefined, owned, raw);
  const natives = Object.values(factories).map((command) => vi.spyOn(command, "handler"));
  for (const [name, command] of Object.entries(factories)) {
    if (flags.registered === false && (name === "thread" || name === "reflex")) continue;
    wrapped.registerCommand(name, command);
    expect(raw.get(name)).toBe(command.getArgumentCompletions);
    expect(records.get(name)?.getArgumentCompletions).toBe(command.getArgumentCompletions);
  }
  return { raw, owned, records, business, draftEnabled, draftRead, natives };
}

function publishedCommands(socket: ReturnType<typeof fakeNet>["sockets"][number]) {
  const frame = decodeAgentFrame(
    socket
      .frames()
      .filter((row) => row.t === "commands")
      .at(-1),
  );
  if (frame?.t !== "commands") throw Error("commands were not actually published");
  return frame.items;
}
async function completeGovernance(socket: ReturnType<typeof fakeNet>["sockets"][number], name: string, prefix = "") {
  const rid = `v2-${socket.frames().length}`;
  socket.hub({ t: "complete_req", rid, name, prefix, deadlineMs: 2000, origin: { listener: "loopback" } });
  await flush();
  const reply = decodeAgentFrame(socket.frames().find((row) => row.t === "complete_reply" && row.rid === rid));
  if (reply?.t !== "complete_reply") throw Error("real service did not reply");
  return reply;
}
function expectStaticOnly(f: ReturnType<typeof registerGovernance>) {
  expect(f.business).not.toHaveBeenCalled();
  expect(f.draftEnabled).not.toHaveBeenCalled();
  expect(f.draftRead).not.toHaveBeenCalled();
  for (const native of f.natives) expect(native).not.toHaveBeenCalled();
}

describe("V-2 real factory/capture → wireWebHub publication matrix", () => {
  it.each([
    ["toolkit", "tui", 0],
    ["all", "tui", 1],
    ["all", "rpc", 0],
  ] as const)(
    "%s/%s installs %i wrapper(s), publishes four own completers and never uses S-tui",
    async (commandComplete, mode, wrappers) => {
      const { pi, fire, sentUserMessages } = fakePi();
      const f = registerGovernance(pi);
      const { ctx } = fakeCtx({ mode });
      const registered: Array<(current: unknown) => unknown> = [];
      Object.assign(ctx.ui, {
        addAutocompleteProvider: (factory: (current: unknown) => unknown) => registered.push(factory),
      });
      const spawn = vi.fn((): never => {
        throw Error("must not launch Hub");
      });
      const d = deps({
        settings: { ...SETTINGS, commandComplete },
        argCompleters: f.raw,
        ownedCommandNames: f.owned,
        spawnImpl: spawn,
      });
      expect(d.argCompleters).toBe(f.raw);
      expect(d.ownedCommandNames).toBe(f.owned);
      const n = await liveConnect(d, pi, fire, ["command.v1", "cmd.args.v1"], ctx);
      const socket = n.sockets[0]!;
      expect(socket.frames().find((row) => row.t === "hello")).toMatchObject({
        caps: expect.arrayContaining(["cmd.args.v1"]),
      });
      const rows = publishedCommands(socket);
      for (const name of f.owned)
        expect(rows.find((row) => row.name === name)).toMatchObject({
          name,
          kind: "extension",
          output: "captured",
          args: { complete: true },
        });
      expect(registered).toHaveLength(wrappers);
      const tui = vi.fn(async () => ({ items: [{ value: "wrong-source", label: "wrong-source" }], prefix: "" }));
      if (registered[0]) {
        const current = { getSuggestions: tui };
        expect(registered[0](current)).toBe(current);
      }
      for (const [name, prefix, values] of [
        ["agent", "settings s", ["settings set"]],
        ["thread", "", ["status", "help", "sub", "drop"]],
        ["reflex", "", ["status", "explain", "reset", "drafts"]],
        ["webhub", "token ", []],
      ] as const) {
        const reply = await completeGovernance(socket, name, prefix);
        expect(reply).toMatchObject({ ok: true, source: "own" });
        if (!reply.ok) throw Error("own refused");
        expect(reply.items.map((item) => item.value)).toEqual(values);
        if (name !== "webhub") expect(reply.items.every((item) => item.policy === "confirm")).toBe(true);
      }
      // Same activation session change must not stack a second all/TUI wrapper.
      fire("session_start", { type: "session_start", reason: "new" }, ctx);
      await flush();
      expect(registered).toHaveLength(wrappers);
      expect(tui).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(sentUserMessages).toEqual([]);
      expectStaticOnly(f);
    },
  );

  it.each(["print", "json"] as const)(
    "%s mode is wholly inert: no wrapper, socket or published frames",
    async (mode) => {
      const { pi, fire } = fakePi();
      const f = registerGovernance(pi);
      const { ctx } = fakeCtx({ mode });
      const wrapper = vi.fn();
      Object.assign(ctx.ui, { addAutocompleteProvider: wrapper });
      const n = fakeNet();
      wireWebHub(pi, deps({ netConnect: n.netConnect, argCompleters: f.raw, ownedCommandNames: f.owned }));
      fire("session_start", { type: "session_start", reason: "startup" }, ctx);
      await flush();
      expect(wrapper).not.toHaveBeenCalled();
      expect(n.sockets).toEqual([]);
      expectStaticOnly(f);
    },
  );

  it.each([false, true])(
    "registered thread/reflex feature flags=%s retain complete=true and exact filtered roots",
    async (enabled) => {
      const { pi, fire } = fakePi();
      const f = registerGovernance(pi, { rebind: enabled, drafts: enabled });
      const { ctx } = fakeCtx({ mode: "rpc" });
      const branch = vi.spyOn(ctx.sessionManager, "getBranch");
      const n = await liveConnect(
        deps({
          settings: { ...SETTINGS, commandComplete: "toolkit" },
          argCompleters: f.raw,
          ownedCommandNames: f.owned,
        }),
        pi,
        fire,
        ["command.v1", "cmd.args.v1"],
        ctx,
      );
      const socket = n.sockets[0]!;
      branch.mockClear();
      for (const name of ["thread", "reflex"])
        expect(publishedCommands(socket).find((row) => row.name === name)?.args?.complete).toBe(true);
      expect(await completeGovernance(socket, "thread")).toMatchObject({
        ok: true,
        source: "own",
        items: (enabled
          ? ["status", "help", "sub", "drop", "rebind", "acquire"]
          : ["status", "help", "sub", "drop"]
        ).map((value) => ({ value, label: value, policy: "confirm" })),
      });
      expect(await completeGovernance(socket, "thread", "sub r_v2-complete-run o")).toMatchObject({
        ok: true,
        items: [{ value: "sub r_v2-complete-run origin", label: "origin", policy: "confirm" }],
      });
      expect(await completeGovernance(socket, "thread", "rebind ")).toMatchObject({
        ok: true,
        items: enabled ? [{ value: "rebind origin", label: "origin", policy: "confirm" }] : [],
      });
      expect(await completeGovernance(socket, "thread", "acquire ")).toMatchObject({
        ok: true,
        items: enabled ? [{ value: "acquire origin", label: "origin", policy: "confirm" }] : [],
      });
      const reply = await completeGovernance(socket, "reflex", "d");
      expect(reply).toMatchObject({
        ok: true,
        items: [{ value: "drafts", description: "显示草案诊断；关闭时显示 disabled", policy: "confirm" }],
      });
      expect(branch).not.toHaveBeenCalled();
      expectStaticOnly(f);
    },
  );

  it.each(["toolkit", "all"] as const)(
    "%s no-RAW external control is not a factory-owned completer",
    async (commandComplete) => {
      const { pi, fire } = fakePi();
      const f = registerGovernance(pi);
      const native = vi.fn(async () => {});
      // Deliberately outside wrapCommandApi, with no argument completer.
      pi.registerCommand("external-v2", { description: "external no-completer control", handler: native });
      expect(f.raw.has("external-v2")).toBe(false);
      expect(f.owned.has("external-v2")).toBe(false);
      const { ctx } = fakeCtx({ mode: "rpc" });
      const n = await liveConnect(
        deps({ settings: { ...SETTINGS, commandComplete }, argCompleters: f.raw, ownedCommandNames: f.owned }),
        pi,
        fire,
        ["command.v1", "cmd.args.v1"],
        ctx,
      );
      const socket = n.sockets[0]!;
      expect(publishedCommands(socket).find((row) => row.name === "external-v2")?.args?.complete).toBe(
        commandComplete === "all" ? true : undefined,
      );
      expect(await completeGovernance(socket, "external-v2")).toMatchObject({ ok: true, source: "own", items: [] });
      expect(native).not.toHaveBeenCalled();
      expectStaticOnly(f);
    },
  );

  it.each(["off", "web-commands-off", "capless"] as const)(
    "%s strips all four real registrations from the argument wire surface",
    async (gate) => {
      const { pi, fire } = fakePi();
      const f = registerGovernance(pi);
      const get = vi.spyOn(f.raw, "get");
      const { ctx, registered } = tuiCtxWithAutocomplete();
      const n = await liveConnect(
        deps({
          settings: {
            ...SETTINGS,
            commandComplete: gate === "off" ? "off" : "toolkit",
            webCommands: gate !== "web-commands-off",
          },
          argCompleters: f.raw,
          ownedCommandNames: f.owned,
        }),
        pi,
        fire,
        gate === "off" ? ["command.v1", "cmd.args.v1"] : ["command.v1"],
        ctx,
      );
      const socket = n.sockets[0]!;
      const hello = socket.frames().find((row) => row.t === "hello");
      expect(hello).toMatchObject({ caps: expect.any(Array) });
      expect((hello!.caps as string[]).includes("cmd.args.v1")).toBe(gate === "capless");
      const rows = publishedCommands(socket);
      for (const name of f.owned) expect(rows.some((row) => row.name === name)).toBe(true);
      expect(rows.every((row) => row.args === undefined)).toBe(true);
      expect(registered).toHaveLength(0);
      if (gate === "off") {
        socket.hub({
          t: "complete_req",
          rid: "v2-off",
          name: "thread",
          prefix: "",
          deadlineMs: 2000,
          origin: { listener: "loopback" },
        });
        await flush();
        expect(socket.frames().some((row) => row.t === "complete_reply")).toBe(false);
      }
      expect(get).not.toHaveBeenCalled();
      expectStaticOnly(f);
    },
  );

  it("host-assembled absent registrations have no thread/reflex item or RAW (not an activate gate proof)", async () => {
    const { pi, fire } = fakePi();
    const f = registerGovernance(pi, { registered: false });
    const { ctx } = fakeCtx({ mode: "rpc" });
    const n = await liveConnect(
      deps({ settings: { ...SETTINGS, commandComplete: "toolkit" }, argCompleters: f.raw, ownedCommandNames: f.owned }),
      pi,
      fire,
      ["command.v1", "cmd.args.v1"],
      ctx,
    );
    for (const name of ["thread", "reflex"]) {
      expect(f.records.has(name)).toBe(false);
      expect(f.raw.has(name)).toBe(false);
      expect(f.owned.has(name)).toBe(false);
      expect(publishedCommands(n.sockets[0]!).some((row) => row.name === name)).toBe(false);
      expect(await completeGovernance(n.sockets[0]!, name)).toMatchObject({ ok: false, code: "E_UNKNOWN_COMMAND" });
    }
    expectStaticOnly(f);
  });

  it.each(["default", "allow", "deny"] as const)(
    "%s policy is enforced on actual socket requests for each factory",
    async (policy) => {
      const { pi, fire } = fakePi();
      const f = registerGovernance(pi);
      const { ctx } = fakeCtx({ mode: "rpc" });
      const n = await liveConnect(
        deps({
          settings: {
            ...SETTINGS,
            commandComplete: "toolkit",
            ...(policy === "default"
              ? {}
              : { webCommandPolicy: { agent: policy, thread: policy, reflex: policy, webhub: policy } }),
          },
          argCompleters: f.raw,
          ownedCommandNames: f.owned,
        }),
        pi,
        fire,
        ["command.v1", "cmd.args.v1"],
        ctx,
      );
      const socket = n.sockets[0]!;
      for (const name of ["agent", "thread", "reflex"]) {
        const reply = await completeGovernance(socket, name, name === "agent" ? "settings s" : "");
        if (policy === "deny") expect(reply).toMatchObject({ ok: false, code: "E_COMMAND_DENIED" });
        else {
          if (!reply.ok) throw Error("completion refused");
          expect(reply.items.length).toBeGreaterThan(0);
          expect(reply.items.every((item) => item.policy === (policy === "default" ? "confirm" : undefined))).toBe(
            true,
          );
        }
      }
      for (const prefix of ["token ", "2fa ", "2fa enroll ", "2fa feishu "]) {
        const reply = await completeGovernance(socket, "webhub", prefix);
        if (policy === "deny") expect(reply).toMatchObject({ ok: false, code: "E_COMMAND_DENIED" });
        else if (policy === "default") expect(reply).toMatchObject({ ok: true, source: "own", items: [] });
        else {
          if (!reply.ok) throw Error("override refused");
          expect(reply.items.length).toBeGreaterThan(0);
          expect(reply.items.every((item) => item.policy === undefined)).toBe(true);
          expect(reply.items.some((item) => item.value.includes("--confirm"))).toBe(false);
        }
      }
      expectStaticOnly(f);
    },
  );
});

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

/** V-M's registry is recorded from a REAL factory registration, not a hand-built RAW map. */
function registerMemory(pi: ReturnType<typeof fakePi>["pi"], jevOn = true) {
  const reads: string[] = [];
  const jev = new Proxy({} as JevCommandPort, {
    get(_target, key) {
      if (key === "isChildSession") return false;
      reads.push(String(key));
      throw Error("unexpected Jev business read");
    },
  });
  const command = createMemCommand({ ...(jevOn ? { jev } : {}) });
  const native = vi.spyOn(command, "handler");
  const registered = new Map<string, typeof command>();
  pi.registerCommand = (name, value) => {
    registered.set(name, value as typeof command);
  };
  // getCommands projects ONLY the metadata pi actually received through wrapCommandApi.
  Object.assign(pi, {
    getCommands: () => [...registered].map(([name, c]) => ({ name, source: "extension", description: c.description })),
  });
  const raw = new Map<string, ArgCompleter>();
  const owned = new Set<string>();
  wrapCommandApi(pi, () => undefined, owned, raw).registerCommand("mem", command);
  expect(raw.get("mem")).toBe(command.getArgumentCompletions);
  expect(registered.get("mem")?.getArgumentCompletions).toBe(command.getArgumentCompletions);
  expect(owned).toEqual(new Set(["mem"]));
  return { raw, owned, native, reads };
}

describe("V-M factory/capture RAW → wireWebHub fake-socket publication and completion", () => {
  it.each(["toolkit", "all"] as const)(
    "%s publishes real mem complete=true and answers S-own before S-tui",
    async (mode) => {
      const { pi, fire, sentUserMessages } = fakePi();
      const f = registerMemory(pi);
      const { ctx, registered } = tuiCtxWithAutocomplete();
      const capabilities = vi.fn(() => ({ sessionAdd: false, revisionReview: true }));
      const start = vi.fn(() => {
        throw Error("completion cannot start a write");
      });
      const spawn = vi.fn(() => {
        throw Error("must not spawn Hub");
      });
      const read = vi.fn((args: string, cwd: string) => executeMemoryRead(args, cwd));
      const d = deps({
        settings: { ...SETTINGS, commandComplete: mode },
        argCompleters: f.raw,
        ownedCommandNames: f.owned,
        memoryWrite: { capabilities, start },
        memoryRead: read,
        spawnImpl: spawn,
      });
      expect(d.argCompleters).toBe(f.raw);
      expect(d.ownedCommandNames).toBe(f.owned);
      const n = await liveConnect(d, pi, fire, ["command.v1", "cmd.args.v1"], ctx);
      const socket = n.sockets[0]!;
      const hello = socket.frames().find((r) => r.t === "hello");
      expect(hello).toMatchObject({ caps: expect.arrayContaining(["cmd.args.v1"]) });
      const commands = socket
        .frames()
        .filter((r) => r.t === "commands")
        .at(-1) as unknown as CommandsFrame;
      expect(commands.items.find((r) => r.name === "mem")).toMatchObject({
        kind: "extension",
        policy: "allow",
        output: "captured",
        args: { complete: true },
      });
      const tui = vi.fn(async () => ({ items: [{ value: "review --run", label: "wrong-source" }], prefix: "review " }));
      expect(registered).toHaveLength(mode === "all" ? 1 : 0);
      if (mode === "all") {
        const current = { getSuggestions: tui };
        expect((registered[0] as (p: unknown) => unknown)(current)).toBe(current);
      }
      capabilities.mockClear();
      for (const [i, prefix] of ["review ", "review --r", "review --run"].entries()) {
        socket.hub({
          t: "complete_req",
          rid: `vm-own-${i}`,
          name: "mem",
          prefix,
          deadlineMs: 2000,
          origin: { listener: "loopback" },
        });
        await flush();
        const reply = socket.frames().find((r) => r.t === "complete_reply" && r.rid === `vm-own-${i}`);
        expect(reply).toMatchObject({
          ok: true,
          source: "own",
          items: i === 0 ? [{ value: "review --list", label: "--list" }] : [],
        });
      }
      expect(capabilities).toHaveBeenCalledWith(ctx);
      expect(capabilities).toHaveBeenCalledTimes(6);
      // A later REAL registration updates the already-wired map by reference; a
      // snapshot/copy captured inside wireWebHub would incorrectly keep --list.
      const jevOff = createMemCommand({});
      const offNative = vi.spyOn(jevOff, "handler");
      wrapCommandApi(pi, () => undefined, f.owned, f.raw).registerCommand("mem", jevOff);
      expect(d.argCompleters).toBe(f.raw);
      expect(f.raw.get("mem")).toBe(jevOff.getArgumentCompletions);
      socket.hub({
        t: "complete_req",
        rid: "vm-live-raw",
        name: "mem",
        prefix: "review ",
        deadlineMs: 2000,
        origin: { listener: "loopback" },
      });
      await flush();
      expect(socket.frames().find((r) => r.t === "complete_reply" && r.rid === "vm-live-raw")).toMatchObject({
        ok: true,
        source: "own",
        items: [],
      });
      expect(offNative).not.toHaveBeenCalled();
      expect(tui).not.toHaveBeenCalled();
      expect(f.native).not.toHaveBeenCalled();
      expect(f.reads).toEqual([]);
      expect(start).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(sentUserMessages).toEqual([]);
    },
  );

  it.each(["off", "web-commands-off", "capless"] as const)(
    "%s leaves the valid-client path inert (no RAW/backend reads)",
    async (gate) => {
      const { pi, fire } = fakePi();
      const f = registerMemory(pi);
      const getRaw = vi.spyOn(f.raw, "get");
      const capabilities = vi.fn(() => {
        throw Error("no backend discovery");
      });
      const start = vi.fn(() => {
        throw Error("no backend dispatch");
      });
      const spawn = vi.fn(() => {
        throw Error("no Hub spawn");
      });
      const { ctx, registered } = tuiCtxWithAutocomplete();
      const n = await liveConnect(
        deps({
          settings: {
            ...SETTINGS,
            commandComplete: gate === "off" ? "off" : "toolkit",
            webCommands: gate !== "web-commands-off",
          },
          argCompleters: f.raw,
          ownedCommandNames: f.owned,
          memoryWrite: { capabilities, start },
          spawnImpl: spawn,
        }),
        pi,
        fire,
        gate === "off" ? ["command.v1", "cmd.args.v1"] : ["command.v1"],
        ctx,
      );
      const socket = n.sockets[0]!;
      const hello = socket.frames().find((r) => r.t === "hello") as { caps: string[] };
      expect(hello.caps.includes("cmd.args.v1")).toBe(gate === "capless");
      expect(registered).toHaveLength(0);
      const commands = socket
        .frames()
        .filter((r) => r.t === "commands")
        .at(-1) as unknown as CommandsFrame;
      expect(commands.items.find((r) => r.name === "mem")).toBeDefined();
      expect(commands.items.every((r) => r.args === undefined)).toBe(true);
      if (gate === "off") {
        // Even a stray frame cannot invoke a service when mode=off (binding absent).
        socket.hub({
          t: "complete_req",
          rid: "vm-off",
          name: "mem",
          prefix: "review ",
          deadlineMs: 2000,
          origin: { listener: "loopback" },
        });
        await flush();
        expect(socket.frames().some((r) => r.t === "complete_reply")).toBe(false);
      }
      expect(getRaw).not.toHaveBeenCalled();
      expect(capabilities).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(f.native).not.toHaveBeenCalled();
      expect(f.reads).toEqual([]);
    },
  );

  it.each(["jev-off", "deny", "false-cap", "throw-cap", "missing-cap"] as const)(
    "%s never publishes an unauthorized review candidate",
    async (condition) => {
      const { pi, fire, sentUserMessages } = fakePi();
      const f = registerMemory(pi, condition !== "jev-off");
      const capabilities = vi.fn(() => {
        if (condition === "throw-cap") throw Error("private backend failure");
        return { sessionAdd: false, revisionReview: condition === "jev-off" || condition === "deny" };
      });
      const start = vi.fn(() => {
        throw Error("no effect expected");
      });
      const { ctx } = fakeCtx({ mode: "rpc" });
      const n = await liveConnect(
        deps({
          settings: {
            ...SETTINGS,
            commandComplete: "toolkit",
            ...(condition === "deny" ? { webCommandPolicy: { mem: "deny" as const } } : {}),
          },
          argCompleters: f.raw,
          ownedCommandNames: f.owned,
          ...(condition === "missing-cap" ? {} : { memoryWrite: { capabilities, start } }),
        }),
        pi,
        fire,
        ["command.v1", "cmd.args.v1"],
        ctx,
      );
      const socket = n.sockets[0]!;
      const commands = socket
        .frames()
        .filter((r) => r.t === "commands")
        .at(-1) as unknown as CommandsFrame;
      // Static complete advertises an attempt, NOT permission to use review or execute it.
      expect(commands.items.find((r) => r.name === "mem")?.args?.complete).toBe(true);
      socket.hub({
        t: "complete_req",
        rid: "vm-denied",
        name: "mem",
        prefix: "review ",
        deadlineMs: 2000,
        origin: { listener: "loopback" },
      });
      await flush();
      expect(socket.frames().find((r) => r.t === "complete_reply" && r.rid === "vm-denied")).toMatchObject(
        condition === "deny" ? { ok: false, code: "E_COMMAND_DENIED" } : { ok: true, source: "own", items: [] },
      );
      if (condition === "false-cap" || condition === "throw-cap" || condition === "missing-cap") {
        for (const [i, args] of ["review", "review --list"].entries()) {
          const id = `vm-no-review-000${i}`;
          socket.hub({
            t: "cmd",
            id,
            rid: `${id}-r`,
            deadlineMs: 2000,
            origin: { listener: "loopback", ip: "127.0.0.1", reqId: id },
            cmd: { op: "command", name: "mem", args, confirm: true },
          });
          await flush();
          expect(socket.frames().find((r) => r.t === "cmd_result" && r.id === id)).toMatchObject({
            ok: false,
            code: "E_UNSUPPORTED",
            effect: "none",
          });
        }
      }
      expect(f.native).not.toHaveBeenCalled();
      expect(f.reads).toEqual([]);
      expect(start).not.toHaveBeenCalled();
      expect(sentUserMessages).toEqual([]);
    },
  );

  it("native --run stays unreachable through Web even with confirm=true and actual review capability", async () => {
    const { pi, fire, sentUserMessages } = fakePi();
    const f = registerMemory(pi);
    const read = vi.fn((args: string, cwd: string) => executeMemoryRead(args, cwd));
    const capabilities = vi.fn(() => ({ sessionAdd: false, revisionReview: true }));
    const start = vi.fn(() => {
      throw Error("--run must not enter revision flow");
    });
    const { ctx } = fakeCtx({ mode: "rpc" });
    const n = await liveConnect(
      deps({
        argCompleters: f.raw,
        ownedCommandNames: f.owned,
        memoryRead: read,
        memoryWrite: { capabilities, start },
      }),
      pi,
      fire,
      ["command.v1", "cmd.args.v1"],
      ctx,
    );
    const socket = n.sockets[0]!;
    socket.hub({
      t: "cmd",
      id: "vm-native-run-0001",
      rid: "vm-native-run-r",
      deadlineMs: 2000,
      origin: { listener: "loopback", ip: "127.0.0.1", reqId: "vm-offline" },
      cmd: { op: "command", name: "mem", args: "review --run", confirm: true },
    });
    await flush();
    expect(socket.frames().find((r) => r.t === "cmd_result" && r.id === "vm-native-run-0001")).toMatchObject({
      ok: false,
      code: "E_UNSUPPORTED",
      effect: "none",
    });
    expect(read).toHaveBeenCalledWith("review --run", ctx.cwd);
    expect(capabilities).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(f.native).not.toHaveBeenCalled();
    expect(f.reads).toEqual([]);
    expect(sentUserMessages).toEqual([]);
  });
});
