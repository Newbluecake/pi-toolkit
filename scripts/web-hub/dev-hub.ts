#!/usr/bin/env -S npx tsx
/**
 * Fake-data dev hub (`npm run dev:hub`, vue-plan.md v2.1 §4.5, §5.2 — P2). A standalone HTTP+SSE
 * server that speaks the real hub↔browser wire protocol (`src/web-hub/protocol/`) closely enough
 * for local frontend development and the P2 visual-acceptance harness (`visual.ts`), without ever
 * touching a real pi agent process. It never imports `hub.ts`/`registry.ts`/`db.ts`/anything that
 * talks to a live agent — only the frozen protocol types, `hub/static.ts` (`serveStatic`/
 * `serveIndex`/`webRoot` — P5b later swaps this call site to `createUiServer`, this file stays a
 * thin caller either way), `hub/http.ts`'s exported `CSP` constant (so a dev/visual run is tested
 * against the exact same security header the real hub sends), `hub/sse.ts`'s reusable fan-out
 * (`createSseHub`), `protocol/lan.ts`'s pure `parseOrigin`/`canonicalOrigin` (Origin-header
 * canonicalization, used to mirror the real LAN CSRF gate — `csrfOkLan` — for password mode) and
 * — for `--mode token` only — the real `hub/auth.ts` bearer-token exchange (the actual mechanism,
 * not a re-implementation of it). Password mode mirrors the real *LAN* password auth surface
 * (`hub/lan-auth.ts`'s `LAN_SESSION_COOKIE`/`formatLanCookie`/`readLanCookie` — cookie name
 * `pwh_lan`, distinct from token mode's loopback `pwh_sid`) with a deliberately simpler *fake*
 * credential check: a single fixed in-memory pair plus a `--login-error` escape hatch to force any
 * of the real error responses on demand (there is no KDF/db/rate-limit queue to model here).
 *
 * Served data comes from `tests/fixtures/web-hub-ui/<scenario>.json` (`DevHubFixture`, validated
 * at load time by `validateFixture`) plus an optional `historyGenerate` directive (used by the
 * `long` fixture) that synthesizes a large, deterministic transcript at request time instead of
 * checking 1000 JSON entries into the repo.
 *
 * Exit codes when run as a CLI: this script only exits on `--help`/parse failure (2) or a fatal
 * startup error (1); otherwise it runs until killed (`SIGINT`/`SIGTERM` close the server first).
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAuth, readCookie, SESSION_COOKIE } from "../../src/web-hub/hub/auth.js";
import { CSP } from "../../src/web-hub/hub/http.js";
import { formatLanCookie, LAN_SESSION_COOKIE, readLanCookie } from "../../src/web-hub/hub/lan-auth.js";
import { createSseHub, type SseClient, type SseEventName, type SseHub } from "../../src/web-hub/hub/sse.js";
import { serveIndex, serveStatic } from "../../src/web-hub/hub/static.js";
import { canonicalOrigin, parseOrigin } from "../../src/web-hub/protocol/lan.js";
import type { AgentCard, HistoryPayload } from "../../src/web-hub/protocol/http-contract.js";
import type { FleetRowWire, WireEntry, WireMessage } from "../../src/web-hub/protocol/messages.js";
import { PROTO } from "../../src/web-hub/protocol/version.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const DEFAULT_UI_DIST = resolve(REPO_ROOT, "dist/web-hub-ui");
export const FIXTURES_DIR = resolve(REPO_ROOT, "tests/fixtures/web-hub-ui");

// ---------------------------------------------------------------------------
// fixture shape
// ---------------------------------------------------------------------------

/** One extra frame `dev-hub` fires `atMs` after a client's `/api/events` connects. Mirrors the
 * real hub's `onHubEvent` (`src/web-hub/hub/http.ts`): only `ev`/`gap`/`append` are *scoped*
 * (routed through `sse.publish(event, data, agentKey)`, reaching only clients subscribed to that
 * `agentKey` — `agentKey` is required on the fixture entry so the routing has something to key
 * on); every other event (`agent_up`/`agent_down`/`agent_stale`/`session`/`status`/`fleet`/
 * `prompt`) is a *global* broadcast (`sse.publish(event, data)`, no third argument — reaches every
 * connected client whether or not it ever subscribed) — a fixture entry may still carry
 * `agentKey` on one of these for `applyScriptEvent`'s own in-memory agent-list bookkeeping, it is
 * simply never passed to `sse.publish` for them. */
export interface DevHubScriptEvent {
  readonly atMs: number;
  readonly event: SseEventName;
  readonly agentKey?: string;
  readonly data: unknown;
}

/** Deterministic large-transcript synthesis for the `long` scenario (vue-plan.md §4.5's "long =
 * 1000 条") — keeps the checked-in fixture small while still exercising real pagination. */
export interface DevHubHistoryGenerate {
  readonly agentKey: string;
  readonly count: number;
}

export interface DevHubFixture {
  readonly agents: readonly AgentCard[];
  /** Keyed by agentKey; returned verbatim as the `history` SSE frame after `/api/subscribe`. */
  readonly history: Readonly<Record<string, HistoryPayload>>;
  /** `historyOlder[agentKey][before]` answers `GET /api/history?agent=&before=`; a miss returns an
   * empty, `hasMore:false` page (never a 404 — mirrors the real hub's "nothing older" case). */
  readonly historyOlder?: Readonly<Record<string, Readonly<Record<string, HistoryPayload>>>>;
  readonly script?: readonly DevHubScriptEvent[];
  readonly historyGenerate?: DevHubHistoryGenerate;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isHistoryPayloadLike(v: unknown): v is HistoryPayload {
  if (!isRecord(v)) return false;
  return (
    typeof v["agentKey"] === "string" &&
    Array.isArray(v["entries"]) &&
    Array.isArray(v["tailMessages"]) &&
    typeof v["fromSeq"] === "number" &&
    typeof v["hasMore"] === "boolean" &&
    (v["source"] === "file" || v["source"] === "agent")
  );
}

function isAgentCardLike(v: unknown): v is AgentCard {
  if (!isRecord(v)) return false;
  return (
    typeof v["agentKey"] === "string" &&
    (v["kind"] === "tui" || v["kind"] === "rpc") &&
    typeof v["pid"] === "number" &&
    typeof v["cwd"] === "string" &&
    (v["state"] === "live" || v["state"] === "stale") &&
    typeof v["pluginVersion"] === "string" &&
    typeof v["outdated"] === "boolean" &&
    Array.isArray(v["prompts"])
  );
}

/** Real validation (not a rubber stamp): rejects a malformed fixture with a specific reason
 * instead of letting a bad JSON file surface as a confusing runtime crash three requests later. */
export function validateFixture(raw: unknown, sourceLabel: string): DevHubFixture {
  if (!isRecord(raw)) throw new Error(`${sourceLabel}: fixture root must be an object`);
  const agents = raw["agents"];
  if (!Array.isArray(agents)) throw new Error(`${sourceLabel}: "agents" must be an array`);
  for (const [i, a] of agents.entries()) {
    if (!isAgentCardLike(a)) throw new Error(`${sourceLabel}: agents[${i}] is not a valid AgentCard`);
  }
  const history = raw["history"];
  if (!isRecord(history)) throw new Error(`${sourceLabel}: "history" must be an object`);
  for (const [key, payload] of Object.entries(history)) {
    if (!isHistoryPayloadLike(payload))
      throw new Error(`${sourceLabel}: history["${key}"] is not a valid HistoryPayload`);
  }
  const historyOlder = raw["historyOlder"];
  if (historyOlder !== undefined) {
    if (!isRecord(historyOlder)) throw new Error(`${sourceLabel}: "historyOlder" must be an object`);
    for (const [agentKey, pages] of Object.entries(historyOlder)) {
      if (!isRecord(pages)) throw new Error(`${sourceLabel}: historyOlder["${agentKey}"] must be an object`);
      for (const [before, payload] of Object.entries(pages)) {
        if (!isHistoryPayloadLike(payload)) {
          throw new Error(`${sourceLabel}: historyOlder["${agentKey}"]["${before}"] is not a valid HistoryPayload`);
        }
      }
    }
  }
  const script = raw["script"];
  if (script !== undefined) {
    if (!Array.isArray(script)) throw new Error(`${sourceLabel}: "script" must be an array`);
    for (const [i, s] of script.entries()) {
      if (!isRecord(s) || typeof s["atMs"] !== "number" || typeof s["event"] !== "string" || !("data" in s)) {
        throw new Error(`${sourceLabel}: script[${i}] must be { atMs, event, data, agentKey? }`);
      }
    }
  }
  const historyGenerate = raw["historyGenerate"];
  if (historyGenerate !== undefined) {
    if (
      !isRecord(historyGenerate) ||
      typeof historyGenerate["agentKey"] !== "string" ||
      typeof historyGenerate["count"] !== "number"
    ) {
      throw new Error(`${sourceLabel}: "historyGenerate" must be { agentKey, count }`);
    }
  }
  return raw as unknown as DevHubFixture;
}

export async function loadFixture(scenario: string, dir: string = FIXTURES_DIR): Promise<DevHubFixture> {
  const path = join(dir, `${scenario}.json`);
  let raw: unknown;
  try {
    const { readFile } = await import("node:fs/promises");
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    throw new Error(`dev-hub: cannot load fixture "${scenario}" from ${path}: ${String(err)}`);
  }
  return validateFixture(raw, path);
}

// ---------------------------------------------------------------------------
// deterministic "long" transcript synthesis
// ---------------------------------------------------------------------------

const LONG_CODE_SAMPLE = [
  "```typescript",
  "export function reconcile(prev: Row[], next: Row[]): Patch[] {",
  "  const byId = new Map(prev.map((r) => [r.id, r]));",
  "  const patches: Patch[] = [];",
  "  for (const row of next) {",
  "    const before = byId.get(row.id);",
  '    if (before === undefined) patches.push({ kind: "insert", row });',
  '    else if (!shallowEqual(before, row)) patches.push({ kind: "update", row });',
  "    byId.delete(row.id);",
  "  }",
  '  for (const gone of byId.values()) patches.push({ kind: "remove", id: gone.id });',
  "  return patches;",
  "}",
  "```",
].join("\n");

function synthesizeMessage(index: number): WireMessage {
  const role = index % 2 === 0 ? "user" : "assistant";
  const content =
    index % 17 === 0
      ? `Here's the reconciliation helper we discussed:\n\n${LONG_CODE_SAMPLE}`
      : `message #${index} — ${role === "user" ? "please check the diff" : "looks good, applied the change"}`;
  return { role, timestamp: 1_700_000_000_000 + index * 1_000, content };
}

function synthesizeLongEntries(count: number): WireEntry[] {
  const out: WireEntry[] = [];
  for (let i = 1; i <= count; i++) {
    out.push({
      id: `e-${i}`,
      parentId: i === 1 ? null : `e-${i - 1}`,
      type: "message",
      timestamp: new Date(1_700_000_000_000 + i * 1_000).toISOString(),
      message: synthesizeMessage(i),
    });
  }
  return out;
}

/** Answers `GET /api/history?before=e-<n>&limit=<l>` against the synthesized 1..count range. */
function synthesizeHistoryPage(agentKey: string, count: number, before: string, limit: number): HistoryPayload {
  const m = /^e-(\d+)$/.exec(before);
  const beforeIndex = m ? Number(m[1]) : count + 1;
  const endExclusive = Math.max(1, Math.min(beforeIndex, count + 1));
  const startInclusive = Math.max(1, endExclusive - limit);
  const entries: WireEntry[] = [];
  for (let i = startInclusive; i < endExclusive; i++) {
    entries.push({
      id: `e-${i}`,
      parentId: i === 1 ? null : `e-${i - 1}`,
      type: "message",
      timestamp: new Date(1_700_000_000_000 + i * 1_000).toISOString(),
      message: synthesizeMessage(i),
    });
  }
  return {
    agentKey,
    entries,
    tailMessages: [],
    fromSeq: startInclusive,
    hasMore: startInclusive > 1,
    source: "file",
    ...(entries[0] === undefined ? {} : { oldestEntryId: entries[0].id }),
  };
}

// ---------------------------------------------------------------------------
// CLI / options
// ---------------------------------------------------------------------------

export type LoginErrorKind = "invalid" | "throttled" | "saturated" | "not-allowed" | "busy-exhausted" | "network";
export const LOGIN_ERROR_KINDS: readonly LoginErrorKind[] = [
  "invalid",
  "throttled",
  "saturated",
  "not-allowed",
  "busy-exhausted",
  "network",
];

export interface DevHubOptions {
  readonly mode: "token" | "password";
  readonly scenario: string;
  readonly port?: number;
  readonly root?: string;
  readonly fixturesDir?: string;
  readonly loginError?: LoginErrorKind;
  readonly initialPassword?: boolean;
  readonly devUsername?: string;
  readonly devPassword?: string;
  readonly log?: (line: string) => void;
}

export interface DevHubHandle {
  readonly port: number;
  readonly url: string;
  readonly mode: "token" | "password";
  readonly scenario: string;
  /** Only set for `mode: "token"` — the bearer token a browser would exchange at `/api/login`. */
  readonly token?: string;
  close(): Promise<void>;
}

const BIND_HOST = "127.0.0.1";
const DEV_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.destroyed) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...headers,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(text)),
  });
  res.end(text);
}

function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message?: string,
  headers: Record<string, string> = {},
): void {
  sendJson(res, status, message === undefined ? { error: code } : { error: code, message }, headers);
}

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveP, rejectP) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024) {
        rejectP(new Error("body too large"));
        return;
      }
      chunks.push(c);
    });
    req.once("end", () => {
      const buf = Buffer.concat(chunks);
      if (buf.length === 0) {
        resolveP(undefined);
        return;
      }
      try {
        resolveP(JSON.parse(buf.toString("utf8")));
      } catch {
        rejectP(new Error("invalid JSON"));
      }
    });
    req.once("error", rejectP);
  });
}

function field(body: unknown, name: string): unknown {
  return isRecord(body) ? body[name] : undefined;
}

/** Mirrors hub/http.ts `stringField`: non-empty string of length ≤ 256, else undefined. */
function stringField(body: unknown, name: string): string | undefined {
  const v = field(body, name);
  return typeof v === "string" && v.length > 0 && v.length <= 256 ? v : undefined;
}

/** Same CSRF gate as the real loopback `http.ts` (`csrfOk`): JSON content-type + `X-PWH: 1` +
 * (when present) a same-origin `Origin`. Used for `--mode token` only. */
function csrfOk(req: IncomingMessage): boolean {
  const ct = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (ct !== "application/json") return false;
  if (req.headers["x-pwh"] !== "1") return false;
  const origin = req.headers.origin;
  if (origin !== undefined && origin.toLowerCase() !== `http://${(req.headers.host ?? "").toLowerCase()}`) return false;
  return true;
}

/** Same CSRF gate as the real LAN listener (`http.ts`'s `csrfOkLan`): JSON content-type +
 * `X-PWH: 1` + a REQUIRED `Origin` whose canonicalized form matches this dev-hub's own origin
 * (unlike `csrfOk` above, a missing `Origin` is rejected — the real LAN gate never treats a
 * same-site-but-no-Origin request as safe). Used for `--mode password` only (dev-hub's password
 * mode fakes the LAN password auth surface, not the loopback one). */
function csrfOkLan(req: IncomingMessage, selfOrigin: string): boolean {
  const ct = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (ct !== "application/json") return false;
  if (req.headers["x-pwh"] !== "1") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  const parsed = parseOrigin(origin);
  if (parsed === undefined) return false;
  return canonicalOrigin(parsed.scheme, parsed.hostKey) === selfOrigin;
}

function loginErrorResponse(kind: LoginErrorKind, res: ServerResponse): void {
  switch (kind) {
    case "invalid":
      sendError(res, 401, "E_AUTH");
      return;
    case "throttled":
      sendError(res, 429, "E_RATE", undefined, { "Retry-After": "30" });
      return;
    case "saturated":
      sendJson(res, 429, { error: "E_RATE", saturated: true }, { "Retry-After": "5" });
      return;
    case "not-allowed":
      sendError(res, 429, "E_LOCKED", undefined, { "Retry-After": "60" });
      return;
    case "busy-exhausted":
      sendError(res, 503, "E_BUSY");
      return;
    case "network":
      // No response at all: the real failure mode this simulates is a dropped/never-answered
      // connection (client's fetch rejects), not a well-formed error body.
      res.destroy();
      return;
  }
}

interface DevAgentState {
  agents: Map<string, AgentCard>;
}

/** Mirrors the real hub's `PendingFrame`/`PendingSub`/`MAX_PENDING_FRAMES` (`hub/http.ts`): frames
 * for a scoped event (`ev`/`gap`/`append`) that fire while a `/api/subscribe` snapshot is still
 * in flight are buffered per `(clientId, agentKey)` instead of racing the `history` frame —
 * replayed (seq-filtered for `ev`) right after `history`, then the client is finally marked
 * `subscribed` so it starts receiving the *live* scoped stream. */
interface PendingFrame {
  event: SseEventName;
  data: unknown;
  seq?: number;
}

interface PendingSub {
  frames: PendingFrame[];
  overflow: boolean;
}

const MAX_PENDING_FRAMES = 4_096;

/** Real hub events that are routed to every connected client, filtered by neither `subscribed`
 * nor `clientId` (`hub/http.ts`'s `onHubEvent`, the non-`scoped()` branches). */
const GLOBAL_SSE_EVENTS: ReadonlySet<SseEventName> = new Set([
  "agent_up",
  "agent_down",
  "agent_stale",
  "session",
  "status",
  "fleet",
  "prompt",
]);

/** Applies one scripted frame's side-effect to the in-memory agent-list mirror (so a client that
 * connects *after* e.g. an `agent_down` already fired sees the post-effect list, same as a real
 * hub's registry) and broadcasts it. `scoped` (supplied by `createDevHub`) both publishes AND
 * buffers a scoped (`ev`/`gap`/`append`) frame for any subscribe currently in flight — see
 * `PendingFrame` above; a global event never goes through it. Returns nothing — purely a
 * side-effecting dispatcher. */
function applyScriptEvent(
  state: DevAgentState,
  sse: SseHub,
  ev: DevHubScriptEvent,
  scoped: (event: SseEventName, data: unknown, agentKey: string) => void,
): void {
  if (ev.event === "agent_down" && isRecord(ev.data) && typeof ev.data["agentKey"] === "string") {
    state.agents.delete(ev.data["agentKey"]);
    sse.publish("agent_down", ev.data);
    return;
  }
  if (ev.event === "agent_up" && isRecord(ev.data) && isAgentCardLike(ev.data["agent"])) {
    state.agents.set((ev.data["agent"] as AgentCard).agentKey, ev.data["agent"] as AgentCard);
    sse.publish("agent_up", ev.data);
    return;
  }
  if (ev.event === "agent_stale" && isRecord(ev.data) && typeof ev.data["agentKey"] === "string") {
    const existing = state.agents.get(ev.data["agentKey"]);
    if (existing !== undefined) state.agents.set(ev.data["agentKey"], { ...existing, state: "stale" });
    sse.publish("agent_stale", ev.data);
    return;
  }
  if (GLOBAL_SSE_EVENTS.has(ev.event)) {
    sse.publish(ev.event, ev.data);
    return;
  }
  // Scoped (`ev`/`gap`/`append`): only clients subscribed to `agentKey` receive it, and any
  // subscribe-in-flight for that agentKey buffers it instead of missing it to a race.
  if (ev.agentKey !== undefined) {
    scoped(ev.event, ev.data, ev.agentKey);
    return;
  }
  // Malformed fixture (a scoped event with no agentKey) — fail open as a broadcast rather than
  // silently dropping it, same spirit as `validateFixture`'s "specific reason, not a crash".
  sse.publish(ev.event, ev.data);
}

export async function createDevHub(opts: DevHubOptions): Promise<DevHubHandle> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const root = opts.root ?? DEFAULT_UI_DIST;
  const fixture = await loadFixture(opts.scenario, opts.fixturesDir ?? FIXTURES_DIR);

  const state: DevAgentState = { agents: new Map(fixture.agents.map((a) => [a.agentKey, a])) };
  const sse = createSseHub({ now: () => Date.now(), pingMs: 15_000 });
  const pending = new Map<string, Map<string, PendingSub>>(); // clientId -> agentKey -> PendingSub

  function getPending(clientId: string, agentKey: string): PendingSub | undefined {
    return pending.get(clientId)?.get(agentKey);
  }

  function deletePending(clientId: string, agentKey: string): void {
    const m = pending.get(clientId);
    if (m === undefined) return;
    m.delete(agentKey);
    if (m.size === 0) pending.delete(clientId);
  }

  function bufferScoped(agentKey: string, frame: PendingFrame): void {
    for (const [clientId, m] of pending) {
      const p = m.get(agentKey);
      if (p === undefined) continue;
      if (sse.get(clientId) === undefined) {
        pending.delete(clientId);
        continue;
      }
      if (p.frames.length >= MAX_PENDING_FRAMES) p.overflow = true;
      else p.frames.push(frame);
    }
  }

  function scoped(event: SseEventName, data: unknown, agentKey: string): void {
    sse.publish(event, data, agentKey);
    const seq = isRecord(data) && typeof data["seq"] === "number" ? data["seq"] : undefined;
    bufferScoped(agentKey, seq === undefined ? { event, data } : { event, data, seq });
  }

  // token mode: the real auth.ts mechanism, backed by a throwaway per-run token file.
  const authDir = mkdtempSync(join(tmpdir(), "pwh-dev-hub-"));
  const auth =
    opts.mode === "token"
      ? createAuth({ tokenFile: join(authDir, "token"), log: { info: () => {}, warn: () => {}, error: () => {} } })
      : undefined;
  const devToken = auth?.token();

  // password mode: a single fixed in-memory credential (dev-only — never the real KDF/db path).
  const devUsername = opts.devUsername ?? "admin";
  const devPassword = opts.devPassword ?? "admin";
  const pwSessions = new Map<string, number>(); // sid -> expiresAt

  function pwCheck(cookieHeader: string | undefined): boolean {
    const sid = readLanCookie(cookieHeader);
    if (sid === undefined) return false;
    const exp = pwSessions.get(sid);
    if (exp === undefined || exp <= Date.now()) return false;
    return true;
  }

  function historyFor(agentKey: string): HistoryPayload {
    if (fixture.historyGenerate?.agentKey === agentKey) {
      const count = fixture.historyGenerate.count;
      const entries = synthesizeLongEntries(count);
      return {
        agentKey,
        entries,
        tailMessages: entries.slice(-8).map((e) => e.message!),
        fromSeq: 1,
        hasMore: false,
        source: "file",
        ...(entries[0] === undefined ? {} : { oldestEntryId: entries[0].id }),
      };
    }
    return (
      fixture.history[agentKey] ?? {
        agentKey,
        entries: [],
        tailMessages: [],
        fromSeq: 0,
        hasMore: false,
        source: "file",
      }
    );
  }

  function historyPage(agentKey: string, before: string, limit: number): HistoryPayload {
    if (fixture.historyGenerate?.agentKey === agentKey) {
      return synthesizeHistoryPage(agentKey, fixture.historyGenerate.count, before, limit);
    }
    return (
      fixture.historyOlder?.[agentKey]?.[before] ?? {
        agentKey,
        entries: [],
        tailMessages: [],
        fromSeq: 0,
        hasMore: false,
        source: "file",
      }
    );
  }

  function toCard(a: AgentCard): AgentCard {
    return a;
  }

  function handleSubscribe(clientId: string, agentKey: string, res: ServerResponse): void {
    const client = sse.get(clientId);
    if (client === undefined) {
      sendError(res, 404, "E_NOT_FOUND", "unknown clientId");
      return;
    }
    if (!state.agents.has(agentKey)) {
      sendError(res, 404, "E_NOT_FOUND", "unknown agentKey");
      return;
    }
    // Real `subscribe()` drops any stale `subscribed` entry up front too — the client only
    // rejoins the live scoped stream once its own snapshot below has actually been delivered.
    client.subscribed.delete(agentKey);
    const p: PendingSub = { frames: [], overflow: false };
    let m = pending.get(clientId);
    if (m === undefined) pending.set(clientId, (m = new Map()));
    m.set(agentKey, p);
    sendJson(res, 202, { ok: true });
    // Real hub answers 202 first, then pushes `history` once the (here: instant) snapshot
    // resolves — `setImmediate` preserves that response-before-push ordering for clients that
    // read the SSE stream synchronously right after the fetch resolves. Any scoped (`ev`/`gap`/
    // `append`) frame that fires in that window is buffered by `scoped()` above and replayed
    // right after `history` (seq-filtered for `ev`, same as `runSnapshot` in `hub/http.ts`).
    setImmediate(() => {
      if (getPending(clientId, agentKey) !== p) return;
      deletePending(clientId, agentKey);
      if (sse.get(clientId) !== client) return;
      const payload = historyFor(agentKey);
      if (!client.send("history", payload)) return;
      for (const f of p.frames) {
        if (f.event === "ev" && f.seq !== undefined && f.seq < payload.fromSeq) continue;
        if (!client.send(f.event, f.data)) return;
      }
      if (p.overflow) client.send("gap", { agentKey, fromSeq: payload.fromSeq });
      client.subscribed.add(agentKey);
    });
  }

  function handleUnsubscribe(clientId: string, agentKey: string, res: ServerResponse): void {
    sse.get(clientId)?.subscribed.delete(agentKey);
    deletePending(clientId, agentKey);
    sendJson(res, 200, { ok: true });
  }

  function openEvents(req: IncomingMessage, res: ServerResponse): SseClient {
    // Real hub's `openEvents` (`hub/http.ts`): a well-formed `Last-Event-ID` drives the SSE ring
    // replay/resync path in `sse.attach`; dev-hub ignoring the header entirely (as before this
    // fix) meant a reconnecting client always silently missed whatever fired while it was gone.
    const raw = req.headers["last-event-id"];
    const lastEventId = typeof raw === "string" && /^\d{1,16}$/.test(raw.trim()) ? Number(raw.trim()) : undefined;
    const client = sse.attach(req, res, lastEventId);
    client.send("hub", {
      version: "0.0.0-dev-hub",
      buildId: "dev-hub@fixture",
      pid: process.pid,
      startedAt: Date.now(),
      proto: PROTO,
      port,
    });
    client.send("agents", { agents: [...state.agents.values()].map(toCard) });
    res.once("close", () => pending.delete(client.id));
    return client;
  }

  let port = 0;
  const scriptTimers: ReturnType<typeof setTimeout>[] = [];

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log(`dev-hub: request failed: ${String(err)}`);
      if (!res.headersSent) sendError(res, 500, "E_INTERNAL");
      else res.destroy();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setSecurityHeaders(res);
    const host = (req.headers.host ?? "").toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      sendError(res, 421, "E_HOST");
      return;
    }
    const url = req.url ?? "/";
    const qi = url.indexOf("?");
    const path = qi < 0 ? url : url.slice(0, qi);
    const query = new URLSearchParams(qi < 0 ? "" : url.slice(qi + 1));
    const method = (req.method ?? "GET").toUpperCase();

    if (path === "/healthz") {
      sendJson(
        res,
        200,
        { ok: true, version: "0.0.0-dev-hub", authMode: opts.mode, scenario: opts.scenario },
        { "Cache-Control": "no-store" },
      );
      return;
    }

    if (path !== "/api" && !path.startsWith("/api/")) {
      if (method !== "GET" && method !== "HEAD") {
        sendError(res, 404, "E_NOT_FOUND");
        return;
      }
      const served = await serveStatic(root, path, res, { authMode: opts.mode });
      if (!served) sendError(res, 404, "E_NOT_FOUND");
      return;
    }

    res.setHeader("Cache-Control", "no-store");

    const isAuthed = (): boolean =>
      opts.mode === "token" ? auth!.check(req.headers.cookie, Date.now()) : pwCheck(req.headers.cookie);

    if (method === "POST") {
      // Password mode fakes the real *LAN* password auth surface, so its CSRF gate mirrors
      // `csrfOkLan` (Origin REQUIRED); token mode fakes the loopback surface (`csrfOk`, Origin
      // optional) — the two are deliberately not interchangeable, same as the real hub.
      const csrfPass =
        opts.mode === "password" ? csrfOkLan(req, canonicalOrigin("http", `127.0.0.1:${port}`)) : csrfOk(req);
      if (!csrfPass) {
        sendError(res, 403, "E_CSRF");
        return;
      }
      const body = await readJson(req).catch(() => undefined);

      if (path === "/api/login") {
        if (opts.mode === "token") {
          const r = auth!.login(field(body, "token"), Date.now());
          if (r.ok) {
            sendJson(
              res,
              200,
              { ok: true },
              { "Set-Cookie": `${SESSION_COOKIE}=${r.sid}; HttpOnly; SameSite=Strict; Path=/` },
            );
          } else if (r.code === "E_RATE") {
            sendJson(res, 429, { error: "E_RATE" }, { "Retry-After": "60" });
          } else {
            sendError(res, 401, "E_AUTH");
          }
          return;
        }
        if (opts.loginError !== undefined) {
          loginErrorResponse(opts.loginError, res);
          return;
        }
        const username = field(body, "username");
        const password = field(body, "password");
        if (username === devUsername && password === devPassword) {
          const sid = randomBytes(32).toString("base64url");
          pwSessions.set(sid, Date.now() + DEV_SESSION_TTL_MS);
          sendJson(
            res,
            200,
            { ok: true, initialPassword: opts.initialPassword === true },
            { "Set-Cookie": formatLanCookie(sid, { secure: false }) },
          );
        } else {
          sendError(res, 401, "E_AUTH");
        }
        return;
      }

      if (path === "/api/logout") {
        if (opts.mode === "token") {
          const sid = readCookie(req.headers.cookie, SESSION_COOKIE);
          if (sid !== undefined) auth!.logout(sid);
          sendJson(
            res,
            200,
            { ok: true },
            { "Set-Cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` },
          );
        } else {
          const sid = readLanCookie(req.headers.cookie);
          if (sid !== undefined) pwSessions.delete(sid);
          sendJson(res, 200, { ok: true }, { "Set-Cookie": formatLanCookie("", { secure: false, clear: true }) });
        }
        return;
      }

      if (!isAuthed()) {
        sendError(res, 401, "E_AUTH");
        return;
      }
      if (path === "/api/subscribe") {
        const clientId = stringField(body, "clientId");
        const agentKey = stringField(body, "agentKey");
        if (clientId === undefined || agentKey === undefined) {
          sendError(res, 400, "E_BAD_REQUEST");
          return;
        }
        handleSubscribe(clientId, agentKey, res);
        return;
      }
      if (path === "/api/unsubscribe") {
        const clientId = stringField(body, "clientId");
        const agentKey = stringField(body, "agentKey");
        if (clientId === undefined || agentKey === undefined) {
          sendError(res, 400, "E_BAD_REQUEST");
          return;
        }
        handleUnsubscribe(clientId, agentKey, res);
        return;
      }
      sendError(res, 404, "E_NOT_FOUND");
      return;
    }

    if (method === "GET") {
      if (path === "/api/session" && opts.mode === "password") {
        if (!isAuthed()) {
          sendError(res, 401, "E_AUTH");
          return;
        }
        sendJson(res, 200, { username: devUsername, initialPasswordInUse: opts.initialPassword === true });
        return;
      }
      if (!isAuthed()) {
        sendError(res, 401, "E_AUTH");
        return;
      }
      if (path === "/api/events") {
        openEvents(req, res);
        return;
      }
      if (path === "/api/history") {
        const agentKey = query.get("agent") ?? "";
        const before = query.get("before") ?? "";
        const limitRaw = query.get("limit");
        if (agentKey.length === 0 || before.length === 0) {
          sendError(res, 400, "E_BAD_REQUEST");
          return;
        }
        let limit = 400;
        if (limitRaw !== null) {
          // Real `historyPage` (`hub/http.ts`) rejects an unparseable `limit` outright (400)
          // instead of silently falling back to the default — a caller that sent garbage gets
          // told so, rather than an unexpectedly-different page.
          if (!/^\d{1,9}$/.test(limitRaw)) {
            sendError(res, 400, "E_BAD_REQUEST", "bad limit");
            return;
          }
          limit = Math.min(400, Math.max(1, Number(limitRaw)));
        }
        if (!state.agents.has(agentKey)) {
          sendError(res, 404, "E_NOT_FOUND");
          return;
        }
        sendJson(res, 200, historyPage(agentKey, before, limit));
        return;
      }
    }
    sendError(res, 404, "E_NOT_FOUND");
  }

  await new Promise<void>((resolveP, rejectP) => {
    server.once("error", rejectP);
    server.listen(opts.port ?? 0, BIND_HOST, () => resolveP());
  });
  const addr = server.address();
  port = typeof addr === "object" && addr !== null ? addr.port : (opts.port ?? 0);

  for (const ev of fixture.script ?? []) {
    const t = setTimeout(() => applyScriptEvent(state, sse, ev, scoped), ev.atMs);
    t.unref?.();
    scriptTimers.push(t);
  }

  log(`dev-hub: listening on http://127.0.0.1:${port} (mode=${opts.mode}, scenario=${opts.scenario})`);
  if (devToken !== undefined) log(`dev-hub: token=${devToken}`);

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    mode: opts.mode,
    scenario: opts.scenario,
    ...(devToken === undefined ? {} : { token: devToken }),
    async close(): Promise<void> {
      for (const t of scriptTimers) clearTimeout(t);
      sse.closeAll();
      await new Promise<void>((resolveP) => server.close(() => resolveP()));
      const { rm } = await import("node:fs/promises");
      await rm(authDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: readonly string[]): DevHubOptions {
  let mode: "token" | "password" = "token";
  let scenario = "dashboard";
  let port: number | undefined;
  let root: string | undefined;
  let loginError: LoginErrorKind | undefined;
  let initialPassword = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`dev-hub: missing value for ${a}`);
      return v;
    };
    if (a === "--mode") {
      const v = next();
      if (v !== "token" && v !== "password")
        throw new Error(`dev-hub: --mode must be "token" or "password", got "${v}"`);
      mode = v;
    } else if (a === "--scenario") scenario = next();
    else if (a === "--port") port = Number(next());
    else if (a === "--root") root = resolve(next());
    else if (a === "--login-error") {
      const v = next();
      if (!LOGIN_ERROR_KINDS.includes(v as LoginErrorKind)) {
        throw new Error(`dev-hub: --login-error must be one of ${LOGIN_ERROR_KINDS.join("|")}, got "${v}"`);
      }
      loginError = v as LoginErrorKind;
    } else if (a === "--initial-password") initialPassword = true;
    else if (a === "--help" || a === "-h") {
      // handled by caller
    } else throw new Error(`dev-hub: unknown argument "${a}"`);
  }
  return {
    mode,
    scenario,
    ...(port === undefined ? {} : { port }),
    ...(root === undefined ? {} : { root }),
    ...(loginError === undefined ? {} : { loginError }),
    initialPassword,
  };
}

const HELP = `Usage: npm run dev:hub -- [--mode token|password] [--scenario <name>] [--port <n>] [--root <dir>]
                          [--login-error invalid|throttled|saturated|not-allowed|busy-exhausted|network]
                          [--initial-password]

Fake-data hub for local frontend dev + the visual acceptance harness (vue-plan.md §4.5).
Scenarios come from tests/fixtures/web-hub-ui/<name>.json (dashboard, states, empty, long, streaming).`;

async function main(): Promise<void> {
  if (process.argv.slice(2).includes("--help") || process.argv.slice(2).includes("-h")) {
    console.log(HELP);
    return;
  }
  let opts: DevHubOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    console.error(HELP);
    process.exitCode = 2;
    return;
  }
  const handle = await createDevHub(opts);
  const shutdown = (): void => {
    void handle.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMain()) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
