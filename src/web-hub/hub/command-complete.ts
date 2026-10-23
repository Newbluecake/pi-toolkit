/** Slash-argument completion: ephemeral, cap-gated requests, never the command ledger.
 * Own limiter shared by both listeners; no prefix/result text enters logs or caches.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  CMD_ARGS,
  CMD_ARGS_AUDIT_CODE_ABORTED,
  COMMAND_NAME_PATTERN,
  type CompleteItemWire,
  type CompleteReplyFrame,
} from "../protocol/command-args.js";
import { CMD_ARGS_HUB_CAP } from "../protocol/version.js";
import { auditCommandComplete, type CommandCompleteAuditRecord } from "./audit.js";
import { createCmdLimit, type CmdLimit } from "./cmd-limit.js";
import type { HubLog, PreviewRouteIo } from "./ports.js";
import { createReqDeadline } from "./req-deadline.js";
import { HubError, type Registry } from "./registry.js";

export interface CommandCompleteIo extends PreviewRouteIo {
  strictCsrfOk(): boolean;
  readJson(req: IncomingMessage, maxBytes: number, maxMs: number): Promise<unknown>;
}
export interface CommandCompleteRoutes {
  handle(req: IncomingMessage, res: ServerResponse, io: CommandCompleteIo): Promise<void>;
}
const NAME_RE = new RegExp(COMMAND_NAME_PATTERN);
const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/;
const STATUS: Readonly<Record<string, number>> = {
  E_CSRF: 403,
  E_AUTH: 401,
  E_BAD_REQUEST: 400,
  E_UNKNOWN_COMMAND: 404,
  E_COMMAND_DENIED: 403,
  E_UNSUPPORTED: 501,
  E_RATE: 429,
  E_BUSY: 503,
  E_NOT_FOUND: 404,
  E_AGENT_GONE: 404,
  E_DEADLINE: 504,
  E_INTERNAL: 500,
};

/** Defense in depth beyond the socket schema: enforce UTF-8 and aggregate byte bounds.
 * Copy only known fields, never reflect arbitrary agent properties into HTTP.
 */
export function trimCompleteItems(raw: readonly CompleteItemWire[]): { items: CompleteItemWire[]; truncated?: true } {
  const items: CompleteItemWire[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const item of raw) {
    if (items.length >= CMD_ARGS.itemMax) {
      truncated = true;
      break;
    }
    if (
      typeof item.value !== "string" ||
      typeof item.label !== "string" ||
      /^\s/.test(item.value) ||
      CONTROL_RE.test(item.value) ||
      CONTROL_RE.test(item.label) ||
      Buffer.byteLength(item.value) > CMD_ARGS.itemValueMaxBytes ||
      item.label.length > CMD_ARGS.itemLabelMaxChars ||
      (item.description !== undefined &&
        (typeof item.description !== "string" ||
          item.description.length > CMD_ARGS.itemDescMaxChars ||
          CONTROL_RE.test(item.description)))
    ) {
      truncated = true;
      continue;
    }
    if (seen.has(item.value)) continue;
    const copy: CompleteItemWire = {
      value: item.value,
      label: item.label,
      ...(item.description === undefined ? {} : { description: item.description }),
      ...(item.policy === "confirm" ? { policy: "confirm" as const } : {}),
    };
    // Include array framing and HTTP envelope reserve, not just raw string lengths.
    if (Buffer.byteLength(JSON.stringify([...items, copy])) + 64 > CMD_ARGS.itemsTotalMaxBytes) {
      truncated = true;
      break;
    }
    seen.add(item.value);
    items.push(copy);
  }
  return { items, ...(truncated ? { truncated: true } : {}) };
}

export function createCommandCompleteRoutes(deps: {
  registry: Pick<Registry, "get" | "getCaps" | "isConnected" | "request">;
  log: HubLog;
  now(): number;
  /** Private by default; never pass the /api/cmd limiter. */
  limit?: CmdLimit;
}): CommandCompleteRoutes {
  const { registry, log, now } = deps;
  const limit = deps.limit ?? createCmdLimit(now);
  const inflight = new Map<string, number>();
  let total = 0;
  return {
    async handle(req, res, io) {
      const started = now();
      const deadline = createReqDeadline(now, CMD_ARGS.routeDeadlineMs);
      const audit: CommandCompleteAuditRecord = { listener: io.listener };
      const ctl = new AbortController();
      let principal = "";
      let taken = false;
      let audited = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const release = (): void => {
        if (!taken) return;
        taken = false;
        total--;
        const n = (inflight.get(principal) ?? 1) - 1;
        if (n === 0) inflight.delete(principal);
        else inflight.set(principal, n);
      };
      const record = (): void => {
        if (audited) return;
        audited = true;
        audit.ms = Math.max(0, now() - started);
        auditCommandComplete(log, audit);
      };
      // Covers auth/body/agent waits. Abort also cancels the registry's pending waiter.
      let cancel!: () => void;
      const cancelled = new Promise<never>((_, reject) => {
        cancel = () => reject(new HubError("E_DEADLINE"));
      });
      const onClose = (): void => {
        if (res.writableFinished) return;
        audit.code = CMD_ARGS_AUDIT_CODE_ABORTED;
        ctl.abort();
        release();
        record();
        cancel();
      };
      const send = (code: string, retryable = false): void => {
        audit.code = code;
        if (!res.destroyed && !ctl.signal.aborted)
          io.sendJson(
            res,
            STATUS[code] ?? 500,
            { error: code, retryable },
            { "Cache-Control": "no-store", ...(code === "E_RATE" || code === "E_BUSY" ? { "Retry-After": "1" } : {}) },
          );
      };
      res.once("close", onClose);
      const run = async (): Promise<void> => {
        if (!io.strictCsrfOk()) {
          send("E_CSRF");
          return;
        }
        const authed = await io.authorize(deadline);
        if (ctl.signal.aborted) return;
        if ("handled" in authed) {
          audit.code = authed.code;
          return;
        }
        principal = `${io.listener}:${authed.user ?? "token"}`;
        const rate = (key: string, capacity: number, refill: number): boolean => {
          if (limit.admit(key, capacity, refill).ok) return true;
          send("E_RATE", true);
          return false;
        };
        const rates = CMD_ARGS.hubRate;
        if (!rate(`${principal}:cpre`, rates.cprePerSecond, 1000 / rates.cprePerSecond)) return;
        if (io.listener === "lan" && !rate(`lan-ip:${io.ip}`, rates.lanIpPer2s, 2000 / rates.lanIpPer2s)) return;
        if (!rate(`${principal}:complete`, rates.completeCapacity, rates.completeRefillMs)) return;
        if ((inflight.get(principal) ?? 0) >= CMD_ARGS.hubInflight.perPrincipalMax) {
          send("E_RATE", true);
          return;
        }
        if (total >= CMD_ARGS.hubInflight.globalMax) {
          send("E_BUSY", true);
          return;
        }
        taken = true;
        total++;
        inflight.set(principal, (inflight.get(principal) ?? 0) + 1);
        const body = await io.readJson(req, 8 << 10, Math.max(1, deadline.remaining()));
        if (ctl.signal.aborted) return;
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          send("E_BAD_REQUEST");
          return;
        }
        const { agentKey, name, prefix } = body as Record<string, unknown>;
        if (
          typeof agentKey !== "string" ||
          !KEY_RE.test(agentKey) ||
          typeof name !== "string" ||
          !NAME_RE.test(name) ||
          typeof prefix !== "string" ||
          Buffer.byteLength(prefix) > CMD_ARGS.prefixMaxBytes ||
          CONTROL_RE.test(prefix)
        ) {
          send("E_BAD_REQUEST");
          return;
        }
        audit.name = name;
        audit.plen = Buffer.byteLength(prefix);
        if (!rate(`agent-complete:${agentKey}`, rates.agentPerSecond, 1000 / rates.agentPerSecond)) return;
        const view = registry.get(agentKey);
        if (view === undefined || !registry.isConnected(agentKey)) {
          send("E_NOT_FOUND");
          return;
        }
        const caps = registry.getCaps(agentKey) ?? [];
        if (!["cmd.v1", "command.v1", CMD_ARGS_HUB_CAP].every((c) => caps.includes(c))) {
          send("E_UNSUPPORTED");
          return;
        }
        // The advertised command table carries resolved webCommandPolicy (including overrides).
        // Fail closed if that table/name has not arrived yet; agent re-checks policy per item.
        const row = view.commands?.find((c) => c.name === name);
        if (row === undefined) {
          send("E_UNKNOWN_COMMAND");
          return;
        }
        if (row.policy === "deny") {
          send("E_COMMAND_DENIED");
          return;
        }
        const frameMs = Math.min(deadline.remaining() - CMD_ARGS.deadlineMarginMs, CMD_ARGS.frameDeadlineMaxMs);
        if (frameMs <= 0) {
          send("E_DEADLINE", true);
          return;
        }
        // request's third arg is a RELATIVE span, never an absolute Date.now() deadline.
        const reply = await registry.request<CompleteReplyFrame>(
          agentKey,
          {
            t: "complete_req",
            rid: "",
            name,
            prefix,
            deadlineMs: frameMs,
            origin: { listener: io.listener },
          },
          Math.min(frameMs + CMD_ARGS.ackSlackMs, deadline.remaining()),
          ctl.signal,
        );
        if (ctl.signal.aborted) return;
        if (registry.get(agentKey)?.commands?.find((c) => c.name === name)?.policy === "deny") {
          send("E_COMMAND_DENIED");
          return;
        }
        if (!reply.ok) {
          send(reply.code, reply.retryable);
          return;
        }
        const result = trimCompleteItems(reply.items);
        audit.hits = result.items.length;
        audit.source = reply.source;
        audit.code = "ok";
        io.sendJson(
          res,
          200,
          { ...result, source: reply.source, ...(reply.truncated ? { truncated: true } : {}) },
          { "Cache-Control": "no-store" },
        );
      };
      try {
        timer = setTimeout(
          () => {
            cancel();
            ctl.abort();
          },
          Math.max(0, deadline.remaining()),
        );
        timer.unref();
        await Promise.race([run(), cancelled]);
      } catch (err) {
        if (audit.code !== CMD_ARGS_AUDIT_CODE_ABORTED) {
          // Abort on a route deadline suppresses late writes, not the deadline response itself.
          const code =
            err instanceof HubError
              ? err.code
              : typeof err === "object" &&
                  err !== null &&
                  "code" in err &&
                  (err.code === "E_BAD_REQUEST" || err.code === "E_DEADLINE")
                ? String(err.code)
                : "E_INTERNAL";
          audit.code = code;
          if (!res.destroyed && !res.headersSent)
            io.sendJson(
              res,
              STATUS[code] ?? 500,
              { error: code, retryable: code === "E_DEADLINE" },
              { "Cache-Control": "no-store" },
            );
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        res.off("close", onClose);
        release();
        record();
      }
    },
  };
}
