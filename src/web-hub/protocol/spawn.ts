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
 *
 * default-model plan §2 (H1) freezes its additions here too: the `model` tri-state on the POST
 * body, `parseSpawnModelRef` + `SPAWN_MODEL_MAX_BYTES`, the `model`/`"model-rejected"` record
 * vocabulary, and the whole `POST /api/headless/prefs` body surface — H2 (hub) and F1 (browser)
 * develop against this file in parallel, so names/types must match the plan exactly.
 */
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { isValidModelId, isValidProvider } from "./models.js";

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
  | "launcher-changed"
  /** default-model plan D5: pi rejected `--model` at startup (`Model "…" not found.` /
   * `… is ambiguous across providers`). A post-terminal annotation on the terminal
   * `failed{exited_early}` record — settled by the hub's delayed breaker verdict, never a
   * state transition, so it can arrive (or be persisted) shortly AFTER the terminal state. */
  | "model-rejected";

export type FirstPromptState = "pending" | "sending" | "delivered" | "failed" | "expired";

// ---------------------------------------------------------------------------
// spawn restore (web-hub-spawn-restore plan v1 §5.1/§10.1 — append-only; NO persisted enum
// (`SpawnState`/`SpawnEndReason`/`SpawnHint`) grows, D11: a rolled-back hub must never read a
// newer spawns.json as corrupt)
// ---------------------------------------------------------------------------

/** Where a restoring record is: reaping the old identity → fork intent written → registering. */
export type RestorePhase = "reaping" | "forking" | "registering";

/** Why a restore did not happen / did not finish (rides next to an EXISTING endReason, D11). */
export type RestoreFailure =
  | "session-missing"
  | "session-invalid"
  | "prev-alive"
  | "prev-unknown"
  | "scan-miss"
  | "exhausted"
  | "lifetime"
  | "launcher"
  | "reaper"
  | "persist"
  | "cwd-changed"
  | "register-timeout"
  | "exited-early";

/** Runtime list of {@link RestoreFailure} (store shape check + UI i18n key map). */
export const RESTORE_FAILURES: readonly RestoreFailure[] = [
  "session-missing",
  "session-invalid",
  "prev-alive",
  "prev-unknown",
  "scan-miss",
  "exhausted",
  "lifetime",
  "launcher",
  "reaper",
  "persist",
  "cwd-changed",
  "register-timeout",
  "exited-early",
];

/** Runtime list of {@link RestorePhase}. */
export const RESTORE_PHASES: readonly RestorePhase[] = ["reaping", "forking", "registering"];

/** `SpawnRecordPublic.restore` (plan §9.2): visible to every principal — no path, no body. */
export interface SpawnRestoreWire {
  phase?: RestorePhase;
  attempt: number;
  failure?: RestoreFailure;
  prevAgentKey?: string;
  restoredAt?: number;
}

/** D15: consecutive restore forks allowed before `exhausted`. */
export const RESTORE_MAX_ATTEMPTS = 3;
/** D15: a restored record live this long clears its `restore` field (attempt counter reset). */
export const RESTORE_STABLE_MS = 120_000;
/** D14: a candidate needs at least this much of its createdAt-anchored lifetime left. */
export const RESTORE_MIN_LIFETIME_MS = 300_000;
/** §6.5 reaping: verified SIGTERM → poll for confirmed death at most this long. */
export const RESTORE_TERM_WAIT_MS = 3_000;
/** §6.5 reaping: verified SIGKILL → poll for confirmed death at most this long. */
export const RESTORE_KILL_WAIT_MS = 2_000;
/** §6.5 reaping: death poll interval. */
export const RESTORE_POLL_MS = 100;
/** D17: restore jobs run at most this many at once (FIFO by createdAt). */
export const RESTORE_CONCURRENCY = 2;
/** §6.5 ④: a restore's register deadline is `forkAt + min(2×registerTimeoutS, this)`. */
export const RESTORE_REGISTER_MAX_MS = 240_000;
/** §5.1: a longer `sessionFile` is not persisted (restore degrades to `--session-id`). */
export const RESTORE_SESSION_FILE_MAX_BYTES = 1024;
/** §5.1: the only `sessionId` shape ever persisted / passed to `--session-id`. */
export const RESTORE_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** §5.1's `sessionFile` rule: absolute, UTF-8 ≤1024 B, no NUL/newline, ends in `.jsonl`. */
export function isValidRestoreSessionFile(p: string): boolean {
  if (!p.startsWith("/") || !p.endsWith(".jsonl")) return false;
  if (p.includes("\0") || p.includes("\n") || p.includes("\r")) return false;
  return new TextEncoder().encode(p).length <= RESTORE_SESSION_FILE_MAX_BYTES;
}

// ---------------------------------------------------------------------------
// record projections (arch §6.4 visibility matrix)
// ---------------------------------------------------------------------------

export interface SpawnRecordPublic {
  spawnId: string;
  state: SpawnState;
  createdAt: number;
  updatedAt: number;
  cwdLabel: string;
  /** default-model plan D3: the effective `provider/id` the child was forked with
   * (`--model`), absent ⇒ pi's own default. Non-sensitive by design — public so SpawnRow can
   * badge it and a faithful retry can replay it (`rec.model ?? ""`). */
  model?: string;
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
  /** web-hub-delete-session plan v2 §2.2: set while a delete is in flight (removeIntent, not
   * yet deleted — either still non-terminal and going through the stop grace, or terminal and
   * awaiting death confirmation). Absent once the record is gone (the browser never sees
   * `removing:false`; it just stops receiving the record). */
  removing?: true;
  /** web-hub-spawn-restore plan §9.2: present while a restore is in flight, failed, or inside
   * its 2-minute stability window. Never carries `sessionId`/`sessionFile`. */
  restore?: SpawnRestoreWire;
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
  /** default-model plan D2 tri-state: absent ⇒ hub preference (`spawn-prefs.json`);
   * `""` ⇒ explicit pi default (fork WITHOUT `--model`); `provider/id` ⇒ parseSpawnModelRef-
   * valid, used as-is. Old-cached UIs / retries / clients that omit unknown fields just get
   * the preference — that is the point of the tri-state. */
  model?: string;
  firstPrompt?: { text: string; deliver?: "steer" | "followUp" }; // text ≤48 KiB, UTF-8
}

export interface SpawnAccepted {
  spawnId: string;
  state: "starting";
  cwd: string;
  /** default-model plan D2/v2-R2-2: the EFFECTIVE value — body `model` when given, else the
   * hub preference resolved at admit time; absent ⇒ pi default (no `--model`). A `dup:true`
   * replay returns the ORIGINAL record's value — a later preference change never rewrites an
   * already-admitted record. */
  model?: string;
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
  /** web-hub-spawn-restore plan D18: restore managed sessions across hub restarts. Absent ⇒
   * false hub-side (an older pi launching a newer hub never restores on its own). */
  restore?: boolean;
}

// ---------------------------------------------------------------------------
// limits & validation (arch §8.2 gate order: schema runs after the ≤SPAWN_BODY_MAX body read)
// ---------------------------------------------------------------------------

/** Same shape/source as `hub/http.ts`'s `CMD_ID_RE` — pinned equal by tests/web-hub/protocol/spawn.test.ts. */
export const SPAWN_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * web-hub-delete-session plan v2 §2.5: `POST /api/headless`'s idempotency-LRU-hit-but-record-gone
 * branch rejects with `E_BAD_REQUEST{reason: SPAWN_GONE_REASON}` instead of falling through to a
 * fresh fork. Shared by `hub/spawn/routes.ts` and the UI's `classifySpawnError`.
 */
export const SPAWN_GONE_REASON = "spawn-gone";

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

// ---------------------------------------------------------------------------
// model ref (default-model plan §2 — 「新建会话默认模型」)
// ---------------------------------------------------------------------------

/**
 * Byte cap for a `provider/id` model ref, UTF-8. Exactly
 * `MODEL_REF_MAX_BYTES + 1 ("/") + MODEL_REF_MAX_BYTES` = 257: `isValidProvider` and
 * `isValidModelId` each cap their half at 128 bytes, so a parsed ref can never exceed it —
 * the constant is the frozen wire budget and the request schema's `maxLength` prefilter.
 */
export const SPAWN_MODEL_MAX_BYTES = 257;

/**
 * Provider half of {@link parseSpawnModelRef}: starts alnum, then alnum/`.`/`_`/`-`. The
 * alnum start rejects a leading `-` (and any other flag-looking prefix) so the value can
 * never masquerade as an argv flag when the hub appends it to `pi --mode rpc --model <ref>`
 * (default-model plan §3.1 「argv 安全」 — no shell, value validated, still defense-in-depth).
 */
const SPAWN_PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A validated `provider/id` ref. The `id` may itself contain `/`, `:`, `.`, `@` — the split
 * is at the FIRST `/`, and `:<thinking>`-style suffixes are pi's to interpret, not the hub's.
 * Reassembling `provider + "/" + id` reproduces the input byte-for-byte: the split carries
 * no normalization, the parsed value IS the wire value.
 */
export interface SpawnModelRef {
  provider: string;
  id: string;
}

/**
 * Validate a `provider/id` model ref (default-model plan §2): split at the first `/`, then
 * `isValidProvider && isValidModelId`, the provider additionally pinned to
 * `^[A-Za-z0-9][A-Za-z0-9._-]*$`, whole ref ≤ {@link SPAWN_MODEL_MAX_BYTES} UTF-8 bytes.
 * `null` for: no `/`, empty provider, empty id, a leading `-` provider, any whitespace or
 * control/format char (zero-width U+200B included), and over-budget refs. `""` is NOT valid
 * here — callers treat it as the explicit 「pi 默认」 tri-state BEFORE calling this.
 * Never throws.
 */
export function parseSpawnModelRef(s: string): SpawnModelRef | null {
  const slash = s.indexOf("/");
  if (slash <= 0) return null; // -1: no `/` at all; 0: empty provider
  const provider = s.slice(0, slash);
  const id = s.slice(slash + 1);
  if (!isValidProvider(provider) || !isValidModelId(id)) return null;
  if (!SPAWN_PROVIDER_RE.test(provider)) return null;
  if (byteLength(s) > SPAWN_MODEL_MAX_BYTES) return null;
  return { provider, id };
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
    model: Type.Optional(Type.String({ maxLength: SPAWN_MODEL_MAX_BYTES })),
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

export type SpawnBodyError = "not-an-object" | "schema" | "cwd-too-long" | "model-invalid" | "first-prompt-too-long";

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
  // default-model plan §2: `model` is a tri-state — only a non-`""` value must parse as a
  // `provider/id` ref (`""` = explicit pi default, absent = hub preference).
  if (body.model !== undefined && body.model !== "" && parseSpawnModelRef(body.model) === null) {
    return { ok: false, error: "model-invalid" };
  }
  if (body.firstPrompt !== undefined && byteLength(body.firstPrompt.text) > PROMPT_TEXT_MAX_BYTES) {
    return { ok: false, error: "first-prompt-too-long" };
  }
  return { ok: true, body };
}

// ---------------------------------------------------------------------------
// spawn prefs (default-model plan §2/§3.1 — the hub-wide 「新建会话默认模型」 preference)
// ---------------------------------------------------------------------------

/**
 * The prefs projection: `GET /api/headless`'s `prefs` field and `POST /api/headless/prefs`'s
 * `{prefs}` reply body. D1: ONE global value under `<stateDir>/spawn-prefs.json` — every
 * authenticated principal that can reach `/api/headless*` is equally trusted with it
 * (user ruling U1), so there is deliberately no per-principal field here. `lan:"off"` keeps
 * the whole surface 404 for LAN principals (route guard, H2).
 */
export interface SpawnPrefsWire {
  /** The default `provider/id` forked with when a POST body omits `model`; `null` ⇒ no
   * preference (fork WITHOUT `--model`). */
  defaultModel: string | null;
}

/** POST /api/headless/prefs body cap, UTF-8 bytes (plan §3 ④: `readJson(≤1 KiB)`). */
export const SPAWN_PREFS_BODY_MAX = 1024;

/** POST /api/headless/prefs body shape: strict; `""` is the explicit 「清空」 request. */
export interface SpawnPrefsRequestBody {
  defaultModel: string;
}

/**
 * Strict POST body schema (`additionalProperties: false`). Deliberately NO `maxLength`
 * prefilter: an over-long value fails `parseSpawnModelRef` inside
 * {@link parseSpawnPrefsRequest} and surfaces as the same `"model-invalid"` 400 as any other
 * bad ref (plan §3 ⑤), instead of a separate schema error.
 */
export const SpawnPrefsRequestSchema = Type.Object({ defaultModel: Type.String() }, { additionalProperties: false });

export type SpawnPrefsError = "not-an-object" | "schema" | "model-invalid";

/**
 * Validate + parse an arbitrary JSON value into a `SpawnPrefsRequestBody`. `""` parses OK
 * (clear); any non-empty `defaultModel` must pass {@link parseSpawnModelRef}. Never throws.
 */
export function parseSpawnPrefsRequest(
  raw: unknown,
): { ok: true; body: SpawnPrefsRequestBody } | { ok: false; error: SpawnPrefsError } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "not-an-object" };
  if (!Value.Check(SpawnPrefsRequestSchema, raw)) return { ok: false, error: "schema" };
  const body: SpawnPrefsRequestBody = Value.Decode(SpawnPrefsRequestSchema, raw);
  if (body.defaultModel !== "" && parseSpawnModelRef(body.defaultModel) === null) {
    return { ok: false, error: "model-invalid" };
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

/** Fails to compile if the prefs schema and `SpawnPrefsRequestBody` ever drift apart. */
type _SpawnPrefsStaticMatches =
  Static<typeof SpawnPrefsRequestSchema> extends SpawnPrefsRequestBody
    ? SpawnPrefsRequestBody extends Static<typeof SpawnPrefsRequestSchema>
      ? true
      : never
    : never;
const _spawnPrefsStaticMatches: _SpawnPrefsStaticMatches = true;
void _spawnPrefsStaticMatches;
