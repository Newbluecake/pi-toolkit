/**
 * Default `LanAssembly` (plan §1.4.2; S1-W3 LD 包): wires the real
 * `LanStorePort` (`lan-store.ts`, LS) / `KdfPort` (`kdf.ts`, LS) /
 * `LoginLimiterPort` (`ratelimit.ts`, LC) / `KdfAdmissionPort`
 * (`kdf-admission.ts`, LC) / `HostsPort` (`net-hosts.ts`, LC) implementations
 * into a `LanFrontendDeps`. Only imports port *types* plus each concrete
 * package's factory — never `node:sqlite` directly (that stays inside
 * `lan-store.ts`'s child processes, L19); `createLanStore` itself is what
 * opens/migrates the db (§4.1 "前置条件") before this module ever
 * constructs a `LanFrontendDeps`.
 *
 * §4.1's db-open failures (`sqlite-unavailable` / `db-too-large` /
 * `db-invalid` / `db-timeout`) must degrade to a loopback-only hub with
 * `hub.json.lan = {state:"off", reason, detail}` — never take the whole hub
 * down — matching the `db-*` rows of §9.3's status table (which all describe
 * a *running* hub). Since `LanAssembly.build()`'s frozen return type has no
 * room to express that outcome (`Promise<LanFrentendDeps>`, no error
 * variant), `build()` rejects with `LanAssemblyOffError` for exactly these
 * recognized reasons; `hub.ts` (also LD's file, not a frozen-signature
 * change) special-cases that rejection the same way it already special-cases
 * `deps.lanConfigError` — skip constructing `LanFrontendDeps`/`HttpFrontend.
 * lan`, keep loopback, and fold the reason into `hub.json.lan` directly. Any
 * *other* rejection (a genuine bug, not a recognized off-reason) still fails
 * `startHub` outright, same as before.
 */
import { createKdf } from "./kdf.js";
import { createKdfAdmission } from "./kdf-admission.js";
import { createLoginLimiter } from "./ratelimit.js";
import { createLanStore } from "./lan-store.js";
import { createHostsPort } from "./net-hosts.js";
import type { LanOffReason } from "../protocol/lan.js";
import type { LanAssembly, LanFrontendDeps } from "./ports.js";

/**
 * Thrown by `defaultLanAssembly.build()` for a recognized §4.1 db-open
 * failure — `hub.ts` catches this specific class (never a bare `Error`) and
 * folds it into `hub.json.lan` instead of failing hub startup outright.
 */
export class LanAssemblyOffError extends Error {
  readonly reason: LanOffReason;
  readonly detail: string | undefined;
  constructor(reason: LanOffReason, detail?: string) {
    super(`web-hub: LAN assembly reported off (${reason})${detail === undefined ? "" : `: ${detail}`}`);
    this.name = "LanAssemblyOffError";
    this.reason = reason;
    this.detail = detail;
  }
}

export const defaultLanAssembly: LanAssembly = {
  async build({ cfg, paths, log, now, scope, onStatus }): Promise<LanFrontendDeps> {
    const result = await createLanStore({ dbFile: paths.dbFile, log, now });
    if (!result.ok) {
      throw new LanAssemblyOffError(result.reason, result.detail);
    }
    const { store } = result;
    // §4.1's "查询子进程反复失败" runtime degradation (Q20/§4.2): report the reason here so
    // `hub.json.lan` reflects it even before `HttpFrontend.lan` exists (e.g. a fake facade in a
    // unit test, or a race where `build()` hasn't returned yet) — `hub/http.ts`'s own duck-typed
    // subscription on this same `store.onUnavailable` (LC review-fix P1, §4.1 fail-closed) is what
    // actually closes the LAN listener and keeps `LanFacade.status()` in sync; both listeners are
    // idempotent with each other (`onStatus` is just the latest write, and `db-client.ts` never
    // respawns once `unavailable` is set, so there is nothing left to race against).
    store.onUnavailable(() => {
      onStatus({ state: "off", reason: "db-unavailable" });
    });
    scope.defer(() => store.close());

    const limiter = createLoginLimiter({ now });
    const admission = createKdfAdmission({ now, isTightened: () => limiter.isTightened() });

    return {
      cfg,
      store,
      kdf: createKdf(),
      limiter,
      admission,
      hosts: createHostsPort(),
      scope,
      onStatus,
    };
  },
};
