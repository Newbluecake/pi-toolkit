/** Approval-bound P50 probe contract. Default CLI is deliberately non-executable:
 * no credential loader, network, data creation or LIVE path is installed here.
 * A future approved host auth bridge must reuse pi's request-time credential path.
 * The controlled runner seam is exercised OFFLINE with the real wire/SDK and fake HTTP. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
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
  readonly routes: readonly {
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
  const m = JSON.parse(bytes) as ClosureManifest;
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
      (i < 3 && !/^[a-f0-9]{64}$/.test(r.payloadSha256 ?? ""))
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
          (payload as { model?: unknown }).model !== r.model
        )
          throw Error(stage === "C1" ? "C_ENVELOPE" : "PAYLOAD_MISMATCH");
        events.push({ stage, estimatedInputTokens: estimated, payloadSha256: digest, serverEnforced: false });
      } catch (error) {
        stopped = true;
        throw error;
      }
    },
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
// Default CLI refuses before creating any data; manifest approval alone does not
// supply authentication. No dynamic imports/eval, key-file reads or network fallback.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  try {
    if (args.length !== 4 || args[0] !== "--manifest" || args[2] !== "--confirm-approved-manifest-sha256")
      throw Error("APPROVAL_REQUIRED");
    const file = args[1]!;
    if (lstatSync(file).size > 65536) throw Error("MANIFEST_BOUNDS");
    await runApprovedClosureProbe(readFileSync(file, "utf8"), args[3]);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 2;
  }
}
