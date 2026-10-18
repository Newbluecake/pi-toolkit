import { createHash } from "node:crypto";
import type { AnchorIdentity, ConsultAnchorSpec, ConsultAnchorStatus } from "../core/types.js";

/** Trusted, process-local metadata only: never retain the provider body here. */
export type AnchorObservation =
  | { state: "added" | "relocated"; identity: AnchorIdentity; degraded?: true }
  | { state: Exclude<ConsultAnchorStatus, "added" | "relocated">; identity?: AnchorIdentity; degraded?: true };
export type AnchorDecision = AnchorObservation & { payload: unknown };

// P0 M7 requires the full anchored shape + readback, not merely 1h landing.
// This does NOT establish 1h survival or change the default prediction TTL (5m).
export const ANCHOR_1H_ROUTES = Object.freeze(["cr-anthropic/claude-opus-5-5"] as const);
const BLOCK_TYPES: readonly string[] = Object.freeze(["text", "tool_use", "tool_result", "image"]);
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as ObjectValue) : undefined;
}
export function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl);
  const source = object(value);
  if (!source) return value;
  return Object.fromEntries(
    Object.entries(source)
      .filter(([key]) => key !== "cache_control")
      .map(([key, child]) => [key, withoutCacheControl(child)]),
  );
}
function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "undefined", "utf8")
    .digest("hex");
}
export interface MessageBreakpointShape {
  last: number;
  lastBlock: number;
  points: Array<{ message: number; block: number; ttl: string }>;
}
export function messageBreakpointShape(messages: unknown): MessageBreakpointShape | undefined {
  if (!Array.isArray(messages)) return undefined;
  const shape: MessageBreakpointShape = { last: -1, lastBlock: -1, points: [] };
  messages.forEach((message, index) => {
    const m = object(message);
    if (m?.role === "user" || m?.role === "tool_result") {
      shape.last = index;
      shape.lastBlock = Array.isArray(m.content) ? m.content.length - 1 : -1;
    }
    if (!Array.isArray(m?.content)) return;
    m.content.forEach((block: unknown, blockIndex: number) => {
      const b = object(block);
      if (b?.cache_control === undefined) return;
      const ttl = object(b.cache_control)?.ttl;
      shape.points.push({ message: index, block: blockIndex, ttl: typeof ttl === "string" ? ttl : "" });
    });
  });
  return shape;
}
/** One status table shared by raw-body and hashed comparisons. */
export function compareMessageBreakpoints(
  expert: MessageBreakpointShape | undefined,
  consult: MessageBreakpointShape | undefined,
  anchor?: AnchorObservation,
): boolean {
  if (!expert || !consult || expert.points.some((point) => point.message !== expert.last)) return false;
  const expertTtls = expert.points.map((point) => point.ttl);
  if (anchor?.state !== "added" && anchor?.state !== "relocated") {
    return (
      consult.points.every((point) => point.message === consult.last) &&
      JSON.stringify(expertTtls) === JSON.stringify(consult.points.map((point) => point.ttl))
    );
  }
  const identity = anchor.identity;
  const atAnchor = consult.points.filter((point) => point.message === identity.k - 1 && point.block === identity.block);
  if (
    atAnchor.length !== 1 ||
    atAnchor[0]?.ttl !== identity.ttl ||
    expertTtls.length !== 1 ||
    expertTtls[0] !== identity.ttl
  )
    return false;
  const rest = consult.points.filter((point) => point !== atAnchor[0]);
  return anchor.state === "relocated"
    ? rest.length === 0 && identity.k - 1 !== consult.last
    : rest.length === 1 &&
        rest[0]?.message === consult.last &&
        rest[0].block === consult.lastBlock &&
        rest[0].ttl === identity.ttl &&
        identity.k - 1 !== consult.last;
}
/** Provider cache markers, in Anthropic cache-prefix order (tools → system → messages).
 * Never descend into schemas, tool inputs or tool-result data: those may contain
 * application properties called cache_control that are not breakpoints.
 */
function providerCacheControls(payload: unknown): unknown[] {
  const body = object(payload);
  const controls: unknown[] = [];
  const add = (block: unknown) => {
    const marker = object(block)?.cache_control;
    if (marker !== undefined) controls.push(marker);
  };
  for (const field of ["tools", "system"] as const) {
    const blocks = body?.[field];
    if (Array.isArray(blocks)) blocks.forEach(add);
  }
  if (Array.isArray(body?.messages)) {
    for (const message of body.messages) {
      const content = object(message)?.content;
      if (Array.isArray(content)) content.forEach(add);
    }
  }
  return controls;
}
function countBreakpoints(payload: unknown): number {
  return providerCacheControls(payload).length;
}
function validTtlOrder(payload: unknown): boolean {
  let shortSeen = false;
  for (const marker of providerCacheControls(payload)) {
    if (object(marker)?.ttl === "1h") {
      if (shortSeen) return false;
    } else shortSeen = true; // omitted ttl is Anthropic's 5m default
  }
  return true;
}
function routeFor(model: unknown): AnchorIdentity["route"] | undefined {
  const m = object(model);
  return typeof m?.provider === "string" && typeof m.id === "string" && typeof m.api === "string"
    ? { provider: m.provider, model: m.id, api: m.api }
    : undefined;
}
/** Verify content identities without trusting a cache marker as a coordinate source. */
export function anchorIdentityMatches(
  payload: unknown,
  identity: AnchorIdentity,
  route?: AnchorIdentity["route"],
): boolean {
  const body = object(payload);
  const messages = body?.messages;
  if (
    !Array.isArray(messages) ||
    !Number.isSafeInteger(identity.k) ||
    identity.k < 1 ||
    identity.k >= messages.length ||
    !Number.isSafeInteger(identity.block) ||
    identity.block < 0
  )
    return false;
  const content = object(messages[identity.k - 1])?.content;
  return (
    Array.isArray(content) &&
    object(content[identity.block])?.type === identity.blockType &&
    BLOCK_TYPES.includes(identity.blockType) &&
    hash(withoutCacheControl(content[identity.block])) === identity.blockHash &&
    hash(withoutCacheControl(messages.slice(0, identity.k))) === identity.prefixHash &&
    hash(body?.system) === identity.systemHash &&
    hash(body?.tools) === identity.toolsHash &&
    (route === undefined ||
      (route.provider === identity.route.provider &&
        route.model === identity.route.model &&
        route.api === identity.route.api))
  );
}

/** Pure placement. Coordinates are derived only from the host prompt or a trusted base identity. */
export function resolveAnchor(
  payload: unknown,
  spec: ConsultAnchorSpec,
  model: unknown,
  options: { identity?: AnchorIdentity; first?: boolean } = {},
): AnchorDecision {
  const body = object(payload);
  const route = routeFor(model);
  const skip = (state: AnchorObservation["state"], degraded?: true): AnchorDecision =>
    ({ payload, state, ...(degraded ? { degraded } : {}) }) as AnchorDecision;
  if (object(model)?.api !== "anthropic-messages" || countBreakpoints(payload) === 0) return skip("n/a");
  if (!body || !Array.isArray(body.messages) || !route) return skip("skipped:shape");
  const messages = body.messages;
  const shape = messageBreakpointShape(messages)!;
  // Only pi's one default message breakpoint is eligible for copying/moving.
  const lastPoint = shape.points[0];
  if (shape.points.length !== 1 || lastPoint?.message !== shape.last) return skip("skipped:shape");
  const lastContent = object(messages[lastPoint.message])?.content;
  if (!Array.isArray(lastContent) || lastPoint.block !== lastContent.length - 1) return skip("skipped:shape");
  const cacheControl = object(object(lastContent[lastPoint.block])?.cache_control);
  if (!cacheControl || cacheControl.type !== "ephemeral") return skip("skipped:shape");
  const ttl = typeof cacheControl.ttl === "string" ? cacheControl.ttl : "";
  const total = countBreakpoints(payload);
  const degraded = total >= 4 ? true : undefined;
  let identity = options.identity ?? spec.base;
  if (!identity) {
    const question = object(messages.at(-1));
    const content = question?.content;
    if (
      question?.role !== "user" ||
      !Array.isArray(content) ||
      content.length !== 1 ||
      object(content[0])?.type !== "text" ||
      object(content[0])?.text !== spec.prompt ||
      messages.length < 2
    )
      return skip("skipped:shape", degraded);
    const k = messages.length - 1;
    const history = object(messages[k - 1]);
    if (!Array.isArray(history?.content)) return skip("skipped:block", degraded);
    let block = history.content.length - 1;
    while (block >= 0 && !BLOCK_TYPES.includes(String(object(history.content[block])?.type))) block--;
    if (block < 0) return skip("skipped:block", degraded);
    identity = {
      k,
      block,
      blockType: object(history.content[block])!.type as AnchorIdentity["blockType"],
      blockHash: hash(withoutCacheControl(history.content[block])),
      prefixHash: hash(withoutCacheControl(messages.slice(0, k))),
      systemHash: hash(body.system),
      toolsHash: hash(body.tools),
      route,
      ttl,
    };
  } else if (!anchorIdentityMatches(payload, identity, route) || ttl !== identity.ttl) {
    return skip("skipped:identity", degraded);
  }
  if (ttl === "1h" && !(ANCHOR_1H_ROUTES as readonly string[]).includes(`${route.provider}/${route.model}`))
    return skip("skipped:ttl-1h-unproven", degraded);
  if (ttl !== "" && ttl !== "5m" && ttl !== "1h") return skip("skipped:shape", degraded);
  const relocate = total + 1 > 4;
  if (relocate && (total !== 4 || options.first === false || spec.base !== undefined))
    return { ...skip("skipped:limit", true), identity };
  const updated = messages.map((message, index) => {
    const m = object(message);
    if (!m || !Array.isArray(m.content) || (index !== identity.k - 1 && (!relocate || index !== lastPoint.message)))
      return message;
    return {
      ...m,
      content: m.content.map((block: unknown, blockIndex: number) => {
        if (index === identity.k - 1 && blockIndex === identity.block)
          return { ...object(block), cache_control: { ...cacheControl } };
        if (relocate && index === lastPoint.message && blockIndex === lastPoint.block) {
          const { cache_control: _marker, ...rest } = object(block)!;
          return rest;
        }
        return block;
      }),
    };
  });
  const applied = { ...body, messages: updated };
  // pi-ai normally uses one TTL everywhere; fail unchanged if an extension
  // supplied a mixed shape that would put a long marker after a short one.
  if (!validTtlOrder(applied)) return skip("skipped:ttl-order", degraded);
  return {
    payload: applied,
    state: relocate ? "relocated" : "added",
    identity,
    ...(degraded ? { degraded } : {}),
  };
}
export interface ConsultAnchorInstallation {
  current(): AnchorObservation | undefined;
  close(): void;
}
/** Inner wrapper: extensions see the anchored body; the outer probe sees their final result. */
export function installConsultAnchor(session: unknown, spec: ConsultAnchorSpec): ConsultAnchorInstallation {
  const agent = object(object(session)?.agent);
  let observation: AnchorObservation | undefined;
  let identity = spec.base;
  let halted = false;
  let firstRequestKey: string | undefined;
  let advanced = false;
  let closed = false;
  const original = agent?.onPayload;
  const wrapped = async function (this: unknown, payload: unknown, model: unknown): Promise<unknown> {
    let applied = payload;
    if (!closed && !halted) {
      try {
        // Provider strict-tool fallback and AgentSession auto-retry can re-enter
        // onPayload for the same logical first request. Retain no message text.
        const requestKey = hash(withoutCacheControl(object(payload)?.messages));
        if (firstRequestKey === undefined) firstRequestKey = requestKey;
        else if (requestKey !== firstRequestKey) advanced = true;
        const decision = resolveAnchor(payload, spec, model, { ...(identity ? { identity } : {}), first: !advanced });
        const { payload: next, ...metadata } = decision;
        applied = next;
        observation = metadata;
        if (decision.identity) identity = decision.identity;
        if (
          decision.state === "skipped:shape" ||
          decision.state === "skipped:block" ||
          decision.state === "skipped:identity" ||
          decision.state === "n/a" ||
          decision.state === "skipped:ttl-order" ||
          identity === undefined
        )
          halted = true;
      } catch {
        observation = { state: "skipped:shape" };
        halted = true;
      }
    }
    const result = typeof original === "function" ? await original.call(this, applied, model) : undefined;
    return result === undefined ? applied : result;
  };
  if (agent) agent.onPayload = wrapped;
  return {
    current: () => observation,
    close() {
      closed = true;
      if (agent?.onPayload === wrapped) agent.onPayload = original;
    },
  };
}
