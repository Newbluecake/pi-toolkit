/**
 * wake-unknown-optimistic §5.1 (review #1, Blocker): REAL legacy-pi conformance.
 *
 * Self-gated: runs ONLY when PI_TOOLKIT_LEGACY_PI_DIR points at an unpacked
 * @earendil-works/pi-coding-agent package (pi 1.0.4 / 1.1.0 — the hosts whose non-streaming
 * `sendCustomMessage(…,{triggerTurn:true})` runs the prompt WITHOUT before_agent_start, F1).
 * CI never sets the variable, so CI skips this file.
 *
 *   PI_TOOLKIT_LEGACY_PI_DIR=/tmp/pi10/package npx vitest run tests/conformance/fabric-xs-legacy.test.ts
 *   PI_TOOLKIT_LEGACY_PI_DIR=/tmp/pi11/package npx vitest run tests/conformance/fabric-xs-legacy.test.ts
 *
 * Reproduce a dir with:  npm pack @earendil-works/pi-coding-agent@1.1.0 && mkdir /tmp/pi11 && tar xzf *.tgz -C /tmp/pi11
 *
 * Provider = plan A: the legacy bundle's OWN provider pipeline (ModelRuntime.create over a
 * models.json pointing at the local AnthropicStub — no host shim, no streamSimple).
 * The code under test (`src/fabric/root-wake.ts` + guards) is pi-free and imported directly.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AnthropicStub } from "./fixtures/anthropic-stub.js";
import { FakeClock } from "../../src/core/clock.js";
import { RootWakeController, type RootWakeAudit } from "../../src/fabric/root-wake.js";
import { XsWakeLedger } from "../../src/fabric/xs/wake-ledger.js";
import { XsHostCapability } from "../../src/fabric/xs/host-cap.js";

const LEGACY_DIR = process.env.PI_TOOLKIT_LEGACY_PI_DIR;
/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

interface LegacyHost {
  dir: string;
  agentDir: string;
  session: Any;
  manager: Any;
  clock: FakeClock;
  ledger: XsWakeLedger;
  cap: XsHostCapability;
  controller: RootWakeController;
  audit: RootWakeAudit[];
  /** before_agent_start events actually fired by the legacy host (empty for wake runs — F1). */
  basEvents: unknown[];
  /** trailing message of each context event, in firing order (F4). */
  contextTails: unknown[];
  /** ledger snapshot taken at each context event (before settlement can release the record). */
  contextLedgers: unknown[][];
  settled: boolean[];
  /** last assistant stopReason per agent_end (pi 1.0's agent_settled has no `aborted` field). */
  agentEnds: string[];
  abortCalls: number;
  wake: (content?: string) => ReturnType<RootWakeController["dispatch"]>;
  close: () => Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const sleep = (ms: number) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
async function until(check: () => boolean, label: string, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await sleep(5);
  expect(check(), label).toBe(true);
}

/**
 * Boots a REAL legacy-pi AgentSession over the local Anthropic stub and wires the REAL
 * RootWakeController (FakeClock) to it through an inline extension factory: BAS / context /
 * agent_settled handlers only — the same wiring `src/fabric/xs/activate.ts` installs.
 */
async function legacyHost(
  stub: AnthropicStub,
  options: { onSettled?: () => void; forwardBas?: boolean } = {},
): Promise<LegacyHost> {
  expect(LEGACY_DIR, "PI_TOOLKIT_LEGACY_PI_DIR must point at an unpacked legacy package").toBeTruthy();
  const bundle = (await import(pathToFileURL(join(LEGACY_DIR!, "dist/bundle/index.js")).href)) as Any;
  for (const name of [
    "createAgentSession",
    "SessionManager",
    "SettingsManager",
    "DefaultResourceLoader",
    "ModelRuntime",
  ])
    expect(typeof bundle[name], `legacy bundle exports ${name}`).toBe("function");
  expect(typeof bundle.streamSimple, "legacy bundle must NOT export streamSimple (F6)").toBe("undefined");

  const dir = mkdtempSync(join(tmpdir(), "fabric-xs-legacy-"));
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir);
  // Plan A: the legacy runtime's OWN provider pipeline over a local loopback provider.
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "xs-local": {
          baseUrl: `${stub.baseUrl}/v1`,
          api: "anthropic-messages",
          apiKey: "local-stub-only",
          models: [{ id: "claude-xs", contextWindow: 1000, maxTokens: 128 }],
        },
      },
    }),
  );
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({}));
  // No auth.json: the inline `apiKey` in models.json IS the credential (a wrong-shaped auth.json
  // silently blanks auth on the legacy runtime — probed on both 1.0.4 and 1.1.0).

  const clock = new FakeClock();
  const ledger = new XsWakeLedger();
  const cap = new XsHostCapability();
  const audit: RootWakeAudit[] = [];
  const basEvents: unknown[] = [];
  const contextTails: unknown[] = [];
  const contextLedgers: unknown[][] = [];
  const settled: boolean[] = [];
  const agentEnds: string[] = [];
  const state: { abortCalls: number; ctx?: Any; pi?: Any; session?: Any } = { abortCalls: 0 };
  let controller!: RootWakeController;
  const loader = new bundle.DefaultResourceLoader({
    cwd: dir,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (api: Any) => {
        state.pi = api;
        api.on("session_start", (_e: unknown, ctx: Any) => {
          state.ctx = ctx;
        });
        api.on("before_agent_start", (event: unknown) => {
          basEvents.push(event);
          // L4 sets forwardBas:false — a legacy host's human {prompt} BAS would flip the capability
          // to absent before the deferred dispatch; the deferred/queued/abort mechanics under test
          // are independent of that observation.
          if (options.forwardBas !== false) controller.beforeAgentStart(event);
        });
        api.on("context", (event: Any) => {
          const messages: unknown[] = Array.isArray(event?.messages) ? event.messages : [];
          contextTails.push(messages.at(-1));
          controller.context(event);
          contextLedgers.push(ledger.entries());
        });
        api.on("agent_end", (event: Any) => {
          agentEnds.push(String(event?.messages?.at(-1)?.stopReason ?? ""));
        });
        api.on("agent_settled", (event: Any) => {
          settled.push(event?.aborted === true);
          controller.settled();
          options.onSettled?.();
        });
      },
    ],
  });
  await loader.reload();
  const modelRuntime = await bundle.ModelRuntime.create({ modelsPath: join(agentDir, "models.json") });
  const model = modelRuntime.getModel("xs-local", "claude-xs");
  expect(model, "legacy ModelRuntime resolved the stub model (provider plan A)").toBeTruthy();
  const manager = bundle.SessionManager.inMemory(dir);
  controller = new RootWakeController({
    sessionId: manager.getSessionId(),
    rootRunMaxS: 20,
    wakeEnabled: true,
    receive: () => "wake",
    clock,
    ledger,
    capability: cap,
    audit: (event) => audit.push(event),
    host: {
      isIdle: () => state.session?.isIdle ?? true,
      hasPendingMessages: () => state.session?.pendingMessageCount > 0,
      sendMessage: (m, o) => state.pi.sendMessage(m, o),
      abort: () => {
        state.abortCalls++;
        return state.ctx?.abort?.();
      },
    },
  });
  const settings = bundle.SettingsManager.create(dir, agentDir);
  const { session } = await bundle.createAgentSession({
    cwd: dir,
    sessionManager: manager,
    model,
    modelRuntime,
    settingsManager: settings,
    resourceLoader: loader,
  });
  state.session = session;
  await session.bindExtensions({ mode: "rpc", onError: () => undefined });
  const wake = (content = "legacy wake body") =>
    controller.dispatch({
      xid: `lx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      from: { ref: "legacy-source" },
      content,
      expiresAt: Date.now() + 10_000,
    });
  const host: LegacyHost = {
    dir,
    agentDir,
    session,
    manager,
    clock,
    ledger,
    cap,
    controller,
    audit,
    basEvents,
    contextTails,
    contextLedgers,
    settled,
    agentEnds,
    get abortCalls() {
      return state.abortCalls;
    },
    wake,
    close: async () => {
      controller.dispose();
      await session.abort?.().catch(() => undefined);
      session.dispose?.();
      await stub.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  cleanups.push(host.close);
  return host;
}

describe.skipIf(!LEGACY_DIR)("wake-unknown-optimistic: real legacy pi conformance (L1–L4, §5.1)", () => {
  /** pi 1.1+ marks agent_settled{aborted:true}; pi 1.0 has no field — agent_end's stopReason is the evidence. */
  /**
   * Abort evidence, version-tolerant: pi 1.1+ marks agent_settled{aborted:true}; pi 1.0 has no
   * field and its context-aborted run ends with the assistant's stopReason "error" (probed on
   * both bundles — 0 provider requests + our abort counter corroborate).
   */
  const abortedRun = (h: LegacyHost, index: number) =>
    h.settled[index] === true || h.agentEnds[index] === "aborted" || h.agentEnds[index] === "error";
  it("L1+L2: legacy starting — no BAS ever, first context carries the marker, abort before the provider, absent, exactly one audit/abort", async () => {
    const stub = await AnthropicStub.start();
    const h = await legacyHost(stub);
    expect(h.cap.state).toBe("unknown"); // fresh process: optimistic dispatch ahead
    const before = stub.requests.length;
    const result = h.wake();
    // L2: dispatch is accepted (woke = accepted dispatch) and F2 holds synchronously.
    expect(result).toMatchObject({ dispatched: true, effect: "applied", woke: true });
    expect(h.session.isIdle).toBe(false);
    await until(() => h.contextTails.length >= 1, "wake run reached its first context event");
    const token = (result as { token: string }).token;
    // the snapshot taken at that very context sight (settlement may release the record right after)
    const record = (h.contextLedgers[0] as Array<{ token: string }>).find((r) => r.token === token);
    expect(record).toMatchObject({
      state: "tombstone",
      started: true,
      executionPending: true,
      levelCommitted: true,
      gateSightAt: expect.any(Number),
      abortIssuedAt: expect.any(Number),
    });
    await until(() => h.settled.length === 1, "wake run settled");
    // L1: the wake run NEVER saw before_agent_start (F1)…
    expect(h.basEvents).toHaveLength(0);
    // …and its first context event's TRAILING message is our custom marker with the full shape (F4).
    const tail = h.contextTails[0] as
      | { role?: unknown; customType?: unknown; details?: { xsWake?: unknown; wakeToken?: unknown; xid?: unknown } }
      | undefined;
    expect(tail?.role).toBe("custom");
    expect(tail?.customType).toBe("subagent:xs");
    expect(tail?.details?.xsWake).toBe(true);
    expect(typeof tail?.details?.wakeToken).toBe("string");
    expect(tail?.details?.xid).toEqual(expect.any(String));
    // L2: zero provider requests, aborted settled, absent, exactly one abort + one audit entry.
    expect(stub.requests).toHaveLength(before);
    expect(abortedRun(h, h.settled.length - 1)).toBe(true);
    expect(h.cap.state).toBe("absent");
    expect(h.abortCalls).toBe(1);
    expect(h.audit.filter((e) => e === "wake_shape_absent_aborted")).toHaveLength(1);
    expect(h.controller.state).toBe("idle"); // supervised through settlement
    // L2: the second wake on an absent host is deliver-only.
    expect(h.wake("second")).toEqual({ dispatched: false, wakeDowngraded: "host_unsupported" });
  }, 20_000);

  it("L3: a human prompt's legacy BAS only marks the shape (absent); its provider request runs; no abort; wakes stay host_unsupported", async () => {
    const stub = await AnthropicStub.start();
    const h = await legacyHost(stub);
    const before = stub.requests.length;
    const run = h.session.prompt("human first turn");
    await until(() => h.settled.length === 1, "human run settled");
    await run;
    expect(h.basEvents.length).toBeGreaterThanOrEqual(1);
    // The legacy {prompt} shape (no messageType) is the absent evidence.
    expect((h.basEvents[0] as { messageType?: unknown; prompt?: unknown }).messageType).toBeUndefined();
    expect(typeof (h.basEvents[0] as { prompt?: unknown }).prompt).toBe("string");
    expect(h.cap.state).toBe("absent");
    expect(stub.requests.length).toBe(before + 1); // the human run's provider request ran
    expect(h.abortCalls).toBe(0); // no abort — human runs are never ours to abort
    expect(h.wake()).toEqual({ dispatched: false, wakeDowngraded: "host_unsupported" });
  }, 20_000);

  it("L4: dispatch inside agent_settled defers (Fpi5); the queued run is aborted at its first context, zero provider requests", async () => {
    const stub = await AnthropicStub.start();
    const deferred: Array<ReturnType<RootWakeController["dispatch"]>> = [];
    const stateAfterDispatch: string[] = [];
    let armed = true;
    const h = await legacyHost(stub, {
      forwardBas: false, // see harness: keep the capability unknown through the human run
      // dispatch from INSIDE the first agent_settled handler — pi defers the triggered run
      // until every settled handler returned (Fpi5), so isIdle reads true at dispatch.
      onSettled: () => {
        if (!armed) return;
        armed = false;
        deferred.push(h.wake("deferred legacy wake"));
        stateAfterDispatch.push(h.controller.state);
      },
    });
    const run = h.session.prompt("human turn");
    await run; // pi drains the deferred action before this resolves: the queued run already ended
    expect(deferred[0]).toMatchObject({
      dispatched: true,
      effect: "unknown",
      reason: "start_deferred",
      woke: true,
    });
    expect(stateAfterDispatch[0]).toBe("deferred"); // the dispatch inside settled DID defer (Fpi5)
    const before = stub.requests.length;
    await until(() => h.settled.length === 2, "queued wake run settled (aborted)");
    expect(abortedRun(h, 1)).toBe(true);
    expect(stub.requests).toHaveLength(before); // zero provider requests for the wake run
    expect(h.abortCalls).toBe(1);
    expect(h.audit.filter((e) => e === "wake_shape_absent_aborted")).toHaveLength(1);
    expect(h.cap.state).toBe("absent");
    expect(h.basEvents).toHaveLength(1); // only the human run's BAS — the wake run never got one (F1)
  }, 25_000);
});
