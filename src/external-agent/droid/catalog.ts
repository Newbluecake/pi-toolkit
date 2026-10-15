/**
 * droid 模型目录探测侧（plan §4.7）：ExternalCatalogPort 实现。
 *
 * 缓存读走注入的 CatalogStore（P2）；探测 = 起一个短命 droid RPC 进程（同样带
 * DROID_CHILD_ENV）→ initialize_session（cwd 固定 probeCwd，S4：只 init 也会落一个空会话
 * 文件，固定 slug 归档）→ 读 availableModels → close_session → terminate("graceful")。
 * single-flight、DROID_CATALOG_PROBE_TIMEOUT_MS 有界、计时器 unref（经注入 clock）、失败静默
 * 保留旧缓存。探测发现漂移 ⇒ catalog.drift（strict 下的 unavailableReason 由 P5 port 判定）。
 */
import { mkdirSync, realpathSync, statSync } from "node:fs";
import type { DroidAgentSettings } from "../../config/settings.js";
import { ClassifiedError } from "../../core/errors.js";
import type { ExternalCatalog, ExternalCatalogPort, ExternalFrameworkDeps, ExternalModelInfo } from "../types.js";
import { probeCwd } from "../paths.js";
import { createDroidEnvelope } from "./envelope.js";
import {
  DROID_CATALOG_PROBE_TIMEOUT_MS,
  DROID_CHILD_ENV,
  DROID_EXEC_ARGS,
  DROID_EXITS_ON_STDIN_EOF,
  DROID_METHODS,
} from "./protocol.js";
import { buildInitParams } from "./settings.js";

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** availableModels[] → ExternalModelInfo[]（畸形条目跳过；唯一权威表，U4）。 */
export function parseAvailableModels(raw: unknown): ExternalModelInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: ExternalModelInfo[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = str(e.id);
    if (id === undefined) continue;
    const displayName = str(e.displayName);
    const upstreamProvider = str(e.modelProvider);
    const kind = str(e.kind);
    const defaultEffort = str(e.defaultReasoningEffort);
    out.push({
      id,
      ...(displayName === undefined ? {} : { displayName }),
      ...(upstreamProvider === undefined ? {} : { upstreamProvider }),
      ...(kind === undefined ? {} : { kind }),
      ...(typeof e.tokenMultiplier === "number" && Number.isFinite(e.tokenMultiplier)
        ? { tokenMultiplier: e.tokenMultiplier }
        : {}),
      reasoningEfforts: Array.isArray(e.supportedReasoningEfforts)
        ? e.supportedReasoningEfforts.filter((x): x is string => typeof x === "string")
        : [],
      ...(defaultEffort === undefined ? {} : { defaultEffort }),
      deprecated: e.deprecated === true,
    });
  }
  return out;
}

/** realpath|size|mtimeMs|ino（arch §5.1 二进制指纹；任何一步失败 ⇒ undefined）。 */
export function binaryFingerprint(binary: string): string | undefined {
  try {
    const real = realpathSync(binary);
    const st = statSync(real);
    return `${real}|${st.size}|${st.mtimeMs}|${st.ino}`;
  } catch {
    return undefined;
  }
}

export interface DroidCatalog extends ExternalCatalogPort {
  dispose(): void;
}

export function createDroidCatalog(deps: ExternalFrameworkDeps, settings: () => DroidAgentSettings): DroidCatalog {
  let memory: ExternalCatalog | undefined;
  let inFlight = false;
  let disposed = false;
  let probeKill: (() => void) | undefined;

  const storeRead = (): ExternalCatalog | undefined => {
    try {
      return deps.catalogStore.read("droid");
    } catch {
      return undefined;
    }
  };

  const probe = (): void => {
    const s = settings();
    let child;
    try {
      mkdirSync(probeCwd(deps.agentDir), { recursive: true, mode: 0o700 });
      child = deps.spawnChild({
        binary: s.binary,
        args: DROID_EXEC_ARGS,
        cwd: probeCwd(deps.agentDir),
        extraEnv: DROID_CHILD_ENV,
        killGraceMs: s.killGraceMs,
        ownerWatchdog: !DROID_EXITS_ON_STDIN_EOF,
        clock: deps.clock,
      });
    } catch {
      inFlight = false; // ENOENT 等：失败静默（warnOnce 由 P5 port 的 unavailableReason 路径负责）
      return;
    }
    probeKill = () => child.terminate("now");
    const envelope = createDroidEnvelope();
    let drift: { expected: string; actual: string } | undefined;
    const rpc = deps.createRpc({
      envelope,
      write: (line) => child.write(line),
      onNotification: () => {},
      onRequest: () => ({ error: { code: -32601, message: "not supported by pi-toolkit host" } }),
      onDrift: (d) => {
        drift = d;
      },
      onProtocolError: () => {},
      clock: deps.clock,
    });
    child.onStdout((chunk) => rpc.feed(chunk));
    const deadline = deps.clock.setTimer(DROID_CATALOG_PROBE_TIMEOUT_MS, () => {
      try {
        rpc.failAll(
          new ClassifiedError({ kind: "internal", message: "droid catalog probe timed out", retryable: false }),
        );
      } finally {
        child.terminate("now");
      }
    });
    // 探测用模型：设置里显式列的第一个 ⇒ 现有目录第一个非 deprecated ⇒ "auto"（init 对无效
    // modelId 静默回落，S5，探测不会因模型名失败）。
    const probeModel =
      s.models[0] ??
      memory?.models.find((m) => !m.deprecated)?.id ??
      storeRead()?.models.find((m) => !m.deprecated)?.id ??
      "auto";
    void (async () => {
      try {
        const result = await rpc.request<Record<string, unknown>>(
          DROID_METHODS.initializeSession,
          buildInitParams({ cwd: probeCwd(deps.agentDir), modelId: probeModel }),
          s.initTimeoutMs,
        );
        const models = parseAvailableModels(result?.availableModels);
        const protocolVersion = envelope.lastSeenProtocolVersion();
        const fingerprint = binaryFingerprint(s.binary);
        const catalog: ExternalCatalog = {
          provider: "droid",
          fetchedAt: deps.clock.now(),
          ...(protocolVersion === undefined ? {} : { protocolVersion }),
          ...(fingerprint === undefined ? {} : { binaryFingerprint: fingerprint }),
          models,
          ...(drift === undefined ? {} : { drift }),
        };
        memory = catalog;
        try {
          deps.catalogStore.write(catalog);
        } catch {
          /* 失败静默 */
        }
        try {
          await rpc.request(DROID_METHODS.closeSession, {}, s.requestTimeoutMs);
        } catch {
          /* best-effort */
        }
      } catch {
        /* 失败静默：保留旧缓存 */
      } finally {
        deps.clock.clearTimer(deadline);
        child.terminate("graceful");
        inFlight = false;
        probeKill = undefined;
      }
    })();
  };

  return {
    snapshot() {
      if (memory === undefined) memory = storeRead();
      return memory;
    },
    refreshInBackground() {
      if (disposed || inFlight) return;
      inFlight = true;
      probe();
    },
    observeInit(models: unknown, protocolVersion: string | undefined) {
      const parsed = parseAvailableModels(models);
      if (parsed.length === 0) return;
      const prev = memory ?? storeRead();
      const catalog: ExternalCatalog = {
        provider: "droid",
        fetchedAt: deps.clock.now(),
        ...(protocolVersion === undefined
          ? prev?.protocolVersion === undefined
            ? {}
            : { protocolVersion: prev.protocolVersion }
          : { protocolVersion }),
        ...(prev?.agentVersion === undefined ? {} : { agentVersion: prev.agentVersion }),
        ...(prev?.binaryFingerprint === undefined ? {} : { binaryFingerprint: prev.binaryFingerprint }),
        models: parsed,
        ...(prev?.drift === undefined ? {} : { drift: prev.drift }),
      };
      memory = catalog;
      try {
        deps.catalogStore.write(catalog);
      } catch {
        /* 失败静默 */
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      probeKill?.(); // 停探测；不杀运行中的 run（provider.dispose 也不管 run）
      probeKill = undefined;
    },
  };
}

/** update -32602 "Unknown model" 的拒绝文案（§4.4 step 2：error 文本含 model ⇒ config + 目录候选）。
 *  `allowed` 非空（白名单模式，2026-10-16 拍板）且目录缺席 ⇒ 不再说「any droid model id is
 *  accepted」——准入届时也只放行名单内 id（名单判定不依赖目录）。 */
export function unknownDroidModelMessage(
  modelId: string,
  catalog: ExternalCatalog | undefined,
  allowed?: readonly string[],
): string {
  const candidates = catalog?.models.filter((m) => !m.deprecated).map((m) => m.id) ?? [];
  const listed = candidates.slice(0, 12).join(", ");
  const suffix =
    candidates.length === 0
      ? allowed !== undefined && allowed.length > 0
        ? "model catalog unavailable — only the model ids in externalAgents.droid.models are accepted"
        : "model catalog unavailable — any droid model id is accepted; see `droid exec --help`"
      : `known droid models: ${listed}${candidates.length > 12 ? `, … +${candidates.length - 12} more` : ""}`;
  return `unknown droid model "${modelId}" (droid.update_session_settings rejected it): ${suffix}`;
}
