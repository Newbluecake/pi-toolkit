/** One current observation/proof OR pending write. B (native thinking) is deliberately absent. */
import {
  generationOwnData as own,
  isGenerationId,
  sanitizeGenerationCore,
  WEB_MESSAGE_SPEED_ENTRY_TYPE,
  type GenerationCore,
} from "../protocol/message-generation.js";
import type { MessageSpeedBinding } from "./message-speed-binding.js";

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
  const clear = (): void => {
    observation = undefined;
    pending = undefined;
  };
  const reset = (): void => {
    clear();
    armed = false;
    turnIndex = undefined;
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
          clear();
          messageGeneration += 1;
          const o = owner();
          if (armed && turnIndex !== undefined && o !== undefined)
            observation = {
              identity: { ...o, loopGeneration, turnIndex, messageGeneration },
              invalid: false,
              count: 0,
              completed: false,
            };
          break;
        }
        case "turn_end":
          persist(event);
          observation = undefined;
          turnIndex = undefined;
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
      if (kind === "thinking_delta" || kind === "thinking_start" || kind === "thinking_end") o.invalid = true;
      if (kind !== "text_delta" && kind !== "thinking_delta" && kind !== "toolcall_delta") return;
      if (binding === undefined || (o.binding !== undefined && !sameBinding(o.binding, binding))) o.invalid = true;
      else o.binding = { ...binding };
      if (delta.length === 0) return;
      const t = now();
      if (!Number.isFinite(t) || t < 0 || (o.last !== undefined && t < o.last) || o.completed) o.invalid = true;
      o.first ??= t;
      o.last = t;
      o.count += 1;
    },
    raw(event) {
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
        output.some((item) => own(item, "type") === "reasoning" || own(item, "type") === "redacted_thinking")
      )
        o.invalid = true;
    },
    end(message) {
      if (own(message, "role") !== "assistant") return undefined;
      const o = observation;
      clear();
      if (o === undefined || !matches(o.identity) || o.invalid || !o.completed || o.binding === undefined)
        return undefined;
      const b = o.binding;
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
        content.some((item) => own(item, "type") !== "text" && own(item, "type") !== "toolCall")
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
