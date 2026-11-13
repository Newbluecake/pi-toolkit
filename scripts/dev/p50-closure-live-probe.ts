/** Approval-bound P50 probe. --print-manifest is offline; provider execution
 * requires --live AND an unchanged SHA-approved manifest. Never run LIVE without
 * separate human approval. Authentication is delegated to the public pi SDK. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir, homedir } from "node:os";
import {
  buildClosureManifest,
  payloadTemplateHash,
  requireQuote,
  openProbeCatalog,
  requireProbeAuth,
  ProbeRegistry,
  runClosureHost,
} from "./p50-closure-runtime.js";
import { estimatePayload, STOCK_ESTIMATE_PROFILE } from "../../src/memory/jev/p50-estimate.js";
import { memoryDirFor } from "../../src/memory/paths.js";

export type ProbeStage = "R1" | "R2" | "G1" | "C1";
export interface ClosureManifest {
  readonly contract: "p50-stock-estimate-suggest-only-v1";
  readonly root: string;
  readonly paths: {
    readonly home: string;
    readonly cache: string;
    readonly tmp: string;
    readonly config: string;
    readonly agent: string;
    readonly cwd: string;
    readonly memory: string;
    readonly ccProjects: string;
  };
  readonly maxAttempts: 4;
  readonly budgetUsd: number;
  readonly plannedReserveUsd: number;
  readonly cEnvelopeEstimatedInputTokens: number;
  readonly approval?: Readonly<Record<string, unknown>>;
  readonly routes: readonly {
    readonly provider?: string;
    readonly route?: string;
    readonly api?: string;
    readonly priceSource?: string;
    readonly priceSnapshotSha256?: string;
    readonly payload?: Readonly<Record<string, unknown>>;
    readonly payloadTemplateSha256?: string;
    readonly stage: ProbeStage;
    readonly endpoint: string;
    readonly model: string;
    readonly estimatedInputTokens: number;
    readonly outputAllowance: number;
    readonly inputUsdPerMillion: number;
    readonly outputUsdPerMillion: number;
    readonly payloadSha256?: string;
  }[];
}
export const manifestSha256 = (bytes: string): string => createHash("sha256").update(bytes).digest("hex");
const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
function physical(path: string): string {
  let parent = path;
  const suffix: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(parent), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(parent) === parent)
        throw Error("ISOLATION_UNAVAILABLE");
      suffix.unshift(relative(dirname(parent), parent));
      parent = dirname(parent);
    }
  }
}
/** Read-only validation, including physical resolution, BEFORE runner/data creation.
 * Inherited ARMORY_MEMORY_ROOT/CC_PROJECTS_ROOT never survive the environment plan. */
export function validateClosureManifest(
  bytes: string,
  approvedHash: string | undefined,
  inherited: NodeJS.ProcessEnv = process.env,
) {
  if (!approvedHash || !/^[a-f0-9]{64}$/.test(approvedHash) || manifestSha256(bytes) !== approvedHash)
    throw Error("APPROVAL_HASH_MISMATCH");
  if (Buffer.byteLength(bytes) > 65536) throw Error("MANIFEST_BOUNDS");
  let m: ClosureManifest;
  try {
    m = JSON.parse(bytes) as ClosureManifest;
  } catch {
    throw Error("MANIFEST_CONTRACT");
  }
  requireQuote(m);
  if (
    m.contract !== "p50-stock-estimate-suggest-only-v1" ||
    m.maxAttempts !== 4 ||
    !Number.isFinite(m.budgetUsd) ||
    m.budgetUsd <= 0 ||
    m.budgetUsd > 1 ||
    !Number.isFinite(m.plannedReserveUsd) ||
    m.plannedReserveUsd <= 0 ||
    m.plannedReserveUsd > 0.01 ||
    m.plannedReserveUsd > m.budgetUsd ||
    !Number.isSafeInteger(m.cEnvelopeEstimatedInputTokens) ||
    m.cEnvelopeEstimatedInputTokens <= 0
  )
    throw Error("MANIFEST_CONTRACT");
  if (!isAbsolute(m.root) || resolve(m.root) !== m.root || physical(m.root) !== m.root) throw Error("ISOLATION_ROOT");
  const rootStat = lstatSync(m.root);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    (rootStat.mode & 0o777) !== 0o700 ||
    rootStat.uid !== process.getuid?.()
  )
    throw Error("ISOLATION_ROOT");
  const keys = ["home", "cache", "tmp", "config", "agent", "cwd", "memory", "ccProjects"] as const;
  if (
    !m.paths ||
    keys.some(
      (k) =>
        typeof m.paths[k] !== "string" ||
        !isAbsolute(m.paths[k]) ||
        !inside(m.root, resolve(m.paths[k])) ||
        !inside(m.root, physical(resolve(m.paths[k]))),
    )
  )
    throw Error("ISOLATION_ESCAPE");
  const env = {
    HOME: m.paths.home,
    USERPROFILE: m.paths.home,
    XDG_CONFIG_HOME: m.paths.config,
    XDG_CACHE_HOME: m.paths.cache,
    TMPDIR: m.paths.tmp,
    PI_CODING_AGENT_DIR: m.paths.agent,
    ARMORY_MEMORY_ROOT: m.paths.memory,
    CC_PROJECTS_ROOT: m.paths.ccProjects,
    NODE_OPTIONS: "",
    PI_OFFLINE: "1",
  };
  // No secure/child bypass. A live bridge must be separately approved in plain main.
  if (Object.keys(inherited).some((k) => k.startsWith("PI_SECURE_") && inherited[k])) throw Error("SECURE_UNAVAILABLE");
  const memoryDir = memoryDirFor(m.paths.cwd, {
    memoryRoot: env.ARMORY_MEMORY_ROOT,
    ccProjectsRoot: env.CC_PROJECTS_ROOT,
  });
  if (!inside(m.root, physical(memoryDir))) throw Error("ISOLATION_ESCAPE");
  const stages: ProbeStage[] = ["R1", "R2", "G1", "C1"];
  if (!Array.isArray(m.routes) || m.routes.length !== 4) throw Error("MANIFEST_ROUTES");
  let quote = 0;
  for (let i = 0; i < 4; i++) {
    const r = m.routes[i]!;
    const url = new URL(r.endpoint);
    if (
      r.stage !== stages[i] ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !r.model ||
      !Number.isSafeInteger(r.estimatedInputTokens) ||
      r.estimatedInputTokens <= 0 ||
      r.outputAllowance !== (i < 2 ? 128 : 384) ||
      ![r.inputUsdPerMillion, r.outputUsdPerMillion].every((n) => Number.isFinite(n) && n >= 0) ||
      (i < 3 && !/^[a-f0-9]{64}$/.test(r.payloadSha256 ?? r.payloadTemplateSha256 ?? ""))
    )
      throw Error("MANIFEST_ROUTE");
    if (i === 3 && r.estimatedInputTokens !== m.cEnvelopeEstimatedInputTokens) throw Error("C_ENVELOPE");
    quote += (r.estimatedInputTokens * r.inputUsdPerMillion + r.outputAllowance * r.outputUsdPerMillion) / 1e6;
  }
  if (quote > m.plannedReserveUsd + 1e-12) throw Error("QUOTE_EXCEEDS_APPROVAL");
  const freeze = (value: unknown): void => {
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  };
  freeze(m);
  Object.freeze(env);
  return Object.freeze({ manifest: m, environment: env, memoryDir });
}
export interface ClosureProbeEffect {
  readonly suggestions: number;
  readonly autoEligible: boolean;
  readonly automaticCommitCalls: number;
  readonly targetRawUnchanged: boolean;
  readonly contextRawUnchanged: boolean;
  readonly auditState: string;
}
export interface ClosureRunnerContext {
  readonly isolation: ReturnType<typeof validateClosureManifest>;
  /** Install at the existing SDK fetch injection boundary; never issue HTTP here. */
  beforeHttp(stage: ProbeStage, endpoint: string, payload: unknown): void;
}
export async function runApprovedClosureProbe(
  bytes: string,
  hash: string | undefined,
  runner?: (context: ClosureRunnerContext) => Promise<ClosureProbeEffect>,
) {
  const isolation = validateClosureManifest(bytes, hash);
  if (!runner) throw Error("AUTH_UNAVAILABLE");
  const events: { stage: ProbeStage; estimatedInputTokens: number; payloadSha256: string; serverEnforced: false }[] =
    [];
  let stopped = false;
  const effect = await runner({
    isolation,
    beforeHttp(stage, endpoint, payload) {
      if (stopped) throw Error("PROBE_STOPPED");
      try {
        const r = isolation.manifest.routes[events.length];
        if (!r || r.stage !== stage || r.endpoint !== endpoint) throw Error("EXTRA_OR_UNAPPROVED_REQUEST");
        const estimated = estimatePayload(payload);
        if (estimated === undefined) throw Error("PAYLOAD_DATA");
        const digest = manifestSha256(JSON.stringify(payload));
        if (
          estimated > r.estimatedInputTokens ||
          (r.payloadSha256 !== undefined && digest !== r.payloadSha256) ||
          (r.payloadTemplateSha256 !== undefined &&
            payloadTemplateHash(payload as Record<string, unknown>) !== r.payloadTemplateSha256) ||
          (payload as { model?: unknown }).model !== r.model
        )
          throw Error(stage === "C1" ? "C_ENVELOPE" : "PAYLOAD_MISMATCH");
        events.push({ stage, estimatedInputTokens: estimated, payloadSha256: digest, serverEnforced: false });
      } catch (error) {
        stopped = true;
        throw error;
      }
    },
  }).catch((error: unknown) => {
    const code = error instanceof Error ? error.message : "";
    throw Error(
      ["PROBE_STOPPED", "EXTRA_OR_UNAPPROVED_REQUEST", "PAYLOAD_DATA", "PAYLOAD_MISMATCH", "C_ENVELOPE"].includes(code)
        ? code
        : "INCOMPLETE_CLOSURE",
    );
  });
  if (
    stopped ||
    events.length !== 4 ||
    effect.suggestions !== 1 ||
    effect.autoEligible ||
    effect.automaticCommitCalls !== 0 ||
    !effect.targetRawUnchanged ||
    !effect.contextRawUnchanged ||
    effect.auditState !== "prepared"
  )
    throw Error("INCOMPLETE_CLOSURE");
  return { verdict: "PASS" as const, assurance: STOCK_ESTIMATE_PROFILE, events, effect, live: "NOT_RUN" as const };
}
export const closureManifestBytes = (manifest: ClosureManifest): string => JSON.stringify(manifest, null, 2) + "\n";
/** Fixed-code errors only: never serialize an SDK error, stack, cause, request,
 * response, auth result, headers or model descriptor. Also used by tests. */
export function probeErrorCode(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  return new Set([
    "APPROVAL_REQUIRED",
    "APPROVAL_HASH_MISMATCH",
    "AUTH_UNAVAILABLE",
    "MANIFEST_BOUNDS",
    "MANIFEST_CONTRACT",
    "MANIFEST_ROUTES",
    "MANIFEST_ROUTE",
    "MANIFEST_CHANGED",
    "ROUTE_UNAVAILABLE",
    "QUOTE_UNAVAILABLE",
    "PROXY_UNAVAILABLE",
    "RESERVATION_LIMIT",
    "LIST_TARGET_EXCEEDED",
    "ISOLATION_ROOT",
    "ISOLATION_ESCAPE",
    "ISOLATION_UNAVAILABLE",
    "SECURE_UNAVAILABLE",
    "INCOMPLETE_CLOSURE",
  ]).has(code)
    ? code
    : "PROBE_FAILED";
}
export async function probeMain(
  args: readonly string[],
  ports = { open: openProbeCatalog, auth: requireProbeAuth, run: runClosureHost },
) {
  try {
    if (Object.keys(process.env).some((k) => k.startsWith("PI_SECURE_") && process.env[k]))
      throw Error("SECURE_UNAVAILABLE");
    const flag = (name: string) => args.includes(name);
    const value = (name: string) => {
      const i = args.indexOf(name);
      return i < 0 ? undefined : args[i + 1];
    };
    // No implicit legacy LIVE path, and no auth/catalog work without one mode.
    if (flag("--live") === flag("--print-manifest")) throw Error("APPROVAL_REQUIRED");
    const allowed = new Set(["--live", "--print-manifest", "--manifest", "--manifest-sha", "--root", "--agent-dir"]);
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (!allowed.has(arg) || args.indexOf(arg) !== i) throw Error("APPROVAL_REQUIRED");
      if (arg !== "--live" && arg !== "--print-manifest" && (!args[++i] || args[i]!.startsWith("--")))
        throw Error("APPROVAL_REQUIRED");
    }
    const agentDir = resolve(value("--agent-dir") ?? process.env.PI_CODING_AGENT_DIR ?? joinAgentHome());
    if (flag("--print-manifest")) {
      if (flag("--manifest") || flag("--manifest-sha")) throw Error("APPROVAL_REQUIRED");
      const catalog = await ports.open(agentDir, false);
      const manifest = buildClosureManifest(
        catalog.settings,
        catalog.registry,
        value("--root") ?? resolve(tmpdir(), `p50-live-${process.getuid?.() ?? "user"}`),
      );
      requireQuote(manifest);
      return {
        code: 0,
        output:
          JSON.stringify(
            { manifest, manifestSha256: manifestSha256(closureManifestBytes(manifest)), live: "NOT_RUN" },
            null,
            2,
          ) + "\n",
      };
    }
    if (!value("--manifest") || !value("--manifest-sha") || flag("--root")) throw Error("APPROVAL_REQUIRED");
    const file = value("--manifest")!;
    if (lstatSync(file).size > 65536) throw Error("MANIFEST_BOUNDS");
    const approved = JSON.parse(readFileSync(file, "utf8")) as { manifest: ClosureManifest };
    const bytes = closureManifestBytes(approved.manifest);
    validateClosureManifest(bytes, value("--manifest-sha"));
    const catalog = await ports.open(agentDir, true);
    const current = buildClosureManifest(catalog.settings, catalog.registry, approved.manifest.root);
    if (closureManifestBytes(current) !== bytes) throw Error("MANIFEST_CHANGED");
    if (catalog.settings.jev.proxy) throw Error("PROXY_UNAVAILABLE");
    await ports.auth(catalog.runtime, catalog.registry, current);
    const result = await runApprovedClosureProbe(bytes, value("--manifest-sha"), async (context) => {
      const registry = new ProbeRegistry(catalog.runtime, context.beforeHttp);
      return ports.run(context, registry, catalog.settings);
    });
    return { code: 0, output: JSON.stringify({ ...result, live: "RUN" }) + "\n" };
  } catch (error) {
    return { code: 2, output: probeErrorCode(error) + "\n" };
  }
}
function joinAgentHome() {
  return resolve(homedir(), ".pi/agent");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await probeMain(process.argv.slice(2));
  (result.code ? process.stderr : process.stdout).write(result.output);
  process.exitCode = result.code;
}
