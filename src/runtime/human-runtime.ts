import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { DefaultResourceLoader, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionFactory, ResourceLoader } from "@earendil-works/pi-coding-agent";
import { clampSpanMs } from "../core/deadline.js";
import type { InvocationRef, createHumanGrantPort } from "../fabric/xs/human-grant.js";
import type { XsSender } from "../fabric/xs/sender.js";
import { createMessageSessionTool } from "../tools/message-session-tool.js";
import type { SessionSpec } from "../core/types.js";
import type { ToolScopePolicy } from "./tool-scope.js";

export interface ChildHumanBinding {
  tool: ReturnType<typeof createMessageSessionTool>;
  observer: ExtensionFactory;
  dispose(): void;
  wrapAgent(tool: unknown): unknown;
}
export interface HumanRuntime {
  prepare(runId: string): Promise<ChildHumanBinding | undefined>;
  childLinked(runId: string): void;
  detach(): void;
}
interface Source {
  sessionId: string;
  epoch: number;
}
interface HumanRuntimeDeps {
  grants: ReturnType<typeof createHumanGrantPort>;
  rootOwner: string;
  source(): Source | undefined;
  sender(): XsSender | undefined;
  runLevel(runId: string): number;
  reply: boolean;
  alias: boolean;
}

/** Activation-local façade. Only the grant park's bounded DATA crosses reloads;
 * no SDK session, sender, waiter, resource loader or callback is parked globally.
 */
export function createHumanRuntime(deps: HumanRuntimeDeps): HumanRuntime {
  const waiters = new Map<string, () => void>();
  const bindings = new Set<() => void>();
  let generation = 0;
  // Exact SDK execute causality for BLOCKING nested Agent: its result arrives
  // only after the child finishes. The async store carries pure call data,
  // never a session/sender; the admitted spawn edge is still mandatory.
  const nestedCall = new AsyncLocalStorage<InvocationRef>();
  const open = (source: Source, runId: string, owner: string) =>
    deps.grants.openChild(source.sessionId, deps.rootOwner, runId, owner);
  return {
    detach() {
      generation++;
      for (const dispose of [...bindings]) dispose();
      for (const done of [...waiters.values()]) done();
      nestedCall.disable();
    },
    childLinked(runId) {
      waiters.get(runId)?.();
    },
    async prepare(runId) {
      const version = generation;
      const source = deps.source();
      if (!source || !deps.sender() || bindings.size >= 64) return undefined;
      const owner = randomUUID();
      const parent = nestedCall.getStore();
      if (parent?.sessionId === source.sessionId) deps.grants.linkInvocation(parent, runId);
      let ref = open(source, runId, owner);
      if (
        !ref &&
        deps.grants.childPending(source.sessionId, deps.rootOwner, runId) &&
        waiters.size < 64 &&
        !waiters.has(runId)
      ) {
        // The real spawn edge precedes Agent's tool_result. Wait ONCE, only for
        // an already proven potential parent; never authorize by guessing it.
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            waiters.delete(runId);
            resolve();
          };
          const timer = setTimeout(done, clampSpanMs(1_000)!);
          timer.unref();
          waiters.set(runId, done);
        });
        if (version !== generation || bindings.size >= 64) return undefined;
        ref = open(source, runId, owner);
      }
      if (!ref) return undefined;
      let disposed = false;
      let seq = 0;
      const calls = new Map<string, InvocationRef>();
      const live = () => {
        const current = deps.source();
        return (
          !disposed &&
          generation === version &&
          current?.sessionId === source.sessionId &&
          current.epoch === source.epoch
        );
      };
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        bindings.delete(dispose);
        calls.clear();
        deps.grants.endRun(source.sessionId, runId);
      };
      if (!live()) {
        dispose();
        return undefined;
      }
      bindings.add(dispose);
      const observer: ExtensionFactory = (pi) => {
        pi.on("context", () => {
          calls.clear();
          if (!live() || !deps.grants.bindChildContext(ref!, runId, owner, ++seq)) dispose();
        });
        pi.on("tool_call", (event) => {
          if (!live() || seq === 0 || calls.size >= 256 || calls.has(event.toolCallId)) return;
          if (event.parentToolCallId && !calls.has(event.parentToolCallId)) return;
          const call: InvocationRef = {
            sessionId: source.sessionId,
            runKey: runId,
            owner,
            contextSeq: seq,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          };
          calls.set(event.toolCallId, call);
          deps.grants.registerInvocation(call);
        });
        pi.on("tool_result", (event) => {
          const call = calls.get(event.toolCallId);
          const child = (event.details as { runId?: unknown } | undefined)?.runId;
          if (live() && call && event.toolName === "Agent" && !event.isError && typeof child === "string") {
            deps.grants.linkInvocation(call, child);
            waiters.get(child)?.();
          }
        });
        // A new branch/compaction is not continuation evidence for delegation.
        pi.on("session_compact", dispose);
        pi.on("session_before_switch", dispose);
        pi.on("session_before_fork", dispose);
        pi.on("session_before_tree", dispose);
        pi.on("agent_end", dispose);
      };
      const sender = new Proxy({} as XsSender, {
        get(_target, prop) {
          if (prop === "message")
            return (args: Parameters<XsSender["message"]>[0]) => {
              const call = args.invocation;
              if (!live() || !call || !deps.grants.resolve(call))
                return Promise.resolve({ status: "not_joined", effect: "none", reason: "not_joined" });
              return (
                deps.sender()?.message({
                  ...args,
                  invocationLevel: () => deps.runLevel(runId),
                  invocationLive: () => live() && deps.grants.resolve(call) !== undefined,
                }) ?? Promise.resolve({ status: "not_joined", effect: "none", reason: "not_joined" })
              );
            };
          return undefined;
        },
      });
      return {
        observer,
        dispose,
        wrapAgent(tool) {
          const definition = tool as { name?: string; execute?: (...args: unknown[]) => unknown } | undefined;
          if (definition?.name !== "Agent" || typeof definition.execute !== "function") return tool;
          const execute = definition.execute;
          return {
            ...definition,
            execute: (...args: unknown[]) => {
              const call = typeof args[0] === "string" ? calls.get(args[0]) : undefined;
              return live() && call?.toolName === "Agent"
                ? nestedCall.run({ ...call }, () => execute.apply(definition, args))
                : execute.apply(definition, args);
            },
          };
        },
        tool: createMessageSessionTool({
          sender,
          activation: true,
          reply: deps.reply,
          alias: deps.alias,
          invocation: (id) => {
            const call = calls.get(id);
            return live() && call?.toolName === "message_session" ? { ...call } : undefined;
          },
        }),
      };
    },
  };
}

/** Add the host observer via public extensionFactories, preserving the caller's
 * resource loader and its extension runtime. No -e inheritance or private SDK API.
 */
export async function withHumanBinding(
  options: Record<string, unknown>,
  cwd: string,
  binding: ChildHumanBinding,
): Promise<Record<string, unknown>> {
  const agentDir = typeof options.agentDir === "string" ? options.agentDir : getAgentDir();
  const settingsManager =
    (options.settingsManager as SettingsManager | undefined) ?? SettingsManager.create(cwd, agentDir);
  let base = options.resourceLoader as ResourceLoader | undefined;
  if (!base) {
    base = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
    await base.reload();
  }
  const supplemental = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [binding.observer],
  });
  await supplemental.reload();
  const resourceLoader = new Proxy(base, {
    get(target, prop) {
      if (prop === "getExtensions")
        return () => {
          const original = target.getExtensions();
          return { ...original, extensions: [...original.extensions, ...supplemental.getExtensions().extensions] };
        };
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    ...options,
    settingsManager,
    resourceLoader,
    customTools: [
      ...((options.customTools as unknown[] | undefined) ?? []).map((tool) => binding.wrapAgent(tool)),
      binding.tool,
    ],
    ...(Array.isArray(options.tools) ? { tools: [...options.tools, "message_session"] } : {}),
  };
}

/** Runtime-owned runId, never spec.model/meta/Agent arguments. Readonly,
 * explicit exclusion, noTools and external sessions retain the old path.
 */
export function humanRunId(spec: SessionSpec): string | undefined {
  const request = spec as SessionSpec & { runId?: string; toolScope?: { policy: ToolScopePolicy } };
  if (
    spec.external ||
    spec.noTools === "all" ||
    spec.excludeTools?.includes("message_session") ||
    request.toolScope?.policy.provenance ||
    request.toolScope?.policy.deny.has("message_session")
  )
    return undefined;
  return typeof request.runId === "string" && request.runId ? request.runId : undefined;
}
export function grantHumanScope(spec: SessionSpec): void {
  const scope = (spec as SessionSpec & { toolScope?: { policy: ToolScopePolicy } }).toolScope;
  if (scope?.policy.allow)
    scope.policy = { ...scope.policy, allow: new Set([...scope.policy.allow, "message_session"]) };
}
