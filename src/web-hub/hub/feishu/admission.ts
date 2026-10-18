/** F6 §4.1. The only Feishu path to CommandRouter.request; no await between live checks and request. */
import { FEISHU_RATE_LIMITS } from "../../protocol/feishu.js";
import type { CmdArgs, CmdFrame, CmdResultFrame } from "../../protocol/messages.js";
import type { CmdLimit } from "../cmd-limit.js";
import type { CommandRouter } from "../ports.js";
import type { FeishuSessions } from "./sessions.js";
import type { FeishuState } from "./state.js";

export interface FeishuInstallation {
  appId: string;
  gen: number;
  ownerOpenId: string;
  botOpenId?: string;
  botUnionId?: string;
  installSecret: string;
  active: boolean;
}
export interface FeishuIdentityContext {
  installGen: number;
  tenantKey: string;
  senderOpenId: string;
}
export interface FeishuDispatch extends FeishuIdentityContext {
  id: string;
  sessionId: string;
  cmd: CmdArgs;
  callback?: boolean;
  queryOnly?: boolean;
  /** Query must never be moved to another process's ledger. */
  expectedAgentKey?: string;
  bindingKey?: string;
  bindingRev?: number;
}
export type FeishuAdmissionResult =
  { ok: true; agentKey: string; result: CmdResultFrame } | { ok: false; code: string; retryAfterMs?: number };
export interface FeishuAdmissionDeps {
  installation(): FeishuInstallation | undefined;
  state: Pick<FeishuState, "tenant" | "allowList" | "bindings" | "appId" | "connectorMayStart" | "persistFailed">;
  sessions: Pick<FeishuSessions, "resolve">;
  /** FA MUST inject the very same instance as hub/http.ts, never create a bot-local limiter. */
  limit: CmdLimit;
  commands: Pick<CommandRouter, "request" | "peekIdempotent" | "inflight">;
  deadlineMs?: number;
}
export function createFeishuAdmission(deps: FeishuAdmissionDeps) {
  function authorize(
    ctx: FeishuIdentityContext,
  ): { ok: true; installation: FeishuInstallation } | { ok: false; code: string } {
    const install = deps.installation();
    if (
      !install?.active ||
      install.gen !== ctx.installGen ||
      install.appId !== deps.state.appId ||
      !deps.state.connectorMayStart() ||
      deps.state.persistFailed()
    )
      return { ok: false, code: "installation-changed" };
    if (deps.state.tenant.get() !== ctx.tenantKey) return { ok: false, code: "tenant-mismatch" };
    if (!deps.state.allowList.has(ctx.senderOpenId)) return { ok: false, code: "sender-denied" };
    return { ok: true, installation: install };
  }
  function spend(bucket: string, max: number, windowMs: number) {
    return deps.limit.admit(bucket, max, Math.ceil(windowMs / max));
  }
  function callback(ctx: FeishuIdentityContext): { ok: true } | { ok: false; code: string; retryAfterMs?: number } {
    const auth = authorize(ctx);
    if (!auth.ok) return auth;
    const rate = spend("feishu:cb", FEISHU_RATE_LIMITS.callback.max, FEISHU_RATE_LIMITS.callback.windowMs);
    return rate.ok ? rate : { ok: false, code: "E_RATE", retryAfterMs: rate.retryAfterMs };
  }
  return {
    authorize,
    callback,
    resolve: deps.sessions.resolve,
    async dispatch(input: FeishuDispatch): Promise<FeishuAdmissionResult> {
      // Intentionally no caller-supplied origin. This synthetic value is attribution ONLY.
      const auth = authorize(input);
      if (!auth.ok) return auth;
      const cmd = input.cmd;
      if (!(
        (cmd.op === "prompt" && cmd.deliver === "followUp") ||
        cmd.op === "dialog_answer" ||
        cmd.op === "dialog_cancel"
      ))
        return { ok: false, code: "op-denied" };
      const binding = input.bindingKey === undefined ? undefined : deps.state.bindings.get(input.bindingKey);
      if (
        input.bindingKey !== undefined &&
        (binding?.rev !== input.bindingRev || binding?.sessionId !== input.sessionId || binding?.offline !== undefined)
      )
        return { ok: false, code: "binding-changed" };
      const route = deps.sessions.resolve(input.sessionId);
      if (!route.ok) return route;
      if (input.expectedAgentKey !== undefined && route.agentKey !== input.expectedAgentKey)
        return { ok: false, code: "agent-changed" };
      if (deps.commands.inflight() >= 32) return { ok: false, code: "E_RATE" };
      const origin = { listener: "lan" as const, ip: "feishu", user: `feishu:${input.senderOpenId}`, reqId: input.id };
      const dup = deps.commands.peekIdempotent?.(origin, route.agentKey, input.id, cmd) !== undefined;
      if (!dup) {
        const buckets: Array<[string, number, number]> = [
          [`agent:${route.agentKey}`, 30, 1_000],
          [
            `feishu:${input.senderOpenId}:cmd`,
            FEISHU_RATE_LIMITS.senderCmd.max,
            Math.ceil(FEISHU_RATE_LIMITS.senderCmd.windowMs / FEISHU_RATE_LIMITS.senderCmd.max),
          ],
          [
            "feishu:global",
            FEISHU_RATE_LIMITS.global.max,
            Math.ceil(FEISHU_RATE_LIMITS.global.windowMs / FEISHU_RATE_LIMITS.global.max),
          ],
        ];
        if (input.callback)
          buckets.push([
            "feishu:cb",
            FEISHU_RATE_LIMITS.callback.max,
            Math.ceil(FEISHU_RATE_LIMITS.callback.windowMs / FEISHU_RATE_LIMITS.callback.max),
          ]);
        for (const [key, capacity, refillMs] of buckets) {
          const admitted = deps.limit.admit(key, capacity, refillMs);
          if (!admitted.ok) return { ok: false, code: "E_RATE", retryAfterMs: admitted.retryAfterMs };
        }
      }
      const frame: CmdFrame = {
        t: "cmd",
        rid: "",
        id: input.id,
        deadlineMs: deps.deadlineMs ?? 8_000,
        origin,
        cmd,
        ...(input.queryOnly ? { queryOnly: true } : {}),
      };
      // Returning the promise starts request NOW, before any caller can change authorization.
      const result = await deps.commands.request(frame, route.agentKey);
      return { ok: true, agentKey: route.agentKey, result };
    },
  };
}
export type FeishuAdmission = ReturnType<typeof createFeishuAdmission>;
