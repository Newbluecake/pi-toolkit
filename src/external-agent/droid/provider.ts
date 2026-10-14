/**
 * droid provider（plan §4.4/§4.7）：create/resume 的进程 + init + 无条件 update + 生效值校验。
 *
 * 流程（create 与 resume 共用，resume 多头行钉 cwd 与 sessionId 续跑）：
 *   spawn（DROID_CHILD_ENV）→ initialize_session（initTimeoutMs）→ observeInit 喂目录 →
 *   update_session_settings（无条件，S5：init 静默吞无效 modelId，update 干净拒绝；
 *   resume 还解决「持久化设置覆盖 init 参数」坑）→ 生效值比对（全量 settings echo，
 *   fail closed）→ openTranscript → DroidSessionHandle。
 * 校验通过前绝不发 add_user_message（prompt 由 runner 随后调用）。
 */
import { realpathSync, statSync } from "node:fs";
import { ClassifiedError, classifiedInfo } from "../../core/errors.js";
import type { DroidAgentSettings } from "../../config/settings.js";
import { msgBinaryNotFound, msgProtocolDrift, msgResumeCwdGone } from "../messages.js";
import { externalSessionPath, isExternalSessionPath } from "../paths.js";
import type {
  ExternalAgentProvider,
  ExternalFrameworkDeps,
  ExternalSessionHandle,
  ExternalSessionSpec,
  ManagedChild,
  TranscriptWriter,
} from "../types.js";
import { createDroidCatalog, unknownDroidModelMessage, type DroidCatalog } from "./catalog.js";
import { createDroidEnvelope } from "./envelope.js";
import {
  DROID_CHILD_ENV,
  DROID_CUMULATIVE_INCLUDES_CHILD,
  DROID_EXITS_ON_STDIN_EOF,
  DROID_EXEC_ARGS,
  DROID_METHODS,
  DROID_RESUME_CUSTOM_TYPE,
  DROID_THINKING_IN_OUTPUT,
  DROID_UNSUPPORTED_REQUEST_REPLY,
} from "./protocol.js";
import { createDroidSession, type DroidRpcHandlers, type DroidRpcHandlersRef } from "./session.js";
import {
  buildInitParams,
  buildUpdateSettingsParams,
  extractSettingsEcho,
  isFullSettingsEcho,
  mapThinkingToEffort,
  verifyEffectiveSettings,
  type DroidSettingsEcho,
} from "./settings.js";

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** spawn 失败的归类（主会话补充裁定）：runner 目前没有 create() 重试循环（P1 验收确认），
 *  所以适配器**不得**抛 ClassifiedError{kind:"startup_transient"}——其 retryable 语义无人消费，
 *  EAGAIN/EMFILE 等启动失败一律归为 internal；ENOENT（config）换成带 binary 路径的明确文案。 */
function reclassifySpawnError(e: unknown, binary: string): ClassifiedError {
  const info = classifiedInfo(e);
  if (info === undefined)
    return new ClassifiedError({
      kind: "internal",
      message: e instanceof Error ? e.message : String(e),
      retryable: false,
    });
  if (info.kind === "startup_transient")
    return new ClassifiedError({ kind: "internal", message: info.message, retryable: false });
  if (info.kind === "config")
    // spawn 契约里唯一的 config 案例就是 ENOENT（binary 找不到）。
    return new ClassifiedError({ kind: "config", message: msgBinaryNotFound(binary), retryable: false });
  return new ClassifiedError(info);
}

function asClassified(e: unknown, redact: (t: string) => string): ClassifiedError {
  if (e instanceof ClassifiedError) return e;
  const info = classifiedInfo(e);
  if (info !== undefined) return new ClassifiedError(info);
  return new ClassifiedError({
    kind: "internal",
    message: redact(e instanceof Error ? e.message : String(e)),
    retryable: false,
  });
}

export function createDroidProvider(
  deps: ExternalFrameworkDeps,
  settings: () => DroidAgentSettings,
): ExternalAgentProvider {
  const catalog: DroidCatalog = createDroidCatalog(deps, settings);
  let disposed = false;

  const ownsSessionFile = (path: string): boolean => {
    if (!isExternalSessionPath(path, deps.agentDir)) return false;
    try {
      return deps.readTranscriptHeader(path)?.provider === "droid";
    } catch {
      return false;
    }
  };

  const startSession = async (
    spec: ExternalSessionSpec,
    o: { resume: boolean; sessionFile?: string },
  ): Promise<ExternalSessionHandle> => {
    const s = settings();
    const ext = spec.external;
    if (ext.provider !== "droid")
      throw new ClassifiedError({
        kind: "config",
        message: `droid provider cannot run provider "${ext.provider}"`,
        retryable: false,
      });

    // ── cwd（§4.4）：create = realpath(spec.cwd)；resume = 头行 cwd（钉死，禁止回落 spec.cwd）。 ──
    let cwd: string;
    let resumeSessionId: string | undefined;
    if (o.resume) {
      const header = deps.readTranscriptHeader(o.sessionFile!);
      if (header === undefined || header.provider !== "droid")
        throw new ClassifiedError({
          kind: "config",
          message: "not a droid external-agent session file",
          retryable: false,
        });
      cwd = header.cwd;
      try {
        if (!statSync(cwd).isDirectory()) throw new Error("not a directory");
      } catch {
        throw new ClassifiedError({ kind: "config", message: msgResumeCwdGone(cwd), retryable: false });
      }
      resumeSessionId = header.sessionId;
    } else {
      const raw = str(spec.cwd) ?? process.cwd();
      try {
        cwd = realpathSync(raw);
      } catch {
        throw new ClassifiedError({
          kind: "config",
          message: `working directory does not exist: ${raw}`,
          retryable: false,
        });
      }
    }

    // thinking → reasoningEffort（arch §8.3；目录缺失时透传合法档位名）。
    const info = catalog.snapshot()?.models.find((m) => m.id === ext.modelId);
    const effort = mapThinkingToEffort(ext.thinkingLevel, info?.reasoningEfforts, info?.defaultEffort);

    // ── spawn ──
    let child: ManagedChild;
    try {
      child = deps.spawnChild({
        binary: s.binary,
        args: DROID_EXEC_ARGS,
        cwd,
        extraEnv: DROID_CHILD_ENV,
        killGraceMs: s.killGraceMs,
        ownerWatchdog: !DROID_EXITS_ON_STDIN_EOF,
        clock: deps.clock,
      });
    } catch (e) {
      throw reclassifySpawnError(e, s.binary);
    }

    // ── RPC（provider 阶段回调：收 settings echo、缓冲其余通知、记录协议致命） ──
    const envelope = createDroidEnvelope();
    const bufferedNotifications: { method: string; params: unknown }[] = [];
    let setupFailure: ClassifiedError | undefined;
    let protocolDriftWarned = false;
    let lastFullEcho: DroidSettingsEcho | undefined;
    let fullEchoCount = 0;
    const echoWaiters = new Set<() => void>();
    const handlersRef: DroidRpcHandlersRef = {
      current: {
        onNotification: (method, params) => {
          if (method === DROID_METHODS.sessionNotification) {
            const notif =
              params !== null && typeof params === "object"
                ? (params as Record<string, unknown>).notification
                : undefined;
            if (notif !== null && typeof notif === "object") {
              const n = notif as Record<string, unknown>;
              if (n.type === "settings_updated") {
                const echo = extractSettingsEcho(n.settings);
                if (isFullSettingsEcho(echo)) {
                  lastFullEcho = echo;
                  fullEchoCount++;
                  for (const w of [...echoWaiters]) w();
                  echoWaiters.clear();
                }
              }
            }
          }
          bufferedNotifications.push({ method, params });
        },
        // init/update 阶段的反向请求（不该出现；S2 防御）：一律 -32601，绝不悬挂。
        onRequest: () => ({ error: { ...DROID_UNSUPPORTED_REQUEST_REPLY } }),
        onDrift: (d) => {
          const agentVersion = catalog.snapshot()?.agentVersion;
          if (s.protocolCheck === "strict")
            setupFailure ??= new ClassifiedError({
              kind: "config",
              message: msgProtocolDrift(d.actual, d.expected, agentVersion),
              retryable: false,
            });
          else {
            protocolDriftWarned = true;
            deps.warnOnce("droid-protocol-drift", msgProtocolDrift(d.actual, d.expected, agentVersion));
          }
        },
        onProtocolError: (e) => {
          setupFailure ??= e;
        },
      } satisfies DroidRpcHandlers,
    };
    const rpc = deps.createRpc({
      envelope,
      write: (line) => child.write(line),
      onNotification: (m, p) => handlersRef.current.onNotification(m, p),
      onRequest: (m, id, p) => handlersRef.current.onRequest(m, id, p),
      onDrift: (d) => handlersRef.current.onDrift(d),
      onProtocolError: (e) => handlersRef.current.onProtocolError(e),
      clock: deps.clock,
    });
    child.onStdout((chunk) => {
      try {
        rpc.feed(chunk);
      } catch {
        /* client 内部已按协议错误收口 */
      }
    });
    const failSpawned = (e: unknown): never => {
      child.terminate("now");
      throw asClassified(e, deps.redact);
    };

    // ── init → observeInit → update → 生效值比对 ──
    let sessionId: string;
    try {
      const initResult = await rpc.request<Record<string, unknown>>(
        DROID_METHODS.initializeSession,
        buildInitParams({
          cwd,
          modelId: ext.modelId,
          ...(effort === undefined ? {} : { reasoningEffort: effort }),
          ...(resumeSessionId === undefined ? {} : { sessionId: resumeSessionId }),
        }),
        s.initTimeoutMs,
      );
      if (setupFailure !== undefined) throw setupFailure;
      sessionId = str(initResult?.sessionId) ?? "";
      if (sessionId.length === 0)
        throw new ClassifiedError({
          kind: "config",
          message: "droid initialize_session returned no sessionId (protocol drift?)",
          retryable: false,
        });
      const initEcho = extractSettingsEcho(initResult);
      if (isFullSettingsEcho(initEcho)) lastFullEcho = initEcho;
      catalog.observeInit(initResult?.availableModels, envelope.lastSeenProtocolVersion());

      const preUpdateEchoCount = fullEchoCount;
      try {
        await rpc.request(
          DROID_METHODS.updateSessionSettings,
          buildUpdateSettingsParams({
            modelId: ext.modelId,
            ...(effort === undefined ? {} : { reasoningEffort: effort }),
          }),
          s.requestTimeoutMs,
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (/unknown model/i.test(message))
          // S5：update 干净拒绝 -32602 "Unknown model: …" ⇒ config + 目录候选；add_user_message 从未发出。
          throw new ClassifiedError({
            kind: "config",
            message: unknownDroidModelMessage(ext.modelId, catalog.snapshot()),
            retryable: false,
          });
        throw e;
      }
      if (setupFailure !== undefined) throw setupFailure;
      // 生效值来源：update 成功响应是 `{}`（S/47 实测），等 update 后的全量 settings_updated
      // echo（有界；超时回落最新 echo——create 时即 init result.settings）。
      if (fullEchoCount === preUpdateEchoCount)
        await new Promise<void>((resolve) => {
          const timer = deps.clock.setTimer(s.requestTimeoutMs, () => {
            echoWaiters.delete(cb);
            resolve();
          });
          const cb = (): void => {
            deps.clock.clearTimer(timer);
            resolve();
          };
          echoWaiters.add(cb);
        });
      const mismatch = verifyEffectiveSettings(lastFullEcho, { modelId: ext.modelId });
      if (mismatch !== undefined)
        throw new ClassifiedError({
          kind: "config",
          message: `droid effective-settings mismatch: ${mismatch}`,
          retryable: false,
        });
      if (setupFailure !== undefined) throw setupFailure;
    } catch (e) {
      failSpawned(e);
    }

    // ── transcript（§4.6；persistTranscript:false ⇒ 不建文件、sessionFile=undefined） ──
    let transcript: TranscriptWriter | undefined;
    if (ext.persistTranscript) {
      try {
        transcript = o.resume
          ? deps.openTranscript({ path: o.sessionFile!, resume: true })
          : deps.openTranscript({
              path: externalSessionPath(deps.agentDir, "droid", sessionId!),
              header: {
                type: "external_session",
                version: 1,
                provider: "droid",
                sessionId: sessionId!,
                cwd,
                modelId: ext.modelId,
                createdAt: new Date(deps.clock.now()).toISOString(),
                roleName: ext.roleName,
                runId: ext.runId,
              },
              resume: false,
            });
        if (o.resume)
          transcript.append({
            type: "custom",
            customType: DROID_RESUME_CUSTOM_TYPE,
            data: { runId: ext.runId, modelId: ext.modelId },
          });
      } catch (e) {
        failSpawned(e);
      }
    }

    const ledger = deps.createLedger(ext.pricing, {
      thinkingInOutput: DROID_THINKING_IN_OUTPUT,
      cumulativeIncludesChild: DROID_CUMULATIVE_INCLUDES_CHILD,
    });
    return createDroidSession({
      deps,
      settings: s,
      spec,
      child: child!,
      rpc,
      envelope,
      handlersRef,
      cwd,
      sessionId: sessionId!,
      effectiveModelId: lastFullEcho?.modelId ?? ext.modelId,
      ...(lastFullEcho?.reasoningEffort === undefined ? {} : { effectiveEffort: lastFullEcho.reasoningEffort }),
      ...(lastFullEcho?.autonomyLevel === undefined ? {} : { autonomyEcho: lastFullEcho.autonomyLevel }),
      ...(transcript === undefined ? {} : { transcript }),
      ledger,
      resume: o.resume,
      catalog,
      bufferedNotifications,
      ...(protocolDriftWarned ? { protocolDriftWarned: true } : {}),
    });
  };

  return {
    id: "droid",
    ownsSessionFile,
    create: (spec) => startSession(spec, { resume: false }),
    resume: (sessionFile, spec) => startSession(spec, { resume: true, sessionFile }),
    catalog,
    dispose() {
      if (disposed) return;
      disposed = true;
      catalog.dispose(); // 停目录探测；不杀运行中的 run
    },
  };
}
