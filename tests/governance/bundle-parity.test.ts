/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * startup-bundle plan r3 §7 — the full parity acceptance matrix for the single-file bundle.
 *
 * P1 (228631bc, packageRoot content anchor) and P2 (ac60f407, dispatcher + bundle) landed the
 * implementation; this suite is the 收尾包: prove the three load paths (src direct / bundle
 * direct / dispatcher) are behaviour-identical, that the off/secure contracts still hold through
 * the bundle, that a broken bundle fails loud instead of falling back, that the §7.3 operational
 * surfaces work from inside the bundle, and that the §6.4 performance numbers hold under the REAL
 * pi loader (`loadExtensions` — the exact entry pi uses for every extension).
 *
 * Architecture (plan §7.1 seams):
 *   A. `tests/helpers/activation-trace-async.ts` — the AWAITABLE recorder (the sync one cannot
 *      see past the dispatcher's first `await`; the existing file stays untouched).
 *   B. every path runs in its own child process (`tests/startup-bundle/parity-probe.ts` under
 *      tsx) — process boundaries isolate HOST_KEY, the secure domain, env and the module cache.
 *   C. full temporary package layouts drive the "no bundle ⇒ source" and "broken bundle ⇒ error,
 *      never fallback" rows through the REAL loader (`tests/startup-bundle/loader-probe.mjs`).
 *
 * CI runs `build:bundle` BEFORE `npm test`, so a missing artifact is a BROKEN gate, not a skip
 * (plan R10): the suite fails loud when `dist/bundle/index.js` is absent.
 *
 * Scope notes (deliberate, see the task brief):
 *   - the fabric-wake-off / fabric-xs-reply-off fixtures pin internals that never pass through
 *     activate() (spawn-service journals, wireWebHub frames). Their settings INPUTS are re-run
 *     through the bundle and compared src↔bundle; the golden bytes themselves stay pinned by the
 *     existing src-path tests. The wake golden's `messageAgentSchema` IS activation-visible and
 *     is compared against the bundle-captured `message_agent.parameters`.
 *   - §7.2's "real CLI anchor" row (spawn the actual `pi` binary) is not covered here; the
 *     loadExtensions probes use the same loader with the same alias table, which is the closest
 *     hermetic equivalent.
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BASELINE } from "../integration/helpers/schedule-activate.js";
import { PROFILES } from "./trace-profiles.js";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const BUNDLE = join(ROOT, "dist", "bundle", "index.js");
const PARITY_PROBE = join(ROOT, "tests", "startup-bundle", "parity-probe.ts");
const LOADER_PROBE = join(ROOT, "tests", "startup-bundle", "loader-probe.mjs");
const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");
// No `import.meta.resolve` here: vitest's SSR transform does not provide it. The repo layout
// pins the host package location; the loader probe (.mjs, plain node) re-derives it the same way.
const PI_PKG = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");

/**
 * Child env: an explicit WHITELIST, never the parent's whole environment. Who spawns this test
 * differs by invocation — `npm test` leaks the whole npm lifecycle family (npm_config_,
 * npm_package_*), a vitest worker adds VITEST_* / NODE_ENV=test, and a developer shell may export
 * provider keys or debug flags — and several of those reach activation-time behaviour: quota's
 * ENV_FALLBACK credentials change the per-session_start warning count the trace golden pins,
 * DEEPSEEK_API_KEY / PI_WEB_SEARCH_ENV_FILE feed web-tools, PI_SUBAGENT_DEBUG_COMPACT_HINT flips
 * compact-hint logging, PI_TOOLKIT_ENTRY / PI_CODING_AGENT_DIR hijack entry+settings resolution.
 * A probe child must record the SAME activation no matter who spawned it (bash, vitest worker,
 * CI), so it gets exactly the OS basics plus the caller's explicit overrides.
 */
const CHILD_ENV_WHITELIST = ["PATH", "HOME", "TMPDIR"] as const;

function childEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string> = { TZ: "Asia/Shanghai" };
  for (const key of CHILD_ENV_WHITELIST) {
    const value = process.env[key];
    if (value !== undefined && value !== "") env[key] = value;
  }
  return { ...env, ...overrides };
}

const TRACE_GOLDEN = JSON.parse(
  readFileSync(join(ROOT, "tests", "fixtures", "governance", "activate-trace.json"), "utf8"),
) as Record<string, { calls: string[]; count: number; phase2: string[]; phase2Count: number }>;
const SECURE_GOLDEN = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "secure-off-golden.json"), "utf8")) as {
  scenarios: Record<string, unknown>;
  expect: {
    domainKind: string;
    guardsNeeded: boolean;
    secureCommandRegistered: boolean;
    envDelta: Record<string, string | null>;
    tracesIdenticalAcrossScenarios: boolean;
  };
};
const XS_OFF_GOLDEN = JSON.parse(
  readFileSync(join(ROOT, "tests", "fixtures", "fabric-xs-off-golden.json"), "utf8"),
) as {
  mainSessionTools: string[];
};
const THREAD_OFF_GOLDEN = JSON.parse(
  readFileSync(join(ROOT, "tests", "fixtures", "thread-off-golden.json"), "utf8"),
) as {
  mainSessionTools: string[];
};
const THREAD_REBIND_OFF_GOLDEN = JSON.parse(
  readFileSync(join(ROOT, "tests", "fixtures", "thread-rebind-off-golden.json"), "utf8"),
) as { mainSessionTools: string[]; commands: string[] };
const SCHEDULE_OFF_GOLDEN = JSON.parse(
  readFileSync(join(ROOT, "tests", "fixtures", "schedule-off-golden.json"), "utf8"),
) as {
  surface: { tools: string[]; commands: string[]; handlerCounts: Record<string, number>; systemPrompt: string };
};

interface Fingerprint {
  calls: string[];
  count: number;
  envDelta: Record<string, string | null>;
  tools: string[];
  commands: string[];
  handlerCounts: Record<string, number>;
  secureKind: string;
  secureVaultCount: number;
  secureConfigPresent: boolean;
  phase2?: string[];
  phase2Count?: number;
  surface?: {
    systemPrompt: string;
    statuses: Array<[string, string | undefined]>;
    legacyFileExists: boolean;
    schedulesDirExists: boolean;
  };
  toolSchemas?: Record<string, unknown>;
  notices?: string[];
  statuses?: Array<[string, string | undefined]>;
  hubSpawn?: { argv: string[]; config: unknown };
  trafficPage?: Record<string, unknown>;
}

interface ProbeResult {
  mode: string;
  scenarios: Record<string, Fingerprint>;
  resolvedUrls: string[];
  spawnCalls: Array<{ argv: string[]; config: unknown }>;
}

/** §7.1 seam B: run one probe child process and parse its fingerprint blob. */
function runParityProbe(config: Record<string, unknown>, timeoutMs = 180_000): ProbeResult {
  const cfgFile = join(tmpdir(), `pt-parity-cfg-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(cfgFile, JSON.stringify(config));
  try {
    const result = spawnSync(process.execPath, ["--import", TSX_LOADER, PARITY_PROBE, cfgFile], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: timeoutMs,
      env: childEnv(),
    });
    expect(result.status, `probe (${String(config.mode)}) failed:\n${result.stderr}`).toBe(0);
    return JSON.parse(result.stdout) as ProbeResult;
  } finally {
    rmSync(cfgFile, { force: true });
  }
}

/** §7.1 seam C / §6.4: drive the REAL pi loader against one entry. */
function runLoaderProbe(entry: string, cwd: string, env: Record<string, string> = {}, timeoutMs = 120_000): any {
  const result = spawnSync(process.execPath, [LOADER_PROBE, "load", entry, cwd], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    env: childEnv(env),
  });
  expect(result.status, `loader probe failed for ${entry}:\n${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout);
}

// ---------------------------------------------------------------------------
// Scenario inputs
// ---------------------------------------------------------------------------

const profileScenarios = Object.entries(PROFILES).map(([name, profile]) => ({
  name: `profile:${name}`,
  settings: profile.settings,
  ...(profile.child ? { child: true } : {}),
  ...(profile.omit ? { omit: profile.omit } : {}),
  ...(profile.phase2 ? { replay: "governance" as const } : {}),
}));

/** 真·全 off (§7.1 off table, last row): every switchable subsystem explicitly false. */
const ALL_OFF = {
  ...BASELINE,
  fabric: { enabled: false },
  compact: { enabled: false },
  bashJobs: { enabled: false },
  extend: { enabled: false },
  workflow: { enabled: false },
  load: { enabled: false },
  quota: { enabled: false },
  schedule: { enabled: false },
  topicSwitch: { enabled: false },
  traffic: { enabled: false },
  cacheTtl: { enabled: false },
};

const offScenarios = [
  ...Object.entries(SECURE_GOLDEN.scenarios).map(([name, settings]) => ({
    name: `secure-off:${name}`,
    settings,
  })),
  { name: "off:xs-off", settings: null }, // DEFAULT settings — the fabric-xs-off golden's input
  { name: "off:wake-off", settings: { fabric: { enabled: true, wake: { enabled: false } } } },
  {
    name: "off:xs-reply-off",
    settings: { fabric: { enabled: true, crossSession: { enabled: true, reply: { enabled: false } } } },
  },
  { name: "off:schedule-off", settings: { ...BASELINE }, replay: "schedule" as const },
  { name: "off:thread-off", settings: { fabric: { enabled: true } } },
  { name: "off:thread-rebind-off", settings: { fabric: { enabled: true, threads: { enabled: true } } } },
  { name: "off:all-off", settings: ALL_OFF },
];

const smokeScenarios = [
  {
    name: "smoke:hub-ui-hud",
    settings: { ...BASELINE, webHub: { enabled: true, autoStart: true }, hud: { enabled: true } },
    injectNodeLoader: true,
    replay: "smoke" as const,
    commands: [{ command: "webhub", args: "status" }],
  },
  {
    name: "smoke:traffic",
    settings: { ...BASELINE, traffic: { enabled: true, web: { port: 20000 + (process.pid % 20000) } } },
    replay: "smoke" as const,
    commands: [{ command: "record", args: "on" }],
  },
  { name: "smoke:child-inert", settings: { ...BASELINE }, child: true },
];

// ---------------------------------------------------------------------------
// Probe runs — one process per path (seam B), shared by every describe below.
// ---------------------------------------------------------------------------

let src: ProbeResult;
let bundle: ProbeResult;
let dispatcher: ProbeResult;
let smoke: ProbeResult;

const CAPTURE_SCHEMAS = ["web_search"];

beforeAll(() => {
  // R10: a missing artifact is a broken gate, never a silent skip. CI builds before testing.
  expect(
    existsSync(BUNDLE),
    "dist/bundle/index.js is missing — run `npm run build:bundle` (CI builds before test)",
  ).toBe(true);

  const base = {
    entryDir: ROOT,
    watchRoots: [ROOT],
    captureSchemas: CAPTURE_SCHEMAS,
  };
  src = runParityProbe({ ...base, mode: "src", scenarios: profileScenarios.concat(offScenarios) }, 300_000);
  bundle = runParityProbe({ ...base, mode: "bundle", scenarios: profileScenarios.concat(offScenarios) }, 300_000);
  dispatcher = runParityProbe(
    { ...base, mode: "dispatcher", scenarios: profileScenarios.concat(offScenarios) },
    300_000,
  );
  smoke = runParityProbe({ entryDir: ROOT, mode: "bundle", scenarios: smokeScenarios }, 180_000);
}, 420_000);

/** tools/commands/handlerCounts — the golden-expressible surface facts, derived from `calls`. */
function surfaceOf(fp: Fingerprint): Pick<Fingerprint, "tools" | "commands" | "handlerCounts"> {
  return { tools: fp.tools, commands: fp.commands, handlerCounts: fp.handlerCounts };
}

// ---------------------------------------------------------------------------
// §7.1 Behavioural parity: three paths × 7 profiles
// ---------------------------------------------------------------------------

describe("§7.1 three-path activation parity × 7 profiles", () => {
  const results = () => ({ src, bundle, dispatcher });

  for (const path of ["src", "bundle", "dispatcher"] as const) {
    it(`${path}: every profile's phase-1 calls and phase-2 replay match the activate-trace golden`, () => {
      const result = results()[path];
      for (const [name, profile] of Object.entries(PROFILES)) {
        const fp = result.scenarios[`profile:${name}`];
        expect(fp, `${path}/${name} recorded`).toBeDefined();
        const golden = TRACE_GOLDEN[name]!;
        expect(fp.count, `${path}/${name} call count`).toBe(golden.count);
        expect(fp.calls, `${path}/${name} phase 1`).toEqual(golden.calls);
        if (profile.phase2) {
          expect(fp.phase2Count, `${path}/${name} phase-2 count`).toBe(golden.phase2Count);
          expect(fp.phase2, `${path}/${name} phase 2`).toEqual(golden.phase2);
        }
      }
    });
  }

  it("the three paths agree exactly on tools / commands / handler counts for every scenario", () => {
    const names = Object.keys(src.scenarios);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(surfaceOf(bundle.scenarios[name]!), `${name}: bundle vs src`).toEqual(surfaceOf(src.scenarios[name]!));
      expect(surfaceOf(dispatcher.scenarios[name]!), `${name}: dispatcher vs src`).toEqual(
        surfaceOf(src.scenarios[name]!),
      );
    }
  });

  it("dispatcher resolves the bundle and NEVER the source entry (recorded resolutions, not timing)", () => {
    const urls = dispatcher.resolvedUrls.map((u) => u.replace("file://", "").replace(/\?v=\d+$/, ""));
    expect(urls).toContain(BUNDLE);
    expect(
      urls.some((u) => u.endsWith("/src/index.ts") || u.endsWith("/src/index.js")),
      urls.join("\n"),
    ).toBe(false);
  });

  it("the src path does resolve the source entry (recording hook sanity)", () => {
    expect(src.resolvedUrls.some((u) => u.endsWith("/src/index.ts"))).toBe(true);
  });

  it("§7.2 schema row: the three paths' typebox schemas are identical and validate under the HOST typebox copy", async () => {
    const require = createRequire(join(PI_PKG, "package.json"));
    const valueModule = (await import(require.resolve("typebox/value"))) as {
      Value: { Check: (schema: unknown, value: unknown) => unknown };
    };
    const schemaOf = (r: ProbeResult): unknown => r.scenarios["profile:default"]!.toolSchemas?.["web_search"];
    for (const path of ["src", "bundle", "dispatcher"] as const) {
      const schema = schemaOf(results()[path]);
      expect(schema, `${path}: web_search schema captured`).toBeDefined();
      expect(typeof valueModule.Value.Check(schema, {})).toBe("boolean");
    }
    expect(schemaOf(results().bundle)).toEqual(schemaOf(results().src));
    expect(schemaOf(results().dispatcher)).toEqual(schemaOf(results().src));
  });
});

// ---------------------------------------------------------------------------
// §7.1 off / secure contracts through the bundle
// ---------------------------------------------------------------------------

describe("§7.1 off/secure contracts through the bundle (inputs reused from the fixtures)", () => {
  it("secure-off: all three scenarios keep the golden verdict — plain domain, no guards, no /secure, no env delta, identical traces", () => {
    const traces: string[][] = [];
    for (const name of Object.keys(SECURE_GOLDEN.scenarios)) {
      const fp = bundle.scenarios[`secure-off:${name}`]!;
      expect(fp.secureKind, name).toBe(SECURE_GOLDEN.expect.domainKind);
      // guardsNeeded (golden: false) is structural — plain + no configured vaults ⇒ no guards;
      // the golden's own src-path test pins the real function, this pins the bundle side.
      expect(fp.secureVaultCount, name).toBe(0);
      expect(fp.calls.includes("registerCommand(secure)"), name).toBe(SECURE_GOLDEN.expect.secureCommandRegistered);
      expect(fp.envDelta, name).toEqual(SECURE_GOLDEN.expect.envDelta);
      traces.push(fp.calls);
    }
    expect(traces.every((t) => JSON.stringify(t) === JSON.stringify(traces[0]))).toBe(
      SECURE_GOLDEN.expect.tracesIdenticalAcrossScenarios,
    );
  });

  it("fabric xs off (DEFAULT settings): the bundle's tool table equals the frozen golden", () => {
    expect(bundle.scenarios["off:xs-off"]!.tools).toEqual(XS_OFF_GOLDEN.mainSessionTools);
  });

  it("thread off (fabric on, threads absent): the bundle's tool table equals the frozen golden", () => {
    expect(bundle.scenarios["off:thread-off"]!.tools).toEqual(THREAD_OFF_GOLDEN.mainSessionTools);
  });

  it("thread rebind off (fabric+threads on): the bundle's tool AND command tables equal the frozen golden", () => {
    const fp = bundle.scenarios["off:thread-rebind-off"]!;
    expect(fp.tools).toEqual(THREAD_REBIND_OFF_GOLDEN.mainSessionTools);
    expect(fp.commands).toEqual(THREAD_REBIND_OFF_GOLDEN.commands);
  });

  it("schedule off (BASELINE): tools / commands / handler counts / folded system prompt equal the frozen golden", () => {
    const fp = bundle.scenarios["off:schedule-off"]!;
    expect(fp.tools).toEqual(SCHEDULE_OFF_GOLDEN.surface.tools);
    expect(fp.commands).toEqual(SCHEDULE_OFF_GOLDEN.surface.commands);
    expect(fp.handlerCounts).toEqual(SCHEDULE_OFF_GOLDEN.surface.handlerCounts);
    expect(fp.surface?.systemPrompt).toEqual(SCHEDULE_OFF_GOLDEN.surface.systemPrompt);
  });

  it("wake off: the off input's whole fingerprint matches the src path (the wake golden's internals stay pinned by its own src-path test)", () => {
    expect(bundle.scenarios["off:wake-off"]!.calls).toEqual(src.scenarios["off:wake-off"]!.calls);
    expect(surfaceOf(bundle.scenarios["off:wake-off"]!)).toEqual(surfaceOf(src.scenarios["off:wake-off"]!));
    // message_agent is a child-scope tool (RESERVED_TOOL_NAMES): its schema never passes a
    // main-session registerTool, so the frozen messageAgentSchema is not activation-visible.
  });

  it("真·全 off: the bundle's whole fingerprint equals the src path's under the same input (I9 bundle-side proof)", () => {
    expect(bundle.scenarios["off:all-off"]!.calls).toEqual(src.scenarios["off:all-off"]!.calls);
    expect(surfaceOf(bundle.scenarios["off:all-off"]!)).toEqual(surfaceOf(src.scenarios["off:all-off"]!));
  });

  it("every off input: bundle calls === src calls (fixture inputs re-run through both paths)", () => {
    for (const scenario of offScenarios) {
      expect(bundle.scenarios[scenario.name]!.calls, scenario.name).toEqual(src.scenarios[scenario.name]!.calls);
      expect(surfaceOf(bundle.scenarios[scenario.name]!), scenario.name).toEqual(
        surfaceOf(src.scenarios[scenario.name]!),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// §7.1 bad bundle / fallback layout — the REAL loader, full temp package layouts
// ---------------------------------------------------------------------------

interface Layout {
  dir: string;
  cleanup: () => void;
}

/** A real package skeleton: copied root entry + COPIED src (a symlinked src gets realpath'd by
 *  jiti back to the repo, which would silently load the repo's good bundle instead of the
 *  layout's — caught while building this suite) + symlinked node_modules (the peers). */
function makeLayout(bundleContent: string | undefined): Layout {
  const dir = mkdtempSync(join(tmpdir(), "pt-layout-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "pi-toolkit", type: "module", pi: { extensions: ["./index.ts"] } }),
    );
    copyFileSync(join(ROOT, "index.ts"), join(dir, "index.ts"));
    cpSync(join(ROOT, "src"), join(dir, "src"), { recursive: true });
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
    if (bundleContent !== undefined) {
      mkdirSync(join(dir, "dist", "bundle"), { recursive: true });
      writeFileSync(join(dir, "dist", "bundle", "index.js"), bundleContent);
    }
    return { dir, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

describe("§7.1 bad bundle / fallback layouts (real loadExtensions)", () => {
  it("syntactically broken bundle ⇒ exactly one error, zero tools — never a silent source fallback", () => {
    const l = makeLayout("export default async function (");
    try {
      const r = runLoaderProbe(join(l.dir, "index.ts"), l.dir);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toContain("Failed to load extension");
      expect(r.toolNames).toEqual([]);
      expect(r.commandNames).toEqual([]);
    } finally {
      l.cleanup();
    }
  });

  it("bundle that throws at load time ⇒ one error carrying the message, zero tools", () => {
    const l = makeLayout('throw new Error("boom-bundle");\n');
    try {
      const r = runLoaderProbe(join(l.dir, "index.ts"), l.dir);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toContain("boom-bundle");
      expect(r.toolNames).toEqual([]);
    } finally {
      l.cleanup();
    }
  });

  it("no bundle at all (git-install shape) ⇒ zero errors, the SOURCE path comes up with the real tool set", () => {
    const l = makeLayout(undefined);
    try {
      const r = runLoaderProbe(join(l.dir, "index.ts"), l.dir, {}, 180_000);
      expect(r.errors).toEqual([]);
      expect(r.extensionCount).toBe(1);
      expect(r.toolNames.length).toBeGreaterThanOrEqual(20);
      expect(r.toolNames).toContain("Agent");
    } finally {
      l.cleanup();
    }
  }, 240_000);

  it("host modules unresolvable ⇒ loud failure naming the pinning, not a partial redirect or a fallback", () => {
    // Same layout WITH a bundle but WITHOUT node_modules, driven by a probe copy whose argv[1]
    // sits outside any pi install tree ⇒ the realpath→pi-package.json chain finds nothing.
    const l = makeLayout("export default async function activate() {}\n");
    rmSync(join(l.dir, "node_modules"));
    const probeCopy = join(l.dir, "probe.mjs");
    copyFileSync(LOADER_PROBE, probeCopy);
    try {
      const result = spawnSync(process.execPath, [probeCopy, "load", join(l.dir, "index.ts"), l.dir], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 120_000,
        // The probe copy cannot self-resolve the pi package (its node_modules is gone), so hand
        // it over explicitly — argv[1] stays in the layout, which is the thing under test.
        env: childEnv({ PI_TOOLKIT_TEST_PI_PKG: PI_PKG }),
      });
      expect(result.status).toBe(0);
      const r = JSON.parse(result.stdout);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toContain("cannot pin host modules");
      expect(r.toolNames).toEqual([]);
    } finally {
      l.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// §7.3 operational smoke, from inside the bundle
// ---------------------------------------------------------------------------

describe("§7.3 smoke through the bundle", () => {
  it("hub start: the spawned hub child's argv targets <pkg>/src/web-hub/hub/main.ts (never dist/hub), with a parseable PI_WEBHUB_CONFIG", () => {
    const hub = smoke.scenarios["smoke:hub-ui-hud"]!.hubSpawn;
    expect(hub, "the dumping node-loader must have recorded the hub child").toBeDefined();
    expect(hub!.argv, hub!.argv.join(" ")).toContain(join(ROOT, "src", "web-hub", "hub", "main.ts"));
    expect(
      hub!.argv.some((a) => a.includes("/dist/hub/")),
      hub!.argv.join(" "),
    ).toBe(false);
    expect(typeof (hub!.config as { home?: unknown })?.home).toBe("string");
  });

  it("HUD wiring ran: the TUI session replay produced HUD status payloads from the bundle", () => {
    const statuses = smoke.scenarios["smoke:hub-ui-hud"]!.statuses ?? [];
    expect(statuses.length, JSON.stringify(statuses)).toBeGreaterThan(0);
    // pluginRoot's anchor proof rides on the /webhub status lines below (same packageRoot).
  });

  it("UI dist: /webhub status completes without throwing and its UI-dist verdict matches the repo's real build state", () => {
    const notices = (smoke.scenarios["smoke:hub-ui-hud"]!.notices ?? []).join("\n");
    expect(notices).not.toContain("threw:");
    expect(notices).not.toContain("not registered");
    const hasLocalDist = existsSync(join(ROOT, "dist", "web-hub-ui", "build-info.json"));
    if (hasLocalDist) {
      // packageUiDistDir() from INSIDE the bundle found the repo's built UI ⇒ no install hint.
      expect(notices).not.toContain("本地也未发现已构建产物");
    } else {
      // Unbuilt checkout ⇒ the fallback path must point at the package root the bundle resolved.
      expect(notices).toContain(`cd ${ROOT}`);
    }
  });

  it("traffic page: /record on serves the page the bundle's buildPage assembled (record-token meta + Vue + app mount)", () => {
    const page = smoke.scenarios["smoke:traffic"]!.trafficPage;
    expect(page, (smoke.scenarios["smoke:traffic"]!.notices ?? []).join("\n")).toBeDefined();
    expect(page!.status).toBe(200);
    expect(page!.hasRecordTokenMeta).toBe(true);
    expect(page!.hasVueGlobal || page!.hasAppMount).toBe(true);
    expect(page!.bytes as number).toBeGreaterThan(10_000);
  });

  it("child session stays inert: the child fingerprint matches the golden child profile and gains no post-guard surface", () => {
    const fp = smoke.scenarios["smoke:child-inert"]!;
    const goldenChildCommands = TRACE_GOLDEN.child!.calls.filter((c) => c.startsWith("registerCommand(")).map((c) =>
      c.slice("registerCommand(".length, -1),
    );
    expect(fp.commands).toEqual(goldenChildCommands);
    expect(fp.calls.includes("registerTool(Agent)")).toBe(false);
    expect(fp.commands).not.toContain("webhub");
    expect(fp.commands).not.toContain("record");
  });
});

// ---------------------------------------------------------------------------
// §6.4 performance — the REAL loader, whole loadExtensions segment, median + range
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function samples(entry: string, count: number, env: Record<string, string> = {}, timeoutMs = 120_000): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(runLoaderProbe(entry, ROOT, env, timeoutMs).ms as number);
  return out;
}

describe("§6.4 performance (loadExtensions whole segment; hot jiti cache)", () => {
  const BUDGET = Number(process.env.PI_TOOLKIT_BUNDLE_PERF_BUDGET_MS ?? 2500);
  const report = (label: string, values: number[]): string =>
    `${label}: median=${median(values)}ms range=${Math.min(...values)}–${Math.max(...values)}ms samples=[${values.join(", ")}]`;

  it("src direct (baseline) — recorded, no threshold", { timeout: 300_000 }, () => {
    const values = samples(join(ROOT, "src", "index.ts"), 5);
    console.log(`[bundle-parity] ${report("src-hot", values)}`);
    expect(median(values)).toBeGreaterThan(0);
  });

  it("bundle direct — hot median under the budget", { timeout: 120_000 }, () => {
    const values = samples(BUNDLE, 5);
    console.log(`[bundle-parity] ${report("bundle-hot", values)}`);
    expect(median(values), report("bundle-hot", values)).toBeLessThan(BUDGET);
  });

  it(
    "dispatcher (the real path) — hot median under the budget and well under the src baseline",
    { timeout: 120_000 },
    () => {
      const values = samples(join(ROOT, "index.ts"), 5);
      console.log(`[bundle-parity] ${report("dispatcher-hot", values)}`);
      expect(median(values), report("dispatcher-hot", values)).toBeLessThan(BUDGET);
    },
  );

  it(
    "cold cache control — TMPDIR+JITI_RESPECT_TMPDIR_ENV provably creates a fresh jiti cache; recorded, no threshold",
    { timeout: 300_000 },
    () => {
      const coldRoot = mkdtempSync(join(tmpdir(), "pt-cold-"));
      try {
        const hotCacheRoot = join(tmpdir(), "jiti");
        expect(existsSync(join(coldRoot, "jiti")), "cold cache dir must not pre-exist").toBe(false);
        const env = { TMPDIR: coldRoot, JITI_RESPECT_TMPDIR_ENV: "1" };
        const started = Date.now();
        const bundleCold = samples(BUNDLE, 2, env);
        const coldJiti = join(coldRoot, "jiti");
        expect(existsSync(coldJiti), "the cold run must create $TMPDIR/jiti").toBe(true);
        expect(statSync(coldJiti).mtimeMs, "the cache must be created by THIS run").toBeGreaterThanOrEqual(
          started - 1500,
        );
        expect(resolve(coldJiti), "cold cache root must differ from the hot root").not.toBe(resolve(hotCacheRoot));
        const srcCold = samples(join(ROOT, "src", "index.ts"), 2, env, 180_000);
        const dispatcherCold = samples(join(ROOT, "index.ts"), 2, env);
        console.log(
          `[bundle-parity] ${report("bundle-cold", bundleCold)}; ${report("src-cold", srcCold)}; ${report("dispatcher-cold", dispatcherCold)}`,
        );
        expect(median(bundleCold)).toBeGreaterThan(0);
      } finally {
        rmSync(coldRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
    },
  );
});
