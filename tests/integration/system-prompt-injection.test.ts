import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import activate from "../../src/index.js";

/**
 * The model cannot discover valid `subagent_type` values on its own: an
 * unknown name comes back as `unknown agent type: <x>` and the turn is burned
 * on trial and error. activate() therefore hooks pi's before_agent_start and
 * appends the registry listing to the assembled system prompt.
 *
 * This guards the *wiring* (hook registered, reads the registry at event
 * time); the rendering itself is unit-tested in tests/config/agent-config.test.ts.
 */
const HOST_KEY = Symbol.for("pi-subagent:host");

// S7: session_start now builds a BashJobManager rooted at the agent dir, so
// this suite runs against a throwaway $HOME — a test must never scan or mutate
// the developer's real ~/.pi/agent (settings file included).
const fakeHome = mkdtempSync(join(tmpdir(), "pi-subagent-home-"));
const realHome = process.env.HOME;
process.env.HOME = fakeHome;
// memory-merge (memory-plan §4.2): the memory module wires its inject hook
// PRE-GUARD (child sessions included, by design), so it now sits ahead of the
// core agent-types hook asserted below and fires in child sessions too. This
// suite scopes itself to the core agent-types/models wiring, so it disables
// memory via the settings file; memory wiring is covered by tests/memory/*.
mkdirSync(join(fakeHome, ".pi", "agent"), { recursive: true });
writeFileSync(
  join(fakeHome, ".pi", "agent", "pi-subagent.json"),
  JSON.stringify({ memory: { enabled: false } }) + "\n",
  "utf8",
);

type Handler = (event: unknown, ctx: unknown) => unknown;

/** Mirrors pi's registration semantics: `on()` appends, every handler fires (loader.ts on()). */
function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    registerTool() {},
    registerCommand() {},
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage() {},
    appendEntry() {},
    events: { on() {}, emit() {} },
  };
  const emit = async (event: string, payload: unknown = {}, ctx: unknown = {}) => {
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
  };
  const first = (event: string) => handlers.get(event)?.[0];
  return { pi, handlers, emit, first };
}

describe("wiring: available agent types are injected into the system prompt", () => {
  beforeEach(() => {
    delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  });
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  });
  afterAll(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("registers before_agent_start and appends the registry listing once types are loaded", async () => {
    const { pi, handlers, emit, first } = fakePi();
    activate(pi as never);

    const hook = first("before_agent_start");
    expect(hook, "before_agent_start must be hooked").toBeTypeOf("function");

    // Before any session_start the registry is empty → no override at all
    // (never hand pi a systemPrompt it did not ask us to change).
    expect(hook!({ systemPrompt: "BASE" }, {})).toBeUndefined();

    // session_start reloads the registry (built-ins always present).
    await emit("session_start", {}, { modelRegistry: { getAvailable: () => [], find: () => undefined } });
    const result = hook!({ systemPrompt: "BASE" }, {}) as { systemPrompt: string };
    expect(result.systemPrompt.startsWith("BASE\n\n")).toBe(true);
    expect(result.systemPrompt).toContain("## Available subagent types (pi-subagent)");
    expect(result.systemPrompt).toContain("- general-purpose:");
    expect(handlers.has("session_shutdown")).toBe(true);

    await emit("session_shutdown", { reason: "exit" });
  });

  it("appends available models from the before_agent_start ctx before session_start (first-prompt window)", async () => {
    const { pi, emit, first } = fakePi();
    activate(pi as never);

    const hook = first("before_agent_start");
    expect(hook, "before_agent_start must be hooked").toBeTypeOf("function");

    // M2: the hub freezes a section's first successful render as its
    // snapshot (stable mode). A single call already carrying the models
    // exercises the ctx.modelRegistry fallback (holder.current is only
    // assigned after session_start) without crossing into the
    // freeze-vs-update-message distinction, which tests/sysprompt/hub.test.ts
    // covers exhaustively on its own.
    const result = hook!(
      { systemPrompt: "BASE" },
      {
        modelRegistry: {
          getAvailable: () => [
            {
              provider: "anthropic",
              id: "claude-sonnet",
              name: "Claude Sonnet",
              reasoning: true,
              contextWindow: 200_000,
            },
          ],
        },
      },
    ) as { systemPrompt: string };
    expect(result.systemPrompt.startsWith("BASE\n\n")).toBe(true);
    expect(result.systemPrompt).toContain("## Available models (pi-subagent)");
    expect(result.systemPrompt).toContain("- anthropic/claude-sonnet — Claude Sonnet (ctx 200k, reasoning)");

    await emit("session_shutdown", { reason: "exit" });
  });

  it("prefers the session stack's model port once session_start has built it", async () => {
    const { pi, emit, first } = fakePi();
    activate(pi as never);
    const hook = first("before_agent_start");

    const stackRegistry = {
      getAvailable: () => [{ provider: "stack", id: "from-holder", name: "Holder model" }],
      find: () => undefined,
    };
    await emit("session_start", {}, { modelRegistry: stackRegistry });

    const eventRegistry = {
      getAvailable: () => [{ provider: "event", id: "from-ctx", name: "Ctx model" }],
    };
    const result = hook!({ systemPrompt: "BASE" }, { modelRegistry: eventRegistry }) as { systemPrompt: string };
    expect(result.systemPrompt).toContain("- stack/from-holder — Holder model");
    expect(result.systemPrompt).not.toContain("- event/from-ctx");

    await emit("session_shutdown", { reason: "exit" });
  });

  it("prefers ctx.scopedModels over the full registry list (an unscoped install truncates away the useful ids)", async () => {
    const { pi, emit, first } = fakePi();
    activate(pi as never);
    const hook = first("before_agent_start");

    // 40 registry models: with MAX_PROMPT_MODELS=30 the tail would be elided,
    // which is exactly how droid-completion/kimi-k3 disappeared in the wild.
    const bulk = Array.from({ length: 40 }, (_, index) => ({
      provider: "amazon-bedrock",
      id: `filler-${index}`,
    }));
    await emit("session_start", {}, { modelRegistry: { getAvailable: () => bulk, find: () => undefined } });

    const result = hook!(
      { systemPrompt: "BASE" },
      {
        modelRegistry: { getAvailable: () => bulk },
        scopedModels: [
          { model: { provider: "droid-completion", id: "kimi-k3", name: "Kimi K3" }, thinkingLevel: "high" },
          { model: { provider: "cloudrouter-anthropic", id: "claude-opus-5" } },
        ],
      },
    ) as { systemPrompt: string };

    expect(result.systemPrompt).toContain("- droid-completion/kimi-k3 — Kimi K3");
    expect(result.systemPrompt).toContain("- cloudrouter-anthropic/claude-opus-5");
    expect(result.systemPrompt).not.toContain("amazon-bedrock/filler-0");
    expect(result.systemPrompt).not.toContain("more");

    await emit("session_shutdown", { reason: "exit" });
  });

  it("stays inert inside child sessions (HOST_KEY guard: no duplicate host-only surface)", () => {
    const first = fakePi();
    activate(first.pi as never);
    const child = fakePi();
    activate(child.pi as never); // re-activation inside a spawned child session

    // M2 (plan D6): the prompt-section hub is created PRE-guard so child
    // sessions share the identical hook set -- `before_agent_start` DOES
    // register here now, but with zero post-guard sections (types/models
    // register only past the HOST_KEY guard below) it is functionally inert.
    const hook = child.handlers.get("before_agent_start")?.[0];
    expect(hook, "the hub's before_agent_start registers even in a child session (D6)").toBeTypeOf("function");
    expect(hook!({ systemPrompt: "BASE" }, {})).toBeUndefined();

    // The strictly host-only surface (registered only past the guard, e.g.
    // /goal's agent_end hook) never duplicates into a child session.
    expect(child.handlers.has("agent_end")).toBe(false);
  });

  it("re-activates after /reload (the host claim is released on session_shutdown)", async () => {
    // Regression: pi's /reload emits session_shutdown on the old runner, then
    // re-imports the extension and calls activate() again in the SAME process.
    // A globalThis claim that outlived its activation made every post-reload
    // instance inert — no Agent tool, no /agent, no hooks — until pi restarted.
    const first = fakePi();
    activate(first.pi as never);
    expect(first.handlers.has("before_agent_start")).toBe(true);
    expect(first.handlers.has("agent_end")).toBe(true); // host-only surface is up

    await first.emit("session_shutdown", { reason: "reload" });

    const reloaded = fakePi();
    activate(reloaded.pi as never);
    expect(reloaded.handlers.has("before_agent_start"), "post-reload instance must take over").toBe(true);
    expect(reloaded.handlers.has("agent_end"), "post-reload instance owns the host-only surface").toBe(true);

    // ...and the fresh instance owns the claim: a child session spawned after
    // the reload still gets only the hub's (inert) hook, never the host-only surface.
    const child = fakePi();
    activate(child.pi as never);
    expect(child.handlers.has("agent_end")).toBe(false);
    const childHook = child.handlers.get("before_agent_start")?.[0];
    expect(childHook!({ systemPrompt: "BASE" }, {})).toBeUndefined();
  });

  it("a child session's shutdown cannot steal the host claim", async () => {
    const host = fakePi();
    activate(host.pi as never);
    const child = fakePi();
    activate(child.pi as never);
    // plugin-merge + M2 (D6): a child session registers the pre-guard merged
    // surface (todo's session hooks) AND the prompt-section hub's full hook
    // set (before_agent_start / context_with_system / session_start /
    // session_compact / model_select / session_tree / turn_start /
    // agent_settled) — but never the strictly host-only hooks/tools that
    // register past the HOST_KEY guard (e.g. /goal's agent_end).
    // bash-timeout-grace plan §3.4/§3.5 (P5): `agent_before_settle` joins this
    // set too — `wireChildBashJobs` registers it pre-guard (default settings:
    // `bashJobs.childSessions`/`childSettleHold` both true) for the settle-
    // hold hook, which is inert (returns undefined) until a bash call is
    // ever made in that child session.
    expect(child.handlers.has("agent_end")).toBe(false);
    const childHook = child.handlers.get("before_agent_start")?.[0];
    expect(childHook!({ systemPrompt: "BASE" }, {})).toBeUndefined(); // present but inert (no sections registered)
    for (const event of child.handlers.keys()) {
      expect([
        "session_start",
        "session_tree",
        "session_compact",
        "session_shutdown",
        "before_agent_start",
        "context_with_system",
        "model_select",
        "turn_start",
        "agent_settled",
        "agent_before_settle",
      ]).toContain(event);
    }

    // Host still owns the claim, so a later activation stays inert.
    const another = fakePi();
    activate(another.pi as never);
    expect(another.handlers.has("agent_end")).toBe(false);
  });
});
