/**
 * Feishu PersonalAgent device-flow registration (bot plan §9 / §R2-e / R1 #7, package F4).
 * Pi-free; `fetch` + clock are injected seams (tests only — production resolves `globalThis.fetch`
 * per call and uses the unref'd system clock).
 *
 * Request shapes and polling semantics are the F-probe P1 flow, verified live on a real tenant
 * (`scripts/dev/feishu-probe/steps.ts` P1; `probe-results.md`):
 * - `POST {accounts base}/oauth/v1/app/registration`, `application/x-www-form-urlencoded`;
 *   `begin`: `action=begin&archetype=PersonalAgent&auth_method=client_secret&request_user_info=open_id`;
 *   `poll`: `action=poll&device_code=…`. Registration origins are ONLY
 *   `https://accounts.feishu.cn|accounts.larksuite.com` ({@link isAllowedRegistrationBase}).
 * - The endpoint answers the NORMAL pending states with HTTP **400** (`authorization_pending`,
 *   `slow_down`): the JSON body drives the state machine, the status alone is never fatal.
 *   `slow_down` ⇒ interval +5 s (cap 600). An EMPTY `{}` (neither error nor credentials) means
 *   "keep polling". `{user_info:{tenant_brand:"lark"|"feishu"}}` without credentials ⇒ brand switch
 *   (same device code, other accounts origin, re-poll immediately). Partial credentials
 *   (client_id without secret or vice versa) are REJECTED, as is credentials + error.
 * - `interval` clamp 1..60 (default 5), `expires_in` clamp 1..600 (default 600), hard stop at expiry,
 *   every request ≤8 s (and never past the expiry), bodies ≤64 KiB, `redirect:"error"`.
 *   Transient transport failures (network / timeout / 5xx / 429) retry up to 4 times in a row.
 *
 * Setup ownership (§R2-e): there is exactly ONE setup generation (`setupGen`) and at most one
 * active run. A run captures its gen; EVERY result it produces (poll answer, commit) is discarded
 * once the gen moved on (`cancel`/`fence`/a newer `begin`). The gen is re-checked immediately
 * before credentials are committed AND handed to the credential store as its pre-rename guard.
 * `fence()` is what `reset` calls first: it bumps the gen, aborts the in-flight request and waits
 * for a commit already past the point of no return (the credential store serializes the following
 * `remove()` after it, so reset can never leave a freshly committed credential behind).
 *
 * NEVER surfaced anywhere (returns, views, logs, errors): `device_code`, `client_secret`, any
 * token. The public view is exactly `{phase, qrUrl?, expiresAt?}` ({@link FsbSetupView}); the QR
 * URL is the decorated display link and is dropped from the view the moment the run leaves
 * `pending`. Logs carry static event names + numbers only.
 */
import { hostname as osHostname } from "node:os";

import {
  FEISHU_BRANDS,
  FEISHU_OPEN_ID_RE,
  FEISHU_REGISTRATION_BASES,
  FEISHU_SETUP,
  FEISHU_WS_HOST_SUFFIXES,
  isAllowedRegistrationBase,
  isFeishuBrand,
} from "../../protocol/feishu.js";
import type { FeishuBrand, FeishuSetupPhase, FsbSetupView } from "../../protocol/feishu.js";
import { FEISHU_APP_ID_RE, FEISHU_APP_SECRET_RE } from "./credentials.js";
import type { CredentialInput } from "./credentials.js";
import { systemFeishuClock } from "./http.js";
import type { FeishuClock, FeishuFetch } from "./http.js";

export const REGISTRATION_PATH = "/oauth/v1/app/registration";
/** response body cap (§2.1-style ≤64 KiB) */
export const REGISTRATION_MAX_BODY_BYTES = 64 * 1024;
/** consecutive transient poll failures tolerated (probe: 4) */
export const REGISTRATION_MAX_TRANSIENT = 4;
export const REGISTRATION_INTERVAL_MIN_S = 1;
export const REGISTRATION_INTERVAL_MAX_S = 60;
export const REGISTRATION_INTERVAL_DEFAULT_S = 5;
/** `slow_down` may grow the interval up to this */
export const REGISTRATION_SLOW_DOWN_CAP_S = 600;
const QR_DECORATION = { from: "sdk", tp: "sdk", source: "pi-toolkit" } as const;

// ---------------------------------------------------------------------------
// pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export type PollOutcome =
  | { kind: "credentials"; brand: FeishuBrand; appId: string; appSecret: string; ownerOpenId: string }
  | { kind: "brand-switch"; brand: FeishuBrand }
  | { kind: "pending" }
  | { kind: "slow_down" }
  | { kind: "expired" }
  | { kind: "denied" }
  | { kind: "failed"; reason: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * Classify one poll answer (`status` = HTTP status, `body` = decoded JSON). Pure; the order of the
 * rules is the probe's: brand switch → pending → rejection → success validation.
 */
export function classifyPollResponse(status: number, body: unknown, brand: FeishuBrand): PollOutcome {
  if (!isRecord(body)) return { kind: "failed", reason: "poll-body" };
  const id = body["client_id"];
  const secret = body["client_secret"];
  const success = nonEmptyString(id) && nonEmptyString(secret);
  const error = body["error"];
  const noError = error === undefined || error === null || error === "";
  const info = body["user_info"];
  const tenantBrand = isRecord(info) ? info["tenant_brand"] : undefined;
  if (!success && isFeishuBrand(tenantBrand) && tenantBrand !== brand) {
    return { kind: "brand-switch", brand: tenantBrand };
  }
  const pendingError = error === "authorization_pending" || error === "slow_down";
  // An empty/neutral body (no error, no credential field at all) = keep polling (multica / probe).
  const pending = pendingError || (noError && id === undefined && secret === undefined);
  if (!pending && !success) {
    if (error === "expired_token") return { kind: "expired" };
    if (error === "access_denied") return { kind: "denied" };
    return { kind: "failed", reason: status >= 400 ? `poll-http-${status}` : "poll-fields" };
  }
  if (success) {
    if (!noError) return { kind: "failed", reason: "contradictory" };
    const openId = isRecord(info) ? info["open_id"] : undefined;
    if (
      !FEISHU_APP_ID_RE.test(id) ||
      !FEISHU_APP_SECRET_RE.test(secret) ||
      typeof openId !== "string" ||
      !FEISHU_OPEN_ID_RE.test(openId)
    ) {
      return { kind: "failed", reason: "credential-fields" };
    }
    // The tenant's stated brand wins when present (a lark tenant must not be stored as feishu).
    return {
      kind: "credentials",
      brand: isFeishuBrand(tenantBrand) ? tenantBrand : brand,
      appId: id,
      appSecret: secret,
      ownerOpenId: openId,
    };
  }
  return error === "slow_down" ? { kind: "slow_down" } : { kind: "pending" };
}

/** `interval` field → seconds in [1,60] (default 5). */
export function clampPollInterval(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw : REGISTRATION_INTERVAL_DEFAULT_S;
  return Math.max(REGISTRATION_INTERVAL_MIN_S, Math.min(REGISTRATION_INTERVAL_MAX_S, n));
}
/** `expires_in` (or the `expire_in` typo variant) → seconds in [1,600] (default 600). */
export function clampExpiresIn(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : FEISHU_SETUP.maxExpiresInS;
  return Math.max(1, Math.min(FEISHU_SETUP.maxExpiresInS, n));
}

function safeHostLabel(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 48);
  return cleaned === "" ? "host" : cleaned;
}

/**
 * Validate + decorate the display link from `begin`. `undefined` ⇒ refuse the whole run: not https,
 * userinfo/fragment/non-443 port, host not a proper `.feishu.cn`/`.larksuite.com` subdomain, a
 * polling credential smuggled in the query (or the device code itself anywhere), or too long.
 */
export function decorateQrUrl(raw: unknown, deviceCode: string, hostname: string): string | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > FEISHU_SETUP.qrUrlMaxLength) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") return undefined;
  if (url.port !== "" && url.port !== "443") return undefined;
  const host = url.hostname.toLowerCase();
  if (host.endsWith(".")) return undefined;
  if (!FEISHU_WS_HOST_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length)) return undefined;
  for (const key of url.searchParams.keys()) if (/device.?code|secret|token/i.test(key)) return undefined;
  if (deviceCode.length > 0 && url.toString().includes(deviceCode)) return undefined;
  for (const [k, v] of Object.entries(QR_DECORATION)) url.searchParams.set(k, v);
  url.searchParams.set("name", `pi@${safeHostLabel(hostname)}`);
  const out = url.toString();
  return out.length <= FEISHU_SETUP.qrUrlMaxLength ? out : undefined;
}

// ---------------------------------------------------------------------------
// public API types
// ---------------------------------------------------------------------------

export type CredentialsPresence = "none" | "present" | "unsafe";

export type RegistrationLogEvent = {
  /** static name: `begin` | `poll` | `retry` | `brand-switch` | `slow-down` | `commit` | `phase` */
  event: string;
  phase?: FeishuSetupPhase;
  reason?: string;
  ms?: number;
};

export interface RegistrationDeps {
  fetch?: FeishuFetch;
  clock?: FeishuClock;
  /** machine name for the `name=pi@<host>` decoration (default `os.hostname()`) */
  hostname?: () => string;
  /** live credential presence — decides `exists` / `credentials-unsafe` refusals at begin */
  credentialsState: () => CredentialsPresence;
  /**
   * Install the registration result (the service wires `credentials.commit` + `botInfo` + owner
   * allow-list + connector start). `guard` MUST be honoured as the last synchronous check before
   * the commit point (`CredentialStore.commit({guard})` does).
   */
  commit: (input: CredentialInput, guard: () => boolean) => Promise<{ ok: true } | { ok: false; reason: string }>;
  log?: (event: RegistrationLogEvent) => void;
  /** per-request deadline (default {@link FEISHU_SETUP.requestTimeoutMs}) */
  requestTimeoutMs?: number;
}

export type BeginRefusal =
  /** `replace` without `confirm` ⇒ wire `E_FSB_CONFIRM_REQUIRED` */
  | "confirm-required"
  /** credentials exist and `replace` was not requested ⇒ `E_FSB_CONFIRM_REQUIRED` (user must pass --replace) */
  | "exists"
  /** credential file unsafe (reset first) ⇒ `E_FSB_STATE` */
  | "credentials-unsafe"
  /** a run is active and `replace` cannot be adopted into it ⇒ `E_FSB_SETUP_ACTIVE` */
  | "active-conflict"
  /** `begin` POST failed / was malformed (`failure` has the static reason) ⇒ retryable by the user */
  | "begin-failed"
  /** fenced/cancelled while the begin POST was in flight */
  | "cancelled"
  | "disposed";

export type BeginResult =
  { ok: true; view: FsbSetupView; adopted: boolean } | { ok: false; refused: BeginRefusal; failure?: string };

/** Map a begin refusal to the closed `fsb_res` code vocabulary (F8/FA convenience). */
export function refusalToFsbCode(
  refused: BeginRefusal,
): "E_FSB_CONFIRM_REQUIRED" | "E_FSB_STATE" | "E_FSB_SETUP_ACTIVE" | "E_FSB_BAD_REQUEST" {
  switch (refused) {
    case "confirm-required":
    case "exists":
      return "E_FSB_CONFIRM_REQUIRED";
    case "active-conflict":
      return "E_FSB_SETUP_ACTIVE";
    case "credentials-unsafe":
    case "begin-failed":
    case "cancelled":
    case "disposed":
      return "E_FSB_STATE";
  }
}

export interface RegistrationDiagnostic {
  phase: FeishuSetupPhase;
  /** static local reason for `failed` (e.g. `poll-http-500`) */
  reason?: string;
  brand?: FeishuBrand;
  setupGen: number;
}

export interface Registration {
  /** current setup generation (bumped by every begin / cancel / fence) */
  readonly setupGen: number;
  /** a run is `pending`/committing (a begin POST in flight counts) */
  readonly active: boolean;
  begin(opts?: { replace?: boolean; confirm?: boolean }): Promise<BeginResult>;
  /** Public view of the current/last run; `undefined` when none since boot / since the last fence-clear. */
  status(): FsbSetupView | undefined;
  diagnostic(): RegistrationDiagnostic | undefined;
  /** Fence the run (late results discarded, nothing written), then wait for a commit already in flight. */
  cancel(): Promise<FsbSetupView | undefined>;
  /** `reset`: like cancel but also forgets the last terminal view; resolves when no commit is in flight. */
  fence(): Promise<void>;
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

type PostResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; kind: "network" | "timeout" | "too-large" | "protocol" | "aborted" | "http"; status?: number };

async function readCapped(response: Response, max: number): Promise<Uint8Array | "too-large"> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return "too-large";
  const body = response.body;
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        return "too-large";
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

interface Run {
  gen: number;
  replace: boolean;
  brand: FeishuBrand;
  /** SECRET — closure only, cleared on any terminal phase */
  deviceCode: string;
  interval: number;
  expiresAt: number;
  qrUrl: string | undefined;
  phase: FeishuSetupPhase;
  /** internal: `pending` + commit in flight */
  committing: boolean;
  reason: string | undefined;
  abort: AbortController;
  commitPromise: Promise<void> | undefined;
}

// ---------------------------------------------------------------------------
// state machine
// ---------------------------------------------------------------------------

export function createRegistration(deps: RegistrationDeps): Registration {
  const clock = deps.clock ?? systemFeishuClock;
  const fetchImpl: FeishuFetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const requestTimeoutMs = deps.requestTimeoutMs ?? FEISHU_SETUP.requestTimeoutMs;

  let setupGen = 0;
  let run: Run | undefined;
  /** the begin POST in flight (single-flight adoption) */
  let starting: { replace: boolean; gen: number; abort: AbortController; promise: Promise<BeginResult> } | undefined;
  let disposed = false;

  function log(event: RegistrationLogEvent): void {
    try {
      deps.log?.(event);
    } catch {
      /* observers never affect the flow */
    }
  }

  function hostname(): string {
    try {
      return (deps.hostname ?? osHostname)();
    } catch {
      return "host";
    }
  }

  const isActive = (r: Run): boolean => r.phase === "pending";
  const current = (r: Run): boolean => run === r && r.gen === setupGen && isActive(r);

  function finish(r: Run, phase: FeishuSetupPhase, reason?: string): void {
    if (r.phase !== "pending") return;
    r.phase = phase;
    r.committing = false;
    r.reason = reason;
    r.deviceCode = "";
    r.qrUrl = undefined;
    log({ event: "phase", phase, ...(reason !== undefined ? { reason } : {}) });
  }

  function viewOf(r: Run): FsbSetupView {
    if (r.phase === "pending") {
      const v: FsbSetupView = { phase: "pending" };
      if (r.qrUrl !== undefined) v.qrUrl = r.qrUrl;
      v.expiresAt = r.expiresAt;
      return v;
    }
    return { phase: r.phase };
  }

  async function post(
    brand: FeishuBrand,
    form: Record<string, string>,
    timeoutMs: number,
    outer: AbortSignal,
  ): Promise<PostResult> {
    const base = FEISHU_REGISTRATION_BASES[brand];
    if (!isAllowedRegistrationBase(base)) return { ok: false, kind: "protocol" };
    const controller = new AbortController();
    let timedOut = false;
    const onOuter = (): void => controller.abort();
    if (outer.aborted) return { ok: false, kind: "aborted" };
    outer.addEventListener("abort", onOuter, { once: true });
    const timer = clock.setTimeout(
      () => {
        timedOut = true;
        controller.abort();
      },
      Math.max(1, timeoutMs),
    );
    try {
      const response = await fetchImpl(`${base}${REGISTRATION_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
        redirect: "error",
        signal: controller.signal,
      });
      const bytes = await readCapped(response, REGISTRATION_MAX_BODY_BYTES);
      if (bytes === "too-large") return { ok: false, kind: "too-large", status: response.status };
      if (response.status >= 500 || response.status === 429) {
        return { ok: false, kind: "http", status: response.status };
      }
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return { ok: false, kind: "protocol", status: response.status };
      }
      return { ok: true, status: response.status, body };
    } catch {
      if (outer.aborted) return { ok: false, kind: "aborted" };
      return { ok: false, kind: timedOut ? "timeout" : "network" };
    } finally {
      clock.clearTimeout(timer);
      outer.removeEventListener("abort", onOuter);
    }
  }

  function transient(kind: string): boolean {
    return kind === "network" || kind === "timeout" || kind === "http";
  }

  function failureReason(res: Extract<PostResult, { ok: false }>): string {
    if (res.kind === "http") return `http-${res.status ?? 0}`;
    return res.kind;
  }

  function sleep(ms: number, r: Run): Promise<void> {
    return new Promise<void>((resolve) => {
      if (r.abort.signal.aborted) return resolve();
      const done = (): void => {
        clock.clearTimeout(handle);
        r.abort.signal.removeEventListener("abort", done);
        resolve();
      };
      const handle = clock.setTimeout(done, Math.max(0, ms));
      r.abort.signal.addEventListener("abort", done, { once: true });
    });
  }

  async function pollLoop(r: Run): Promise<void> {
    let delay = r.interval * 1000;
    let transientFailures = 0;
    while (current(r)) {
      if (delay > 0) await sleep(Math.min(delay, Math.max(0, r.expiresAt - clock.now())), r);
      if (!current(r)) return;
      if (clock.now() >= r.expiresAt) return finish(r, "expired", "expired");
      const started = clock.now();
      const res = await post(
        r.brand,
        { action: "poll", device_code: r.deviceCode },
        Math.max(1, Math.min(requestTimeoutMs, r.expiresAt - clock.now())),
        r.abort.signal,
      );
      if (!current(r)) return;
      if (!res.ok) {
        if (res.kind === "aborted") return;
        transientFailures += 1;
        if (!transient(res.kind) || transientFailures > REGISTRATION_MAX_TRANSIENT) {
          return finish(r, "failed", transient(res.kind) ? "transient-limit" : failureReason(res));
        }
        delay = Math.max(r.interval * 1000, Math.min(8_000, 1_000 * 2 ** (transientFailures - 1)));
        log({ event: "retry", reason: failureReason(res), ms: Math.max(0, clock.now() - started) });
        continue;
      }
      transientFailures = 0;
      delay = r.interval * 1000;
      const outcome = classifyPollResponse(res.status, res.body, r.brand);
      log({ event: "poll", reason: outcome.kind, ms: Math.max(0, clock.now() - started) });
      switch (outcome.kind) {
        case "pending":
          continue;
        case "slow_down":
          r.interval = Math.min(REGISTRATION_SLOW_DOWN_CAP_S, r.interval + FEISHU_SETUP.slowDownAddS);
          delay = r.interval * 1000;
          log({ event: "slow-down" });
          continue;
        case "brand-switch":
          r.brand = outcome.brand;
          delay = 0;
          log({ event: "brand-switch" });
          continue;
        case "expired":
          return finish(r, "expired", "expired-token");
        case "denied":
          return finish(r, "denied", "access-denied");
        case "failed":
          return finish(r, "failed", outcome.reason);
        case "credentials": {
          // Last check BEFORE credentials are committed (§R2-e): expired or fenced ⇒ nothing is written.
          if (clock.now() >= r.expiresAt) return finish(r, "expired", "expired-at-commit");
          if (!current(r)) return;
          const input: CredentialInput = {
            brand: outcome.brand,
            appId: outcome.appId,
            appSecret: outcome.appSecret,
            ownerOpenId: outcome.ownerOpenId,
          };
          r.committing = true;
          const guard = (): boolean => current(r) && clock.now() < r.expiresAt;
          const commit = (async (): Promise<void> => {
            let result: { ok: true } | { ok: false; reason: string };
            try {
              result = await deps.commit(input, guard);
            } catch {
              result = { ok: false, reason: "threw" };
            }
            log({ event: "commit", reason: result.ok ? "ok" : result.reason });
            if (result.ok) {
              // Credentials are installed: the run is done even if a cancel raced in (truthful view).
              if (r.phase === "cancelled") {
                r.phase = "pending";
              }
              return finish(r, "done");
            }
            if (r.phase !== "pending") return; // fenced: cancel already decided the phase
            return finish(r, "failed", `commit-${result.reason}`);
          })();
          r.commitPromise = commit;
          await commit;
          return;
        }
      }
    }
  }

  function startRun(r: Run): void {
    run = r;
    void pollLoop(r).catch(() => {
      // pollLoop never throws by construction; a defect must still end the run, never wedge it.
      finish(r, "failed", "internal");
    });
  }

  async function doBegin(opts: { replace: boolean }, controller: AbortController, gen: number): Promise<BeginResult> {
    const brand: FeishuBrand = FEISHU_BRANDS[0];
    const res = await post(
      brand,
      {
        action: "begin",
        archetype: "PersonalAgent",
        auth_method: "client_secret",
        request_user_info: "open_id",
      },
      requestTimeoutMs,
      controller.signal,
    );
    if (gen !== setupGen || disposed) return { ok: false, refused: "cancelled" };
    if (!res.ok) {
      log({ event: "begin", reason: failureReason(res) });
      return { ok: false, refused: "begin-failed", failure: failureReason(res) };
    }
    const body = res.body;
    if (
      res.status !== 200 ||
      !isRecord(body) ||
      !nonEmptyString(body["device_code"]) ||
      !nonEmptyString(body["verification_uri_complete"])
    ) {
      const reason = res.status >= 400 ? `begin-http-${res.status}` : "begin-fields";
      log({ event: "begin", reason });
      return { ok: false, refused: "begin-failed", failure: reason };
    }
    const deviceCode = body["device_code"];
    const qrUrl = decorateQrUrl(body["verification_uri_complete"], deviceCode, hostname());
    if (qrUrl === undefined) {
      log({ event: "begin", reason: "begin-qr-url" });
      return { ok: false, refused: "begin-failed", failure: "begin-qr-url" };
    }
    const r: Run = {
      gen,
      replace: opts.replace,
      brand,
      deviceCode,
      interval: clampPollInterval(body["interval"]),
      expiresAt: clock.now() + clampExpiresIn(body["expires_in"] ?? body["expire_in"]) * 1000,
      qrUrl,
      phase: "pending",
      committing: false,
      reason: undefined,
      abort: controller,
      commitPromise: undefined,
    };
    log({ event: "begin", reason: "ok" });
    startRun(r);
    return { ok: true, view: viewOf(r), adopted: false };
  }

  const registration: Registration = {
    get setupGen() {
      return setupGen;
    },
    get active() {
      return starting !== undefined || (run !== undefined && isActive(run));
    },

    async begin(opts) {
      if (disposed) return { ok: false, refused: "disposed" };
      const replace = opts?.replace === true;
      if (replace && opts?.confirm !== true) return { ok: false, refused: "confirm-required" };
      // Adopt a running (or starting) generation: one bounded setup at a time.
      if (starting !== undefined) {
        if (replace && !starting.replace) return { ok: false, refused: "active-conflict" };
        const first = await starting.promise;
        return first.ok ? { ok: true, view: first.view, adopted: true } : first;
      }
      if (run !== undefined && isActive(run)) {
        if (replace && !run.replace) return { ok: false, refused: "active-conflict" };
        return { ok: true, view: viewOf(run), adopted: true };
      }
      const presence = deps.credentialsState();
      if (presence === "unsafe") return { ok: false, refused: "credentials-unsafe" };
      if (presence === "present" && !replace) return { ok: false, refused: "exists" };
      // A new generation. The previous terminal view (if any) is forgotten.
      run = undefined;
      setupGen += 1;
      const gen = setupGen;
      const controller = new AbortController();
      const promise = doBegin({ replace }, controller, gen);
      const entry = { replace, gen, abort: controller, promise };
      starting = entry;
      try {
        return await promise;
      } finally {
        if (starting === entry) starting = undefined;
      }
    },

    status: () => (run === undefined ? undefined : viewOf(run)),

    diagnostic: () =>
      run === undefined
        ? undefined
        : {
            phase: run.phase,
            ...(run.reason !== undefined ? { reason: run.reason } : {}),
            brand: run.brand,
            setupGen,
          },

    async cancel() {
      setupGen += 1;
      starting?.abort.abort();
      const r = run;
      if (r !== undefined && isActive(r)) {
        r.abort.abort();
        if (r.commitPromise === undefined) finish(r, "cancelled", "cancelled");
        else {
          // A commit is in flight: the guard is already false, so it fails at the commit point
          // unless it already passed it — then the run truthfully ends `done`.
          r.phase = "cancelled";
          r.reason = "cancelled";
          r.deviceCode = "";
          r.qrUrl = undefined;
          r.committing = false;
          await r.commitPromise;
        }
      }
      return run === undefined ? undefined : viewOf(run);
    },

    async fence() {
      await registration.cancel();
      run = undefined;
    },

    async dispose() {
      disposed = true;
      await registration.fence();
    },
  };
  return registration;
}
