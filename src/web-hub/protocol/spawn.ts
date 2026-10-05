/**
 * web-hub spawn protocol (web-hub-spawn plan v2.1 §SP1 / arch v2 §8.1 — frozen interface).
 *
 * Pure TypeScript + typebox, `node:*`-free: the browser UI (SP11) imports the limits and types
 * here for its own prechecks, exactly like `protocol/upload.ts`. Everything on the wire for
 * `/api/headless*` — record projections, policy, the POST body schema — is frozen in this one
 * module so the hub (SP9) and the UI never drift.
 *
 * Field-visibility rules (arch §6.4): `SpawnRecordPublic` is the ONLY shape ever broadcast on
 * the `spawns` SSE event; owner-only fields (`cwd`, `origin.user`, `hintDetail`, `stderrTail`,
 * `uiCancelled[].title`, `firstPrompt.textLen`) live on `SpawnRecordOwner` and are added
 * per-request by `hub/spawn/project.ts` (SP9). The first-prompt BODY never appears at any layer.
 */
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

// ---------------------------------------------------------------------------
// states & enums (arch §8.1, verbatim)
// ---------------------------------------------------------------------------

export type SpawnState = "starting" | "live" | "stopping" | "exited" | "failed";

export type SpawnEndReason =
  | "user"
  | "lifetime"
  | "hub"
  | "crash"
  | "orphan"
  | "protocol_error"
  | "spawn_error"
  | "register_timeout"
  | "exited_early"
  | "cwd_mismatch";

/** User-facing failure hints (arch §8.1); `hintDetail` is owner-only free text. */
export type SpawnHint =
  | "register-timeout-hello"
  | "register-timeout-session"
  | "control-off"
  | "newer-plugin"
  | "cwd-mismatch"
  | "protocol-error"
  | "launcher-changed";

export type FirstPromptState = "pending" | "sending" | "delivered" | "failed" | "expired";

// ---------------------------------------------------------------------------
// record projections (arch §6.4 visibility matrix)
// ---------------------------------------------------------------------------

export interface SpawnRecordPublic {
  spawnId: string;
  state: SpawnState;
  createdAt: number;
  updatedAt: number;
  cwdLabel: string;
  pid?: number;
  agentKey?: string;
  linked?: boolean;
  control?: boolean;
  origin: { listener: "loopback" | "lan"; reqId: string };
  endReason?: SpawnEndReason;
  exit?: { code: number | null; signal: string | null; unconfirmed?: true };
  hint?: SpawnHint;
  uiCancelledCount?: number;
  firstPrompt?: { state: FirstPromptState; code?: string };
}

export interface SpawnRecordOwner extends SpawnRecordPublic {
  cwd: string;
  origin: { listener: "loopback" | "lan"; reqId: string; user?: string };
  hintDetail?: string;
  stderrTail?: string;
  uiCancelled?: Array<{ method: string; title?: string; at: number }>;
  firstPrompt?: { state: FirstPromptState; code?: string; textLen: number; attempts: number };
}

export interface SpawnsPayload {
  items: SpawnRecordPublic[];
  active: number;
  max: number;
}

export interface SpawnPolicyWire {
  allowed: boolean;
  reason?: "platform" | "launcher" | "persist" | "reaper" | "cooldown" | "breaker";
  detail?: string;
  retryAfterS?: number;
  confirm: "always" | "unknown-dir";
  scope: "known" | "roots";
  max: number;
  maxPerPrincipal: number;
  active: number;
  activeMine: number;
  registerTimeoutS: number;
  maxLifetimeMinutes: number;
}

// ---------------------------------------------------------------------------
// request / response bodies
// ---------------------------------------------------------------------------

export interface SpawnRequestBody {
  id: string; // /^[A-Za-z0-9_-]{16,64}$/, idempotent per principal
  cwd: string; // ≤4096 bytes
  confirm?: true;
  expectCwd?: string;
  firstPrompt?: { text: string; deliver?: "steer" | "followUp" }; // text ≤48 KiB, UTF-8
}

export interface SpawnAccepted {
  spawnId: string;
  state: "starting";
  cwd: string;
  dup?: true;
  firstPrompt?: "accepted";
}

/**
 * One entry of `GET /api/headless/dirs`'s `recent` list (arch §4.5): `cwd` is the realpath the
 * UI fills the input with, `label` follows the same `basename(realpath)` rule as
 * `SpawnRecordPublic.cwdLabel`, `at` is the source's last-activity time (epoch ms) — entries
 * arrive ordered by `at` descending, capped at 50.
 */
export interface DirEntryWire {
  cwd: string;
  label: string;
  at: number;
}

/**
 * The spawn policy hub-side config (arch §6.2) — `webHub.spawn` minus `enabled`: the settings
 * layer (SP2) only sets `HubConfig.spawn` when `webHub.spawn.enabled === true`, so "the key is
 * absent" is the wire-level meaning of "feature off" (response matrix, arch §8.2).
 */
export interface HubSpawnConfig {
  roots: string[];
  maxProcesses: number;
  maxPerPrincipal: number;
  ratePerMinute: number;
  maxLifetimeMinutes: number;
  registerTimeoutS: number;
  lan: "off" | "known" | "roots";
}

// ---------------------------------------------------------------------------
// limits & validation (arch §8.2 gate order: schema runs after the ≤SPAWN_BODY_MAX body read)
// ---------------------------------------------------------------------------

/** Same shape/source as `hub/http.ts`'s `CMD_ID_RE` — pinned equal by tests/web-hub/protocol/spawn.test.ts. */
export const SPAWN_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * First-prompt text cap, UTF-8 bytes (arch §4.6). Equal to `hub/http.ts`'s
 * `PROMPT_TEXT_MAX_BYTES` (the `/api/cmd` prompt cap) — pinned by test; that file is outside
 * SP1's file domain so the pin reads its source instead of importing it.
 */
export const PROMPT_TEXT_MAX_BYTES = 48 * 1024;

/** `SpawnRequestBody.cwd` / `expectCwd` cap, UTF-8 bytes (Linux PATH_MAX). */
export const SPAWN_CWD_MAX_BYTES = 4096;

/** POST /api/headless body cap (arch §8.2): 48 KiB first prompt + JSON overhead + slack. */
export const SPAWN_BODY_MAX = 52 * 1024;

const textEncoder = new TextEncoder();

function byteLength(s: string): number {
  return textEncoder.encode(s).length;
}

/**
 * Strict POST body schema (`additionalProperties: false`). The typebox `maxLength` guards are
 * UTF-16-unit PREFILTERS only (UTF-16 length ≤ UTF-8 byte length, so they never over-reject);
 * the exact UTF-8 byte caps are enforced by {@link parseSpawnRequestBody} — always parse with
 * that, never with a bare `Value.Check`.
 */
export const SpawnRequestSchema = Type.Object(
  {
    id: Type.String({ pattern: SPAWN_ID_RE.source }),
    cwd: Type.String({ maxLength: SPAWN_CWD_MAX_BYTES }),
    confirm: Type.Optional(Type.Literal(true)),
    expectCwd: Type.Optional(Type.String({ maxLength: SPAWN_CWD_MAX_BYTES })),
    firstPrompt: Type.Optional(
      Type.Object(
        {
          text: Type.String({ maxLength: PROMPT_TEXT_MAX_BYTES }),
          deliver: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")])),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type SpawnBodyError = "not-an-object" | "schema" | "cwd-too-long" | "first-prompt-too-long";

/** Validate + parse an arbitrary JSON value into a `SpawnRequestBody`. Never throws. */
export function parseSpawnRequestBody(
  raw: unknown,
): { ok: true; body: SpawnRequestBody } | { ok: false; error: SpawnBodyError } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "not-an-object" };
  if (!Value.Check(SpawnRequestSchema, raw)) return { ok: false, error: "schema" };
  const body: SpawnRequestBody = Value.Decode(SpawnRequestSchema, raw);
  if (byteLength(body.cwd) > SPAWN_CWD_MAX_BYTES) return { ok: false, error: "cwd-too-long" };
  // SP9 (SP1 acceptance leftover P3①): `expectCwd` gets the same exact UTF-8 byte re-check as
  // `cwd` — the typebox `maxLength` above is only a UTF-16-unit prefilter, so e.g. 2048 astral
  // chars (4096 units, 8192 bytes) would slip through it otherwise.
  if (body.expectCwd !== undefined && byteLength(body.expectCwd) > SPAWN_CWD_MAX_BYTES) {
    return { ok: false, error: "cwd-too-long" };
  }
  if (body.firstPrompt !== undefined && byteLength(body.firstPrompt.text) > PROMPT_TEXT_MAX_BYTES) {
    return { ok: false, error: "first-prompt-too-long" };
  }
  return { ok: true, body };
}

// ---------------------------------------------------------------------------
// lifecycle / supervision constants (arch §7; consumers land in SP4–SP8)
// ---------------------------------------------------------------------------

/**
 * The fixed `select` title ask_user uses to mark its rpc-mode probe (arch §4.4). Equal to
 * `src/ask-user/channel-handler.ts`'s `ASK_USER_MARKER` — pinned by test; importing it here
 * would drag an ask-user module into the browser bundle, hence the copy.
 */
export const RPC_ASK_USER_TITLE = "\0XYZ_ASK_USER";

/** §3.1 ⑤: wait this long for node's `spawn`/`error` event before SIGKILL. */
export const SPAWN_EVENT_MS = 5_000;

/** §3.1 ⑩ stop escalation: stdin.end() → +STOP_TERM_MS SIGTERM(-pgid) → +STOP_KILL_MS SIGKILL(-pgid) → +EXIT_GUARD_MS fallback terminal. */
export const STOP_TERM_MS = 5_000;
export const STOP_KILL_MS = 3_000;
export const EXIT_GUARD_MS = 5_000;

/** L3: reaper escalates EOF → TERM → KILL within this bound after any hub death (arch §7.3). */
export const REAPER_GRACE_MS = 5_000;
/** L3 bound: an orphan is gone ≤12s after the hub disappears, even if the hub never restarts. */
export const ORPHAN_BOUND_MS = 12_000;

/** Marker-hold fallbacks (arch §4.4): no dialog slot / unlinked / slot cleared for this long ⇒ cancelled. */
export const MARKER_HOLD_GRACE_MS = 5_000;

/** §4.4/#9: bytes of a stdout line's head inspected for the `extension_ui_request` prefix. */
export const UI_REQ_HEAD_BYTES = 512;

/** §4.4: single stdout line cap before dropping the rest of the line (memory bound). */
export const STDOUT_LINE_MAX = 64 * 1024;

/** §7.8 stderr sink: in-memory ring, pending write queue, per-file cap, per-dir file cap, tail size. */
export const STDERR_RING_BYTES = 64 * 1024;
export const STDERR_QUEUE_BYTES = 64 * 1024;
export const STDERR_FILE_MAX = 256 * 1024;
export const STDERR_FILES_MAX = 20;
export const STDERR_TAIL_BYTES = 4_096;

/** §3.1 ⑧ / arch §4.6: first-prompt absolute deadline = registerTimeoutS + this grace; per-send backoff [1s, 3s, 9s], ≤4 attempts. */
export const FIRST_PROMPT_GRACE_MS = 120_000;
export const FIRST_PROMPT_BACKOFF_MS: readonly [number, number, number] = [1_000, 3_000, 9_000];

/** §3.1 circuit breaker: launch-failure cooldown ladder, 10-minute window, 10-minute open period. */
export const SPAWN_BACKOFF_MS: readonly [number, number, number] = [0, 5_000, 30_000];
export const SPAWN_FAIL_WINDOW_MS = 600_000;
export const SPAWN_BREAKER_OPEN_MS = 600_000;

/** §7.7 record retention: keep ≤20 terminal, ≤16 non-terminal (and ≤2 concurrently `starting`) records. */
export const SPAWN_TERMINAL_KEEP = 20;
export const SPAWN_NONTERMINAL_MAX = 16;
export const SPAWN_STARTING_MAX = 2;

/**
 * Launcher version chain (arch §4.2/#12): a spawned `pi --mode rpc` must run a pi version inside
 * this range or the run is failed with `hint:"newer-plugin"`. Mirrors the package-root
 * `peerDependencies["@earendil-works/pi-coding-agent"]` range — pinned by test.
 */
export interface PiVersionRange {
  min: string;
  maxExclusive: string;
}
export const SUPPORTED_PI_RANGE: PiVersionRange = { min: "1.0.0", maxExclusive: "1.1.0" };

// ---------------------------------------------------------------------------
// compile-time drift guards (schema static type ≡ frozen interface; no runtime effect)
// ---------------------------------------------------------------------------

/** Fails to compile if the typebox schema and `SpawnRequestBody` ever drift apart. */
type _SpawnRequestStaticMatches =
  Static<typeof SpawnRequestSchema> extends SpawnRequestBody
    ? SpawnRequestBody extends Static<typeof SpawnRequestSchema>
      ? true
      : never
    : never;
const _spawnRequestStaticMatches: _SpawnRequestStaticMatches = true;
void _spawnRequestStaticMatches;
