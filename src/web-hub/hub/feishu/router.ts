/** F6: first-line command grammar, durable binding pointers and typed F8 work intents. */
import { FEISHU_RECEIVED_BODY_MAX_BYTES, sanitizeHeaderField } from "../../protocol/feishu.js";
import type { FeishuIdentityContext } from "./admission.js";
import type { FeishuMessage, FeishuPreparedInbound } from "./inbound.js";
import type { FeishuRequests } from "./requests.js";
import { feishuBatchIdentity } from "./requests.js";
import { feishuBindingKey, type FeishuSessions, type FeishuSessionRow } from "./sessions.js";
import type { FeishuBinding, FeishuState, RequestPayload } from "./state.js";

export type FeishuCommand =
  | { op: "prompt"; text: string }
  | { op: "list" | "cur" | "unbind" }
  | { op: "help"; unknown?: string }
  | { op: "use"; selector: string }
  | { op: "new"; cwd: string; firstPrompt: string }
  | { op: "file"; path: string }
  | { op: "schedule" }
  | { op: "schedule-run"; n: number };
/** `schedule` (F1, #32): recognise `/schedule` + `/schedule run <n>`; absent/false ⇒ unknown command, byte-identical. */
export interface FeishuParseOptions {
  schedule?: boolean;
}
export function parseFeishuCommand(text: string, opts: FeishuParseOptions = {}): FeishuCommand {
  if (text.startsWith("//")) return { op: "prompt", text: text.slice(1) };
  if (!text.startsWith("/")) return { op: "prompt", text };
  const newline = text.indexOf("\n");
  const first = newline < 0 ? text : text.slice(0, newline);
  const tail = newline < 0 ? "" : text.slice(newline + 1);
  const token = first.split(/\s/, 1)[0] ?? first;
  // Main-session ruling: /home/me/file.txt is a path-like prompt, not a bot command.
  if (token.indexOf("/", 1) >= 0) return { op: "prompt", text };
  if (["/list", "/cur", "/unbind", "/help"].includes(first) && !tail.trim())
    return { op: first.slice(1) as "list" | "cur" | "unbind" | "help" };
  if (opts.schedule === true && token === "/schedule") {
    if (tail.trim()) return { op: "help" };
    if (first === "/schedule") return { op: "schedule" };
    const m = /^\/schedule\s+run\s+(\d{1,4})$/.exec(first);
    return m !== null && Number(m[1]) >= 1 ? { op: "schedule-run", n: Number(m[1]) } : { op: "help" };
  }
  if (first.startsWith("/use ") && first.slice(5).trim() && !tail.trim())
    return { op: "use", selector: first.slice(5).trim() };
  if (first.startsWith("/file ") && first.slice(6).trim().startsWith("/") && !tail.trim())
    return { op: "file", path: first.slice(6).trim() };
  if (first.startsWith("/new ")) {
    const args = first.slice(5).trim();
    let cwd: string, rest: string;
    if (args.startsWith('"')) {
      const match = /^"(?:[^"\\]|\\.)*"/.exec(args);
      if (!match) return { op: "help" };
      try {
        cwd = JSON.parse(match[0]) as string;
      } catch {
        return { op: "help" };
      }
      rest = args.slice(match[0].length).trim();
      if (rest && !/^\s/.test(args.slice(match[0].length))) return { op: "help" };
    } else {
      const end = args.search(/\s/);
      cwd = end < 0 ? args : args.slice(0, end);
      rest = end < 0 ? "" : args.slice(end).trim();
    }
    if (cwd && Buffer.byteLength(cwd) <= 4_096 && !/[\p{Cc}\p{Cf}]/u.test(cwd))
      return { op: "new", cwd, firstPrompt: [rest, tail].filter(Boolean).join("\n") };
  }
  return ["/list", "/use", "/cur", "/new", "/unbind", "/file", "/help"].includes(token)
    ? { op: "help" }
    : { op: "help", unknown: token.slice(0, 64) }; // Unknown commands NEVER reach pi.
}
export type FeishuRouterIntent =
  | { type: "notice"; message: FeishuMessage; code: string; unknownCommand?: string }
  | { type: "list"; message: FeishuMessage; generation: number; rows: FeishuSessionRow[] }
  | { type: "current"; message: FeishuMessage; binding: FeishuBinding | undefined; rows: FeishuSessionRow[] }
  | { type: "bound"; message: FeishuMessage; binding: FeishuBinding }
  | {
      type: "new";
      message: FeishuMessage;
      identity: FeishuIdentityContext;
      id: string;
      cwd: string;
      firstPrompt: string;
      policy: { scope: "known" | "roots"; confirm: "unknown-dir" };
    }
  | { type: "file"; message: FeishuMessage; identity: FeishuIdentityContext; path: string; binding: FeishuBinding }
  | { type: "open-topic"; message: FeishuMessage; identity: FeishuIdentityContext }
  | { type: "schedule"; message: FeishuMessage; identity: FeishuIdentityContext }
  | { type: "schedule-run"; message: FeishuMessage; identity: FeishuIdentityContext; n: number };
export interface FeishuRouterDeps {
  state: FeishuState;
  sessions: FeishuSessions;
  requests: FeishuRequests;
  groupRootTopics: boolean;
  spawnScope: "known" | "roots";
  /** F1: `/schedule` is recognised (HubConfig.schedule present). Absent ⇒ legacy behavior. */
  schedule?: boolean;
  /** F8 must return committed+pinned upload ids, and stage >16KiB text as .txt. No silent truncation. */
  preparePayload?(message: FeishuMessage, text: string, identity: FeishuIdentityContext): Promise<RequestPayload>;
  emit(intent: FeishuRouterIntent): void;
  onHealth?(event: { degraded: true; reason: "background-failed"; operation: "flush" }): void;
}
/** R2-j: known refuses unknown dirs; only roots can offer realpath confirmation. */
export function feishuNewDirectoryDecision(scope: "known" | "roots", known: boolean): "create" | "confirm" | "refused" {
  return known ? "create" : scope === "roots" ? "confirm" : "refused";
}
export function createFeishuRouter(deps: FeishuRouterDeps) {
  const state = deps.state;
  let disposed = false;
  return {
    async prepare(message: FeishuMessage, identity: FeishuIdentityContext): Promise<FeishuPreparedInbound> {
      const intents: FeishuRouterIntent[] = [];
      let readyId: string | undefined;
      const key = feishuBindingKey(message.chatType, message.chatId, message.threadId);
      const command = parseFeishuCommand(message.text, deps.schedule === true ? { schedule: true } : {});
      const notice = (code: string, unknownCommand?: string) => {
        intents.push({ type: "notice", message, code, ...(unknownCommand ? { unknownCommand } : {}) });
      };
      if (!state.allowList.has(identity.senderOpenId) || state.tenant.get() !== identity.tenantKey)
        return { drop: true };
      if (command.op === "prompt" && message.messageType === "text" && !command.text.trim()) notice("usage");
      else if (command.op === "help") notice("help", command.unknown);
      else if (command.op === "schedule" || command.op === "schedule-run") {
        // Private chat only (plan §7.4): a group/topic never lists or triggers schedules.
        if (message.chatType !== "p2p") notice("schedule-p2p-only");
        else if (command.op === "schedule") intents.push({ type: "schedule", message, identity });
        else intents.push({ type: "schedule-run", message, identity, n: command.n });
      } else if (key === undefined) {
        if (deps.groupRootTopics) intents.push({ type: "open-topic", message, identity });
        else notice("use-topic");
      } else if (command.op === "list") {
        const list = deps.sessions.list(message.chatId, message.senderOpenId);
        if (!list.ok) notice("list-full");
        else intents.push({ type: "list", message, generation: list.generation.id, rows: list.generation.rows });
      } else if (command.op === "use") {
        const selected = deps.sessions.select(message.chatId, message.senderOpenId, command.selector);
        if (!selected.ok) notice(selected.code);
        else {
          const bound = state.bindings.set(key, {
            chatId: message.chatId,
            chatType: message.chatType,
            ...(message.threadId ? { threadId: message.threadId } : {}),
            sessionId: selected.row.sessionId,
            label: sanitizeHeaderField(selected.row.name),
            offline: null,
          });
          if (!bound.ok) notice("bindings-full");
          else intents.push({ type: "bound", message, binding: bound.value });
        }
      } else if (command.op === "cur")
        intents.push({ type: "current", message, binding: state.bindings.get(key), rows: deps.sessions.rows() });
      else if (command.op === "unbind") {
        state.bindings.remove(key);
        notice("unbound");
      } else if (command.op === "new")
        intents.push({
          type: "new",
          message,
          identity,
          id: feishuBatchIdentity([message.messageId]).id,
          cwd: command.cwd,
          firstPrompt: command.firstPrompt,
          policy: { scope: deps.spawnScope, confirm: "unknown-dir" },
        });
      else {
        const binding = state.bindings.get(key);
        if (!binding?.sessionId || binding.offline !== undefined) notice("no-session-bound");
        else if (command.op === "file") intents.push({ type: "file", message, identity, path: command.path, binding });
        else if (command.op === "prompt") {
          let payload: RequestPayload;
          if (deps.preparePayload !== undefined) payload = await deps.preparePayload(message, command.text, identity);
          else payload = { body: command.text, messageIds: [message.messageId], uploadIds: [] };
          // Revocation while staging is an intentional silent drop, never queue pressure.
          if (disposed || !state.allowList.has(identity.senderOpenId) || state.tenant.get() !== identity.tenantKey)
            return { drop: true };
          if (message.messageType !== "text" && deps.preparePayload === undefined) notice("files-unavailable");
          else if (!payload.body.trim()) notice("usage");
          else if (Buffer.byteLength(payload.body) > FEISHU_RECEIVED_BODY_MAX_BYTES) notice("text-staging-required");
          else {
            const received = deps.requests.receive({
              sessionId: binding.sessionId,
              bindingKey: key,
              bindingRev: binding.rev,
              senderOpenId: message.senderOpenId,
              senderDisplay: sanitizeHeaderField(message.senderDisplay),
              chatLabel: sanitizeHeaderField(message.chatLabel),
              chatId: message.chatId,
              chatType: message.chatType,
              ...(message.threadId ? { threadId: message.threadId } : {}),
              triggerMessageId: message.messageId,
              payload,
              ...(message.createdAt !== undefined ? { sourceCreatedAt: message.createdAt } : {}),
              installGen: identity.installGen,
              tenantKey: identity.tenantKey,
            });
            if (!received.ok && received.refused === "unavailable") return { drop: true };
            if (!received.ok) notice("queue-full");
            else readyId = received.value.id;
          }
        }
      }
      const isCommand = command.op !== "prompt";
      return {
        durable() {
          if (disposed) return;
          // Commands break debounce windows; no command dispatch is ever awaited in the ACK path.
          if (isCommand)
            void deps.requests.flushChat(message.chatId).catch(() => {
              try {
                deps.onHealth?.({ degraded: true, reason: "background-failed", operation: "flush" });
              } catch {
                /* Diagnostic only. */
              }
            });
          if (readyId !== undefined) deps.requests.release(readyId);
          for (const intent of intents) deps.emit(intent);
        },
      };
    },
    /** F8 calls after a successful reply_in_thread response. Never guesses a thread id. */
    bindTopic(input: { chatId: string; threadId: string; sessionId: string; label?: string }) {
      return state.bindings.set(feishuBindingKey("group", input.chatId, input.threadId)!, {
        chatId: input.chatId,
        threadId: input.threadId,
        chatType: "group",
        sessionId: input.sessionId,
        ...(input.label ? { label: sanitizeHeaderField(input.label) } : {}),
        offline: null,
      });
    },
    dispose() {
      disposed = true;
    },
  };
}
export type FeishuRouter = ReturnType<typeof createFeishuRouter>;
