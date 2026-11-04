import { createHash, randomUUID } from "node:crypto";
import { clampSpanMs } from "../../core/deadline.js";

/** Host-only provenance. No reference enters parameters, prompts, diagnostics or wire.
 * Process park: 64 grants, <=30 min, lazy expiry, pure data only (reload safe).
 * A released none claim stays bound to the SAME invocation and target.
 */
export interface HumanGrantRef {
  readonly id: string;
}
export interface InvocationRef {
  sessionId: string;
  runKey: string;
  contextSeq: number;
  toolCallId: string;
  toolName: string;
  owner: string;
}
export interface HumanGrantClaim {
  grantId: string;
  claimId: string;
  call: InvocationRef;
  targetSessionId: string;
}
export interface HumanGrantPort {
  issue(input: {
    inputId: string;
    sessionId: string;
    via: "interactive" | "rpc" | "web";
    issuedAt: number;
    owner: string;
  }): HumanGrantRef | undefined;
  bindContext(ref: HumanGrantRef, runKey: string, contextSeq: number): boolean;
  linkInvocation(parent: InvocationRef, childRunId: string): void;
  resolve(call: InvocationRef): HumanGrantRef | undefined;
  reserve(ref: HumanGrantRef, call: InvocationRef, targetSessionId: string): HumanGrantClaim | undefined;
  commit(claim: HumanGrantClaim): void;
  releaseNone(claim: HumanGrantClaim): void;
  revokeSession(sessionId: string): void;
}
interface Grant {
  id: string;
  inputId: string;
  sessionId: string;
  owner: string;
  expiresAt: number;
  rootRunKey?: string;
  contexts: Array<{ runKey: string; contextSeq: number; owner: string }>;
  calls: InvocationRef[];
  children: string[];
  claim?: HumanGrantClaim;
  state: "available" | "reserved" | "consumed";
}
interface Edge {
  sessionId: string;
  parent: string;
  child: string;
  at: number;
}
interface Park {
  grants: Grant[];
  edges: Edge[];
}
const KEY = Symbol.for("pi-subagent:xs-human-grants");
export const HUMAN_GRANT_CAP = 64;
export const HUMAN_GRANT_TTL_MS = clampSpanMs(30 * 60_000)!;
function park(): Park {
  const g = globalThis as unknown as Record<symbol, Park | undefined>;
  return g[KEY] ?? (g[KEY] = { grants: [], edges: [] });
}
const sameCall = (a: InvocationRef, b: InvocationRef) =>
  a.sessionId === b.sessionId &&
  a.owner === b.owner &&
  a.runKey === b.runKey &&
  a.contextSeq === b.contextSeq &&
  a.toolCallId === b.toolCallId &&
  a.toolName === b.toolName;

export function createHumanGrantPort(
  data: Park = { grants: [], edges: [] },
  now: () => number = Date.now,
): HumanGrantPort & {
  registerInvocation(call: InvocationRef): void;
  discardInput(ref: HumanGrantRef): void;
  endRun(sessionId: string, runKey: string): void;
  observeSpawnEdge(sessionId: string, parent: string, child: string): void;
} {
  const sweep = () => {
    data.grants = data.grants.filter((g) => now() < g.expiresAt);
    data.edges = data.edges.filter((e) => now() < e.at + HUMAN_GRANT_TTL_MS);
  };
  const find = (ref: HumanGrantRef) => {
    sweep();
    return data.grants.find((g) => g.id === ref.id);
  };
  const resolve = (call: InvocationRef): HumanGrantRef | undefined => {
    sweep();
    const g = data.grants.find((g) => g.sessionId === call.sessionId && g.calls.some((c) => sameCall(c, call)));
    return g ? { id: g.id } : undefined;
  };
  return {
    issue(input) {
      sweep();
      if (
        !input.inputId ||
        !input.sessionId ||
        !input.owner ||
        !Number.isFinite(input.issuedAt) ||
        input.issuedAt > now() ||
        now() >= input.issuedAt + HUMAN_GRANT_TTL_MS
      )
        return undefined;
      const existing = data.grants.find((g) => g.inputId === input.inputId && g.sessionId === input.sessionId);
      if (existing) return existing.owner === input.owner ? { id: existing.id } : undefined;
      if (data.grants.length >= HUMAN_GRANT_CAP) return undefined;
      const id = randomUUID();
      data.grants.push({
        id,
        inputId: input.inputId,
        sessionId: input.sessionId,
        owner: input.owner,
        expiresAt: input.issuedAt + HUMAN_GRANT_TTL_MS,
        contexts: [],
        calls: [],
        children: [],
        state: "available",
      });
      return { id };
    },
    bindContext(ref, runKey, contextSeq) {
      const g = find(ref);
      if (!g || !runKey || !Number.isSafeInteger(contextSeq) || contextSeq < 1) return false;
      if (g.rootRunKey === undefined) g.rootRunKey = runKey;
      if (g.rootRunKey !== runKey && !g.children.includes(runKey)) return false;
      if (g.contexts.length >= 256) return false;
      if (!g.contexts.some((c) => c.runKey === runKey && c.contextSeq === contextSeq))
        g.contexts.push({ runKey, contextSeq, owner: g.owner });
      return true;
    },
    discardInput(ref) {
      data.grants = data.grants.filter(
        (g) => g.id !== ref.id || g.contexts.length > 0 || g.claim !== undefined || g.children.length > 0,
      );
    },
    registerInvocation(call) {
      sweep();
      for (const g of data.grants) {
        if (g.sessionId !== call.sessionId || g.calls.length >= 256) continue;
        const bound = g.contexts.some(
          (c) => c.runKey === call.runKey && c.contextSeq === call.contextSeq && c.owner === call.owner,
        );
        if (bound && !g.calls.some((c) => sameCall(c, call))) g.calls.push({ ...call });
      }
    },
    observeSpawnEdge(sessionId, parent, child) {
      sweep();
      if (data.edges.length < 256 && !data.edges.some((e) => e.child === child))
        data.edges.push({ sessionId, parent, child, at: now() });
    },
    linkInvocation(parent, childRunId) {
      const ref = resolve(parent);
      const g = ref && find(ref);
      // A tool result alone is not an edge; a model-supplied runId cannot manufacture one.
      const edge = data.edges.find(
        (e) =>
          e.sessionId === parent.sessionId &&
          e.child === childRunId &&
          e.parent === (g?.rootRunKey === parent.runKey ? "root" : parent.runKey),
      );
      if (!g || !edge || parent.toolName !== "Agent" || g.children.length >= 64) return;
      if (!g.children.includes(childRunId)) g.children.push(childRunId);
    },
    resolve,
    reserve(ref, call, targetSessionId) {
      const g = find(ref);
      if (!g || g.state !== "available" || resolve(call)?.id !== ref.id || !targetSessionId) return undefined;
      if (g.claim && (!sameCall(g.claim.call, call) || g.claim.targetSessionId !== targetSessionId)) return undefined;
      const claim = g.claim ?? { grantId: ref.id, claimId: randomUUID(), call: { ...call }, targetSessionId };
      g.claim = claim;
      g.state = "reserved";
      return { ...claim, call: { ...claim.call } };
    },
    commit(claim) {
      const g = find({ id: claim.grantId });
      if (
        g?.claim?.claimId === claim.claimId &&
        sameCall(g.claim.call, claim.call) &&
        g.claim.targetSessionId === claim.targetSessionId &&
        g.state === "reserved"
      )
        g.state = "consumed";
    },
    releaseNone(claim) {
      const g = find({ id: claim.grantId });
      if (
        g?.claim?.claimId === claim.claimId &&
        sameCall(g.claim.call, claim.call) &&
        g.claim.targetSessionId === claim.targetSessionId
      )
        g.state = "available";
    },
    endRun(sessionId, runKey) {
      sweep();
      data.grants = data.grants.filter((g) => {
        if (g.sessionId !== sessionId) return true;
        g.contexts = g.contexts.filter((c) => c.runKey !== runKey);
        g.calls = g.calls.filter((c) => c.runKey !== runKey);
        g.children = g.children.filter((c) => c !== runKey);
        return g.contexts.length > 0 || g.children.length > 0;
      });
    },
    revokeSession(sessionId) {
      data.grants = data.grants.filter((g) => g.sessionId !== sessionId);
      data.edges = data.edges.filter((e) => e.sessionId !== sessionId);
    },
  };
}
export function getHumanGrantPort(): ReturnType<typeof createHumanGrantPort> {
  return createHumanGrantPort(park());
}

/** Web dispatch proof is minted only immediately before a policy-admitted host send.
 * Pure data, 64 pending, 5 min, unique session/text/owner; consumed once. No model API.
 */
interface WebProof {
  sessionId: string;
  owner: string;
  inputId: string;
  text: string;
  at: number;
}
const WEB_PROOF_TTL_MS = clampSpanMs(5 * 60_000)!;
const WEB_KEY = Symbol.for("pi-subagent:xs-human-web-inputs");
function webProofs(): WebProof[] {
  const g = globalThis as unknown as Record<symbol, WebProof[] | undefined>;
  return g[WEB_KEY] ?? (g[WEB_KEY] = []);
}
export function noteHumanWebDispatch(proof: WebProof): void {
  const list = webProofs();
  for (let i = list.length - 1; i >= 0; i--) if (Date.now() >= list[i]!.at + WEB_PROOF_TTL_MS) list.splice(i, 1);
  if (list.length < 64 && !list.some((p) => p.inputId === proof.inputId && p.owner === proof.owner))
    list.push({ ...proof });
}
export function takeHumanWebDispatch(sessionId: string, text: string): WebProof | undefined {
  const list = webProofs();
  const matches = list.filter(
    (p) => p.sessionId === sessionId && p.text === text && Date.now() < p.at + WEB_PROOF_TTL_MS,
  );
  // Ambiguous candidates are ALL consumed, so a later retry cannot turn ambiguity into proof.
  for (const p of matches) list.splice(list.indexOf(p), 1);
  return matches.length === 1 ? matches[0] : undefined;
}
export function revokeHumanWebDispatch(owner: string): void {
  const list = webProofs();
  for (let i = list.length - 1; i >= 0; i--) if (list[i]!.owner === owner) list.splice(i, 1);
}

/** Per-activation host adapter. Queued input cannot replace the current context grant.
 * Only host-observed user messages subsequently present in context bind an input.
 * This adapter never reads model input.source/meta/grantId.
 */
export function createHumanGrantHost(port = getHumanGrantPort(), owner = randomUUID()) {
  let runKey = randomUUID();
  let contextSeq = 0;
  let active: HumanGrantRef | undefined;
  const pending: Array<{ sessionId: string; text: string; ref: HumanGrantRef; expiresAt: number }> = [];
  const accepted: Array<{ sessionId: string; message: unknown; ref: HumanGrantRef; fingerprint?: string }> = [];
  // pi emitContext structured-clones the raw messages. Correlate that clone only with
  // the exact host-observed snapshot (including host timestamp), never text/source/meta.
  // The digest is local evidence, not a credential; it never enters tool/wire/prompt.
  const fingerprint = (raw: unknown): string | undefined => {
    try {
      const m = raw as { role?: unknown; timestamp?: unknown } | undefined;
      if (m?.role !== "user" || !Number.isSafeInteger(m.timestamp) || (m.timestamp as number) < 0) return undefined;
      const encoded = JSON.stringify(raw);
      if (encoded === undefined || encoded.length > 65_536) return undefined;
      return createHash("sha256").update(encoded).digest("hex");
    } catch {
      return undefined;
    }
  };
  const calls = new Map<string, InvocationRef>();
  const userText = (raw: unknown): string | undefined => {
    const m = raw as { role?: unknown; content?: unknown } | undefined;
    if (m?.role !== "user") return undefined;
    if (typeof m.content === "string") return m.content;
    if (!Array.isArray(m.content)) return undefined;
    return m.content
      .filter((b): b is { type: "text"; text: string } => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  };
  return {
    input(event: { source: string; text: string }, sessionId: string) {
      for (let i = pending.length - 1; i >= 0; i--) if (Date.now() >= pending[i]!.expiresAt) pending.splice(i, 1);
      if (pending.length >= HUMAN_GRANT_CAP) return;
      const web = event.source === "extension" ? takeHumanWebDispatch(sessionId, event.text) : undefined;
      const via = event.source === "interactive" || event.source === "rpc" ? event.source : web ? "web" : undefined;
      if (!via) return;
      const ref = port.issue({ sessionId, owner, via, inputId: web?.inputId ?? randomUUID(), issuedAt: Date.now() });
      if (ref) pending.push({ sessionId, text: event.text, ref, expiresAt: Date.now() + HUMAN_GRANT_TTL_MS });
    },
    handled(text: string, sessionId: string) {
      for (let i = pending.length - 1; i >= 0; i--) {
        const p = pending[i]!;
        if (p.sessionId === sessionId && p.text === text) {
          port.discardInput(p.ref);
          pending.splice(i, 1);
        }
      }
    },
    message(message: unknown, sessionId: string) {
      const text = userText(message);
      if (text === undefined) return;
      const matches = pending.filter((p) => p.sessionId === sessionId && p.text === text);
      for (const p of matches) pending.splice(pending.indexOf(p), 1);
      if (matches.length === 1 && accepted.length < HUMAN_GRANT_CAP) {
        const digest = fingerprint(message);
        accepted.push({
          sessionId,
          message,
          ref: matches[0]!.ref,
          ...(digest === undefined ? {} : { fingerprint: digest }),
        });
      }
    },
    context(event: unknown, sessionId: string) {
      const messages = (event as { messages?: unknown[] } | undefined)?.messages;
      if (!Array.isArray(messages)) {
        active = undefined;
        return;
      }
      const relevant = accepted.filter((a) => a.sessionId === sessionId);
      const indices = new Map<unknown, number[]>();
      const byFingerprint = new Map<string, number[]>();
      if (relevant.length > 0) {
        for (let i = Math.max(0, messages.length - 2_000); i < messages.length; i++) {
          const message = messages[i];
          const positions = indices.get(message) ?? [];
          positions.push(i);
          indices.set(message, positions);
          const digest = fingerprint(message);
          if (digest !== undefined) {
            const positions = byFingerprint.get(digest) ?? [];
            positions.push(i);
            byFingerprint.set(digest, positions);
          }
        }
      }
      const proven: Array<{ input: (typeof accepted)[number]; index: number }> = [];
      for (const input of relevant) {
        const matches =
          input.fingerprint === undefined
            ? (indices.get(input.message) ?? [])
            : (byFingerprint.get(input.fingerprint) ?? []);
        const uniqueInput =
          input.fingerprint === undefined || relevant.filter((a) => a.fingerprint === input.fingerprint).length === 1;
        if (matches.length > 1 || !uniqueInput) {
          port.discardInput(input.ref);
          accepted.splice(accepted.indexOf(input), 1); // ambiguity never becomes proof on retry
        } else if (matches.length === 1) proven.push({ input, index: matches[0]! });
      }
      if (proven.length > 0) {
        const latest = proven.reduce((a, b) => (a.index > b.index ? a : b));
        active = latest.input.ref;
        for (const p of proven) accepted.splice(accepted.indexOf(p.input), 1);
      }
      contextSeq++;
      if (active && !port.bindContext(active, runKey, contextSeq)) active = undefined;
    },
    toolCall(toolCallId: string, toolName: string, sessionId: string, parentToolCallId?: string) {
      if (calls.has(toolCallId) || calls.size >= 256 || contextSeq === 0) return;
      const parent = parentToolCallId ? calls.get(parentToolCallId) : undefined;
      if (parentToolCallId && !parent) return;
      const call: InvocationRef = { sessionId, owner, runKey, contextSeq, toolCallId, toolName };
      calls.set(toolCallId, call);
      port.registerInvocation(call);
    },
    invocation(toolCallId: string, toolName: string): InvocationRef | undefined {
      const call = calls.get(toolCallId);
      return call?.toolName === toolName ? { ...call } : undefined;
    },
    toolResult(toolCallId: string, toolName: string, details: unknown, isError: boolean) {
      const call = calls.get(toolCallId);
      const child = (details as { runId?: unknown } | undefined)?.runId;
      if (!isError && toolName === "Agent" && call && typeof child === "string") port.linkInvocation(call, child);
    },
    end(sessionId: string) {
      port.endRun(sessionId, runKey);
      runKey = randomUUID();
      contextSeq = 0;
      active = undefined;
      calls.clear();
      accepted.length = 0;
    },
    revoke(sessionId: string) {
      port.revokeSession(sessionId);
      pending.length = 0;
      accepted.length = 0;
      runKey = randomUUID();
      contextSeq = 0;
      active = undefined;
      calls.clear();
    },
  };
}
