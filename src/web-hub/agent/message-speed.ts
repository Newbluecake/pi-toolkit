/** One current observation/proof OR pending write. B (native thinking) is deliberately absent. */
import {
  generationOwnData as own,
  isGenerationId,
  sanitizeGenerationCore,
  WEB_MESSAGE_SPEED_ENTRY_TYPE,
  type GenerationCore,
} from "../protocol/message-generation.js";
import type { MessageSpeedBinding } from "./message-speed-binding.js";

// Arrays need descriptor reads too: the shared own helper deliberately excludes arrays.
function arrayOwn(value: unknown, key: string): unknown {
  try {
    if (!Array.isArray(value)) return undefined;
    const d = Object.getOwnPropertyDescriptor(value, key);
    return d !== undefined && Object.hasOwn(d, "value") ? d.value : undefined;
  } catch {
    return undefined;
  }
}
function arrayEveryOwn(value: unknown, predicate: (item: unknown) => boolean): boolean {
  const length = arrayOwn(value, "length");
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > 100_000) return false;
  for (let i = 0; i < length; i++) {
    const item = arrayOwn(value, String(i));
    if (item === undefined || !predicate(item)) return false;
  }
  return true;
}

export interface MessageSpeedOwner {
  sessionId: string;
  sessionGeneration: number;
  activationGeneration: object;
  ownerToken: object;
}
interface Identity extends MessageSpeedOwner {
  loopGeneration: number;
  turnIndex: number;
  messageGeneration: number;
}
interface Observation {
  identity: Identity;
  binding?: MessageSpeedBinding;
  invalid: boolean;
  count: number;
  first?: number;
  last?: number;
  completed: boolean;
  tokens?: number;
}
interface ChatCapture {
  provider: unknown;
  model: unknown;
  id?: string;
  invalid: boolean;
  finish?: string;
  tokens?: number;
}
interface Pending {
  identity: Identity;
  finalMessage: unknown;
  core: GenerationCore;
}
export interface MessageSpeed {
  event(event: Record<string, unknown>): void;
  delta(kind: string, delta: string, binding: MessageSpeedBinding | undefined): void;
  raw(event: unknown): void;
  end(message: unknown): GenerationCore | undefined;
  reset(): void;
}
export function createMessageSpeed<C>(deps: {
  monotonicNow?: () => number;
  currentOwner(): MessageSpeedOwner | undefined;
  getCurrentContext(): C | undefined;
  sessionId(ctx: C): unknown;
  secureRecheckForWrite?: (ctx: C) => unknown;
  appendEntry(type: string, data: unknown): void;
}): MessageSpeed {
  const now = deps.monotonicNow ?? (() => performance.now());
  let loopGeneration = 0;
  let messageGeneration = 0;
  let armed = false;
  let turnIndex: number | undefined;
  let observation: Observation | undefined;
  let pending: Pending | undefined;
  let chat: ChatCapture | undefined;
  let messageStarted = false;
  const clear = (): void => {
    observation = undefined;
    pending = undefined;
  };
  const reset = (): void => {
    clear();
    armed = false;
    turnIndex = undefined;
    chat = undefined;
    messageStarted = false;
  };
  const owner = (): MessageSpeedOwner | undefined => {
    try {
      const o = deps.currentOwner();
      return o !== undefined && isGenerationId(o.sessionId) ? o : undefined;
    } catch {
      return undefined;
    }
  };
  const matches = (i: Identity): boolean => {
    const o = owner();
    return (
      o !== undefined &&
      o.sessionId === i.sessionId &&
      o.sessionGeneration === i.sessionGeneration &&
      o.activationGeneration === i.activationGeneration &&
      o.ownerToken === i.ownerToken &&
      armed &&
      i.loopGeneration === loopGeneration &&
      i.messageGeneration === messageGeneration &&
      i.turnIndex === turnIndex
    );
  };
  const sameBinding = (a: MessageSpeedBinding, b: MessageSpeedBinding): boolean =>
    a.responseId === b.responseId && a.provider === b.provider && a.api === b.api && a.model === b.model;
  const persist = (event: Record<string, unknown>): void => {
    const p = pending;
    pending = undefined; // take-and-clear even on every failure
    if (
      p === undefined ||
      !matches(p.identity) ||
      event.turnIndex !== p.identity.turnIndex ||
      event.message !== p.finalMessage ||
      !isGenerationId(event.messageEntryId)
    )
      return;
    try {
      const ctx = deps.getCurrentContext();
      if (ctx === undefined || deps.sessionId(ctx) !== p.identity.sessionId || deps.secureRecheckForWrite === undefined)
        return;
      // Only synchronous undefined is authorization; promises and all other values fail closed.
      if (deps.secureRecheckForWrite(ctx) !== undefined) return;
      if (deps.getCurrentContext() !== ctx || deps.sessionId(ctx) !== p.identity.sessionId || !matches(p.identity))
        return;
      deps.appendEntry(WEB_MESSAGE_SPEED_ENTRY_TYPE, { piToolkitGeneration: { ...p.core, mid: event.messageEntryId } });
    } catch {
      /* stale/locked/append failures never retry */
    }
  };
  return {
    reset,
    event(event) {
      switch (event.type) {
        case "agent_start":
          reset();
          loopGeneration += 1;
          armed = true;
          break;
        case "agent_end":
        case "agent_settled":
          reset();
          break;
        case "turn_start":
          clear();
          chat = undefined;
          messageStarted = false;
          turnIndex =
            armed &&
            typeof event.turnIndex === "number" &&
            Number.isSafeInteger(event.turnIndex) &&
            event.turnIndex >= 0
              ? event.turnIndex
              : undefined;
          break;
        case "message_start": {
          if (own(event.message, "role") !== "assistant") break;
          const repeated = messageStarted;
          messageStarted = true;
          clear();
          messageGeneration += 1;
          const o = owner();
          if (armed && turnIndex !== undefined && o !== undefined)
            observation = {
              identity: { ...o, loopGeneration, turnIndex, messageGeneration },
              invalid: repeated,
              count: 0,
              completed: false,
            };
          break;
        }
        case "turn_end":
          persist(event);
          observation = undefined;
          turnIndex = undefined;
          chat = undefined;
          break;
      }
    },
    delta(kind, delta, binding) {
      const o = observation;
      if (o === undefined) return;
      if (!matches(o.identity)) {
        clear();
        return;
      }
      if (kind === "error" || kind === "aborted" || kind === "abort") o.invalid = true;
      if (
        (kind === "thinking_delta" || kind === "thinking_start" || kind === "thinking_end") &&
        binding?.api !== "openai-completions" &&
        o.binding?.api !== "openai-completions"
      )
        o.invalid = true;
      if (kind !== "text_delta" && kind !== "thinking_delta" && kind !== "toolcall_delta") return;
      if (binding === undefined || (o.binding !== undefined && !sameBinding(o.binding, binding))) o.invalid = true;
      else o.binding = { ...binding };
      if (delta.length === 0) return;
      const t = now();
      if (!Number.isFinite(t) || t < 0 || (o.last !== undefined && t < o.last)) o.invalid = true;
      o.first ??= t;
      o.last = t;
      o.count += 1;
    },
    raw(event) {
      const api = own(event, "api");
      if (api === "openai-completions" && armed && turnIndex !== undefined) {
        const provider = own(event, "provider"),
          model = own(event, "model");
        if (chat === undefined) chat = { provider, model, invalid: false };
        const c = chat;
        if (provider !== c.provider || model !== c.model) return;
        const data = own(event, "data");
        const id = own(data, "id");
        if (!isGenerationId(id) || (c.id !== undefined && c.id !== id)) c.invalid = true;
        else c.id ??= id;
        const choices = own(data, "choices");
        const length = arrayOwn(choices, "length");
        if (!Array.isArray(choices) || typeof length !== "number" || length > 1) {
          c.invalid = true;
          return;
        }
        const choice = arrayOwn(choices, "0");
        if (length === 1 && (choice === undefined || own(choice, "index") !== 0)) c.invalid = true;
        const delta = own(choice, "delta");
        if (c.finish !== undefined && delta !== undefined && delta !== null) {
          if (
            typeof delta !== "object" ||
            Array.isArray(delta) ||
            Object.keys(delta).some((k) => {
              const d = Object.getOwnPropertyDescriptor(delta, k);
              return d === undefined || !("value" in d) || (k !== "role" && d.value !== null && d.value !== "");
            })
          )
            c.invalid = true;
        }
        const finish = own(choice, "finish_reason");
        if (finish !== undefined && finish !== null) {
          const mapped =
            finish === "stop"
              ? "stop"
              : finish === "length"
                ? "length"
                : finish === "tool_calls" || finish === "function_call"
                  ? "toolUse"
                  : undefined;
          if (mapped === undefined || c.finish !== undefined) c.invalid = true;
          else c.finish = mapped;
        }
        const top = own(data, "usage"),
          nested = own(choice, "usage");
        const topPresent = top !== undefined && top !== null,
          nestedPresent = nested !== undefined && nested !== null;
        const valid = (value: unknown): value is number =>
          typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 10_000_000;
        const t = own(top, "completion_tokens"),
          n = own(nested, "completion_tokens");
        if (topPresent || nestedPresent) {
          if (
            (topPresent && !valid(t)) ||
            (nestedPresent && !valid(n)) ||
            (topPresent && nestedPresent && t !== n) ||
            c.finish === undefined ||
            c.tokens !== undefined
          )
            c.invalid = true;
          else c.tokens = (topPresent ? t : n) as number;
        }
        return;
      }
      const o = observation;
      if (o === undefined) return;
      if (!matches(o.identity)) {
        clear();
        return;
      }
      if (o.binding === undefined) return;
      const b = o.binding;
      if (
        own(event, "provider") !== b.provider ||
        own(event, "api") !== b.api ||
        own(event, "model") !== b.model ||
        (b.api !== "openai-responses" && b.api !== "openai-codex-responses")
      )
        return;
      const data = own(event, "data");
      const response = own(data, "response");
      const type = own(data, "type");
      const id =
        type === "response.completed" ? own(response, "id") : (own(response, "id") ?? own(data, "response_id"));
      if (o.completed && (id === b.responseId || !isGenerationId(id))) {
        o.invalid = true;
        return;
      }
      if (id !== b.responseId) return; // never cache/overwrite another request (including native warmer)
      if (typeof type === "string" && /reasoning|summary|redact/.test(type)) o.invalid = true;
      if (type !== "response.completed") return;
      if (o.completed) o.invalid = true;
      o.completed = true;
      const usage = own(response, "usage");
      const tokens = own(usage, "output_tokens");
      const details = own(usage, "output_tokens_details");
      if (
        own(response, "status") !== "completed" ||
        own(details, "reasoning_tokens") !== 0 ||
        typeof tokens !== "number" ||
        !Number.isSafeInteger(tokens) ||
        tokens < 1 ||
        tokens > 10_000_000
      )
        o.invalid = true;
      else o.tokens = tokens;
      const output = own(response, "output");
      if (
        !Array.isArray(output) ||
        !arrayEveryOwn(output, (item) => {
          const type = own(item, "type");
          return typeof type === "string" && type !== "reasoning" && type !== "redacted_thinking";
        })
      )
        o.invalid = true;
    },
    end(message) {
      if (own(message, "role") !== "assistant") return undefined;
      const o = observation;
      clear();
      if (o === undefined || !matches(o.identity) || o.invalid || o.binding === undefined) return undefined;
      const b = o.binding;
      if (b.api === "openai-completions") {
        if (
          chat === undefined ||
          chat.invalid ||
          chat.id !== b.responseId ||
          chat.provider !== b.provider ||
          chat.model !== b.model ||
          chat.finish !== own(message, "stopReason") ||
          chat.tokens === undefined
        )
          return undefined;
        if (chat.finish === "toolUse") return undefined;
        o.tokens = chat.tokens;
      } else if (!o.completed) return undefined;
      if (own(message, "stopReason") === "error" || own(message, "stopReason") === "aborted") return undefined;
      if (
        own(message, "responseId") !== b.responseId ||
        own(message, "provider") !== b.provider ||
        own(message, "api") !== b.api ||
        own(message, "model") !== b.model ||
        own(own(message, "usage"), "output") !== o.tokens
      )
        return undefined;
      const content = own(message, "content");
      if (
        !Array.isArray(content) ||
        (b.api === "openai-completions" && arrayOwn(content, "length") === 0) ||
        !arrayEveryOwn(
          content,
          (item) =>
            own(item, "type") === "text" ||
            own(item, "type") === "toolCall" ||
            (b.api === "openai-completions" &&
              (own(item, "type") === "thinking" || own(item, "type") === "redacted_thinking")),
        )
      )
        return undefined;
      const core = sanitizeGenerationCore({
        v: 1,
        tokens: o.tokens,
        genMs: (o.last ?? NaN) - (o.first ?? NaN),
        deltaCount: o.count,
      });
      if (core !== undefined) pending = { identity: o.identity, finalMessage: message, core };
      return core;
    },
  };
}
