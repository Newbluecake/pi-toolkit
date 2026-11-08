/** One current observation/proof or pending write; generation rate includes reasoning output. */
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
  tokens?: number;
}
interface ResponseCapture {
  binding: MessageSpeedBinding;
  created: boolean;
  invalid: boolean;
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
interface AnthropicLane {
  provider: unknown;
  model: unknown;
  id: string;
  external: boolean;
  terminal: boolean;
  closed: boolean;
  invalid: boolean;
  tokens?: number;
  stop?: string;
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
  let responses: ResponseCapture | undefined;
  let messageStarted = false;
  let lane: AnthropicLane | undefined;
  let anthropicTainted = false;
  let capture = false;
  let captureOwner: MessageSpeedOwner | undefined;
  const abandonLane = (): void => {
    if (lane) lane.external = true;
  };
  const clear = (): void => {
    observation = undefined;
    pending = undefined;
  };
  const reset = (): void => {
    clear();
    abandonLane();
    capture = false;
    armed = false;
    turnIndex = undefined;
    chat = undefined;
    responses = undefined;
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
          abandonLane();
          clear();
          chat = undefined;
          responses = undefined;
          messageStarted = false;
          turnIndex =
            armed &&
            typeof event.turnIndex === "number" &&
            Number.isSafeInteger(event.turnIndex) &&
            event.turnIndex >= 0
              ? event.turnIndex
              : undefined;
          capture = turnIndex !== undefined;
          const current = owner();
          captureOwner = current === undefined ? undefined : { ...current };
          if (capture && lane && !lane.closed) anthropicTainted = true;
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
            };
          break;
        }
        case "turn_end":
          persist(event);
          observation = undefined;
          abandonLane();
          capture = false;
          turnIndex = undefined;
          chat = undefined;
          responses = undefined;
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
      if (kind !== "text_delta" && kind !== "thinking_delta" && kind !== "toolcall_delta") return;
      if (binding === undefined || (o.binding !== undefined && !sameBinding(o.binding, binding))) o.invalid = true;
      else {
        o.binding = { ...binding };
        if (binding.api === "openai-responses" || binding.api === "openai-codex-responses") {
          if (responses === undefined)
            responses = { binding: { ...binding }, created: false, invalid: false, completed: false };
          else if (!sameBinding(responses.binding, binding)) responses.invalid = true;
        }
      }
      if (delta.length === 0) return;
      const t = now();
      if (!Number.isFinite(t) || t < 0 || (o.last !== undefined && t < o.last)) o.invalid = true;
      o.first ??= t;
      o.last = t;
      o.count += 1;
    },
    raw(event) {
      const api = own(event, "api");
      if (api === "anthropic-messages") {
        const provider = own(event, "provider"),
          model = own(event, "model");
        const data = own(event, "data"),
          type = own(data, "type");
        const poison = (): void => {
          anthropicTainted = true;
          if (lane) lane.invalid = true;
        };
        const invalidate = (): void => {
          if (lane && !lane.external) lane.invalid = true;
          else poison();
        };
        if (type === "message_start") {
          const id = own(own(data, "message"), "id");
          if (
            !isGenerationId(id) ||
            typeof provider !== "string" ||
            typeof model !== "string" ||
            (lane && (!lane.closed || (capture && !lane.external)))
          ) {
            poison();
            return;
          }
          lane = { provider, model, id, external: !capture, terminal: false, closed: false, invalid: anthropicTainted };
          return;
        }
        if (type === "message_delta" || type === "message_stop") {
          if (
            !lane ||
            lane.closed ||
            lane.provider !== provider ||
            lane.model !== model ||
            (lane.external && capture)
          ) {
            poison();
            return;
          }
          if (type === "message_stop") {
            if (!lane.terminal) {
              invalidate();
              return;
            }
            lane.closed = true;
            return;
          }
          const stop = own(own(data, "delta"), "stop_reason");
          const tokens = own(own(data, "usage"), "output_tokens");
          const mapped =
            stop === "end_turn" || stop === "stop_sequence"
              ? "stop"
              : stop === "max_tokens"
                ? "length"
                : stop === "tool_use"
                  ? "toolUse"
                  : undefined;
          if (
            lane.terminal ||
            mapped === undefined ||
            typeof tokens !== "number" ||
            !Number.isSafeInteger(tokens) ||
            tokens < 1 ||
            tokens > 10_000_000
          ) {
            invalidate();
            return;
          }
          lane.terminal = true;
          if (!lane.external) {
            lane.stop = mapped;
            lane.tokens = tokens;
          }
          return;
        }
        if (type === "ping" || type === "content_block_stop") return;
        if (type === "content_block_delta") {
          const deltaType = own(own(data, "delta"), "type");
          if (deltaType === "signature_delta") return;
          if (deltaType !== "text_delta" && deltaType !== "thinking_delta" && deltaType !== "input_json_delta") {
            invalidate();
            return;
          }
        } else if (type !== "content_block_start") {
          invalidate();
          return;
        }
        if (
          !lane ||
          lane.closed ||
          lane.terminal ||
          lane.provider !== provider ||
          lane.model !== model ||
          (lane.external && capture)
        )
          invalidate();
        return;
      }
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
      if (!capture || (api !== "openai-responses" && api !== "openai-codex-responses")) return;
      const provider = own(event, "provider"),
        model = own(event, "model");
      const data = own(event, "data"),
        response = own(data, "response"),
        type = own(data, "type");
      const id =
        type === "response.completed" || type === "response.created"
          ? own(response, "id")
          : (own(response, "id") ?? own(data, "response_id"));
      if (responses === undefined) {
        if (type !== "response.created" || !isGenerationId(id) || !isGenerationId(provider) || !isGenerationId(model))
          return;
        responses = {
          binding: { responseId: id, provider, api, model },
          created: true,
          invalid: false,
          completed: false,
        };
        return;
      }
      const r = responses,
        b = r.binding;
      if (provider !== b.provider || api !== b.api || model !== b.model) return;
      if (type === "response.created") {
        if (r.created || r.completed || id !== b.responseId) r.invalid = true;
        else r.created = true;
        return;
      }
      if (r.completed && (id === b.responseId || !isGenerationId(id))) {
        r.invalid = true;
        return;
      }
      if (id !== b.responseId) return;
      if (
        type === "response.incomplete" ||
        type === "response.failed" ||
        type === "error" ||
        type === "response.error"
      ) {
        r.invalid = true;
        return;
      }
      if (type !== "response.completed") return;
      r.completed = true;
      const usage = own(response, "usage");
      const tokens = own(usage, "output_tokens");
      if (
        own(response, "status") !== "completed" ||
        typeof tokens !== "number" ||
        !Number.isSafeInteger(tokens) ||
        tokens < 1 ||
        tokens > 10_000_000
      )
        r.invalid = true;
      else r.tokens = tokens;
      const output = own(response, "output");
      if (!Array.isArray(output) || !arrayEveryOwn(output, (item) => typeof own(item, "type") === "string"))
        r.invalid = true;
    },
    end(message) {
      if (own(message, "role") !== "assistant") return undefined;
      const o = observation;
      clear();
      capture = false;
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
        o.tokens = chat.tokens;
      } else if (b.api === "anthropic-messages") {
        if (
          !captureOwner ||
          captureOwner.sessionId !== o.identity.sessionId ||
          captureOwner.sessionGeneration !== o.identity.sessionGeneration ||
          captureOwner.activationGeneration !== o.identity.activationGeneration ||
          captureOwner.ownerToken !== o.identity.ownerToken ||
          !lane ||
          lane.external ||
          lane.invalid ||
          anthropicTainted ||
          !lane.terminal ||
          lane.id !== b.responseId ||
          lane.provider !== b.provider ||
          lane.model !== b.model ||
          lane.stop !== own(message, "stopReason") ||
          lane.tokens === undefined
        )
          return undefined;
        o.tokens = lane.tokens;
      } else {
        if (
          !captureOwner ||
          captureOwner.sessionId !== o.identity.sessionId ||
          captureOwner.sessionGeneration !== o.identity.sessionGeneration ||
          captureOwner.activationGeneration !== o.identity.activationGeneration ||
          captureOwner.ownerToken !== o.identity.ownerToken ||
          !responses ||
          responses.invalid ||
          !responses.completed ||
          !sameBinding(responses.binding, b) ||
          responses.tokens === undefined
        )
          return undefined;
        o.tokens = responses.tokens;
      }
      const stopReason = own(message, "stopReason");
      if (stopReason !== "stop" && stopReason !== "length" && stopReason !== "toolUse") return undefined;
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
            own(item, "type") === "thinking" ||
            own(item, "type") === "redacted_thinking",
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
