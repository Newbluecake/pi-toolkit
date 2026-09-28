#!/usr/bin/env -S npx tsx
/**
 * Fake-data dev hub (`npm run dev:hub`, vue-plan.md v2.1 §4.5, §5.2 — P2). A standalone HTTP+SSE
 * server that speaks the real hub↔browser wire protocol (`src/web-hub/protocol/`) closely enough
 * for local frontend development and the P2 visual-acceptance harness (`visual.ts`), without ever
 * touching a real pi agent process. It never imports `hub.ts`/`registry.ts`/`db.ts`/anything that
 * talks to a live agent — only the frozen protocol types, `hub/http.ts`'s exported `CSP`
 * constant (so a dev/visual run is tested against the exact same security header the real hub
 * sends), `hub/sse.ts`'s reusable fan-out
 * (`createSseHub`), `protocol/lan.ts`'s pure `parseOrigin`/`canonicalOrigin` (Origin-header
 * canonicalization, used to mirror the real LAN CSRF gate — `csrfOkLan` — for password mode) and
 * — for `--mode token` only — the real `hub/auth.ts` bearer-token exchange (the actual mechanism,
 * not a re-implementation of it). Password mode mirrors the real *LAN* password auth surface
 * (`hub/lan-auth.ts`'s `LAN_SESSION_COOKIE`/`formatLanCookie`/`readLanCookie` — cookie name
 * `pwh_lan`, distinct from token mode's loopback `pwh_sid`) with a deliberately simpler *fake*
 * credential check: a single fixed in-memory pair plus a `--login-error` escape hatch to force any
 * of the real error responses on demand (there is no KDF/db/rate-limit queue to model here).
 *
 * Static serving (P5b 打回点 2, vue-plan.md v2.1 §5.2): whenever `--root`/`opts.root` (default
 * `DEFAULT_UI_DIST`, i.e. `dist/web-hub-ui/`) carries a `build-info.json` manifest, this now
 * serves through the exact same production module the real hub uses —
 * `hub/static.ts`'s `createUiServer` (manifest-verified, `expect.version` pinned to this repo's
 * own `package.json` version via `readPackageVersion()` since a locally built `dist/web-hub-ui/`
 * is always built at the checked-out version) — so a `dev:hub`/`visual:web` run exercises the
 * exact same URL mapping, cache headers, and CSP posture production does, not a parallel
 * reimplementation that could silently drift. `devServeStatic`/`devServeIndex` below (a small,
 * unverified raw-directory static server, same containment/extension-whitelist checks as the
 * legacy `serveStatic` this replaces) is kept ONLY as the fallback for a `--root` with no manifest
 * at all — almost always a hand-written test fixture `index.html` `dev-hub.test.ts` points
 * `--root` at directly, which the production trust model was never meant to accept.
 *
 * Served data comes from `tests/fixtures/web-hub-ui/<scenario>.json` (`DevHubFixture`, validated
 * at load time by `validateFixture`) plus an optional `historyGenerate` directive (used by the
 * `long` fixture) that synthesizes a large, deterministic transcript at request time instead of
 * checking 1000 JSON entries into the repo.
 *
 * P2 control plane (control-plan.md v2.1 §9.3, §12.3 C6): dev-hub also fakes the write surface —
 * `POST /api/cmd` and `POST /api/dialog` (§6.2 request/response shapes, §6.3's stricter *write*
 * CSRF: `Origin` REQUIRED + `Sec-Fetch-Site` must be `same-origin` when present, on BOTH modes)
 * — so the frontend's `transport.command()`/`dialog()` and every new control state (§7) can be
 * developed and visually exercised without a real pi process. Behavior is deterministic, driven
 * by request-content markers instead of a scripted agent:
 *   - success paths: prompt (observed, or `delivery:"unobserved"` when the text contains
 *     `[unobserved]`), abort (`wasBusy` from the card), steer/stop subagent, builtin bridge
 *     (`session` sync output, `compact` async), captured pi-toolkit commands (`captured:true`
 *     with demo `CommandOutputWire`), third-party commands (`captured:false,
 *     completion:"unknown"`), template/skill commands;
 *   - failure paths: `[compacting]` → 409 `E_BUSY_COMPACTING`, `[stale-ctx]` → 409
 *     `E_STALE_CTX` (both retryable/effect none), `expect.sessionId` mismatch → 409
 *     `E_SESSION_CHANGED`, `[reject]` in steer text → 422 `E_SUBAGENT_REJECTED`, runId
 *     `r_missing…` → 404 `E_NOT_FOUND`, runId `…_done` → 409 `E_NOT_RUNNING` (steer) /
 *     `alreadyTerminal` (stop), unknown command → 404 `E_UNKNOWN_COMMAND`, policy `deny` → 409
 *     `E_COMMAND_DENIED`, policy `confirm` without `confirm:true` → 409 `E_CONFIRM_REQUIRED`,
 *     dialog races → 409 `E_DIALOG_CLOSED`, malformed answers → 400 `E_BAD_ANSWER`;
 *   - the unknown→queryOnly path: text/args containing `[timeout]` answers 504 `E_DEADLINE`
 *     (`effect:"unknown"`), keeps the fake ledger entry `running`, then settles it as ok
 *     `DEV_HUB_LATE_SETTLE_MS` later and broadcasts an SSE `cmd_late` — a following
 *     `queryOnly:true` request with the same id first sees `state:"running"`, then the settled
 *     `dup` result. `[slow]` simply delays the (successful) response `DEV_HUB_SLOW_MS`.
 * Every cmd/dialog request is recorded (path, body fields, `Origin`/`Sec-Fetch-Site` headers,
 * response status/code) and exposed on the handle as `controlRequests()` — the K16
 * Origin-echo probe (`visual/checks-control.ts --probe`) and `dev-hub.test.ts` read it back.
 * Hub-level states (v2.1 §6.6/§6.7) come from the fixture: `hubState` (caps,
 * `state:"stopping"|"restarting"`, `nextVersion`, `supersedePending`,
 * `supersedeDeadlineAt`/`supersedeDeadlineInMs` — the relative form is converted to an absolute
 * deadline at startup so a checked-in fixture never goes stale — `forced`, `draining`) is
 * merged into the SSE `hub` frame, and script events named `hub`/`dialogs`/`ctl`/`commands`/
 * `cmd_late` rebroadcast updated slots/states on the fixture's own timeline.
 *
 * Exit codes when run as a CLI: this script only exits on `--help`/parse failure (2) or a fatal
 * startup error (1); otherwise it runs until killed (`SIGINT`/`SIGTERM` close the server first).
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAuth, readCookie, SESSION_COOKIE } from "../../src/web-hub/hub/auth.js";
import { CSP } from "../../src/web-hub/hub/http.js";
import { formatLanCookie, LAN_SESSION_COOKIE, readLanCookie } from "../../src/web-hub/hub/lan-auth.js";
import { createSseHub, type SseClient, type SseEventName, type SseHub } from "../../src/web-hub/hub/sse.js";
import { createUiServer, type UiServer } from "../../src/web-hub/hub/static.js";
import { canonicalOrigin, parseOrigin } from "../../src/web-hub/protocol/lan.js";
import type { AgentCard, HistoryPayload } from "../../src/web-hub/protocol/http-contract.js";
import type {
  CtlItemWire,
  CommandInfoWire,
  CommandOutputWire,
  DialogClosedWire,
  DialogWire,
  FleetRowWire,
  QueueItemWire,
  SessionInfo,
  StatusInfo,
  WireEntry,
  WireMessage,
} from "../../src/web-hub/protocol/messages.js";
import { PROTO } from "../../src/web-hub/protocol/version.js";
import { readPackageVersion } from "../../src/web-hub/ui/build-info-plugin.js";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve as resolvePath, sep } from "node:path";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const DEFAULT_UI_DIST = resolve(REPO_ROOT, "dist/web-hub-ui");

const DEV_STATIC_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
const DEV_STATIC_MAX_BYTES = 8 * 1024 * 1024;
const DEV_AUTH_MODE_PLACEHOLDER = 'data-auth-mode="__AUTH_MODE__"';

function devWithin(root: string, target: string): boolean {
  const base = root.endsWith(sep) ? root : root + sep;
  return target.startsWith(base);
}

/** Decode + validate a URL path into a root-relative path, or undefined if unsafe (same rules
 * the legacy `hub/static.ts` used to apply — kept here since P5b deleted that module's copy, see
 * the module doc comment). */
function devSafeRelativePath(urlPath: string): string | undefined {
  const raw = urlPath.split("?")[0]!.split("#")[0]!;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  if (!decoded.startsWith("/")) return undefined;
  if (decoded.includes("\0") || decoded.includes("\\") || decoded.includes("..")) return undefined;
  const rel = decoded === "/" ? "index.html" : decoded.slice(1);
  const segments = rel.split("/");
  if (segments.some((s) => s.length === 0 || s.startsWith("."))) return undefined;
  if (!(extname(rel).toLowerCase() in DEV_STATIC_CONTENT_TYPES)) return undefined;
  return rel;
}

async function devTryServe(root: string, rel: string, res: ServerResponse): Promise<boolean> {
  const absRoot = resolvePath(root);
  const target = resolvePath(absRoot, rel);
  if (!devWithin(absRoot, target)) return false;
  let data: Buffer;
  try {
    const [realRoot, realTarget] = await Promise.all([realpath(absRoot), realpath(target)]);
    if (!devWithin(realRoot, realTarget)) return false;
    const st = await stat(realTarget);
    if (!st.isFile() || st.size > DEV_STATIC_MAX_BYTES) return false;
    data = await readFile(realTarget);
  } catch {
    return false;
  }
  if (res.headersSent || res.destroyed) return true;
  res.writeHead(200, {
    "Content-Type": DEV_STATIC_CONTENT_TYPES[extname(rel).toLowerCase()]!,
    "Content-Length": data.length,
    "Cache-Control": "no-cache",
  });
  res.end(data);
  return true;
}

async function devServeIndex(root: string, res: ServerResponse, authMode: "token" | "password"): Promise<boolean> {
  const absRoot = resolvePath(root);
  const target = resolvePath(absRoot, "index.html");
  if (!devWithin(absRoot, target)) return false;
  let text: string;
  try {
    const [realRoot, realTarget] = await Promise.all([realpath(absRoot), realpath(target)]);
    if (!devWithin(realRoot, realTarget)) return false;
    const st = await stat(realTarget);
    if (!st.isFile() || st.size > DEV_STATIC_MAX_BYTES) return false;
    text = await readFile(realTarget, "utf8");
  } catch {
    return false;
  }
  if (res.headersSent || res.destroyed) return true;
  const body = text.includes(DEV_AUTH_MODE_PLACEHOLDER)
    ? text.replace(DEV_AUTH_MODE_PLACEHOLDER, `data-auth-mode="${authMode}"`)
    : text;
  const data = Buffer.from(body, "utf8");
  res.writeHead(200, {
    "Content-Type": DEV_STATIC_CONTENT_TYPES[".html"]!,
    "Content-Length": data.length,
    "Cache-Control": "no-cache",
  });
  res.end(data);
  return true;
}

async function devServeStatic(
  root: string,
  urlPath: string,
  res: ServerResponse,
  opts?: { authMode?: "token" | "password" },
): Promise<boolean> {
  const rel = devSafeRelativePath(urlPath);
  if (rel === undefined) return false;
  if (rel === "index.html" && opts?.authMode !== undefined) return devServeIndex(root, res, opts.authMode);
  return devTryServe(root, rel, res);
}
export const FIXTURES_DIR = resolve(REPO_ROOT, "tests/fixtures/web-hub-ui");

// ---------------------------------------------------------------------------
// fixture shape
// ---------------------------------------------------------------------------

/** One extra frame `dev-hub` fires `atMs` after a client's `/api/events` connects. Mirrors the
 * real hub's `onHubEvent` (`src/web-hub/hub/http.ts`): only `ev`/`gap`/`append` are *scoped*
 * (routed through `sse.publish(event, data, agentKey)`, reaching only clients subscribed to that
 * `agentKey` — `agentKey` is required on the fixture entry so the routing has something to key
 * on); every other event (`agent_up`/`agent_down`/`agent_stale`/`session`/`status`/`fleet`/
 * `prompt`, plus the P2 control frames `dialogs`/`ctl`/`commands`/`cmd_late` and the hub
 * lifecycle frame `hub`) is a *global* broadcast (`sse.publish(event, data)`, no third argument —
 * reaches every connected client whether or not it ever subscribed) — a fixture entry may still
 * carry `agentKey` on one of these for `applyScriptEvent`'s own in-memory bookkeeping (agent
 * list, dialogs/ctl/commands slots, hub state), it is simply never passed to `sse.publish` for
 * them. `hub` events are MERGED into the current hub state and rebroadcast as a full `hub` frame
 * (same shape as the attach-time one); `dialogs`/`ctl`/`commands` events replace their slot
 * before broadcasting, so a late-connecting client sees the post-effect state too. */
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

/** Fields merged into the SSE `hub` frame (§6.6/v2.1: caps, hub lifecycle states for
 * `HubStateBanner`). A checked-in fixture uses `supersedeDeadlineInMs` (relative) instead of
 * `supersedeDeadlineAt` so the countdown demo never expires in the repo; dev-hub converts it to
 * `Date.now() + ms` at startup and never sends the relative key on the wire. */
export interface DevHubHubState {
  readonly caps?: readonly string[];
  readonly state?: "running" | "stopping" | "restarting";
  readonly nextVersion?: string;
  readonly supersedePending?: boolean;
  readonly supersedeDeadlineAt?: number;
  readonly supersedeDeadlineInMs?: number;
  readonly forced?: boolean;
  readonly draining?: boolean;
}

/** §3.2 slots, keyed by agentKey. `dialogs` seeds both the `agents`-frame card field and the
 * post-subscribe `dialogs` frame (§6.6), and is the state `POST /api/dialog` mutates (a web
 * answer moves the dialog `open` → `closed{by:"web", cmdId}` — the dual-channel race demo). */
export interface DevHubDialogsSlot {
  readonly epoch: string;
  readonly open: readonly DialogWire[];
  readonly closed: readonly DialogClosedWire[];
}
export interface DevHubCtlSlot {
  readonly epoch: string;
  readonly sessionId: string;
  readonly items: readonly CtlItemWire[];
}
export interface DevHubCommandsSlot {
  readonly epoch: string;
  readonly items: readonly CommandInfoWire[];
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
  readonly hubState?: DevHubHubState;
  readonly dialogs?: Readonly<Record<string, DevHubDialogsSlot>>;
  readonly ctl?: Readonly<Record<string, DevHubCtlSlot>>;
  readonly commands?: Readonly<Record<string, DevHubCommandsSlot>>;
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
  const hubState = raw["hubState"];
  if (hubState !== undefined) {
    if (!isRecord(hubState)) throw new Error(`${sourceLabel}: "hubState" must be an object`);
    for (const key of Object.keys(hubState)) {
      if (
        ![
          "caps",
          "state",
          "nextVersion",
          "supersedePending",
          "supersedeDeadlineAt",
          "supersedeDeadlineInMs",
          "forced",
          "draining",
        ].includes(key)
      ) {
        throw new Error(`${sourceLabel}: hubState has unknown key "${key}"`);
      }
    }
    if (hubState["caps"] !== undefined && !Array.isArray(hubState["caps"])) {
      throw new Error(`${sourceLabel}: hubState.caps must be an array`);
    }
    if (
      hubState["state"] !== undefined &&
      hubState["state"] !== "running" &&
      hubState["state"] !== "stopping" &&
      hubState["state"] !== "restarting"
    ) {
      throw new Error(`${sourceLabel}: hubState.state must be running|stopping|restarting`);
    }
  }
  const dialogs = raw["dialogs"];
  if (dialogs !== undefined) {
    if (!isRecord(dialogs)) throw new Error(`${sourceLabel}: "dialogs" must be an object`);
    for (const [agentKey, slot] of Object.entries(dialogs)) {
      if (
        !isRecord(slot) ||
        typeof slot["epoch"] !== "string" ||
        !Array.isArray(slot["open"]) ||
        !Array.isArray(slot["closed"])
      ) {
        throw new Error(`${sourceLabel}: dialogs["${agentKey}"] must be { epoch, open[], closed[] }`);
      }
    }
  }
  const ctl = raw["ctl"];
  if (ctl !== undefined) {
    if (!isRecord(ctl)) throw new Error(`${sourceLabel}: "ctl" must be an object`);
    for (const [agentKey, slot] of Object.entries(ctl)) {
      if (
        !isRecord(slot) ||
        typeof slot["epoch"] !== "string" ||
        typeof slot["sessionId"] !== "string" ||
        !Array.isArray(slot["items"])
      ) {
        throw new Error(`${sourceLabel}: ctl["${agentKey}"] must be { epoch, sessionId, items[] }`);
      }
    }
  }
  const commands = raw["commands"];
  if (commands !== undefined) {
    if (!isRecord(commands)) throw new Error(`${sourceLabel}: "commands" must be an object`);
    for (const [agentKey, slot] of Object.entries(commands)) {
      if (!isRecord(slot) || typeof slot["epoch"] !== "string" || !Array.isArray(slot["items"])) {
        throw new Error(`${sourceLabel}: commands["${agentKey}"] must be { epoch, items[] }`);
      }
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
  /** Every `/api/cmd` + `/api/dialog` request this dev-hub instance has answered (newest last,
   * capped at 256) — the K16 Origin-echo probe and `dev-hub.test.ts` read headers/statuses back
   * from here instead of standing up their own capture server. */
  controlRequests(): readonly DevHubControlRequest[];
  close(): Promise<void>;
}

const BIND_HOST = "127.0.0.1";
const DEV_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** How long a `[timeout]`-marked command stays `running` in the fake ledger before settling as
 * ok and broadcasting `cmd_late` (the unknown→queryOnly demo path, §3.4/§4.5). Exported so
 * `dev-hub.test.ts` can bound its waits instead of hard-coding a number. */
export const DEV_HUB_LATE_SETTLE_MS = 900;
/** How long a `[slow]`-marked command delays its (successful) response — exercises the
 * browser's in-flight state without ever tripping the 16s fetch timeout. */
export const DEV_HUB_SLOW_MS = 1_200;

/** One recorded `/api/cmd` or `/api/dialog` request (control-plan §9.3 "记录请求"). Headers are
 * kept because the K16 Origin-echo probe (`visual/checks-control.ts --probe`) reads them back
 * in-process; `responseStatus`/`responseCode` are filled in when the response is sent. */
export interface DevHubControlRequest {
  readonly path: "/api/cmd" | "/api/dialog";
  readonly at: number;
  agentKey?: string;
  id?: string;
  op?: string;
  origin?: string;
  secFetchSite?: string;
  responseStatus?: number;
  responseCode?: string;
}

/** Fake per-hub idempotency ledger (§3.4/§4.5's hub LRU + agent 台账, merged — dev-hub is both
 * ends). `done` entries only ever hold successes and non-retryable failures (retryable,
 * effect-none failures are never stored, exactly like the real hub); `running` entries are the
 * `[timeout]` path, settled later by `scheduleLateSettle`. */
interface DevLedgerEntry {
  readonly payload: string;
  state: "running" | "done";
  status?: number;
  body?: unknown;
}

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

/** §6.3 step 2's extra write-endpoint rule (D8, both listeners): `Sec-Fetch-Site`, WHEN the
 * browser sends one at all, must be `same-origin`. Absent is fine — K16 measured LAN plain-HTTP
 * Chromium sending no `Sec-Fetch-Site` at all, and the real gate deliberately doesn't require it. */
function secFetchSiteOk(req: IncomingMessage): boolean {
  const sfs = req.headers["sec-fetch-site"];
  if (sfs === undefined) return true;
  return sfs.toLowerCase() === "same-origin";
}

/** The loopback *write* gate (§6.3 step 2, stricter than `csrfOk`): JSON + `X-PWH: 1` +
 * `Origin` REQUIRED and equal to `http://<Host>` + `secFetchSiteOk`. Used only for
 * `/api/cmd`/`/api/dialog` in `--mode token`. */
function csrfOkWriteLoopback(req: IncomingMessage): boolean {
  const ct = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (ct !== "application/json") return false;
  if (req.headers["x-pwh"] !== "1") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  if (origin.toLowerCase() !== `http://${(req.headers.host ?? "").toLowerCase()}`) return false;
  return secFetchSiteOk(req);
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

interface MutableDialogsSlot {
  epoch: string;
  open: DialogWire[];
  closed: DialogClosedWire[];
}
interface MutableCtlSlot {
  readonly epoch: string;
  readonly sessionId: string;
  items: CtlItemWire[];
}
interface MutableCommandsSlot {
  readonly epoch: string;
  items: CommandInfoWire[];
}

interface DevAgentState {
  agents: Map<string, AgentCard>;
  dialogs: Map<string, MutableDialogsSlot>;
  ctl: Map<string, MutableCtlSlot>;
  commands: Map<string, MutableCommandsSlot>;
}

/** Side-effecting merge hook for scripted `hub` frames (v2.1 §6.7 states): the script event's
 * data is merged into dev-hub's current hub state and the full resulting `hub` frame (same
 * shape `openEvents` sends at attach) is returned for broadcast. */
export interface DevHubScriptHooks {
  mergeHubState(data: Record<string, unknown>): Record<string, unknown>;
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
 * nor `clientId` (`hub/http.ts`'s `onHubEvent`, the non-`scoped()` branches). The P2 control
 * events (`dialogs`/`ctl`/`commands`/`cmd_late`) are global too — their payload carries the
 * `agentKey` (§6.6); `hub` is the hub's own lifecycle frame (v2.1 §6.7). */
const GLOBAL_SSE_EVENTS: ReadonlySet<SseEventName> = new Set([
  "agent_up",
  "agent_down",
  "agent_stale",
  "session",
  "status",
  "fleet",
  "prompt",
  "dialogs",
  "ctl",
  "commands",
  "cmd_late",
  "hub",
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
  hooks: DevHubScriptHooks,
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
  if (ev.event === "hub" && isRecord(ev.data)) {
    sse.publish("hub", hooks.mergeHubState(ev.data));
    return;
  }
  if (ev.event === "dialogs" && isRecord(ev.data) && typeof ev.data["agentKey"] === "string") {
    // Slot update mirrors what a real agent's `dialogs` frame does to the hub registry: the
    // whole slot is replaced (covering the dual-channel race demo — e.g. `by:"tui"` closing a
    // dialog the web form is displaying) BEFORE the broadcast, so a client connecting right
    // after sees the post-effect state in the `agents` frame too.
    if (typeof ev.data["epoch"] === "string" && Array.isArray(ev.data["open"]) && Array.isArray(ev.data["closed"])) {
      state.dialogs.set(ev.data["agentKey"], {
        epoch: ev.data["epoch"],
        open: ev.data["open"] as DialogWire[],
        closed: ev.data["closed"] as DialogClosedWire[],
      });
    }
    sse.publish("dialogs", ev.data);
    return;
  }
  if (ev.event === "ctl" && isRecord(ev.data) && typeof ev.data["agentKey"] === "string") {
    if (
      typeof ev.data["epoch"] === "string" &&
      typeof ev.data["sessionId"] === "string" &&
      Array.isArray(ev.data["items"])
    ) {
      state.ctl.set(ev.data["agentKey"], {
        epoch: ev.data["epoch"],
        sessionId: ev.data["sessionId"],
        items: ev.data["items"] as CtlItemWire[],
      });
    }
    sse.publish("ctl", ev.data);
    return;
  }
  if (ev.event === "commands" && isRecord(ev.data) && typeof ev.data["agentKey"] === "string") {
    if (typeof ev.data["epoch"] === "string" && Array.isArray(ev.data["items"])) {
      state.commands.set(ev.data["agentKey"], {
        epoch: ev.data["epoch"],
        items: ev.data["items"] as CommandInfoWire[],
      });
    }
    sse.publish("commands", ev.data);
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

  // See module doc comment above: a manifest present -> route through the real production
  // static server instead of the raw fallback.
  const hasManifest = existsSync(join(root, "build-info.json"));
  const uiServer: UiServer | undefined = hasManifest
    ? createUiServer({
        candidates: [{ ok: true, spec: { kind: "package", dir: root } }],
        hubVersion: await readPackageVersion(),
        log: { info: () => {}, warn: () => {}, error: () => {} },
      })
    : undefined;
  if (uiServer !== undefined) {
    const status = await uiServer.refresh();
    log(`dev-hub: static serving via createUiServer (production path), root=${root}, ui status=${status.state}`);
  } else {
    log(`dev-hub: static serving via devServeStatic (raw fallback, no build-info.json manifest at ${root})`);
  }

  const state: DevAgentState = {
    agents: new Map(fixture.agents.map((a) => [a.agentKey, a])),
    dialogs: new Map(
      Object.entries(fixture.dialogs ?? {}).map(([k, s]) => [
        k,
        { epoch: s.epoch, open: [...s.open], closed: [...s.closed] },
      ]),
    ),
    ctl: new Map(Object.entries(fixture.ctl ?? {}).map(([k, s]) => [k, { ...s, items: [...s.items] }])),
    commands: new Map(
      Object.entries(fixture.commands ?? {}).map(([k, s]) => [k, { epoch: s.epoch, items: [...s.items] }]),
    ),
  };
  const sse = createSseHub({ now: () => Date.now(), pingMs: 15_000 });
  const pending = new Map<string, Map<string, PendingSub>>(); // clientId -> agentKey -> PendingSub

  // --- hub lifecycle state (v2.1 §6.6/§6.7): fixture-seeded, script-`hub`-event-mutable -------
  const hubStateStartedAt = Date.now();
  const hubStateMutable: Record<string, unknown> = {};
  {
    const seed = fixture.hubState;
    if (seed !== undefined) {
      if (seed.caps !== undefined) hubStateMutable["caps"] = [...seed.caps];
      if (seed.state !== undefined) hubStateMutable["state"] = seed.state;
      if (seed.nextVersion !== undefined) hubStateMutable["nextVersion"] = seed.nextVersion;
      if (seed.supersedePending !== undefined) hubStateMutable["supersedePending"] = seed.supersedePending;
      if (seed.supersedeDeadlineAt !== undefined) hubStateMutable["supersedeDeadlineAt"] = seed.supersedeDeadlineAt;
      if (seed.supersedeDeadlineInMs !== undefined) {
        hubStateMutable["supersedeDeadlineAt"] = hubStateStartedAt + seed.supersedeDeadlineInMs;
      }
      if (seed.forced !== undefined) hubStateMutable["forced"] = seed.forced;
      if (seed.draining !== undefined) hubStateMutable["draining"] = seed.draining;
    }
  }
  function hubFrame(): Record<string, unknown> {
    return {
      version: "0.0.0-dev-hub",
      buildId: "dev-hub@fixture",
      pid: process.pid,
      startedAt: hubStateStartedAt,
      proto: PROTO,
      port,
      ...hubStateMutable,
    };
  }
  const scriptHooks: DevHubScriptHooks = {
    mergeHubState(data: Record<string, unknown>): Record<string, unknown> {
      if (typeof data["supersedeDeadlineInMs"] === "number") {
        hubStateMutable["supersedeDeadlineAt"] = Date.now() + data["supersedeDeadlineInMs"];
      }
      for (const [k, v] of Object.entries(data)) {
        if (k === "supersedeDeadlineInMs") continue; // dev-only relative form, never on the wire
        hubStateMutable[k] = v;
      }
      return hubFrame();
    },
  };

  // --- fake control plane (§6.2 endpoints, §3.4/§4.5 ledger, §9.3 request recording) ----------
  const ledger = new Map<string, DevLedgerEntry>();
  const controlRequests: DevHubControlRequest[] = [];
  const CONTROL_REQUEST_LOG_CAP = 256;
  const lateTimers: ReturnType<typeof setTimeout>[] = [];
  let queueSeq = 0;

  function recordControlRequest(
    req: IncomingMessage,
    path: "/api/cmd" | "/api/dialog",
    body: unknown,
  ): DevHubControlRequest {
    const rec: DevHubControlRequest = { path, at: Date.now() };
    const agentKey = stringField(body, "agentKey");
    const id = stringField(body, "id");
    const op = stringField(body, "op") ?? stringField(body, "action");
    if (agentKey !== undefined) rec.agentKey = agentKey;
    if (id !== undefined) rec.id = id;
    if (op !== undefined) rec.op = op;
    if (typeof req.headers.origin === "string") rec.origin = req.headers.origin;
    const sfs = req.headers["sec-fetch-site"];
    if (typeof sfs === "string") rec.secFetchSite = sfs;
    controlRequests.push(rec);
    if (controlRequests.length > CONTROL_REQUEST_LOG_CAP) {
      controlRequests.splice(0, controlRequests.length - CONTROL_REQUEST_LOG_CAP);
    }
    return rec;
  }

  /** Dedupe digest: the whole request body minus the transport-only keys (`id`, `queryOnly`,
   * `retry`) — same id + different remaining payload ⇒ 409 "id reused" (§3.4). */
  function payloadDigest(path: string, body: unknown): string {
    if (!isRecord(body)) return path;
    const rest: Record<string, unknown> = { ...body };
    delete rest["id"];
    delete rest["queryOnly"];
    delete rest["retry"];
    return path + "\n" + JSON.stringify(rest);
  }

  function scheduleLateSettle(
    agentKey: string,
    id: string,
    op: string,
    entry: DevLedgerEntry,
    settledBody: Record<string, unknown>,
    lateSseData: Record<string, unknown>,
  ): void {
    const t = setTimeout(() => {
      entry.state = "done";
      entry.status = 200;
      entry.body = settledBody;
      // §6.6: `cmd_late` is a broadcast and NEVER carries `output` (the initiating page fetches
      // it back with `queryOnly`) — `lateSseData` is deliberately the caller's stripped shape.
      sse.publish("cmd_late", { agentKey, id, op, ok: true, data: lateSseData });
    }, DEV_HUB_LATE_SETTLE_MS);
    t.unref?.();
    lateTimers.push(t);
  }

  /** Upserts one item into the agent's `ctl` slot (§4.3/§4.5 projection, ≤32, newest first) and
   * broadcasts it — a web prompt becoming visible in the pending-items UI without a page reload. */
  function bumpCtl(agentKey: string, card: AgentCard, item: CtlItemWire): void {
    const existing = state.ctl.get(agentKey);
    const slot: MutableCtlSlot = existing ?? {
      epoch: card.epoch ?? "dev-epoch-1",
      sessionId: card.session?.sessionId ?? "dev-session",
      items: [],
    };
    slot.items = [item, ...slot.items.filter((i) => i.cmdId !== item.cmdId)].slice(0, 32);
    state.ctl.set(agentKey, slot);
    sse.publish("ctl", { agentKey, epoch: slot.epoch, sessionId: slot.sessionId, items: slot.items });
  }

  /** Mirrors §4.4's queue mirror: a successfully queued web prompt joins `status.queue` (with
   * its cmdId) and the new status is broadcast — the web message visibly lining up behind TUI
   * entries, exactly like the real agent would report it. */
  function pushQueueItem(
    agentKey: string,
    card: AgentCard,
    text: string,
    deliver: "steer" | "followUp",
    cmdId: string,
  ): void {
    const status: StatusInfo = { ...(card.status ?? { leafId: null, busy: true, pending: false }) };
    const item: QueueItemWire = {
      id: `q-web-${++queueSeq}`,
      text: text.length > 200 ? text.slice(0, 199) + "…" : text,
      deliver,
      source: "web",
      cmdId,
      at: Date.now(),
    };
    status.queue = [...(status.queue ?? []), item].slice(-32);
    status.pending = true;
    const next: AgentCard = { ...card, status };
    state.agents.set(agentKey, next);
    sse.publish("status", { agentKey, status });
  }

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
    // §6.6: the `agents` frame's cards carry the dialogs slot's current value (open ask_user
    // badges on the list view without subscribing first).
    const slot = state.dialogs.get(a.agentKey);
    if (slot === undefined) return a;
    return { ...a, dialogs: { epoch: slot.epoch, open: slot.open, closed: slot.closed } };
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
      // §6.6: the control slots this fixture seeds are delivered with the snapshot — a client
      // that just subscribed sees the same open dialogs / pending items / command list as one
      // that was connected all along, without waiting for the next slot refresh.
      const dSlot = state.dialogs.get(agentKey);
      if (dSlot !== undefined) {
        client.send("dialogs", { agentKey, epoch: dSlot.epoch, open: dSlot.open, closed: dSlot.closed });
      }
      const cSlot = state.ctl.get(agentKey);
      if (cSlot !== undefined) {
        client.send("ctl", { agentKey, epoch: cSlot.epoch, sessionId: cSlot.sessionId, items: cSlot.items });
      }
      const cmdSlot = state.commands.get(agentKey);
      if (cmdSlot !== undefined) {
        client.send("commands", { agentKey, epoch: cmdSlot.epoch, items: cmdSlot.items });
      }
      client.subscribed.add(agentKey);
    });
  }

  function handleUnsubscribe(clientId: string, agentKey: string, res: ServerResponse): void {
    sse.get(clientId)?.subscribed.delete(agentKey);
    deletePending(clientId, agentKey);
    sendJson(res, 200, { ok: true });
  }

  // ----------------------------------------------------------------------
  // fake control plane: POST /api/cmd + POST /api/dialog (§6.2 shapes)
  // ----------------------------------------------------------------------

  function delay(ms: number): Promise<void> {
    return new Promise((resolveP) => {
      const t = setTimeout(resolveP, ms);
      t.unref?.();
    });
  }

  function expectSessionMismatch(body: unknown, card: AgentCard): boolean {
    const e = field(body, "expect");
    if (!isRecord(e)) return false;
    const sid = e["sessionId"];
    if (typeof sid !== "string" || sid.length === 0) return false;
    return card.session?.sessionId !== sid;
  }

  /** Demo `CommandOutputWire` for captured pi-toolkit commands (§4.9) — the kind variety
   * (`notify`/`status`/`text`/`interactive` + `needsTerminal`) `CommandResult.vue` has to render. */
  function demoCommandOutput(name: string, args: string): CommandOutputWire {
    switch (name) {
      case "agent":
        return { entries: [{ kind: "notify", level: "info", text: "2 agents · 1 running · slots 3/8 free" }] };
      case "tasklist":
        return {
          entries: [
            {
              kind: "notify",
              level: "info",
              text: "#1 finish the queue mirror (in_progress)\n#2 run full gates (pending)",
            },
          ],
        };
      case "mem":
        return {
          entries: [
            { kind: "text", title: "mem doctor", text: "D01 ok · D02 ok · 12 files · 3.1 KiB" },
            { kind: "interactive", title: "mem doctor", text: "editor" },
          ],
          needsTerminal: true,
        };
      case "cache-ttl":
        return { entries: [{ kind: "status", key: "cache-ttl", text: "ttl auto · 5m" }] };
      case "webhub":
        return { entries: [{ kind: "notify", level: "info", text: `hub running · 127.0.0.1:${port}` }] };
      default:
        return {
          entries: [{ kind: "notify", level: "info", text: `/${name}${args.length > 0 ? " " + args : ""} done` }],
        };
    }
  }

  /** Dedupe replay + `queryOnly` answer (§3.4/§4.5). Returns `{answered:false, digest}` when the
   * request must actually execute; any other outcome (dup replay, query answer, id-reuse 409,
   * E_UNKNOWN_ID, still-running 504) is fully sent here. */
  function ledgerReplay(
    path: "/api/cmd" | "/api/dialog",
    body: unknown,
    id: string,
    rec: DevHubControlRequest,
    res: ServerResponse,
  ): { answered: true } | { answered: false; digest: string } {
    const digest = payloadDigest(path, body);
    const existing = ledger.get(id);
    if (existing !== undefined && existing.payload !== digest) {
      rec.responseStatus = 409;
      rec.responseCode = "E_BAD_REQUEST";
      sendJson(res, 409, {
        error: "E_BAD_REQUEST",
        message: "id reused with a different payload",
        id,
        retryable: false,
        effect: "none",
      });
      return { answered: true };
    }
    if (field(body, "queryOnly") === true) {
      if (existing === undefined) {
        rec.responseStatus = 404;
        rec.responseCode = "E_UNKNOWN_ID";
        sendJson(res, 404, { error: "E_UNKNOWN_ID", id, retryable: false, effect: "none" });
        return { answered: true };
      }
      let data: unknown;
      if (existing.state === "running") {
        data = { op: "query", state: "running" };
      } else if (existing.status === 200) {
        const b = existing.body;
        data = { op: "query", state: "ok", result: { ok: true, data: isRecord(b) ? b["data"] : undefined } };
      } else {
        const b = existing.body;
        const code = isRecord(b) && typeof b["error"] === "string" ? b["error"] : "E_DEADLINE";
        data = { op: "query", state: "failed", result: { ok: false, code, retryable: false, effect: "none" } };
      }
      rec.responseStatus = 200;
      sendJson(res, 200, { ok: true, id, dup: true, data });
      return { answered: true };
    }
    if (existing !== undefined) {
      if (existing.state === "running") {
        rec.responseStatus = 504;
        rec.responseCode = "E_DEADLINE";
        sendJson(res, 504, { error: "E_DEADLINE", id, retryable: true, effect: "unknown" });
        return { answered: true };
      }
      rec.responseStatus = existing.status ?? 200;
      const b = existing.body;
      sendJson(res, existing.status ?? 200, isRecord(b) && b["ok"] === true ? { ...b, dup: true } : b);
      return { answered: true };
    }
    return { answered: false, digest };
  }

  interface FailOpts {
    readonly message?: string;
    readonly retryable: boolean;
    readonly effect?: "none" | "unknown";
    /** Terminal (non-retryable) failures are cached in the ledger — a same-id retry replays
     * them (§3.4 "done 只存成功与不可重试失败"). */
    readonly terminal?: boolean;
  }

  async function handleCmd(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const rec = recordControlRequest(req, "/api/cmd", body);
    let storeDone: ((status: number, responseBody: unknown) => void) | undefined;
    const fail = (status: number, code: string, opts: FailOpts): void => {
      rec.responseStatus = status;
      rec.responseCode = code;
      const id = stringField(body, "id");
      const responseBody: Record<string, unknown> = { error: code };
      if (opts.message !== undefined) responseBody["message"] = opts.message;
      if (id !== undefined) responseBody["id"] = id;
      responseBody["retryable"] = opts.retryable;
      if (opts.effect !== undefined) responseBody["effect"] = opts.effect;
      if (opts.terminal === true) storeDone?.(status, responseBody);
      sendJson(res, status, responseBody);
    };
    const ok200 = (data: unknown): void => {
      const id = stringField(body, "id")!;
      const responseBody = { ok: true, id, data };
      storeDone?.(200, responseBody);
      rec.responseStatus = 200;
      sendJson(res, 200, responseBody);
    };

    const agentKey = stringField(body, "agentKey");
    const id = stringField(body, "id");
    const op = stringField(body, "op");
    if (agentKey === undefined || id === undefined || op === undefined) {
      return fail(400, "E_BAD_REQUEST", { retryable: false, effect: "none", message: "agentKey/id/op required" });
    }
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
      return fail(400, "E_BAD_REQUEST", { retryable: false, effect: "none", message: "bad id format" });
    }
    const card = state.agents.get(agentKey);
    if (card === undefined) return fail(404, "E_NOT_FOUND", { retryable: false, effect: "none" });
    if (card.state === "stale") return fail(503, "E_AGENT_GONE", { retryable: false, effect: "none" });
    // §6.3 step 6: an agent that never advertised control (`AgentCard.control`) gets no frame
    // forwarded at all — same 409 the real router answers for an old pi-toolkit.
    if (card.control !== true) return fail(409, "E_UNSUPPORTED", { retryable: false, effect: "none" });

    const gate = ledgerReplay("/api/cmd", body, id, rec, res);
    if (gate.answered) return;
    const digest = gate.digest;
    storeDone = (status, responseBody) =>
      ledger.set(id, { payload: digest, state: "done", status, body: responseBody });

    if (op === "prompt") {
      const text = field(body, "text");
      if (typeof text !== "string" || text.trim().length === 0 || Buffer.byteLength(text, "utf8") > 48 * 1024) {
        return fail(400, "E_BAD_REQUEST", { retryable: false, effect: "none", message: "empty or oversized text" });
      }
      if (expectSessionMismatch(body, card)) {
        return fail(409, "E_SESSION_CHANGED", { retryable: false, effect: "none", terminal: true });
      }
      if (text.includes("[compacting]")) return fail(409, "E_BUSY_COMPACTING", { retryable: true, effect: "none" });
      if (text.includes("[stale-ctx]")) return fail(409, "E_STALE_CTX", { retryable: true, effect: "none" });
      if (text.includes("[timeout]")) {
        const entry: DevLedgerEntry = { payload: digest, state: "running" };
        ledger.set(id, entry);
        scheduleLateSettle(
          agentKey,
          id,
          "prompt",
          entry,
          { ok: true, id, data: { op: "prompt", delivery: "unobserved" } },
          { op: "prompt", delivery: "unobserved" },
        );
        return fail(504, "E_DEADLINE", { retryable: true, effect: "unknown", message: "agent deadline" });
      }
      if (text.includes("[slow]")) await delay(DEV_HUB_SLOW_MS);
      const busy = card.status?.busy === true;
      const behavior: "idle" | "steer" | "followUp" = busy
        ? field(body, "deliver") === "followUp"
          ? "followUp"
          : "steer"
        : "idle";
      const delivery = text.includes("[unobserved]");
      if (behavior !== "idle") {
        pushQueueItem(agentKey, card, text, behavior, id);
      }
      const now = Date.now();
      bumpCtl(agentKey, card, {
        cmdId: id,
        op: "prompt",
        state: delivery ? "dispatched" : behavior === "idle" ? "started" : "queued",
        behavior,
        at: now,
        updatedAt: now,
      });
      return ok200({ op: "prompt", delivery: delivery ? "unobserved" : "observed", behavior });
    }

    if (op === "abort") {
      if (expectSessionMismatch(body, card)) {
        return fail(409, "E_SESSION_CHANGED", { retryable: false, effect: "none", terminal: true });
      }
      return ok200({ op: "abort", wasBusy: card.status?.busy === true });
    }

    if (op === "steer_subagent") {
      const runId = stringField(body, "runId");
      const text = field(body, "text");
      if (runId === undefined || typeof text !== "string") {
        return fail(400, "E_BAD_REQUEST", { retryable: false, effect: "none", message: "runId/text required" });
      }
      if (runId.startsWith("r_missing")) {
        return fail(404, "E_NOT_FOUND", { retryable: false, effect: "none", terminal: true });
      }
      if (runId.endsWith("_done")) {
        return fail(409, "E_NOT_RUNNING", { retryable: false, effect: "none", terminal: true });
      }
      if (text.includes("[reject]")) {
        return fail(422, "E_SUBAGENT_REJECTED", {
          retryable: false,
          effect: "none",
          terminal: true,
          message: "steer_rejected: run is draining",
        });
      }
      if (text.includes("[timeout]")) {
        const entry: DevLedgerEntry = { payload: digest, state: "running" };
        ledger.set(id, entry);
        scheduleLateSettle(
          agentKey,
          id,
          "steer_subagent",
          entry,
          { ok: true, id, data: { op: "steer_subagent" } },
          { op: "steer_subagent" },
        );
        return fail(504, "E_DEADLINE", { retryable: true, effect: "unknown", message: "steer deadline" });
      }
      if (text.includes("[slow]")) await delay(DEV_HUB_SLOW_MS);
      return ok200({ op: "steer_subagent" });
    }

    if (op === "abort_subagent") {
      const runId = stringField(body, "runId");
      if (runId === undefined) {
        return fail(400, "E_BAD_REQUEST", { retryable: false, effect: "none", message: "runId required" });
      }
      if (runId.startsWith("r_missing")) {
        return fail(404, "E_NOT_FOUND", { retryable: false, effect: "none", terminal: true });
      }
      if (runId.endsWith("_done")) return ok200({ op: "abort_subagent", alreadyTerminal: true });
      if (runId.includes("timeout")) {
        const entry: DevLedgerEntry = { payload: digest, state: "running" };
        ledger.set(id, entry);
        scheduleLateSettle(
          agentKey,
          id,
          "abort_subagent",
          entry,
          { ok: true, id, data: { op: "abort_subagent", escalatedTo: "L2" } },
          { op: "abort_subagent", escalatedTo: "L2" },
        );
        return fail(504, "E_DEADLINE", { retryable: true, effect: "unknown", message: "stop deadline" });
      }
      return ok200({ op: "abort_subagent", escalatedTo: "L2" });
    }

    if (op === "command") {
      const name = stringField(body, "name");
      const argsRaw = field(body, "args");
      const args = typeof argsRaw === "string" ? argsRaw : "";
      if (name === undefined || !/^[A-Za-z0-9:_.-]{1,64}$/.test(name)) {
        return fail(400, "E_BAD_REQUEST", { retryable: false, effect: "none", message: "bad command name" });
      }
      const slot = state.commands.get(agentKey);
      const item = slot?.items.find((i) => i.name === name);
      const BUILTIN_DEMO: ReadonlySet<string> = new Set(["session", "compact", "model", "name", "thinking", "new"]);
      if (item === undefined && !BUILTIN_DEMO.has(name)) {
        // §4.6: an unrecognized /xxx NEVER falls through to the model as plain text.
        return fail(404, "E_UNKNOWN_COMMAND", { retryable: false, effect: "none" });
      }
      const kind: "extension" | "template" | "builtin" =
        item === undefined
          ? "builtin"
          : item.kind === "skill"
            ? "template"
            : item.kind === "template"
              ? "template"
              : item.kind;
      const busy = card.status?.busy === true;
      const policy =
        item === undefined ? "allow" : busy && item.policyBusy !== undefined ? item.policyBusy : item.policy;
      if (policy === "deny") {
        return fail(409, "E_COMMAND_DENIED", {
          retryable: false,
          effect: "none",
          terminal: true,
          message: `/${name} is only available in the terminal`,
        });
      }
      if (policy === "confirm" && field(body, "confirm") !== true) {
        return fail(409, "E_CONFIRM_REQUIRED", {
          retryable: false,
          effect: "none",
          terminal: true,
          message: `Run /${name}${args.length > 0 ? " " + args : ""} on ${agentKey}?`,
        });
      }
      if (args.includes("[timeout]")) {
        const entry: DevLedgerEntry = { payload: digest, state: "running" };
        ledger.set(id, entry);
        scheduleLateSettle(
          agentKey,
          id,
          "command",
          entry,
          { ok: true, id, data: { op: "command", kind, completion: "sync" } },
          { op: "command", kind, completion: "sync" },
        );
        return fail(504, "E_DEADLINE", { retryable: true, effect: "unknown", message: "command deadline" });
      }
      if (args.includes("[slow]")) await delay(DEV_HUB_SLOW_MS);
      if (kind === "builtin") {
        if (name === "compact") {
          // §4.6: compact is async — the HTTP receipt says so, and the completion (or failure)
          // arrives later as a `cmd_late` broadcast; the initiating page refetches with queryOnly.
          ok200({ op: "command", kind: "builtin", completion: "async" });
          const t = setTimeout(() => {
            sse.publish("cmd_late", {
              agentKey,
              id,
              op: "command",
              ok: true,
              data: { op: "command", kind: "builtin", completion: "sync" },
            });
          }, DEV_HUB_LATE_SETTLE_MS);
          t.unref?.();
          lateTimers.push(t);
          return;
        }
        if (name === "session") {
          const s = card.session;
          const text =
            s === undefined
              ? `${agentKey} · no active session`
              : `${s.sessionId} · ${s.name ?? "(unnamed)"} · ${s.model === undefined ? "no model" : `${s.model.provider}/${s.model.id}`} · ${s.cwd}`;
          return ok200({
            op: "command",
            kind: "builtin",
            completion: "sync",
            output: { entries: [{ kind: "text", text }] },
          });
        }
        if (name === "new") {
          // K22 path: the command ctx switches sessions — demo the §4.6 "会话/状态槽变化" echo.
          const s = card.session;
          if (s !== undefined) {
            const nextSession: SessionInfo = { ...s, sessionId: `${s.sessionId}-web-${++queueSeq}` };
            state.agents.set(agentKey, { ...card, session: nextSession });
            sse.publish("session", { agentKey, session: nextSession });
          }
          return ok200({ op: "command", kind: "builtin", completion: "sync" });
        }
        return ok200({
          op: "command",
          kind: "builtin",
          completion: "sync",
          output: { entries: [{ kind: "text", text: `/${name}${args.length > 0 ? " " + args : ""} applied` }] },
        });
      }
      if (kind === "template") {
        return ok200({ op: "command", kind: "template", completion: "unknown" });
      }
      // extension: pi-toolkit's own commands are captured (§4.9 output echo); third-party stays
      // completion:"unknown", captured:false — "output only visible in the terminal".
      if (item?.output === "captured") {
        return ok200({
          op: "command",
          kind: "extension",
          completion: "sync",
          captured: true,
          output: demoCommandOutput(name, args),
        });
      }
      return ok200({ op: "command", kind: "extension", completion: "unknown", captured: false });
    }

    return fail(400, "E_BAD_REQUEST", { retryable: false, effect: "none", message: `unknown op "${op}"` });
  }

  async function handleDialog(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const rec = recordControlRequest(req, "/api/dialog", body);
    let storeDone: ((status: number, responseBody: unknown) => void) | undefined;
    const fail = (status: number, code: string, opts: FailOpts): void => {
      rec.responseStatus = status;
      rec.responseCode = code;
      const id = stringField(body, "id");
      const responseBody: Record<string, unknown> = { error: code };
      if (opts.message !== undefined) responseBody["message"] = opts.message;
      if (id !== undefined) responseBody["id"] = id;
      responseBody["retryable"] = opts.retryable;
      if (opts.effect !== undefined) responseBody["effect"] = opts.effect;
      if (opts.terminal === true) storeDone?.(status, responseBody);
      sendJson(res, status, responseBody);
    };

    const agentKey = stringField(body, "agentKey");
    const id = stringField(body, "id");
    const dialogId = stringField(body, "dialogId");
    const epoch = stringField(body, "epoch");
    const action = stringField(body, "action");
    if (
      agentKey === undefined ||
      id === undefined ||
      dialogId === undefined ||
      epoch === undefined ||
      (action !== "answer" && action !== "cancel")
    ) {
      return fail(400, "E_BAD_REQUEST", {
        retryable: false,
        effect: "none",
        message: "agentKey/id/dialogId/epoch/action required",
      });
    }
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
      return fail(400, "E_BAD_REQUEST", { retryable: false, effect: "none", message: "bad id format" });
    }
    const card = state.agents.get(agentKey);
    if (card === undefined) return fail(404, "E_NOT_FOUND", { retryable: false, effect: "none" });
    if (card.state === "stale") return fail(503, "E_AGENT_GONE", { retryable: false, effect: "none" });
    if (card.control !== true) return fail(409, "E_UNSUPPORTED", { retryable: false, effect: "none" });

    const gate = ledgerReplay("/api/dialog", body, id, rec, res);
    if (gate.answered) return;
    const digest = gate.digest;
    storeDone = (status, responseBody) =>
      ledger.set(id, { payload: digest, state: "done", status, body: responseBody });

    const slot = state.dialogs.get(agentKey);
    if (slot === undefined || slot.epoch !== epoch) {
      // §3.5: stale epoch (/reload) or never-seen dialogId — indistinguishable from "already
      // closed", and deliberately so.
      return fail(409, "E_DIALOG_CLOSED", { retryable: false, effect: "none", terminal: true, message: "stale" });
    }
    const dialog = slot.open.find((d) => d.dialogId === dialogId);
    if (dialog === undefined) {
      return fail(409, "E_DIALOG_CLOSED", { retryable: false, effect: "none", terminal: true, message: "stale" });
    }
    if (action === "cancel" && dialog.allowCancel !== true) {
      return fail(400, "E_BAD_REQUEST", { retryable: false, effect: "none", message: "cancel not allowed" });
    }
    if (action === "answer") {
      const answers = field(body, "answers");
      if (!Array.isArray(answers)) {
        return fail(400, "E_BAD_REQUEST", { retryable: false, effect: "none", message: "answers required" });
      }
      if (answers.length !== dialog.questions.length) {
        return fail(400, "E_BAD_ANSWER", {
          retryable: false,
          effect: "none",
          terminal: true,
          message: `expected ${dialog.questions.length} answer(s), got ${answers.length}`,
        });
      }
      for (const [i, q] of dialog.questions.entries()) {
        const a: unknown = answers[i];
        if (!isRecord(a) || !Array.isArray(a["selected"]) || !(typeof a["other"] === "string" || a["other"] === null)) {
          return fail(400, "E_BAD_ANSWER", {
            retryable: false,
            effect: "none",
            terminal: true,
            message: "malformed answer",
          });
        }
        const selected = a["selected"];
        for (const s of selected) {
          if (typeof s !== "string" || !q.options.some((o) => o.label === s)) {
            return fail(400, "E_BAD_ANSWER", {
              retryable: false,
              effect: "none",
              terminal: true,
              message: `unknown option for question ${i + 1}`,
            });
          }
        }
        if (q.multiSelect !== true && selected.length > 1) {
          return fail(400, "E_BAD_ANSWER", {
            retryable: false,
            effect: "none",
            terminal: true,
            message: "single-select question got multiple values",
          });
        }
        if (a["other"] !== null && q.allowOther === false) {
          return fail(400, "E_BAD_ANSWER", {
            retryable: false,
            effect: "none",
            terminal: true,
            message: "free-text answer not allowed for this question",
          });
        }
      }
    }
    // Dual-channel arbitration (§5, D3): first claim wins. This request just won — any LATER
    // answer (web or TUI) hits the `dialog === undefined` branch above with E_DIALOG_CLOSED and
    // reads the winner's cmdId from `closed[]` (§3.5's "claim 了但响应丢失" reconciliation).
    slot.open = slot.open.filter((d) => d.dialogId !== dialogId);
    const closedEntry: DialogClosedWire = {
      dialogId,
      by: "web",
      outcome: action === "answer" ? "answered" : "cancelled",
      cmdId: id,
      at: Date.now(),
    };
    slot.closed = [closedEntry, ...slot.closed].slice(0, 8);
    sse.publish("dialogs", { agentKey, epoch: slot.epoch, open: slot.open, closed: slot.closed });
    const responseBody = { ok: true, id };
    storeDone(200, responseBody);
    rec.responseStatus = 200;
    sendJson(res, 200, responseBody);
  }

  function openEvents(req: IncomingMessage, res: ServerResponse): SseClient {
    // Real hub's `openEvents` (`hub/http.ts`): a well-formed `Last-Event-ID` drives the SSE ring
    // replay/resync path in `sse.attach`; dev-hub ignoring the header entirely (as before this
    // fix) meant a reconnecting client always silently missed whatever fired while it was gone.
    const raw = req.headers["last-event-id"];
    const lastEventId = typeof raw === "string" && /^\d{1,16}$/.test(raw.trim()) ? Number(raw.trim()) : undefined;
    const client = sse.attach(req, res, lastEventId);
    client.send("hub", hubFrame());
    client.send("agents", { agents: [...state.agents.values()].map(toCard) });
    // P1 fix (todo #26 W3 打回点 A): the fixture's own doc comment (`DevHubScriptEvent`) has
    // always promised "atMs after A CLIENT's /api/events connects" — but this used to be
    // scheduled exactly once, at `createDevHub()` time, i.e. relative to the HUB's own startup.
    // A visual-harness matrix run reuses one hub across ~20-30 cells sequentially; only whichever
    // cell happened to connect before that one global timer fired ever saw the scripted frame
    // (e.g. a `fleet` row for the detail scenario) — every later cell connected to a `/api/events`
    // stream that had already missed it forever, with no replay (script events aren't buffered by
    // `Last-Event-ID` the way a real hub's own ring buffer would). Scheduling per-connection
    // instead (as documented) means every fresh client — one per matrix cell — gets the full
    // script replayed on its own timeline. Idempotent for every event kind actually used by the
    // fixtures this harness drives (`fleet`/`agent_down`/`agent_up`/`agent_stale` all just
    // set/delete/re-publish the same state), so a reconnect (e.g. `checks-common.ts`'s theme
    // persistence check reloads the page 3x per cell) safely replays them again rather than lose
    // them.
    const clientTimers: ReturnType<typeof setTimeout>[] = [];
    for (const ev of fixture.script ?? []) {
      const t = setTimeout(() => applyScriptEvent(state, sse, ev, scoped, scriptHooks), ev.atMs);
      t.unref?.();
      clientTimers.push(t);
      scriptTimers.push(t);
    }
    res.once("close", () => {
      pending.delete(client.id);
      for (const t of clientTimers) clearTimeout(t);
    });
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
      const served =
        uiServer !== undefined
          ? await uiServer.serve(path, res, {
              authMode: opts.mode,
              ...(typeof req.headers["accept-language"] === "string"
                ? { acceptLanguage: req.headers["accept-language"] }
                : {}),
            })
          : await devServeStatic(root, path, res, { authMode: opts.mode });
      if (!served) sendError(res, 404, "E_NOT_FOUND");
      return;
    }

    res.setHeader("Cache-Control", "no-store");

    const isAuthed = (): boolean =>
      opts.mode === "token" ? auth!.check(req.headers.cookie, Date.now()) : pwCheck(req.headers.cookie);

    if (method === "POST") {
      // Password mode fakes the real *LAN* password auth surface, so its CSRF gate mirrors
      // `csrfOkLan` (Origin REQUIRED); token mode fakes the loopback surface (`csrfOk`, Origin
      // optional) — the two are deliberately not interchangeable, same as the real hub. The two
      // control endpoints additionally apply §6.3 step 2's STRICTER write gate (D8): Origin is
      // required on BOTH modes, and `Sec-Fetch-Site` must be `same-origin` whenever present.
      const isWriteEndpoint = path === "/api/cmd" || path === "/api/dialog";
      const csrfPass = isWriteEndpoint
        ? opts.mode === "password"
          ? csrfOkLan(req, canonicalOrigin("http", `127.0.0.1:${port}`)) && secFetchSiteOk(req)
          : csrfOkWriteLoopback(req)
        : opts.mode === "password"
          ? csrfOkLan(req, canonicalOrigin("http", `127.0.0.1:${port}`))
          : csrfOk(req);
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
      if (path === "/api/cmd") {
        await handleCmd(req, res, body);
        return;
      }
      if (path === "/api/dialog") {
        await handleDialog(req, res, body);
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

  log(`dev-hub: listening on http://127.0.0.1:${port} (mode=${opts.mode}, scenario=${opts.scenario})`);
  if (devToken !== undefined) log(`dev-hub: token=${devToken}`);

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    mode: opts.mode,
    scenario: opts.scenario,
    ...(devToken === undefined ? {} : { token: devToken }),
    controlRequests(): readonly DevHubControlRequest[] {
      return controlRequests;
    },
    async close(): Promise<void> {
      for (const t of scriptTimers) clearTimeout(t);
      for (const t of lateTimers) clearTimeout(t);
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
Scenarios come from tests/fixtures/web-hub-ui/<name>.json: dashboard, states, empty, long, streaming (P1);
control, ask-user, commands, hub-states (P2 control plane — control-plan.md §9.3).
The P2 scenarios also answer POST /api/cmd + /api/dialog (success / 409 / 504 unknown → queryOnly /
cmd_late / slow paths — see the module doc comment for the [marker] triggers).`;

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
