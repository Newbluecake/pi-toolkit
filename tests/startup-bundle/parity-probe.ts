/**
 * Child-process probe for the startup-bundle parity suite (plan r3 §7.1 seams A/B, §7.3 smoke).
 *
 * Runs OUTSIDE vitest, driven by `node --import tsx parity-probe.ts <config.json>`; prints ONE JSON
 * blob (fingerprints for every scenario) on stdout. The process boundary is the isolation seam:
 * HOST_KEY, the secure domain, process.env and the module cache all start clean, so each entry path
 * (src direct / bundle direct / dispatcher) is recorded without manual resets between paths.
 *
 * One scenario:
 *   1. fresh throwaway $HOME (+ `pi-subagent.json`, byte-for-byte like tests/governance; `null`
 *      settings ⇒ no file at all, the DEFAULT-settings shape the fabric off goldens use);
 *   2. reset the process-global activation symbols (host claim, secure domain, …);
 *   3. `traceActivationAsync` — the AWAITABLE recorder (the sync one cannot record the async
 *      dispatcher; plan §7.1 seam A);
 *   4. optional replays against the captured handlers, all verbatim from existing tests:
 *      - "governance": phase-2 replay of tests/governance/activate-trace.test.ts;
 *      - "schedule":  surface capture of tests/integration/schedule-off-golden.test.ts;
 *      - "smoke":     §7.3 — TUI-mode session events with a recording spawn/execFile stub, then
 *                     command-handler invocations (`/webhub status`, `/record on`).
 *
 * The bundle path pins host identity via the tsx-loaded `src/core/bundle-entry.ts` BEFORE importing
 * the artifact — the dispatcher's own order. A recording resolve hook (registerHooks, installed
 * FIRST so it also sees the bundle hooks' short-circuits) collects resolved URLs for the
 * "bundle branch never resolves src/index.ts" assertion. Test infrastructure: never import from src/**.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { traceActivationAsync } from "../helpers/activation-trace-async.js";
import { fakeCtx, systemPromptFor } from "../integration/helpers/schedule-activate.js";

const HOST_KEY = Symbol.for("pi-subagent:host");
const FEISHU_HOST_KEY = Symbol.for("pi-subagent:feishu-notify:host");
const HOST_CAP_KEY = Symbol.for("pi-subagent:xs-host-cap");
const RUN_REGISTRY_KEY = Symbol.for("pi-subagent:sched-run");
const SECURE_DOMAIN_KEY = Symbol.for("pi-subagent:secure-domain");

const PHASE2_METHODS = [
  "sendMessage",
  "appendEntry",
  "ui.setStatus",
  "ui.setWidget",
  "ui.addAutocompleteProvider",
  "ui.notify",
];

interface CommandInvocation {
  command: string;
  args: string;
}

interface Scenario {
  name: string;
  /** `null` ⇒ NO settings file (DEFAULT settings). An object ⇒ written verbatim as pi-subagent.json. */
  settings: unknown;
  child?: boolean;
  omit?: readonly string[];
  replay?: "governance" | "schedule" | "smoke";
  /** smoke replay: write an empty jiti.mjs into the home and point webHub.nodeLoader at it. */
  injectNodeLoader?: boolean;
  /** smoke replay: command handlers to invoke after activation. */
  commands?: CommandInvocation[];
}

interface ProbeConfig {
  mode: "src" | "bundle" | "dispatcher";
  /** Package root the entry lives in (the repo, or a temp package layout). */
  entryDir: string;
  scenarios: Scenario[];
  /** Record resolved URLs under these roots (assert bundle-vs-src routing). */
  watchRoots?: string[];
  /** Capture `parameters` for these tool names (schema identity row, §7.2). */
  captureSchemas?: string[];
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function resetActivationGlobals(): void {
  const g = globalThis as Record<symbol, unknown>;
  delete g[HOST_KEY];
  delete g[FEISHU_HOST_KEY];
  delete g[HOST_CAP_KEY];
  delete g[RUN_REGISTRY_KEY];
  delete g[SECURE_DOMAIN_KEY];
}

/** Same retry shape as tests/integration/helpers/schedule-activate.ts (ENOTEMPTY under load). */
function rmTemp(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

function sandbox(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "pt-parity-"));
  return { home, cleanup: () => rmTemp(home) };
}

interface SpawnCapture {
  argv: string[];
  env: Record<string, string>;
}

async function main(): Promise<void> {
  const config: ProbeConfig = JSON.parse(readFileSync(process.argv[2]!, "utf8"));

  // §7.1 extra assertion: record every resolved URL (FIRST, so it wraps short-circuit hooks).
  const resolvedUrls: string[] = [];
  registerHooks({
    resolve(spec, context, nextResolve) {
      const result = nextResolve(spec, context) as { url?: unknown };
      if (result !== null && typeof result === "object" && typeof result.url === "string")
        resolvedUrls.push(result.url);
      return result;
    },
  });

  let activate: (pi: any) => void | Promise<void>;
  if (config.mode === "src") {
    const mod = await import(join(config.entryDir, "src", "index.ts"));
    activate = mod.default;
  } else if (config.mode === "bundle") {
    // The dispatcher's own order: pin host identity, THEN import the artifact natively.
    const entry = await import(join(config.entryDir, "src", "core", "bundle-entry.ts"));
    const hooks = entry.installBundleHooks();
    if (!hooks.installed && hooks.reason !== undefined && !hooks.reason.includes("already installed")) {
      throw new Error(`probe: installBundleHooks failed: ${hooks.reason}`);
    }
    const mod = await import(entry.bundleUrl());
    activate = entry.pickBundleFactory(mod);
  } else {
    const mod = await import(join(config.entryDir, "index.ts"));
    activate = mod.default;
  }

  const spawnCalls: SpawnCapture[] = [];
  const out: Record<string, unknown> = { mode: config.mode, scenarios: {} };

  for (const scenario of config.scenarios) {
    resetActivationGlobals();
    const box = sandbox();
    const previousHome = process.env.HOME;
    process.env.HOME = box.home;
    try {
      let settings = scenario.settings;
      if (scenario.injectNodeLoader === true && settings !== null && typeof settings === "object") {
        // A dumping loader instead of an empty one: the hub child is `node <loader> <hubMainPath>`;
        // the loader records its own argv + PI_WEBHUB_CONFIG and exits (no real hub boot needed
        // to observe what the BUNDLE computed).
        const dumpPath = join(box.home, "loader-dump.json");
        writeFileSync(
          join(box.home, "jiti.mjs"),
          `import { writeFileSync } from "node:fs";\n` +
            `writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify({\n` +
            `  argv: process.argv.slice(2),\n` +
            `  hubConfig: (() => { try { return JSON.parse(process.env.PI_WEBHUB_CONFIG ?? "null"); } catch { return "unparseable"; } })(),\n` +
            `}));\n`,
        );
        settings = {
          ...(settings as Record<string, unknown>),
          webHub: {
            ...((settings as Record<string, { webHub?: Record<string, unknown> }>).webHub ?? {}),
            nodeLoader: join(box.home, "jiti.mjs"),
          },
        };
      }
      if (settings !== null && settings !== undefined) {
        const dir = join(box.home, ".pi", "agent");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "pi-subagent.json"), JSON.stringify(settings, null, 2) + "\n", "utf8");
      }
      if (scenario.child) (globalThis as Record<symbol, unknown>)[HOST_KEY] = { activatedAt: 1 };

      const handlers = new Map<string, Array<(e: unknown, c: unknown) => unknown>>();
      const toolObjects: unknown[] = [];
      const commandObjects = new Map<string, unknown>();
      const trace = await traceActivationAsync(activate, {
        ...(scenario.omit ? { omit: scenario.omit } : {}),
        onHandler: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
        onRegisterTool: (tool) => toolObjects.push(tool),
        onRegisterCommand: (name, command) => {
          if (!commandObjects.has(name)) commandObjects.set(name, command);
        },
      });

      const domain = (globalThis as Record<symbol, unknown>)[SECURE_DOMAIN_KEY] as
        { kind?: string; vaults?: unknown[]; config?: unknown } | undefined;
      // SNAPSHOT the trace before the phase-2 replays below push into the shared `trace.calls`
      // array: the golden's `calls` is phase-1 only, and activate-trace.test.ts copies
      // `[...trace.calls]` for exactly this reason. A live reference here leaked every replay
      // push (two session_start fires ⇒ +36 entries for profile:default) into the serialized
      // fingerprint, so `calls` diverged from `count` and the golden comparison could never hold.
      const phase1Calls = [...trace.calls];
      const fingerprint: Record<string, unknown> = {
        calls: phase1Calls,
        count: phase1Calls.length,
        envDelta: trace.envDelta,
        tools: trace.calls.filter((c) => c.startsWith("registerTool(")).map((c) => c.slice("registerTool(".length, -1)),
        commands: trace.calls
          .filter((c) => c.startsWith("registerCommand("))
          .map((c) => c.slice("registerCommand(".length, -1)),
        handlerCounts: Object.fromEntries([...handlers].map(([k, v]) => [k, v.length]).sort()),
        secureKind: domain?.kind ?? "none",
        secureVaultCount: domain?.vaults?.length ?? 0,
        secureConfigPresent: domain?.config !== undefined && domain?.config !== null,
      };
      if (config.captureSchemas !== undefined && config.captureSchemas.length > 0) {
        const wanted = new Set(config.captureSchemas);
        fingerprint.toolSchemas = Object.fromEntries(
          toolObjects
            .filter((t) => wanted.has((t as { name?: string }).name ?? "?"))
            .map((t) => [(t as { name?: string }).name ?? "?", (t as { parameters?: unknown }).parameters]),
        );
      }

      if (scenario.replay === "governance") {
        // Verbatim phase-2 replay of tests/governance/activate-trace.test.ts record().
        const ui = (method: string, arg: unknown, extra?: string) => {
          trace.calls.push(`ui.${method}(${typeof arg === "string" ? arg : ""}${extra ?? ""})`);
        };
        const { ctx } = fakeCtx(box.home, { mode: "rpc" });
        ctx.hasUI = true;
        ctx.ui = {
          setWidget: (key: string, content: unknown) => ui("setWidget", key, content === undefined ? ":clear" : ":set"),
          setStatus: (key: string, text: unknown) => ui("setStatus", key, text === undefined ? ":clear" : ":set"),
          notify: (_m: string, level?: string) => ui("notify", level ?? "info"),
          addAutocompleteProvider: () => ui("addAutocompleteProvider", ""),
          confirm: async () => true,
          input: async () => undefined,
        };
        const mark = trace.calls.length;
        const fire = async (event: string, payload: unknown) => {
          for (const fn of handlers.get(event) ?? []) await fn(payload, ctx);
          await tick();
          await tick();
        };
        await fire("session_start", { type: "session_start", reason: "startup" });
        await fire("session_shutdown", { type: "session_shutdown", reason: "new" });
        await fire("session_start", { type: "session_start", reason: "new" });
        await fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
        fingerprint.phase2 = trace.calls.slice(mark).filter((c) => PHASE2_METHODS.some((m) => c.startsWith(`${m}(`)));
        fingerprint.phase2Count = (fingerprint.phase2 as string[]).length;
      }

      if (scenario.replay === "schedule") {
        // Verbatim surface capture of tests/integration/schedule-off-golden.test.ts captureSurface().
        const c = fakeCtx(box.home);
        const emit = async (event: string, payload: unknown) => {
          for (const fn of handlers.get(event) ?? []) await fn(payload, c.ctx);
        };
        await emit("session_start", { type: "session_start", reason: "startup" });
        const prompt = await systemPromptFor({ handlers } as never, c.ctx);
        await emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, c.ctx);
        await emit("agent_settled", { aborted: false }, c.ctx);
        await emit("session_shutdown", { type: "session_shutdown" }, c.ctx);
        const agentDir = join(box.home, ".pi", "agent");
        fingerprint.surface = {
          systemPrompt: prompt,
          statuses: c.statuses,
          legacyFileExists: existsSync(join(agentDir, "pi-subagent-schedules.json")),
          schedulesDirExists: existsSync(join(agentDir, "schedules")),
        };
      }

      if (scenario.replay === "smoke") {
        // §7.3: TUI-mode session events with an OBSERVABLE spawn — the ESM namespace of
        // node:child_process is frozen, so instead of stubbing spawn the injected nodeLoader is a
        // script that dumps the hub child's own argv + PI_WEBHUB_CONFIG to a file. The hub argv is
        // exactly what the BUNDLE's packageRoot computed.
        const c = fakeCtx(box.home, { mode: "tui" });
        (c.ctx.ui as any).theme = { fg: (_style: string, text: string) => text };
        const fire = async (event: string, payload: unknown) => {
          for (const fn of handlers.get(event) ?? []) {
            try {
              await fn(payload, c.ctx);
            } catch {
              /* a handler needing a richer ctx is not this probe's concern */
            }
          }
          await tick();
        };
        await fire("session_start", { type: "session_start", reason: "startup" });
        // The hub spawn is driven by the connect→backoff state machine (maybeSpawn), which runs
        // on real async rounds after the first connect failure — poll for the dump, not ticks.
        const dumpFile = join(box.home, "loader-dump.json");
        for (let i = 0; i < 100 && !existsSync(dumpFile); i++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await tick();
        await tick();
        fingerprint.statuses = c.statuses;
        fingerprint.notices = c.notices;

        for (const invocation of scenario.commands ?? []) {
          const command = commandObjects.get(invocation.command) as
            { handler?: (args: string, ctx: unknown) => Promise<void> | void } | undefined;
          if (command?.handler === undefined) {
            (fingerprint.notices as string[]).push(`PROBE: command ${invocation.command} not registered`);
            continue;
          }
          try {
            await command.handler(invocation.args, c.ctx);
            (fingerprint.notices as string[]).push(`PROBE: ${invocation.command} ${invocation.args} ok`);
          } catch (error) {
            (fingerprint.notices as string[]).push(
              `PROBE: ${invocation.command} ${invocation.args} threw: ${(error as Error).message}`,
            );
          }
        }

        // §7.3 traffic page: if a command just started a local web viewer, fetch the page the
        // BUNDLE's own buildPage() assembled (packageRoot-anchored app.js + vendored Vue).
        const url = (fingerprint.notices as string[]).join("\n").match(/http:\/\/127\.0\.0\.1:\d+(?:\/[^\s"']*)?/)?.[0];
        if (url !== undefined) {
          try {
            const response = await fetch(url);
            const body = await response.text();
            fingerprint.trafficPage = {
              status: response.status,
              hasRecordTokenMeta: body.includes('name="record-token"'),
              hasVueGlobal: body.includes("vue.global") || body.includes("VueCompositionAPI"),
              hasAppMount: body.includes("createApp") || body.includes("#app"),
              bytes: body.length,
            };
          } catch (error) {
            fingerprint.trafficPage = { fetchError: (error as Error).message };
          }
        }

        // The dumping nodeLoader (injectNodeLoader) wrote the hub child's argv + hub config.
        if (existsSync(dumpFile)) {
          try {
            const dump = JSON.parse(readFileSync(dumpFile, "utf8")) as { argv?: string[]; hubConfig?: unknown };
            fingerprint.hubSpawn = { argv: dump.argv ?? [], config: dump.hubConfig ?? null };
          } catch {
            fingerprint.hubSpawn = { argv: [], config: "unparseable" };
          }
        }
      }

      (out.scenarios as Record<string, unknown>)[scenario.name] = fingerprint;
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      resetActivationGlobals();
      box.cleanup();
    }
  }

  // Only the routing-relevant URLs (entry/index/bundle) — the raw list is ~7k entries under tsx.
  const roots = config.watchRoots ?? [];
  out.resolvedUrls = resolvedUrls.filter(
    (u) =>
      roots.some((r) => u.startsWith(pathToFileURL(r).href)) &&
      (u.includes("/src/index.") || u.includes("/dist/bundle/")),
  );
  out.spawnCalls = spawnCalls.map((c) => ({
    argv: c.argv,
    config: (() => {
      try {
        return JSON.parse(c.env["PI_WEBHUB_CONFIG"] ?? "null");
      } catch {
        return "unparseable";
      }
    })(),
  }));
  process.stdout.write(JSON.stringify(out));
  // Some activations leave unref'd timers / open handles (bash-jobs store flush, keepalive probes);
  // the fingerprint is complete, so do not let them hold the process open.
  process.exit(0);
}

await main();
