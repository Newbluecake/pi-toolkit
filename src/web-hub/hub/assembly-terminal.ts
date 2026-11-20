/** Enabled-only v2 composition. One hub PTY/ring/ledger owner; no v1 reader/parser.
 * Construction is synchronous and auth never awaits terminal initialization/reapers. */
import { randomBytes } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import type { HubAssembly } from "./assembly.js";
import { identityEquals, verifyBoundSocket } from "../protocol/paths.js";
import type { TerminalContextPort, TerminalContextSnapshotV2 } from "./terminal-v2-ports.js";
import type { TerminalScopeV2 } from "../protocol/terminal-v2.js";
import { HubTerminalServiceV2 } from "./terminal/v2/service.js";
import { createTerminalAllocationLedgerV2 } from "./terminal/v2/ledger.js";
import { ensureTerminalStoreV2, TerminalFreshUnsupportedV2 } from "./terminal/v2/fresh.js";
import { retireOldKernelAllocationsV2 } from "./terminal/v2/retirement.js";
import { createHubTerminalContextV2 } from "./terminal/v2/context.js";
import { TerminalRevocationFenceV2, matchesTerminalAuthV2 } from "./terminal/v2/revocation-fence.js";
import { createTerminalResizeGateV2 } from "./terminal/v2/resize-gate.js";
import { createTerminalViewsV2, type TerminalRevalidateV2 } from "./terminal/v2/view.js";
import { createTerminalRoutesV2 } from "./terminal/v2/routes.js";
import type { TerminalFrontendV2 } from "./terminal/v2/frontend.js";
import { TerminalV2Fault, clampSpanMs, deadline } from "./terminal/v2/local.js";
import { TerminalFaultV2 } from "./terminal/v2/timing.js";

export function assembleTerminal(ctx: HubAssembly) {
  const config = ctx.config.terminal;
  if (!config) return undefined;
  const owner = ctx.singletonOwner,
    identity = ctx.socketIdentity;
  const hubInstance = randomBytes(24).toString("base64url");
  let disposed = false,
    available = false;
  let reason = "initializing";
  const lifetime = new AbortController();
  // Pin the original state parent before the first await, not a later replacement.
  const stateIdentity = (() => {
    try {
      return lstatSync(ctx.paths.stateDir);
    } catch {
      return undefined;
    }
  })();
  const ownershipCurrent = () =>
    owner !== undefined &&
    ctx.singletonOwner === owner &&
    owner.server.listening &&
    identity !== undefined &&
    ctx.socketIdentity === identity &&
    owner.identity === identity;
  const memoryCurrent = () => !disposed && !ctx.isClosing() && !ctx.startup.signal.aborted && ownershipCurrent();
  // Resource commits/retirement use the SAME singleton and physical directory/socket
  // identity, never a second lock. Auth notification paths never invoke this IO guard.
  const resourceCurrent = () => {
    if (!ownershipCurrent() || !identity) return false;
    try {
      const dir = lstatSync(ctx.paths.socketDir),
        socket = lstatSync(ctx.paths.socketPath),
        state = lstatSync(ctx.paths.stateDir);
      return (
        stateIdentity !== undefined &&
        state.isDirectory() &&
        !state.isSymbolicLink() &&
        state.uid === process.getuid?.() &&
        (state.mode & 0o777) === 0o700 &&
        identityEquals(state, stateIdentity) &&
        realpathSync(ctx.paths.stateDir) === ctx.paths.stateDir &&
        dir.isDirectory() &&
        dir.uid === process.getuid?.() &&
        (dir.mode & 0o777) === 0o700 &&
        socket.isSocket() &&
        socket.uid === process.getuid?.() &&
        !dir.isSymbolicLink() &&
        !socket.isSymbolicLink() &&
        identityEquals(dir, identity.dir) &&
        identityEquals(socket, identity.socket)
      );
    } catch {
      return false;
    }
  };
  const privacyDenied = (scope: TerminalScopeV2) =>
    !ctx.privacyStore || ctx.privacyStore.degraded || ctx.privacyStore.isLocked(scope.sessionId);
  const context = createHubTerminalContextV2({
    now: ctx.now,
    link: (key) => ctx.agentServer?.terminalContextLink?.(key),
    permitted: (scope) => memoryCurrent() && !privacyDenied(scope),
  });
  const translate = (error: unknown): never => {
    if (error instanceof TerminalV2Fault && error.failure.code !== "E_INPUT_UNKNOWN")
      throw new TerminalFaultV2(error.failure.code, error.failure.effect);
    throw error;
  };
  const port: TerminalContextPort = {
    current: (snapshot) => context.port.current(snapshot),
    resolve: async (scope, signal): Promise<TerminalContextSnapshotV2> => {
      try {
        return await context.port.resolve(scope, signal);
      } catch (error) {
        return translate(error);
      }
    },
  };
  const auth = new TerminalRevocationFenceV2(ctx.now);
  const ledger = createTerminalAllocationLedgerV2({ stateDir: ctx.paths.stateDir, current: resourceCurrent });
  const service = new HubTerminalServiceV2({
    ledger,
    context: port,
    hubInstance,
    limits: config,
    ...(ctx.deps.terminalV2Test?.backend ? { backend: ctx.deps.terminalV2Test.backend } : {}),
    revision: () => auth.revision,
    check(id, scope, revision) {
      try {
        auth.check(id, revision);
      } catch (error) {
        translate(error);
      }
      if (!memoryCurrent()) throw new TerminalFaultV2("E_SESSION_CHANGED");
      if (privacyDenied(scope)) throw new TerminalFaultV2("E_PRIVACY");
      const target = context.target(scope);
      if (!target) throw new TerminalFaultV2("E_UNSUPPORTED");
      return target.declaration.limits;
    },
  });
  const offFlights = auth.subscribe(() => service.abortCreates());
  const off = auth.subscribeCreators((selector) =>
    service.invalidateCreators((creator) => matchesTerminalAuthV2(selector, creator)),
  );
  let revalidate: TerminalRevalidateV2 = async () => ({ ok: false, code: "E_AUTH", effect: "none" });
  const resizeGate = createTerminalResizeGateV2();
  const views = createTerminalViewsV2({
    service,
    hubInstance,
    auth,
    notifications: auth,
    resizeGate,
    now: ctx.now,
    revalidate: (id, signal) => revalidate(id, signal),
  });
  const routes = createTerminalRoutesV2({
    service,
    views,
    auth,
    notifications: auth,
    hubInstance,
    now: ctx.now,
    audit: (record) => ctx.log.info("web-hub terminal", { audit: "terminal", ...record }),
  });
  const project = () => {
    if (!ctx.info || disposed) return;
    const denied = !ctx.privacyStore || ctx.privacyStore.degraded;
    if (available && !denied) delete ctx.info.terminal;
    else ctx.info.terminal = { state: "unavailable", reason: denied ? "privacy-unavailable" : reason };
    ctx.registry?.publish({ type: "hub" });
  };
  ctx.terminalPrivacyChanged = () => {
    for (const view of ctx.registry?.list() ?? []) {
      const target = ctx.agentServer?.terminalContextLink?.(view.agentKey);
      if (target && privacyDenied(target.scope)) {
        context.retire(target.instance);
        service.invalidateScope(target.scope);
      }
    }
    project();
  };
  const frontend: TerminalFrontendV2 = {
    routes,
    auth,
    attachAuthority(next) {
      revalidate = next;
    },
  };
  // No startupStep/await: auth, rotate recovery and both listeners are independent.
  // One bounded terminal-only initialization task and one guarded ledger factory.
  const initialized = (async () => {
    const at = Date.now() + clampSpanMs(6000);
    const wait = deadline(ctx.now, 6000, [ctx.startup.signal, lifetime.signal]);
    try {
      if (!memoryCurrent() || !identity) throw new Error();
      const actual = await wait.wait(verifyBoundSocket(ctx.paths.socketPath, identity.dir));
      if (
        !resourceCurrent() ||
        !identityEquals(actual.socket, identity.socket) ||
        !identityEquals(actual.dir, identity.dir)
      )
        throw new Error();
      await wait.wait(
        ensureTerminalStoreV2(
          {
            stateDir: ctx.paths.stateDir,
            ledger,
            current: () => memoryCurrent() && resourceCurrent(),
            at,
          },
          wait.signal,
        ),
      );
      if (!memoryCurrent() || !resourceCurrent()) throw new Error();
      const retired = await wait.wait(
        retireOldKernelAllocationsV2({ stateDir: ctx.paths.stateDir, ledger, current: resourceCurrent }, wait.signal),
      );
      if (retired.kind === "unavailable" || !resourceCurrent()) throw new Error();
      available = await wait.wait(service.initialize(wait.signal));
      if (!available || !resourceCurrent()) throw new Error();
      reason = "";
    } catch (error) {
      available = false;
      reason = error instanceof TerminalFreshUnsupportedV2 ? "legacy-unsupported" : "resource-unavailable";
      ctx.log.warn("web-hub terminal unavailable", { reason });
    } finally {
      wait.dispose();
      project();
    }
  })();
  ctx.deps.terminalV2Test?.ready?.(initialized, service, ledger);
  project();
  let disposeWork: Promise<void> | undefined;
  const dispose = () => {
    if (disposeWork) return disposeWork;
    disposed = true;
    lifetime.abort();
    ctx.terminalPrivacyChanged = undefined;
    auth.dispose();
    context.dispose();
    off();
    offFlights();
    // Seal service admission and start original physical cleanup synchronously. Observe
    // its honest result BEFORE the hub's outer 3s step/log close; never extend that step.
    const wait = deadline(ctx.now, 2000);
    const serviceStopped = (() => {
      try {
        return service.dispose();
      } catch {
        return Promise.reject(new Error("E_CLEANUP"));
      }
    })();
    disposeWork = (async () => {
      try {
        const [result] = await wait.wait(Promise.all([serviceStopped, routes.dispose()]));
        if (result.clean) ctx.log.info("web-hub terminal cleanup complete", { result: "clean" });
        else ctx.log.warn("web-hub terminal cleanup unresolved", { result: "unknown" });
      } catch {
        // Timeout/rejection is not unresolved:0, and no late success revises this record.
        ctx.log.warn("web-hub terminal cleanup unresolved", { result: "unknown" });
      } finally {
        wait.dispose();
      }
    })();
    return disposeWork;
  };
  ctx.cleanup.push(dispose);
  return {
    service,
    ledger,
    frontend,
    initialized,
    dispose,
    context: {
      consume: context.consume,
      retire(instance: object, scope: TerminalScopeV2) {
        context.retire(instance);
        service.invalidateScope(scope);
      },
    },
    get status() {
      return available ? { state: "ready" as const } : { state: "unavailable" as const, reason };
    },
  };
}
