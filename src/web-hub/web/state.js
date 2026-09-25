/**
 * Browser-side state reducer (plan §包 E). Pure functions, no DOM, no I/O —
 * `reduce(state, msg)` never mutates its input and returns a new state (or the
 * same object when nothing changed). Runs unchanged under vitest (node).
 *
 * `msg` is either an SSE frame (`event` ∈ SSE_EVENTS, `data` = parsed JSON,
 * `id` = SSE id) or a local UI/transport event (`event` ∈ LOCAL_EVENTS).
 *
 * Dedupe rules (arch §7): transcript items from history entries are keyed by
 * entry id; non-custom messages additionally by messageKey (`role:timestamp`,
 * toolResult + `:toolCallId`); custom messages are NOT deduped by key (content
 * keys collide) — live ones are deduped by `ev` seq, appended ones by entry id.
 */

/**
 * @typedef {{ kind: string, title?: string, since: number }} Prompt
 * @typedef {{ toolCallId: string, toolName: string, args: unknown, partial?: string,
 *   result?: unknown, isError?: boolean, done: boolean, truncated?: boolean }} LiveTool
 * @typedef {{ id: string, kind: "message" | "custom" | "compaction" | "branch_summary" | "model_change",
 *   entryId?: string | undefined, seq?: number | undefined, key?: string | undefined, message?: any, entry?: any,
 *   truncated?: boolean | undefined }} Item
 * @typedef {{ clientId: string, pending: boolean, failed?: boolean }} Sub
 * @typedef {{
 *   key: string, card: any, down: boolean, downReason?: string | undefined,
 *   session?: any, status?: any, prompts: Prompt[], fleet: any[],
 *   items: Item[], keys: Set<string>, entryIds: Set<string>, uid: number,
 *   lastSeq: number, streaming: any | null, tools: LiveTool[],
 *   history: "none" | "waiting" | "loaded" | "error", historyError?: string | undefined,
 *   hasMore: boolean, oldestEntryId?: string | undefined, paging: boolean,
 *   needsResync: boolean, sub: Sub | null,
 * }} AgentState
 * @typedef {{
 *   clientId: string | null, hub: any, conn: string, lastEventId?: number,
 *   selected: string | null, agents: Map<string, AgentState>, order: string[],
 * }} State
 * @typedef {{ event: string, data: any, id?: number }} Msg
 */

/** Local (non-SSE) events understood by `reduce`. */
export const LOCAL_EVENTS = Object.freeze([
  "conn", // {state:"connecting"|"open"|"reconnecting"|"auth"}
  "select", // {agentKey}
  "subscribing", // {agentKey, clientId}
  "subscribed", // {agentKey}
  "subscribe_failed", // {agentKey, error}
  "unsubscribed", // {agentKey}
  "retry", // {agentKey}
  "paging", // {agentKey}
  "page", // HistoryPayload from GET /api/history
  "page_failed", // {agentKey, error}
]);

/** @returns {State} */
export function initialState() {
  return { clientId: null, hub: null, conn: "connecting", selected: null, agents: new Map(), order: [] };
}

/**
 * @param {any} card
 * @returns {AgentState}
 */
function newAgent(card) {
  return {
    key: String(card.agentKey),
    card,
    down: false,
    session: card.session,
    status: card.status,
    prompts: Array.isArray(card.prompts) ? card.prompts : [],
    fleet: [],
    items: [],
    keys: new Set(),
    entryIds: new Set(),
    uid: 0,
    lastSeq: -1,
    streaming: null,
    tools: [],
    history: "none",
    hasMore: false,
    paging: false,
    needsResync: false,
    sub: null,
  };
}

/**
 * Same key rule as protocol `messageKey` for non-custom roles.
 * @param {any} m
 * @returns {string | undefined}
 */
export function messageKey(m) {
  if (!m || typeof m !== "object") return undefined;
  if (m.role === "custom") return undefined; // custom: never key-deduped in the browser
  const ts = m.timestamp ?? "";
  if (m.role === "toolResult") return `${m.role}:${ts}:${typeof m.toolCallId === "string" ? m.toolCallId : ""}`;
  return `${m.role}:${ts}`;
}

/**
 * @param {State} s
 * @param {string} key
 * @param {(a: AgentState) => AgentState} fn
 * @returns {State}
 */
function updateAgent(s, key, fn) {
  const a = s.agents.get(key);
  if (!a) return s;
  const next = fn(a);
  if (next === a) return s;
  const agents = new Map(s.agents);
  agents.set(key, next);
  return { ...s, agents };
}

/**
 * @param {State} s
 * @param {Msg} msg
 * @returns {State}
 */
export function reduce(s, msg) {
  if (!msg || typeof msg.event !== "string") return s;
  const d = msg.data && typeof msg.data === "object" ? msg.data : {};
  const next = reduceInner(s, msg.event, d);
  if (typeof msg.id === "number" && Number.isFinite(msg.id) && next.lastEventId !== msg.id) {
    return { ...next, lastEventId: msg.id };
  }
  return next;
}

/**
 * @param {State} s
 * @param {string} event
 * @param {any} d
 * @returns {State}
 */
function reduceInner(s, event, d) {
  const key = typeof d.agentKey === "string" ? d.agentKey : undefined;
  switch (event) {
    // ---------------------------------------------------------------- global
    case "hello": {
      // New SSE connection ⇒ new clientId; subscriptions of the old client are gone.
      const agents = new Map();
      for (const [k, a] of s.agents) agents.set(k, a.sub ? { ...a, sub: null } : a);
      return { ...s, clientId: typeof d.clientId === "string" ? d.clientId : null, agents };
    }
    case "hub":
      return { ...s, hub: d };
    case "ping":
      return s;
    case "resync": {
      const agents = new Map();
      for (const [k, a] of s.agents) agents.set(k, a.history !== "none" ? { ...a, needsResync: true } : a);
      return { ...s, agents };
    }
    case "agents": {
      const cards = Array.isArray(d) ? d : Array.isArray(d.agents) ? d.agents : [];
      const agents = new Map();
      const order = [];
      for (const card of cards) {
        if (!card || typeof card.agentKey !== "string" || agents.has(card.agentKey)) continue;
        const old = s.agents.get(card.agentKey);
        agents.set(card.agentKey, old ? mergeCard(old, card) : newAgent(card));
        order.push(card.agentKey);
      }
      return withSelection({ ...s, agents, order });
    }
    case "agent_up": {
      const card = d.agent && typeof d.agent === "object" ? d.agent : d;
      if (typeof card.agentKey !== "string") return s;
      const agents = new Map(s.agents);
      const old = s.agents.get(card.agentKey);
      agents.set(card.agentKey, old ? mergeCard(old, card) : newAgent(card));
      const order = old ? s.order : [...s.order, card.agentKey];
      return withSelection({ ...s, agents, order });
    }
    case "agent_down":
      if (!key) return s;
      return updateAgent(s, key, (a) => ({
        ...a,
        down: true,
        downReason: typeof d.reason === "string" ? d.reason : undefined,
        card: { ...a.card, state: "stale" },
        streaming: null,
        tools: a.tools.filter((t) => t.done),
        prompts: [],
      }));
    case "agent_stale":
      if (!key) return s;
      return updateAgent(s, key, (a) => ({ ...a, card: { ...a.card, state: "stale" } }));

    // ---------------------------------------------------------------- per agent
    case "session":
      if (!key || !d.session) return s;
      return updateAgent(s, key, (a) => applySession(a, d.session));
    case "status":
      if (!key || !d.status) return s;
      return updateAgent(s, key, (a) => ({ ...a, status: d.status, card: { ...a.card, status: d.status } }));
    case "fleet":
      if (!key) return s;
      return updateAgent(s, key, (a) => ({ ...a, fleet: Array.isArray(d.runs) ? d.runs : [] }));
    case "prompt":
      if (!key) return s;
      return updateAgent(s, key, (a) => ({ ...a, prompts: Array.isArray(d.prompts) ? d.prompts : [] }));
    case "gap":
      if (!key) return s;
      return updateAgent(s, key, (a) => (a.history === "none" || a.needsResync ? a : { ...a, needsResync: true }));
    case "history":
      if (!key) return s;
      return updateAgent(s, key, (a) => applyHistory(a, d));
    case "ev":
      if (!key || typeof d.seq !== "number" || !d.e || typeof d.e.type !== "string") return s;
      return updateAgent(s, key, (a) => applyEv(a, d.seq, d.e));
    case "append":
      if (!key || !Array.isArray(d.entries)) return s;
      return updateAgent(s, key, (a) => (a.history === "loaded" ? appendEntries(a, d.entries) : a));

    // ---------------------------------------------------------------- local
    case "conn":
      return typeof d.state === "string" && d.state !== s.conn ? { ...s, conn: d.state } : s;
    case "select":
      return key && s.agents.has(key) && s.selected !== key ? { ...s, selected: key } : s;
    case "subscribing":
      if (!key || typeof d.clientId !== "string") return s;
      return updateAgent(s, key, (a) => ({
        ...a,
        sub: { clientId: d.clientId, pending: true },
        needsResync: false,
        history: a.history === "loaded" ? "loaded" : "waiting",
        historyError: undefined,
      }));
    case "subscribed":
      if (!key) return s;
      return updateAgent(s, key, (a) => (a.sub ? { ...a, sub: { ...a.sub, pending: false } } : a));
    case "subscribe_failed":
      if (!key) return s;
      return updateAgent(s, key, (a) => ({
        ...a,
        sub: a.sub ? { ...a.sub, pending: false, failed: true } : null,
        history: "error",
        historyError: String(d.error ?? "E_SUBSCRIBE"),
      }));
    case "unsubscribed":
      if (!key) return s;
      return updateAgent(s, key, (a) => ({ ...a, sub: null, history: "none", needsResync: false, paging: false }));
    case "retry":
      if (!key) return s;
      return updateAgent(s, key, (a) => ({ ...a, sub: null, needsResync: true, historyError: undefined }));
    case "paging":
      if (!key) return s;
      return updateAgent(s, key, (a) => ({ ...a, paging: true }));
    case "page":
      if (!key) return s;
      return updateAgent(s, key, (a) => applyPage(a, d));
    case "page_failed":
      if (!key) return s;
      return updateAgent(s, key, (a) => ({ ...a, paging: false }));
    default:
      return s;
  }
}

/** @param {State} s @returns {State} */
function withSelection(s) {
  if (s.selected !== null && s.agents.has(s.selected)) return s;
  const first = s.order.find((k) => !s.agents.get(k)?.down) ?? s.order[0] ?? null;
  return first === s.selected ? s : { ...s, selected: first };
}

/** @param {AgentState} a @param {any} card @returns {AgentState} */
function mergeCard(a, card) {
  /** @type {AgentState} */
  let next = {
    ...a,
    card,
    down: false,
    downReason: undefined,
    status: card.status ?? a.status,
    prompts: Array.isArray(card.prompts) ? card.prompts : a.prompts,
  };
  if (card.session) next = applySession(next, card.session);
  return next;
}

/** @param {any} a @param {any} b */
function sameSession(a, b) {
  return !!a && !!b && a.sessionId === b.sessionId && (a.sessionFile ?? null) === (b.sessionFile ?? null);
}

/**
 * Session replaced (new/resume/fork) ⇒ drop the transcript and wait for a
 * fresh `history` (the hub also pushes `gap`; `needsResync` makes the app
 * re-subscribe either way).
 * @param {AgentState} a @param {any} session @returns {AgentState}
 */
function applySession(a, session) {
  const card = { ...a.card, session };
  if (sameSession(a.session, session) || a.session === undefined) return { ...a, session, card };
  if (a.history === "none") return { ...a, session, card, items: [], keys: new Set(), entryIds: new Set() };
  return {
    ...a,
    session,
    card,
    items: [],
    keys: new Set(),
    entryIds: new Set(),
    lastSeq: -1,
    streaming: null,
    tools: [],
    history: "waiting",
    hasMore: false,
    oldestEntryId: undefined,
    paging: false,
    needsResync: true,
  };
}

// ---------------------------------------------------------------------------
// history / entries
// ---------------------------------------------------------------------------

/**
 * @param {any} entry
 * @returns {Omit<Item, "id"> | undefined}
 */
function entryItem(entry) {
  if (!entry || typeof entry !== "object" || typeof entry.id !== "string") return undefined;
  const base = { entryId: entry.id, truncated: entry.truncated === true };
  switch (entry.type) {
    case "message":
      if (!entry.message || typeof entry.message !== "object") return undefined;
      return { ...base, kind: "message", message: entry.message, key: messageKey(entry.message) };
    case "custom_message":
      if (entry.display === false) return undefined;
      return { ...base, kind: "custom", entry };
    case "compaction":
      return { ...base, kind: "compaction", entry };
    case "branch_summary":
      return { ...base, kind: "branch_summary", entry };
    case "model_change":
      return { ...base, kind: "model_change", entry };
    default:
      return undefined; // custom(data), thinking_level_change: not rendered
  }
}

/**
 * Build items from entries, skipping ones already present (entry id, or
 * non-custom messageKey).
 * @param {AgentState} a @param {any[]} entries
 * @returns {{ items: Item[], keys: Set<string>, entryIds: Set<string>, uid: number }}
 */
function buildItems(a, entries) {
  const keys = new Set(a.keys);
  const entryIds = new Set(a.entryIds);
  let uid = a.uid;
  /** @type {Item[]} */
  const items = [];
  for (const entry of entries) {
    if (!entry || typeof entry.id !== "string" || entryIds.has(entry.id)) continue;
    entryIds.add(entry.id);
    const it = entryItem(entry);
    if (!it) continue;
    if (it.key !== undefined) {
      if (keys.has(it.key)) continue;
      keys.add(it.key);
    }
    items.push({ ...it, id: `e:${entry.id}:${uid++}` });
  }
  return { items, keys, entryIds, uid };
}

/** @param {AgentState} a @param {any} d @returns {AgentState} */
function applyHistory(a, d) {
  if (d.error !== undefined && d.error !== null) {
    return { ...a, history: "error", historyError: String(d.error), sub: a.sub ? { ...a.sub, pending: false } : a.sub };
  }
  const fresh = { ...a, items: [], keys: new Set(), entryIds: new Set() };
  const built = buildItems(fresh, Array.isArray(d.entries) ? d.entries : []);
  let uid = built.uid;
  const items = built.items;
  const keys = built.keys;
  for (const m of Array.isArray(d.tailMessages) ? d.tailMessages : []) {
    const it = messageItem(m, keys, `t:${uid++}`);
    if (it) items.push(it);
  }
  const inflight = d.inflight && typeof d.inflight === "object" ? d.inflight : undefined;
  const tools = Array.isArray(inflight?.tools)
    ? inflight.tools
        .filter((/** @type {any} */ t) => t && typeof t.toolCallId === "string")
        .map((/** @type {any} */ t) => ({
          toolCallId: t.toolCallId,
          toolName: String(t.toolName ?? ""),
          args: t.args,
          ...(typeof t.partial === "string" ? { partial: t.partial } : {}),
          done: false,
        }))
    : [];
  const fromSeq = typeof d.fromSeq === "number" ? d.fromSeq : 0;
  return {
    ...a,
    items,
    keys,
    entryIds: built.entryIds,
    uid,
    lastSeq: fromSeq - 1,
    streaming: inflight?.message ? cloneMessage(inflight.message) : null,
    tools,
    history: "loaded",
    historyError: undefined,
    hasMore: d.hasMore === true,
    oldestEntryId: typeof d.oldestEntryId === "string" ? d.oldestEntryId : undefined,
    paging: false,
    needsResync: false,
    sub: a.sub ? { ...a.sub, pending: false } : a.sub,
  };
}

/** @param {AgentState} a @param {any} d @returns {AgentState} */
function applyPage(a, d) {
  if (a.history !== "loaded") return { ...a, paging: false };
  const built = buildItems(a, Array.isArray(d.entries) ? d.entries : []);
  return {
    ...a,
    items: [...built.items, ...a.items],
    keys: built.keys,
    entryIds: built.entryIds,
    uid: built.uid,
    hasMore: d.hasMore === true,
    oldestEntryId: typeof d.oldestEntryId === "string" ? d.oldestEntryId : a.oldestEntryId,
    paging: false,
  };
}

/** SSE `append` (spike K7④): entries the event stream never carried. @param {AgentState} a @param {any[]} entries */
function appendEntries(a, entries) {
  const built = buildItems(a, entries);
  if (built.items.length === 0 && built.entryIds.size === a.entryIds.size) return a;
  return { ...a, items: [...a.items, ...built.items], keys: built.keys, entryIds: built.entryIds, uid: built.uid };
}

/**
 * @param {any} m @param {Set<string>} keys (mutated: caller owns a fresh copy) @param {string} id
 * @param {number} [seq]
 * @returns {Item | undefined}
 */
function messageItem(m, keys, id, seq) {
  if (!m || typeof m !== "object" || typeof m.role !== "string") return undefined;
  const key = messageKey(m);
  if (key !== undefined) {
    if (keys.has(key)) return undefined;
    keys.add(key);
  }
  if (m.role === "custom" && m.display === false) return undefined;
  /** @type {Item} */
  const it = { id, kind: "message", message: m, truncated: m.truncated === true };
  if (key !== undefined) it.key = key;
  if (seq !== undefined) it.seq = seq;
  return it;
}

// ---------------------------------------------------------------------------
// live events
// ---------------------------------------------------------------------------

/** @param {AgentState} a @param {number} seq @param {any} e @returns {AgentState} */
function applyEv(a, seq, e) {
  if (a.history !== "loaded") return a; // buffered by the hub and replayed after `history`
  if (seq <= a.lastSeq) return a; // duplicate (ring replay / buffered overlap)
  const jumped = a.lastSeq >= 0 && seq > a.lastSeq + 1;
  const next = applyEvent({ ...a, lastSeq: seq }, seq, e);
  return jumped && !next.needsResync ? { ...next, needsResync: true } : next;
}

/** @param {any} m */
function cloneMessage(m) {
  const content = Array.isArray(m.content)
    ? m.content.map((/** @type {any} */ b) => (b && typeof b === "object" ? { ...b } : b))
    : m.content;
  return { ...m, content };
}

/**
 * Classify a message_update delta. Accepts both the flat wire form
 * (`{contentIndex, delta, kind|deltaType}`) and pi's nested
 * `assistantMessageEvent` form.
 * @param {any} e
 */
function deltaParts(e) {
  const ame = e.assistantMessageEvent && typeof e.assistantMessageEvent === "object" ? e.assistantMessageEvent : {};
  const tag = String(e.deltaType ?? e.kind ?? e.updateType ?? ame.type ?? "");
  const kind = /thinking/i.test(tag) ? "thinking" : /tool/i.test(tag) ? "toolCall" : "text";
  const index =
    typeof e.contentIndex === "number" ? e.contentIndex : typeof ame.contentIndex === "number" ? ame.contentIndex : 0;
  const delta = typeof e.delta === "string" ? e.delta : typeof ame.delta === "string" ? ame.delta : undefined;
  const content = e.content ?? ame.content;
  const toolCall = e.toolCall ?? ame.toolCall;
  return { kind, index, delta, content, toolCall };
}

/** @param {any} streaming @param {any} e */
function applyDelta(streaming, e) {
  const msg = streaming ? cloneMessage(streaming) : { role: "assistant", content: [] };
  if (!Array.isArray(msg.content))
    msg.content = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : [];
  const { kind, index, delta, content, toolCall } = deltaParts(e);
  // Payload-less updates (e.g. assistantMessageEvent type done/error) carry nothing to merge —
  // ignore them instead of writing an empty placeholder block.
  if (delta === undefined && content === undefined && toolCall === undefined) return streaming;
  if (index < 0 || index > 10_000) return msg;
  while (msg.content.length <= index) msg.content.push(null);
  const prev = msg.content[index];
  if (kind === "toolCall") {
    if (toolCall && typeof toolCall === "object") msg.content[index] = { ...toolCall, type: "toolCall" };
    else if (delta !== undefined) {
      const base = prev && prev.type === "toolCall" ? prev : { type: "toolCall", id: "", name: "", arguments: {} };
      msg.content[index] = { ...base, partialJson: String(base.partialJson ?? "") + delta };
    }
  } else {
    const field = kind === "thinking" ? "thinking" : "text";
    const base = prev && prev.type === kind ? prev : { type: kind, [field]: "" };
    if (typeof content === "string") msg.content[index] = { ...base, [field]: content };
    else if (delta !== undefined) msg.content[index] = { ...base, [field]: String(base[field] ?? "") + delta };
  }
  msg.content = msg.content.map((/** @type {any} */ b) => b ?? { type: "text", text: "" });
  return msg;
}

/** @param {AgentState} a @param {number} seq @param {any} e @returns {AgentState} */
function applyEvent(a, seq, e) {
  switch (e.type) {
    case "message_start":
      if (e.message && e.message.role === "assistant") return { ...a, streaming: cloneMessage(e.message) };
      return a;
    case "message_update":
      return { ...a, streaming: applyDelta(a.streaming, e) };
    case "message_end": {
      const m = e.message;
      if (!m || typeof m !== "object") return a;
      const keys = new Set(a.keys);
      const it = messageItem(m, keys, `s:${seq}`, seq);
      /** @type {AgentState} */
      let next = { ...a, keys };
      if (m.role === "assistant") next.streaming = null;
      if (m.role === "toolResult" && typeof m.toolCallId === "string") {
        next.tools = a.tools.filter((t) => t.toolCallId !== m.toolCallId);
      }
      if (it) next.items = [...a.items, it];
      return next;
    }
    case "tool_execution_start": {
      if (typeof e.toolCallId !== "string") return a;
      const tool = { toolCallId: e.toolCallId, toolName: String(e.toolName ?? ""), args: e.args, done: false };
      return { ...a, tools: [...a.tools.filter((t) => t.toolCallId !== e.toolCallId), tool] };
    }
    case "tool_execution_update": {
      if (typeof e.toolCallId !== "string") return a;
      const partial = typeof e.partial === "string" ? e.partial : resultText(e.partialResult);
      return {
        ...a,
        tools: upsertTool(a.tools, e, (t) => ({ ...t, partial, ...(e.truncated === true ? { truncated: true } : {}) })),
      };
    }
    case "tool_execution_end": {
      if (typeof e.toolCallId !== "string") return a;
      return {
        ...a,
        tools: upsertTool(a.tools, e, (t) => ({
          ...t,
          done: true,
          result: e.result,
          isError: e.isError === true,
          ...(e.truncated === true ? { truncated: true } : {}),
        })),
      };
    }
    case "session_compact": {
      const ce = e.compactionEntry && typeof e.compactionEntry === "object" ? e.compactionEntry : undefined;
      const entryId = typeof ce?.id === "string" ? ce.id : undefined;
      if (entryId && a.entryIds.has(entryId)) return a;
      const entry = {
        type: "compaction",
        summary: ce?.summary ?? e.summary,
        firstKeptEntryId: ce?.firstKeptEntryId ?? e.firstKeptEntryId,
      };
      const entryIds = entryId ? new Set(a.entryIds).add(entryId) : a.entryIds;
      /** @type {Item} */
      const it = { id: `s:${seq}`, kind: "compaction", entry, seq };
      if (entryId) it.entryId = entryId;
      return { ...a, entryIds, items: [...a.items, it] };
    }
    case "session_info_changed":
      if (typeof e.name === "string" && a.session) {
        const session = { ...a.session, name: e.name };
        return { ...a, session, card: { ...a.card, session } };
      }
      return a;
    case "model_select":
      if (e.model && typeof e.model === "object" && a.session) {
        const session = {
          ...a.session,
          model: { provider: String(e.model.provider ?? ""), id: String(e.model.id ?? "") },
        };
        return { ...a, session, card: { ...a.card, session } };
      }
      return a;
    case "agent_end":
      return a.streaming ? { ...a, streaming: null } : a;
    default:
      return a; // turn_*, agent_start/settled, input, ui_prompt_* (banner comes from `prompt`)
  }
}

/** @param {LiveTool[]} tools @param {any} e @param {(t: LiveTool) => LiveTool} fn */
function upsertTool(tools, e, fn) {
  const i = tools.findIndex((t) => t.toolCallId === e.toolCallId);
  if (i < 0)
    return [...tools, fn({ toolCallId: e.toolCallId, toolName: String(e.toolName ?? ""), args: e.args, done: false })];
  const out = tools.slice();
  out[i] = fn(/** @type {LiveTool} */ (tools[i]));
  return out;
}

/** Plain text of a tool result / content array (text blocks only). @param {unknown} r */
export function resultText(r) {
  if (typeof r === "string") return r;
  if (!r || typeof r !== "object") return "";
  const content = /** @type {any} */ (r).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && b.type === "text" && typeof b.text === "string" ? b.text : b && b.type === "image" ? "[image]" : "",
      )
      .filter((t) => t !== "")
      .join("\n");
  }
  return "";
}

// ---------------------------------------------------------------------------
// derived decisions (pure)
// ---------------------------------------------------------------------------

/**
 * The agent the app should (re)subscribe now, if any: the selected, live
 * agent whose subscription is missing, belongs to an older SSE client, or
 * needs a resync. Never while a subscribe is in flight.
 * @param {State} s
 * @returns {string | undefined}
 */
export function needsSubscribe(s) {
  if (!s.clientId || s.selected === null) return undefined;
  const a = s.agents.get(s.selected);
  if (!a || a.down) return undefined;
  if (a.sub?.pending) return undefined;
  if (a.sub?.failed && !a.needsResync) return undefined; // manual retry only
  if (!a.sub || a.sub.clientId !== s.clientId || a.needsResync) return a.key;
  return undefined;
}

/** @param {State} s @returns {AgentState | undefined} */
export function selectedAgent(s) {
  return s.selected === null ? undefined : s.agents.get(s.selected);
}
